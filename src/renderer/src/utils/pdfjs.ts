import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// Vite-friendly worker
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export { pdfjs }
export type { PDFDocumentProxy }

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const loadingTask = pdfjs.getDocument({ data: data.slice(0) })
  return loadingTask.promise
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
