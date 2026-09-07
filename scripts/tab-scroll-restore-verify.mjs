/**
 * Verify tab-switch restores PDF browse scroll position.
 * Drives the Vite renderer on :5173 via puppeteer-core.
 */
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const require = createRequire(import.meta.url)

const BASE = process.env.LAMPAGE_URL || 'http://127.0.0.1:5173'
const TOLERANCE = 40 // px — layout settle / subpixel / center-pad jitter

function pass(name, detail = '') {
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

async function ensureMultiPagePdfs() {
  const outDir = join(root, 'samples')
  mkdirSync(outDir, { recursive: true })
  const aPath = join(outDir, 'scroll-restore-a.pdf')
  const bPath = join(outDir, 'scroll-restore-b.pdf')

  // Prefer existing multi-page samples when present + generate dedicated temps.
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')

  async function make(path, title, pages = 8) {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < pages; i++) {
      const page = doc.addPage([612, 792])
      page.drawText(`${title} — page ${i + 1}/${pages}`, {
        x: 72,
        y: 720,
        size: 18,
        font,
        color: rgb(0.1, 0.1, 0.1)
      })
      page.drawText('Lampage scroll-restore verify filler line '.repeat(3), {
        x: 72,
        y: 680,
        size: 12,
        font
      })
      // Tall content marker for visual debug
      page.drawRectangle({
        x: 72,
        y: 100 + i * 20,
        width: 400,
        height: 40,
        color: rgb(0.2 + i * 0.05, 0.4, 0.7)
      })
    }
    writeFileSync(path, Buffer.from(await doc.save()))
  }

  await make(aPath, 'DocA', 8)
  await make(bPath, 'DocB', 8)
  return { aPath, bPath }
}

function toBase64(buf) {
  return Buffer.from(buf).toString('base64')
}

function b64ToAbInPage() {
  // injected helper
}

const chromePaths = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean)

const { aPath, bPath } = await ensureMultiPagePdfs()
const pdfA = toBase64(readFileSync(aPath))
const pdfB = toBase64(readFileSync(bPath))

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
  console.error('Failed to launch Chrome', lastErr)
  process.exit(1)
}

const page = await browser.newPage()
page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'error' || t === 'warning') {
    console.log(`  [browser:${t}]`, msg.text())
  }
})
page.on('pageerror', (err) => console.error('  [pageerror]', err.message))

let ok = false
try {
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForSelector('.app-shell', { timeout: 30000 })

  // Open two PDFs via the zustand store (browser preview).
  await page.waitForFunction(() => window.__lampageStore != null, { timeout: 30000 })

  const openResult = await page.evaluate(async (pdfA, pdfB) => {
    function b64ToAb(b64) {
      const bin = atob(b64)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      return u8.buffer
    }
    const store = window.__lampageStore
    store.setState({ activeId: null, docs: [] })

    store.getState().addOpenedFiles([
      { path: '/tmp/scroll-restore-a.pdf', name: 'scroll-restore-a.pdf', data: b64ToAb(pdfA) },
      { path: '/tmp/scroll-restore-b.pdf', name: 'scroll-restore-b.pdf', data: b64ToAb(pdfB) }
    ])
    const docs = store.getState().docs
    if (docs.length < 2) return { error: 'expected 2 docs', n: docs.length }
    store.getState().setActive(docs[0].id)
    return { ids: docs.map((d) => d.id), names: docs.map((d) => d.name) }
  }, pdfA, pdfB)

  if (openResult.error) {
    fail('open-docs', JSON.stringify(openResult))
    throw new Error('open failed')
  }
  pass('open-docs', openResult.names.join(', '))

  // Wait for first PDF pages to render (fit-width first open)
  await page.waitForFunction(
    () => document.querySelectorAll('.pdf-page-wrap').length >= 1,
    { timeout: 60000 }
  )
  // Wait until sizer has meaningful height (progressive fill)
  await page.waitForFunction(
    () => {
      const v = document.querySelector('.pdf-viewer')
      return v && v.scrollHeight > v.clientHeight + 200
    },
    { timeout: 90000 }
  )
  // Give progressive remaining pages a moment
  await new Promise((r) => setTimeout(r, 1500))

  const before = await page.evaluate(async () => {
    const v = document.querySelector('.pdf-viewer')
    if (!v) return { error: 'no viewer' }
    const target = Math.min(Math.floor(v.scrollHeight * 0.45), v.scrollHeight - v.clientHeight - 10)
    v.scrollTop = Math.max(target, 400)
    v.dispatchEvent(new Event('scroll'))
    // Allow rAF persist
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const doc = window.__lampageStore.getState().activeDoc()
    return {
      scrollTop: v.scrollTop,
      scrollHeight: v.scrollHeight,
      clientHeight: v.clientHeight,
      storeScroll: doc?.scrollTop,
      id: doc?.id,
      zoom: doc?.zoom,
      zoomFit: doc?.zoomFit,
      pageCount: document.querySelectorAll('.pdf-page-wrap').length
    }
  })

  if (before.error) {
    fail('scroll-first', before.error)
    throw new Error(before.error)
  }
  if (!(before.scrollTop > 200)) {
    fail('scroll-first', `scrollTop=${before.scrollTop} (need >200); h=${before.scrollHeight}`)
    throw new Error('could not scroll first doc')
  }
  pass(
    'scroll-first',
    `scrollTop=${before.scrollTop} store=${before.storeScroll} pages=${before.pageCount} zoom=${before.zoom}`
  )

  const savedTarget = before.scrollTop

  // Switch to second doc
  await page.evaluate((secondId) => {
    window.__lampageStore.getState().setActive(secondId)
  }, openResult.ids[1])

  await page.waitForFunction(
    () => document.querySelectorAll('.pdf-page-wrap').length >= 1,
    { timeout: 60000 }
  )
  await new Promise((r) => setTimeout(r, 800))

  const mid = await page.evaluate((firstId) => {
    const st = window.__lampageStore.getState()
    const a = st.docs.find((d) => d.id === firstId)
    return {
      activeId: st.activeId,
      aScroll: a?.scrollTop,
      aZoom: a?.zoom,
      aName: a?.name
    }
  }, openResult.ids[0])
  if (mid.aScroll == null || Math.abs(mid.aScroll - savedTarget) > TOLERANCE) {
    // Soft check — store should have been flushed on setActive
    fail('flush-on-switch', `store scrollTop=${mid.aScroll} want~${savedTarget}`)
  } else {
    pass('flush-on-switch', `store scrollTop=${mid.aScroll}`)
  }

  // Switch back to first doc
  await page.evaluate((firstId) => {
    window.__lampageStore.getState().setActive(firstId)
  }, openResult.ids[0])

  await page.waitForFunction(
    () => document.querySelectorAll('.pdf-page-wrap').length >= 3,
    { timeout: 120000 }
  )
  // Wait for restore to settle (non-progressive full render + rAF)
  await page.waitForFunction(
    (want, tol) => {
      const v = document.querySelector('.pdf-viewer')
      if (!v) return false
      if (v.scrollHeight < want + v.clientHeight * 0.5) return false
      return Math.abs(v.scrollTop - want) <= tol
    },
    { timeout: 120000 },
    savedTarget,
    TOLERANCE
  )

  const after = await page.evaluate(() => {
    const v = document.querySelector('.pdf-viewer')
    const doc = window.__lampageStore.getState().activeDoc()
    return {
      scrollTop: v?.scrollTop,
      scrollHeight: v?.scrollHeight,
      storeScroll: doc?.scrollTop,
      zoom: doc?.zoom,
      zoomFit: doc?.zoomFit,
      pages: document.querySelectorAll('.pdf-page-wrap').length
    }
  })

  const delta = Math.abs((after.scrollTop ?? 0) - savedTarget)
  if (delta <= TOLERANCE && (after.scrollTop ?? 0) > 200) {
    pass(
      'restore-scroll',
      `scrollTop=${after.scrollTop} saved=${savedTarget} delta=${delta} pages=${after.pages} zoom=${after.zoom}`
    )
    ok = true
  } else {
    fail(
      'restore-scroll',
      `scrollTop=${after.scrollTop} saved=${savedTarget} delta=${delta} store=${after.storeScroll} pages=${after.pages}`
    )
  }
} catch (e) {
  fail('verify-exception', String(e && e.stack ? e.stack : e))
} finally {
  await browser.close()
}

process.exit(ok ? 0 : 1)
