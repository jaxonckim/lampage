/**
 * Reliable plain-text extraction for clipboard copy from PDF text layers.
 *
 * Strategy (literature / pdf.js TextLayer):
 * - Walk selected glyph text nodes in DOM order (matches visual highlight order
 *   for typical pdf.js reading-order layers — not geometric re-sort).
 * - Insert `\n` on `<br>` (pdf.js hasEOL) and across pages / clear line breaks.
 * - Prefer spaces already present in text-item content; only infer a space from
 *   geometry when both sides lack boundary whitespace AND the gap looks like a
 *   word gap (not flush glyphs, not punctuation/superscript attachment).
 * - Soft hyphens / discretionary line-end hyphens: join across EOL when the next
 *   run continues a word (lowercase), stripping the hyphen.
 * - Native Selection.toString() glues word-level spans (no interstitial DOM
 *   whitespace) — geometry remains necessary for those PDFs — but on papers
 *   where items already carry ", name" / spaces, native is closer; we match it
 *   by not inserting before punctuation.
 */

const NOISE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u00AD\u200B-\u200F\uFEFF]/g

/** Punctuation that should attach to the previous token (no leading space). */
const NO_SPACE_BEFORE_RE = /^[,.;:!?)\]}%°∗*†‡#$+\-–—@]/u
/** Opening punctuation that should attach to the following token. */
const NO_SPACE_AFTER_RE = /[(\[{“"‘']$/u

export function cleanCopiedText(s: string): string {
  return s.replace(NOISE_RE, '').normalize('NFC')
}

function selectionRootEl(node: Node | null): HTMLElement | null {
  if (!node) return null
  return node instanceof HTMLElement ? node : node.parentElement
}

/** True when the selection lives inside a PDF text layer / viewer. */
export function isPdfTextSelection(sel: Selection | null = window.getSelection()): boolean {
  if (!sel || !sel.rangeCount) return false
  const el = selectionRootEl(sel.getRangeAt(0).commonAncestorContainer)
  return !!el?.closest('.pdf-text-layer, .textLayer, .pdf-viewer')
}

function rangesOf(sel: Selection): Range[] {
  const out: Range[] = []
  for (let i = 0; i < sel.rangeCount; i++) out.push(sel.getRangeAt(i))
  return out
}

function isSkippedTextHost(el: Element | null): boolean {
  if (!el) return true
  if (el.classList.contains('endOfContent')) return true
  if (el.getAttribute('role') === 'img') return true
  if (el.closest('.endOfContent, [role="img"]')) return true
  return false
}

/**
 * pdf.js places glyphs inside absolutely-positioned <span>s.
 * Ignore interstitial whitespace text nodes between spans.
 */
function isPdfGlyphTextNode(tn: Text): boolean {
  const parent = tn.parentElement
  if (!parent || isSkippedTextHost(parent)) return false
  if (!parent.closest('.textLayer, .pdf-text-layer')) return false
  return parent.tagName === 'SPAN' || !!parent.closest('span')
}

/** Clamp selection ranges onto a text node; return selected substring + offsets. */
function selectedSliceDetailed(
  textNode: Text,
  ranges: Range[]
): { text: string; start: number; end: number } | null {
  let start = Infinity
  let end = -1
  for (const range of ranges) {
    try {
      if (!range.intersectsNode(textNode)) continue
    } catch {
      continue
    }
    try {
      const inter = range.cloneRange()
      const nodeRange = document.createRange()
      nodeRange.selectNodeContents(textNode)
      if (inter.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
        inter.setStart(textNode, 0)
      }
      if (inter.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
        inter.setEnd(textNode, textNode.length)
      }
      if (inter.collapsed) continue
      start = Math.min(start, inter.startOffset)
      end = Math.max(end, inter.endOffset)
    } catch {
      /* ignore */
    }
  }
  if (!(start < end)) return null
  return { text: textNode.data.slice(start, end), start, end }
}

type TextRun = {
  node: Text
  text: string
  firstRect: DOMRect | null
  lastRect: DOMRect | null
}

function sliceClientRects(textNode: Text, start: number, end: number): DOMRectList | null {
  try {
    const r = document.createRange()
    r.setStart(textNode, start)
    r.setEnd(textNode, end)
    return r.getClientRects()
  } catch {
    return null
  }
}

function pageIndexOf(node: Node): number {
  const el = selectionRootEl(node)
  const page = el?.closest('.pdf-page-wrap') as HTMLElement | null
  if (!page) return 0
  const idx = Number(page.dataset.pageIndex || 0)
  return Number.isFinite(idx) ? idx : 0
}

/** True if a `<br>` appears strictly between two text nodes in document order. */
function brBetween(a: Text, b: Text): boolean {
  try {
    const range = document.createRange()
    range.setStart(a, a.length)
    range.setEnd(b, 0)
    const root = range.commonAncestorContainer
    const scope: Element | Document =
      root.nodeType === Node.ELEMENT_NODE ? (root as Element) : (root.ownerDocument as Document)
    const brs = scope.querySelectorAll('br')
    for (const br of brs) {
      const afterA = !!(a.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_FOLLOWING)
      const beforeB = !!(br.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      if (afterA && beforeB) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** Soft / discretionary hyphens only — not ASCII '-' (often intentional). */
function endsWithSoftHyphen(s: string): boolean {
  return /[\u00AD\u2010\u2011]$/.test(s)
}

function stripTrailingSoftHyphen(s: string): string {
  return s.replace(/[\u00AD\u2010\u2011]$/, '')
}

/**
 * Soft hyphenation across a line break:
 * "experi\u00AD" + "ment" → "experiment" (soft hyphen dropped, no newline).
 * ASCII hard hyphens at EOL are left intact to match native Selection.toString().
 */
function shouldDehyphenate(prev: string, next: string): boolean {
  if (!endsWithSoftHyphen(prev)) return false
  if (!next) return false
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(next)
}

function isSameVisualLine(prev: TextRun, next: TextRun): boolean {
  const prevRect = prev.lastRect
  const nextRect = next.firstRect
  if (!prevRect || !nextRect) return true // unknown → treat as same line (no forced newline)
  const lineH = Math.max(1, prevRect.height, nextRect.height)
  const prevMidY = (prevRect.top + prevRect.bottom) / 2
  const nextMidY = (nextRect.top + nextRect.bottom) / 2
  return Math.abs(nextMidY - prevMidY) <= lineH * 0.5
}

/**
 * Decide separator between two consecutive selected runs.
 * Returns { sep, prevText } so dehyphenation can rewrite the previous chunk.
 */
function separatorBetween(
  prev: TextRun,
  next: TextRun
): { sep: string; rewritePrev?: string } {
  const hasBr = brBetween(prev.node, next.node)
  const prevPage = pageIndexOf(prev.node)
  const nextPage = pageIndexOf(next.node)
  const crossPage = prevPage !== nextPage
  const sameLine = !hasBr && !crossPage && isSameVisualLine(prev, next)
  const lineBreak = hasBr || crossPage || !sameLine

  if (lineBreak && shouldDehyphenate(prev.text, next.text)) {
    return { sep: '', rewritePrev: stripTrailingSoftHyphen(prev.text) }
  }

  if (lineBreak) return { sep: '\n' }

  // Same line: trust existing whitespace in text content
  if (/\s$/.test(prev.text) || /^\s/.test(next.text)) return { sep: '' }

  // Punctuation / marker attachment (common in academic author lists, emails)
  if (NO_SPACE_BEFORE_RE.test(next.text)) return { sep: '' }
  if (NO_SPACE_AFTER_RE.test(prev.text)) return { sep: '' }

  const prevRect = prev.lastRect
  const nextRect = next.firstRect
  if (!prevRect || !nextRect) {
    // No geometry: do not invent spaces (matches native concatenation)
    return { sep: '' }
  }

  const lineH = Math.max(1, prevRect.height, nextRect.height)
  const gap = nextRect.left - prevRect.right

  // Overlap / flush / tiny tracking → same word (e.g. "Lamp"+"age", "Gal"+"∗")
  if (gap <= lineH * 0.06) return { sep: '' }

  // Word gap: require a clearer gap than before so footnote markers / scaled
  // spans at odd zoom levels do not sprout spaces before commas.
  // ~0.22–0.25em of line box; floor scales with CSS zoom because rects scale.
  const spaceThreshold = Math.max(2, lineH * 0.26)
  if (gap > spaceThreshold) return { sep: ' ' }

  return { sep: '' }
}

/**
 * Walk text nodes intersecting the selection in document order and rebuild
 * plain text with EOL newlines and conservative gap spaces.
 */
function extractPdfSelectionByDomOrder(ranges: Range[]): string {
  if (!ranges.length) return ''

  let root: Node | null = null
  for (const r of ranges) {
    const el = selectionRootEl(r.commonAncestorContainer)
    const viewer = el?.closest('.pdf-viewer')
    if (viewer) {
      root = viewer
      break
    }
  }
  if (!root) root = ranges[0].commonAncestorContainer

  const runs: TextRun[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const tn = n as Text
    if (!isPdfGlyphTextNode(tn)) continue

    let intersects = false
    for (const r of ranges) {
      try {
        if (r.intersectsNode(tn)) {
          intersects = true
          break
        }
      } catch {
        /* ignore */
      }
    }
    if (!intersects) continue

    const detail = selectedSliceDetailed(tn, ranges)
    if (!detail || !detail.text) continue

    const rects = sliceClientRects(tn, detail.start, detail.end)
    const firstRect = rects && rects.length ? rects[0] : null
    const lastRect = rects && rects.length ? rects[rects.length - 1] : null

    runs.push({
      node: tn,
      text: detail.text,
      firstRect,
      lastRect
    })
  }

  if (!runs.length) return ''

  const parts: string[] = [runs[0].text]
  for (let i = 1; i < runs.length; i++) {
    const { sep, rewritePrev } = separatorBetween(runs[i - 1], runs[i])
    if (rewritePrev != null) parts[parts.length - 1] = rewritePrev
    parts.push(sep)
    parts.push(runs[i].text)
  }
  return parts.join('')
}

/**
 * Build plain text from the current Selection.
 * PDF: DOM-order runs + EOL / conservative spaces (see file header).
 * Other: cleaned Selection.toString().
 */
export function getSelectionPlainText(sel: Selection | null = window.getSelection()): string {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return ''

  const ranges = rangesOf(sel)
  const anchorEl = selectionRootEl(ranges[0].commonAncestorContainer)
  const pdfRoot = anchorEl?.closest('.pdf-viewer') as HTMLElement | null

  if (!pdfRoot) {
    return cleanCopiedText(sel.toString())
  }

  const walked = extractPdfSelectionByDomOrder(ranges)
  if (!walked) {
    return cleanCopiedText(sel.toString())
  }
  return cleanCopiedText(walked)
}

/** Write plain text to the clipboard (async Clipboard API with execCommand fallback). */
export async function writeClipboardText(text: string): Promise<void> {
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
}
