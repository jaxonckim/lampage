import { useEffect, useRef, useState } from 'react'
import { loadPdf, getOutline, renderPage } from '../utils/pdfjs'
import type { OpenDoc, OutlineItem, TocItem } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import { suppressPageSync } from '../utils/pageSync'

interface Props {
  doc: OpenDoc | null
  mdToc: TocItem[]
  onJumpPage: (pageIndex: number) => void
  onJumpHeading: (id: string) => void
  onPdfMutated: (data: ArrayBuffer) => void
}

/**
 * Right sidebar PDF thumbs.
 * Bugs fixed:
 * - Effect depended on currentPage/selectedPages → full wipe+rerender on every scroll (jumpy + missing thumbs).
 * - Thumb grid unmounted when switching to 目录 → switching back did not re-render (ref null during effect).
 * - Click handlers closed over stale doc; jump fought IntersectionObserver.
 */
export default function RightSidebar({
  doc,
  mdToc,
  onJumpPage,
  onJumpHeading,
  onPdfMutated
}: Props): JSX.Element {
  const rightTab = useAppStore((s) => s.rightTab)
  const setRightTab = useAppStore((s) => s.setRightTab)
  const updateDoc = useAppStore((s) => s.updateDoc)
  const setStatus = useAppStore((s) => s.setStatus)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const thumbRef = useRef<HTMLDivElement>(null)
  const dragIndex = useRef<number | null>(null)
  const renderGen = useRef(0)
  const docRef = useRef(doc)
  docRef.current = doc
  const onJumpPageRef = useRef(onJumpPage)
  const onPdfMutatedRef = useRef(onPdfMutated)
  onJumpPageRef.current = onJumpPage
  onPdfMutatedRef.current = onPdfMutated

  // Outline + pageCount — independent of thumb UI.
  useEffect(() => {
    if (!doc || doc.kind !== 'pdf') {
      setOutline([])
      return
    }
    let cancelled = false
    let pdfProxy: Awaited<ReturnType<typeof loadPdf>> | null = null
    ;(async () => {
      const pdf = await loadPdf(doc.data)
      pdfProxy = pdf
      if (cancelled) {
        try {
          pdf.destroy()
        } catch {
          /* ignore */
        }
        pdfProxy = null
        return
      }
      try {
        const o = await getOutline(pdf)
        if (cancelled) return
        setOutline(o as OutlineItem[])
        if (doc.pageCount !== pdf.numPages) {
          updateDoc(doc.id, { pageCount: pdf.numPages })
        }
      } finally {
        if (pdfProxy === pdf) {
          try {
            pdf.destroy()
          } catch {
            /* ignore */
          }
          pdfProxy = null
        }
      }
    })()
    return () => {
      cancelled = true
      if (pdfProxy) {
        try {
          pdfProxy.destroy()
        } catch {
          /* ignore */
        }
        pdfProxy = null
      }
    }
  }, [doc?.id, doc?.data])

  // Full thumb render only when document bytes change (or grid remounts with data).
  useEffect(() => {
    const root = thumbRef.current
    if (!doc || doc.kind !== 'pdf' || !root) return

    const gen = ++renderGen.current
    let cancelled = false
    let pdfProxy: Awaited<ReturnType<typeof loadPdf>> | null = null

    ;(async () => {
      root.replaceChildren()
      const pdf = await loadPdf(doc.data)
      pdfProxy = pdf
      if (cancelled || gen !== renderGen.current) {
        try {
          pdf.destroy()
        } catch {
          /* ignore */
        }
        pdfProxy = null
        return
      }
      try {
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled || gen !== renderGen.current) return
          const pageIndex = i - 1
          const page = await pdf.getPage(i)
          // Sharper thumbs: CSS display ~0.28×, canvas at display × devicePixelRatio (retina)
          const cssScale = 0.28
          const dpr = Math.min(3, window.devicePixelRatio || 1)
          const viewport = page.getViewport({ scale: cssScale * dpr })
          const item = document.createElement('div')
          item.className = 'thumb-item'
          item.dataset.index = String(pageIndex)
          item.dataset.key = `${doc.id}-${pageIndex}`
          item.draggable = true

          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          canvas.style.width = `${Math.max(1, Math.floor(viewport.width / dpr))}px`
          canvas.style.height = `${Math.max(1, Math.floor(viewport.height / dpr))}px`
          item.appendChild(canvas)

          const label = document.createElement('div')
          label.className = 'label'
          label.textContent = `第 ${i} 页`
          item.appendChild(label)
          root.appendChild(item)

          await renderPage(page, { canvasContext: canvas.getContext('2d')!, viewport }).promise

          item.onclick = (e) => {
            const d = docRef.current
            if (!d || d.kind !== 'pdf') return
            const idx = pageIndex
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
              const selected = new Set(d.selectedPages)
              if (selected.has(idx)) selected.delete(idx)
              else selected.add(idx)
              updateDoc(d.id, {
                selectedPages: Array.from(selected).sort((a, b) => a - b),
                currentPage: idx
              })
            } else {
              suppressPageSync(700)
              updateDoc(d.id, { selectedPages: [idx], currentPage: idx })
              onJumpPageRef.current(idx)
            }
          }
          item.ondragstart = () => {
            dragIndex.current = pageIndex
          }
          item.ondragover = (ev) => {
            ev.preventDefault()
          }
          item.ondrop = async (ev) => {
            ev.preventDefault()
            const d = docRef.current
            const from = dragIndex.current
            const to = pageIndex
            dragIndex.current = null
            if (from == null || from === to || !d || d.kind !== 'pdf') return
            const order = Array.from({ length: pdf.numPages }, (_, k) => k)
            const [moved] = order.splice(from, 1)
            order.splice(to, 0, moved)
            const data = await window.api.pdf.reorder(d.data, order)
            onPdfMutatedRef.current(data)
            setStatus('已重排页面')
          }
        }
        // Apply active/selected after paint
        const d = docRef.current
        if (d) {
          root.querySelectorAll('.thumb-item').forEach((el) => {
            const i = Number((el as HTMLElement).dataset.index)
            el.classList.toggle('active', i === d.currentPage)
            el.classList.toggle('selected', d.selectedPages.includes(i))
          })
        }
      } finally {
        if (pdfProxy === pdf) {
          try {
            pdf.destroy()
          } catch {
            /* ignore */
          }
          pdfProxy = null
        }
      }
    })()

    return () => {
      cancelled = true
      if (pdfProxy) {
        try {
          pdfProxy.destroy()
        } catch {
          /* ignore */
        }
        pdfProxy = null
      }
    }
  }, [doc?.id, doc?.data, setStatus, updateDoc])

  // Selection / current highlight only — no wipe.
  useEffect(() => {
    const root = thumbRef.current
    if (!root || !doc || doc.kind !== 'pdf') return
    root.querySelectorAll('.thumb-item').forEach((el) => {
      const i = Number((el as HTMLElement).dataset.index)
      el.classList.toggle('active', i === doc.currentPage)
      el.classList.toggle('selected', doc.selectedPages.includes(i))
    })
  }, [doc?.currentPage, doc?.selectedPages?.join(','), doc?.id])

  // Keep active thumb visible when page changes from viewer scroll.
  useEffect(() => {
    const root = thumbRef.current
    if (!root || !doc || doc.kind !== 'pdf') return
    const el = root.querySelector(`.thumb-item[data-index="${doc.currentPage}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [doc?.currentPage, doc?.id])

  useEffect(() => {
    if (doc?.kind === 'md') setRightTab('outline')
  }, [doc?.id, doc?.kind, setRightTab])

  const renderOutline = (items: OutlineItem[], depth = 0): JSX.Element[] =>
    items.flatMap((it, i) => [
      <div
        key={`${depth}-${i}-${it.title}-${it.pageIndex}`}
        className="outline-item"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => {
          suppressPageSync(700)
          onJumpPage(it.pageIndex)
        }}
      >
        {it.title}
      </div>,
      ...(it.items ? renderOutline(it.items, depth + 1) : [])
    ])

  return (
    <aside className="sidebar right">
      <div className="right-tabs">
        <button
          type="button"
          className={rightTab === 'outline' ? 'active' : ''}
          onClick={() => setRightTab('outline')}
        >
          目录
        </button>
        {doc?.kind !== 'md' && (
          <button
            type="button"
            className={rightTab === 'thumbs' ? 'active' : ''}
            onClick={() => setRightTab('thumbs')}
          >
            缩略图
          </button>
        )}
      </div>
      <div className="right-body">
        {/* Keep thumb grid mounted so render effect can target a stable ref. */}
        {doc?.kind === 'pdf' && (
          <div
            className="thumb-grid"
            ref={thumbRef}
            hidden={rightTab !== 'thumbs'}
            style={{ display: rightTab === 'thumbs' ? undefined : 'none' }}
          />
        )}

        {rightTab === 'outline' && doc?.kind === 'pdf' && (
          <div className="outline-tree">
            {outline.length === 0 ? (
              <div className="outline-empty">这份文件没有目录。</div>
            ) : (
              renderOutline(outline)
            )}
          </div>
        )}

        {rightTab === 'outline' && doc?.kind === 'md' && (
          <div className="outline-tree">
            {mdToc.length === 0 ? (
              <div className="outline-empty">暂无标题</div>
            ) : (
              mdToc.map((t) => (
                <div
                  key={t.id}
                  className="outline-item"
                  style={{ paddingLeft: 8 + (t.level - 1) * 12 }}
                  onClick={() => onJumpHeading(t.id)}
                >
                  {t.text}
                </div>
              ))
            )}
          </div>
        )}

        {!doc && <div className="outline-empty">打开文档后显示目录 / 缩略图</div>}
      </div>
    </aside>
  )
}
