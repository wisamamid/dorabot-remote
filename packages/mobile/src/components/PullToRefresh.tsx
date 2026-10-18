import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner, cx } from './ui.js'

/** Distance the content must be pulled, in px, to trigger a refresh. */
export const PULL_THRESHOLD = 60
const MAX_PULL = 110

/** Rubber-band: the further you pull, the harder it resists. */
export function pullResistance(dy: number): number {
  if (dy <= 0) return 0
  return Math.min(MAX_PULL, dy * 0.6)
}

/**
 * Pull-to-refresh for a scrolling list, built on touch events so it works in
 * WKWebView (body overscroll is disabled app-wide). Only engages when the list
 * is scrolled to the top and the drag is downward.
 */
export function PullToRefresh({
  onRefresh,
  className,
  children,
  scrollRef,
  onScroll,
}: {
  onRefresh: () => Promise<unknown>
  className?: string
  children: ReactNode
  scrollRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
}): ReactNode {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const pullRef = useRef(0)
  const busy = useRef(false)
  const refreshFn = useRef(onRefresh)
  refreshFn.current = onRefresh

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    let startY: number | null = null

    const set = (v: number): void => {
      pullRef.current = v
      setPull(v)
    }
    const onStart = (e: TouchEvent): void => {
      if (busy.current || el.scrollTop > 0) {
        startY = null
        return
      }
      startY = e.touches[0]?.clientY ?? null
    }
    const onMove = (e: TouchEvent): void => {
      if (startY === null) return
      const dy = (e.touches[0]?.clientY ?? startY) - startY
      if (dy <= 0 || el.scrollTop > 0) {
        if (pullRef.current) set(0)
        return
      }
      if (e.cancelable) e.preventDefault()
      set(pullResistance(dy))
    }
    const onEnd = (): void => {
      if (startY === null) return
      startY = null
      const done = pullRef.current >= PULL_THRESHOLD
      if (!done) {
        set(0)
        return
      }
      busy.current = true
      setRefreshing(true)
      set(PULL_THRESHOLD * 0.75)
      void Promise.resolve(refreshFn.current())
        .catch(() => {})
        .finally(() => {
          busy.current = false
          setRefreshing(false)
          set(0)
        })
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  const dragging = pull > 0 && !refreshing
  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div
        aria-hidden={!pull}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
        style={{ height: pull, opacity: Math.min(1, pull / PULL_THRESHOLD) }}
      >
        <div className="flex items-center self-center">
          {refreshing ? (
            <Spinner className="size-5" />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="size-5 text-ink-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ transform: `rotate(${pull >= PULL_THRESHOLD ? 180 : 0}deg)`, transition: 'transform 150ms' }}
            >
              <path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      </div>
      <div
        ref={(node) => {
          innerRef.current = node
          if (scrollRef) scrollRef.current = node
        }}
        onScroll={onScroll}
        className={cx('scroll h-full min-h-0', className)}
        style={{ transform: `translateY(${pull}px)`, transition: dragging ? 'none' : 'transform 200ms ease-out' }}
      >
        {children}
      </div>
    </div>
  )
}
