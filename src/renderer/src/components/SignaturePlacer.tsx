import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../stores/appStore'
import { saveSigSize } from '../utils/sigSize'
import { flattenEmbedSignatures } from '../utils/flattenSignature'

interface Props {
  onPdfMutated: (data: ArrayBuffer) => void
}

/** Display scale used by PdfViewer: zoom * 1.25 */
function cssScaleForZoom(zoom: number): number {
  return zoom * 1.25
}

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * Place mode (click to drop) + multi-overlay drag/resize + single 嵌入 to burn all.
 * Geometry in PDF points; screen = points * cssScale (zoom-independent memory).
 */
export default function SignaturePlacer({ onPdfMutated }: Props): JSX.Element | null {
  const pending = useAppStore((s) => s.signaturePending)
  const overlays = useAppStore((s) => s.signatureOverlays)
  const selectedId = useAppStore((s) => s.signatureSelectedId)
  const setPending = useAppStore((s) => s.setSignaturePending)
  const addOverlay = useAppStore((s) => s.addSignatureOverlay)
  const updateOverlay = useAppStore((s) => s.updateSignatureOverlay)
  const removeOverlay = useAppStore((s) => s.removeSignatureOverlay)
  const clearOverlays = useAppStore((s) => s.clearSignatureOverlays)
  const setSelectedId = useAppStore((s) => s.setSignatureSelectedId)
  const setStatus = useAppStore((s) => s.setStatus)
  const docs = useAppStore((s) => s.docs)
  const [busy, setBusy] = useState(false)
  const [hosts, setHosts] = useState<Record<string, HTMLElement | null>>({})
  /** Screen coords for place-mode ghost preview (follows pointer). */
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{
    id: string
    mode: DragMode
    startX: number
    startY: number
    shift: boolean
    orig: { xPt: number; yTopPt: number; widthPt: number; heightPt: number }
    aspect: number
    scale: number
    pageW: number
    pageH: number
  } | null>(null)

  const doc =
    docs.find((d) => d.id === (pending?.docId ?? overlays[0]?.docId)) ??
    docs.find((d) => d.id === useAppStore.getState().activeId) ??
    null

  const relevantOverlays = overlays.filter((o) => !doc || o.docId === doc.id)
  const zoom = doc?.zoom ?? 1
  const scale = cssScaleForZoom(zoom)

  // Resolve page host elements for each overlay page + pending doc pages as needed
  useEffect(() => {
    if (!doc || doc.kind !== 'pdf') {
      setHosts({})
      return
    }
    let cancelled = false
    const pagesNeeded = new Set<number>()
    for (const o of relevantOverlays) pagesNeeded.add(o.pageIndex)
    // Also try current page so place-mode click target exists
    pagesNeeded.add(doc.currentPage)

    const find = (): void => {
      if (cancelled) return
      const next: Record<string, HTMLElement | null> = {}
      let missing = false
      for (const pi of pagesNeeded) {
        const key = `${doc.id}-${pi}`
        const el = document.getElementById(`pdf-page-${doc.id}-${pi}`)
        next[key] = el
        if (!el) missing = true
      }
      setHosts(next)
      if (missing) window.setTimeout(find, 120)
    }
    find()
    return () => {
      cancelled = true
    }
  }, [doc?.id, doc?.data, doc?.zoom, doc?.currentPage, relevantOverlays.map((o) => `${o.id}:${o.pageIndex}`).join('|')])

  // Place mode: click anywhere on a PDF page to drop
  useEffect(() => {
    if (!pending || !doc || doc.kind !== 'pdf') return

    const onClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t) return
      // Ignore placer chrome / toolbar
      if (t.closest('.sig-placer') || t.closest('.sig-placer-toolbar')) return
      const pageEl = t.closest('.pdf-page-wrap') as HTMLElement | null
      if (!pageEl) return
      const idMatch = /^pdf-page-(.+)-(\d+)$/.exec(pageEl.id)
      if (!idMatch || idMatch[1] !== pending.docId) return

      e.preventDefault()
      e.stopPropagation()

      const pageIndex = Number(idMatch[2])
      const rect = pageEl.getBoundingClientRect()
      const cssScale = cssScaleForZoom(doc.zoom)
      // clientWidth is layout (pre-transform); getBoundingClientRect is visual — use fraction
      const pageW = pageEl.clientWidth / cssScale
      const pageH = pageEl.clientHeight / cssScale
      const clickX = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * pageW : 0
      const clickY = rect.height > 0 ? ((e.clientY - rect.top) / rect.height) * pageH : 0

      let widthPt = Math.min(pending.widthPt, pageW * 0.95)
      let heightPt = Math.min(pending.heightPt, pageH * 0.95)
      // Keep aspect if we had to clamp
      if (pending.aspect > 0) {
        const byW = widthPt / pending.aspect
        if (byW <= pageH * 0.95) heightPt = byW
        else {
          heightPt = pageH * 0.95
          widthPt = heightPt * pending.aspect
        }
      }

      // Center signature on click point
      let xPt = clickX - widthPt / 2
      let yTopPt = clickY - heightPt / 2
      xPt = Math.min(Math.max(0, xPt), Math.max(0, pageW - widthPt))
      yTopPt = Math.min(Math.max(0, yTopPt), Math.max(0, pageH - heightPt))

      // objectUrl ownership transfers to the overlay; addOverlay clears pending without revoke
      addOverlay({
        docId: pending.docId,
        pageIndex,
        imageData: pending.imageData,
        mime: pending.mime,
        objectUrl: pending.objectUrl,
        xPt,
        yTopPt,
        widthPt,
        heightPt,
        aspect: pending.aspect
      })
      saveSigSize({ width: widthPt, height: heightPt })
      setStatus(
        `已放置签名（第 ${pageIndex + 1} 页）。可继续添加，或拖动调整后点「嵌入」`
      )
    }

    const onMove = (e: MouseEvent): void => {
      setCursorPos({ x: e.clientX, y: e.clientY })
    }

    document.addEventListener('click', onClick, true)
    document.addEventListener('mousemove', onMove, true)
    document.body.classList.add('sig-place-mode')
    setCursorPos(null)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('mousemove', onMove, true)
      document.body.classList.remove('sig-place-mode')
      setCursorPos(null)
    }
  }, [pending, doc, addOverlay, setStatus])

  const cancelAll = useCallback(() => {
    if (doc) clearOverlays(doc.id)
    else clearOverlays()
    setPending(null)
    setStatus('已取消签名放置')
  }, [doc, clearOverlays, setPending, setStatus])

  const deleteSelected = useCallback(() => {
    const id = useAppStore.getState().signatureSelectedId
    if (!id) {
      setStatus('请先点击选中要删除的签名')
      return
    }
    removeOverlay(id)
    setStatus('已移除签名')
  }, [removeOverlay, setStatus])

  const confirmEmbed = useCallback(async () => {
    if (!doc || doc.kind !== 'pdf' || busy) return
    const list = useAppStore.getState().signatureOverlays.filter((o) => o.docId === doc.id)
    if (!list.length) {
      setStatus('请先放置至少一个签名')
      return
    }
    setBusy(true)
    setStatus(`正在嵌入 ${list.length} 个签名…`)
    try {
      const items = list.map((o) => {
        const pageEl = document.getElementById(`pdf-page-${o.docId}-${o.pageIndex}`)
        const pageHpt = pageEl
          ? pageEl.clientHeight / cssScaleForZoom(doc.zoom)
          : o.yTopPt + o.heightPt + 72
        return {
          pageIndex: o.pageIndex,
          imageData: o.imageData,
          mime: o.mime,
          rect: {
            x: o.xPt,
            y: pageHpt - o.yTopPt - o.heightPt,
            width: o.widthPt,
            height: o.heightPt
          }
        }
      })
      const data = await flattenEmbedSignatures(doc.data, items)
      const last = list[list.length - 1]
      saveSigSize({ width: last.widthPt, height: last.heightPt })
      clearOverlays(doc.id)
      onPdfMutated(data)
      const pages = Array.from(new Set(list.map((o) => o.pageIndex + 1))).join('、')
      setStatus(
        `已嵌入 ${list.length} 个签名（第 ${pages} 页已高清栅格化，该页文字不可再选）`
      )
    } catch (err) {
      console.error(err)
      setStatus('签名嵌入失败')
    } finally {
      setBusy(false)
    }
  }, [doc, busy, clearOverlays, onPdfMutated, setStatus])

  useEffect(() => {
    if (!pending && !relevantOverlays.length) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pending) {
          setPending(null)
          setStatus('已取消放置模式')
        } else {
          cancelAll()
        }
      } else if (e.key === 'Enter' && !e.isComposing && relevantOverlays.length) {
        e.preventDefault()
        void confirmEmbed()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    pending,
    relevantOverlays.length,
    selectedId,
    cancelAll,
    confirmEmbed,
    deleteSelected,
    setPending,
    setStatus
  ])

  const onPointerDown =
    (id: string, mode: DragMode) =>
    (e: React.PointerEvent): void => {
      const o = relevantOverlays.find((x) => x.id === id)
      if (!o || !doc) return
      e.preventDefault()
      e.stopPropagation()
      setSelectedId(id)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      const host = document.getElementById(`pdf-page-${o.docId}-${o.pageIndex}`)
      const sc = cssScaleForZoom(doc.zoom)
      dragRef.current = {
        id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        shift: e.shiftKey,
        orig: {
          xPt: o.xPt,
          yTopPt: o.yTopPt,
          widthPt: o.widthPt,
          heightPt: o.heightPt
        },
        aspect: o.aspect > 0 ? o.aspect : o.widthPt / Math.max(1e-6, o.heightPt),
        scale: sc,
        pageW: host ? host.clientWidth / sc : 595,
        pageH: host ? host.clientHeight / sc : 842
      }
    }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const dx = (e.clientX - d.startX) / d.scale
    const dy = (e.clientY - d.startY) / d.scale
    let { xPt, yTopPt, widthPt, heightPt } = d.orig
    const minSize = 12
    const lock = e.shiftKey || d.shift
    const aspect = d.aspect

    if (d.mode === 'move') {
      xPt = d.orig.xPt + dx
      yTopPt = d.orig.yTopPt + dy
    } else if (lock && aspect > 0) {
      // Shift+resize: lock original aspect (width/height = aspect)
      if (d.mode === 'e' || d.mode === 'w') {
        const nextW =
          d.mode === 'e'
            ? Math.max(minSize, d.orig.widthPt + dx)
            : Math.max(minSize, d.orig.widthPt - dx)
        widthPt = nextW
        heightPt = nextW / aspect
        if (d.mode === 'w') xPt = d.orig.xPt + (d.orig.widthPt - widthPt)
        yTopPt = d.orig.yTopPt + (d.orig.heightPt - heightPt) / 2
      } else if (d.mode === 'n' || d.mode === 's') {
        const nextH =
          d.mode === 's'
            ? Math.max(minSize, d.orig.heightPt + dy)
            : Math.max(minSize, d.orig.heightPt - dy)
        heightPt = nextH
        widthPt = nextH * aspect
        xPt = d.orig.xPt + (d.orig.widthPt - widthPt) / 2
        if (d.mode === 'n') yTopPt = d.orig.yTopPt + (d.orig.heightPt - heightPt)
      } else {
        // Corners: drive from the dominant delta
        const fromW = d.mode.includes('e')
          ? d.orig.widthPt + dx
          : d.orig.widthPt - dx
        const fromH = d.mode.includes('s')
          ? d.orig.heightPt + dy
          : d.orig.heightPt - dy
        if (Math.abs(dx) * aspect >= Math.abs(dy)) {
          widthPt = Math.max(minSize, fromW)
          heightPt = widthPt / aspect
        } else {
          heightPt = Math.max(minSize, fromH)
          widthPt = heightPt * aspect
        }
        if (d.mode.includes('w')) xPt = d.orig.xPt + (d.orig.widthPt - widthPt)
        if (d.mode.includes('n')) yTopPt = d.orig.yTopPt + (d.orig.heightPt - heightPt)
      }
    } else {
      if (d.mode.includes('e')) widthPt = Math.max(minSize, d.orig.widthPt + dx)
      if (d.mode.includes('s')) heightPt = Math.max(minSize, d.orig.heightPt + dy)
      if (d.mode.includes('w')) {
        const nextW = Math.max(minSize, d.orig.widthPt - dx)
        xPt = d.orig.xPt + (d.orig.widthPt - nextW)
        widthPt = nextW
      }
      if (d.mode.includes('n')) {
        const nextH = Math.max(minSize, d.orig.heightPt - dy)
        yTopPt = d.orig.yTopPt + (d.orig.heightPt - nextH)
        heightPt = nextH
      }
    }

    widthPt = Math.min(widthPt, d.pageW)
    heightPt = Math.min(heightPt, d.pageH)
    if (lock && aspect > 0) {
      // Re-clamp preserving aspect if we hit a page edge
      if (widthPt / aspect > d.pageH) {
        heightPt = d.pageH
        widthPt = heightPt * aspect
      } else {
        heightPt = widthPt / aspect
      }
    }
    xPt = Math.min(Math.max(0, xPt), d.pageW - widthPt)
    yTopPt = Math.min(Math.max(0, yTopPt), d.pageH - heightPt)

    updateOverlay(d.id, { xPt, yTopPt, widthPt, heightPt })
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    const id = dragRef.current.id
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    dragRef.current = null
    const o = useAppStore.getState().signatureOverlays.find((x) => x.id === id)
    if (o) saveSigSize({ width: o.widthPt, height: o.heightPt })
  }

  const showUi = Boolean(pending || relevantOverlays.length)
  if (!showUi || !doc || doc.kind !== 'pdf') return null

  const portals = relevantOverlays.map((o) => {
    const host = hosts[`${o.docId}-${o.pageIndex}`]
    if (!host) return null
    const selected = o.id === selectedId
    const overlay = (
      <div
        key={o.id}
        className={`sig-placer${selected ? ' selected' : ''}`}
        style={{
          position: 'absolute',
          left: o.xPt * scale,
          top: o.yTopPt * scale,
          width: o.widthPt * scale,
          height: o.heightPt * scale,
          zIndex: selected ? 22 : 20
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => {
          e.stopPropagation()
          setSelectedId(o.id)
        }}
      >
        <img
          className="sig-placer-img"
          src={o.objectUrl}
          alt="签名"
          draggable={false}
          onPointerDown={onPointerDown(o.id, 'move')}
        />
        {selected &&
          (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => (
            <div
              key={h}
              className={`sig-placer-handle sig-placer-handle-${h}`}
              onPointerDown={onPointerDown(o.id, h)}
            />
          ))}
        {selected && (
          <button
            type="button"
            className="sig-placer-delete"
            title="删除此签名 (Del)"
            aria-label="删除此签名"
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              deleteSelected()
            }}
          >
            ×
          </button>
        )}
      </div>
    )
    return createPortal(overlay, host)
  })

  const ghostW = pending ? pending.widthPt * scale : 0
  const ghostH = pending ? pending.heightPt * scale : 0

  return (
    <>
      {portals}
      {pending && cursorPos && (
        <div
          className="sig-place-ghost"
          style={{
            left: cursorPos.x - ghostW / 2,
            top: cursorPos.y - ghostH / 2,
            width: ghostW,
            height: ghostH
          }}
          aria-hidden
        >
          <img src={pending.objectUrl} alt="" draggable={false} />
        </div>
      )}
      <div className="sig-placer-toolbar">
        <span className="sig-placer-hint">
          {pending
            ? '移动鼠标预览 · 点击页面放置 · Esc 取消放置'
            : `已放置 ${relevantOverlays.length} 个 · 拖动移动 · 手柄缩放 · Shift 锁定比例 · 选中后 Del/删除`}
        </span>
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || !selectedId}
          onClick={deleteSelected}
          title="删除选中的签名 (Del / Backspace)"
        >
          删除
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={cancelAll}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !relevantOverlays.length}
          onClick={() => void confirmEmbed()}
        >
          {busy ? '嵌入中…' : '嵌入'}
        </button>
      </div>
    </>
  )
}
