/**
 * Push triggers. When something needs a human (a question, an approval) and a
 * phone is not connected to see it live, ask the relay to wake that phone.
 *
 * The relay and Apple only ever see a generic kind, an opaque routing id and (for
 * devices that registered a push key) an E2E-encrypted blob; never session names,
 * tool names or prompt text in the clear. Tokens are never logged.
 */
import { createHash } from 'node:crypto'
import { signBytes, type SigningKeyPair } from '@dorabot-remote/protocol'
import { buildPushContent, encryptPushContent, parsePushKey, pushKeyId, type PushContent } from './push-content.js'
import type { DeviceRecord, Store } from './store.js'

export type PushKind = 'question' | 'approval' | 'result' | 'error' | 'alert'

export const PUSH_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/
export const APPROVAL_COALESCE_MS = 30_000
const MAX_EVENT_AGE_MS = 2 * 60_000
const SEND_TIMEOUT_MS = 10_000
const MAX_SEEN = 2000

export interface PushNotifierOptions {
  store: Pick<Store, 'listDevices' | 'clearPushTokenIf'>
  /** Relay base URL (wss/ws accepted) and relay id; push is silently off when absent. */
  relay: { url: string; id: string } | null
  signingKey: SigningKeyPair
  /** This Mac, for the encrypted content (hostId/hostName) and the `kid` key selector. */
  host?: { id: string; name: string }
  isConnected: (deviceId: string) => boolean
  log: (msg: string) => void
  fetch?: typeof fetch
  now?: () => number
}

export function relayHttpBase(url: string): string {
  return url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '')
}

export class PushNotifier {
  private readonly seen = new Map<string, number>()
  private readonly lastApproval = new Map<string, number>()
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(private readonly opts: PushNotifierOptions) {
    this.fetchFn = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
  }

  /** Map a gateway event to a push, if it is one we notify about. Returns the promises for tests. */
  onGatewayEvent(name: string, data: unknown): Promise<void>[] {
    if (!this.opts.relay) return []
    const d = (data ?? {}) as Record<string, unknown>
    const ts = typeof d.timestamp === 'number' ? d.timestamp : null
    if (ts !== null && this.now() - ts > MAX_EVENT_AGE_MS) return []

    let kind: PushKind
    let rid: string
    switch (name) {
      case 'agent.ask_user':
        if (typeof d.requestId !== 'string' || !d.requestId) return []
        kind = 'question'
        rid = d.requestId
        break
      case 'agent.elicitation':
        if (typeof d.elicitationId !== 'string' || !d.elicitationId) return []
        kind = 'question'
        rid = d.elicitationId
        break
      case 'agent.tool_approval':
        if (typeof d.requestId !== 'string' || !d.requestId) return []
        kind = 'approval'
        rid = d.requestId
        break
      case 'agent.result':
      case 'agent.error': {
        kind = name === 'agent.result' ? 'result' : 'error'
        // No request id exists for a run ending; derive an opaque one that does not leak the session key.
        const sk = typeof d.sessionKey === 'string' ? d.sessionKey : ''
        rid = `run-${createHash('sha1').update(name + sk).digest('hex').slice(0, 10)}-${this.now().toString(36)}`
        break
      }
      default:
        return []
    }
    const r = rid.slice(0, 128)
    return this.notify(kind, r, buildPushContent(name, data, r, this.opts.host))
  }

  private notify(kind: PushKind, rid: string, content: PushContent | null): Promise<void>[] {
    const out: Promise<void>[] = []
    const now = this.now()
    for (const device of this.opts.store.listDevices()) {
      if (!this.eligible(device, kind)) continue
      const key = `${device.id}:${rid}`
      if (this.seen.has(key)) continue
      this.remember(key, now)
      if (kind === 'approval') {
        const last = this.lastApproval.get(device.id)
        if (last !== undefined && now - last < APPROVAL_COALESCE_MS) continue
        this.lastApproval.set(device.id, now)
      }
      out.push(this.send(device, kind, rid, content))
    }
    return out
  }

  private eligible(device: DeviceRecord, kind: PushKind): boolean {
    if (device.revoked || !device.pushToken || !device.pushPlatform) return false
    if (!device.scopes.includes('approvals')) return false
    if ((kind === 'result' || kind === 'error') && !device.pushOnResult) return false
    return !this.opts.isConnected(device.id)
  }

  private remember(key: string, now: number): void {
    this.seen.set(key, now)
    if (this.seen.size > MAX_SEEN) {
      const first = this.seen.keys().next().value
      if (first !== undefined) this.seen.delete(first)
    }
  }

  private encFor(device: DeviceRecord, content: PushContent | null): string | undefined {
    if (!content || device.pushPlatform !== 'ios') return undefined
    const key = parsePushKey(device.pushKey)
    if (!key) return undefined
    try {
      return encryptPushContent(content, key)
    } catch {
      return undefined
    }
  }

  /**
   * Send a contentless alert push to all devices with push tokens (not revoked).
   * Best-effort: failures are logged only.
   */
  async sendAlert(): Promise<void> {
    if (!this.opts.relay) return
    const promises: Promise<void>[] = []
    for (const device of this.opts.store.listDevices()) {
      if (device.revoked || !device.pushToken || !device.pushPlatform) continue
      // Alert: contentless, no rid, no device offline check, no scope requirements.
      const rid = `alert-${this.now().toString(36)}`
      promises.push(this.send(device, 'alert', rid, null))
    }
    await Promise.all(promises)
  }

  private async send(device: DeviceRecord, kind: PushKind, rid: string, content: PushContent | null): Promise<void> {
    const relay = this.opts.relay!
    const enc = this.encFor(device, content)
    const raw = new TextEncoder().encode(
      JSON.stringify({
        token: device.pushToken,
        platform: device.pushPlatform,
        kind,
        rid,
        ...(device.pushPlatform === 'ios' ? { env: device.pushEnv ?? 'production' } : {}),
        ...(enc ? { enc } : {}),
        ...(enc && this.opts.host?.id ? { kid: pushKeyId(this.opts.host.id) } : {}),
        ts: this.now(),
      }),
    )
    const { pk, sig } = signBytes(this.opts.signingKey, raw)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS)
    let status: string
    try {
      const res = await this.fetchFn(`${relayHttpBase(relay.url)}/push/${relay.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dr-pk': pk, 'x-dr-sig': sig },
        body: raw,
        signal: ctl.signal,
      })
      status = String(res.status)
      if (res.status === 410) {
        this.opts.store.clearPushTokenIf(device.id, device.pushToken!)
        status = '410 (token dropped)'
      }
    } catch (err) {
      status = (err as Error).name === 'AbortError' ? 'timeout' : 'network error'
    } finally {
      clearTimeout(timer)
    }
    this.opts.log(`push ${kind} -> "${device.name}"${enc ? ' (e2e)' : ''}: ${status}`)
  }
}
