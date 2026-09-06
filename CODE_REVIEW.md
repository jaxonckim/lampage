# Lampage code review (2026-09-06)

## Task A — samples UI removed

- Removed bottom **示例** block + `openWelcomeSample()` from `src/renderer/src/components/LeftSidebar.tsx`
- Removed unused `.sidebar-section-label` from `src/renderer/src/styles/global.css`
- Kept `samples/` on disk for manual testing (not wired into UI)

## Critical / High fixes applied

| Severity | Issue | Fix |
|----------|-------|-----|
| Critical | `sandbox: false` | `sandbox: true` in `src/main/index.ts` |
| Critical | Unrestricted `fs:readFile` / `fs:writeFile` | Absolute-path checks + allowlist; paths allowed only via open/save dialog or drop |
| High | `shell.openExternal` any URL | Allow only `http:` / `https:` |
| High | `signatures:delete` / save path traversal | `basename` + reject separators; resolve must stay under signatures dir |
| High | `onMenu` listened on any channel | Whitelist `menu:*` in preload |
| High | Drop used deprecated `File.path` | `webUtils.getPathForFile` via preload; browser stub returns `''` |
| High | Drop could read arbitrary paths | `fs:readDropped` limited to `.pdf/.md/.markdown/.txt` |
| High | MD `javascript:` / attr injection XSS | `safeHref`, escape `data-language`, TipTap Link protocol allowlist |
| Medium | SignatureModal ObjectURL leak | Create/revoke via `urlsRef` |

## Follow-ups addressed (this pass)

| Item | Status | Notes |
|------|--------|-------|
| Production CSP / `allowedHosts` | Done | Dev/preview (`command === 'serve'`): permissive CSP + `allowedHosts: true` for tunnels. Production build: tight CSP (`connect-src 'self' blob:` only) via `transformIndexHtml`. Packaged apps never use vite `server`. |
| Dirty close confirm | Done | `closeDoc` prompts when `dirty` (Ctrl+W / file-list ×). |
| Stronger PDF IPC validation | Done | `src/main/pdfIpcValidate.ts` — sizes, indexes, angles, mime, rect, ranges (no zod). |
| Destroy PDF proxies in cleanup | Done | `PdfViewer` + `RightSidebar` destroy on effect cleanup (not only unmount / `finally` race). |
| Dead `void encodeText` | Done | Removed from `App.tsx`. |
| PageManageModal dead bitmap loop | Done | Removed no-op `existing.forEach`. |
| `will-navigate` deny | Done | Deny in-window navigations; safe http(s) → `openExternal`. |
| Share `pdfOps` in `browserApi` | Done | Imports `@shared/pdfOps` (alias added). |

## Signature UX (this pass)

1. **Free place + resize** — pick signature → overlay on current page with drag move + 8 resize handles (`SignaturePlacer`).
2. **Remember size in PDF points** — `localStorage` key `lampage.signatureSize.v1` stores `{width,height}` in page units. Display uses `points * (zoom * 1.25)`; zoom does not change remembered size.
3. **Flatten embed** — `flattenEmbedSignature`: pdf.js render page → draw signature → JPEG → `replacePageWithImage` (pdf-lib). **Tradeoff: that page becomes a raster** (no text select / vector extract on that page). Status bar notes this.
4. Flow: modal pick/draw/import → place/resize → Confirm → flatten; Esc cancels.

## Remaining findings (not this pass)

### Medium
1. **PdfViewer** cancelled mid-`page.render` can still throw noisily after destroy (caught / ignored in places).
2. **readDropped residual**: compromised renderer can still allow+read absolute paths ending in allowed extensions.
3. **Custom MD parser** (`MarkdownView.tsx`): lossy vs CommonMark; TipTap HTML round-trip can alter content.

### Low
1. Keep Electron / pdfjs-dist updated (native PDF parsing attack surface).
2. Flattened signature pages are JPEG (~0.92 quality); very large pages may be heavy.
3. Signature placer clamps to page bounds; no multi-page placement in one gesture.

