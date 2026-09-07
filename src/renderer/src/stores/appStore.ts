import { create } from 'zustand'
import type { OpenDoc } from '../types/docs'
import { decodeText, encodeText, kindFromName, uid } from '../utils/id'

const LS_LEFT = 'lampage.leftCollapsed'
const LS_RIGHT = 'lampage.rightCollapsed'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return fallback
    return v === '1' || v === 'true'
  } catch {
    return fallback
  }
}

function revokeUrl(url: string | undefined | null): void {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    /* ignore */
  }
}

/**
 * Equality key for real filesystem paths when deduping open docs.
 * Unifies separators and lowercases so Windows paths match across
 * mixed slash style / drive-letter case. `null` paths are never keyed.
 */
function openPathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** Placed signature overlay (PDF page units / points). Kept until 嵌入. */
export type SignatureOverlay = {
  id: string
  docId: string
  pageIndex: number
  imageData: ArrayBuffer
  mime: 'png' | 'jpg'
  objectUrl: string
  /** Left edge in PDF points (origin top-left for overlay math). */
  xPt: number
  /** Top edge in PDF points (from page top). */
  yTopPt: number
  widthPt: number
  heightPt: number
  /** width/height for Shift+resize aspect lock. */
  aspect: number
}

/** Awaiting a click on the PDF to drop the next signature. */
export type SignaturePending = {
  docId: string
  imageData: ArrayBuffer
  mime: 'png' | 'jpg'
  objectUrl: string
  widthPt: number
  heightPt: number
  aspect: number
}

interface AppState {
  docs: OpenDoc[]
  activeId: string | null
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  findOpen: boolean
  findQuery: string
  findFocusNonce: number
  mdEditMode: boolean
  rightTab: 'thumbs' | 'outline'
  status: string
  pageManageOpen: boolean
  signatureOpen: boolean
  signaturePending: SignaturePending | null
  signatureOverlays: SignatureOverlay[]
  signatureSelectedId: string | null

  setLeftWidth: (w: number) => void
  setRightWidth: (w: number) => void
  setLeftCollapsed: (v: boolean) => void
  setRightCollapsed: (v: boolean) => void
  toggleLeftCollapsed: () => void
  toggleRightCollapsed: () => void
  setFindOpen: (v: boolean) => void
  requestFind: () => void
  setFindQuery: (q: string) => void
  setMdEditMode: (v: boolean) => void
  setRightTab: (t: 'thumbs' | 'outline') => void
  setStatus: (s: string) => void
  setPageManageOpen: (v: boolean) => void
  setSignatureOpen: (v: boolean) => void
  setSignaturePending: (p: SignaturePending | null) => void
  addSignatureOverlay: (o: Omit<SignatureOverlay, 'id'> & { id?: string }) => string
  updateSignatureOverlay: (id: string, patch: Partial<SignatureOverlay>) => void
  removeSignatureOverlay: (id: string) => void
  clearSignatureOverlays: (docId?: string) => void
  setSignatureSelectedId: (id: string | null) => void
  setActive: (id: string) => void
  closeDoc: (id: string) => void
  updateDoc: (id: string, patch: Partial<OpenDoc>) => void
  addOpenedFiles: (
    files: Array<{ path: string | null; name: string; data: ArrayBuffer; dirty?: boolean }>
  ) => void
  activeDoc: () => OpenDoc | null
}

export const useAppStore = create<AppState>((set, get) => ({
  docs: [],
  activeId: null,
  leftWidth: 240,
  rightWidth: 260,
  leftCollapsed: readBool(LS_LEFT, false),
  rightCollapsed: readBool(LS_RIGHT, false),
  findOpen: false,
  findQuery: '',
  findFocusNonce: 0,
  mdEditMode: false,
  rightTab: 'thumbs',
  status: '就绪',
  pageManageOpen: false,
  signatureOpen: false,
  signaturePending: null,
  signatureOverlays: [],
  signatureSelectedId: null,

  setLeftWidth: (w) => set({ leftWidth: Math.min(480, Math.max(160, w)) }),
  setRightWidth: (w) => set({ rightWidth: Math.min(480, Math.max(180, w)) }),
  setLeftCollapsed: (v) => {
    try {
      localStorage.setItem(LS_LEFT, v ? '1' : '0')
    } catch {
      /* ignore */
    }
    set({ leftCollapsed: v })
  },
  setRightCollapsed: (v) => {
    try {
      localStorage.setItem(LS_RIGHT, v ? '1' : '0')
    } catch {
      /* ignore */
    }
    set({ rightCollapsed: v })
  },
  toggleLeftCollapsed: () => get().setLeftCollapsed(!get().leftCollapsed),
  toggleRightCollapsed: () => get().setRightCollapsed(!get().rightCollapsed),
  setFindOpen: (v) => set({ findOpen: v }),
  requestFind: () =>
    set((s) => ({
      findOpen: true,
      findFocusNonce: s.findFocusNonce + 1
    })),
  setFindQuery: (q) => set({ findQuery: q }),
  setMdEditMode: (v) => set({ mdEditMode: v }),
  setRightTab: (t) => set({ rightTab: t }),
  setStatus: (s) => set({ status: s }),
  setPageManageOpen: (v) => set({ pageManageOpen: v }),
  setSignatureOpen: (v) => set({ signatureOpen: v }),
  setSignaturePending: (p) => {
    const prev = get().signaturePending
    if (prev?.objectUrl && prev.objectUrl !== p?.objectUrl) {
      revokeUrl(prev.objectUrl)
    }
    set({ signaturePending: p })
  },
  addSignatureOverlay: (o) => {
    const id = o.id ?? uid('sigol')
    const overlay: SignatureOverlay = { ...o, id }
    set((s) => ({
      signatureOverlays: [...s.signatureOverlays, overlay],
      signatureSelectedId: id,
      signaturePending: null
    }))
    return id
  },
  updateSignatureOverlay: (id, patch) => {
    set({
      signatureOverlays: get().signatureOverlays.map((o) =>
        o.id === id ? { ...o, ...patch } : o
      )
    })
  },
  removeSignatureOverlay: (id) => {
    const cur = get().signatureOverlays.find((o) => o.id === id)
    revokeUrl(cur?.objectUrl)
    set((s) => ({
      signatureOverlays: s.signatureOverlays.filter((o) => o.id !== id),
      signatureSelectedId: s.signatureSelectedId === id ? null : s.signatureSelectedId
    }))
  },
  clearSignatureOverlays: (docId) => {
    const list = get().signatureOverlays
    const keep: SignatureOverlay[] = []
    for (const o of list) {
      if (docId && o.docId !== docId) {
        keep.push(o)
      } else {
        revokeUrl(o.objectUrl)
      }
    }
    const pending = get().signaturePending
    if (pending && (!docId || pending.docId === docId)) {
      revokeUrl(pending.objectUrl)
      set({
        signatureOverlays: keep,
        signaturePending: null,
        signatureSelectedId: null
      })
    } else {
      set({
        signatureOverlays: keep,
        signatureSelectedId: keep.some((o) => o.id === get().signatureSelectedId)
          ? get().signatureSelectedId
          : null
      })
    }
  },
  setSignatureSelectedId: (id) => set({ signatureSelectedId: id }),
  setActive: (id) => {
    const doc = get().docs.find((d) => d.id === id)
    set({
      activeId: id,
      rightTab: doc?.kind === 'md' ? 'outline' : get().rightTab,
      mdEditMode: false
    })
  },
  closeDoc: (id) => {
    const target = get().docs.find((d) => d.id === id)
    if (target?.dirty) {
      const ok = window.confirm(`「${target.name}」有未保存的更改，确定关闭？`)
      if (!ok) return
    }
    get().clearSignatureOverlays(id)
    const docs = get().docs.filter((d) => d.id !== id)
    const activeId = get().activeId === id ? docs[0]?.id ?? null : get().activeId
    set({ docs, activeId })
  },
  updateDoc: (id, patch) =>
    set({
      docs: get().docs.map((d) => (d.id === id ? { ...d, ...patch } : d))
    }),
  addOpenedFiles: (files) => {
    if (!files.length) return

    const docs = [...get().docs]
    const pathToId = new Map<string, string>()
    for (const d of docs) {
      if (d.path != null) pathToId.set(openPathKey(d.path), d.id)
    }

    const added: OpenDoc[] = []
    let focusId: string | null = null

    for (const f of files) {
      if (f.path != null) {
        const key = openPathKey(f.path)
        const existingId = pathToId.get(key)
        if (existingId) {
          // Same real path already open (or earlier in this batch) — focus it.
          focusId = existingId
          continue
        }
      }

      // path: null (unsaved page-mgmt splits, etc.) is always unique — never dedupe.
      const kind = kindFromName(f.name)
      const doc: OpenDoc = {
        id: uid(),
        path: f.path,
        name: f.name,
        kind,
        data: f.data,
        text: kind === 'md' ? decodeText(f.data) : undefined,
        dirty: f.dirty ?? false,
        zoom: 1,
        // PDFs open in fit-width; MD ignores zoomFit.
        zoomFit: kind === 'pdf' ? 'width' : null,
        currentPage: 0,
        pageCount: undefined,
        selectedPages: []
      }
      docs.push(doc)
      added.push(doc)
      if (f.path != null) pathToId.set(openPathKey(f.path), doc.id)
      focusId = doc.id
    }

    if (!focusId) return

    const focused = docs.find((d) => d.id === focusId) ?? null
    set({
      docs,
      activeId: focusId,
      rightTab: focused?.kind === 'md' ? 'outline' : get().rightTab,
      mdEditMode: false,
      status: added.length
        ? `已打开 ${added.length} 个文件`
        : focused
          ? `已切换到 ${focused.name}`
          : get().status
    })
  },
  activeDoc: () => {
    const { docs, activeId } = get()
    return docs.find((d) => d.id === activeId) ?? null
  }
}))

export function syncMdTextToData(doc: OpenDoc): OpenDoc {
  if (doc.kind !== 'md' || doc.text == null) return doc
  return { ...doc, data: encodeText(doc.text) }
}
