export type DocKind = 'pdf' | 'md'

/** PDF zoom fit mode; null = free/manual zoom. */
export type ZoomFitMode = 'width' | 'page'

export interface OpenDoc {
  id: string
  path: string | null
  name: string
  kind: DocKind
  data: ArrayBuffer
  text?: string
  dirty: boolean
  zoom: number
  /** Active fit mode for PDFs; null when user zooms manually. */
  zoomFit: ZoomFitMode | null
  currentPage: number
  pageCount?: number
  selectedPages: number[]
}

export interface OutlineItem {
  title: string
  pageIndex: number
  items?: OutlineItem[]
}

export interface TocItem {
  id: string
  level: number
  text: string
}
