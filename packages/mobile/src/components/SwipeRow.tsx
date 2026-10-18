import { useEffect, useRef, useState, type ReactNode } from 'react'

const ACTION_PX = 88
const LONG_PRESS_MS = 500
const SLOP = 8

/**
 * A list row with an iOS-style swipe-left action and a long-press hook. Touch only,
 * so a trackpad or mouse just gets the plain row. The row's own click is swallowed
 * after a long press or swipe so it does not also open the session.
 */
export function SwipeRow({
  actionLabel,
  onAction,
  onLongPress,
  children,
}: {
  actionLabel: string
  onAction: () => void
  onLongPress: () => void
  children: ReactNode
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const longRef = useRef(onLongPress)
  longRef.current = onLongPress

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let sx = 0
    let sy = 0
    let base = 0
    let mode: 'idle' | 'pending' | 'swipe' | 'scroll' = 'idle'
    let timer = 0
    let swallow = false
    const set = (x: number, animate: boolean): void => {
      el.style.transition = animate ? 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      el.style.transform = x ? `translateX(${x}px)` : ''
    }
    const close = (): void => {
      openRef.current = false
      setOpen(false)
      set(0, true)
    }
    const start = (e: TouchEvent): void => {
      const t = e.touches[0]
      if (!t || e.touches.length !== 1) return
      sx = t.clientX
      sy = t.clientY
      base = openRef.current ? -ACTION_PX : 0
      mode = 'pending'
      swallow = false
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (mode !== 'pending') return
        mode = 'idle'
        swallow = true
        longRef.current()
      }, LONG_PRESS_MS)
    }
    const move = (e: TouchEvent): void => {
      const t = e.touches[0]
      if (!t || mode === 'idle' || mode === 'scroll') return
      const dx = t.clientX - sx
      const dy = t.clientY - sy
      if (mode === 'pending') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        window.clearTimeout(timer)
        if (Math.abs(dx) > Math.abs(dy)) mode = 'swipe'
        else {
          mode = 'scroll'
          return
        }
      }
      if (e.cancelable) e.preventDefault()
      set(Math.max(-ACTION_PX * 1.4, Math.min(0, base + dx)), false)
    }
    const end = (e: TouchEvent): void => {
      window.clearTimeout(timer)
      const was = mode
      mode = 'idle'
      if (was !== 'swipe') return
      swallow = true
      const x = (e.changedTouches[0]?.clientX ?? sx) - sx + base
      if (x < -ACTION_PX / 2) {
        openRef.current = true
        setOpen(true)
        set(-ACTION_PX, true)
      } else close()
    }
    const click = (e: MouseEvent): void => {
      if (swallow) {
        e.stopPropagation()
        e.preventDefault()
        swallow = false
      } else if (openRef.current) {
        e.stopPropagation()
        e.preventDefault()
        close()
      }
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    el.addEventListener('click', click, true)
    return () => {
      window.clearTimeout(timer)
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      el.removeEventListener('click', click, true)
    }
  }, [])

  return (
    <div className="relative overflow-hidden rounded-card">
      <div className="absolute inset-y-0 right-0 flex" style={{ width: ACTION_PX }} aria-hidden={!open}>
        <button
          tabIndex={open ? 0 : -1}
          onClick={() => {
            onAction()
            openRef.current = false
            setOpen(false)
            if (ref.current) {
              ref.current.style.transition = 'transform 200ms'
              ref.current.style.transform = ''
            }
          }}
          className="flex-1 bg-mint-600 text-[14px] font-semibold text-ink-950"
        >
          {actionLabel}
        </button>
      </div>
      <div ref={ref} className="relative bg-ink-900">
        {children}
      </div>
    </div>
  )
}
