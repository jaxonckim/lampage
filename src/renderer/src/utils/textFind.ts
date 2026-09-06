/** Non-destructive text find via CSS Custom Highlight API (Chromium/Electron). */

export const FIND_HL = 'lampage-find'
export const FIND_HL_CURRENT = 'lampage-find-current'

export type FindMatch = {
  range: Range
  /** Element used for scrollIntoView (nearest block/span). */
  scrollEl: HTMLElement
}

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

/** Collect text nodes under root, skipping script/style and our UI widgets. */
export function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, .code-copy-btn, .selection-copy-btn, .find-bar')) {
        return NodeFilter.FILTER_REJECT
      }
      // Skip empty / whitespace-only in PDF endOfContent etc. — still allow spaces inside content
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let n: Node | null
  while ((n = walker.nextNode())) out.push(n as Text)
  return out
}

type Piece = { node: Text; start: number; end: number }

function buildIndex(nodes: Text[]): { full: string; pieces: Piece[] } {
  const pieces: Piece[] = []
  let full = ''
  for (const node of nodes) {
    const val = node.nodeValue || ''
    pieces.push({ node, start: full.length, end: full.length + val.length })
    full += val
  }
  return { full, pieces }
}

function rangeFromOffsets(pieces: Piece[], from: number, to: number): Range | null {
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  for (const p of pieces) {
    if (startNode == null && from >= p.start && from < p.end) {
      startNode = p.node
      startOffset = from - p.start
    }
    // `to` is exclusive; allow to === p.end
    if (to > p.start && to <= p.end) {
      endNode = p.node
      endOffset = to - p.start
    }
  }
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
  } catch {
    return null
  }
}

function scrollTargetForRange(range: Range): HTMLElement {
  const node = range.startContainer
  if (node instanceof HTMLElement) return node
  return (node.parentElement as HTMLElement) || (range.commonAncestorContainer as HTMLElement)
}

/**
 * Find all case-insensitive occurrences of query under root.
 * Matches can span multiple text nodes (important for PDF text layer).
 */
export function findMatches(root: HTMLElement, query: string): FindMatch[] {
  const q = query.trim()
  if (!q) return []
  const nodes = collectTextNodes(root)
  if (!nodes.length) return []
  const { full, pieces } = buildIndex(nodes)
  const hay = full.toLowerCase()
  const needle = q.toLowerCase()
  const matches: FindMatch[] = []
  let from = 0
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) break
    const range = rangeFromOffsets(pieces, idx, idx + needle.length)
    if (range) {
      matches.push({ range, scrollEl: scrollTargetForRange(range) })
    }
    from = idx + Math.max(1, needle.length)
  }
  return matches
}

export function clearFindHighlights(): void {
  if (!highlightsSupported()) return
  CSS.highlights.delete(FIND_HL)
  CSS.highlights.delete(FIND_HL_CURRENT)
}

export function paintFindHighlights(matches: FindMatch[], currentIndex: number): void {
  if (!highlightsSupported()) {
    // Fallback: no CSS Highlight — leave DOM alone (selection/copy still works)
    return
  }
  if (!matches.length) {
    clearFindHighlights()
    return
  }
  const all = new Highlight(...matches.map((m) => m.range))
  CSS.highlights.set(FIND_HL, all)
  const cur = matches[currentIndex]
  if (cur) {
    CSS.highlights.set(FIND_HL_CURRENT, new Highlight(cur.range))
  } else {
    CSS.highlights.delete(FIND_HL_CURRENT)
  }
}

export function scrollToMatch(match: FindMatch): void {
  try {
    match.scrollEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  } catch {
    try {
      match.scrollEl.scrollIntoView({ block: 'center' })
    } catch {
      /* ignore */
    }
  }
}
