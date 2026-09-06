/**
 * Verify getSelectionPlainText against:
 * - Synthetic PDF-like text layers (basic + academic: columns, hyphens, zoom)
 * - Real pdf.js renders: find-copy-sample, academic-en-sample, tracemonkey
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
  '.map': 'application/json',
  '.wasm': 'application/wasm'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let path = url.pathname === '/' ? '/selection-copy-fixture.html' : url.pathname
    let filePath
    if (path.startsWith('/samples/')) {
      filePath = join(projectRoot, path)
    } else if (path.startsWith('/pdfjs/')) {
      filePath = join(projectRoot, 'node_modules/pdfjs-dist', path.slice('/pdfjs/'.length))
    } else if (path.startsWith('/scripts/')) {
      filePath = join(projectRoot, path)
    } else {
      filePath = join(__dirname, path.replace(/^\//, ''))
    }
    const data = await readFile(filePath)
    const ext = extname(filePath)
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' })
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
page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'error' || t === 'warning') console.log('[page]', msg.text())
})
page.on('pageerror', (err) => console.error('[pageerror]', err.message))

let failed = 0
let passed = 0

function report(results, label) {
  for (const r of results) {
    if (!r.ok) {
      failed++
      console.error('FAIL', r.name, '\n  expected:', JSON.stringify(r.expected), '\n  actual:  ', JSON.stringify(r.actual),
        r.native != null ? `\n  native:  ${JSON.stringify(r.native)}` : '')
    } else {
      passed++
      console.log('PASS', r.name)
    }
  }
  console.log(`-- ${label}: ${results.filter(r => r.ok).length}/${results.length} passed`)
}

// --- Fixture tests ---
await page.goto(`${base}/selection-copy-fixture.html`, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => Array.isArray(window.__RESULTS__))
const results = await page.evaluate(() => window.__RESULTS__)
report(results, 'fixture')

// --- Real PDF via pdf.js ---
await page.goto(`${base}/selection-copy-pdf.html`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => window.__PDF_READY__ === true, { timeout: 180000 })
const pdfResults = await page.evaluate(() => window.__PDF_RESULTS__)
report(pdfResults, 'pdf')

await browser.close()
server.close()

console.log(`\n=== SUMMARY ===`)
console.log(`PASS ${passed}  FAIL ${failed}  TOTAL ${passed + failed}`)
if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed`)
