/** Fit-zoom helpers shared by Toolbar and PdfViewer. */

import type { ZoomFitMode } from '../types/docs'

export type { ZoomFitMode }

/** Must match PdfViewer chrome (PAD_*) so fit accounts for scaled padding. */
export const FIT_PAD_X = 16
export const FIT_PAD_TOP = 24
export const FIT_PAD_BOTTOM = 48

const ZOOM_MIN = 0.4
const ZOOM_MAX = 3

export function clampFitZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z.toFixed(2))))
}

/**
 * Compute fit zoom from page size at zoom=1 and available viewer size.
 * Content size at zoom z ≈ (page + chrome) * z.
 */
export function computeFitZoomFromPageSize(
  pageW1: number,
  pageH1: number,
  availW: number,
  availH: number,
  mode: ZoomFitMode
): number | null {
  if (pageW1 <= 0 || pageH1 <= 0 || availW <= 0 || availH <= 0) return null
  const zW = availW / (pageW1 + 2 * FIT_PAD_X)
  const zH = availH / (pageH1 + FIT_PAD_TOP + FIT_PAD_BOTTOM)
  const next = mode === 'width' ? zW : Math.min(zW, zH)
  return clampFitZoom(next)
}

/** Measure a rendered .pdf-page-wrap and derive fit zoom. */
export function computeFitZoomFromDom(
  viewer: HTMLElement,
  pageEl: HTMLElement,
  currentZoom: number,
  mode: ZoomFitMode
): number | null {
  const zNow = Math.max(currentZoom, 1e-6)
  const pageW1 = pageEl.offsetWidth / zNow
  const pageH1 = pageEl.offsetHeight / zNow
  return computeFitZoomFromPageSize(
    pageW1,
    pageH1,
    viewer.clientWidth,
    viewer.clientHeight,
    mode
  )
}
