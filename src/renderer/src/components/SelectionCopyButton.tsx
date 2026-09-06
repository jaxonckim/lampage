import { useEffect, useState } from 'react'
import { getSelectionPlainText, writeClipboardText } from '../utils/selectionText'

function selectionRootEl(node: Node | null): HTMLElement | null {
  if (!node) return null
  return node instanceof HTMLElement ? node : node.parentElement
}

/**
 * Floating “复制” button near the current text selection inside the viewer.
 * Works for PDF text layer and Markdown (read + edit).
 * Uses the same plain-text builder as Ctrl+C for PDF selections.
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
      const plain = getSelectionPlainText(sel)
      if (!plain.trim()) {
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
      setText(plain)
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
        // Re-read at click time so text stays in sync with the live selection
        const live = getSelectionPlainText() || text
        await writeClipboardText(live)
        window.getSelection()?.removeAllRanges()
        setVisible(false)
        setText('')
      }}
    >
      复制
    </button>
  )
}
