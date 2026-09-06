import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type OpenedFile = {
  path: string
  name: string
  data: ArrayBuffer
}

const MENU_CHANNELS = new Set([
  'menu:open',
  'menu:save',
  'menu:save-as',
  'menu:print',
  'menu:find'
])

const api = {
  openFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('dialog:openFiles'),
  openImages: (): Promise<(OpenedFile & { mime: 'png' | 'jpg' }) | null> =>
    ipcRenderer.invoke('dialog:openImages'),
  saveFileDialog: (opts?: {
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null> => ipcRenderer.invoke('dialog:saveFile', opts),
  readFile: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, data: ArrayBuffer | Uint8Array | string): Promise<boolean> =>
    ipcRenderer.invoke('fs:writeFile', path, data),
  readDropped: (paths: string[]): Promise<OpenedFile[]> =>
    ipcRenderer.invoke('fs:readDropped', paths),
  /** Resolve a dropped File to an absolute path (Electron; empty string if unavailable). */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  print: (payload: {
    kind: 'pdf'
    data: ArrayBuffer
  } | {
    kind: 'md'
    html: string
    title?: string
  } | {
    kind: 'html'
    html: string
    title?: string
    pageCount?: number
  }): Promise<boolean> => ipcRenderer.invoke('print:document', payload),

  pdf: {
    deletePages: (data: ArrayBuffer, indexes: number[]) =>
      ipcRenderer.invoke('pdf:deletePages', data, indexes) as Promise<ArrayBuffer>,
    insertBlank: (data: ArrayBuffer, afterIndex: number) =>
      ipcRenderer.invoke('pdf:insertBlank', data, afterIndex) as Promise<ArrayBuffer>,
    reorder: (data: ArrayBuffer, order: number[]) =>
      ipcRenderer.invoke('pdf:reorder', data, order) as Promise<ArrayBuffer>,
    extract: (data: ArrayBuffer, indexes: number[]) =>
      ipcRenderer.invoke('pdf:extract', data, indexes) as Promise<ArrayBuffer>,
    splitRanges: (data: ArrayBuffer, ranges: Array<{ start: number; end: number }>) =>
      ipcRenderer.invoke('pdf:splitRanges', data, ranges) as Promise<ArrayBuffer[]>,
    splitEveryN: (data: ArrayBuffer, n: number) =>
      ipcRenderer.invoke('pdf:splitEveryN', data, n) as Promise<ArrayBuffer[]>,
    merge: (list: ArrayBuffer[]) =>
      ipcRenderer.invoke('pdf:merge', list) as Promise<ArrayBuffer>,
    rotate: (data: ArrayBuffer, indexes: number[], angle: 90 | 180 | 270 = 90) =>
      ipcRenderer.invoke('pdf:rotate', data, indexes, angle) as Promise<ArrayBuffer>,
    duplicate: (data: ArrayBuffer, pageIndex: number) =>
      ipcRenderer.invoke('pdf:duplicate', data, pageIndex) as Promise<ArrayBuffer>,
    embedSignature: (
      data: ArrayBuffer,
      pageIndex: number,
      imageData: ArrayBuffer,
      mime: 'png' | 'jpg',
      rect: { x: number; y: number; width: number; height: number }
    ) =>
      ipcRenderer.invoke(
        'pdf:embedSignature',
        data,
        pageIndex,
        imageData,
        mime,
        rect
      ) as Promise<ArrayBuffer>,
    /** Replace a page with a full-page raster (used by flatten-embed signatures). */
    replacePageImage: (
      data: ArrayBuffer,
      pageIndex: number,
      imageData: ArrayBuffer,
      mime: 'png' | 'jpg',
      pageWidth: number,
      pageHeight: number
    ) =>
      ipcRenderer.invoke(
        'pdf:replacePageImage',
        data,
        pageIndex,
        imageData,
        mime,
        pageWidth,
        pageHeight
      ) as Promise<ArrayBuffer>
  },

  signatures: {
    list: () =>
      ipcRenderer.invoke('signatures:list') as Promise<
        Array<{ id: string; name: string; mime: 'png' | 'jpg'; data: ArrayBuffer }>
      >,
    save: (payload: { name: string; data: ArrayBuffer; mime: 'png' | 'jpg' }) =>
      ipcRenderer.invoke('signatures:save', payload) as Promise<string>,
    delete: (id: string) => ipcRenderer.invoke('signatures:delete', id) as Promise<boolean>
  },

  onMenu: (channel: string, cb: () => void): (() => void) => {
    if (!MENU_CHANNELS.has(channel)) {
      return () => undefined
    }
    const handler = (): void => cb()
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },

  /** Main-process file association / second-instance open (payload already read). */
  onOpenFiles: (cb: (files: OpenedFile[]) => void): (() => void) => {
    const handler = (_event: unknown, files: OpenedFile[]): void => {
      if (Array.isArray(files) && files.length) cb(files)
    }
    ipcRenderer.on('app:open-files', handler)
    return () => {
      ipcRenderer.removeListener('app:open-files', handler)
    }
  },

  /** Flush argv / open-file paths queued before the renderer subscribed. */
  rendererReady: (): Promise<OpenedFile[]> => ipcRenderer.invoke('app:renderer-ready'),

  /** Main asks renderer whether to allow window close / quit (dirty docs). */
  onConfirmClose: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('app:confirm-close', handler)
    return () => {
      ipcRenderer.removeListener('app:confirm-close', handler)
    }
  },

  /** Reply to app:confirm-close — true proceeds with close/quit. */
  confirmCloseResponse: (proceed: boolean): void => {
    ipcRenderer.send('app:confirm-close-response', proceed)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type JckApi = typeof api
