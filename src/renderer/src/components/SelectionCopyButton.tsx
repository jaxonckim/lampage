import { useEffect, useState } from 'react'

function selectionRootEl(node: Node | null): HTMLElement | null {
  if (!node) return null
  return node instanceof HTMLElement ? node : node.parentElement
}

/**
 * Floating “复制” button near the current text selection inside the viewer.
 * Works for PDF text layer and Markdown (read + edit).
 */
export default function SelectionCopyButton(): JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [text, setText] = useState('')

  useEffect(() => {
    let hideTimer = 0

    const isInsideViewer = (node: Node | null): boolean => {
      const el = selectionRootEl(node)
      return !!el?.closest('.viewer, .md-shell, .pdf-text-layer, .textLayer, .ProseMirror')
    }

    const update = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setVisible(false)
        setText('')
        return
      }
      const raw = sel.toString()
      if (!raw.trim()) {
        setVisible(false)
        setText('')
        return
      }
      const range = sel.getRangeAt(0)
      if (!isInsideViewer(range.commonAncestorContainer)) {
        setVisible(false)
        return
      }
      const anchorEl = selectionRootEl(sel.anchorNode)
      if (anchorEl?.closest('.find-bar, .selection-copy-btn')) {
        setVisible(false)
        return
      }
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) {
        setVisible(false)
        return
      }
      setText(raw)
      setPos({ x: rect.left + rect.width / 2, y: Math.max(8, rect.top) })
      setVisible(true)
    }

    const onMouseUp = (): void => {
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(update, 10)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift' || e.key.startsWith('Arrow')) {
        window.clearTimeout(hideTimer)
        hideTimer = window.setTimeout(update, 10)
      }
    }
    const onScroll = (): void => {
      setVisible((v) => {
        if (v) {
          // hide on scroll; avoids stale position
          return false
        }
        return v
      })
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.selection-copy-btn')) return
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed) {
          setVisible(false)
          setText('')
        }
      }, 0)
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      window.clearTimeout(hideTimer)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  if (!visible || !text) return null

  return (
    <button
      type="button"
      className="selection-copy-btn"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.left = '-9999px'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        window.getSelection()?.removeAllRanges()
        setVisible(false)
        setText('')
      }}
    >
      复制
    </button>
  )
}
