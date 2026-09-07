/**
 * Dedicated full-document print jobs (never the main app chrome window).
 *
 * PDF: build a chrome-free HTML print surface (pdf.js canvas → images) in a
 *      dedicated BrowserWindow, then webContents.print({ silent:false }) so the
 *      **system** print dialog opens in one click with a real page preview.
 *      Never load file://….pdf for the user path — that opens Chromium’s PDF
 *      plugin UI (toolbar print icon, no OS preview) and crops landscape
 *      MediaBoxes under default A4-portrait + margins.
 * MD/HTML: load chrome-free HTML and print the same way (direct system dialog).
 *
 * Windows: the system print dialog needs a visible, focused BrowserWindow.
 * Never use opacity 0 / showInactive — that leaves a ghost taskbar entry and
 * the print dialog never surfaces properly.
 *
 * Landscape invoices (MediaBox width > height, e.g. 596×397 pts): seed
 * landscape + marginType:none so the dialog does not clip; HTML uses
 * object-fit:contain inside a page surface sized for the MediaBox aspect.
 */
import { BrowserWindow, app, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { writeFile, unlink, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { PDFDocument } from 'pdf-lib'

export type PrintPayload =
  | { kind: 'pdf'; data: ArrayBuffer | Uint8Array }
  | { kind: 'md'; html: string; title?: string }
  /** Pre-built multi-page HTML (e.g. browser/pdf.js surfaces) */
  | { kind: 'html'; html: string; title?: string; pageCount?: number }

export type PdfPrintLayout = {
  pageCount: number
  pageWidthPt: number
  pageHeightPt: number
  /** True when the first page's effective width > height (rotation-aware). */
  landscape: boolean
}

/** Last job metadata for automated verification (tests / hooks). */
export let lastPrintJob: {
  kind: 'pdf' | 'md' | 'html'
  pageCount: number
  usedMainWindow: false
  tempPath: string
  landscape: boolean
  pageWidthPt: number
  pageHeightPt: number
  printOptions: Electron.WebContentsPrintOptions
  previewWindow: { width: number; height: number; shown: boolean }
  /** User path uses HTML surface — never Chromium PDF plugin. */
  method: 'html-surface'
} | null = null

const MAX_MD_HTML = 40 * 1024 * 1024
const PRINT_DIALOG_TIMEOUT_MS = 10 * 60 * 1000
const PDF_PRINT_SCALE = 2
const PDF_PRINT_PAGE_SOFT_CAP = 80

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function tempDir(): string {
  const name = `lampage-print-${Date.now()}-${randomBytes(6).toString('hex')}`
  return join(app.getPath('temp'), name)
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

function getPrintWorkArea(parent?: BrowserWindow): Electron.Rectangle {
  try {
    if (parent && !parent.isDestroyed()) {
      const bounds = parent.getBounds()
      const display = screen.getDisplayMatching(bounds)
      if (display?.workArea) return display.workArea
    }
  } catch {
    /* fall through to primary */
  }
  return screen.getPrimaryDisplay().workArea
}

/**
 * Resolve pdf.js build + CMap/font assets for the print harness BrowserWindow.
 * Packaged builds keep pdfjs-dist under app.getAppPath()/node_modules; cmaps may
 * also live under out/renderer/pdfjs from sync-pdfjs-assets.
 */
export function resolvePdfjsForPrint(): {
  pdfMjs: string
  workerMjs: string
  cmaps: string
  fonts: string
} {
  const appPath = app.getAppPath()
  const roots = [
    appPath,
    join(appPath, '..'),
    join(__dirname, '../..'),
    join(__dirname, '../../..'),
    process.cwd()
  ]
  const find = (rel: string): string | null => {
    for (const root of roots) {
      const p = join(root, rel)
      if (existsSync(p)) return p
    }
    return null
  }
  const pdfMjs =
    find('node_modules/pdfjs-dist/build/pdf.mjs') ||
    find('node_modules/pdfjs-dist/build/pdf.min.mjs')
  const workerMjs =
    find('node_modules/pdfjs-dist/build/pdf.worker.mjs') ||
    find('node_modules/pdfjs-dist/build/pdf.worker.min.mjs')
  const cmaps =
    find('node_modules/pdfjs-dist/cmaps') ||
    find('out/renderer/pdfjs/cmaps') ||
    find('src/renderer/public/pdfjs/cmaps')
  const fonts =
    find('node_modules/pdfjs-dist/standard_fonts') ||
    find('out/renderer/pdfjs/standard_fonts') ||
    find('src/renderer/public/pdfjs/standard_fonts')
  if (!pdfMjs || !workerMjs || !cmaps || !fonts) {
    throw new Error(
      `pdf.js assets missing for print (pdf=${!!pdfMjs} worker=${!!workerMjs} cmaps=${!!cmaps} fonts=${!!fonts})`
    )
  }
  return { pdfMjs, workerMjs, cmaps, fonts }
}

/**
 * Inspect PDF MediaBox / rotation so print defaults match page aspect.
 * Exported for verify scripts.
 */
export async function inspectPdfPrintLayout(
  data: ArrayBuffer | Uint8Array | Buffer
): Promise<PdfPrintLayout> {
  const buf = toBuffer(data)
  try {
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true })
    const pageCount = pdf.getPageCount()
    if (pageCount < 1) {
      return { pageCount: 0, pageWidthPt: 595, pageHeightPt: 842, landscape: false }
    }
    const page = pdf.getPage(0)
    const { width, height } = page.getSize()
    let angle = 0
    try {
      angle = page.getRotation().angle % 360
    } catch {
      angle = 0
    }
    if (angle < 0) angle += 360
    const swapped = angle === 90 || angle === 270
    const pageWidthPt = swapped ? height : width
    const pageHeightPt = swapped ? width : height
    return {
      pageCount,
      pageWidthPt,
      pageHeightPt,
      landscape: pageWidthPt > pageHeightPt
    }
  } catch {
    return { pageCount: 1, pageWidthPt: 595, pageHeightPt: 842, landscape: false }
  }
}

/** Build webContents.print options that avoid cropping landscape invoices. */
export function buildWebContentsPrintOptions(
  layout: Pick<PdfPrintLayout, 'landscape'>
): Electron.WebContentsPrintOptions {
  return {
    silent: false,
    printBackground: true,
    // A4/Letter portrait + default margins crops width>height MediaBoxes
    // (e.g. 596×397 Chinese e-invoices). Seed the system dialog in landscape
    // with zero margins so the full page fits; user can still change paper.
    landscape: layout.landscape,
    margins: { marginType: 'none' },
    pageSize: 'A4'
  }
}

function createPrintWindow(opts?: { landscape?: boolean }): BrowserWindow {
  const parent = findPrintParent()
  const workArea = getPrintWorkArea(parent)
  const margin = 48
  const landscape = !!opts?.landscape
  let width: number
  let height: number
  if (landscape) {
    width = Math.min(1100, Math.max(480, workArea.width - margin))
    height = Math.min(
      Math.max(360, Math.round(width * (397 / 596))),
      Math.max(360, workArea.height - margin)
    )
  } else {
    width = Math.min(900, Math.max(320, workArea.width - margin))
    height = Math.min(
      Math.min(900, Math.round(workArea.height * 0.8)),
      Math.max(320, workArea.height - margin)
    )
  }
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = Math.round(workArea.y + (workArea.height - height) / 2)
  return new BrowserWindow({
    show: false,
    width,
    height,
    x,
    y,
    title: '打印',
    ...(parent ? { parent } : {}),
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    webPreferences: {
      // Print harness imports pdf.js from node_modules via file:// URLs.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Required so the harness can load pdf.js / cmaps / the temp PDF.
      webSecurity: false,
      offscreen: false
    }
  })
}

function printWebContents(
  win: BrowserWindow,
  options: Electron.WebContentsPrintOptions
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(Boolean(ok))
    }
    const timer = setTimeout(() => finish(false), PRINT_DIALOG_TIMEOUT_MS)
    try {
      win.webContents.print(options, (success) => {
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

async function safeRmDir(path: string): Promise<void> {
  try {
    if (existsSync(path)) await rm(path, { recursive: true, force: true })
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

/**
 * Chrome-free PDF print harness: pdf.js rasterizes every page into
 * `.pdf-print-page` surfaces. @page / CSS follow MediaBox aspect (landscape
 * when width>height). Images use object-fit:contain so content is never clipped.
 */
export function buildPdfPrintHarnessHtml(opts: {
  pdfFileUrl: string
  pdfMjsUrl: string
  workerMjsUrl: string
  cmapsUrl: string
  fontsUrl: string
  title?: string
  scale?: number
  softCap?: number
}): string {
  const scale = opts.scale ?? PDF_PRINT_SCALE
  const softCap = opts.softCap ?? PDF_PRINT_PAGE_SOFT_CAP
  const title = escapeHtml(opts.title || 'document.pdf')
  // Ensure trailing slash for pdf.js asset directories
  const cmapsUrl = opts.cmapsUrl.endsWith('/') ? opts.cmapsUrl : `${opts.cmapsUrl}/`
  const fontsUrl = opts.fontsUrl.endsWith('/') ? opts.fontsUrl : `${opts.fontsUrl}/`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style id="lampage-print-css">
  html, body { margin: 0; padding: 0; background: #fff; }
  .pdf-print-root { margin: 0; padding: 0; }
  .pdf-print-page {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    background: #fff;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pdf-print-page:last-child {
    page-break-after: auto;
    break-after: auto;
  }
  .pdf-print-page img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    margin: 0 auto;
  }
  .lampage-print-error {
    font-family: system-ui, sans-serif;
    color: #b91c1c;
    padding: 24px;
  }
</style>
</head>
<body>
<div class="pdf-print-root" id="lampage-print-root"></div>
<script type="module">
import * as pdfjs from ${JSON.stringify(opts.pdfMjsUrl)};
pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(opts.workerMjsUrl)};

const SOFT_CAP = ${softCap};
const SCALE = ${scale};

function applyPageCss(pageWidthPt, pageHeightPt) {
  const css = document.getElementById('lampage-print-css');
  if (!css) return;
  css.textContent = \`
@page { size: \${pageWidthPt}pt \${pageHeightPt}pt; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.pdf-print-root { margin: 0; padding: 0; }
.pdf-print-page {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: \${pageWidthPt}pt;
  height: \${pageHeightPt}pt;
  margin: 0;
  padding: 0;
  background: #fff;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
  page-break-inside: avoid;
  break-inside: avoid;
}
.pdf-print-page:last-child {
  page-break-after: auto;
  break-after: auto;
}
.pdf-print-page img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  margin: 0;
  padding: 0;
}
\`;
}

try {
  const pdf = await pdfjs.getDocument({
    url: ${JSON.stringify(opts.pdfFileUrl)},
    cMapUrl: ${JSON.stringify(cmapsUrl)},
    cMapPacked: true,
    standardFontDataUrl: ${JSON.stringify(fontsUrl)}
  }).promise;

  const pageCount = pdf.numPages;
  if (pageCount < 1) throw new Error('PDF has no pages');

  const page1 = await pdf.getPage(1);
  const vp1 = page1.getViewport({ scale: 1 });
  const pageWidthPt = vp1.width;
  const pageHeightPt = vp1.height;
  const landscape = pageWidthPt > pageHeightPt;
  applyPageCss(pageWidthPt, pageHeightPt);

  const root = document.getElementById('lampage-print-root');
  root.dataset.pageCount = String(pageCount);
  const limit = Math.min(pageCount, SOFT_CAP);

  for (let i = 1; i <= limit; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({
      canvasContext: ctx,
      viewport,
      annotationMode: pdfjs.AnnotationMode.ENABLE
    }).promise;
    const wrap = document.createElement('div');
    wrap.className = 'pdf-print-page';
    wrap.dataset.pageIndex = String(i - 1);
    const img = document.createElement('img');
    img.alt = 'Page ' + i;
    img.src = canvas.toDataURL('image/jpeg', 0.92);
    wrap.appendChild(img);
    root.appendChild(wrap);
    // Free canvas memory promptly
    canvas.width = 0;
    canvas.height = 0;
  }

  window.__lampagePrintReady = {
    ok: true,
    pageCount,
    surfaces: root.querySelectorAll('.pdf-print-page').length,
    pageWidthPt,
    pageHeightPt,
    landscape,
    method: 'html-surface'
  };
} catch (err) {
  const msg = err && err.message ? err.message : String(err);
  const el = document.createElement('div');
  el.className = 'lampage-print-error';
  el.textContent = '打印准备失败: ' + msg;
  document.body.appendChild(el);
  window.__lampagePrintReady = { ok: false, error: msg, method: 'html-surface' };
}
</script>
</body>
</html>`
}

/** Show + focus the print window so the system print dialog can appear. */
function preparePrintWindowForDialog(win: BrowserWindow): void {
  try {
    if (typeof win.setOpacity === 'function') {
      win.setOpacity(1)
    }
    win.setTitle('打印')
    if (win.isMinimized()) {
      win.restore()
    }
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

/**
 * Wait until the HTML print surface has painted after show so the OS print
 * dialog preview pane is not empty.
 */
async function waitForPrintPreviewSurface(win: BrowserWindow): Promise<void> {
  const budgetMs = 800
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(done, budgetMs)
    try {
      win.webContents.once('paint', () => {
        clearTimeout(timer)
        setTimeout(done, 100)
      })
    } catch {
      /* paint may be unavailable */
    }
  })
  try {
    const img = await win.webContents.capturePage()
    const { width, height } = img.getSize()
    if (width < 32 || height < 32 || img.isEmpty()) {
      await new Promise((r) => setTimeout(r, 400))
    }
  } catch {
    /* capturePage can fail under some GPU/sandbox setups */
  }
}

type PrintReadyMeta = {
  ok: boolean
  pageCount?: number
  surfaces?: number
  pageWidthPt?: number
  pageHeightPt?: number
  landscape?: boolean
  method?: string
  error?: string
}

async function waitForPrintReady(
  win: BrowserWindow,
  timeoutMs = 120000
): Promise<PrintReadyMeta> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (win.isDestroyed()) throw new Error('Print window closed')
    try {
      const meta = (await win.webContents.executeJavaScript(
        'window.__lampagePrintReady || null'
      )) as PrintReadyMeta | null
      if (meta) return meta
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Timed out waiting for print surface')
}

async function printHtmlFile(
  filePath: string,
  meta: {
    kind: 'pdf' | 'md' | 'html'
    pageCount: number
    landscape: boolean
    pageWidthPt: number
    pageHeightPt: number
  },
  cleanupPaths: string[]
): Promise<boolean> {
  const printOptions = buildWebContentsPrintOptions({ landscape: meta.landscape })
  const win = createPrintWindow({ landscape: meta.landscape })
  const bounds = win.getBounds()
  lastPrintJob = {
    kind: meta.kind,
    pageCount: meta.pageCount,
    usedMainWindow: false,
    tempPath: filePath,
    landscape: meta.landscape,
    pageWidthPt: meta.pageWidthPt,
    pageHeightPt: meta.pageHeightPt,
    printOptions,
    previewWindow: { width: bounds.width, height: bounds.height, shown: false },
    method: 'html-surface'
  }
  try {
    await win.loadURL(pathToFileURL(filePath).href)
    // MD/static HTML: short settle. PDF harness sets __lampagePrintReady.
    if (meta.kind === 'pdf') {
      const ready = await waitForPrintReady(win)
      if (!ready.ok) {
        throw new Error(ready.error || 'Print surface failed')
      }
      if (typeof ready.pageCount === 'number' && lastPrintJob) {
        lastPrintJob.pageCount = ready.pageCount
      }
      if (typeof ready.pageWidthPt === 'number' && lastPrintJob) {
        lastPrintJob.pageWidthPt = ready.pageWidthPt
        lastPrintJob.pageHeightPt = ready.pageHeightPt ?? lastPrintJob.pageHeightPt
        lastPrintJob.landscape = !!ready.landscape
      }
    } else {
      await new Promise((r) => setTimeout(r, 250))
    }
    preparePrintWindowForDialog(win)
    if (lastPrintJob) {
      lastPrintJob.previewWindow.shown = true
      const b = win.getBounds()
      lastPrintJob.previewWindow.width = b.width
      lastPrintJob.previewWindow.height = b.height
    }
    await waitForPrintPreviewSurface(win)
    return await printWebContents(win, printOptions)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    for (const p of cleanupPaths) {
      if (p.endsWith('.html') || p.endsWith('.pdf') || !p.includes('lampage-print-')) {
        await safeUnlink(p)
      } else {
        await safeRmDir(p)
      }
    }
  }
}

/**
 * Print every page of a PDF via an HTML print surface (pdf.js), never the
 * Chromium PDF plugin viewer.
 */
export async function printPdfDocument(data: ArrayBuffer | Uint8Array): Promise<boolean> {
  const buf = toBuffer(data)
  const layout = await inspectPdfPrintLayout(buf)
  if (layout.pageCount < 1) throw new Error('PDF has no pages')

  const assets = resolvePdfjsForPrint()
  const dir = tempDir()
  await mkdir(dir, { recursive: true })
  const pdfPath = join(dir, 'document.pdf')
  const htmlPath = join(dir, 'print.html')
  await writeFile(pdfPath, buf)

  const harness = buildPdfPrintHarnessHtml({
    pdfFileUrl: pathToFileURL(pdfPath).href,
    pdfMjsUrl: pathToFileURL(assets.pdfMjs).href,
    workerMjsUrl: pathToFileURL(assets.workerMjs).href,
    cmapsUrl: pathToFileURL(assets.cmaps).href + '/',
    fontsUrl: pathToFileURL(assets.fonts).href + '/',
    title: 'document.pdf',
    scale: PDF_PRINT_SCALE,
    softCap: PDF_PRINT_PAGE_SOFT_CAP
  })
  await writeFile(htmlPath, harness, 'utf8')

  return printHtmlFile(
    htmlPath,
    {
      kind: 'pdf',
      pageCount: layout.pageCount,
      landscape: layout.landscape,
      pageWidthPt: layout.pageWidthPt,
      pageHeightPt: layout.pageHeightPt
    },
    [dir]
  )
}

/**
 * Print chrome-free HTML directly via the system print dialog.
 * (No HTML→PDF→PDF-plugin detour — that reintroduced Chromium PDF chrome.)
 */
export async function printMdDocument(html: string, title = 'document'): Promise<boolean> {
  if (typeof html !== 'string') throw new Error('Invalid MD html')
  if (html.length > MAX_MD_HTML) throw new Error('MD html too large')

  const filePath = tempPath('html')
  await writeFile(filePath, buildMdPrintHtml(html, title || 'document'), 'utf8')
  return printHtmlFile(
    filePath,
    {
      kind: 'md',
      pageCount: 1,
      landscape: false,
      pageWidthPt: 595.28,
      pageHeightPt: 841.89
    },
    [filePath]
  )
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

  // Detect landscape from embedded @page size or .pdf-print-page dimensions if present
  let landscape = false
  let pageWidthPt = 595.28
  let pageHeightPt = 841.89
  const sizeMatch = titled.match(/@page\s*\{[^}]*size:\s*([\d.]+)pt\s+([\d.]+)pt/i)
  if (sizeMatch) {
    pageWidthPt = parseFloat(sizeMatch[1])
    pageHeightPt = parseFloat(sizeMatch[2])
    landscape = pageWidthPt > pageHeightPt
  }

  return printHtmlFile(
    filePath,
    {
      kind: 'html',
      pageCount: opts?.pageCount ?? 1,
      landscape,
      pageWidthPt,
      pageHeightPt
    },
    [filePath]
  )
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

/**
 * Simulate placing a MediaBox onto A4 with the same defaults we seed into the
 * print dialog. Used by verify scripts (no printer required).
 */
export function mediaBoxFitsSeededPaper(
  pageWidthPt: number,
  pageHeightPt: number,
  opts: { landscape: boolean; marginPt?: number }
): { fits: boolean; paperWidthPt: number; paperHeightPt: number; scale: number } {
  const margin = opts.marginPt ?? 0
  // A4 in PDF points
  const a4Short = 595.28
  const a4Long = 841.89
  const paperWidthPt = (opts.landscape ? a4Long : a4Short) - 2 * margin
  const paperHeightPt = (opts.landscape ? a4Short : a4Long) - 2 * margin
  const scale = Math.min(paperWidthPt / pageWidthPt, paperHeightPt / pageHeightPt)
  const fits =
    pageWidthPt * Math.min(scale, 1) <= paperWidthPt + 0.5 &&
    pageHeightPt * Math.min(scale, 1) <= paperHeightPt + 0.5 &&
    // Actual-size (scale 1) must also fit when we seed landscape + no margins
    pageWidthPt <= paperWidthPt + 0.5 &&
    pageHeightPt <= paperHeightPt + 0.5
  return { fits, paperWidthPt, paperHeightPt, scale }
}

/**
 * Build printToPDF options mirroring the seeded system-dialog defaults.
 * Used by verify scripts (no real printer). Exported for tests.
 */
export function buildPrintToPdfVerifyOptions(
  layout: Pick<PdfPrintLayout, 'landscape' | 'pageWidthPt' | 'pageHeightPt'>
): Electron.PrintToPDFOptions {
  return {
    printBackground: true,
    landscape: layout.landscape,
    // Honor @page MediaBox size from the HTML surface (avoids A4 letterbox in verify).
    preferCSSPageSize: true,
    margins: { marginType: 'none' },
    // Fallback if preferCSSPageSize is ignored: A4 orientation matches landscape flag.
    pageSize: 'A4'
  }
}
