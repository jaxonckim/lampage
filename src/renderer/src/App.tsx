import { useCallback, useEffect, useMemo, useState } from 'react'
import { TitleBar, FunctionBar } from './components/Toolbar'
import LeftSidebar from './components/LeftSidebar'
import RightSidebar from './components/RightSidebar'
import Splitter from './components/Splitter'
import FindBar from './components/FindBar'
import PdfViewer from './components/PdfViewer'
import MarkdownView from './components/MarkdownView'
import SelectionCopyButton from './components/SelectionCopyButton'
import PageManageModal from './components/PageManageModal'
import SignatureModal from './components/SignatureModal'
import { useAppStore, syncMdTextToData } from './stores/appStore'
import type { TocItem } from './types/docs'
import { encodeText } from './utils/id'
import { suppressPageSync } from './utils/pageSync'

export default function App(): JSX.Element {
  const docs = useAppStore((s) => s.docs)
  const activeId = useAppStore((s) => s.activeId)
  const leftWidth = useAppStore((s) => s.leftWidth)
  const rightWidth = useAppStore((s) => s.rightWidth)
  const leftCollapsed = useAppStore((s) => s.leftCollapsed)
  const rightCollapsed = useAppStore((s) => s.rightCollapsed)
  const setLeftWidth = useAppStore((s) => s.setLeftWidth)
  const setRightWidth = useAppStore((s) => s.setRightWidth)
  const addOpenedFiles = useAppStore((s) => s.addOpenedFiles)
  const updateDoc = useAppStore((s) => s.updateDoc)
  const setFindOpen = useAppStore((s) => s.setFindOpen)
  const requestFind = useAppStore((s) => s.requestFind)
  const findOpen = useAppStore((s) => s.findOpen)
  const pageManageOpen = useAppStore((s) => s.pageManageOpen)
  const signatureOpen = useAppStore((s) => s.signatureOpen)
  const closeDoc = useAppStore((s) => s.closeDoc)
  const findQuery = useAppStore((s) => s.findQuery)
  const setStatus = useAppStore((s) => s.setStatus)
  const status = useAppStore((s) => s.status)
  const doc = useMemo(() => docs.find((d) => d.id === activeId) ?? null, [docs, activeId])

  const [mdToc, setMdToc] = useState<TocItem[]>([])
  const [findTick, setFindTick] = useState(0)
  const [findDir, setFindDir] = useState<1 | -1>(1)
  const [findCur, setFindCur] = useState(0)
  const [findTotal, setFindTotal] = useState(0)
  const [dragging, setDragging] = useState(false)

  const onFindStats = useCallback((c: number, t: number) => {
    setFindCur(c)
    setFindTotal(t)
  }, [])

  const openFiles = useCallback(async () => {
    const files = await window.api.openFiles()
    if (files.length) addOpenedFiles(files)
  }, [addOpenedFiles])

  const saveDoc = useCallback(
    async (saveAs: boolean) => {
      if (!doc) return
      let working = doc
      if (doc.kind === 'md') working = syncMdTextToData(doc)
      let path = working.path
      if (saveAs || !path) {
        path = await window.api.saveFileDialog({
          defaultPath: working.name,
          filters:
            working.kind === 'pdf'
              ? [{ name: 'PDF', extensions: ['pdf'] }]
              : [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
        })
        if (!path) return
      }
      if (working.kind === 'md') {
        await window.api.writeFile(path, working.text ?? '')
      } else {
        await window.api.writeFile(path, working.data)
      }
      updateDoc(doc.id, {
        path,
        name: path.split(/[/\\]/).pop() || working.name,
        dirty: false,
        data: working.data,
        text: working.text
      })
      setStatus(`已保存 ${path}`)
    },
    [doc, updateDoc, setStatus]
  )

  const printDoc = useCallback(async () => {
    await window.api.print()
  }, [])

  const exportMdPdf = useCallback(async () => {
    if (!doc || doc.kind !== 'md') return
    setStatus('请在打印对话框中选择“另存为 PDF”')
    await window.api.print()
  }, [doc, setStatus])

  useEffect(() => {
    const offs = [
      window.api.onMenu('menu:open', () => openFiles()),
      window.api.onMenu('menu:save', () => saveDoc(false)),
      window.api.onMenu('menu:save-as', () => saveDoc(true)),
      window.api.onMenu('menu:print', () => printDoc()),
      window.api.onMenu('menu:find', () => requestFind())
    ]
    return () => offs.forEach((off) => off())
  }, [openFiles, saveDoc, printDoc, requestFind])

  // Ctrl/Cmd shortcuts (prevent browser defaults in Electron / web preview)
  // Do not intercept Ctrl/Cmd+C — native copy must work for PDF/MD selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc closes find when open (unless a modal owns the UI)
      if (e.key === 'Escape' && findOpen && !pageManageOpen && !signatureOpen) {
        const t = e.target as HTMLElement | null
        // FindBar input also handles Esc; this covers focus elsewhere
        if (!t?.closest('.modal-backdrop')) {
          e.preventDefault()
          setFindOpen(false)
          return
        }
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      // Never steal copy/cut/paste/select-all
      if (key === 'c' || key === 'x' || key === 'v' || key === 'a') return
      if (key === 'o') {
        e.preventDefault()
        void openFiles()
        return
      }
      if (key === 'p') {
        e.preventDefault()
        void printDoc()
        return
      }
      if (key === 'w') {
        e.preventDefault()
        if (activeId) closeDoc(activeId)
        return
      }
      if (key === 's') {
        e.preventDefault()
        void saveDoc(false)
        return
      }
      if (key === 'f') {
        e.preventDefault()
        requestFind()
        return
      }
      if (key === 'g') {
        // Ctrl+G / Ctrl+Shift+G → next/prev find match
        if (!findOpen) return
        e.preventDefault()
        setFindDir(e.shiftKey ? -1 : 1)
        setFindTick((x) => x + 1)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    openFiles,
    printDoc,
    saveDoc,
    requestFind,
    setFindOpen,
    findOpen,
    pageManageOpen,
    signatureOpen,
    activeId,
    closeDoc
  ])

  useEffect(() => {
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || !doc) return
      e.preventDefault()
      const next = doc.zoom + (e.deltaY < 0 ? 0.1 : -0.1)
      updateDoc(doc.id, { zoom: Math.min(3, Math.max(0.4, Number(next.toFixed(2)))) })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [doc, updateDoc])

  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      setDragging(true)
    }
    const onDragLeave = (): void => setDragging(false)
    const onDrop = async (e: DragEvent): Promise<void> => {
      e.preventDefault()
      setDragging(false)
      const files = e.dataTransfer?.files
      if (!files?.length) return
      const paths: string[] = []
      const browserFiles: { path: string; name: string; data: ArrayBuffer }[] = []
      for (const f of Array.from(files)) {
        const pth =
          typeof window.api.getPathForFile === 'function'
            ? window.api.getPathForFile(f)
            : (f as File & { path?: string }).path
        if (pth) paths.push(pth)
        else if (/\.(pdf|md|markdown)$/i.test(f.name)) {
          browserFiles.push({ path: f.name, name: f.name, data: await f.arrayBuffer() })
        }
      }
      if (paths.length) {
        const opened = await window.api.readDropped(paths)
        addOpenedFiles(opened)
      } else if (browserFiles.length) {
        addOpenedFiles(browserFiles)
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addOpenedFiles])

  const onPdfMutated = (data: ArrayBuffer): void => {
    if (!doc) return
    updateDoc(doc.id, { data, dirty: true, selectedPages: [], pageCount: undefined })
  }

  /*
   * Layout:
   *  title bar (full width)
   *  body-row: [left sidebar | splitter | center-pane]
   *    center-pane: function bar (spans main+right)
   *                 content-row: [viewer | splitter | right sidebar]
   *  status bar
   *
   * Collapse must keep a placeholder grid cell so columns don't shift
   * (returning null from sidebars previously put the main viewer into a 0px track).
   */
  const leftCols = leftCollapsed
    ? '0px 0px minmax(0, 1fr)'
    : `${leftWidth}px 5px minmax(0, 1fr)`
  const rightCols = rightCollapsed
    ? 'minmax(0, 1fr) 0px 0px'
    : `minmax(0, 1fr) 5px ${rightWidth}px`

  return (
    <div className="app-shell">
      <TitleBar onOpen={openFiles} />

      <div className="body-row" style={{ gridTemplateColumns: leftCols }}>
        {leftCollapsed ? (
          <div className="sidebar-placeholder" aria-hidden />
        ) : (
          <LeftSidebar />
        )}
        {leftCollapsed ? (
          <div className="sidebar-placeholder" aria-hidden />
        ) : (
          <Splitter onDrag={(dx) => setLeftWidth(leftWidth + dx)} />
        )}

        <div className="center-pane">
          <FunctionBar
            onSave={saveDoc}
            onPrint={printDoc}
            onExportPdf={exportMdPdf}
            onFind={() => requestFind()}
          />

          <div className="content-row" style={{ gridTemplateColumns: rightCols }}>
            <div className="viewer-wrap">
              {dragging && <div className="drag-overlay">释放以打开文件</div>}
              <FindBar
                matchLabel={findTotal ? `${findCur}/${findTotal}` : '无结果'}
                onNext={() => {
                  setFindDir(1)
                  setFindTick((x) => x + 1)
                }}
                onPrev={() => {
                  setFindDir(-1)
                  setFindTick((x) => x + 1)
                }}
              />
              <SelectionCopyButton />
              {!doc && (
                <div className="viewer">
                  <div className="empty">
                    <div>
                      <div className="empty-brand">Lampage</div>
                      打开 PDF 或 Markdown 开始阅读
                      <div style={{ marginTop: 14 }}>
                        <button type="button" className="btn-primary" onClick={openFiles}>
                          打开文件…
                        </button>
                      </div>
                      <div style={{ marginTop: 10, fontSize: 12 }}>也可拖拽文件到窗口</div>
                    </div>
                  </div>
                </div>
              )}
              {doc?.kind === 'pdf' && (
                <PdfViewer
                  doc={doc}
                  findQuery={findQuery}
                  findOpen={findOpen}
                  findTick={findTick}
                  findDir={findDir}
                  onFindStats={onFindStats}
                />
              )}
              {doc?.kind === 'md' && (
                <MarkdownView
                  doc={doc}
                  findQuery={findQuery}
                  findOpen={findOpen}
                  findTick={findTick}
                  findDir={findDir}
                  onFindStats={onFindStats}
                  onToc={setMdToc}
                />
              )}
            </div>

            {rightCollapsed ? (
              <div className="sidebar-placeholder" aria-hidden />
            ) : (
              <Splitter reverse onDrag={(dx) => setRightWidth(rightWidth + dx)} />
            )}
            {rightCollapsed ? (
              <div className="sidebar-placeholder" aria-hidden />
            ) : (
              <RightSidebar
                doc={doc}
                mdToc={mdToc}
                onJumpPage={(pageIndex) => {
                  if (!doc) return
                  suppressPageSync(700)
                  updateDoc(doc.id, { currentPage: pageIndex })
                  document.getElementById(`pdf-page-${doc.id}-${pageIndex}`)?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                  })
                }}
                onJumpHeading={(id) => {
                  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                onPdfMutated={onPdfMutated}
              />
            )}
          </div>
        </div>
      </div>

      <footer className="status-bar">{status}</footer>
      <PageManageModal doc={doc} onPdfMutated={onPdfMutated} />
      <SignatureModal doc={doc} onPdfMutated={onPdfMutated} />
    </div>
  )
}

void encodeText
