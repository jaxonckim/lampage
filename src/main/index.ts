import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron'
import { join, resolve, basename, dirname, isAbsolute, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
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
} from '../shared/pdfOps'
import {
  assertPdfBytes,
  assertImageBytes,
  assertPageIndex,
  assertPageIndexes,
  assertOrder,
  assertAngle,
  assertPositiveInt,
  assertMime,
  assertRect,
  assertRanges,
  assertPdfList,
  assertInt
} from './pdfIpcValidate'

let mainWindow: BrowserWindow | null = null

/** Absolute paths the renderer may read/write after explicit user gestures (open/save/drop). */
const allowedPaths = new Set<string>()

function signaturesDir(): string {
  return join(app.getPath('userData'), 'signatures')
}

async function ensureSignaturesDir(): Promise<string> {
  const dir = signaturesDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  return dir
}

function assertSafeAbsolutePath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Invalid path')
  }
  if (filePath.includes('\0')) {
    throw new Error('Invalid path')
  }
  const resolved = resolve(filePath)
  if (!isAbsolute(resolved)) {
    throw new Error('Path must be absolute')
  }
  return resolved
}

function allowPath(filePath: string): string {
  const resolved = assertSafeAbsolutePath(filePath)
  allowedPaths.add(resolved)
  return resolved
}

function requireAllowedPath(filePath: unknown): string {
  const resolved = assertSafeAbsolutePath(filePath)
  if (!allowedPaths.has(resolved)) {
    throw new Error('Path not permitted')
  }
  return resolved
}

/** Ensure a signature id resolves to a file directly under the signatures directory. */
function resolveSignatureTarget(dir: string, id: unknown): string {
  if (typeof id !== 'string' || !id || id.includes('\0')) {
    throw new Error('Invalid signature id')
  }
  // Reject any path separators / relative segments before basename.
  if (/[/\\]/.test(id) || id === '.' || id === '..') {
    throw new Error('Invalid signature id')
  }
  const safeName = basename(id)
  if (!safeName || safeName !== id) {
    throw new Error('Invalid signature id')
  }
  if (!/\.(png|jpg|jpeg)$/i.test(safeName)) {
    throw new Error('Invalid signature id')
  }
  const target = resolve(dir, safeName)
  const root = resolve(dir)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Invalid signature path')
  }
  return target
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Lampage',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // Deny in-window navigations away from the app shell (window-open already denied).
  // Allow the initial loadURL/loadFile and same-origin / file: app documents.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let allowed = false
    try {
      const target = new URL(url)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const dev = new URL(process.env['ELECTRON_RENDERER_URL'])
        allowed = target.origin === dev.origin
      } else {
        allowed = target.protocol === 'file:'
      }
    } catch {
      allowed = false
    }
    if (allowed) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  buildMenu()
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open')
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save')
        },
        {
          label: '另存为...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-as')
        },
        { type: 'separator' },
        {
          label: '打印...',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow?.webContents.send('menu:print')
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        {
          label: '查找...',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('menu:find')
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function toBuffer(data: Uint8Array | ArrayBuffer | number[]): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return Buffer.from(data)
}

function registerIpc(): void {
  ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'txt'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'All', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    const files = []
    for (const filePath of result.filePaths) {
      const allowed = allowPath(filePath)
      const buf = await readFile(allowed)
      files.push({
        path: allowed,
        name: basename(allowed),
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      })
    }
    return files
  })

  ipcMain.handle('dialog:openImages', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const allowed = allowPath(result.filePaths[0])
    const buf = await readFile(allowed)
    return {
      path: allowed,
      name: basename(allowed),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mime: allowed.toLowerCase().endsWith('.png') ? 'png' : 'jpg'
    }
  })

  ipcMain.handle(
    'dialog:saveFile',
    async (_e, opts: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: typeof opts?.defaultPath === 'string' ? opts.defaultPath : undefined,
        filters: opts?.filters || [{ name: 'All', extensions: ['*'] }]
      })
      if (result.canceled || !result.filePath) return null
      return allowPath(result.filePath)
    }
  )

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    const allowed = requireAllowedPath(filePath)
    const buf = await readFile(allowed)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle(
    'fs:writeFile',
    async (_e, filePath: string, data: ArrayBuffer | Uint8Array | string) => {
      const allowed = requireAllowedPath(filePath)
      // Ensure parent dir exists only for already-allowed paths (save-as creates new files).
      const parent = dirname(allowed)
      if (!existsSync(parent)) {
        throw new Error('Parent directory does not exist')
      }
      if (typeof data === 'string') {
        await writeFile(allowed, data, 'utf8')
      } else {
        await writeFile(allowed, toBuffer(data as Uint8Array))
      }
      return true
    }
  )

  ipcMain.handle('fs:readDropped', async (_e, filePaths: unknown) => {
    if (!Array.isArray(filePaths)) throw new Error('Invalid paths')
    const files = []
    for (const filePath of filePaths) {
      // User explicitly dropped these files — allow after absolute-path checks.
      const allowed = allowPath(filePath as string)
      if (!/\.(pdf|md|markdown|txt)$/i.test(allowed)) {
        throw new Error('Unsupported dropped file type')
      }
      const buf = await readFile(allowed)
      files.push({
        path: allowed,
        name: basename(allowed),
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      })
    }
    return files
  })

  ipcMain.handle('print:current', async () => {
    if (!mainWindow) return false
    return new Promise<boolean>((resolvePromise) => {
      mainWindow!.webContents.print({ silent: false, printBackground: true }, (success) => {
        resolvePromise(success)
      })
    })
  })

  // PDF ops (validated args — DoS / throw hardening, not a sandbox substitute)
  ipcMain.handle('pdf:deletePages', async (_e, data: unknown, indexes: unknown) => {
    const pdf = assertPdfBytes(data)
    const out = await deletePages(new Uint8Array(pdf), assertPageIndexes(indexes))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:insertBlank', async (_e, data: unknown, afterIndex: unknown) => {
    const pdf = assertPdfBytes(data)
    const out = await insertBlankPage(new Uint8Array(pdf), assertInt(afterIndex, 'afterIndex'))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:reorder', async (_e, data: unknown, order: unknown) => {
    const pdf = assertPdfBytes(data)
    const out = await reorderPages(new Uint8Array(pdf), assertOrder(order))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:extract', async (_e, data: unknown, indexes: unknown) => {
    const pdf = assertPdfBytes(data)
    const out = await extractPages(new Uint8Array(pdf), assertPageIndexes(indexes))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:splitRanges', async (_e, data: unknown, ranges: unknown) => {
    const pdf = assertPdfBytes(data)
    const outs = await splitByRanges(new Uint8Array(pdf), assertRanges(ranges))
    return outs.map((o) => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength))
  })
  ipcMain.handle('pdf:splitEveryN', async (_e, data: unknown, n: unknown) => {
    const pdf = assertPdfBytes(data)
    const outs = await splitEveryN(new Uint8Array(pdf), assertPositiveInt(n, 'n'))
    return outs.map((o) => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength))
  })
  ipcMain.handle('pdf:merge', async (_e, list: unknown) => {
    const out = await mergePdfs(assertPdfList(list).map((d) => new Uint8Array(d)))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:rotate', async (_e, data: unknown, indexes: unknown, angle: unknown) => {
    const pdf = assertPdfBytes(data)
    const out = await rotatePages(new Uint8Array(pdf), assertPageIndexes(indexes), assertAngle(angle))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:duplicate', async (_e, data: unknown, pageIndex: unknown) => {
    const pdf = assertPdfBytes(data)
    const out = await duplicatePage(new Uint8Array(pdf), assertPageIndex(pageIndex))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle(
    'pdf:embedSignature',
    async (_e, data: unknown, pageIndex: unknown, imageData: unknown, mime: unknown, rect: unknown) => {
      const pdf = assertPdfBytes(data)
      const img = assertImageBytes(imageData)
      const out = await embedSignatureImage(
        new Uint8Array(pdf),
        assertPageIndex(pageIndex),
        new Uint8Array(img),
        assertMime(mime),
        assertRect(rect)
      )
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
    }
  )
  ipcMain.handle(
    'pdf:replacePageImage',
    async (
      _e,
      data: unknown,
      pageIndex: unknown,
      imageData: unknown,
      mime: unknown,
      pageWidth: unknown,
      pageHeight: unknown
    ) => {
      const pdf = assertPdfBytes(data)
      const img = assertImageBytes(imageData)
      const w = pageWidth
      const h = pageHeight
      if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) {
        throw new Error('Invalid page size')
      }
      if (w <= 0 || h <= 0 || w > 20000 || h > 20000) throw new Error('Invalid page size')
      const out = await replacePageWithImage(
        new Uint8Array(pdf),
        assertPageIndex(pageIndex),
        new Uint8Array(img),
        assertMime(mime),
        w,
        h
      )
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
    }
  )

  // Signatures storage
  ipcMain.handle('signatures:list', async () => {
    const dir = await ensureSignaturesDir()
    const names = await readdir(dir)
    const items = []
    for (const name of names) {
      if (!/\.(png|jpg|jpeg)$/i.test(name)) continue
      const buf = await readFile(join(dir, name))
      items.push({
        id: name,
        name,
        mime: name.toLowerCase().endsWith('.png') ? 'png' : 'jpg',
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      })
    }
    return items
  })

  ipcMain.handle(
    'signatures:save',
    async (_e, payload: { name: string; data: ArrayBuffer; mime: 'png' | 'jpg' }) => {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid payload')
      if (payload.mime !== 'png' && payload.mime !== 'jpg') throw new Error('Invalid mime')
      const dir = await ensureSignaturesDir()
      const rawName = typeof payload.name === 'string' ? payload.name : ''
      const safe = basename(rawName).replace(/[^\w.\-]/gi, '_') || `sig-${Date.now()}`
      const ext = payload.mime === 'png' ? 'png' : 'jpg'
      const fileName = safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`
      const target = resolveSignatureTarget(dir, fileName)
      await writeFile(target, toBuffer(new Uint8Array(payload.data)))
      return basename(target)
    }
  )

  ipcMain.handle('signatures:delete', async (_e, id: string) => {
    const dir = await ensureSignaturesDir()
    const target = resolveSignatureTarget(dir, id)
    if (existsSync(target)) await unlink(target)
    return true
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.lampage.app')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
