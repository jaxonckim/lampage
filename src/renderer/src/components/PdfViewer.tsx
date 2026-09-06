import { useEffect, useRef, useCallback } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { loadPdf, pdfjs } from '../utils/pdfjs'
import type { OpenDoc } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import { isPageSyncSuppressed } from '../utils/pageSync'
import {
  clearFindHighlights,
  findMatches,
  paintFindHighlights,
  scrollToMatch,
  type FindMatch
} from '../utils/textFind'
import { getSelectionPlainText, isPdfTextSelection, writeClipboardText } from '../utils/selectionText'

interface Props {
  doc: OpenDoc
  findQuery: string
  findOpen: boolean
  findTick: number
  findDir: 1 | -1
  onFindStats: (cur: number, total: number) => void
}

const CSS_BASE = 1.25
const ZOOM_MIN = 0.4
const ZOOM_MAX = 3
const SETTLE_MS = 140
/** Pages to fully render before first paint on open. */
const FIRST_PAINT_PAGES = 1
/** Base layout chrome at zoom=1 (scaled with zoom so CSS preview ≡ settle). */
const PAD_TOP = 24
const PAD_X = 16
const PAD_BOTTOM = 48
const PAGE_GAP = 16

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z.toFixed(3))))
}

function applyZoomChrome(wrap: HTMLElement, zoom: number): void {
  // Must scale with zoom: CSS transform preview scales padding/gap, settle re-layout must match.
  wrap.style.padding = `${PAD_TOP * zoom}px ${PAD_X * zoom}px ${PAD_BOTTOM * zoom}px`
  wrap.style.gap = `${PAGE_GAP * zoom}px`
}

/**
 * Smooth Ctrl/Cmd+wheel zoom:
 * - CSS transform preview (no wipe) while the gesture is active
 * - Debounced settle re-render at full resolution
 * - Zoom centered on cursor; scroll never jumps to document top
 * Progressive open: first page paints ASAP; remaining pages fill in background.
 */
export default function PdfViewer({
  doc,
  findQuery,
  findOpen,
  findTick,
  findDir,
  onFindStats
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const sizerRef = useRef<HTMLDivElement | null>(null)
  const pagesRef = useRef<HTMLDivElement | null>(null)
  const renderedZoomRef = useRef(doc.zoom)
  const previewZoomRef = useRef(doc.zoom)
  const settleTimerRef = useRef<number | null>(null)
  const renderGen = useRef(0)
  const dataGen = useRef(0)
  const activeRenderTasks = useRef<Set<RenderTask>>(new Set())
  const scrollAnchorRef = useRef<{
    contentX: number
    contentY: number
    mx: number
    my: number
  } | null>(null)
  const updateDoc = useAppStore((s) => s.updateDoc)
  const matchIndex = useRef(0)
  const matchesRef = useRef<FindMatch[]>([])
  const onFindStatsRef = useRef(onFindStats)
  onFindStatsRef.current = onFindStats
  const docZoomRef = useRef(doc.zoom)
  docZoomRef.current = doc.zoom
  const docIdRef = useRef(doc.id)
  docIdRef.current = doc.id

  const cancelActiveRenders = useCallback(() => {
    for (const t of activeRenderTasks.current) {
      try {
        t.cancel()
      } catch {
        /* ignore */
      }
    }
    activeRenderTasks.current.clear()
  }, [])

  const applyPreviewChrome = useCallback((renderedZoom: number, previewZoom: number) => {
    const sizer = sizerRef.current
    const pages = pagesRef.current
    if (!sizer || !pages) return
    const ratio = previewZoom / renderedZoom
    const baseW = pages.scrollWidth || pages.offsetWidth
    const baseH = pages.scrollHeight || pages.offsetHeight
    // Sizer always owns scroll dimensions (pages are position:absolute).
    // Keep transform at ratio≈1 only after settle scroll is applied — callers
    // that clear use applyPreviewChrome(z,z) once new DOM + scroll are ready.
    if (Math.abs(ratio - 1) < 0.001) {
      pages.style.transform = ''
      sizer.style.width = `${baseW}px`
      sizer.style.height = `${baseH}px`
      return
    }
    pages.style.transformOrigin = '0 0'
    pages.style.transform = `scale(${ratio})`
    sizer.style.width = `${baseW * ratio}px`
    sizer.style.height = `${baseH * ratio}px`
  }, [])

  /** Keep content point under cursor: scroll = content * (preview/rendered) - mouse */
  const zoomScrollToAnchor = useCallback(
    (container: HTMLElement, renderedZoom: number, previewZoom: number) => {
      const anchor = scrollAnchorRef.current
      if (!anchor) return
      const ratio = previewZoom / renderedZoom
      container.scrollLeft = anchor.contentX * ratio - anchor.mx
      container.scrollTop = anchor.contentY * ratio - anchor.my
    },
    []
  )

  /**
   * Set scroll in the same frame as DOM swap, then re-assert on double rAF
   * after layout. Avoids the one-frame settle jump from deferred-only scroll.
   */
  const setScrollStable = useCallback((container: HTMLElement, left: number, top: number) => {
    container.scrollLeft = left
    container.scrollTop = top
    requestAnimationFrame(() => {
      container.scrollLeft = left
      container.scrollTop = top
      requestAnimationFrame(() => {
        container.scrollLeft = left
        container.scrollTop = top
      })
    })
  }, [])

  const renderOnePage = useCallback(
    async (
      pdf: PDFDocumentProxy,
      pageIndex1: number,
      zoom: number,
      gen: number
    ): Promise<HTMLDivElement | null> => {
      let page: PDFPageProxy
      try {
        page = await pdf.getPage(pageIndex1)
      } catch {
        return null
      }
      if (gen !== renderGen.current) return null

      const cssScale = zoom * CSS_BASE
      const viewport = page.getViewport({ scale: cssScale })
      const pageWrap = document.createElement('div')
      pageWrap.className = 'pdf-page-wrap'
      pageWrap.dataset.pageIndex = String(pageIndex1 - 1)
      pageWrap.id = `pdf-page-${docIdRef.current}-${pageIndex1 - 1}`
      pageWrap.style.width = `${viewport.width}px`
      pageWrap.style.height = `${viewport.height}px`

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      const outputScale = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      canvas.style.pointerEvents = 'none'
      pageWrap.appendChild(canvas)

      const textLayerDiv = document.createElement('div')
      textLayerDiv.className = 'pdf-text-layer textLayer'
      textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale))
      pageWrap.appendChild(textLayerDiv)

      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
      try {
        const task = page.render({ canvasContext: ctx, viewport, transform })
        activeRenderTasks.current.add(task)
        await task.promise
        activeRenderTasks.current.delete(task)
        if (gen !== renderGen.current) return null
        const textContent = await page.getTextContent()
        if (gen !== renderGen.current) return null
        const textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport
        })
        await textLayer.render()
        // endOfContent helps Chromium selection bounds (pdf.js TextLayerBuilder pattern)
        const endOfContent = document.createElement('div')
        endOfContent.className = 'endOfContent'
        textLayerDiv.appendChild(endOfContent)
      } catch {
        return null
      }
      if (gen !== renderGen.current) return null
      return pageWrap
    },
    []
  )

  const renderPages = useCallback(
    async (
      pdf: PDFDocumentProxy,
      zoom: number,
      opts: { preserveScroll: boolean; scrollToPage?: number; progressive?: boolean }
    ) => {
      const root = containerRef.current
      if (!root) return
      const gen = ++renderGen.current
      cancelActiveRenders()

      const progressive = opts.progressive === true && !opts.preserveScroll

      // Capture scroll metrics from live preview BEFORE any DOM swap
      const oldRendered = renderedZoomRef.current
      const oldPreview = previewZoomRef.current
      const oldRatio = oldRendered > 0 ? oldPreview / oldRendered : 1
      const mx = root.clientWidth / 2
      const my = root.clientHeight / 2
      const centerContentX = (root.scrollLeft + mx) / Math.max(oldRatio, 1e-6)
      const centerContentY = (root.scrollTop + my) / Math.max(oldRatio, 1e-6)
      const scaleFactor = oldRendered > 0 ? zoom / oldRendered : 1
      const anchor = scrollAnchorRef.current

      const sizer = document.createElement('div')
      sizer.className = 'pdf-zoom-sizer'
      const wrap = document.createElement('div')
      wrap.className = 'pdf-pages'
      applyZoomChrome(wrap, zoom)
      sizer.appendChild(wrap)

      const commitDom = (scrollLeft: number | null, scrollTop: number | null): void => {
        // Keep old preview on screen until this moment; swap + scroll same frame.
        root.replaceChildren(sizer)
        sizerRef.current = sizer
        pagesRef.current = wrap
        renderedZoomRef.current = zoom
        previewZoomRef.current = zoom
        applyPreviewChrome(zoom, zoom)
        if (scrollLeft != null && scrollTop != null) {
          setScrollStable(root, scrollLeft, scrollTop)
        }
      }

      const resolveScroll = (): { left: number; top: number } | null => {
        if (opts.preserveScroll && anchor) {
          return {
            left: anchor.contentX * scaleFactor - anchor.mx,
            top: anchor.contentY * scaleFactor - anchor.my
          }
        }
        if (opts.preserveScroll) {
          return {
            left: centerContentX * scaleFactor - mx,
            top: centerContentY * scaleFactor - my
          }
        }
        return null
      }

      const firstCount = progressive
        ? Math.min(FIRST_PAINT_PAGES, pdf.numPages)
        : pdf.numPages

      // --- Phase 1: render first page(s) ---
      for (let i = 1; i <= firstCount; i++) {
        if (gen !== renderGen.current) return
        const pageWrap = await renderOnePage(pdf, i, zoom, gen)
        if (!pageWrap || gen !== renderGen.current) return
        wrap.appendChild(pageWrap)
      }

      if (gen !== renderGen.current) return

      const scroll = resolveScroll()
      if (opts.preserveScroll) {
        scrollAnchorRef.current = null
      }

      const maybeScrollToPage = (pageIndex0: number): void => {
        if (opts.preserveScroll || opts.scrollToPage == null) return
        if (pageIndex0 !== opts.scrollToPage) return
        const target = document.getElementById(
          `pdf-page-${docIdRef.current}-${opts.scrollToPage}`
        )
        if (target) target.scrollIntoView({ block: 'nearest' })
      }

      if (progressive) {
        // First paint ASAP — remaining pages append in background
        commitDom(scroll?.left ?? null, scroll?.top ?? null)
        for (let i = 1; i <= firstCount; i++) maybeScrollToPage(i - 1)
        if (gen === renderGen.current) applyFindRef.current()

        for (let i = firstCount + 1; i <= pdf.numPages; i++) {
          if (gen !== renderGen.current) return
          const pageWrap = await renderOnePage(pdf, i, zoom, gen)
          if (!pageWrap || gen !== renderGen.current) return
          wrap.appendChild(pageWrap)
          // Grow sizer to match newly appended untransformed layout
          applyPreviewChrome(renderedZoomRef.current, previewZoomRef.current)
          maybeScrollToPage(i - 1)
        }
        if (gen === renderGen.current) applyFindRef.current()
        return
      }

      // --- Non-progressive (zoom settle): all pages ready, then atomic swap ---
      for (let i = firstCount + 1; i <= pdf.numPages; i++) {
        if (gen !== renderGen.current) return
        const pageWrap = await renderOnePage(pdf, i, zoom, gen)
        if (!pageWrap || gen !== renderGen.current) return
        wrap.appendChild(pageWrap)
      }

      if (gen !== renderGen.current) return

      // Bridge: if we still have a live preview, keep its transform until swap frame.
      // New tree is already at settle zoom; commitDom clears transform + sets scroll together.
      commitDom(scroll?.left ?? null, scroll?.top ?? null)

      if (opts.scrollToPage != null && !opts.preserveScroll) {
        const target = document.getElementById(
          `pdf-page-${docIdRef.current}-${opts.scrollToPage}`
        )
        if (target) target.scrollIntoView({ block: 'nearest' })
      }

      if (gen === renderGen.current) applyFindRef.current()
    },
    [applyPreviewChrome, cancelActiveRenders, renderOnePage, setScrollStable]
  )

  // Load PDF when document bytes change — progressive first paint
  useEffect(() => {
    let cancelled = false
    const gen = ++dataGen.current
    ;(async () => {
      const pdf = await loadPdf(doc.data)
      if (cancelled || gen !== dataGen.current) {
        pdf.destroy()
        return
      }
      const prev = pdfRef.current
      pdfRef.current = pdf
      if (prev && prev !== pdf) {
        try {
          prev.destroy()
        } catch {
          /* ignore */
        }
      }
      updateDoc(doc.id, { pageCount: pdf.numPages })
      renderedZoomRef.current = doc.zoom
      previewZoomRef.current = doc.zoom
      await renderPages(pdf, doc.zoom, {
        preserveScroll: false,
        scrollToPage: doc.currentPage,
        progressive: true
      })
    })()

    return () => {
      cancelled = true
      cancelActiveRenders()
      renderGen.current++
      const cur = pdfRef.current
      pdfRef.current = null
      if (cur) {
        try {
          cur.destroy()
        } catch {
          /* ignore */
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoom handled separately
  }, [doc.data, doc.id, updateDoc, renderPages, cancelActiveRenders])

  // Settle re-render when store zoom changes (toolbar or wheel settle)
  useEffect(() => {
    const pdf = pdfRef.current
    if (!pdf) return
    if (Math.abs(doc.zoom - renderedZoomRef.current) < 0.001) {
      previewZoomRef.current = doc.zoom
      applyPreviewChrome(renderedZoomRef.current, doc.zoom)
      return
    }
    // Non-progressive: keep CSS preview until full settle tree is ready, then swap+scroll
    void renderPages(pdf, doc.zoom, { preserveScroll: true, progressive: false })
  }, [doc.zoom, renderPages, applyPreviewChrome])

  // Ctrl/Cmd+wheel: continuous zoom centered on cursor
  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()

      const rect = root.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      const rendered = renderedZoomRef.current
      const prevPreview = previewZoomRef.current
      const delta = -e.deltaY
      const step =
        e.deltaMode === 1 ? 0.04 * Math.sign(delta || 1) : delta * 0.0015
      const next = clampZoom(prevPreview + (step || (delta > 0 ? 0.04 : -0.04)))
      if (next === prevPreview) return

      const prevRatio = prevPreview / rendered
      scrollAnchorRef.current = {
        contentX: (root.scrollLeft + mx) / prevRatio,
        contentY: (root.scrollTop + my) / prevRatio,
        mx,
        my
      }

      previewZoomRef.current = next
      applyPreviewChrome(rendered, next)
      zoomScrollToAnchor(root, rendered, next)

      if (settleTimerRef.current != null) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        const z = previewZoomRef.current
        if (Math.abs(z - docZoomRef.current) < 0.001) return
        updateDoc(docIdRef.current, { zoom: z })
      }, SETTLE_MS)
    }

    root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      root.removeEventListener('wheel', onWheel)
      if (settleTimerRef.current != null) window.clearTimeout(settleTimerRef.current)
    }
  }, [applyPreviewChrome, zoomScrollToAnchor, updateDoc])

  // Intercept copy so Ctrl+C matches visual PDF selection
  useEffect(() => {
    const onCopy = (e: ClipboardEvent): void => {
      if (!isPdfTextSelection()) return
      const text = getSelectionPlainText()
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', text)
      } else {
        void writeClipboardText(text)
      }
    }
    document.addEventListener('copy', onCopy, true)
    return () => document.removeEventListener('copy', onCopy, true)
  }, [])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible) {
          if (isPageSyncSuppressed()) return
          const idx = Number((visible.target as HTMLElement).dataset.pageIndex || 0)
          if (!Number.isNaN(idx)) updateDoc(doc.id, { currentPage: idx })
        }
      },
      { root, threshold: [0.35, 0.55] }
    )
    const observed = new WeakSet<Element>()
    const timer = window.setInterval(() => {
      const pages = root.querySelectorAll('.pdf-page-wrap')
      pages.forEach((p) => {
        if (!observed.has(p)) {
          obs.observe(p)
          observed.add(p)
        }
      })
    }, 200)
    return () => {
      window.clearInterval(timer)
      obs.disconnect()
    }
  }, [doc.data, doc.zoom, doc.id, updateDoc])

  const applyFind = useCallback(() => {
    const root = containerRef.current
    if (!root) return
    matchesRef.current = []
    matchIndex.current = 0

    if (!findOpen || !findQuery.trim()) {
      clearFindHighlights()
      onFindStatsRef.current(0, 0)
      return
    }

    const matches = findMatches(root, findQuery)
    matchesRef.current = matches
    if (!matches.length) {
      clearFindHighlights()
      onFindStatsRef.current(0, 0)
      return
    }
    matchIndex.current = 0
    paintFindHighlights(matches, 0)
    scrollToMatch(matches[0])
    onFindStatsRef.current(1, matches.length)
  }, [findOpen, findQuery])

  const applyFindRef = useRef(applyFind)
  applyFindRef.current = applyFind

  useEffect(() => {
    const t = window.setTimeout(() => applyFindRef.current(), 120)
    return () => window.clearTimeout(t)
  }, [findQuery, findOpen, doc.data, doc.zoom])

  useEffect(() => {
    if (!findTick || !matchesRef.current.length) return
    const len = matchesRef.current.length
    matchIndex.current = (matchIndex.current + findDir + len) % len
    paintFindHighlights(matchesRef.current, matchIndex.current)
    scrollToMatch(matchesRef.current[matchIndex.current])
    onFindStatsRef.current(matchIndex.current + 1, len)
  }, [findTick, findDir])

  useEffect(() => {
    return () => {
      clearFindHighlights()
      cancelActiveRenders()
    }
  }, [cancelActiveRenders])

  return <div className="viewer pdf-viewer" ref={containerRef} />
}
