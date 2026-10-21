import { randomBytes } from 'node:crypto'
import { PROTOCOL_VERSION, SecureChannel, deriveSessionKeys, fromB64, generateIdentity, sodiumReady, toB64 } from '@dorabot-remote/protocol'
import type { Scope } from '@dorabot-remote/protocol'
import { describe, expect, it } from 'vitest'
import { DeviceConnection, type ConnectionHost } from './connection.js'
import type { DeviceRecord } from './store.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RELAY_BUDGET = 1024 * 1024

async function connect(opts: { caps?: string[]; maxFrameBytes?: number; result?: unknown }) {
  const s = await sodiumReady()
  const hostId = generateIdentity(s)
  const devId = generateIdentity(s)
  const record = { id: 'dev1', name: 'Phone', platform: 'ios', publicKey: toB64(s, devId.publicKey), scopes: ['sessions'] as Scope[], createdAt: 0, lastSeenAt: null, revoked: false } as DeviceRecord
  const host = {
    sodium: s, hostIdentity: hostId, hostSummary: { id: 'h', name: 'Mac' } as never,
    getDevice: () => record, touchDevice() {}, deviceSummary: () => ({}) as never,
    currentSeq: () => 0, eventsSince: () => [], snapshotFor: () => null, knownSessionKeys: () => [],
    gatewayConnected: () => true,
    callGateway: async () => opts.result ?? { ok: true },
    handleBridgeMethod: async () => ({}), log() {}, onClosed() {},
    protectedPaths: () => [] as string[], allowedRoots: () => [] as string[], hostSummaryFor: () => ({ id: 'h', name: 'Mac' }) as never,
  } as unknown as ConnectionHost
  const handlers: Record<string, (...a: never[]) => void> = {}
  const sent: Array<string | Buffer> = []
  let closed = false
  const ws = { on: (ev: string, fn: (...a: never[]) => void) => { handlers[ev] = fn }, send: (d: string | Buffer) => { sent.push(d) }, close: () => { closed = true }, bufferedAmount: 0, maxFrameBytes: opts.maxFrameBytes }
  new DeviceConnection(ws as never, host, '127.0.0.1')
  const text = (o: unknown) => (handlers.message as (b: Buffer, bin: boolean) => void)(Buffer.from(JSON.stringify(o)), false)
  const bin = (b: Uint8Array) => (handlers.message as (b: Buffer, bin: boolean) => void)(Buffer.from(b), true)
  const devEph = generateIdentity(s)
  text({ t: 'hello', v: PROTOCOL_VERSION, deviceId: 'dev1', ephPk: toB64(s, devEph.publicKey) })
  await wait(20)
  const ack = JSON.parse(String(sent[0])) as { ephPk: string }
  const hostHdr = JSON.parse(String(sent[1])) as { hdr: string }
  const ch = SecureChannel.create(s, deriveSessionKeys(s, 'device', { myEphemeral: devEph, theirEphemeralPk: fromB64(s, ack.ephPk), myStatic: devId, theirStaticPk: hostId.publicKey }), { acceptCompressed: true })
  ch.startReceive(fromB64(s, hostHdr.hdr))
  text({ t: 'hdr', hdr: toB64(s, ch.startSend()) })
  await wait(10)
  bin(ch.seal({ t: 'auth', lastSeq: 0, ...(opts.caps ? { caps: opts.caps } : {}) }))
  await wait(30)
  let cursor = 2
  const rpc = async (method: string) => {
    bin(ch.seal({ t: 'rpc', id: 7, method, params: {} }))
    for (let i = 0; i < 300; i++) {
      await wait(10)
      while (cursor < sent.length) {
        const raw = sent[cursor++] as Buffer
        const env = ch.open<{ t: string; id: number; result?: unknown; error?: { code?: string } }>(new Uint8Array(raw))
        if (env.t === 'rpc_res') return { frameBytes: raw.length, env }
      }
    }
    throw new Error('no reply')
  }
  return { rpc, ch, bin, sent, isClosed: () => closed }
}

const history = (bytes: number) => {
  const items: unknown[] = []
  let n = 0
  let size = 0
  while (size < bytes) {
    n++
    const item = ({ type: n % 3 ? 'assistant' : 'tool_result', id: `msg_${n}`, ts: 1_700_000_000_000 + n * 1317, content: `Reading packages/bridge/src/connection.ts line ${n}. `.repeat(4) + randomBytes(90).toString('base64') + `const x${n} = await host.callGateway('sessions.get', { sessionKey: 'agent:main:${n}' })`, usage: { input: 1200 + n, output: 80 + (n % 50) } })
    items.push(item)
    size += JSON.stringify(item).length + 1
  }
  return { items }
}

describe('negotiated compression (bridge -> phone)', () => {
  it('compresses a large response for a phone that advertised deflate', async () => {
    const result = history(300_000)
    const c = await connect({ caps: ['deflate'], result })
    const { env, frameBytes } = await c.rpc('sessions.list')
    expect(env.result).toEqual(result)
    expect(frameBytes).toBeLessThan(JSON.stringify(result).length / 3)
  })

  it('never compresses small frames, even with caps', async () => {
    const c = await connect({ caps: ['deflate'], result: { text: 'a'.repeat(3000) } })
    const { frameBytes, env } = await c.rpc('sessions.list')
    expect(env.result).toEqual({ text: 'a'.repeat(3000) })
    expect(frameBytes).toBeGreaterThan(3000) // highly compressible, yet sent as-is
  })

  it('sends uncompressed to a phone without caps', async () => {
    const result = history(300_000)
    const c = await connect({ result })
    const { env, frameBytes } = await c.rpc('sessions.list')
    expect(env.result).toEqual(result)
    expect(frameBytes).toBeGreaterThan(JSON.stringify(result).length)
  })

  it('ignores unknown caps', async () => {
    const c = await connect({ caps: ['zstd'], result: history(100_000) })
    const { frameBytes } = await c.rpc('sessions.list')
    expect(frameBytes).toBeGreaterThan(100_000)
  })

  it('fits a ~2.5 MB history under the relay budget when compressed, and is refused when not negotiated', async () => {
    const result = history(2_500_000)
    expect(JSON.stringify(result).length).toBeGreaterThan(2_400_000)
    const on = await connect({ caps: ['deflate'], maxFrameBytes: RELAY_BUDGET, result })
    const a = await on.rpc('sessions.list')
    expect(a.env.result).toEqual(result)
    expect(a.frameBytes).toBeLessThan(RELAY_BUDGET)
    console.log(`2.5MB history -> ${a.frameBytes} bytes sealed (${(JSON.stringify(result).length / a.frameBytes).toFixed(1)}x)`)
    const off = await connect({ maxFrameBytes: RELAY_BUDGET, result })
    const b = await off.rpc('sessions.list')
    expect(b.env.error?.code).toBe('too_large')
  })

  it('closes when the phone sends a compressed frame (phone -> bridge is never compressed)', async () => {
    const c = await connect({ caps: ['deflate'] })
    const { deflateRawSync } = await import('node:zlib')
    const { frameDeflated } = await import('@dorabot-remote/protocol')
    const j = Buffer.from(JSON.stringify({ t: 'ping', ts: 1, pad: 'x'.repeat(5000) }))
    c.bin(c.ch.sealBytes(frameDeflated(j.length, deflateRawSync(j))))
    await wait(30)
    expect(c.isClosed()).toBe(true)
  })
})
