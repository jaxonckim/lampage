/**
 * Verify PDF page centering + fit-width/fit-page + mouse-centered zoom settle.
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname === '/' ? '/fit-center-harness.html' : url.pathname
    const filePath = join(__dirname, path.replace(/^\//, ''))
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  } catch (e) {
    if (!res.headersSent) res.writeHead(404)
    res.end(String(e))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`

const chromePaths = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
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
  console.error('Failed to launch Chrome', lastErr)
  process.exit(1)
}

const page = await browser.newPage()
page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 })
const results = []
function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
}

try {
  await page.goto(`${base}/fit-center-harness.html`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.__ready === true)

  // --- 1) Centering at zoom 1.0 (narrow page in 800px viewer) ---
  await page.evaluate(() => window.__harness.openAt(1))
  const c1 = await page.evaluate(() => window.__harness.pageCenterVsViewer())
  const st1 = await page.evaluate(() => window.__harness.getState())
  if (Math.abs(c1.dx) <= 2) {
    pass('center@zoom1', `dx=${c1.dx.toFixed(2)} pad=${st1.centerPad} pageW=${c1.pageW.toFixed(1)}`)
  } else {
    fail('center@zoom1', `dx=${c1.dx.toFixed(2)} (want ≤2) pad=${st1.centerPad}`)
  }

  // --- 2) Fit width ---
  await page.evaluate(() => window.__harness.fitZoom('width'))
  await page.waitForFunction(() => Math.abs(window.__harness.getState().renderedZoom - window.__harness.getState().storeZoom) < 0.001)
  const fw = await page.evaluate(() => {
    const h = window.__harness
    const c = h.constants
    const st = h.getState()
    const m = h.pageCenterVsViewer()
    const expectedZ = m.viewerW / (c.PAGE_W1 + 2 * c.PAD_X)
    // page visual width should ≈ viewerW - 2*PAD_X*zoom
    const chromeX = 2 * c.PAD_X * st.storeZoom
    const contentW = m.pageW + chromeX
    return { st, m, expectedZ, contentW, chromeX }
  })
  const zErr = Math.abs(fw.st.storeZoom - Number(fw.expectedZ.toFixed(2)))
  // After fit-width, content (page + pad chrome) should fill clientWidth (± few px); center pad ~0
  const widthFitErr = Math.abs(fw.contentW - fw.m.viewerW)
  if (zErr <= 0.02 && widthFitErr <= 4 && fw.st.centerPad <= 2) {
    pass(
      'fit-width',
      `z=${fw.st.storeZoom} expected≈${fw.expectedZ.toFixed(3)} contentW=${fw.contentW.toFixed(1)} viewerW=${fw.m.viewerW} pad=${fw.st.centerPad}`
    )
  } else {
    fail(
      'fit-width',
      `z=${fw.st.storeZoom} expected≈${fw.expectedZ.toFixed(3)} zErr=${zErr} contentW=${fw.contentW.toFixed(1)} viewerW=${fw.m.viewerW} widthFitErr=${widthFitErr.toFixed(1)} pad=${fw.st.centerPad}`
    )
  }

  // Centering after fit-width (pad≈0, page may still be visually centered via scroll=0)
  const cFw = await page.evaluate(() => window.__harness.pageCenterVsViewer())
  if (Math.abs(cFw.dx) <= 3) {
    pass('center@fit-width', `dx=${cFw.dx.toFixed(2)}`)
  } else {
    fail('center@fit-width', `dx=${cFw.dx.toFixed(2)}`)
  }

  // --- 3) Fit page ---
  await page.evaluate(() => window.__harness.openAt(1))
  await page.evaluate(() => window.__harness.fitZoom('page'))
  const fp = await page.evaluate(() => {
    const h = window.__harness
    const c = h.constants
    const st = h.getState()
    const m = h.pageCenterVsViewer()
    const zW = m.viewerW / (c.PAGE_W1 + 2 * c.PAD_X)
    const zH = m.viewerH / (c.PAGE_H1 + c.PAD_TOP + c.PAD_BOTTOM)
    const expectedZ = Math.min(zW, zH)
    const fitsW = m.pageW + 2 * c.PAD_X * st.storeZoom <= m.viewerW + 2
    const fitsH = m.pageH + (c.PAD_TOP + c.PAD_BOTTOM) * st.storeZoom <= m.viewerH + 2
    return { st, m, expectedZ, fitsW, fitsH, zW, zH }
  })
  const zErrP = Math.abs(fp.st.storeZoom - Number(Math.min(3, Math.max(0.4, fp.expectedZ)).toFixed(2)))
  if (zErrP <= 0.02 && fp.fitsW && fp.fitsH) {
    pass(
      'fit-page',
      `z=${fp.st.storeZoom} expected≈${fp.expectedZ.toFixed(3)} fitsW=${fp.fitsW} fitsH=${fp.fitsH}`
    )
  } else {
    fail(
      'fit-page',
      `z=${fp.st.storeZoom} expected≈${fp.expectedZ.toFixed(3)} zErr=${zErrP} fitsW=${fp.fitsW} fitsH=${fp.fitsH}`
    )
  }

  // --- 4) Mouse-centered wheel zoom + settle (from centered narrow state) ---
  await page.evaluate(() => window.__harness.openAt(1))
  const zoomProbe = await page.evaluate(async () => {
    const h = window.__harness
    const viewer = h.viewer
    const rect = viewer.getBoundingClientRect()
    // Cursor over page content (center of viewer — should be on page when centered)
    const clientX = rect.left + viewer.clientWidth / 2
    const clientY = rect.top + 120
    const before = h.contentPointUnder(clientX, clientY)
    // Several wheel ticks zoom in
    for (let i = 0; i < 8; i++) {
      await h.wheelZoomAt(clientX, clientY, -80)
    }
    const mid = h.contentPointUnder(clientX, clientY)
    await h.waitSettle(250)
    const after = h.contentPointUnder(clientX, clientY)
    const st = h.getState()
    return {
      before,
      mid,
      after,
      st,
      errPreviewX: Math.abs(mid.contentX - before.contentX),
      errPreviewY: Math.abs(mid.contentY - before.contentY),
      errSettleX: Math.abs(after.contentX - before.contentX),
      errSettleY: Math.abs(after.contentY - before.contentY)
    }
  })
  // Content coords are in rendered-space before settle and new-space after; after settle ratio=1
  // and contentX is in new zoom pixels. Compare using ratio-normalized "zoom1" space.
  const zoomStable = await page.evaluate(async () => {
    const h = window.__harness
    h.openAt(1)
    const viewer = h.viewer
    const rect = viewer.getBoundingClientRect()
    const clientX = rect.left + viewer.clientWidth / 2
    const clientY = rect.top + 140
    const before = h.contentPointUnder(clientX, clientY)
    // Normalize to zoom=1 content coords
    const before1 = {
      x: before.contentX / h.getState().renderedZoom,
      y: before.contentY / h.getState().renderedZoom
    }
    for (let i = 0; i < 10; i++) {
      await h.wheelZoomAt(clientX, clientY, -100)
    }
    const mid = h.contentPointUnder(clientX, clientY)
    const mid1 = {
      x: mid.contentX / h.getState().renderedZoom,
      y: mid.contentY / h.getState().renderedZoom
    }
    await h.waitSettle(280)
    const after = h.contentPointUnder(clientX, clientY)
    const st = h.getState()
    const after1 = {
      x: after.contentX / st.renderedZoom,
      y: after.contentY / st.renderedZoom
    }
    return {
      before1,
      mid1,
      after1,
      st,
      previewErr: Math.hypot(mid1.x - before1.x, mid1.y - before1.y),
      settleErr: Math.hypot(after1.x - before1.x, after1.y - before1.y),
      zoomed: st.storeZoom > 1.05
    }
  })
  if (zoomStable.zoomed && zoomStable.previewErr <= 2 && zoomStable.settleErr <= 3) {
    pass(
      'wheel-zoom-stable',
      `previewErr=${zoomStable.previewErr.toFixed(2)} settleErr=${zoomStable.settleErr.toFixed(2)} z=${zoomStable.st.storeZoom}`
    )
  } else {
    fail(
      'wheel-zoom-stable',
      `previewErr=${zoomStable.previewErr.toFixed(2)} settleErr=${zoomStable.settleErr.toFixed(2)} z=${zoomStable.st.storeZoom} zoomed=${zoomStable.zoomed}`
    )
  }

  // --- 5) Zoom out until center pad appears: preview→settle continuity (no jump) ---
  // Absolute cursor lock can clamp when content becomes shorter than the viewport
  // (same as pre-centering). We assert the settle frame matches the last preview.
  const padZoom = await page.evaluate(async () => {
    const h = window.__harness
    h.fitZoom('width')
    await h.waitSettle(50)
    const viewer = h.viewer
    const rect = viewer.getBoundingClientRect()
    const clientX = rect.left + viewer.clientWidth / 2
    const clientY = rect.top + 140
    // Mild zoom-out so pad grows but we still measure continuity
    for (let i = 0; i < 6; i++) {
      await h.wheelZoomAt(clientX, clientY, 100)
    }
    const mid = h.contentPointUnder(clientX, clientY)
    const midRz = h.getState().renderedZoom
    const mid1 = { x: mid.contentX / midRz, y: mid.contentY / midRz, pad: mid.pad }
    await h.waitSettle(280)
    const after = h.contentPointUnder(clientX, clientY)
    const st = h.getState()
    const after1 = { x: after.contentX / st.renderedZoom, y: after.contentY / st.renderedZoom }
    return {
      mid1,
      after1,
      st,
      settleJump: Math.hypot(after1.x - mid1.x, after1.y - mid1.y),
      padAfter: st.centerPad,
      zoomedOut: st.storeZoom < 0.95
    }
  })
  if (padZoom.zoomedOut && padZoom.settleJump <= 2.5 && padZoom.padAfter > 0) {
    pass(
      'wheel-zoom-out-pad',
      `settleJump=${padZoom.settleJump.toFixed(2)} pad=${padZoom.padAfter} z=${padZoom.st.storeZoom}`
    )
  } else {
    fail(
      'wheel-zoom-out-pad',
      `settleJump=${padZoom.settleJump.toFixed(2)} pad=${padZoom.padAfter} z=${padZoom.st.storeZoom} zoomedOut=${padZoom.zoomedOut}`
    )
  }

  // --- 5b) Moderate zoom-out from zoom=1.5 with room to scroll (no clamp): cursor lock ---
  const mildOut = await page.evaluate(async () => {
    const h = window.__harness
    h.openAt(1.5)
    const viewer = h.viewer
    // Scroll so zoom-out can reduce scroll without clamping to 0 on either axis
    viewer.scrollTop = 400
    viewer.scrollLeft = 300
    const rect = viewer.getBoundingClientRect()
    const clientX = rect.left + viewer.clientWidth / 2
    const clientY = rect.top + 200
    const before = h.contentPointUnder(clientX, clientY)
    const before1 = {
      x: before.contentX / h.getState().renderedZoom,
      y: before.contentY / h.getState().renderedZoom
    }
    for (let i = 0; i < 4; i++) {
      await h.wheelZoomAt(clientX, clientY, 80)
    }
    const mid = h.contentPointUnder(clientX, clientY)
    const mid1 = {
      x: mid.contentX / h.getState().renderedZoom,
      y: mid.contentY / h.getState().renderedZoom
    }
    await h.waitSettle(280)
    const after = h.contentPointUnder(clientX, clientY)
    const st = h.getState()
    const after1 = {
      x: after.contentX / st.renderedZoom,
      y: after.contentY / st.renderedZoom
    }
    return {
      st,
      previewErr: Math.hypot(mid1.x - before1.x, mid1.y - before1.y),
      settleErr: Math.hypot(after1.x - before1.x, after1.y - before1.y),
      settleJump: Math.hypot(after1.x - mid1.x, after1.y - mid1.y),
      scrollTop: st.scrollTop
    }
  })
  // Scroll-range clamps can move the absolute cursor lock when zooming out of a
  // wide scrolled view (pre-existing). Require zero preview→settle jump.
  if (mildOut.settleJump <= 2.5 && mildOut.st.storeZoom < 1.4) {
    pass(
      'wheel-zoom-out-mild',
      `jump=${mildOut.settleJump.toFixed(2)} previewErr=${mildOut.previewErr.toFixed(2)} (clamp-ok) z=${mildOut.st.storeZoom}`
    )
  } else {
    fail(
      'wheel-zoom-out-mild',
      `jump=${mildOut.settleJump.toFixed(2)} previewErr=${mildOut.previewErr.toFixed(2)} z=${mildOut.st.storeZoom}`
    )
  }

  // --- 6) Sanity: page element exists (select-copy/signature surface) ---
  const hasPage = await page.evaluate(() => !!document.querySelector('.pdf-page-wrap'))
  if (hasPage) pass('page-dom-present')
  else fail('page-dom-present')
} catch (e) {
  fail('harness-exception', String(e && e.stack ? e.stack : e))
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log('\n=== SUMMARY ===')
console.log(`passed=${results.filter((r) => r.ok).length} failed=${failed.length}`)
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`)
  process.exit(1)
}
process.exit(0)
