/**
 * What to do with a notification tap or action button. Pure routing plus the
 * approve/deny flow, with every side effect injected so it can be tested.
 */
import { authLevelFor, verdictAllows } from './approval-auth.js'
import { decryptWithKeyInfo, pushKeyId, type StoredPushKey } from './push-keys.js'

export interface PushNav {
  rid?: string
  kind?: string
  /** 'tap' for the default tap, else the UNNotificationAction identifier. */
  actionId?: string
  /** Learned by decrypting `enc`. */
  sessionKey?: string
  /** Which Mac sent it: from `enc` (hostId) or, if that could not be decrypted, the unencrypted key id. */
  hostId?: string
  kid?: string
}

export type PushRoute =
  | { type: 'decide'; decision: 'approve' | 'deny'; rid: string; sessionKey?: string; hostId?: string; kid?: string }
  | { type: 'open'; rid?: string; sessionKey?: string; hostId?: string; kid?: string }

export interface PushData {
  enc?: unknown
  kid?: unknown
  rid?: unknown
  k?: unknown
}

/**
 * Build the navigation for a tapped notification / action button from what the push says.
 * The unencrypted userInfo (rid, k, kid) is attacker-controllable by anything that can reach the
 * relay, so it is never used to act. Only `enc`, decrypted with a stored key, is trusted: rid, kind
 * and hostId come from the decrypted content, and the hostId must match the Mac the key belongs to.
 * If that fails, the result is a plain tap that opens the Inbox without acting.
 */
export function buildPushNav(data: PushData, actionId: string | undefined, keys: readonly StoredPushKey[]): PushNav {
  const opened = typeof data.enc === 'string' ? decryptWithKeyInfo(data.enc, typeof data.kid === 'string' ? data.kid : undefined, keys) : null
  if (!opened) return { actionId: 'tap' }
  const { content, kid } = opened
  // A key only vouches for its own Mac. A legacy key (kid '') cannot be tied to one, so it never acts.
  const bound = kid !== '' && !!content.hostId && pushKeyId(content.hostId) === kid
  return {
    rid: content.rid,
    kind: content.kind,
    // Without a verified Mac, any button press is demoted to a plain open.
    actionId: bound && actionId ? actionId : 'tap',
    ...(content.sessionKey ? { sessionKey: content.sessionKey } : {}),
    ...(bound && content.hostId ? { hostId: content.hostId } : {}),
    ...(kid ? { kid } : {}),
  }
}

export function routePushAction(nav: PushNav): PushRoute {
  const where = { ...(nav.hostId ? { hostId: nav.hostId } : {}), ...(nav.kid ? { kid: nav.kid } : {}) }
  const open: PushRoute = { type: 'open', ...(nav.rid ? { rid: nav.rid } : {}), ...(nav.sessionKey ? { sessionKey: nav.sessionKey } : {}), ...where }
  // Only an approval notification can be approved or denied from a button; anything else just opens.
  if (nav.rid && nav.hostId && nav.kind === 'approval' && (nav.actionId === 'APPROVE' || nav.actionId === 'DENY')) {
    return { type: 'decide', decision: nav.actionId === 'APPROVE' ? 'approve' : 'deny', rid: nav.rid, ...(nav.sessionKey ? { sessionKey: nav.sessionKey } : {}), ...where }
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
  /** A fresh Face ID / passcode prompt for a risky approval (no reuse of the earlier one). Absent means risky approvals cannot proceed. */
  verifyFresh?: () => Promise<'ok' | 'cancelled' | 'unavailable' | 'failed'>
  /** Whether a real OS prompt exists (false in the browser demo). Defaults to true. */
  native?: boolean
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export async function runDecision(route: Extract<PushRoute, { type: 'decide' }>, deps: DecisionDeps): Promise<DecisionOutcome> {
  const verdict = await deps.verify()
  if (verdict === 'cancelled' || verdict === 'failed') return { status: 'cancelled', message: 'Not confirmed. Nothing was changed.' }
  const gone: DecisionOutcome = { status: 'already_resolved', message: 'Already handled.' }
  try {
    const pending = (await deps.rpc('tool.pending')) as Array<{ requestId?: string; toolName?: string; input?: Record<string, unknown> }> | null
    const entry = Array.isArray(pending) ? pending.find((p) => p.requestId === route.rid) : undefined
    if (!entry) return gone
    // Tiered approvals: a risky approve needs its own Face ID, never the one a moment ago.
    if (route.decision === 'approve' && authLevelFor(entry.toolName, entry.input) === 'fresh') {
      const v = deps.verifyFresh ? await deps.verifyFresh() : 'failed'
      if (!verdictAllows(v, deps.native ?? true)) return { status: 'cancelled', message: v === 'unavailable' ? 'Risky actions need Face ID or a passcode. Open the app to review it.' : 'Not confirmed. Nothing was approved.' }
    }
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
