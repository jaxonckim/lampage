/** Last signature size in PDF page units (points). Independent of document zoom. */

const LS_KEY = 'lampage.signatureSize.v1'

export type SigSizePt = { width: number; height: number }

const DEFAULT: SigSizePt = { width: 160, height: 60 }

export function loadSigSize(): SigSizePt {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT }
    const parsed = JSON.parse(raw) as Partial<SigSizePt>
    const width = Number(parsed.width)
    const height = Number(parsed.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ...DEFAULT }
    }
    return {
      width: Math.min(2000, Math.max(8, width)),
      height: Math.min(2000, Math.max(8, height))
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveSigSize(size: SigSizePt): void {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        width: Math.min(2000, Math.max(8, size.width)),
        height: Math.min(2000, Math.max(8, size.height))
      })
    )
  } catch {
    /* ignore */
  }
}

/** Prefer remembered size; otherwise default width with image aspect ratio. */
export function sizeForImage(naturalW: number, naturalH: number): SigSizePt {
  const remembered = loadSigSize()
  // If user has resized before, use that size as-is (may not match this image's aspect).
  try {
    if (localStorage.getItem(LS_KEY)) return remembered
  } catch {
    /* fall through */
  }
  const aspect = naturalW > 0 && naturalH > 0 ? naturalH / naturalW : remembered.height / remembered.width
  return { width: remembered.width, height: remembered.width * aspect }
}
