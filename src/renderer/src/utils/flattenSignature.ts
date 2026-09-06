import { loadPdf } from './pdfjs'

/**
 * Flatten-embed a signature onto one PDF page:
 * 1) render the page with pdf.js
 * 2) draw the signature onto the canvas at PDF page coords
 * 3) replace that page with the raster via pdf-lib (IPC / browser api)
 *
 * Tradeoff: the target page becomes a bitmap — selectable text/vectors on that page are lost.
 *
 * @param rect PDF user-space (points), origin bottom-left (pdf-lib convention)
 */
export async function flattenEmbedSignature(
  pdfData: ArrayBuffer,
  pageIndex: number,
  imageData: ArrayBuffer,
  mime: 'png' | 'jpg',
  rect: { x: number; y: number; width: number; height: number }
): Promise<ArrayBuffer> {
  const pdf = await loadPdf(pdfData)
  try {
    const page = await pdf.getPage(pageIndex + 1)
    const base = page.getViewport({ scale: 1 })
    const renderScale = 2
    const viewport = page.getViewport({ scale: renderScale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unsupported')

    await page.render({ canvasContext: ctx, viewport }).promise

    const blob = new Blob([imageData], { type: mime === 'png' ? 'image/png' : 'image/jpeg' })
    const bmp = await createImageBitmap(blob)
    try {
      const canvasX = rect.x * renderScale
      const canvasY = (base.height - rect.y - rect.height) * renderScale
      ctx.drawImage(bmp, canvasX, canvasY, rect.width * renderScale, rect.height * renderScale)
    } finally {
      bmp.close()
    }

    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
    )
    if (!outBlob) throw new Error('Failed to encode flattened page')
    const flatBytes = await outBlob.arrayBuffer()

    return window.api.pdf.replacePageImage(
      pdfData,
      pageIndex,
      flatBytes,
      'jpg',
      base.width,
      base.height
    )
  } finally {
    try {
      pdf.destroy()
    } catch {
      /* ignore */
    }
  }
}
