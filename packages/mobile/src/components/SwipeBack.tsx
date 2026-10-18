import { useEffect, useRef, type ReactNode } from 'react'

/** A touch must start this close to the left edge to begin a back swipe. */
export const EDGE_PX = 24
const COMMIT_FRACTION = 0.35
const FLICK_PX_PER_MS = 0.5
const LOCK_PX = 10

/** Complete past ~35% of the width, or on a fast rightward flick. */
export function shouldComplete(offset: number, width: number, velocity: number): boolean {
  if (width <= 0) return false
  return offset > width * COMMIT_FRACTION || (velocity > FLICK_PX_PER_MS && offset > 20)
}

/** Which way a gesture is going once it has moved enough to tell. */
export function lockDirection(dx: number, dy: number): 'back' | 'other' | 'undecided' {
  if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return 'undecided'
  return dx > 0 && Math.abs(dx) > Math.abs(dy) ? 'back' : 'other'
}

/** True when an element, or an ancestor up to `stop`, scrolls sideways and is not at its left end. */
function scrolledSideways(el: Element | null, stop: Element): boolean {
  for (let n = el; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth && n.scrollLeft > 0) return true
  }
  return false
}

/**
 * iOS-style interactive back: drag from the left edge and the screen follows the
 * finger; release past a third of the width (or flick) to go back, else it
 * springs home. Touch events only, so it works in WKWebView without a library.
 */
export function SwipeBack({ onBack, children }: { onBack: () => void; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const backRef = useRef(onBack)
  backRef.current = onBack

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let sx = 0
    let sy = 0
    let phase: 'idle' | 'candidate' | 'dragging' = 'idle'
    let offset = 0
    let lastX = 0
    let lastT = 0
    let velocity = 0

    const apply = (x: number, animate: boolean): void => {
      el.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      el.style.transform = x ? `translateX(${x}px)` : ''
      el.style.boxShadow = x ? '-8px 0 24px rgba(0,0,0,0.45)' : ''
    }

    const start = (e: TouchEvent): void => {
      const t = e.touches[0]
      if (!t || e.touches.length !== 1 || t.clientX > EDGE_PX) {
        phase = 'idle'
        return
      }
      if (scrolledSideways(e.target as Element, el)) {
        phase = 'idle'
        return
      }
      sx = lastX = t.clientX
      sy = t.clientY
      lastT = e.timeStamp
      velocity = 0
      offset = 0
      phase = 'candidate'
    }
    const move = (e: TouchEvent): void => {
      if (phase === 'idle') return
      const t = e.touches[0]
      if (!t) return
      const dx = t.clientX - sx
      const dy = t.clientY - sy
      if (phase === 'candidate') {
        const dir = lockDirection(dx, dy)
        if (dir === 'undecided') return
        if (dir === 'other') {
          phase = 'idle'
          return
        }
        phase = 'dragging'
      }
      if (e.cancelable) e.preventDefault()
      offset = Math.max(0, dx)
      const dt = e.timeStamp - lastT
      if (dt > 0) velocity = (t.clientX - lastX) / dt
      lastX = t.clientX
      lastT = e.timeStamp
      apply(offset, false)
    }
    const end = (): void => {
      const was = phase
      phase = 'idle'
      if (was !== 'dragging') return
      const width = el.clientWidth
      if (shouldComplete(offset, width, velocity)) {
        apply(width, true)
        window.setTimeout(() => {
          backRef.current()
          // If the screen stays mounted (a parent folder, say), put it back.
          apply(0, false)
        }, 200)
      } else {
        apply(0, true)
      }
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [])

  return (
    <div ref={ref} className="h-full min-h-0 bg-ink-900">
      {children}
    </div>
  )
}
