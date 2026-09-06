import { useEffect, useRef, useState } from 'react'

interface Props {
  onSaved: () => void
}

/** Handwritten pad: transparent ink on clear canvas (PNG, no white fill). */
export default function SignaturePad({ onSaved }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [name, setName] = useState('我的签名')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 2.25
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
      y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height
    }
  }

  const clear = (): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const save = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas) return
    // PNG preserves alpha — no white backdrop
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!blob) return
    const buf = await blob.arrayBuffer()
    await window.api.signatures.save({ name, data: buf, mime: 'png' })
    onSaved()
  }

  return (
    <div className="sig-panel">
      <div style={{ fontSize: 12, color: '#6b7280' }}>手写签名（透明背景）</div>
      <canvas
        ref={canvasRef}
        className="sig-pad sig-pad-transparent"
        width={560}
        height={240}
        style={{ width: '100%', height: 120 }}
        onPointerDown={(e) => {
          drawing.current = true
          const ctx = e.currentTarget.getContext('2d')!
          const p = pos(e)
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          const ctx = e.currentTarget.getContext('2d')!
          const p = pos(e)
          ctx.lineTo(p.x, p.y)
          ctx.stroke()
        }}
        onPointerUp={() => {
          drawing.current = false
        }}
      />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="签名名称" />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn-ghost" onClick={clear}>
          清除
        </button>
        <button type="button" className="btn-primary" onClick={() => void save()}>
          保存签名
        </button>
      </div>
    </div>
  )
}
