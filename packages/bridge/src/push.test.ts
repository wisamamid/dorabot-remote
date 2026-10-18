import { generateSigningKey, isMethodAllowed, relayIdFromPublicKey, verifyForRelayId } from '@dorabot-remote/protocol'
import { describe, expect, it } from 'vitest'
import { Bridge } from './bridge.js'
import { PushNotifier, relayHttpBase } from './push.js'
import { Store } from './store.js'

const TOKEN = 'ab'.repeat(32)
const key = generateSigningKey()
const relayId = relayIdFromPublicKey(key.publicKey)

function setup(opts: { relay?: boolean; status?: number } = {}) {
  const store = new Store(':memory:')
  const connected = new Set<string>()
  const calls: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = []
  const logs: string[] = []
  let t = 1_000_000
  const n = new PushNotifier({
    store,
    relay: opts.relay === false ? null : { url: 'wss://relay.test/', id: relayId },
    signingKey: key,
    isConnected: (id) => connected.has(id),
    log: (m) => logs.push(m),
    now: () => t,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array })
      return new Response('{}', { status: opts.status ?? 200 })
    }) as unknown as typeof fetch,
  })
  const device = (scopes: string[] = ['approvals'], token: string | null = TOKEN) => {
    const d = store.createDevice({ name: 'Phone', platform: 'ios', publicKey: `pk-${Math.random()}`, scopes: scopes as never })
    if (token) store.setPushToken(d.id, token, 'ios', 'production')
    return d
  }
  const fire = async (name: string, data: Record<string, unknown>) => {
    await Promise.all(n.onGatewayEvent(name, data))
  }
  return { staleId: '', store, connected, calls, logs, n, device, fire, tick: (ms: number) => (t += ms) }
}
const bodyOf = (c: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(c.body))

describe('push triggers', () => {
  it('question and elicitation events push a question; approvals push an approval', async () => {
    const s = setup()
    s.device()
    await s.fire('agent.ask_user', { requestId: 'q1' })
    await s.fire('agent.elicitation', { elicitationId: 'e1' })
    await s.fire('agent.tool_approval', { requestId: 'a1' })
    expect(s.calls.map((c) => bodyOf(c).kind)).toEqual(['question', 'question', 'approval'])
    expect(s.calls.map((c) => bodyOf(c).rid)).toEqual(['q1', 'e1', 'a1'])
  })

  it('signs the exact body bytes the relay verifies, and posts to /push/<relayId> over https', async () => {
    const s = setup()
    s.device()
    await s.fire('agent.ask_user', { requestId: 'q1' })
    const c = s.calls[0]!
    expect(c.url).toBe(`https://relay.test/push/${relayId}`)
    expect(verifyForRelayId(relayId, c.headers['x-dr-pk']!, c.headers['x-dr-sig']!, c.body)).toBe(true)
    expect(bodyOf(c)).toEqual({ token: TOKEN, platform: 'ios', kind: 'question', rid: 'q1', env: 'production', ts: 1_000_000 })
    // tampering breaks it
    expect(verifyForRelayId(relayId, c.headers['x-dr-pk']!, c.headers['x-dr-sig']!, new TextEncoder().encode('{}'))).toBe(false)
  })

  it('only pushes to devices that are not connected', async () => {
    const s = setup()
    const d = s.device()
    s.connected.add(d.id)
    await s.fire('agent.ask_user', { requestId: 'q1' })
    expect(s.calls).toHaveLength(0)
    s.connected.clear()
    await s.fire('agent.ask_user', { requestId: 'q2' })
    expect(s.calls).toHaveLength(1)
  })

  it('requires the approvals scope, a token, and a non-revoked device', async () => {
    const s = setup()
    s.device(['sessions', 'chat'])
    s.device(['approvals'], null)
    const revoked = s.device()
    s.store.setPushToken(revoked.id, TOKEN, 'ios')
    s.store.setRevoked(revoked.id, true)
    await s.fire('agent.ask_user', { requestId: 'q1' })
    expect(s.calls).toHaveLength(0)
  })

  it('revoking drops the token', () => {
    const s = setup()
    const d = s.device()
    s.store.setRevoked(d.id, true)
    expect(s.store.getDevice(d.id)!.pushToken).toBeNull()
  })

  it('dedupes by request id', async () => {
    const s = setup()
    s.device()
    await s.fire('agent.ask_user', { requestId: 'q1' })
    await s.fire('agent.ask_user', { requestId: 'q1' })
    expect(s.calls).toHaveLength(1)
  })

  it('coalesces approvals to one per device per 30s; questions always go', async () => {
    const s = setup()
    s.device()
    await s.fire('agent.tool_approval', { requestId: 'a1' })
    s.tick(5_000)
    await s.fire('agent.tool_approval', { requestId: 'a2' })
    await s.fire('agent.ask_user', { requestId: 'q1' })
    expect(s.calls.map((c) => bodyOf(c).rid)).toEqual(['a1', 'q1'])
    s.tick(31_000)
    await s.fire('agent.tool_approval', { requestId: 'a3' })
    expect(s.calls.map((c) => bodyOf(c).rid)).toEqual(['a1', 'q1', 'a3'])
  })

  it('result/error are off by default and opt-in per device', async () => {
    const s = setup()
    const d = s.device()
    await s.fire('agent.result', { sessionKey: 'x:y:z' })
    expect(s.calls).toHaveLength(0)
    s.store.setPushOnResult(d.id, true)
    await s.fire('agent.result', { sessionKey: 'x:y:z' })
    await s.fire('agent.error', { sessionKey: 'x:y:z' })
    expect(s.calls.map((c) => bodyOf(c).kind)).toEqual(['result', 'error'])
    expect(bodyOf(s.calls[0]!).rid).not.toContain('x:y:z')
  })

  it('ignores stale replayed events and does nothing without a relay', async () => {
    const s = setup()
    s.device()
    await s.fire('agent.ask_user', { requestId: 'old', timestamp: 1_000_000 - 10 * 60_000 })
    expect(s.calls).toHaveLength(0)
    const off = setup({ relay: false })
    off.device()
    await off.fire('agent.ask_user', { requestId: 'q1' })
    expect(off.calls).toHaveLength(0)
  })

  it('removes the token on 410 and logs without it', async () => {
    const s = setup({ status: 410 })
    const d = s.device()
    await s.fire('agent.ask_user', { requestId: 'q1' })
    expect(s.store.getDevice(d.id)!.pushToken).toBeNull()
    expect(s.logs.join('\n')).toContain('410')
    expect(s.logs.join('\n')).not.toContain(TOKEN)
  })

  it('keeps a token that was replaced while the push was in flight', async () => {
    const s = setup({ status: 410 })
    const d = s.device()
    const newer = 'cd'.repeat(32)
    const origSet = s.store.clearPushTokenIf.bind(s.store)
    s.store.setPushToken(d.id, newer, 'ios')
    expect(origSet(d.id, TOKEN)).toBe(false)
    expect(s.store.getDevice(d.id)!.pushToken).toBe(newer)
  })

  it('relayHttpBase maps ws schemes', () => {
    expect(relayHttpBase('wss://a.b/')).toBe('https://a.b')
    expect(relayHttpBase('ws://a.b')).toBe('http://a.b')
  })
})

describe('push method policy', () => {
  it('needs the approvals scope', () => {
    for (const m of ['remote.registerPush', 'remote.unregisterPush', 'remote.setPushPrefs', 'remote.pushPrefs']) {
      expect(isMethodAllowed(m, ['approvals'])).toBe(true)
      expect(isMethodAllowed(m, ['sessions', 'chat'])).toBe(false)
    }
  })
})

describe('store migration', () => {
  it('stores env and prefs per device', () => {
    const s = setup()
    const d = s.device()
    s.store.setPushToken(d.id, TOKEN, 'ios', 'sandbox')
    expect(s.store.getDevice(d.id)).toMatchObject({ pushEnv: 'sandbox', pushOnResult: false })
    s.store.deleteDevice(d.id)
    expect(s.store.getDevice(d.id)).toBeNull()
  })
})

describe('liveness and idle sweep', () => {
  function fakeBridge() {
    const b = new Bridge({ paths: { db: ':memory:' } as never, settings: {} as never })
    const closed: string[] = []
    const mk = (deviceId: string, lastInboundAt: number) => ({
      device: { id: deviceId, name: deviceId },
      isAuthed: true,
      lastInboundAt,
      close: (r: string) => closed.push(`${deviceId}:${r}`),
    })
    const conns = (b as unknown as { connections: Set<unknown> }).connections
    return { b, conns, mk, closed }
  }

  it('a recently active connection is live; a silent one is not (so push fires)', () => {
    const { b, conns, mk } = fakeBridge()
    const now = 10_000_000
    conns.add(mk('fresh', now - 20_000))
    conns.add(mk('stale', now - 60_000))
    expect(b.isDeviceLive('fresh', now)).toBe(true)
    expect(b.isDeviceLive('stale', now)).toBe(false)
    expect(b.isDeviceLive('none', now)).toBe(false)
    b.store.close()
  })

  it('PushNotifier pushes to a stale device and not to a fresh one', async () => {
    const { b, conns, mk } = fakeBridge()
    const now = 10_000_000
    conns.add(mk('stale', now - 60_000))
    conns.add(mk('fresh', now - 5_000))
    const s = setup()
    const n = new PushNotifier({
      store: s.store,
      relay: { url: 'wss://relay.test', id: relayId },
      signingKey: key,
      isConnected: (id) => b.isDeviceLive(id === s.staleId ? 'stale' : 'fresh', now),
      log: () => {},
      now: () => now,
      fetch: (async (u: string, init: RequestInit) => {
        s.calls.push({ url: u, headers: init.headers as Record<string, string>, body: init.body as Uint8Array })
        return new Response('{}')
      }) as unknown as typeof fetch,
    })
    s.staleId = s.device().id
    await Promise.all(n.onGatewayEvent('agent.ask_user', { requestId: 'q1' }))
    expect(s.calls).toHaveLength(1)
    b.store.close()
  })

  it('sweepIdle closes connections silent for 90s and keeps others', () => {
    const { b, conns, mk, closed } = fakeBridge()
    const now = 10_000_000
    conns.add(mk('dead', now - 95_000))
    conns.add(mk('ok', now - 80_000))
    expect(b.sweepIdle(now)).toBe(1)
    expect(closed).toEqual(['dead:idle'])
    b.store.close()
  })
})
