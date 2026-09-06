import { FileText, X } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

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
    </aside>
  )
}
