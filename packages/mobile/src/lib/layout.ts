import { useEffect, useState } from 'react'

/** iPad-class width: two panes. Narrower (phones, Slide Over) keeps the phone layout. */
export const SPLIT_MIN_WIDTH = 768
const QUERY = `(min-width: ${SPLIT_MIN_WIDTH}px)`

/** Live: follows rotation, Split View and Slide Over resizes. */
export function useSplit(): boolean {
  const [split, setSplit] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const on = (): void => setSplit(mq.matches)
    on()
    mq.addEventListener('change', on)
    window.addEventListener('resize', on)
    return () => {
      mq.removeEventListener('change', on)
      window.removeEventListener('resize', on)
    }
  }, [])
  return split
}
