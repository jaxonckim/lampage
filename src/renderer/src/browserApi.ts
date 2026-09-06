import {
  deletePages,
  insertBlankPage,
  reorderPages,
  extractPages,
  splitByRanges,
  splitEveryN,
  mergePdfs,
  rotatePages,
  duplicatePage,
  embedSignatureImage,
  replacePageWithImage
} from '@shared/pdfOps'
import {
  printMdInBrowser,
  printPdfInBrowser,
  printHtmlInIframe,
  getActiveMarkdownHtml
} from './utils/fullDocumentPrint'

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
    print: async (payload) => {
      if (payload.kind === 'pdf') {
        return printPdfInBrowser(payload.data, 'document.pdf')
      }
      if (payload.kind === 'md') {
        const html = payload.html || getActiveMarkdownHtml()
        return printMdInBrowser(html, payload.title || 'document')
      }
      if (payload.kind === 'html') {
        return printHtmlInIframe(payload.html)
      }
      return false
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
        toArrayBuffer(await embedSignatureImage(u8(data), pageIndex, u8(imageData), mime, rect)),
      replacePageImage: async (data, pageIndex, imageData, mime, pageWidth, pageHeight) =>
        toArrayBuffer(
          await replacePageWithImage(u8(data), pageIndex, u8(imageData), mime, pageWidth, pageHeight)
        )
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
