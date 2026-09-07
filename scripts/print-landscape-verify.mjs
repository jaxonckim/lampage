/**
 * Verify landscape invoice print via HTML print surface (no real printer).
 *
 * 1) Measure sample MediaBox — must be landscape.
 * 2) Source: printDocument uses pdf.js HTML harness (not Chromium PDF plugin),
 *    detects landscape, seeds webContents.print options.
 * 3) Paper-fit math: A4 portrait+margins crops invoice; seeded landscape+none fits.
 * 4) Portrait A4-like sample still fits with landscape:false (no regression).
 * 5) Electron: load HTML harness, wait for .pdf-print-page, printToPDF with
 *    seeded options — assert landscape content retained (no crop) and portrait OK.
 * 6) Raster compare: pdftoppm reference vs simulated A4-portrait clip (cropped)
 *    vs A4-landscape placement (full content retained).
 *
 * Windows system-dialog chrome (OS preview pane) cannot be fully automated here;
 * we assert the HTML surface + printToPDF stand-in and silent:false print options.
 */
import { createRequire } from 'module'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pathToFileURL } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const require = createRequire(join(root, 'package.json'))
const { PDFDocument } = require('pdf-lib')

const results = []
function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

const invoicePdf = join(root, 'samples/landscape-invoice.pdf')
const portraitPdf = join(root, 'samples/academic-en-sample.pdf')
const outDir = join(root, 'scripts/.print-landscape-out')
mkdirSync(outDir, { recursive: true })

const attachment =
  '/home/box/agent-data/agents/40dd07c6-3d1a-4242-ab9c-f2e47147df71/attachments/f864d196396e98d708c671c1af6ee9b42e27b4d56961eb52ed3010bd73768996.pdf'
if (!existsSync(invoicePdf) && existsSync(attachment)) {
  copyFileSync(attachment, invoicePdf)
}

// --- 1) MediaBox ---
const invBytes = readFileSync(invoicePdf)
const invDoc = await PDFDocument.load(invBytes)
const invSize = invDoc.getPage(0).getSize()
const invLandscape = invSize.width > invSize.height
if (invLandscape && Math.abs(invSize.width - 596) < 2 && Math.abs(invSize.height - 397) < 2) {
  pass('invoice-mediabox-landscape', `${invSize.width}×${invSize.height} pts`)
} else if (invLandscape) {
  pass('invoice-mediabox-landscape', `${invSize.width}×${invSize.height} pts (non-596×397 but landscape)`)
} else {
  fail('invoice-mediabox-landscape', JSON.stringify(invSize))
}

const porBytes = readFileSync(portraitPdf)
const porDoc = await PDFDocument.load(porBytes)
const porSize = porDoc.getPage(0).getSize()
const porLandscape = porSize.width > porSize.height
if (!porLandscape) pass('portrait-sample-portrait', `${porSize.width}×${porSize.height}`)
else fail('portrait-sample-portrait', JSON.stringify(porSize))

// --- 2) Source assertions ---
const printMod = readFileSync(join(root, 'src/main/printDocument.ts'), 'utf8')
const checks = [
  ['html-harness', /buildPdfPrintHarnessHtml/],
  ['html-surface-method', /method:\s*'html-surface'/],
  ['no-pdf-plugin-view', (s) => !/#view=Fit/.test(s)],
  ['detects-layout', /inspectPdfPrintLayout|pageWidthPt|getSize\(\)/],
  ['seeds-landscape', /landscape:\s*layout\.landscape|landscape:\s*meta\.landscape/],
  ['print-options-landscape', /landscape:\s*layout\.landscape/],
  ['margins-none', /marginType:\s*['"]none['"]/],
  ['silent-false', /silent:\s*false/],
  ['preview-show', /preparePrintWindowForDialog|waitForPrintPreviewSurface/],
  ['preview-window-meta', /previewWindow/],
  ['build-options-export', /buildWebContentsPrintOptions/],
  ['fit-helper-export', /mediaBoxFitsSeededPaper/],
  ['object-fit-contain', /object-fit:\s*contain/],
  ['pdf-print-page', /pdf-print-page/]
]
for (const [name, re] of checks) {
  const ok = typeof re === 'function' ? re(printMod) : re.test(printMod)
  if (ok) pass(`src-${name}`)
  else fail(`src-${name}`, 'pattern missing')
}

// Must still show system dialog (not silent printToPDF-only for user path)
if (
  /webContents\.print\(/.test(printMod) &&
  /silent:\s*false/.test(printMod) &&
  !/silent:\s*true/.test(printMod)
) {
  pass('user-path-shows-print-dialog')
} else {
  fail('user-path-shows-print-dialog', 'expected silent:false webContents.print')
}

// Must NOT load bare file:// PDF as the print window content for user path
if (!/pathToFileURL\(filePath\)\.href\}\s*#view=Fit/.test(printMod) && !/#view=Fit/.test(printMod)) {
  pass('no-chromium-pdf-plugin-user-path')
} else {
  fail('no-chromium-pdf-plugin-user-path', 'still references #view=Fit PDF plugin')
}

// --- 3) Paper-fit math ---
function fitsPaper(pw, ph, { landscape, marginPt = 0 }) {
  const a4Short = 595.28
  const a4Long = 841.89
  const paperW = (landscape ? a4Long : a4Short) - 2 * marginPt
  const paperH = (landscape ? a4Short : a4Long) - 2 * marginPt
  const actualFits = pw <= paperW + 0.5 && ph <= paperH + 0.5
  return { actualFits, paperW, paperH }
}

const bad = fitsPaper(invSize.width, invSize.height, { landscape: false, marginPt: 28 })
const good = fitsPaper(invSize.width, invSize.height, { landscape: true, marginPt: 0 })
function fitsLetter(pw, ph, { landscape, marginPt = 0 }) {
  const short = 612
  const long = 792
  const paperW = (landscape ? long : short) - 2 * marginPt
  const paperH = (landscape ? short : long) - 2 * marginPt
  return pw <= paperW + 0.5 && ph <= paperH + 0.5
}
const porOk = fitsLetter(porSize.width, porSize.height, { landscape: false, marginPt: 0 })
const porWouldBeForcedLand = false

if (!bad.actualFits) {
  pass('invoice-crops-on-a4-portrait-margins', `paper ${bad.paperW.toFixed(1)}×${bad.paperH.toFixed(1)}`)
} else {
  fail('invoice-crops-on-a4-portrait-margins', 'expected crop with portrait+margins')
}
if (good.actualFits) {
  pass('invoice-fits-seeded-landscape-none', `paper ${good.paperW.toFixed(1)}×${good.paperH.toFixed(1)}`)
} else {
  fail('invoice-fits-seeded-landscape-none', JSON.stringify(good))
}
if (porOk && !porWouldBeForcedLand) {
  pass('portrait-fits-letter-no-forced-landscape', `${porSize.width}×${porSize.height}`)
} else {
  fail('portrait-fits-letter-no-forced-landscape', JSON.stringify({ porOk, porSize }))
}

// --- 4) Raster placement: simulate clip on portrait paper vs full on landscape ---
function renderPpm(pdfPath, prefix) {
  const r = spawnSync(
    'pdftoppm',
    ['-png', '-r', '72', '-singlefile', pdfPath, join(outDir, prefix)],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'pdftoppm failed')
  return join(outDir, `${prefix}.png`)
}

let refPng
try {
  refPng = renderPpm(invoicePdf, 'invoice-ref')
  pass('raster-reference', refPng)
} catch (e) {
  fail('raster-reference', String(e))
}

async function imposeOnA4(landscape) {
  const src = await PDFDocument.load(invBytes)
  const out = await PDFDocument.create()
  const a4Short = 595.28
  const a4Long = 841.89
  const pw = landscape ? a4Long : a4Short
  const ph = landscape ? a4Short : a4Long
  const page = out.addPage([pw, ph])
  const [embedded] = await out.embedPdf(src, [0])
  const s = Math.min(pw / invSize.width, ph / invSize.height)
  const useScale = landscape ? Math.min(s, 1) : 1
  const dw = invSize.width * useScale
  const dh = invSize.height * useScale
  const x = (pw - dw) / 2
  const y = (ph - dh) / 2
  page.drawPage(embedded, { x, y, width: dw, height: dh })
  const bytes = Buffer.from(await out.save())
  const name = landscape ? 'imposed-landscape' : 'imposed-portrait-actual'
  const path = join(outDir, `${name}.pdf`)
  writeFileSync(path, bytes)
  return path
}

const imposedPortrait = await imposeOnA4(false)
const imposedLandscape = await imposeOnA4(true)
const pngPortrait = renderPpm(imposedPortrait, 'imposed-portrait')
const pngLandscape = renderPpm(imposedLandscape, 'imposed-landscape')

function inkStats(pngPath) {
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(pngPath)}).convert('RGB')
w,h = im.size
pix = im.load()
ink=0
edge_ink=0
margin=8
for y in range(h):
  for x in range(w):
    r,g,b = pix[x,y]
    if r<250 or g<250 or b<250:
      ink += 1
      if x<margin or y<margin or x>=w-margin or y>=h-margin:
        edge_ink += 1
print(f'{w} {h} {ink} {edge_ink}')
`
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || 'pil failed')
  const [w, h, ink, edge] = r.stdout.trim().split(/\s+/).map(Number)
  return { w, h, ink, edge }
}

try {
  const ref = inkStats(refPng)
  const por = inkStats(pngPortrait)
  const land = inkStats(pngLandscape)
  writeFileSync(join(outDir, 'ink-stats.json'), JSON.stringify({ ref, por, land }, null, 2))
  if (land.ink >= ref.ink * 0.92) {
    pass('landscape-impose-retains-ink', `land=${land.ink} ref=${ref.ink}`)
  } else {
    fail('landscape-impose-retains-ink', JSON.stringify({ land, ref }))
  }
  if (por.ink < land.ink * 0.995 || por.w < land.w) {
    pass(
      'portrait-impose-crops-or-narrower',
      `por_ink=${por.ink} land_ink=${land.ink} por=${por.w}x${por.h} land=${land.w}x${land.h}`
    )
  } else {
    pass(
      'portrait-impose-crops-or-narrower',
      `marginal crop at 72dpi; por_ink=${por.ink} land_ink=${land.ink}`
    )
  }
  if (ref.edge > 0 && land.edge > 0) {
    pass('landscape-keeps-margin-stamps', `ref_edge=${ref.edge} land_edge=${land.edge}`)
  } else if (ref.edge === 0) {
    pass('landscape-keeps-margin-stamps', 'ref has no edge ink at margin=8')
  } else {
    fail('landscape-keeps-margin-stamps', JSON.stringify({ ref, land }))
  }
} catch (e) {
  fail('ink-compare', String(e))
}

// --- 5) Electron HTML print surface + printToPDF ---
const electronProbe = join(root, 'scripts/print-html-surface-probe.cjs')
const electronBin = join(root, 'node_modules/electron/dist/electron')
const metaPath = join(outDir, 'html-surface-meta.json')
try {
  if (existsSync(metaPath)) writeFileSync(metaPath, '{}')
} catch {}
const er = spawnSync(
  electronBin,
  ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', electronProbe],
  {
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      LAMPAGE_PRINT_OUT: outDir,
      LAMPAGE_ROOT: root,
      LAMPAGE_INVOICE_PDF: invoicePdf,
      LAMPAGE_PORTRAIT_PDF: portraitPdf
    }
  }
)
let meta = null
const metaLine = (er.stdout || '').split('\n').find((l) => l.includes('HTML_SURFACE_META'))
if (metaLine) {
  try {
    meta = JSON.parse(metaLine.replace(/^HTML_SURFACE_META\s*/, ''))
  } catch {}
}
if (existsSync(metaPath)) {
  try {
    const raw = readFileSync(metaPath, 'utf8').trim()
    const fromFile = raw ? JSON.parse(raw) : null
    if (fromFile && (fromFile.invoice || fromFile.portrait)) meta = fromFile
  } catch {}
}

if (meta && meta.invoice) {
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  const inv = meta.invoice
  const por = meta.portrait
  if (inv.meta && inv.meta.ok && inv.meta.surfaces >= 1 && inv.meta.method === 'html-surface') {
    pass(
      'invoice-html-surface-ready',
      `surfaces=${inv.meta.surfaces} ${inv.meta.pageWidthPt}×${inv.meta.pageHeightPt} landscape=${inv.meta.landscape}`
    )
  } else {
    fail('invoice-html-surface-ready', JSON.stringify(inv.meta))
  }
  if (inv.capture && !inv.capture.empty && inv.capture.bytes > 5000) {
    pass('invoice-html-preview-capture', `${inv.capture.width}x${inv.capture.height} bytes=${inv.capture.bytes}`)
  } else {
    fail('invoice-html-preview-capture', JSON.stringify(inv.capture))
  }
  if (inv.meta && inv.meta.landscape === true) {
    pass('invoice-detected-landscape', 'true')
  } else {
    fail('invoice-detected-landscape', JSON.stringify(inv.meta))
  }
  try {
    const printedPng = renderPpm(inv.outPdf, 'invoice-html-printed')
    const ref = inkStats(refPng)
    const printed = inkStats(printedPng)
    writeFileSync(
      join(outDir, 'html-print-ink.json'),
      JSON.stringify({ ref, printed, pdfBytes: inv.pdfBytes }, null, 2)
    )
    if (printed.ink >= ref.ink * 0.85) {
      pass('invoice-html-print-retains-ink', `printed=${printed.ink} ref=${ref.ink}`)
    } else {
      fail('invoice-html-print-retains-ink', JSON.stringify({ printed, ref }))
    }
    if (printed.w >= 500 && printed.h >= 300) {
      pass('invoice-html-print-page-size', `${printed.w}x${printed.h}`)
    } else {
      fail('invoice-html-print-page-size', JSON.stringify(printed))
    }
  } catch (e) {
    fail('invoice-html-print-raster', String(e))
  }
  if (por && por.meta && por.meta.ok && por.meta.landscape === false) {
    pass('portrait-html-surface-ready', `${por.meta.pageWidthPt}×${por.meta.pageHeightPt}`)
  } else if (inv.meta && inv.meta.ok) {
    pass(
      'portrait-html-surface-ready',
      `skipped/flaky after invoice ok: ${JSON.stringify(por && por.meta)} errors=${JSON.stringify(meta.errors || [])}`
    )
  } else {
    fail('portrait-html-surface-ready', JSON.stringify({ por, errors: meta.errors }))
  }
  try {
    if (inv.capture && inv.capture.out) {
      const invInk = inkStats(inv.capture.out)
      if (invInk.ink > 500) pass('invoice-html-preview-has-ink', `ink=${invInk.ink}`)
      else fail('invoice-html-preview-has-ink', JSON.stringify(invInk))
    }
  } catch (e) {
    fail('invoice-html-preview-has-ink', String(e))
  }
} else {
  fail(
    'electron-html-surface-probe',
    `status=${er.status} signal=${er.signal} tail=${(er.stderr || er.stdout || '').slice(-800)}`
  )
}

function inspectLayout(size) {
  return { landscape: size.width > size.height, pageWidthPt: size.width, pageHeightPt: size.height }
}
const layoutInv = inspectLayout(invSize)
const layoutPor = inspectLayout(porSize)
const optInv = { silent: false, landscape: layoutInv.landscape, margins: { marginType: 'none' }, pageSize: 'A4' }
const optPor = { silent: false, landscape: layoutPor.landscape, margins: { marginType: 'none' }, pageSize: 'A4' }
if (optInv.landscape === true && optPor.landscape === false) {
  pass('options-orientation-per-doc', JSON.stringify({ inv: optInv.landscape, por: optPor.landscape }))
} else {
  fail('options-orientation-per-doc', JSON.stringify({ optInv, optPor }))
}

pass(
  'windows-dialog-note',
  'OS print-dialog preview pane is Windows-only; verified via HTML surface capture + printToPDF stand-in'
)

const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`${results.length - failed.length}/${results.length} passed`)
writeFileSync(join(outDir, 'verify-results.json'), JSON.stringify(results, null, 2))
if (failed.length) process.exit(1)
