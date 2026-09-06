import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  FileUp,
  Layers,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Printer,
  Save,
  Search,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { suppressPageSync } from '../utils/pageSync'

interface ChromeProps {
  onOpen: () => void
  onSave: (saveAs: boolean) => void
  onPrint: () => void
  onExportPdf: () => void
  onFind: () => void
}

/** Topmost brand row: left toggle → brand ··· 打开 → right toggle. */
export function TitleBar({ onOpen }: { onOpen: () => void }): JSX.Element {
  const leftCollapsed = useAppStore((s) => s.leftCollapsed)
  const rightCollapsed = useAppStore((s) => s.rightCollapsed)
  const toggleLeftCollapsed = useAppStore((s) => s.toggleLeftCollapsed)
  const toggleRightCollapsed = useAppStore((s) => s.toggleRightCollapsed)

  const leftTip = leftCollapsed ? '展开左侧栏' : '收起左侧栏'
  const rightTip = rightCollapsed ? '展开右侧栏' : '收起右侧栏'

  return (
    <div className="app-header">
      <button
        type="button"
        className={`icon-btn sidebar-toggle${leftCollapsed ? '' : ' active'}`}
        onClick={toggleLeftCollapsed}
        title={leftTip}
        aria-label={leftTip}
        aria-pressed={!leftCollapsed}
      >
        {leftCollapsed ? (
          <PanelLeftOpen size={16} strokeWidth={1.75} />
        ) : (
          <PanelLeftClose size={16} strokeWidth={1.75} />
        )}
      </button>
      <div className="brand">Lampage</div>
      <div className="toolbar-grow" />
      <button type="button" className="btn-primary" onClick={onOpen} title="打开" aria-label="打开">
        <FileUp size={14} strokeWidth={1.75} />
        打开
      </button>
      <button
        type="button"
        className={`icon-btn sidebar-toggle${rightCollapsed ? '' : ' active'}`}
        onClick={toggleRightCollapsed}
        title={rightTip}
        aria-label={rightTip}
        aria-pressed={!rightCollapsed}
      >
        {rightCollapsed ? (
          <PanelRightOpen size={16} strokeWidth={1.75} />
        ) : (
          <PanelRightClose size={16} strokeWidth={1.75} />
        )}
      </button>
    </div>
  )
}

/** Function bar: filename + tools. Sits above main viewer + right sidebar only. */
export function FunctionBar({
  onSave,
  onPrint,
  onExportPdf,
  onFind
}: Omit<ChromeProps, 'onOpen'>): JSX.Element {
  const doc = useAppStore((s) => s.activeDoc())
  const mdEditMode = useAppStore((s) => s.mdEditMode)
  const setMdEditMode = useAppStore((s) => s.setMdEditMode)
  const updateDoc = useAppStore((s) => s.updateDoc)
  const setPageManageOpen = useAppStore((s) => s.setPageManageOpen)
  const setSignatureOpen = useAppStore((s) => s.setSignatureOpen)

  const zoom = doc?.zoom ?? 1
  const setZoom = (z: number): void => {
    if (!doc) return
    updateDoc(doc.id, { zoom: Math.min(3, Math.max(0.4, Number(z.toFixed(2)))) })
  }

  /** Match PdfViewer chrome so fit zoom accounts for scaled padding. */
  const FIT_PAD_X = 16
  const FIT_PAD_TOP = 24
  const FIT_PAD_BOTTOM = 48

  const fitZoom = (mode: 'width' | 'page'): void => {
    if (!doc || doc.kind !== 'pdf') return
    const viewer = document.querySelector('.pdf-viewer') as HTMLElement | null
    const pageEl =
      document.getElementById(`pdf-page-${doc.id}-${doc.currentPage}`) ??
      (viewer?.querySelector('.pdf-page-wrap') as HTMLElement | null)
    if (!viewer || !pageEl) return
    const zNow = Math.max(doc.zoom, 1e-6)
    // Page wrap width/height are at current zoom; normalize to zoom=1.
    const pageW1 = pageEl.offsetWidth / zNow
    const pageH1 = pageEl.offsetHeight / zNow
    if (pageW1 <= 0 || pageH1 <= 0) return
    const availW = viewer.clientWidth
    const availH = viewer.clientHeight
    if (availW <= 0 || availH <= 0) return
    // Content size at zoom z ≈ (page + chrome) * z  (center pad is 0 when fitting).
    const zW = availW / (pageW1 + 2 * FIT_PAD_X)
    const zH = availH / (pageH1 + FIT_PAD_TOP + FIT_PAD_BOTTOM)
    const next = mode === 'width' ? zW : Math.min(zW, zH)
    setZoom(next)
  }

  const pageCount = doc?.kind === 'pdf' ? doc.pageCount ?? 0 : 0
  const pageLabel =
    doc?.kind === 'pdf'
      ? pageCount
        ? `${doc.currentPage + 1}/${pageCount}`
        : `${doc.currentPage + 1}/–`
      : '—'

  const goPage = (delta: number): void => {
    if (!doc || doc.kind !== 'pdf') return
    const max = Math.max(0, (doc.pageCount ?? doc.currentPage + 1) - 1)
    const next = Math.min(max, Math.max(0, doc.currentPage + delta))
    suppressPageSync(600)
    updateDoc(doc.id, { currentPage: next })
    document.getElementById(`pdf-page-${doc.id}-${next}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }

  const title = doc ? `${doc.name}${doc.dirty ? ' *' : ''}` : '未打开文档'

  return (
    <div className="secondary-toolbar">
      <span className={`doc-title${doc ? '' : ' muted'}`} title={title}>
        {title}
      </span>

      <div className="toolbar-grow" />

      <button
        type="button"
        className="icon-btn"
        disabled={!doc || doc.kind !== 'pdf'}
        onClick={() => goPage(-1)}
        title="上一页"
        aria-label="上一页"
      >
        <ChevronLeft size={16} strokeWidth={1.75} />
      </button>
      <span className="page-indicator">{pageLabel}</span>
      <button
        type="button"
        className="icon-btn"
        disabled={!doc || doc.kind !== 'pdf'}
        onClick={() => goPage(1)}
        title="下一页"
        aria-label="下一页"
      >
        <ChevronRight size={16} strokeWidth={1.75} />
      </button>

      <span className="toolbar-sep" />

      <button
        type="button"
        className="icon-btn"
        disabled={!doc}
        onClick={() => setZoom(zoom - 0.1)}
        title="缩小"
        aria-label="缩小"
      >
        <ZoomOut size={16} strokeWidth={1.75} />
      </button>
      <span className="zoom-label">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        className="icon-btn"
        disabled={!doc}
        onClick={() => setZoom(zoom + 0.1)}
        title="放大"
        aria-label="放大"
      >
        <ZoomIn size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={!doc || doc.kind !== 'pdf'}
        onClick={() => fitZoom('width')}
        title="适应宽度"
        aria-label="适应宽度"
      >
        <ArrowLeftRight size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={!doc || doc.kind !== 'pdf'}
        onClick={() => fitZoom('page')}
        title="适应页面"
        aria-label="适应页面"
      >
        <Maximize2 size={16} strokeWidth={1.75} />
      </button>

      <span className="toolbar-sep" />

      <button
        type="button"
        className="icon-btn"
        disabled={!doc}
        onClick={() => onSave(false)}
        title="保存"
        aria-label="保存"
      >
        <Save size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={!doc}
        onClick={onFind}
        title="查找"
        aria-label="查找"
      >
        <Search size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={!doc}
        onClick={onPrint}
        title="打印"
        aria-label="打印"
      >
        <Printer size={16} strokeWidth={1.75} />
      </button>

      {doc?.kind === 'md' && (
        <>
          <span className="toolbar-sep" />
          <button
            type="button"
            className={`icon-btn${mdEditMode ? ' active' : ''}`}
            onClick={() => setMdEditMode(!mdEditMode)}
            title={mdEditMode ? '阅读模式' : '编辑模式'}
            aria-label={mdEditMode ? '阅读模式' : '编辑模式'}
          >
            <Pencil size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onExportPdf}
            title="导出 PDF"
            aria-label="导出 PDF"
          >
            <FileUp size={16} strokeWidth={1.75} />
          </button>
        </>
      )}

      {doc?.kind === 'pdf' && (
        <>
          <span className="toolbar-sep" />
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPageManageOpen(true)}
            title="页面管理"
            aria-label="页面管理"
          >
            <Layers size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSignatureOpen(true)}
            title="签名 (Alt+S)"
            aria-label="签名"
          >
            <FilePenLine size={16} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  )
}

/** @deprecated Prefer TitleBar + FunctionBar; kept for any stray imports. */
export default function Toolbar(props: ChromeProps): JSX.Element {
  return (
    <div className="top-chrome">
      <TitleBar onOpen={props.onOpen} />
      <FunctionBar
        onSave={props.onSave}
        onPrint={props.onPrint}
        onExportPdf={props.onExportPdf}
        onFind={props.onFind}
      />
    </div>
  )
}
