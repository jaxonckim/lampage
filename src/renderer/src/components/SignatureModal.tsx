import { useEffect, useRef, useState } from 'react'
import type { OpenDoc } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import SignaturePad from './SignaturePad'
import Modal from './Modal'

interface Props {
  doc: OpenDoc | null
  onPdfMutated: (data: ArrayBuffer) => void
}

type SigItem = { id: string; name: string; mime: 'png' | 'jpg'; data: ArrayBuffer; url: string }

export default function SignatureModal({ doc, onPdfMutated }: Props): JSX.Element {
  const open = useAppStore((s) => s.signatureOpen)
  const setOpen = useAppStore((s) => s.setSignatureOpen)
  const setStatus = useAppStore((s) => s.setStatus)
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

  return (
    <Modal title="签名" open={open} onClose={() => setOpen(false)} wide>
      <p className="modal-hint">
        {disabled
          ? '请打开 PDF 后放置签名。可先绘制或导入签名图片。'
          : `点击已保存签名，将放置到第 ${(doc?.currentPage ?? 0) + 1} 页右下角。`}
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
            title={`点击放置: ${s.name}`}
            onClick={async () => {
              if (!doc || doc.kind !== 'pdf') {
                setStatus('请先打开 PDF')
                return
              }
              const page = doc.currentPage
              const data = await window.api.pdf.embedSignature(doc.data, page, s.data, s.mime, {
                x: 360,
                y: 72,
                width: 160,
                height: 60
              })
              onPdfMutated(data)
              setStatus(`已在第 ${page + 1} 页放置签名`)
              setOpen(false)
            }}
          />
        ))}
      </div>
    </Modal>
  )
}
