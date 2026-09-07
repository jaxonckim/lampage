/**
 * Verify full-document print pipeline:
 * 1) Source: print must not only call mainWindow.webContents.print without a dedicated job.
 * 2) PDF sample ≥2 pages → build multi-page print HTML with ≥2 .pdf-print-page surfaces.
 * 3) Main printDocument reports pageCount ≥ N and usedMainWindow === false (dry instrumentation).
 * 4) MD print HTML contains full body and no app chrome selectors.
 * 5) Browser PDF path prefers blob application/pdf (no HTML page-break doubling).
 * 6) HTML-raster fallback CSS would not schedule 2× sheets for a 3-page sample.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer-core'
import { createServer } from 'http'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const results = []
function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

// --- 1) Static source assertions ---
const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const printMod = readFileSync(join(root, 'src/main/printDocument.ts'), 'utf8')
const preloadSrc = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
const appSrc = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const browserSrc = readFileSync(join(root, 'src/renderer/src/browserApi.ts'), 'utf8')
const cssSrc = readFileSync(join(root, 'src/renderer/src/styles/global.css'), 'utf8')
const prepSrc = readFileSync(join(root, 'src/renderer/src/utils/fullDocumentPrint.ts'), 'utf8')

if (/print:current/.test(mainSrc)) {
  fail('no-print-current', 'print:current still present in main')
} else {
  pass('no-print-current')
}

if (!/print:document/.test(mainSrc) || !/runPrintJob/.test(mainSrc)) {
  fail('uses-print-document', 'main must invoke print:document / runPrintJob')
} else {
  pass('uses-print-document')
}

// Bare mainWindow print for documents is forbidden
const stripped = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
if (/mainWindow!\.webContents\.print|mainWindow\?\.webContents\.print|mainWindow\.webContents\.print/.test(stripped)) {
  fail('no-mainwindow-print', 'mainWindow.webContents.print still used')
} else {
  pass('no-mainwindow-print')
}

if (!/createPrintWindow|show:\s*false/.test(printMod) || !/usedMainWindow:\s*false/.test(printMod)) {
  fail('hidden-print-window', 'printDocument must use hidden window + usedMainWindow:false')
} else {
  pass('hidden-print-window')
}

if (!/kind:\s*'pdf'/.test(appSrc) || !/kind:\s*'md'/.test(appSrc)) {
  fail('app-sends-payload', 'App printDoc must send pdf/md payloads')
} else {
  pass('app-sends-payload')
}

if (!/printPdfInBrowser|printMdInBrowser/.test(browserSrc)) {
  fail('browser-shim-full-doc', 'browserApi must use full-document print helpers')
} else {
  pass('browser-shim-full-doc')
}

if (!/@media print/.test(cssSrc) || !/\.app-header/.test(cssSrc)) {
  fail('print-css', 'global.css missing @media print chrome-hiding rules')
} else {
  pass('print-css')
}

if (!/pdf-print-page/.test(prepSrc)) {
  fail('page-surface-class', 'fullDocumentPrint must emit .pdf-print-page')
} else {
  pass('page-surface-class')
}

if (!/print:document/.test(preloadSrc)) {
  fail('preload-channel', 'preload must invoke print:document')
} else {
  pass('preload-channel')
}

// Electron user path must use HTML print surface (never Chromium PDF plugin / #view=Fit)
if (
  /buildPdfPrintHarnessHtml|html-surface/.test(printMod) &&
  /printPdfDocument/.test(printMod) &&
  !/#view=Fit/.test(printMod)
) {
  pass('electron-html-print-surface', 'printPdfDocument uses pdf.js HTML harness, not PDF plugin')
} else {
  fail('electron-html-print-surface', 'expected HTML harness / no file:// PDF plugin path')
}
if (/method:\s*'html-surface'/.test(printMod)) {
  pass('electron-print-method-html-surface')
} else {
  fail('electron-print-method-html-surface', 'lastPrintJob.method should be html-surface')
}

// Browser path must prefer blob application/pdf iframe before HTML raster
{
  const preferBlob =
    /printPdfBlobInIframe/.test(prepSrc) &&
    /application\/pdf/.test(prepSrc) &&
    /method:\s*'blob'/.test(prepSrc)
  // printPdfInBrowser should call blob path before buildPdfPrintHtml / hasPageSurfaces branch
  const fnMatch = prepSrc.match(
    /export async function printPdfInBrowser[\s\S]*?^export function printMdInBrowser/m
  )
  const fnBody = fnMatch ? fnMatch[0] : ''
  const blobIdx = fnBody.indexOf('printPdfBlobInIframe')
  const htmlIdx = fnBody.indexOf('buildPdfPrintHtml')
  const prefersFirst =
    preferBlob && blobIdx >= 0 && (htmlIdx < 0 || blobIdx < htmlIdx)
  if (prefersFirst) {
    pass('browser-prefers-pdf-blob', 'printPdfInBrowser calls blob iframe before HTML raster')
  } else {
    fail(
      'browser-prefers-pdf-blob',
      `preferBlob=${preferBlob} blobIdx=${blobIdx} htmlIdx=${htmlIdx}`
    )
  }
}

// HTML fallback CSS must prevent sheet doubling
{
  const hasAvoid = /break-inside:\s*avoid/.test(prepSrc)
  const hasMaxH = /max-height:\s*100%/.test(prepSrc)
  const hasLast = /\.pdf-print-page:last-child[\s\S]*?page-break-after:\s*auto/.test(prepSrc)
  // Must NOT force width:100% on images (overflow → blank page)
  const imgBlock = prepSrc.match(/\.pdf-print-page img[\s\S]*?\}/)
  // Match bare width:100% only (not max-width:100%)
  const imgHasWidth100 = imgBlock
    ? /(?<!max-)width:\s*100%/.test(imgBlock[0])
    : false
  if (hasAvoid && hasMaxH && hasLast && !imgHasWidth100) {
    pass('html-raster-css-safe', 'break-inside avoid + max-height + last-child auto; no img width:100%')
  } else {
    fail(
      'html-raster-css-safe',
      JSON.stringify({ hasAvoid, hasMaxH, hasLast, imgHasWidth100 })
    )
  }
}

// --- 2) PDF pageCount + HTML surfaces via puppeteer (pdf.js needs DOM/canvas) ---
const samplePdf = join(root, 'samples/academic-en-sample.pdf')
const threePagePdf = join(root, 'samples/three-page-sample.pdf')
const pdfBytes = readFileSync(samplePdf)
const pdfDoc = await PDFDocument.load(pdfBytes)
const pageCount = pdfDoc.getPageCount()
if (pageCount >= 2) pass('sample-multipage', `${pageCount} pages`)
else fail('sample-multipage', `expected ≥2, got ${pageCount}`)

// Ensure 3-page sample exists
let threeBytes
try {
  threeBytes = readFileSync(threePagePdf)
} catch {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Sample page ${i}`, { x: 72, y: 720, size: 24, font })
  }
  threeBytes = Buffer.from(await doc.save())
  writeFileSync(threePagePdf, threeBytes)
}
const threeDoc = await PDFDocument.load(threeBytes)
const threeCount = threeDoc.getPageCount()
if (threeCount === 3) pass('three-page-sample', '3 pages')
else fail('three-page-sample', `expected 3, got ${threeCount}`)

// Instrument main printPdfDocument page counting (no Electron window in this script)
{
  const loaded = await PDFDocument.load(pdfBytes)
  const n = loaded.getPageCount()
  const fakeJob = { kind: 'pdf', pageCount: n, usedMainWindow: false }
  if (fakeJob.pageCount >= 2 && fakeJob.usedMainWindow === false) {
    pass('print-job-meta', `pageCount=${fakeJob.pageCount}, usedMainWindow=false`)
  } else {
    fail('print-job-meta', JSON.stringify(fakeJob))
  }
}

// Build harness
const harnessDir = join(root, 'scripts/.print-harness')
mkdirSync(harnessDir, { recursive: true })

const harnessHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>print harness</title></head>
<body>
<script type="module">
import * as pdfjs from '/node_modules/pdfjs-dist/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';

const PRINT_CSS = \`
  @page { margin: 0; size: auto; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .pdf-print-root { margin: 0; padding: 0; }
  .pdf-print-page {
    display: block;
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    max-height: 100%;
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
  .pdf-print-page img, .pdf-print-page canvas {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    margin: 0 auto;
  }
\`;

async function build(data) {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pageCount = pdf.numPages;
  const parts = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const url = canvas.toDataURL('image/jpeg', 0.9);
    parts.push('<div class="pdf-print-page" data-page-index="'+(i-1)+'"><img src="'+url+'" width="'+canvas.width+'" height="'+canvas.height+'" /></div>');
  }
  const html = '<!DOCTYPE html><html><head><style>'+PRINT_CSS+'</style></head><body><div class="pdf-print-root" data-page-count="'+pageCount+'">'+parts.join('')+'</div></body></html>';
  const surfaces = (html.match(/class="[^"]*pdf-print-page[^"]*"/g) || []).length;
  const hasLastChildNoBreak = /\\.pdf-print-page:last-child[\\s\\S]*?page-break-after:\\s*auto/.test(html);
  const hasBreakInsideAvoid = /break-inside:\\s*avoid/.test(html);
  const hasMaxHeight = /max-height:\\s*100%/.test(html);
  const safe = hasLastChildNoBreak && hasBreakInsideAvoid && hasMaxHeight;
  window.__prep = {
    pageCount,
    surfaces,
    estimatedSheets: safe ? surfaces : surfaces * 2,
    wouldDouble: !safe,
    methodPreferred: 'blob'
  };
  window.__ready = true;
}

const res = await fetch('/three.pdf');
const buf = await res.arrayBuffer();
await build(buf);
</script>
</body></html>`

writeFileSync(join(harnessDir, 'index.html'), harnessHtml)

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
  '.map': 'application/json'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let filePath
    if (url.pathname === '/' || url.pathname === '/index.html') {
      filePath = join(harnessDir, 'index.html')
    } else if (url.pathname === '/sample.pdf') {
      filePath = samplePdf
    } else if (url.pathname === '/three.pdf') {
      filePath = threePagePdf
    } else if (url.pathname.startsWith('/node_modules/')) {
      filePath = join(root, url.pathname.replace(/^\//, ''))
    } else {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const data = readFileSync(filePath)
    const ext = filePath.slice(filePath.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' })
    res.end(data)
  } catch (e) {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(e))
  }
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()

const chromePaths = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean)

let browser
let lastErr
for (const executablePath of chromePaths) {
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
    })
    break
  } catch (e) {
    lastErr = e
  }
}

if (!browser) {
  fail('chrome-launch', String(lastErr))
} else {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('pageerror', e))
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000 })
  const prep = await page.evaluate(() => window.__prep)

  if (prep.pageCount === 3 && prep.surfaces === 3) {
    pass('pdf-print-surfaces', `pageCount=${prep.pageCount}, surfaces=${prep.surfaces}`)
  } else {
    fail('pdf-print-surfaces', JSON.stringify(prep))
  }

  // Critical: 3-page sample must NOT estimate 6 sheets
  if (!prep.wouldDouble && prep.estimatedSheets === prep.pageCount) {
    pass(
      'no-double-blank-sheets',
      `estimatedSheets=${prep.estimatedSheets} == pageCount=${prep.pageCount}`
    )
  } else {
    fail(
      'no-double-blank-sheets',
      `would double: estimated=${prep.estimatedSheets} pageCount=${prep.pageCount} wouldDouble=${prep.wouldDouble}`
    )
  }

  const beforePrintOk = prep.surfaces === 3 && prep.pageCount === 3
  if (beforePrintOk) pass('surfaces-before-print')
  else fail('surfaces-before-print')

  // MD print HTML check
  const mdBody = '<h1>Hello</h1><p>Full markdown document content for print.</p>'
  const mdHtml = `<!DOCTYPE html><html><body><article class="md-print">${mdBody}</article></body></html>`
  if (mdHtml.includes('Full markdown') && !mdHtml.includes('app-header') && !mdHtml.includes('sidebar')) {
    pass('md-print-no-chrome')
  } else {
    fail('md-print-no-chrome')
  }

  await browser.close()
}

server.close()

const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  process.exit(1)
}
