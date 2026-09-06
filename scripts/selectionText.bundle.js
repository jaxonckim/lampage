// src/renderer/src/utils/selectionText.ts
var NOISE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u00AD\u200B-\u200F\uFEFF]/g;
var NO_SPACE_BEFORE_RE = /^[,.;:!?)\]}%°∗*†‡#$+\-–—@]/u;
var NO_SPACE_AFTER_RE = /[(\[{“"‘']$/u;
function cleanCopiedText(s) {
  return s.replace(NOISE_RE, "").normalize("NFC");
}
function selectionRootEl(node) {
  if (!node)
    return null;
  return node instanceof HTMLElement ? node : node.parentElement;
}
function isPdfTextSelection(sel = window.getSelection()) {
  if (!sel || !sel.rangeCount)
    return false;
  const el = selectionRootEl(sel.getRangeAt(0).commonAncestorContainer);
  return !!el?.closest(".pdf-text-layer, .textLayer, .pdf-viewer");
}
function rangesOf(sel) {
  const out = [];
  for (let i = 0;i < sel.rangeCount; i++)
    out.push(sel.getRangeAt(i));
  return out;
}
function isSkippedTextHost(el) {
  if (!el)
    return true;
  if (el.classList.contains("endOfContent"))
    return true;
  if (el.getAttribute("role") === "img")
    return true;
  if (el.closest('.endOfContent, [role="img"]'))
    return true;
  return false;
}
function isPdfGlyphTextNode(tn) {
  const parent = tn.parentElement;
  if (!parent || isSkippedTextHost(parent))
    return false;
  if (!parent.closest(".textLayer, .pdf-text-layer"))
    return false;
  return parent.tagName === "SPAN" || !!parent.closest("span");
}
function selectedSliceDetailed(textNode, ranges) {
  let start = Infinity;
  let end = -1;
  for (const range of ranges) {
    try {
      if (!range.intersectsNode(textNode))
        continue;
    } catch {
      continue;
    }
    try {
      const inter = range.cloneRange();
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(textNode);
      if (inter.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
        inter.setStart(textNode, 0);
      }
      if (inter.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
        inter.setEnd(textNode, textNode.length);
      }
      if (inter.collapsed)
        continue;
      start = Math.min(start, inter.startOffset);
      end = Math.max(end, inter.endOffset);
    } catch {}
  }
  if (!(start < end))
    return null;
  return { text: textNode.data.slice(start, end), start, end };
}
function sliceClientRects(textNode, start, end) {
  try {
    const r = document.createRange();
    r.setStart(textNode, start);
    r.setEnd(textNode, end);
    return r.getClientRects();
  } catch {
    return null;
  }
}
function pageIndexOf(node) {
  const el = selectionRootEl(node);
  const page = el?.closest(".pdf-page-wrap");
  if (!page)
    return 0;
  const idx = Number(page.dataset.pageIndex || 0);
  return Number.isFinite(idx) ? idx : 0;
}
function brBetween(a, b) {
  try {
    const range = document.createRange();
    range.setStart(a, a.length);
    range.setEnd(b, 0);
    const root = range.commonAncestorContainer;
    const scope = root.nodeType === Node.ELEMENT_NODE ? root : root.ownerDocument;
    const brs = scope.querySelectorAll("br");
    for (const br of brs) {
      const afterA = !!(a.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_FOLLOWING);
      const beforeB = !!(br.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (afterA && beforeB)
        return true;
    }
  } catch {}
  return false;
}
function endsWithSoftHyphen(s) {
  return /[\u00AD\u2010\u2011]$/.test(s);
}
function stripTrailingSoftHyphen(s) {
  return s.replace(/[\u00AD\u2010\u2011]$/, "");
}
function shouldDehyphenate(prev, next) {
  if (!endsWithSoftHyphen(prev))
    return false;
  if (!next)
    return false;
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(next);
}
function isSameVisualLine(prev, next) {
  const prevRect = prev.lastRect;
  const nextRect = next.firstRect;
  if (!prevRect || !nextRect)
    return true;
  const lineH = Math.max(1, prevRect.height, nextRect.height);
  const prevMidY = (prevRect.top + prevRect.bottom) / 2;
  const nextMidY = (nextRect.top + nextRect.bottom) / 2;
  return Math.abs(nextMidY - prevMidY) <= lineH * 0.5;
}
function separatorBetween(prev, next) {
  const hasBr = brBetween(prev.node, next.node);
  const prevPage = pageIndexOf(prev.node);
  const nextPage = pageIndexOf(next.node);
  const crossPage = prevPage !== nextPage;
  const sameLine = !hasBr && !crossPage && isSameVisualLine(prev, next);
  const lineBreak = hasBr || crossPage || !sameLine;
  if (lineBreak && shouldDehyphenate(prev.text, next.text)) {
    return { sep: "", rewritePrev: stripTrailingSoftHyphen(prev.text) };
  }
  if (lineBreak)
    return { sep: `
` };
  if (/\s$/.test(prev.text) || /^\s/.test(next.text))
    return { sep: "" };
  if (NO_SPACE_BEFORE_RE.test(next.text))
    return { sep: "" };
  if (NO_SPACE_AFTER_RE.test(prev.text))
    return { sep: "" };
  const prevRect = prev.lastRect;
  const nextRect = next.firstRect;
  if (!prevRect || !nextRect) {
    return { sep: "" };
  }
  const lineH = Math.max(1, prevRect.height, nextRect.height);
  const gap = nextRect.left - prevRect.right;
  if (gap <= lineH * 0.06)
    return { sep: "" };
  const spaceThreshold = Math.max(2, lineH * 0.26);
  if (gap > spaceThreshold)
    return { sep: " " };
  return { sep: "" };
}
function extractPdfSelectionByDomOrder(ranges) {
  if (!ranges.length)
    return "";
  let root = null;
  for (const r of ranges) {
    const el = selectionRootEl(r.commonAncestorContainer);
    const viewer = el?.closest(".pdf-viewer");
    if (viewer) {
      root = viewer;
      break;
    }
  }
  if (!root)
    root = ranges[0].commonAncestorContainer;
  const runs = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while (n = walker.nextNode()) {
    const tn = n;
    if (!isPdfGlyphTextNode(tn))
      continue;
    let intersects = false;
    for (const r of ranges) {
      try {
        if (r.intersectsNode(tn)) {
          intersects = true;
          break;
        }
      } catch {}
    }
    if (!intersects)
      continue;
    const detail = selectedSliceDetailed(tn, ranges);
    if (!detail || !detail.text)
      continue;
    const rects = sliceClientRects(tn, detail.start, detail.end);
    const firstRect = rects && rects.length ? rects[0] : null;
    const lastRect = rects && rects.length ? rects[rects.length - 1] : null;
    runs.push({
      node: tn,
      text: detail.text,
      firstRect,
      lastRect
    });
  }
  if (!runs.length)
    return "";
  const parts = [runs[0].text];
  for (let i = 1;i < runs.length; i++) {
    const { sep, rewritePrev } = separatorBetween(runs[i - 1], runs[i]);
    if (rewritePrev != null)
      parts[parts.length - 1] = rewritePrev;
    parts.push(sep);
    parts.push(runs[i].text);
  }
  return parts.join("");
}
function getSelectionPlainText(sel = window.getSelection()) {
  if (!sel || sel.isCollapsed || !sel.rangeCount)
    return "";
  const ranges = rangesOf(sel);
  const anchorEl = selectionRootEl(ranges[0].commonAncestorContainer);
  const pdfRoot = anchorEl?.closest(".pdf-viewer");
  if (!pdfRoot) {
    return cleanCopiedText(sel.toString());
  }
  const walked = extractPdfSelectionByDomOrder(ranges);
  if (!walked) {
    return cleanCopiedText(sel.toString());
  }
  return cleanCopiedText(walked);
}
async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
export {
  cleanCopiedText,
  getSelectionPlainText,
  isPdfTextSelection,
  writeClipboardText
};
