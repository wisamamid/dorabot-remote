import { SCOPE_LABELS, type Scope } from '@dorabot-remote/protocol'
import { useCallback, useState } from 'react'
import { useConnection } from './connection.js'
import { haptic } from './platform.js'

/** Scopes asked for this session, so a locked screen survives a tab switch still saying "waiting". */
const asked = new Set<Scope>()

/**
 * Ask the Mac for a permission. A device can only ask; a human grants it on the
 * Mac (control page or `dorabot-remote grant`). The connection layer flips
 * `hasScope` live when the grant lands, so nothing here needs to poll.
 */
export function useScopeRequest(scope: Scope): {
  requested: boolean
  busy: boolean
  error: string | null
  request: () => Promise<void>
} {
  const conn = useConnection()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState(0)

  const request = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await conn.rpc('remote.requestScope', { scope, reason: `Enable ${SCOPE_LABELS[scope]} on the phone` })
      asked.add(scope)
      force((n) => n + 1)
      await haptic('medium')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [conn, scope])

  return { requested: asked.has(scope) && !conn.hasScope(scope), busy, error, request }
}
