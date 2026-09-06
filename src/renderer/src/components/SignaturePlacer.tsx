import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../stores/appStore'
import { saveSigSize } from '../utils/sigSize'
import { flattenEmbedSignature } from '../utils/flattenSignature'

interface Props {
  onPdfMutated: (data: ArrayBuffer) => void
}

/** Display scale used by PdfViewer: zoom * 1.25 */
function cssScaleForZoom(zoom: number): number {
  return zoom * 1.25
}

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * Overlay on the target PDF page: drag to move, handles to resize.
 * Geometry is stored in PDF points; screen pixels = points * cssScale (zoom-independent memory).
 */
export default function SignaturePlacer({ onPdfMutated }: Props): JSX.Element | null {
  const placement = useAppStore((s) => s.signaturePlacement)
  const patchPlacement = useAppStore((s) => s.patchSignaturePlacement)
  const setPlacement = useAppStore((s) => s.setSignaturePlacement)
  const setStatus = useAppStore((s) => s.setStatus)
  const docs = useAppStore((s) => s.docs)
  const [busy, setBusy] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const dragRef = useRef<{
    mode: DragMode
    startX: number
    startY: number
    orig: { xPt: number; yTopPt: number; widthPt: number; heightPt: number }
    scale: number
    pageW: number
    pageH: number
  } | null>(null)

  const doc = placement ? docs.find((d) => d.id === placement.docId) : null
  const zoom = doc?.zoom ?? 1
  const scale = cssScaleForZoom(zoom)

  useEffect(() => {
    if (!placement) {
      setHost(null)
      return
    }
    let cancelled = false
    const find = (): void => {
      if (cancelled) return
      const el = document.getElementById(`pdf-page-${placement.docId}-${placement.pageIndex}`)
      setHost(el)
      if (!el) window.setTimeout(find, 120)
    }
    find()
    return () => {
      cancelled = true
    }
  }, [placement?.docId, placement?.pageIndex, doc?.data, doc?.zoom])

  const cancel = useCallback(() => {
    setPlacement(null)
    setStatus('已取消签名放置')
  }, [setPlacement, setStatus])

  const confirm = useCallback(async () => {
    if (!placement || !doc || doc.kind !== 'pdf' || busy) return
    setBusy(true)
    setStatus('正在扁平化嵌入签名…')
    try {
      const pageEl = document.getElementById(`pdf-page-${placement.docId}-${placement.pageIndex}`)
      const pageHpt = pageEl
        ? pageEl.clientHeight / scale
        : placement.yTopPt + placement.heightPt + 72
      const rect = {
        x: placement.xPt,
        y: pageHpt - placement.yTopPt - placement.heightPt,
        width: placement.widthPt,
        height: placement.heightPt
      }
      const data = await flattenEmbedSignature(
        doc.data,
        placement.pageIndex,
        placement.imageData,
        placement.mime,
        rect
      )
      saveSigSize({ width: placement.widthPt, height: placement.heightPt })
      onPdfMutated(data)
      setPlacement(null)
      setStatus(
        `已在第 ${placement.pageIndex + 1} 页扁平化嵌入签名（该页已栅格化，文字不可再选）`
      )
    } catch (err) {
      console.error(err)
      setStatus('签名嵌入失败')
    } finally {
      setBusy(false)
    }
  }, [placement, doc, busy, scale, onPdfMutated, setPlacement, setStatus])

  useEffect(() => {
    if (!placement) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        void confirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placement, cancel, confirm])

  const onPointerDown = (mode: DragMode) => (e: React.PointerEvent): void => {
    if (!placement || !host) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      orig: {
        xPt: placement.xPt,
        yTopPt: placement.yTopPt,
        widthPt: placement.widthPt,
        heightPt: placement.heightPt
      },
      scale,
      pageW: host.clientWidth / scale,
      pageH: host.clientHeight / scale
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d || !placement) return
    const dx = (e.clientX - d.startX) / d.scale
    const dy = (e.clientY - d.startY) / d.scale
    let { xPt, yTopPt, widthPt, heightPt } = d.orig
    const minSize = 12

    if (d.mode === 'move') {
      xPt = d.orig.xPt + dx
      yTopPt = d.orig.yTopPt + dy
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
    xPt = Math.min(Math.max(0, xPt), d.pageW - widthPt)
    yTopPt = Math.min(Math.max(0, yTopPt), d.pageH - heightPt)

    patchPlacement({ xPt, yTopPt, widthPt, heightPt })
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    dragRef.current = null
  }

  if (!placement || !doc || doc.kind !== 'pdf') return null

  const overlay = (
    <div
      className="sig-placer"
      style={{
        position: 'absolute',
        left: placement.xPt * scale,
        top: placement.yTopPt * scale,
        width: placement.widthPt * scale,
        height: placement.heightPt * scale,
        zIndex: 20
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        className="sig-placer-img"
        src={placement.objectUrl}
        alt="签名"
        draggable={false}
        onPointerDown={onPointerDown('move')}
      />
      {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => (
        <div
          key={h}
          className={`sig-placer-handle sig-placer-handle-${h}`}
          onPointerDown={onPointerDown(h)}
        />
      ))}
    </div>
  )

  return (
    <>
      {host ? createPortal(overlay, host) : null}
      <div className="sig-placer-toolbar">
        <span className="sig-placer-hint">
          拖动移动 · 拖动手柄缩放 · 尺寸按 PDF 点记忆（与缩放无关）
        </span>
        <button type="button" className="btn-ghost" disabled={busy} onClick={cancel}>
          取消
        </button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void confirm()}>
          {busy ? '嵌入中…' : '确认嵌入'}
        </button>
      </div>
    </>
  )
}
