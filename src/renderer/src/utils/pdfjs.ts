import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'

// Vite-friendly worker
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export { pdfjs }
export type { PDFDocumentProxy }

type PageRenderParams = Parameters<PDFPageProxy['render']>[0]

/**
 * Resolve a URL under the renderer public/ tree.
 * Uses document.baseURI so file:// packaged builds resolve next to index.html.
 */
function publicAssetUrl(relPath: string): string {
  const normalized = relPath.replace(/^\/+/, '')
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL(normalized, document.baseURI).href
  }
  const base = import.meta.env.BASE_URL || './'
  return new URL(normalized, base).href
}

/** Bundled via scripts/sync-pdfjs-assets.mjs → public/pdfjs/ */
const CMAP_URL = publicAssetUrl('pdfjs/cmaps/')
const STANDARD_FONT_DATA_URL = publicAssetUrl('pdfjs/standard_fonts/')

/**
 * Read-only viewing: paint Widget/AP appearances (e.g. invoice stamps) onto the
 * canvas. ENABLE_FORMS would defer interactive widgets to AnnotationLayer HTML,
 * which skips Sig/AP stamps that set noHTML.
 */
export const VIEW_ANNOTATION_MODE = pdfjs.AnnotationMode.ENABLE

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const loadingTask = pdfjs.getDocument({
    data: data.slice(0),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL
  })
  return loadingTask.promise
}

/** Shared page.render options so stamps/annots stay consistent across viewer/print/thumbs. */
export function renderPage(page: PDFPageProxy, params: PageRenderParams): RenderTask {
  return page.render({
    ...params,
    annotationMode: params.annotationMode ?? VIEW_ANNOTATION_MODE
  })
}

export async function getOutline(
  pdf: PDFDocumentProxy
): Promise<Array<{ title: string; pageIndex: number; items?: any[] }>> {
  const outline = await pdf.getOutline()
  if (!outline) return []

  async function mapItems(items: any[]): Promise<any[]> {
    const out = []
    for (const item of items) {
      let pageIndex = 0
      try {
        if (item.dest) {
          const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
          if (dest) {
            const ref = dest[0]
            pageIndex = await pdf.getPageIndex(ref)
          }
        }
      } catch {
        pageIndex = 0
      }
      out.push({
        title: item.title || 'Untitled',
        pageIndex,
        items: item.items?.length ? await mapItems(item.items) : undefined
      })
    }
    return out
  }

  return mapItems(outline)
}
