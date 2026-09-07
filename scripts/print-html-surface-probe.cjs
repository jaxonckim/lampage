/**
 * Electron probe: HTML print surface (pdf.js) → capture + printToPDF.
 * Invoked by print-landscape-verify.mjs. Writes html-surface-meta.json.
 */
const { app, BrowserWindow } = require('electron')
const { pathToFileURL } = require('url')
const { writeFileSync, mkdirSync, existsSync } = require('fs')
const { join } = require('path')

const outDir = process.env.LAMPAGE_PRINT_OUT || join(__dirname, '.print-landscape-out')
const root = process.env.LAMPAGE_ROOT || join(__dirname, '..')
const invoice = process.env.LAMPAGE_INVOICE_PDF || join(root, 'samples/landscape-invoice.pdf')
const portrait = process.env.LAMPAGE_PORTRAIT_PDF || join(root, 'samples/academic-en-sample.pdf')

mkdirSync(outDir, { recursive: true })
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
app.setPath('userData', join(outDir, '.electron-userdata-html-surface'))
// Keep process alive while we destroy intermediate BrowserWindows between jobs.
app.on('window-all-closed', () => {})

function resolvePdfjs() {
  const pdfMjs = join(root, 'node_modules/pdfjs-dist/build/pdf.mjs')
  const workerMjs = join(root, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')
  const cmaps = join(root, 'node_modules/pdfjs-dist/cmaps')
  const fonts = join(root, 'node_modules/pdfjs-dist/standard_fonts')
  for (const p of [pdfMjs, workerMjs, cmaps, fonts]) {
    if (!existsSync(p)) throw new Error('missing ' + p)
  }
  return { pdfMjs, workerMjs, cmaps, fonts }
}

function buildHarness(pdfPath, assets) {
  const pdfUrl = pathToFileURL(pdfPath).href
  const pdfMjsUrl = pathToFileURL(assets.pdfMjs).href
  const workerUrl = pathToFileURL(assets.workerMjs).href
  const cmapsUrl = pathToFileURL(assets.cmaps).href + '/'
  const fontsUrl = pathToFileURL(assets.fonts).href + '/'
  // Build with string concat to avoid nested template escaping issues.
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style id="css"></style></head><body>',
    '<div class="pdf-print-root" id="root"></div>',
    '<script type="module">',
    'import * as pdfjs from ' + JSON.stringify(pdfMjsUrl) + ';',
    'pdfjs.GlobalWorkerOptions.workerSrc = ' + JSON.stringify(workerUrl) + ';',
    'try {',
    '  const pdf = await pdfjs.getDocument({',
    '    url: ' + JSON.stringify(pdfUrl) + ',',
    '    cMapUrl: ' + JSON.stringify(cmapsUrl) + ',',
    '    cMapPacked: true,',
    '    standardFontDataUrl: ' + JSON.stringify(fontsUrl),
    '  }).promise;',
    '  const page1 = await pdf.getPage(1);',
    '  const vp1 = page1.getViewport({ scale: 1 });',
    '  const w = vp1.width, h = vp1.height;',
    '  const landscape = w > h;',
    "  document.getElementById('css').textContent = `",
    '@page { size: ${w}pt ${h}pt; margin: 0; }',
    'html, body { margin: 0; padding: 0; background: #fff; }',
    '.pdf-print-page {',
    '  display: flex; align-items: center; justify-content: center;',
    '  box-sizing: border-box; width: ${w}pt; height: ${h}pt;',
    '  margin: 0; padding: 0; overflow: hidden; background: #fff;',
    '  page-break-after: always; break-after: page;',
    '  page-break-inside: avoid; break-inside: avoid;',
    '}',
    '.pdf-print-page:last-child { page-break-after: auto; break-after: auto; }',
    '.pdf-print-page img {',
    '  display: block; width: 100%; height: 100%; object-fit: contain; margin: 0;',
    '}',
    '`;',
    "  const root = document.getElementById('root');",
    '  const limit = Math.min(pdf.numPages, 2);',
    '  for (let i = 1; i <= limit; i++) {',
    '    const page = await pdf.getPage(i);',
    '    const viewport = page.getViewport({ scale: 2 });',
    "    const canvas = document.createElement('canvas');",
    "    const ctx = canvas.getContext('2d');",
    '    canvas.width = Math.floor(viewport.width);',
    '    canvas.height = Math.floor(viewport.height);',
    '    await page.render({',
    '      canvasContext: ctx, viewport,',
    '      annotationMode: pdfjs.AnnotationMode.ENABLE',
    '    }).promise;',
    "    const wrap = document.createElement('div');",
    "    wrap.className = 'pdf-print-page';",
    '    wrap.dataset.pageIndex = String(i - 1);',
    "    const img = document.createElement('img');",
    "    img.src = canvas.toDataURL('image/jpeg', 0.92);",
    '    wrap.appendChild(img);',
    '    root.appendChild(wrap);',
    '  }',
    '  window.__lampagePrintReady = {',
    '    ok: true,',
    '    pageCount: pdf.numPages,',
    "    surfaces: root.querySelectorAll('.pdf-print-page').length,",
    '    pageWidthPt: w,',
    '    pageHeightPt: h,',
    '    landscape,',
    "    method: 'html-surface'",
    '  };',
    '} catch (e) {',
    '  window.__lampagePrintReady = { ok: false, error: String(e && e.message || e) };',
    '}',
    '</script></body></html>'
  ].join('\n')
}

async function runOne(pdfPath, tag, landscape) {
  const assets = resolvePdfjs()
  const dir = join(outDir, 'harness-' + tag)
  mkdirSync(dir, { recursive: true })
  const htmlPath = join(dir, 'print.html')
  writeFileSync(htmlPath, buildHarness(pdfPath, assets))
  const win = new BrowserWindow({
    show: false,
    width: landscape ? 1000 : 700,
    height: landscape ? 680 : 900,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      webSecurity: false
    }
  })
  try {
    await win.loadURL(pathToFileURL(htmlPath).href)
    let meta = null
    for (let i = 0; i < 120; i++) {
      meta = await win.webContents.executeJavaScript('window.__lampagePrintReady || null')
      if (meta) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!meta || !meta.ok) throw new Error('ready failed: ' + JSON.stringify(meta))
    win.show()
    win.focus()
    await new Promise((r) => setTimeout(r, 300))
    const img = await win.webContents.capturePage()
    const size = img.getSize()
    const png = img.toPNG()
    const empty = img.isEmpty()
    const capturePath = join(outDir, tag + '-capture.png')
    writeFileSync(capturePath, png)
    const pdfBuf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: !!meta.landscape,
      pageSize: 'A4',
      margins: { marginType: 'none' },
      preferCSSPageSize: true
    })
    const outPdf = join(outDir, tag + '-print.pdf')
    writeFileSync(outPdf, Buffer.from(pdfBuf))
    return {
      meta,
      capture: {
        out: capturePath,
        width: size.width,
        height: size.height,
        bytes: png.length,
        empty
      },
      outPdf,
      pdfBytes: pdfBuf.byteLength
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await new Promise((r) => setTimeout(r, 200))
  }
}

app
  .whenReady()
  .then(async () => {
    const meta = { invoice: null, portrait: null, errors: [] }
    const metaFile = join(outDir, 'html-surface-meta.json')
    try {
      meta.invoice = await runOne(invoice, 'invoice-html', true)
    } catch (e) {
      meta.errors.push('invoice:' + String(e && e.message ? e.message : e))
    }
    writeFileSync(metaFile, JSON.stringify(meta, null, 2))
    try {
      meta.portrait = await runOne(portrait, 'portrait-html', false)
    } catch (e) {
      meta.errors.push('portrait:' + String(e && e.message ? e.message : e))
    }
    writeFileSync(metaFile, JSON.stringify(meta, null, 2))
    console.log('HTML_SURFACE_META', JSON.stringify(meta))
    app.quit()
  })
  .catch((e) => {
    console.error(e)
    app.exit(1)
  })
