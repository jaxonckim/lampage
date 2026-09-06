#!/usr/bin/env node
/**
 * Sync pdf.js CMap + standard font assets into the renderer public dir
 * so getDocument({ cMapUrl, standardFontDataUrl }) works offline in Electron.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = path.join(root, 'node_modules', 'pdfjs-dist')
const destRoot = path.join(root, 'src', 'renderer', 'public', 'pdfjs')

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name)
    const to = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function sync() {
  if (!fs.existsSync(srcRoot)) {
    console.warn('[sync-pdfjs-assets] pdfjs-dist not installed; skip')
    return
  }
  fs.rmSync(destRoot, { recursive: true, force: true })
  copyDir(path.join(srcRoot, 'cmaps'), path.join(destRoot, 'cmaps'))
  copyDir(path.join(srcRoot, 'standard_fonts'), path.join(destRoot, 'standard_fonts'))
  console.log('[sync-pdfjs-assets] synced →', path.relative(root, destRoot))
}

sync()
