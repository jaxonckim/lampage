import { useCallback, useRef } from 'react'

interface Props {
  onDrag: (deltaX: number) => void
  reverse?: boolean
}

export default function Splitter({ onDrag, reverse }: Props): JSX.Element {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    lastX.current = e.clientX
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.classList.add('active')
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const dx = e.clientX - lastX.current
      lastX.current = e.clientX
      onDrag(reverse ? -dx : dx)
    },
    [onDrag, reverse]
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    e.currentTarget.classList.remove('active')
  }, [])

  return (
    <div
      className="splitter"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}
