/**
 * Tiered approvals: what authentication an approval needs right before tool.approve.
 *
 *  - Routine approval: one tap, nothing extra.
 *  - Risky approval (the shared classifier in @dorabot-remote/protocol): Face ID / device
 *    passcode every single time. A recent success does not count, and neither does the
 *    app lock being off. This also applies to the notification Approve action.
 *
 * Pure, so the decision can be tested without a device.
 */
import { assessRisk, type RiskContext } from '@dorabot-remote/protocol'
import { authenticate, type AuthResult } from './biometric.js'
import { isNative } from './platform.js'

export type ApprovalAuthLevel = 'none' | 'fresh'

/** Unknown input cannot be judged, so it is treated as risky. */
export function authLevelFor(toolName: string | undefined, input: Record<string, unknown> | undefined | null, ctx: RiskContext = {}): ApprovalAuthLevel {
  if (!toolName || !input || typeof input !== 'object') return 'fresh'
  return assessRisk(toolName, input, ctx).risky ? 'fresh' : 'none'
}

/**
 * Whether a verdict lets the approval go ahead. 'unavailable' (no biometrics, no passcode)
 * blocks a risky approval on a real device; the browser demo has no OS prompt at all.
 */
export function verdictAllows(verdict: AuthResult, native: boolean): boolean {
  if (verdict === 'ok') return true
  return verdict === 'unavailable' && !native
}

export function verdictMessage(verdict: AuthResult): string {
  if (verdict === 'unavailable') return 'Risky actions need Face ID or a device passcode. Set one up in iOS Settings to approve this from your phone.'
  return 'Not confirmed. Nothing was approved.'
}

export interface ApprovalAuthDeps {
  /** A fresh prompt: no reuse of a recent success. */
  fresh: (reason: string) => Promise<AuthResult>
  native: boolean
}

const defaultDeps: ApprovalAuthDeps = { fresh: (reason) => authenticate(reason, { fresh: true }), native: isNative }

/** Resolves to null when the approval may proceed, else the message to show. */
export async function requireApprovalAuth(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined | null,
  ctx: RiskContext = {},
  deps: ApprovalAuthDeps = defaultDeps,
): Promise<string | null> {
  if (authLevelFor(toolName, input, ctx) === 'none') return null
  const verdict = await deps.fresh('Approve a risky action')
  return verdictAllows(verdict, deps.native) ? null : verdictMessage(verdict)
}
