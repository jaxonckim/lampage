import { PDFDocument, degrees } from 'pdf-lib'

type OpenedFile = { path: string; name: string; data: ArrayBuffer }
type JckApi = Window['api']

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.click()
  })
}

async function fileToOpened(file: File): Promise<OpenedFile> {
  const data = await file.arrayBuffer()
  return { path: file.name, name: file.name, data }
}

const sigKey = 'lampage.signatures.v1'

type SigRec = { id: string; name: string; mime: 'png' | 'jpg'; dataB64: string }

function loadSigs(): SigRec[] {
  try {
    return JSON.parse(localStorage.getItem(sigKey) || '[]') as SigRec[]
  } catch {
    return []
  }
}

function saveSigs(list: SigRec[]): void {
  localStorage.setItem(sigKey, JSON.stringify(list))
}

function b64ToAb(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8.buffer
}

function abToB64(ab: ArrayBuffer): string {
  const u8 = new Uint8Array(ab)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

function downloadBlob(name: string, data: ArrayBuffer | string, mime: string): void {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: mime })
      : new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

async function deletePages(pdfBytes: Uint8Array, pageIndexes: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  const toDelete = [...new Set(pageIndexes)].sort((a, b) => b - a)
  for (const i of toDelete) {
    if (i >= 0 && i < doc.getPageCount()) doc.removePage(i)
  }
  return doc.save()
}

async function insertBlankPage(pdfBytes: Uint8Array, afterIndex: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const count = src.getPageCount()
  const size =
    count > 0
      ? src.getPage(Math.min(Math.max(afterIndex, 0), count - 1)).getSize()
      : { width: 595, height: 842 }
  const indices = Array.from({ length: count }, (_, i) => i)
  const copied = await out.copyPages(src, indices)
  const insertAt = Math.min(Math.max(afterIndex + 1, 0), count)
  for (let i = 0; i < insertAt; i++) out.addPage(copied[i])
  out.addPage([size.width, size.height])
  for (let i = insertAt; i < count; i++) out.addPage(copied[i])
  return out.save()
}

async function reorderPages(pdfBytes: Uint8Array, newOrder: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, newOrder)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

async function extractPages(pdfBytes: Uint8Array, pageIndexes: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, pageIndexes)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

async function splitByRanges(
  pdfBytes: Uint8Array,
  ranges: Array<{ start: number; end: number }>
): Promise<Uint8Array[]> {
  const results: Uint8Array[] = []
  for (const r of ranges) {
    const indexes: number[] = []
    for (let i = r.start; i <= r.end; i++) indexes.push(i)
    results.push(await extractPages(pdfBytes, indexes))
  }
  return results
}

async function splitEveryN(pdfBytes: Uint8Array, n: number): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(pdfBytes)
  const count = src.getPageCount()
  const results: Uint8Array[] = []
  for (let i = 0; i < count; i += n) {
    const indexes = Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k)
    results.push(await extractPages(pdfBytes, indexes))
  }
  return results
}

async function mergePdfs(pdfList: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const bytes of pdfList) {
    const src = await PDFDocument.load(bytes)
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  return out.save()
}

async function rotatePages(
  pdfBytes: Uint8Array,
  pageIndexes: number[],
  angle: 90 | 180 | 270 = 90
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  for (const i of pageIndexes) {
    if (i >= 0 && i < doc.getPageCount()) {
      const page = doc.getPage(i)
      const current = page.getRotation().angle
      page.setRotation(degrees((current + angle) % 360))
    }
  }
  return doc.save()
}

async function duplicatePage(pdfBytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()
  const count = src.getPageCount()
  const order: number[] = []
  for (let i = 0; i < count; i++) {
    order.push(i)
    if (i === pageIndex) order.push(i)
  }
  const pages = await out.copyPages(src, order)
  pages.forEach((p) => out.addPage(p))
  return out.save()
}

async function embedSignatureImage(
  pdfBytes: Uint8Array,
  pageIndex: number,
  imageBytes: Uint8Array,
  mime: 'png' | 'jpg',
  rect: { x: number; y: number; width: number; height: number }
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  const page = doc.getPage(pageIndex)
  const image = mime === 'png' ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes)
  page.drawImage(image, {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  })
  return doc.save()
}

function u8(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data)
}

/** Install a browser fallback for `window.api` when running outside Electron (tunnel preview). */
export function installBrowserApi(): void {
  if (typeof window === 'undefined') return
  if (window.api) return

  const api: JckApi = {
    openFiles: async () => {
      const files = await pickFiles('.pdf,.md,.markdown,application/pdf,text/markdown,text/plain', true)
      const out: OpenedFile[] = []
      for (const f of files) out.push(await fileToOpened(f))
      return out
    },
    openImages: async () => {
      const files = await pickFiles('image/png,image/jpeg,.png,.jpg,.jpeg', false)
      const f = files[0]
      if (!f) return null
      const data = await f.arrayBuffer()
      const mime = f.type.includes('png') || f.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg'
      return { path: f.name, name: f.name, data, mime }
    },
    saveFileDialog: async (opts) => {
      // Browser cannot pick a real path; return a download name the caller writes via writeFile.
      return opts?.defaultPath || 'download.bin'
    },
    readFile: async () => {
      throw new Error('Browser preview cannot read arbitrary paths')
    },
    writeFile: async (path, data) => {
      const name = path.split(/[/\\]/).pop() || 'download'
      if (typeof data === 'string') {
        downloadBlob(name, data, 'text/plain;charset=utf-8')
      } else {
        const ab = data instanceof ArrayBuffer ? data : toArrayBuffer(data)
        const mime = name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
        downloadBlob(name, ab, mime)
      }
      return true
    },
    getPathForFile: () => '',
    readDropped: async () => {
      // Electron-only path list; browser drop handled in App with File objects.
      return []
    },
    print: async () => {
      window.print()
      return true
    },
    pdf: {
      deletePages: async (data, indexes) =>
        toArrayBuffer(await deletePages(u8(data), indexes)),
      insertBlank: async (data, afterIndex) =>
        toArrayBuffer(await insertBlankPage(u8(data), afterIndex)),
      reorder: async (data, order) => toArrayBuffer(await reorderPages(u8(data), order)),
      extract: async (data, indexes) => toArrayBuffer(await extractPages(u8(data), indexes)),
      splitRanges: async (data, ranges) =>
        (await splitByRanges(u8(data), ranges)).map((x) => toArrayBuffer(x)),
      splitEveryN: async (data, n) =>
        (await splitEveryN(u8(data), n)).map((x) => toArrayBuffer(x)),
      merge: async (list) => toArrayBuffer(await mergePdfs(list.map(u8))),
      rotate: async (data, indexes, angle = 90) =>
        toArrayBuffer(await rotatePages(u8(data), indexes, angle)),
      duplicate: async (data, pageIndex) =>
        toArrayBuffer(await duplicatePage(u8(data), pageIndex)),
      embedSignature: async (data, pageIndex, imageData, mime, rect) =>
        toArrayBuffer(await embedSignatureImage(u8(data), pageIndex, u8(imageData), mime, rect))
    },
    signatures: {
      list: async () =>
        loadSigs().map((s) => ({
          id: s.id,
          name: s.name,
          mime: s.mime,
          data: b64ToAb(s.dataB64)
        })),
      save: async (payload) => {
        const id = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const list = loadSigs()
        list.push({
          id,
          name: payload.name,
          mime: payload.mime,
          dataB64: abToB64(payload.data)
        })
        saveSigs(list)
        return id
      },
      delete: async (id) => {
        saveSigs(loadSigs().filter((s) => s.id !== id))
        return true
      }
    },
    onMenu: () => (() => undefined) as unknown as () => import('electron').IpcRenderer
  }

  window.api = api
  ;(window as Window & { __lampageBrowserPreview?: boolean }).__lampageBrowserPreview = true
}
