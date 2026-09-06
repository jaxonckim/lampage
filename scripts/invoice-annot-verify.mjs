#!/usr/bin/env node
/**
 * Verify Chinese VAT e-invoice renders with CJK text + Widget/AP stamp via pdf.js.
 * Compares against poppler reference PNG.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const invoicePdf =
  process.env.INVOICE_PDF ||
  '/home/box/agent-data/agents/40dd07c6-3d1a-4242-ab9c-f2e47147df71/attachments/f864d196396e98d708c671c1af6ee9b42e27b4d56961eb52ed3010bd73768996.pdf'
const refPng = process.env.REF_PNG || '/workspace/invoice-ref-1.png'
const outDir = '/workspace'

function mime(p) {
  if (p.endsWith('.mjs') || p.endsWith('.js')) return 'text/javascript'
  if (p.endsWith('.bcmap')) return 'application/octet-stream'
  if (p.endsWith('.pfb') || p.endsWith('.ttf')) return 'application/octet-stream'
  if (p.endsWith('.pdf')) return 'application/pdf'
  if (p.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    let fp
    if (u.pathname.startsWith('/pdfjs/')) {
      fp = path.join(root, 'src/renderer/public', u.pathname.slice(1))
    } else if (u.pathname.startsWith('/vendor/')) {
      fp = path.join(root, 'node_modules/pdfjs-dist', u.pathname.slice('/vendor/'.length))
    } else if (u.pathname === '/invoice.pdf') {
      fp = invoicePdf
    } else if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(HTML)
      return
    } else {
      res.writeHead(404)
      res.end('no')
      return
    }
    if (!fs.existsSync(fp)) {
      res.writeHead(404)
      res.end('missing ' + fp)
      return
    }
    res.writeHead(200, { 'content-type': mime(fp) })
    fs.createReadStream(fp).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { server, port }
}

const HTML = `<!doctype html>
<html><body>
<canvas id="c"></canvas>
<script type="module">
import * as pdfjs from '/vendor/build/pdf.mjs'
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.min.mjs'

async function render(mode) {
  const data = new Uint8Array(await (await fetch('/invoice.pdf')).arrayBuffer())
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/'
  }).promise
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: 1 })
  const canvas = document.getElementById('c')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0,0,canvas.width,canvas.height)
  await page.render({
    canvasContext: ctx,
    viewport,
    annotationMode: mode
  }).promise
  const annots = await page.getAnnotations({ intent: 'display' })
  const png = canvas.toDataURL('image/png')
  await doc.destroy()
  return {
    png,
    w: canvas.width,
    h: canvas.height,
    annots: annots.map(a => ({
      subtype: a.subtype,
      fieldType: a.fieldType,
      hasAppearance: a.hasAppearance,
      noHTML: a.noHTML,
      rect: a.rect
    }))
  }
}

window.__run = async () => {
  const ENABLE = pdfjs.AnnotationMode.ENABLE
  const DISABLE = pdfjs.AnnotationMode.DISABLE
  const withAnnot = await render(ENABLE)
  const noAnnot = await render(DISABLE)
  return { ENABLE, DISABLE, withAnnot, noAnnot }
}
</script>
</body></html>`

function decodeDataUrl(dataUrl) {
  const b64 = dataUrl.split(',')[1]
  return Buffer.from(b64, 'base64')
}

async function pngStats(buf) {
  // Use sharp if available, else canvas via chrome already; here use built-in via puppeteer page
  return buf
}

async function main() {
  // ensure assets
  await import('./sync-pdfjs-assets.mjs')

  const { server, port } = await startServer()
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  })
  try {
    const page = await browser.newPage()
    page.on('console', (m) => console.log('browser:', m.type(), m.text()))
    page.on('pageerror', (e) => console.error('pageerror', e))
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async () => window.__run())
    const enableBuf = decodeDataUrl(result.withAnnot.png)
    const disableBuf = decodeDataUrl(result.noAnnot.png)
    fs.writeFileSync(path.join(outDir, 'invoice-verify-annot-enable.png'), enableBuf)
    fs.writeFileSync(path.join(outDir, 'invoice-verify-annot-disable.png'), disableBuf)

    // Compare pixel stats in page against reference
    const stats = await page.evaluate(async (refB64, enB64, disB64) => {
      async function load(b64) {
        const img = new Image()
        img.src = 'data:image/png;base64,' + b64
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const { data } = ctx.getImageData(0, 0, c.width, c.height)
        let nonwhite = 0, redish = 0
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2]
          if (r < 250 || g < 250 || b < 250) nonwhite++
          if (r > 150 && g < 100 && b < 100) redish++
        }
        // stamp region approx Rect[474,12,580,92] in PDF space y-up → canvas y-down: y from (397-92)=305 to (397-12)=385, x 474-580
        const x0=474, x1=580, y0=305, y1=385
        let stampNonwhite = 0, stampRed = 0
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * c.width + x) * 4
            const r = data[i], g = data[i+1], b = data[i+2]
            if (r < 250 || g < 250 || b < 250) stampNonwhite++
            if (r > 150 && g < 100 && b < 100) stampRed++
          }
        }
        return { w: c.width, h: c.height, nonwhite, redish, stampNonwhite, stampRed }
      }
      return {
        ref: await load(refB64),
        enable: await load(enB64),
        disable: await load(disB64)
      }
    },
      fs.readFileSync(refPng).toString('base64'),
      enableBuf.toString('base64'),
      disableBuf.toString('base64')
    )

    console.log(JSON.stringify({ annots: result.withAnnot.annots, stats }, null, 2))

    const okText = stats.enable.nonwhite > stats.ref.nonwhite * 0.7
    const okStamp = stats.enable.stampRed > 200
    const stampDiff = Math.abs(stats.enable.stampRed - stats.disable.stampRed)
    console.log('TEXT_OK', okText, 'stampRed enable', stats.enable.stampRed, 'disable', stats.disable.stampRed, 'diff', stampDiff)
    console.log('STAMP_OK', okStamp)
    console.log('nonwhite ref/enable/disable', stats.ref.nonwhite, stats.enable.nonwhite, stats.disable.nonwhite)

    if (!okText || !okStamp) {
      process.exitCode = 1
      console.error('VERIFY_FAILED')
    } else {
      console.log('VERIFY_PASSED')
    }
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
