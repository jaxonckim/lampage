import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

interface Props {
  onNext: () => void
  onPrev: () => void
  matchLabel: string
}

export default function FindBar({ onNext, onPrev, matchLabel }: Props): JSX.Element | null {
  const open = useAppStore((s) => s.findOpen)
  const query = useAppStore((s) => s.findQuery)
  const findFocusNonce = useAppStore((s) => s.findFocusNonce)
  const setFindOpen = useAppStore((s) => s.setFindOpen)
  const setFindQuery = useAppStore((s) => s.setFindQuery)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [open, findFocusNonce])

  if (!open) return null

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        value={query}
        placeholder="查找..."
        aria-label="查找"
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            if (e.shiftKey) onPrev()
            else onNext()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setFindOpen(false)
          }
        }}
      />
      <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 48, textAlign: 'center' }}>
        {matchLabel}
      </span>
      <button type="button" className="icon-btn" onClick={onPrev} title="上一个" aria-label="上一个">
        <ChevronUp size={16} strokeWidth={1.75} />
      </button>
      <button type="button" className="icon-btn" onClick={onNext} title="下一个" aria-label="下一个">
        <ChevronDown size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setFindOpen(false)}
        title="关闭"
        aria-label="关闭"
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  )
}
