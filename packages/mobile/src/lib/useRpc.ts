import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnection } from './connection.js'

/**
 * Load one RPC result and keep it fresh across reconnects.
 *
 * Deliberately small: the screens here are lists and detail views over a handful
 * of gateway methods, not a cache. `reload` is what a pull or a mutation calls.
 */
export function useRpc<T>(
  method: string,
  params?: unknown,
  opts: { enabled?: boolean } = {},
): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const conn = useConnection()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const key = JSON.stringify(params ?? null)
  const enabled = opts.enabled !== false && conn.state === 'ready'

  const reload = useCallback(async () => {
    if (!enabled) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const res = await conn.rpc<T>(method, params)
      if (mine !== seq.current) return
      setData(res)
      setError(null)
    } catch (err) {
      if (mine === seq.current) setError((err as Error).message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
    // `key` stands in for params so an inline object does not refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, method, key, conn.rpc])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload }
}

/**
 * Re-run `reload` when the gateway says the underlying data changed. The gateway
 * broadcasts `projects.update` for task and project edits (from the agent or the
 * desktop app) and `research.update` for research; listening keeps a list honest
 * without polling. Coalesced so a burst of updates costs one refetch.
 */
export function useReloadOnEvents(events: string[], reload: () => Promise<void>): void {
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const names = events.join('|')
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const set = new Set(names.split('|'))
    const on = (e: Event): void => {
      const { event } = (e as CustomEvent<{ event: string }>).detail
      if (!set.has(event)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void reloadRef.current(), 300)
    }
    window.addEventListener('dorabot:event', on)
    return () => {
      window.removeEventListener('dorabot:event', on)
      if (timer) clearTimeout(timer)
    }
  }, [names])
}
