import { useEffect, useRef, useState } from 'react'
import type { OpenDoc } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import { sizeForImage } from '../utils/sigSize'

interface Props {
  doc: OpenDoc | null
}

type SigItem = { id: string; name: string; mime: 'png' | 'jpg'; data: ArrayBuffer; url: string }

function loadImageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 160, h: img.naturalHeight || 60 })
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

export default function SignatureModal({ doc }: Props): JSX.Element {
  const open = useAppStore((s) => s.signatureOpen)
  const setOpen = useAppStore((s) => s.setSignatureOpen)
  const setStatus = useAppStore((s) => s.setStatus)
  const setPlacement = useAppStore((s) => s.setSignaturePlacement)
  const [sigs, setSigs] = useState<SigItem[]>([])
  const urlsRef = useRef<string[]>([])

  const revokeAll = (): void => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u)
    urlsRef.current = []
  }

  const refreshSigs = async (): Promise<void> => {
    const list = await window.api.signatures.list()
    revokeAll()
    const next = list.map((s) => {
      const url = URL.createObjectURL(new Blob([s.data], { type: `image/${s.mime}` }))
      urlsRef.current.push(url)
      return { ...s, url }
    })
    setSigs(next)
  }

  useEffect(() => {
    if (open) void refreshSigs()
  }, [open])

  useEffect(() => {
    return () => revokeAll()
  }, [])

  const disabled = !doc || doc.kind !== 'pdf'

  const beginPlace = async (s: SigItem): Promise<void> => {
    if (!doc || doc.kind !== 'pdf') {
      setStatus('请先打开 PDF')
      return
    }
    let natural = { w: 160, h: 60 }
    try {
      natural = await loadImageSize(s.url)
    } catch {
      /* use defaults */
    }
    const size = sizeForImage(natural.w, natural.h)
    const pageIndex = doc.currentPage
    const scale = doc.zoom * 1.25
    const pageEl = document.getElementById(`pdf-page-${doc.id}-${pageIndex}`)
    const pageW = pageEl ? pageEl.clientWidth / scale : 595
    const pageH = pageEl ? pageEl.clientHeight / scale : 842
    const widthPt = Math.min(size.width, pageW * 0.9)
    const heightPt = Math.min(size.height, pageH * 0.9)
    // Default: lower-right-ish, but freely movable afterwards
    const xPt = Math.max(0, pageW - widthPt - 36)
    const yTopPt = Math.max(0, pageH - heightPt - 36)

    // Fresh object URL owned by placement (modal list URLs get revoked on refresh)
    const objectUrl = URL.createObjectURL(new Blob([s.data], { type: `image/${s.mime}` }))
    setPlacement({
      docId: doc.id,
      pageIndex,
      imageData: s.data.slice(0),
      mime: s.mime,
      objectUrl,
      xPt,
      yTopPt,
      widthPt,
      heightPt
    })
    setOpen(false)
    setStatus(`在第 ${pageIndex + 1} 页调整签名位置与大小，然后确认嵌入`)
  }

  return (
    <Modal title="签名" open={open} onClose={() => setOpen(false)} wide>
      <p className="modal-hint">
        {disabled
          ? '请打开 PDF 后放置签名。可先绘制或导入签名图片。'
          : `选择签名后，在第 ${(doc?.currentPage ?? 0) + 1} 页自由拖放并调整大小，确认后扁平化嵌入（该页将栅格化）。`}
      </p>
      <SignaturePad onSaved={refreshSigs} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            const img = await window.api.openImages()
            if (!img) return
            await window.api.signatures.save({
              name: img.name,
              data: img.data,
              mime: img.mime
            })
            void refreshSigs()
          }}
        >
          导入图片签名
        </button>
      </div>
      <div className="sig-list" style={{ marginTop: 12 }}>
        {sigs.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>暂无已保存签名</div>
        )}
        {sigs.map((s) => (
          <img
            key={s.id}
            src={s.url}
            alt={s.name}
            title={`放置: ${s.name}`}
            onClick={() => void beginPlace(s)}
          />
        ))}
      </div>
    </Modal>
  )
}
