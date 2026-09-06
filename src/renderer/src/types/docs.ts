export type DocKind = 'pdf' | 'md'

export interface OpenDoc {
  id: string
  path: string | null
  name: string
  kind: DocKind
  data: ArrayBuffer
  text?: string
  dirty: boolean
  zoom: number
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
