/**
 * Push registration across several Macs. The phone has ONE APNs token but every
 * paired Mac keeps its own token + content-key record, so each Mac must be told
 * separately. Pure planning and the per-host register step (fakes in tests); the
 * transport (live client for the active Mac, a short-lived one for the others)
 * is supplied by the caller.
 */
import { RemoteClient, fromB64, identityFromB64 } from '@dorabot-remote/protocol'
import type { HostPairing } from './hosts.js'
import { storage } from './platform.js'
import { pushKeyId } from './push-keys.js'

export const SENT_KEY = 'dorabot-remote.push.sent.v2'

export type SentMap = Record<string, string>

export const stampFor = (p: Pick<HostPairing, 'deviceId'>, env: string, token: string): string => `${p.deviceId}:${env}:${token}`

/** The stored map; anything else (including the pre-multi-Mac single stamp) means "nothing registered yet". */
export function parseSent(raw: string | null): SentMap {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: SentMap = {}
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === 'string') out[k] = s
    return out
  } catch {
    return {}
  }
}

export interface PlanInput {
  pairings: readonly HostPairing[]
  activeHostId: string | null
  token: string
  env: string
  sent: SentMap
  /** Key ids (see push-keys.ts) that currently have a key in the keychain. */
  keyIds: ReadonlySet<string>
}

/** Which Macs still need `remote.registerPush`: no approvals scope means nothing to register; the active Mac goes first. */
export function planPushRegistrations(i: PlanInput): string[] {
  const need = i.pairings.filter(
    (p) => p.scopes.includes('approvals') && (i.sent[p.hostId] !== stampFor(p, i.env, i.token) || !i.keyIds.has(pushKeyId(p.hostId))),
  )
  need.sort((a, b) => Number(b.hostId === i.activeHostId) - Number(a.hostId === i.activeHostId))
  return need.map((p) => p.hostId)
}

export interface RegisterDeps {
  rpc: (method: string, params: unknown) => Promise<unknown>
  newKey: () => string
  storeKey: (hostId: string, key: string) => Promise<void>
}

/**
 * Register this phone with one Mac. Every registration rotates that Mac's content key; the bridge
 * switches to the new key as soon as it accepts it, so the keychain is updated right after.
 * Returns the new stamp to record, or throws (nothing is recorded or stored on failure).
 */
export async function registerWithHost(deps: RegisterDeps, p: Pick<HostPairing, 'hostId' | 'deviceId'>, token: string, env: string): Promise<string> {
  const pushKey = deps.newKey()
  await deps.rpc('remote.registerPush', { token, platform: 'ios', env, pushKey })
  await deps.storeKey(p.hostId, pushKey)
  return stampFor(p, env, token)
}

const createSocket = (url: string) => new WebSocket(url) as never

/**
 * Run `fn` against a Mac that is not the active one, over a short-lived client
 * (no subscriptions, no cursor, no stored-relay updates). Rejects on timeout.
 */
export async function withTempClient<T>(p: HostPairing, fn: (rpc: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  let client: RemoteClient | null = null
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out connecting')), timeoutMs)
    client = new RemoteClient({
      identity: identityFromB64(null, p.identity),
      deviceId: p.deviceId,
      hostPublicKey: fromB64(null, p.hostPublicKey),
      addresses: p.addresses,
      relay: p.relay ?? null,
      createSocket,
      lastSeq: 0,
      clientVersion: '0.1.0',
      onState: (s, detail) => {
        if (s === 'revoked') {
          clearTimeout(timer)
          reject(new Error(detail || 'access removed'))
        }
      },
      onReady: () => {
        clearTimeout(timer)
        resolve()
      },
      onEvent: () => {},
    })
    client.connect()
  })
  try {
    await ready
    const c = client as RemoteClient | null
    return await fn((m, params) => c!.rpc(m, params))
  } finally {
    ;(client as RemoteClient | null)?.disconnect()
  }
}

// Serialised: two hosts finishing at once must not overwrite each other's entry.
let sentChain: Promise<unknown> = Promise.resolve()

export async function readSent(): Promise<SentMap> {
  return parseSent(await storage.get(SENT_KEY).catch(() => null))
}

function mutateSent(fn: (m: SentMap) => void): Promise<void> {
  const run = sentChain.then(async () => {
    const m = await readSent()
    fn(m)
    await storage.set(SENT_KEY, JSON.stringify(m)).catch(() => {})
  })
  sentChain = run.catch(() => {})
  return run.catch(() => {})
}

export const markSent = (hostId: string, stamp: string): Promise<void> => mutateSent((m) => void (m[hostId] = stamp))
export const forgetSent = (hostId: string): Promise<void> => mutateSent((m) => void delete m[hostId])
