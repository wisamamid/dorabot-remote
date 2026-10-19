/**
 * What to do with a notification tap or action button. Pure routing plus the
 * approve/deny flow, with every side effect injected so it can be tested.
 */
export interface PushNav {
  rid?: string
  kind?: string
  /** 'tap' for the default tap, else the UNNotificationAction identifier. */
  actionId?: string
  /** Learned by decrypting `enc`. */
  sessionKey?: string
}

export type PushRoute =
  | { type: 'decide'; decision: 'approve' | 'deny'; rid: string; sessionKey?: string }
  | { type: 'open'; rid?: string; sessionKey?: string }

export function routePushAction(nav: PushNav): PushRoute {
  const open: PushRoute = { type: 'open', ...(nav.rid ? { rid: nav.rid } : {}), ...(nav.sessionKey ? { sessionKey: nav.sessionKey } : {}) }
  // Only an approval notification can be approved or denied from a button; anything else just opens.
  if (nav.rid && nav.kind === 'approval' && (nav.actionId === 'APPROVE' || nav.actionId === 'DENY')) {
    return { type: 'decide', decision: nav.actionId === 'APPROVE' ? 'approve' : 'deny', rid: nav.rid, ...(nav.sessionKey ? { sessionKey: nav.sessionKey } : {}) }
  }
  return open
}

export type DecisionOutcome =
  | { status: 'done'; decision: 'approve' | 'deny'; message: string }
  | { status: 'already_resolved'; message: string }
  | { status: 'cancelled'; message: string }
  | { status: 'failed'; message: string }

export const DENY_REASON = 'Denied from notification'
const ALREADY_GONE = /no pending|already (answered|timeout|cancelled|resolved)|not found/i

export interface DecisionDeps {
  /** Face ID / passcode. 'unavailable' (no biometrics and no passcode) is allowed: the OS already required an unlocked phone. */
  verify: () => Promise<'ok' | 'cancelled' | 'unavailable' | 'failed'>
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export async function runDecision(route: Extract<PushRoute, { type: 'decide' }>, deps: DecisionDeps): Promise<DecisionOutcome> {
  const verdict = await deps.verify()
  if (verdict === 'cancelled' || verdict === 'failed') return { status: 'cancelled', message: 'Not confirmed. Nothing was changed.' }
  const gone: DecisionOutcome = { status: 'already_resolved', message: 'Already handled.' }
  try {
    const pending = (await deps.rpc('tool.pending')) as Array<{ requestId?: string }> | null
    if (!Array.isArray(pending) || !pending.some((p) => p.requestId === route.rid)) return gone
    if (route.decision === 'approve') await deps.rpc('tool.approve', { requestId: route.rid })
    else await deps.rpc('tool.deny', { requestId: route.rid, reason: DENY_REASON })
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (ALREADY_GONE.test(msg)) return gone
    return { status: 'failed', message: `Could not ${route.decision}: ${msg || 'unknown error'}` }
  }
  return { status: 'done', decision: route.decision, message: route.decision === 'approve' ? 'Approved.' : 'Denied.' }
}

export interface DeliveredNotification {
  id: string
  data?: Record<string, unknown>
}

/** Delivered approval/question notifications whose request is no longer pending. Run-finished notifications are left alone. */
export function staleDelivered(delivered: DeliveredNotification[], liveRids: ReadonlySet<string>): DeliveredNotification[] {
  return delivered.filter((n) => {
    const d = n.data ?? {}
    return (d.k === 'approval' || d.k === 'question') && typeof d.rid === 'string' && !liveRids.has(d.rid)
  })
}
