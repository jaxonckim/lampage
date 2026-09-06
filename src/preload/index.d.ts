import type { JckApi } from './index'

declare global {
  interface Window {
    api: JckApi
  }
}

export {}
