import { PDFDocument, degrees } from 'pdf-lib'

export async function deletePages(pdfBytes: Uint8Array, pageIndexes: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  const toDelete = [...new Set(pageIndexes)].sort((a, b) => b - a)
  for (const i of toDelete) {
    if (i >= 0 && i < doc.getPageCount()) doc.removePage(i)
  }
  return doc.save()
}

export async function insertBlankPage(pdfBytes: Uint8Array, afterIndex: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const count = src.getPageCount()
  const size =
    count > 0
      ? src.getPage(Math.min(Math.max(afterIndex, 0), count - 1)).getSize()
      : { width: 595, height: 842 }
  const indices = Array.from({ length: count }, (_, i) => i)
  const copied = await out.copyPages(src, indices)
  const insertAt = Math.min(Math.max(afterIndex + 1, 0), count)
  for (let i = 0; i < insertAt; i++) out.addPage(copied[i])
  out.addPage([size.width, size.height])
  for (let i = insertAt; i < count; i++) out.addPage(copied[i])
  return out.save()
}

export async function reorderPages(pdfBytes: Uint8Array, newOrder: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, newOrder)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

export async function extractPages(pdfBytes: Uint8Array, pageIndexes: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, pageIndexes)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

export async function splitByRanges(
  pdfBytes: Uint8Array,
  ranges: Array<{ start: number; end: number }>
): Promise<Uint8Array[]> {
  const results: Uint8Array[] = []
  for (const r of ranges) {
    const indexes: number[] = []
    for (let i = r.start; i <= r.end; i++) indexes.push(i)
    results.push(await extractPages(pdfBytes, indexes))
  }
  return results
}

export async function splitEveryN(pdfBytes: Uint8Array, n: number): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(pdfBytes)
  const count = src.getPageCount()
  const results: Uint8Array[] = []
  for (let i = 0; i < count; i += n) {
    const indexes = Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k)
    results.push(await extractPages(pdfBytes, indexes))
  }
  return results
}

export async function mergePdfs(pdfList: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const bytes of pdfList) {
    const src = await PDFDocument.load(bytes)
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  return out.save()
}

export async function rotatePages(
  pdfBytes: Uint8Array,
  pageIndexes: number[],
  angle: 90 | 180 | 270 = 90
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  for (const i of pageIndexes) {
    if (i >= 0 && i < doc.getPageCount()) {
      const page = doc.getPage(i)
      const current = page.getRotation().angle
      page.setRotation(degrees((current + angle) % 360))
    }
  }
  return doc.save()
}

export async function duplicatePage(pdfBytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  return duplicatePages(pdfBytes, [pageIndex])
}

export async function duplicatePages(pdfBytes: Uint8Array, pageIndexes: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const selected = new Set(pageIndexes)
  const count = src.getPageCount()
  const order: number[] = []
  for (let i = 0; i < count; i++) {
    order.push(i)
    if (selected.has(i)) order.push(i)
  }
  const pages = await out.copyPages(src, order)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

export async function reversePages(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const count = src.getPageCount()
  const order = Array.from({ length: count }, (_, i) => count - 1 - i)
  return reorderPages(pdfBytes, order)
}

export async function embedSignatureImage(
  pdfBytes: Uint8Array,
  pageIndex: number,
  imageBytes: Uint8Array,
  mime: 'png' | 'jpg',
  rect: { x: number; y: number; width: number; height: number }
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  const page = doc.getPage(pageIndex)
  const image =
    mime === 'png' ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes)
  page.drawImage(image, {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  })
  return doc.save()
}
