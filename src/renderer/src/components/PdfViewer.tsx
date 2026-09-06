import { useEffect, useRef, useCallback } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
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

interface Props {
  doc: OpenDoc
  findQuery: string
  findOpen: boolean
  findTick: number
  findDir: 1 | -1
  onFindStats: (cur: number, total: number) => void
}

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
  const updateDoc = useAppStore((s) => s.updateDoc)
  const matchIndex = useRef(0)
  const matchesRef = useRef<FindMatch[]>([])
  const renderGen = useRef(0)
  const onFindStatsRef = useRef(onFindStats)
  onFindStatsRef.current = onFindStats

  useEffect(() => {
    let cancelled = false
    const gen = ++renderGen.current
    ;(async () => {
      const pdf = await loadPdf(doc.data)
      if (cancelled || gen !== renderGen.current) {
        pdf.destroy()
        return
      }
      // Replace ref; previous instance is destroyed only after this effect is superseded
      // or on unmount — avoids tearing down a doc still finishing an in-flight page render.
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
      const root = containerRef.current
      if (!root) return
      root.innerHTML = ''
      const wrap = document.createElement('div')
      wrap.className = 'pdf-pages'
      root.appendChild(wrap)

      const cssScale = doc.zoom * 1.25

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled || gen !== renderGen.current) return
        let page
        try {
          page = await pdf.getPage(i)
        } catch {
          return
        }
        if (cancelled || gen !== renderGen.current) return
        const viewport = page.getViewport({ scale: cssScale })
        const pageWrap = document.createElement('div')
        pageWrap.className = 'pdf-page-wrap'
        pageWrap.dataset.pageIndex = String(i - 1)
        pageWrap.id = `pdf-page-${doc.id}-${i - 1}`
        pageWrap.style.width = `${viewport.width}px`
        pageWrap.style.height = `${viewport.height}px`

        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')!
        const outputScale = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        // Let the text layer receive all pointer events for selection
        canvas.style.pointerEvents = 'none'
        pageWrap.appendChild(canvas)

        const textLayerDiv = document.createElement('div')
        textLayerDiv.className = 'pdf-text-layer textLayer'
        // Critical for pdf.js v4 TextLayer positioning / font-size calc()
        textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale))
        pageWrap.appendChild(textLayerDiv)
        wrap.appendChild(pageWrap)

        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
        try {
          await page.render({ canvasContext: ctx, viewport, transform }).promise
          if (cancelled || gen !== renderGen.current) return
          const textContent = await page.getTextContent()
          const textLayer = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport
          })
          await textLayer.render()
        } catch {
          return
        }
      }

      const target = document.getElementById(`pdf-page-${doc.id}-${doc.currentPage}`)
      if (target) target.scrollIntoView({ block: 'nearest' })

      // Re-apply find after pages are ready
      if (!cancelled && gen === renderGen.current) {
        applyFindRef.current()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [doc.data, doc.zoom, doc.id, updateDoc])

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
    const timer = window.setInterval(() => {
      const pages = root.querySelectorAll('.pdf-page-wrap')
      if (pages.length) {
        pages.forEach((p) => obs.observe(p))
        window.clearInterval(timer)
      }
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
    // Debounce typing; also re-run when find opens/closes
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
      pdfRef.current?.destroy()
      pdfRef.current = null
    }
  }, [])

  return <div className="viewer pdf-viewer" ref={containerRef} />
}
