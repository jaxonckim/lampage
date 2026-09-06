import { useEffect, useMemo, useRef, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import type { OpenDoc, TocItem } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import {
  clearFindHighlights,
  findMatches,
  paintFindHighlights,
  scrollToMatch,
  type FindMatch
} from '../utils/textFind'

interface Props {
  doc: OpenDoc
  findQuery: string
  findOpen: boolean
  findTick: number
  findDir: 1 | -1
  onFindStats: (cur: number, total: number) => void
  onToc: (items: TocItem[]) => void
}

function markdownToHtml(md: string): string {
  // Lightweight MD -> HTML for TipTap initial content (good enough for common docs)
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBuf: string[] = []
  let inList = false

  const flushList = (): void => {
    if (inList) {
      html.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCode) {
        flushList()
        inCode = true
        codeLang = line.slice(3).trim()
        codeBuf = []
      } else {
        const code = codeBuf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const lang = codeLang.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
        html.push(`<pre data-language="${lang}"><code>${code}</code></pre>`)
        inCode = false
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>')
        inList = true
      }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    flushList()
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      html.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      html.push(`<blockquote><p>${inline(line.replace(/^\s*>\s?/, ''))}</p></blockquote>`)
      continue
    }
    if (!line.trim()) {
      html.push('<p></p>')
      continue
    }
    html.push(`<p>${inline(line)}</p>`)
  }
  flushList()
  if (inCode) {
    const code = codeBuf.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    html.push(`<pre><code>${code}</code></pre>`)
  }
  return html.join('\n')
}

function safeHref(href: string): string {
  const t = href.trim()
  if (!t) return '#'
  const lower = t.toLowerCase()
  if (
    lower.startsWith('https:') ||
    lower.startsWith('http:') ||
    lower.startsWith('mailto:') ||
    t.startsWith('#') ||
    t.startsWith('/') ||
    t.startsWith('./') ||
    t.startsWith('../')
  ) {
    return t.replace(/"/g, '&quot;')
  }
  return '#'
}

function inline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
      return `<a href="${safeHref(href)}">${label}</a>`
    })
}

function htmlToMarkdown(root: HTMLElement): string {
  const blocks: string[] = []
  const walk = (node: Node, listPrefix = ''): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      return
    }
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1])
      blocks.push(`${'#'.repeat(level)} ${node.textContent?.trim() || ''}`)
      blocks.push('')
      return
    }
    if (tag === 'p') {
      blocks.push(inlineMd(node))
      blocks.push('')
      return
    }
    if (tag === 'pre') {
      const code = node.querySelector('code')
      const lang = node.getAttribute('data-language') || ''
      blocks.push('```' + lang)
      blocks.push(code?.textContent || node.textContent || '')
      blocks.push('```')
      blocks.push('')
      return
    }
    if (tag === 'blockquote') {
      const t = node.textContent?.trim() || ''
      blocks.push(`> ${t}`)
      blocks.push('')
      return
    }
    if (tag === 'ul') {
      Array.from(node.children).forEach((li) => {
        if (li.tagName.toLowerCase() === 'li') blocks.push(`- ${inlineMd(li as HTMLElement)}`)
      })
      blocks.push('')
      return
    }
    if (tag === 'ol') {
      Array.from(node.children).forEach((li, i) => {
        if (li.tagName.toLowerCase() === 'li') blocks.push(`${i + 1}. ${inlineMd(li as HTMLElement)}`)
      })
      blocks.push('')
      return
    }
    node.childNodes.forEach((ch) => walk(ch, listPrefix))
  }
  root.childNodes.forEach((n) => walk(n))
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function inlineMd(el: HTMLElement): string {
  let out = ''
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent || ''
    else if (n instanceof HTMLElement) {
      const t = n.tagName.toLowerCase()
      if (t === 'strong' || t === 'b') out += `**${n.textContent}**`
      else if (t === 'em' || t === 'i') out += `*${n.textContent}*`
      else if (t === 'code') out += `\`${n.textContent}\``
      else if (t === 'a') out += `[${n.textContent}](${n.getAttribute('href') || ''})`
      else out += n.textContent || ''
    }
  })
  return out.trim()
}

export default function MarkdownView({
  doc,
  findQuery,
  findOpen,
  findTick,
  findDir,
  onFindStats,
  onToc
}: Props): JSX.Element {
  const mdEditMode = useAppStore((s) => s.mdEditMode)
  const updateDoc = useAppStore((s) => s.updateDoc)
  const shellRef = useRef<HTMLDivElement>(null)
  const matchIndex = useRef(0)
  const matchesRef = useRef<FindMatch[]>([])
  /** Suppress dirty while TipTap hydrates / programmatic setContent (onUpdate fires on load). */
  const suppressDirtyRef = useRef(true)
  const onFindStatsRef = useRef(onFindStats)
  onFindStatsRef.current = onFindStats
  const initialHtml = useMemo(() => markdownToHtml(doc.text || ''), [doc.id])

  // New doc → suppress again until editor finishes initial create/transforms
  useEffect(() => {
    suppressDirtyRef.current = true
  }, [doc.id])

  const refreshToc = useCallback(
    (dom: HTMLElement): void => {
      const headings = Array.from(dom.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      const items: TocItem[] = headings.map((h, i) => {
        const id = `md-h-${doc.id}-${i}`
        h.id = id
        return {
          id,
          level: Number(h.tagName.substring(1)),
          text: h.textContent || `Heading ${i + 1}`
        }
      })
      onToc(items)
    },
    [doc.id, onToc]
  )

  const decorateCodeCopy = useCallback((dom: HTMLElement): void => {
    dom.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'code-copy-btn'
      btn.textContent = '复制'
      btn.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const code = pre.querySelector('code')?.textContent || pre.textContent || ''
        // Strip the button label if it got into textContent
        const cleaned = code.replace(/\s*复制\s*$/, '').replace(/\s*已复制\s*$/, '')
        try {
          await navigator.clipboard.writeText(cleaned)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = cleaned
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        btn.textContent = '已复制'
        setTimeout(() => {
          btn.textContent = '复制'
        }, 1200)
      })
      pre.style.position = 'relative'
      pre.appendChild(btn)
    })
  }, [])

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Link.configure({
          openOnClick: false,
          protocols: ["http", "https", "mailto"],
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" }
        }),
        Placeholder.configure({ placeholder: '开始书写 Markdown...' }),
        Typography
      ],
      content: initialHtml,
      editable: mdEditMode,
      onUpdate: ({ editor: ed }) => {
        refreshToc(ed.view.dom)
        decorateCodeCopy(ed.view.dom)
        // TipTap often fires onUpdate during initial setContent / extension transforms.
        // Do not mark dirty (or rewrite text) until hydration completes.
        if (suppressDirtyRef.current) return
        const md = htmlToMarkdown(ed.view.dom)
        updateDoc(doc.id, { text: md, dirty: true })
      },
      onCreate: ({ editor: ed }) => {
        refreshToc(ed.view.dom)
        decorateCodeCopy(ed.view.dom)
        // Allow Typography / post-create transforms to settle, then arm dirty tracking
        queueMicrotask(() => {
          requestAnimationFrame(() => {
            suppressDirtyRef.current = false
          })
        })
      }
    },
    [doc.id]
  )

  useEffect(() => {
    if (!editor) return
    editor.setEditable(mdEditMode)
  }, [editor, mdEditMode])

  const applyFind = useCallback(() => {
    if (!editor) return
    const root = editor.view.dom as HTMLElement
    matchesRef.current = []
    matchIndex.current = 0

    if (!findOpen || !findQuery.trim()) {
      clearFindHighlights()
      onFindStatsRef.current(0, 0)
      return
    }

    const matches = findMatches(root, findQuery)
    matchesRef.current = matches
    if (!matches.length) {
      clearFindHighlights()
      onFindStatsRef.current(0, 0)
      return
    }
    matchIndex.current = 0
    paintFindHighlights(matches, 0)
    scrollToMatch(matches[0])
    onFindStatsRef.current(1, matches.length)
  }, [editor, findOpen, findQuery])

  const applyFindRef = useRef(applyFind)
  applyFindRef.current = applyFind

  useEffect(() => {
    const t = window.setTimeout(() => applyFindRef.current(), 120)
    return () => window.clearTimeout(t)
  }, [findQuery, findOpen, editor, doc.id])

  useEffect(() => {
    if (!findTick || !matchesRef.current.length) return
    const len = matchesRef.current.length
    matchIndex.current = (matchIndex.current + findDir + len) % len
    paintFindHighlights(matchesRef.current, matchIndex.current)
    scrollToMatch(matchesRef.current[matchIndex.current])
    onFindStatsRef.current(matchIndex.current + 1, len)
  }, [findTick, findDir])

  useEffect(() => {
    return () => {
      clearFindHighlights()
    }
  }, [])

  return (
    <div className="viewer">
      <div
        ref={shellRef}
        className={`md-shell ${mdEditMode ? '' : 'read-only'}`}
        style={{ zoom: doc.zoom }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
