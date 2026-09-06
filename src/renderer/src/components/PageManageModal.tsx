import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownUp,
  CopyPlus,
  FileOutput,
  FilePlus,
  GitMerge,
  RotateCw,
  Scissors,
  SquareDashed,
  Trash2
} from 'lucide-react'
import type { OpenDoc } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import { loadPdf, renderPage } from '../utils/pdfjs'
import { uid } from '../utils/id'
import Modal from './Modal'

interface Props {
  doc: OpenDoc | null
  onPdfMutated: (data: ArrayBuffer) => void
}

interface ThumbSlot {
  id: string
  /** Cached rendered bitmap; null means needs (re)render from PDF. */
  bmp: ImageBitmap | null
}

function cloneBuffer(src: ArrayBuffer): ArrayBuffer {
  return src.slice(0)
}



async function cloneBitmapAsync(bmp: ImageBitmap): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  return createImageBitmap(canvas)
}

export default function PageManageModal({ doc, onPdfMutated }: Props): JSX.Element {
  const open = useAppStore((s) => s.pageManageOpen)
  const setOpen = useAppStore((s) => s.setPageManageOpen)
  const setStatus = useAppStore((s) => s.setStatus)
  const updateDoc = useAppStore((s) => s.updateDoc)
  const addOpenedFiles = useAppStore((s) => s.addOpenedFiles)

  const [draftData, setDraftData] = useState<ArrayBuffer | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  /** Merge staged in draft — confirm adds result to open list instead of overwriting current. */
  const [mergeStaged, setMergeStaged] = useState(false)
  /** Inline split form — Electron has no window.prompt (always null → former no-op). */
  const [splitPrompt, setSplitPrompt] = useState<null | { mode: 'n' | 'ranges'; value: string }>(
    null
  )
  const [selected, setSelected] = useState<number[]>([])
  const [pageCount, setPageCount] = useState(0)
  const [activePage, setActivePage] = useState(0)
  const [busy, setBusy] = useState(false)

  const gridRef = useRef<HTMLDivElement>(null)
  const dragFrom = useRef<number | null>(null)
  const slotsRef = useRef<ThumbSlot[]>([])
  const draftRef = useRef<ArrayBuffer | null>(null)
  const selectedRef = useRef(selected)
  const pageCountRef = useRef(pageCount)
  const activeRef = useRef(activePage)
  const docRef = useRef(doc)
  const mergeRef = useRef(false)
  const syncToken = useRef(0)

  draftRef.current = draftData
  selectedRef.current = selected
  pageCountRef.current = pageCount
  activeRef.current = activePage
  docRef.current = doc
  mergeRef.current = mergeStaged

  const disabled = !draftData || busy
  const effectiveSelected = selected.length > 0 ? selected : draftData ? [activePage] : []

  const paintCanvas = (canvas: HTMLCanvasElement, bmp: ImageBitmap): void => {
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0)
  }

  const applySelectionClasses = useCallback((sel: number[], active: number): void => {
    const root = gridRef.current
    if (!root) return
    root.querySelectorAll('.pm-thumb').forEach((el) => {
      const i = Number((el as HTMLElement).dataset.index)
      el.classList.toggle('selected', sel.includes(i))
      el.classList.toggle('active', i === active)
    })
  }, [])

  /** Rebuild DOM from slots; reuse existing nodes by data-id when possible. */
  const syncDomFromSlots = useCallback(
    (sel: number[], active: number): void => {
      const root = gridRef.current
      if (!root) return
      const slots = slotsRef.current
      const existing = new Map<string, HTMLElement>()
      Array.from(root.children).forEach((child) => {
        const el = child as HTMLElement
        const id = el.dataset.id
        if (id) existing.set(id, el)
      })

      const frag = document.createDocumentFragment()
      slots.forEach((slot, idx) => {
        let item = existing.get(slot.id)
        if (!item) {
          item = document.createElement('div')
          item.draggable = true
          item.dataset.id = slot.id
          const canvas = document.createElement('canvas')
          item.appendChild(canvas)
          const label = document.createElement('div')
          label.className = 'pm-thumb-label'
          item.appendChild(label)
        }
        item.className = `pm-thumb${sel.includes(idx) ? ' selected' : ''}${
          active === idx ? ' active' : ''
        }`
        item.dataset.index = String(idx)
        item.title = `第 ${idx + 1} 页`
        const label = item.querySelector('.pm-thumb-label')
        if (label) label.textContent = String(idx + 1)
        const canvas = item.querySelector('canvas')
        if (canvas && slot.bmp) paintCanvas(canvas, slot.bmp)
        frag.appendChild(item)
        existing.delete(slot.id)
      })
      root.replaceChildren(frag)
      // Removed slots are already absent from slotsRef; bitmaps GC'd with slot drop / releaseSlots.
    },
    []
  )

  /** Render bitmaps only for slots where bmp is null. */
  const fillMissingBitmaps = useCallback(
    async (data: ArrayBuffer, sel: number[], active: number): Promise<void> => {
      const token = ++syncToken.current
      const slots = slotsRef.current
      const need = slots
        .map((s, i) => (s.bmp ? -1 : i))
        .filter((i) => i >= 0)
      if (need.length === 0) {
        syncDomFromSlots(sel, active)
        return
      }
      // Show structure immediately (placeholders)
      syncDomFromSlots(sel, active)
      const pdf = await loadPdf(data)
      if (token !== syncToken.current) {
        pdf.destroy()
        return
      }
      try {
        for (const idx of need) {
          if (token !== syncToken.current) return
          if (idx < 0 || idx >= pdf.numPages) continue
          const page = await pdf.getPage(idx + 1)
          const viewport = page.getViewport({ scale: 0.35 })
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          await renderPage(page, { canvasContext: canvas.getContext('2d')!, viewport }).promise
          if (token !== syncToken.current) return
          const bmp = await createImageBitmap(canvas)
          if (token !== syncToken.current) {
            bmp.close()
            return
          }
          const slot = slotsRef.current[idx]
          if (slot) {
            slot.bmp?.close()
            slot.bmp = bmp
          }
          const root = gridRef.current
          const el = root?.querySelector(`.pm-thumb[data-index="${idx}"]`) as HTMLElement | null
          const c = el?.querySelector('canvas')
          if (c) paintCanvas(c, bmp)
        }
      } finally {
        pdf.destroy()
      }
    },
    [syncDomFromSlots]
  )

  const releaseSlots = useCallback((): void => {
    for (const s of slotsRef.current) s.bmp?.close()
    slotsRef.current = []
    syncToken.current++
    if (gridRef.current) gridRef.current.replaceChildren()
  }, [])

  const seedSlots = useCallback(
    async (data: ArrayBuffer, sel: number[], active: number): Promise<void> => {
      releaseSlots()
      const pdf = await loadPdf(data)
      const n = pdf.numPages
      pdf.destroy()
      slotsRef.current = Array.from({ length: n }, () => ({ id: uid(), bmp: null }))
      setPageCount(n)
      await fillMissingBitmaps(data, sel, active)
    },
    [fillMissingBitmaps, releaseSlots]
  )

  const applyDraftMutation = useCallback(
    async (
      label: string,
      fn: (data: ArrayBuffer) => Promise<ArrayBuffer>,
      plan: {
        selectedAfter?: number[]
        currentAfter?: number
        /** Remap: for each new index, source old index or null if needs render. */
        remap: Array<number | null>
        /** Optional: duplicate bitmap from source index into new slot (before remap fill). */
        cloneFrom?: Array<{ at: number; from: number }>
      }
    ): Promise<void> => {
      const current = draftRef.current
      if (!current) return
      setBusy(true)
      try {
        const data = await fn(current)
        const oldSlots = slotsRef.current
        const nextSlots: ThumbSlot[] = plan.remap.map((src) => {
          if (src == null || !oldSlots[src]) return { id: uid(), bmp: null }
          const prev = oldSlots[src]
          // Move ownership of bmp to new slot; clear old reference later
          const slot: ThumbSlot = { id: prev.id, bmp: prev.bmp }
          prev.bmp = null
          return slot
        })
        // Clones for duplicate: after remap, overwrite/insert bitmaps
        if (plan.cloneFrom) {
          for (const { at, from } of plan.cloneFrom) {
            const srcBmp = nextSlots[from]?.bmp ?? oldSlots[from]?.bmp
            if (srcBmp && nextSlots[at]) {
              nextSlots[at].bmp = await cloneBitmapAsync(srcBmp)
              // keep distinct id for the clone
              nextSlots[at].id = uid()
            } else if (nextSlots[at]) {
              nextSlots[at].bmp = null
              nextSlots[at].id = uid()
            }
          }
        }
        // Close unused old bitmaps
        for (const s of oldSlots) s.bmp?.close()

        slotsRef.current = nextSlots
        setDraftData(data)
        setDraftDirty(true)
        const nextSel = plan.selectedAfter ?? []
        const nextCur = plan.currentAfter ?? nextSel[0] ?? 0
        setSelected(nextSel)
        setActivePage(nextCur)
        setPageCount(nextSlots.length)
        setStatus(`草稿：${label}`)
        await fillMissingBitmaps(data, nextSel, nextCur)
      } catch (e) {
        setStatus(`操作失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [fillMissingBitmaps, setStatus]
  )

  // Seed draft when modal opens
  useEffect(() => {
    if (!open || !doc || doc.kind !== 'pdf') {
      if (!open) {
        releaseSlots()
        setDraftData(null)
        setDraftDirty(false)
        setMergeStaged(false)
        setSelected([])
        setPageCount(0)
      }
      return
    }
    const initial =
      doc.selectedPages?.length > 0 ? [...doc.selectedPages] : [doc.currentPage]
    const copy = cloneBuffer(doc.data)
    setDraftData(copy)
    setDraftDirty(false)
    setMergeStaged(false)
    setSelected(initial)
    setActivePage(doc.currentPage)
    void seedSlots(copy, initial, doc.currentPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc?.id, doc?.kind])

  useEffect(() => {
    if (!open) return
    const root = gridRef.current
    if (!root) return

    const onClick = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement).closest('.pm-thumb') as HTMLElement | null
      if (!target) return
      const idx = Number(target.dataset.index)
      if (!Number.isFinite(idx)) return
      setSelected((prev) => {
        let next: number[]
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          const set = new Set(prev)
          if (set.has(idx)) set.delete(idx)
          else set.add(idx)
          next = Array.from(set).sort((a, b) => a - b)
        } else {
          next = [idx]
        }
        setActivePage(idx)
        applySelectionClasses(next, idx)
        return next
      })
    }

    const onDragStart = (e: DragEvent): void => {
      const target = (e.target as HTMLElement).closest('.pm-thumb') as HTMLElement | null
      if (!target) return
      dragFrom.current = Number(target.dataset.index)
      target.classList.add('dragging')
    }
    const onDragEnd = (): void => {
      root.querySelectorAll('.pm-thumb.dragging').forEach((el) => el.classList.remove('dragging'))
      dragFrom.current = null
    }
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      if (!draftRef.current) return
      const target = (e.target as HTMLElement).closest('.pm-thumb') as HTMLElement | null
      if (!target) return
      const from = dragFrom.current
      const to = Number(target.dataset.index)
      dragFrom.current = null
      if (from == null || !Number.isFinite(to) || from === to) return
      const count = pageCountRef.current
      const order = Array.from({ length: count }, (_, k) => k)
      if (order.length === 0) return
      const [moved] = order.splice(from, 1)
      order.splice(to, 0, moved)
      void applyDraftMutation(
        '已重排页面',
        (data) => window.api.pdf.reorder(data, order),
        {
          selectedAfter: [to],
          currentAfter: to,
          remap: order
        }
      )
    }

    root.addEventListener('click', onClick)
    root.addEventListener('dragstart', onDragStart)
    root.addEventListener('dragend', onDragEnd)
    root.addEventListener('dragover', onDragOver)
    root.addEventListener('drop', onDrop)
    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('dragstart', onDragStart)
      root.removeEventListener('dragend', onDragEnd)
      root.removeEventListener('dragover', onDragOver)
      root.removeEventListener('drop', onDrop)
    }
  }, [open, applyDraftMutation, applySelectionClasses])

  const onDelete = (): void => {
    if (disabled) return
    const sel = effectiveSelected
    if (!sel.length) return
    const del = new Set(sel)
    const remap: Array<number | null> = []
    for (let i = 0; i < pageCount; i++) {
      if (!del.has(i)) remap.push(i)
    }
    const min = Math.min(...sel)
    const currentAfter = Math.max(0, Math.min(remap.length - 1, min > 0 ? min - 1 : 0))
    void applyDraftMutation('已删除页面', (data) => window.api.pdf.deletePages(data, sel), {
      selectedAfter: [],
      currentAfter: remap.length ? currentAfter : 0,
      remap
    })
  }

  const onInsertBlank = (): void => {
    if (disabled) return
    const after = effectiveSelected[effectiveSelected.length - 1] ?? activePage
    const remap: Array<number | null> = []
    for (let i = 0; i < pageCount; i++) {
      remap.push(i)
      if (i === after) remap.push(null)
    }
    if (pageCount === 0) remap.push(null)
    void applyDraftMutation('已插入空白页', (data) => window.api.pdf.insertBlank(data, after), {
      selectedAfter: [after + 1],
      currentAfter: after + 1,
      remap
    })
  }

  const onRotate = (): void => {
    if (disabled) return
    const sel = effectiveSelected
    const selSet = new Set(sel)
    const remap: Array<number | null> = Array.from({ length: pageCount }, (_, i) =>
      selSet.has(i) ? null : i
    )
    // For rotated pages we intentionally drop cache (null in remap) but need new ids —
    // applyDraftMutation treats null as new slot. For non-selected keep cache.
    // Problem: rotated pages map to null so they get new empty slots — good.
    // But we also need remap length === pageCount with positions preserved.
    // Fix: use remap that keeps index but invalidates bmp for selected.
    void (async () => {
      const current = draftRef.current
      if (!current) return
      setBusy(true)
      try {
        const data = await window.api.pdf.rotate(current, sel, 90)
        for (const i of sel) {
          const slot = slotsRef.current[i]
          if (slot) {
            slot.bmp?.close()
            slot.bmp = null
          }
        }
        setDraftData(data)
        setDraftDirty(true)
        setSelected(sel)
        setActivePage(sel[0] ?? 0)
        setStatus('草稿：已旋转')
        await fillMissingBitmaps(data, sel, sel[0] ?? 0)
      } catch (e) {
        setStatus(`操作失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    })()
  }

  const onDuplicate = (): void => {
    if (disabled) return
    const sel = [...effectiveSelected].sort((a, b) => a - b)
    if (!sel.length) return
    const selectedSet = new Set(sel)
    const order: number[] = []
    const remap: Array<number | null> = []
    const cloneFrom: Array<{ at: number; from: number }> = []
    for (let i = 0; i < pageCount; i++) {
      order.push(i)
      remap.push(i)
      if (selectedSet.has(i)) {
        order.push(i)
        const at = remap.length
        remap.push(null)
        cloneFrom.push({ at, from: at - 1 })
      }
    }
    const firstDup = sel[0] + 1
    void applyDraftMutation('已复制页面', (data) => window.api.pdf.reorder(data, order), {
      selectedAfter: [firstDup],
      currentAfter: firstDup,
      remap,
      cloneFrom
    })
  }

  const onReverse = (): void => {
    if (disabled) return
    const count = pageCount
    if (count < 2) {
      setStatus('页面不足，无法倒序')
      return
    }
    const order = Array.from({ length: count }, (_, i) => count - 1 - i)
    const mappedSel = effectiveSelected.map((i) => count - 1 - i).sort((a, b) => a - b)
    void applyDraftMutation('已倒序排列', (data) => window.api.pdf.reorder(data, order), {
      selectedAfter: mappedSel,
      currentAfter: mappedSel[0] ?? 0,
      remap: order
    })
  }

  const onExtract = async (): Promise<void> => {
    if (disabled || !draftData || !doc) return
    const sel = effectiveSelected
    if (!sel.length) return
    try {
      setBusy(true)
      const data = await window.api.pdf.extract(draftData, sel)
      const path = await window.api.saveFileDialog({
        defaultPath: `${doc.name.replace(/\.pdf$/i, '')}-extract.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (path) {
        await window.api.writeFile(path, data)
        setStatus(`已提取到 ${path}`)
      }
    } catch (e) {
      setStatus(`操作失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const runSplitEveryN = async (n: number): Promise<void> => {
    if (disabled || !draftData || !doc) return
    if (!Number.isFinite(n) || n < 1) {
      setStatus('请输入有效的每段页数（≥1）')
      return
    }
    try {
      setBusy(true)
      const parts = await window.api.pdf.splitEveryN(draftData, Math.floor(n))
      const base = doc.name.replace(/\.pdf$/i, '') || 'document'
      addOpenedFiles(
        parts.map((data, i) => ({
          path: null,
          name: `${base}-part${i + 1}.pdf`,
          data: cloneBuffer(data),
          dirty: true
        }))
      )
      setSplitPrompt(null)
      setStatus(`已按每 ${Math.floor(n)} 页拆分为 ${parts.length} 个文件（已加入打开列表）`)
    } catch (e) {
      setStatus(`操作失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const runSplitRanges = async (raw: string): Promise<void> => {
    if (disabled || !draftData || !doc) return
    const trimmed = raw.trim()
    if (!trimmed) {
      setStatus('请输入页码范围')
      return
    }
    try {
      setBusy(true)
      const ranges = trimmed.split(',').map((seg) => {
        const bits = seg.split('-').map((x) => Number(x.trim()))
        const a = bits[0]
        const b = bits.length > 1 ? bits[1] : a
        if (!Number.isFinite(a) || a < 1) throw new Error(`无效范围: ${seg}`)
        const start = a - 1
        const end = (Number.isFinite(b) ? b : a) - 1
        if (end < start) throw new Error(`无效范围: ${seg}`)
        return { start, end }
      })
      const parts = await window.api.pdf.splitRanges(draftData, ranges)
      const base = doc.name.replace(/\.pdf$/i, '') || 'document'
      addOpenedFiles(
        parts.map((data, i) => ({
          path: null,
          name: `${base}-range${i + 1}.pdf`,
          data: cloneBuffer(data),
          dirty: true
        }))
      )
      setSplitPrompt(null)
      setStatus(`已按范围拆分 ${parts.length} 个文件（已加入打开列表）`)
    } catch (e) {
      setStatus(`操作失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const onSplitN = (): void => {
    if (disabled) return
    setSplitPrompt({ mode: 'n', value: '1' })
  }

  const onSplitRanges = (): void => {
    if (disabled) return
    setSplitPrompt({ mode: 'ranges', value: '1-1' })
  }

  const submitSplitPrompt = (): void => {
    if (!splitPrompt) return
    if (splitPrompt.mode === 'n') {
      void runSplitEveryN(Number(splitPrompt.value))
    } else {
      void runSplitRanges(splitPrompt.value)
    }
  }

  /** Merge into draft only — no download. Confirm adds result to open-file list. */
  const onMerge = async (): Promise<void> => {
    if (disabled || !draftData) return
    try {
      setBusy(true)
      const more = await window.api.openFiles()
      const pdfs = more.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      if (!pdfs.length) {
        setStatus('未选择要合并的 PDF')
        return
      }
      const list = [draftData, ...pdfs.map((f) => f.data)]
      const merged = await window.api.pdf.merge(list)
      const oldCount = pageCountRef.current
      const pdf = await loadPdf(merged)
      const newCount = pdf.numPages
      pdf.destroy()
      const remap: Array<number | null> = Array.from({ length: newCount }, (_, i) =>
        i < oldCount ? i : null
      )
      const oldSlots = slotsRef.current
      const nextSlots: ThumbSlot[] = remap.map((src) => {
        if (src == null || !oldSlots[src]) return { id: uid(), bmp: null }
        const prev = oldSlots[src]
        const slot: ThumbSlot = { id: prev.id, bmp: prev.bmp }
        prev.bmp = null
        return slot
      })
      for (const s of oldSlots) s.bmp?.close()
      slotsRef.current = nextSlots
      setDraftData(merged)
      setDraftDirty(true)
      setMergeStaged(true)
      const firstNew = oldCount
      setSelected([firstNew])
      setActivePage(firstNew)
      setPageCount(newCount)
      setStatus(`草稿：已合并 ${list.length} 个 PDF（确认后加入打开列表）`)
      await fillMissingBitmaps(merged, [firstNew], firstNew)
    } catch (e) {
      setStatus(`操作失败: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const discardAndClose = useCallback((): void => {
    releaseSlots()
    setDraftData(null)
    setDraftDirty(false)
    setMergeStaged(false)
    setSplitPrompt(null)
    setSelected([])
    setOpen(false)
    setStatus('已取消页面管理')
  }, [releaseSlots, setOpen, setStatus])

  const confirmAndClose = useCallback((): void => {
    const current = docRef.current
    const data = draftRef.current
    if (!current || current.kind !== 'pdf' || !data) {
      setOpen(false)
      return
    }
    if (mergeRef.current) {
      const base = current.name.replace(/\.pdf$/i, '') || 'document'
      const name = `${base}-merged.pdf`
      addOpenedFiles([{ path: null, name, data: cloneBuffer(data), dirty: true }])
      setStatus(`已将合并结果加入打开列表：${name}`)
    } else if (draftDirty) {
      onPdfMutated(data)
      updateDoc(current.id, {
        selectedPages: selectedRef.current,
        currentPage: activeRef.current,
        pageCount: pageCountRef.current || undefined
      })
      setStatus('已应用页面更改')
    } else {
      setStatus('页面管理无更改')
    }
    releaseSlots()
    setDraftData(null)
    setDraftDirty(false)
    setMergeStaged(false)
    setSplitPrompt(null)
    setOpen(false)
  }, [addOpenedFiles, draftDirty, onPdfMutated, releaseSlots, setOpen, setStatus, updateDoc])

  return (
    <Modal title="页面管理" open={open} onClose={discardAndClose} wide workspace>
      <div className="pm-toolbar" role="toolbar" aria-label="页面操作">
        <IconAction
          tip="删除选中页"
          disabled={disabled || effectiveSelected.length === 0}
          onClick={onDelete}
        >
          <Trash2 size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction tip="插入空白页" disabled={disabled} onClick={onInsertBlank}>
          <FilePlus size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction
          tip="复制页面"
          disabled={disabled || effectiveSelected.length === 0}
          onClick={onDuplicate}
        >
          <CopyPlus size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction
          tip="旋转 90°"
          disabled={disabled || effectiveSelected.length === 0}
          onClick={onRotate}
        >
          <RotateCw size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction tip="倒序" disabled={disabled || pageCount < 2} onClick={onReverse}>
          <ArrowDownUp size={16} strokeWidth={1.75} />
        </IconAction>
        <span className="pm-toolbar-sep" />
        <IconAction
          tip="提取选中页"
          disabled={disabled || effectiveSelected.length === 0}
          onClick={() => void onExtract()}
        >
          <FileOutput size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction tip="按 N 页拆分" disabled={disabled} onClick={onSplitN}>
          <Scissors size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction tip="按范围拆分" disabled={disabled} onClick={onSplitRanges}>
          <SquareDashed size={16} strokeWidth={1.75} />
        </IconAction>
        <IconAction tip="合并 PDF…" disabled={disabled} onClick={() => void onMerge()}>
          <GitMerge size={16} strokeWidth={1.75} />
        </IconAction>
        <div className="pm-toolbar-grow" />
        <span className="pm-hint">
          {!doc || doc.kind !== 'pdf'
            ? '请打开 PDF'
            : `草稿 · 共 ${pageCount || '–'} 页 · 选中 ${effectiveSelected.length} · 拖拽可重排${
                mergeStaged ? ' · 合并待加入列表' : draftDirty ? ' · 未应用' : ''
              }`}
        </span>
      </div>

      {splitPrompt && (
        <div className="pm-split-prompt" role="form" aria-label="拆分参数">
          <label htmlFor="pm-split-input">
            {splitPrompt.mode === 'n' ? '每 N 页拆分' : '页码范围（如 1-3,5-6）'}
          </label>
          <input
            id="pm-split-input"
            autoFocus
            value={splitPrompt.value}
            disabled={busy}
            onChange={(e) => setSplitPrompt({ ...splitPrompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitSplitPrompt()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setSplitPrompt(null)
              }
            }}
          />
          <div className="pm-split-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setSplitPrompt(null)}>
              取消
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={submitSplitPrompt}>
              拆分
            </button>
          </div>
        </div>
      )}

      <div className="pm-workspace">
        {!doc || doc.kind !== 'pdf' ? (
          <div className="outline-empty">请打开 PDF 文档后使用页面管理。</div>
        ) : (
          <div className="pm-thumb-grid" ref={gridRef} />
        )}
      </div>

      <div className="pm-footer">
        <button type="button" className="btn-ghost" onClick={discardAndClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={confirmAndClose}
          disabled={busy || !draftData}
        >
          确认
        </button>
      </div>
    </Modal>
  )
}

function IconAction({
  tip,
  disabled,
  onClick,
  children
}: {
  tip: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn"
      title={tip}
      aria-label={tip}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
