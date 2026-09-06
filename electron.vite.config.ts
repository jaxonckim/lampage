import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const DEV_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob: ws: wss: http: https:;"
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob:;"

function lampageCsp(): Plugin {
  return {
    name: 'lampage-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const isBuild = Boolean(ctx.bundle) || process.env.NODE_ENV === 'production'
        if (!isBuild) return html
        return html.replace(
          /http-equiv="Content-Security-Policy" content="[^"]*"/,
          `http-equiv="Content-Security-Policy" content="${PROD_CSP}"`
        )
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    // Cloudflare quick tunnels in preview/dev
    server: {
      allowedHosts: true,
      host: '127.0.0.1'
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), lampageCsp()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    optimizeDeps: {
      include: ['pdfjs-dist']
    }
  }
})
