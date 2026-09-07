/**
 * Prepare full-document print content (all PDF pages / full MD), chrome-free.
 * Used by the browser shim and as a multi-page HTML fallback/verify path.
 */
import { loadPdf, renderPage } from './pdfjs'

const PRINT_SCALE = 1.5
/** Soft cap: beyond this, browser falls back to embedding the PDF blob. */
export const PDF_PRINT_PAGE_SOFT_CAP = 80

export type PdfPrintMethod = 'blob' | 'html-raster'

export type PdfPrintPrep = {
  pageCount: number
  html: string
  /** True when HTML contains one .pdf-print-page surface per page (raster). */
  hasPageSurfaces: boolean
  /** Which browser print path was / would be used. */
  method?: PdfPrintMethod
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildMdPrintHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 12mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #1c2430;
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif; }
  article.md-print { max-width: 800px; margin: 0 auto; padding: 8px 12px 24px;
    line-height: 1.75; font-size: 16px; }
  article.md-print h1 { font-size: 2rem; margin: 1.2em 0 0.5em; font-weight: 700; }
  article.md-print h2 { font-size: 1.55rem; margin: 1.1em 0 0.45em; font-weight: 700; }
  article.md-print h3 { font-size: 1.25rem; margin: 1em 0 0.4em; font-weight: 650; }
  article.md-print h4, article.md-print h5, article.md-print h6 {
    font-size: 1.05rem; margin: 0.9em 0 0.35em; font-weight: 600; }
  article.md-print p { margin: 0.65em 0; }
  article.md-print a { color: #143d2e; }
  article.md-print blockquote {
    border-left: 3px solid #c5d6cb; margin: 0.8em 0; padding: 0.2em 0 0.2em 1em; color: #475569; }
  article.md-print code {
    font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
    background: #f1f5f1; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em;
    white-space: pre-wrap; word-break: break-word; }
  article.md-print pre {
    background: #14241c; color: #e2e8f0; border-radius: 10px; padding: 14px 16px;
    white-space: pre-wrap; word-break: break-word; }
  article.md-print pre code { background: transparent; color: inherit; padding: 0; }
  .code-copy-btn, .hl-mark { display: none !important; }
</style>
</head>
<body>
<article class="md-print">${bodyHtml}</article>
</body>
</html>`
}

/**
 * CSS for HTML-raster PDF print fallback.
 * Each .pdf-print-page must map to exactly one printed sheet:
 * - break-inside/avoid so a surface does not split
 * - max-width/max-height 100% so images do not overflow paper (overflow → blank trailing page)
 * - last-child has no page-break-after (no trailing blank)
 */
export const PDF_PRINT_PAGE_CSS = `
  @page { margin: 0; size: auto; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .pdf-print-root { margin: 0; padding: 0; }
  .pdf-print-page {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    max-height: 100vh;
    max-height: 100%;
    margin: 0;
    padding: 0;
    background: #fff;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-print-page:last-child {
    page-break-after: auto;
    break-after: auto;
  }
  .pdf-print-page img, .pdf-print-page canvas {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    margin: 0 auto;
  }
`

function wrapPdfPagesHtml(
  pagesHtml: string,
  pageCount: number,
  title: string,
  pageWidthPt?: number,
  pageHeightPt?: number
): string {
  const sized =
    pageWidthPt && pageHeightPt
      ? `
  @page { size: ${pageWidthPt}pt ${pageHeightPt}pt; margin: 0; }
  .pdf-print-page {
    width: ${pageWidthPt}pt;
    height: ${pageHeightPt}pt;
    max-width: ${pageWidthPt}pt;
    max-height: ${pageHeightPt}pt;
  }
  .pdf-print-page img, .pdf-print-page canvas {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
`
      : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="lampage-print-pages" content="${pageCount}" />
<title>${escapeHtml(title)}</title>
<style>
${PDF_PRINT_PAGE_CSS}
${sized}
</style>
</head>
<body>
<div class="pdf-print-root" data-page-count="${pageCount}" data-page-width="${pageWidthPt ?? ''}" data-page-height="${pageHeightPt ?? ''}">
${pagesHtml}
</div>
</body>
</html>`
}

/**
 * Rasterize every PDF page into a chrome-free print HTML document.
 * Each page is a `.pdf-print-page` surface (acceptance / verify / fallback).
 */
export async function buildPdfPrintHtml(
  data: ArrayBuffer,
  title = 'document.pdf'
): Promise<PdfPrintPrep> {
  const pdf = await loadPdf(data)
  try {
    const pageCount = pdf.numPages
    if (pageCount < 1) throw new Error('PDF has no pages')

    if (pageCount > PDF_PRINT_PAGE_SOFT_CAP) {
      // Too many pages to rasterize safely — caller should use native PDF bytes.
      return { pageCount, html: '', hasPageSurfaces: false, method: 'blob' }
    }

    const parts: string[] = []
    let pageWidthPt = 595
    let pageHeightPt = 842
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i)
      if (i === 1) {
        const base = page.getViewport({ scale: 1 })
        pageWidthPt = base.width
        pageHeightPt = base.height
      }
      const viewport = page.getViewport({ scale: PRINT_SCALE })
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await renderPage(page, { canvasContext: ctx, viewport }).promise
      const url = canvas.toDataURL('image/jpeg', 0.92)
      // Do not force pixel width on the surface — CSS max-width/max-height keeps one sheet.
      parts.push(
        `<div class="pdf-print-page" data-page-index="${i - 1}">` +
          `<img src="${url}" width="${canvas.width}" height="${canvas.height}" alt="Page ${i}" />` +
          `</div>`
      )
    }

    const html = wrapPdfPagesHtml(parts.join('\n'), pageCount, title, pageWidthPt, pageHeightPt)
    return { pageCount, html, hasPageSurfaces: true, method: 'html-raster' }
  } finally {
    await pdf.destroy()
  }
}

/** Count `.pdf-print-page` surfaces in a print HTML string (for tests). */
export function countPrintPageSurfaces(html: string): number {
  const re = /class="[^"]*\bpdf-print-page\b[^"]*"/g
  return html.match(re)?.length ?? 0
}

/**
 * Estimate how many sheets the HTML-raster CSS would schedule.
 * Doubling risk: surfaces * 2 when each page both breaks and overflows.
 * With fixed CSS (last-child auto break + max-height), estimate === surface count.
 */
export function estimateHtmlPrintSheets(html: string): {
  surfaces: number
  estimatedSheets: number
  hasLastChildNoBreak: boolean
  hasBreakInsideAvoid: boolean
  hasMaxHeightConstraint: boolean
  wouldDouble: boolean
} {
  const surfaces = countPrintPageSurfaces(html)
  const hasLastChildNoBreak =
    /\.pdf-print-page:last-child\s*\{[^}]*page-break-after:\s*auto/s.test(html) ||
    /\.pdf-print-page:last-child\s*\{[^}]*break-after:\s*auto/s.test(html)
  const hasBreakInsideAvoid =
    /break-inside:\s*avoid/.test(html) || /page-break-inside:\s*avoid/.test(html)
  const hasMaxHeightConstraint =
    /max-height:\s*100%/.test(html) || /max-height:\s*100vh/.test(html)
  // Legacy buggy CSS: width:100% images + page-break-after always on every page
  // (including overflow) → ~2× sheets. Detect intentional safe CSS.
  const safe = hasLastChildNoBreak && hasBreakInsideAvoid && hasMaxHeightConstraint
  const estimatedSheets = surfaces
  const wouldDouble = !safe && surfaces > 0
  return {
    surfaces,
    estimatedSheets: safe ? estimatedSheets : surfaces * 2,
    hasLastChildNoBreak,
    hasBreakInsideAvoid,
    hasMaxHeightConstraint,
    wouldDouble
  }
}

/**
 * Print an HTML document via a hidden iframe (browser / preview tunnel).
 * Does not include app chrome.
 */
export function printHtmlInIframe(html: string): Promise<boolean> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('title', 'lampage-print')
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;'
    document.body.appendChild(iframe)

    const cleanup = (): void => {
      try {
        iframe.remove()
      } catch {
        /* ignore */
      }
    }

    const doc = iframe.contentDocument
    const win = iframe.contentWindow
    if (!doc || !win) {
      cleanup()
      resolve(false)
      return
    }

    doc.open()
    doc.write(html)
    doc.close()

    const doPrint = (): void => {
      try {
        win.focus()
        win.print()
        resolve(true)
      } catch {
        resolve(false)
      } finally {
        // Delay removal so the print dialog can snapshot content
        setTimeout(cleanup, 1000)
      }
    }

    if (doc.readyState === 'complete') {
      setTimeout(doPrint, 50)
    } else {
      iframe.onload = () => setTimeout(doPrint, 50)
    }
  })
}

/**
 * Print PDF bytes via blob: application/pdf iframe — Chromium prints natively
 * (same idea as Electron temp-file PDF print). Avoids HTML page-break blank sheets.
 */
export function printPdfBlobInIframe(data: ArrayBuffer): Promise<boolean> {
  const blob = new Blob([data], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('title', 'lampage-print-pdf')
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;'
    iframe.src = url
    document.body.appendChild(iframe)
    const done = (ok: boolean): void => {
      try {
        iframe.remove()
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url)
      resolve(ok)
    }
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
        setTimeout(() => done(true), 1000)
      } catch {
        done(false)
      }
    }
    setTimeout(() => done(false), 30000)
  })
}

function setLastPrintPrep(prep: PdfPrintPrep): void {
  ;(window as Window & { __lampageLastPrintPrep?: PdfPrintPrep }).__lampageLastPrintPrep = prep
}

/**
 * Browser / preview-tunnel path: prefer native PDF blob iframe print so Chromium
 * prints PDF pages directly (no HTML page-break → blank doubling).
 * HTML raster is only a fallback (e.g. blob iframe print failed).
 */
export async function printPdfInBrowser(data: ArrayBuffer, title: string): Promise<boolean> {
  // Prefer blob native PDF print (matches Electron full-file PDF path semantics).
  try {
    const ok = await printPdfBlobInIframe(data)
    if (ok) {
      setLastPrintPrep({
        pageCount: 0,
        html: '',
        hasPageSurfaces: false,
        method: 'blob'
      })
      return true
    }
  } catch {
    /* fall through to HTML raster */
  }

  // Fallback: HTML raster with sheet-safe CSS
  const prep = await buildPdfPrintHtml(data, title)
  prep.method = 'html-raster'
  setLastPrintPrep(prep)

  if (prep.hasPageSurfaces && prep.html) {
    return printHtmlInIframe(prep.html)
  }

  // Last resort: try blob again (e.g. over soft-cap with empty html)
  setLastPrintPrep({
    pageCount: prep.pageCount,
    html: '',
    hasPageSurfaces: false,
    method: 'blob'
  })
  return printPdfBlobInIframe(data)
}

export function printMdInBrowser(bodyHtml: string, title: string): Promise<boolean> {
  const html = buildMdPrintHtml(bodyHtml, title)
  return printHtmlInIframe(html)
}

/** Read live TipTap / MD DOM content for printing. */
export function getActiveMarkdownHtml(): string {
  const el = document.querySelector('.md-shell .ProseMirror') as HTMLElement | null
  if (!el) return ''
  // Clone and strip UI-only widgets
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.code-copy-btn, .hl-mark').forEach((n) => {
    if (n.classList.contains('hl-mark')) {
      const t = document.createTextNode(n.textContent || '')
      n.replaceWith(t)
    } else {
      n.remove()
    }
  })
  return clone.innerHTML
}
