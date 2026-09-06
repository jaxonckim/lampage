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

`bun run typecheck` passes. No git commit made.

## Remaining findings

### Medium
1. **CSP / tunnel surface** (`src/renderer/index.html`, `electron.vite.config.ts`): `connect-src` allows broad `http:`/`https:`/`ws:`; `allowedHosts: true` for Cloudflare tunnels. Tighten for production builds.
2. **PdfViewer lifecycle race** (`PdfViewer.tsx`): effect cleanup only sets `cancelled`; destroy of in-flight doc waits for next load/unmount; cancelled mid-`page.render` can throw noisily.
3. **RightSidebar thumbs** (`RightSidebar.tsx`): destroy in `finally` while a page render may still be resolving — usually caught, can spam console.
4. **Dirty close** (`appStore.closeDoc` / Ctrl+W): closes without unsaved-changes prompt.
5. **readDropped residual**: compromised renderer can still allow+read any absolute path ending in allowed extensions (mitigated vs full FS, not eliminated).
6. **IPC PDF handlers**: little runtime validation of indexes/angles/mime (DoS / throw risk, not RCE with sandbox).
7. **Custom MD parser** (`MarkdownView.tsx`): lossy vs CommonMark; TipTap HTML round-trip can alter content.
8. **PageManageModal** (`PageManageModal.tsx` ~139–145): removed-slot bitmap close loop is a no-op (`existing` ids already absent from `slotsRef`); rely on remap/`releaseSlots` — OK but dead code.

### Low
1. `App.tsx` trailing `void encodeText` dead reference.
2. `browserApi.ts` duplicates pdf-lib ops instead of importing `@shared/pdfOps` (drift risk).
3. No `will-navigate` deny handler (window-open is handled).
4. Keep Electron / pdfjs-dist updated (native PDF parsing attack surface).
5. Signature placement hard-coded bottom-right; no collision/overflow checks.

## Recommended follow-ups (not done)
- Production CSP without tunnel wildcards; disable `allowedHosts: true` outside preview.
- Dirty-document confirm dialog.
- Stronger PDF IPC arg schemas (zod/valibot).
- Destroy PDF proxies immediately in effect cleanup (PdfViewer / RightSidebar).
