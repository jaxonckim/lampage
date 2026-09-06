import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenDoc } from '../types/docs'
import { useAppStore } from '../stores/appStore'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import { sizeForImage } from '../utils/sigSize'
import {
  getLastSignatureId,
  setLastSignatureId,
  setSignatureOrder,
  sortSignaturesByOrder
} from '../utils/sigPrefs'

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
  const setPending = useAppStore((s) => s.setSignaturePending)
  const [sigs, setSigs] = useState<SigItem[]>([])
  const urlsRef = useRef<string[]>([])
  const dragFrom = useRef<number | null>(null)
  const suppressClick = useRef(false)

  const revokeAll = (): void => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u)
    urlsRef.current = []
  }

  const refreshSigs = async (): Promise<void> => {
    const list = await window.api.signatures.list()
    revokeAll()
    const next = sortSignaturesByOrder(list).map((s) => {
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

  const beginPlaceMode = useCallback(
    async (s: SigItem): Promise<void> => {
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
      const aspect =
        natural.w > 0 && natural.h > 0 ? natural.w / natural.h : size.width / size.height

      // Fresh object URL owned by pending (modal list URLs get revoked on refresh)
      const objectUrl = URL.createObjectURL(new Blob([s.data], { type: `image/${s.mime}` }))
      setLastSignatureId(s.id)
      setPending({
        docId: doc.id,
        imageData: s.data.slice(0),
        mime: s.mime,
        objectUrl,
        widthPt: size.width,
        heightPt: size.height,
        aspect
      })
      setOpen(false)
      setStatus('点击 PDF 页面任意位置放置签名，可继续添加多个；完成后点「嵌入」')
    },
    [doc, setOpen, setPending, setStatus]
  )

  /** Alt+S / Option+S: place last-used signature, else first in ordered list. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return
      if (e.key.toLowerCase() !== 's') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      e.stopPropagation()

      void (async () => {
        const list = await window.api.signatures.list()
        const ordered = sortSignaturesByOrder(list)
        if (!ordered.length) {
          setStatus('暂无签名，请先绘制或导入一张签名')
          setOpen(true)
          return
        }
        const lastId = getLastSignatureId()
        const pick = (lastId && ordered.find((s) => s.id === lastId)) || ordered[0]
        const url = URL.createObjectURL(new Blob([pick.data], { type: `image/${pick.mime}` }))
        try {
          await beginPlaceMode({ ...pick, url })
        } finally {
          URL.revokeObjectURL(url)
        }
      })()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [beginPlaceMode, setOpen, setStatus])

  const onListDragStart = (index: number) => (e: React.DragEvent): void => {
    dragFrom.current = index
    suppressClick.current = false
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    ;(e.currentTarget as HTMLElement).classList.add('dragging')
  }

  const onListDragEnd = (e: React.DragEvent): void => {
    ;(e.currentTarget as HTMLElement).classList.remove('dragging')
    dragFrom.current = null
  }

  const onListDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const onListDrop = (toIndex: number) => (e: React.DragEvent): void => {
    e.preventDefault()
    const from = dragFrom.current
    dragFrom.current = null
    if (from == null || from === toIndex) return
    suppressClick.current = true
    setSigs((prev) => {
      if (from < 0 || from >= prev.length || toIndex < 0 || toIndex >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(toIndex, 0, moved)
      setSignatureOrder(next.map((s) => s.id))
      return next
    })
  }

  return (
    <Modal title="签名" open={open} onClose={() => setOpen(false)} wide>
      <p className="modal-hint">
        {disabled
          ? '请打开 PDF 后放置签名。可先绘制或导入签名图片。'
          : '选择签名后进入放置模式：在页面上点击落点，可拖动/缩放调整；支持多个签名，统一点「嵌入」烧录。Alt+S 快速放置上次使用的签名；可拖动下方列表调整顺序。'}
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
      <div className="sig-list" style={{ marginTop: 12 }} onDragOver={onListDragOver}>
        {sigs.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>暂无已保存签名</div>
        )}
        {sigs.map((s, index) => (
          <img
            key={s.id}
            className="sig-list-item"
            src={s.url}
            alt={s.name}
            title={`放置: ${s.name}（可拖动排序）`}
            draggable
            onDragStart={onListDragStart(index)}
            onDragEnd={onListDragEnd}
            onDrop={onListDrop(index)}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              void beginPlaceMode(s)
            }}
          />
        ))}
      </div>
    </Modal>
  )
}
