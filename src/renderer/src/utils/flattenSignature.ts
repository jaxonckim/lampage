import { loadPdf } from './pdfjs'

export type FlattenSigItem = {
  pageIndex: number
  imageData: ArrayBuffer
  mime: 'png' | 'jpg'
  /** PDF user-space (points), origin bottom-left (pdf-lib convention). */
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Flatten quality:
 * - renderScale ≈ max(3, devicePixelRatio * 2), capped at 4 → sharp text on retina
 * - Prefer PNG (lossless, sharp glyphs); if page exceeds ~16MP fall back to JPEG q=0.95
 * Tradeoff: target page(s) become bitmaps (no text select / vector extract);
 * PNG pages are larger on disk than the old JPEG@0.92 @2x path.
 */
function renderScaleForFlatten(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.min(4, Math.max(3, dpr * 2))
}

async function flattenOnePage(
  pdfData: ArrayBuffer,
  pageIndex: number,
  items: FlattenSigItem[]
): Promise<ArrayBuffer> {
  const pdf = await loadPdf(pdfData)
  try {
    const page = await pdf.getPage(pageIndex + 1)
    const base = page.getViewport({ scale: 1 })
    const renderScale = renderScaleForFlatten()
    const viewport = page.getViewport({ scale: renderScale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unsupported')

    // White page backdrop (PDF pages are typically opaque)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    await page.render({ canvasContext: ctx, viewport }).promise

    for (const item of items) {
      const blob = new Blob([item.imageData], {
        type: item.mime === 'png' ? 'image/png' : 'image/jpeg'
      })
      const bmp = await createImageBitmap(blob)
      try {
        const canvasX = item.rect.x * renderScale
        const canvasY = (base.height - item.rect.y - item.rect.height) * renderScale
        ctx.drawImage(
          bmp,
          canvasX,
          canvasY,
          item.rect.width * renderScale,
          item.rect.height * renderScale
        )
      } finally {
        bmp.close()
      }
    }

    const pixels = canvas.width * canvas.height
    const usePng = pixels <= 16_000_000
    const outBlob = await new Promise<Blob | null>((resolve) =>
      usePng
        ? canvas.toBlob((b) => resolve(b), 'image/png')
        : canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.95)
    )
    if (!outBlob) throw new Error('Failed to encode flattened page')
    const flatBytes = await outBlob.arrayBuffer()

    return window.api.pdf.replacePageImage(
      pdfData,
      pageIndex,
      flatBytes,
      usePng ? 'png' : 'jpg',
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

/**
 * Flatten-embed one or more signatures onto PDF page(s).
 * Groups by page so each affected page is rasterized once.
 */
export async function flattenEmbedSignatures(
  pdfData: ArrayBuffer,
  items: FlattenSigItem[]
): Promise<ArrayBuffer> {
  if (!items.length) return pdfData

  const byPage = new Map<number, FlattenSigItem[]>()
  for (const it of items) {
    const list = byPage.get(it.pageIndex) ?? []
    list.push(it)
    byPage.set(it.pageIndex, list)
  }

  // Process higher indexes first so earlier pageIndex values stay stable
  // (replacePageWithImage rebuilds the whole doc each time).
  const pages = Array.from(byPage.keys()).sort((a, b) => b - a)
  let data = pdfData
  for (const pageIndex of pages) {
    data = await flattenOnePage(data, pageIndex, byPage.get(pageIndex)!)
  }
  return data
}

/** @deprecated Prefer flattenEmbedSignatures — kept for any stray single-call sites. */
export async function flattenEmbedSignature(
  pdfData: ArrayBuffer,
  pageIndex: number,
  imageData: ArrayBuffer,
  mime: 'png' | 'jpg',
  rect: { x: number; y: number; width: number; height: number }
): Promise<ArrayBuffer> {
  return flattenEmbedSignatures(pdfData, [{ pageIndex, imageData, mime, rect }])
}
