import { FileText, X } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

async function openWelcomeSample(): Promise<void> {
  try {
    const res = await fetch('/samples/welcome.md')
    if (!res.ok) throw new Error(String(res.status))
    const text = await res.text()
    const data = new TextEncoder().encode(text).buffer
    useAppStore.getState().addOpenedFiles([{ path: 'welcome.md', name: 'welcome.md', data }])
  } catch {
    useAppStore.getState().setStatus('请通过「打开」加载 samples/welcome.md')
  }
}

export default function LeftSidebar(): JSX.Element {
  const docs = useAppStore((s) => s.docs)
  const activeId = useAppStore((s) => s.activeId)
  const setActive = useAppStore((s) => s.setActive)
  const closeDoc = useAppStore((s) => s.closeDoc)

  return (
    <aside className="sidebar left">
      <div className="sidebar-header">
        <span>已打开</span>
      </div>
      <ul className="file-list">
        {docs.length === 0 && (
          <li className="outline-empty" style={{ padding: 16 }}>
            尚未打开文件
          </li>
        )}
        {docs.map((d) => (
          <li
            key={d.id}
            className={`file-item ${d.id === activeId ? 'active' : ''}`}
            onClick={() => setActive(d.id)}
          >
            <FileText className="file-icon" size={15} strokeWidth={1.6} />
            <span className="name" title={d.path || d.name}>
              {d.dirty ? '• ' : ''}
              {d.name}
            </span>
            <span className={`badge ${d.kind}`}>{d.kind.toUpperCase()}</span>
            <button
              type="button"
              className="close"
              title="关闭"
              aria-label={`关闭 ${d.name}`}
              onClick={(e) => {
                e.stopPropagation()
                closeDoc(d.id)
              }}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-section-label">示例</div>
      <ul className="file-list" style={{ flex: '0 0 auto', paddingTop: 0 }}>
        <li
          className="file-item"
          title="打开示例 welcome.md"
          onClick={() => void openWelcomeSample()}
        >
          <FileText className="file-icon" size={15} strokeWidth={1.6} />
          <span className="name">welcome.md</span>
          <span className="badge md">MD</span>
        </li>
      </ul>
    </aside>
  )
}
