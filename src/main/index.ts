import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron'
import { join } from 'path'
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
  embedSignatureImage
} from '../shared/pdfOps'

let mainWindow: BrowserWindow | null = null

function signaturesDir(): string {
  return join(app.getPath('userData'), 'signatures')
}

async function ensureSignaturesDir(): Promise<string> {
  const dir = signaturesDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  return dir
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
      const buf = await readFile(filePath)
      files.push({
        path: filePath,
        name: filePath.split(/[/\\]/).pop() || filePath,
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
    const filePath = result.filePaths[0]
    const buf = await readFile(filePath)
    return {
      path: filePath,
      name: filePath.split(/[/\\]/).pop() || filePath,
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mime: filePath.toLowerCase().endsWith('.png') ? 'png' : 'jpg'
    }
  })

  ipcMain.handle('dialog:saveFile', async (_e, opts: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: opts?.defaultPath,
      filters: opts?.filters || [{ name: 'All', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    const buf = await readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('fs:writeFile', async (_e, filePath: string, data: ArrayBuffer | Uint8Array | string) => {
    if (typeof data === 'string') {
      await writeFile(filePath, data, 'utf8')
    } else {
      await writeFile(filePath, toBuffer(data as Uint8Array))
    }
    return true
  })

  ipcMain.handle('fs:readDropped', async (_e, filePaths: string[]) => {
    const files = []
    for (const filePath of filePaths) {
      const buf = await readFile(filePath)
      files.push({
        path: filePath,
        name: filePath.split(/[/\\]/).pop() || filePath,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      })
    }
    return files
  })

  ipcMain.handle('print:current', async () => {
    if (!mainWindow) return false
    return new Promise<boolean>((resolve) => {
      mainWindow!.webContents.print({ silent: false, printBackground: true }, (success) => {
        resolve(success)
      })
    })
  })

  // PDF ops
  ipcMain.handle('pdf:deletePages', async (_e, data: ArrayBuffer, indexes: number[]) => {
    const out = await deletePages(new Uint8Array(data), indexes)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:insertBlank', async (_e, data: ArrayBuffer, afterIndex: number) => {
    const out = await insertBlankPage(new Uint8Array(data), afterIndex)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:reorder', async (_e, data: ArrayBuffer, order: number[]) => {
    const out = await reorderPages(new Uint8Array(data), order)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:extract', async (_e, data: ArrayBuffer, indexes: number[]) => {
    const out = await extractPages(new Uint8Array(data), indexes)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:splitRanges', async (_e, data: ArrayBuffer, ranges: Array<{ start: number; end: number }>) => {
    const outs = await splitByRanges(new Uint8Array(data), ranges)
    return outs.map((o) => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength))
  })
  ipcMain.handle('pdf:splitEveryN', async (_e, data: ArrayBuffer, n: number) => {
    const outs = await splitEveryN(new Uint8Array(data), n)
    return outs.map((o) => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength))
  })
  ipcMain.handle('pdf:merge', async (_e, list: ArrayBuffer[]) => {
    const out = await mergePdfs(list.map((d) => new Uint8Array(d)))
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:rotate', async (_e, data: ArrayBuffer, indexes: number[], angle: 90 | 180 | 270) => {
    const out = await rotatePages(new Uint8Array(data), indexes, angle)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle('pdf:duplicate', async (_e, data: ArrayBuffer, pageIndex: number) => {
    const out = await duplicatePage(new Uint8Array(data), pageIndex)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
  })
  ipcMain.handle(
    'pdf:embedSignature',
    async (
      _e,
      data: ArrayBuffer,
      pageIndex: number,
      imageData: ArrayBuffer,
      mime: 'png' | 'jpg',
      rect: { x: number; y: number; width: number; height: number }
    ) => {
      const out = await embedSignatureImage(
        new Uint8Array(data),
        pageIndex,
        new Uint8Array(imageData),
        mime,
        rect
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
      const dir = await ensureSignaturesDir()
      const safe = payload.name.replace(/[^\w.\-]/gi, '_') || `sig-${Date.now()}`
      const ext = payload.mime === 'png' ? 'png' : 'jpg'
      const fileName = safe.endsWith(`.${ext}`) ? safe : `${safe}.${ext}`
      await writeFile(join(dir, fileName), toBuffer(new Uint8Array(payload.data)))
      return fileName
    }
  )

  ipcMain.handle('signatures:delete', async (_e, id: string) => {
    const dir = await ensureSignaturesDir()
    const target = join(dir, id)
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
