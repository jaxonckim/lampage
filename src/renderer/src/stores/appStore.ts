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

/** In-progress signature placement (PDF page units / points). */
export type SignaturePlacement = {
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
  signaturePlacement: SignaturePlacement | null

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
  setSignaturePlacement: (p: SignaturePlacement | null) => void
  patchSignaturePlacement: (patch: Partial<SignaturePlacement>) => void
  setActive: (id: string) => void
  closeDoc: (id: string) => void
  updateDoc: (id: string, patch: Partial<OpenDoc>) => void
  addOpenedFiles: (
    files: Array<{ path: string | null; name: string; data: ArrayBuffer }>
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
  signaturePlacement: null,

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
  setSignaturePlacement: (p) => {
    const prev = get().signaturePlacement
    if (prev?.objectUrl && prev.objectUrl !== p?.objectUrl) {
      try {
        URL.revokeObjectURL(prev.objectUrl)
      } catch {
        /* ignore */
      }
    }
    set({ signaturePlacement: p })
  },
  patchSignaturePlacement: (patch) => {
    const cur = get().signaturePlacement
    if (!cur) return
    set({ signaturePlacement: { ...cur, ...patch } })
  },
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
    const placement = get().signaturePlacement
    if (placement?.docId === id) {
      try {
        URL.revokeObjectURL(placement.objectUrl)
      } catch {
        /* ignore */
      }
    }
    const docs = get().docs.filter((d) => d.id !== id)
    const activeId = get().activeId === id ? docs[0]?.id ?? null : get().activeId
    set({
      docs,
      activeId,
      signaturePlacement: placement?.docId === id ? null : placement
    })
  },
  updateDoc: (id, patch) =>
    set({
      docs: get().docs.map((d) => (d.id === id ? { ...d, ...patch } : d))
    }),
  addOpenedFiles: (files) => {
    const next: OpenDoc[] = files.map((f) => {
      const kind = kindFromName(f.name)
      return {
        id: uid(),
        path: f.path,
        name: f.name,
        kind,
        data: f.data,
        text: kind === 'md' ? decodeText(f.data) : undefined,
        dirty: false,
        zoom: 1,
        currentPage: 0,
        pageCount: undefined,
        selectedPages: []
      }
    })
    const docs = [...get().docs, ...next]
    set({
      docs,
      activeId: next[next.length - 1]?.id ?? get().activeId,
      status: `已打开 ${next.length} 个文件`
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
