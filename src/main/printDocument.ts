/**
 * Dedicated full-document print jobs (never the main app chrome window).
 *
 * PDF: write bytes to a temp file, open a BrowserWindow on file://PDF,
 *      then webContents.print() — Chromium prints every page of the PDF.
 * MD:  write a chrome-free HTML document to temp, print that window.
 *
 * Windows: the system print dialog needs a visible, focused BrowserWindow.
 * Never use opacity 0 / showInactive — that leaves a ghost taskbar entry and
 * the print dialog never surfaces properly.
 */
import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { writeFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { PDFDocument } from 'pdf-lib'

export type PrintPayload =
  | { kind: 'pdf'; data: ArrayBuffer | Uint8Array }
  | { kind: 'md'; html: string; title?: string }
  /** Pre-built multi-page HTML (e.g. browser/pdf.js surfaces) */
  | { kind: 'html'; html: string; title?: string; pageCount?: number }

/** Last job metadata for automated verification (tests / hooks). */
export let lastPrintJob: {
  kind: 'pdf' | 'md' | 'html'
  pageCount: number
  usedMainWindow: false
  tempPath: string
} | null = null

const MAX_MD_HTML = 40 * 1024 * 1024
const PRINT_DIALOG_TIMEOUT_MS = 10 * 60 * 1000

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function tempPath(ext: string): string {
  const name = `lampage-print-${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
  return join(app.getPath('temp'), name)
}

function findPrintParent(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
}

function createPrintWindow(): BrowserWindow {
  const parent = findPrintParent()
  return new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    title: '打印',
    // Parent helps Windows own the system print dialog without modal=true
    // (modal would block the parent and can interfere with multi-page PDF print).
    ...(parent ? { parent } : {}),
    // Paint while initially hidden so PDF/HTML layout can settle before show.
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
}

function printWebContents(win: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(Boolean(ok))
    }
    const timer = setTimeout(() => finish(false), PRINT_DIALOG_TIMEOUT_MS)
    // silent:false shows the system print dialog (user may cancel → false)
    try {
      win.webContents.print({ silent: false, printBackground: true }, (success) => {
        clearTimeout(timer)
        finish(Boolean(success))
      })
    } catch {
      clearTimeout(timer)
      finish(false)
    }
  })
}

async function safeUnlink(path: string): Promise<void> {
  try {
    if (existsSync(path)) await unlink(path)
  } catch {
    /* ignore */
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildMdPrintHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 12mm; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #1c2430;
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  }
  article.md-print {
    max-width: 800px;
    margin: 0 auto;
    padding: 8px 12px 24px;
    line-height: 1.75;
    font-size: 16px;
  }
  article.md-print h1 { font-size: 2rem; margin: 1.2em 0 0.5em; font-weight: 700; }
  article.md-print h2 { font-size: 1.55rem; margin: 1.1em 0 0.45em; font-weight: 700; }
  article.md-print h3 { font-size: 1.25rem; margin: 1em 0 0.4em; font-weight: 650; }
  article.md-print h4, article.md-print h5, article.md-print h6 {
    font-size: 1.05rem; margin: 0.9em 0 0.35em; font-weight: 600;
  }
  article.md-print p { margin: 0.65em 0; }
  article.md-print a { color: #143d2e; }
  article.md-print blockquote {
    border-left: 3px solid #c5d6cb;
    margin: 0.8em 0;
    padding: 0.2em 0 0.2em 1em;
    color: #475569;
  }
  article.md-print code {
    font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
    background: #f1f5f1;
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  article.md-print pre {
    background: #14241c;
    color: #e2e8f0;
    border-radius: 10px;
    padding: 14px 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  article.md-print pre code { background: transparent; color: inherit; padding: 0; }
  .code-copy-btn, .hl-mark { display: none !important; }
</style>
</head>
<body>
<article class="md-print">${bodyHtml}</article>
</body>
</html>`
}

/** Show + focus the print window so the system print dialog can appear. */
function preparePrintWindowForDialog(win: BrowserWindow): void {
  try {
    // Visible + focused at normal opacity. Opacity 0 / showInactive leaves a
    // ghost taskbar entry on Windows and the print dialog never surfaces.
    if (typeof win.setOpacity === 'function') {
      win.setOpacity(1)
    }
    win.setTitle('打印')
    win.show()
    win.focus()
    if (typeof win.moveTop === 'function') {
      win.moveTop()
    }
  } catch {
    try {
      win.show()
      win.focus()
    } catch {
      /* ignore */
    }
  }
}

async function printTempFile(
  filePath: string,
  meta: { kind: 'pdf' | 'md' | 'html'; pageCount: number }
): Promise<boolean> {
  const win = createPrintWindow()
  lastPrintJob = {
    kind: meta.kind,
    pageCount: meta.pageCount,
    usedMainWindow: false,
    tempPath: filePath
  }
  try {
    // loadURL resolves after did-finish-load
    await win.loadURL(pathToFileURL(filePath).href)
    // PDF viewer / layout settle (paintWhenInitiallyHidden paints before show)
    await new Promise((r) => setTimeout(r, meta.kind === 'pdf' ? 600 : 300))
    preparePrintWindowForDialog(win)
    // Brief settle after show/focus so the compositor owns a real HWND
    await new Promise((r) => setTimeout(r, 80))
    return await printWebContents(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await safeUnlink(filePath)
  }
}

/**
 * Print every page of a PDF via Chromium's native PDF viewer in a hidden window.
 */
export async function printPdfDocument(data: ArrayBuffer | Uint8Array): Promise<boolean> {
  const buf = toBuffer(data)
  let pageCount = 1
  try {
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true })
    pageCount = pdf.getPageCount()
  } catch {
    pageCount = 1
  }
  if (pageCount < 1) throw new Error('PDF has no pages')

  const filePath = tempPath('pdf')
  await writeFile(filePath, buf)
  return printTempFile(filePath, { kind: 'pdf', pageCount })
}

export async function printMdDocument(html: string, title = 'document'): Promise<boolean> {
  if (typeof html !== 'string') throw new Error('Invalid MD html')
  if (html.length > MAX_MD_HTML) throw new Error('MD html too large')

  const filePath = tempPath('html')
  await writeFile(filePath, buildMdPrintHtml(html, title || 'document'), 'utf8')
  return printTempFile(filePath, { kind: 'md', pageCount: 1 })
}

export async function printHtmlDocument(
  html: string,
  opts?: { title?: string; pageCount?: number }
): Promise<boolean> {
  if (typeof html !== 'string') throw new Error('Invalid html')
  if (html.length > MAX_MD_HTML) throw new Error('html too large')

  const filePath = tempPath('html')
  const titled =
    html.includes('<html') || html.includes('<HTML')
      ? html
      : buildMdPrintHtml(html, opts?.title || 'document')
  await writeFile(filePath, titled, 'utf8')
  const pageCount =
    opts?.pageCount ??
    (titled.match(/class="[^"]*pdf-print-page[^"]*"/g)?.length ||
      titled.match(/class='[^']*pdf-print-page[^']*'/g)?.length ||
      1)
  return printTempFile(filePath, { kind: 'html', pageCount })
}

export async function runPrintJob(payload: PrintPayload): Promise<boolean> {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid print payload')
  if (payload.kind === 'pdf') return printPdfDocument(payload.data)
  if (payload.kind === 'md') return printMdDocument(payload.html, payload.title)
  if (payload.kind === 'html') {
    return printHtmlDocument(payload.html, {
      title: payload.title,
      pageCount: payload.pageCount
    })
  }
  throw new Error('Invalid print kind')
}
