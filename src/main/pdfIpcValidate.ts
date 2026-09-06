/** Lightweight runtime validation for PDF IPC args (no zod dependency). */

const MAX_PDF_BYTES = 120 * 1024 * 1024 // 120 MiB
const MAX_IMAGE_BYTES = 25 * 1024 * 1024 // 25 MiB
const MAX_PAGES_ARG = 5000

export function assertPdfBytes(data: unknown): ArrayBuffer {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    throw new Error('Invalid PDF data')
  }
  const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  if (ab.byteLength <= 0 || ab.byteLength > MAX_PDF_BYTES) {
    throw new Error('Invalid PDF data size')
  }
  return ab as ArrayBuffer
}

export function assertImageBytes(data: unknown): ArrayBuffer {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    throw new Error('Invalid image data')
  }
  const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  if (ab.byteLength <= 0 || ab.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Invalid image data size')
  }
  return ab as ArrayBuffer
}

export function assertInt(n: unknown, label: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || !Number.isFinite(n)) {
    throw new Error(`Invalid ${label}`)
  }
  return n
}

export function assertPageIndex(n: unknown): number {
  const i = assertInt(n, 'pageIndex')
  if (i < 0 || i >= MAX_PAGES_ARG) throw new Error('Invalid pageIndex')
  return i
}

export function assertPageIndexes(arr: unknown): number[] {
  if (!Array.isArray(arr)) throw new Error('Invalid page indexes')
  if (arr.length > MAX_PAGES_ARG) throw new Error('Too many page indexes')
  return arr.map((x, i) => {
    const v = assertInt(x, `pageIndexes[${i}]`)
    if (v < 0 || v >= MAX_PAGES_ARG) throw new Error('Invalid page index')
    return v
  })
}

export function assertOrder(arr: unknown): number[] {
  return assertPageIndexes(arr)
}

export function assertAngle(a: unknown): 90 | 180 | 270 {
  if (a !== 90 && a !== 180 && a !== 270) throw new Error('Invalid rotation angle')
  return a
}

export function assertPositiveInt(n: unknown, label: string): number {
  const v = assertInt(n, label)
  if (v <= 0) throw new Error(`Invalid ${label}`)
  return v
}

export function assertMime(m: unknown): 'png' | 'jpg' {
  if (m !== 'png' && m !== 'jpg') throw new Error('Invalid mime')
  return m
}

export function assertRect(rect: unknown): { x: number; y: number; width: number; height: number } {
  if (!rect || typeof rect !== 'object') throw new Error('Invalid rect')
  const r = rect as Record<string, unknown>
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k] as number)) {
      throw new Error(`Invalid rect.${k}`)
    }
  }
  const width = r.width as number
  const height = r.height as number
  if (width <= 0 || height <= 0 || width > 20000 || height > 20000) {
    throw new Error('Invalid rect size')
  }
  const x = r.x as number
  const y = r.y as number
  if (Math.abs(x) > 50000 || Math.abs(y) > 50000) {
    throw new Error('Invalid rect position')
  }
  return { x, y, width, height }
}

export function assertRanges(ranges: unknown): Array<{ start: number; end: number }> {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 500) {
    throw new Error('Invalid ranges')
  }
  return ranges.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`Invalid ranges[${i}]`)
    const start = assertInt((r as { start: unknown }).start, `ranges[${i}].start`)
    const end = assertInt((r as { end: unknown }).end, `ranges[${i}].end`)
    if (start < 0 || end < start || end >= MAX_PAGES_ARG) throw new Error(`Invalid ranges[${i}]`)
    return { start, end }
  })
}

export function assertPdfList(list: unknown): ArrayBuffer[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
    throw new Error('Invalid PDF list')
  }
  return list.map((d) => assertPdfBytes(d))
}
