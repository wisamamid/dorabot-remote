/**
 * Fuzz: hostile bytes at the bridge's device socket, before and after the handshake. The bridge must never
 * throw unhandled, never crash, and keep serving a well-behaved phone afterwards. Seeded, so a failure replays.
 */
import { randomBytes } from 'node:crypto'
import {
  CAP_DEFLATE,
  PROTOCOL_VERSION,
  SCOPES,
  SecureChannel,
  deriveSessionKeys,
  fromB64,
  generateIdentity,
  methodsForScopes,
  toB64,
  type PairResult,
} from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHarness, until, wait, type Harness } from '../test/harness.js'

const PORT = 7894

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const unhandled: unknown[] = []
const onUnhandled = (e: unknown): void => void unhandled.push(e)

let h: Harness
beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUnhandled)
  h = await startHarness(PORT)
}, 30_000)
afterAll(async () => {
  await h?.stop()
  process.off('unhandledRejection', onUnhandled)
  process.off('uncaughtException', onUnhandled)
})

const open = (path = '/connect'): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`)
    ws.on('error', () => {}) // refusals and resets are fine
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })

const closed = (ws: WebSocket, ms = 1500): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    const t = setTimeout(() => {
      ws.terminate()
      resolve()
    }, ms)
    ws.once('close', () => {
      clearTimeout(t)
      resolve()
    })
  })

function randomJsonValue(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * (depth > 3 ? 6 : 9))
  switch (pick) {
    case 0:
      return null
    case 1:
      return Math.floor((r() - 0.5) * 2 ** (Math.floor(r() * 53)))
    case 2:
      return r() < 0.5
    case 3:
      return ['', 'x', '__proto__', 'constructor', '../../etc/passwd', '\u0000', 'a'.repeat(Math.floor(r() * 5000))][Math.floor(r() * 7)]
    case 4:
      return r() * 1e308
    case 5:
      return [NaN, Infinity, -0][Math.floor(r() * 3)] ?? null
    case 6:
      return Array.from({ length: Math.floor(r() * 5) }, () => randomJsonValue(r, depth + 1))
    default: {
      const o: Record<string, unknown> = {}
      const n = Math.floor(r() * 6)
      for (let i = 0; i < n; i++) {
        const k = ['__proto__', 'constructor', 'prompt', 'path', 'sessionKey', 'sessionKeys', 'requestId', 'id', 'cwd', 'command', 'scope', 'kind', 'toolName', 'token', 'tokHash', 'deviceId', 'afterSeq', 'limit', 'name', 'params', 'freshAuth'][Math.floor(r() * 21)]!
        o[k] = randomJsonValue(r, depth + 1)
      }
      return o
    }
  }
}

describe('bridge fuzz', () => {
  it('survives junk before the handshake (random, oversized and malformed frames)', async () => {
    const r = rng(0xd02a)
    const pair = await h.pairApproved('Fuzz pre')
    const hello = (extra: Record<string, unknown>): string =>
      JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, deviceId: pair.deviceId, ephPk: toB64(null, generateIdentity().publicKey), ...extra })
    const frames: Array<() => Array<string | Buffer>> = [
      () => [randomBytes(Math.floor(r() * 400))],
      () => [JSON.stringify(randomJsonValue(r))],
      () => [hello({ v: randomJsonValue(r) })],
      () => [hello({ deviceId: randomJsonValue(r) })],
      () => [hello({ ephPk: randomJsonValue(r) })],
      () => [hello({ t: randomJsonValue(r) })],
      () => [hello({}), hello({})],
      () => [hello({}), JSON.stringify({ t: 'hdr', hdr: randomJsonValue(r) })],
      () => [hello({}), JSON.stringify({ t: 'hdr', hdr: toB64(null, randomBytes(Math.floor(r() * 40))) }), randomBytes(Math.floor(r() * 300))],
      () => [JSON.stringify({ t: 'hdr', hdr: 'AAAA' })],
      () => [JSON.stringify({ t: 'pair', v: 1, sealed: randomJsonValue(r) })],
      () => [JSON.stringify({ t: 'pair', v: 1, sealed: toB64(null, randomBytes(Math.floor(r() * 200))) })],
      () => ['{"t":"hello"', '\u0000\u0001', Buffer.alloc(0)],
      () => [Buffer.alloc(2 * 1024 * 1024, 0x41)], // over the payload cap
      () => ['x'.repeat(3 * 1024 * 1024)],
    ]
    for (let i = 0; i < 360; i++) {
      // Mostly the device socket; the pairing socket takes the same junk.
      const ws = await open(i % 4 === 3 ? '/pair' : '/connect').catch(() => null)
      if (!ws) {
        await wait(30)
        continue
      }
      for (const f of frames[i % frames.length]!()) {
        if (ws.readyState !== WebSocket.OPEN) break
        try {
          ws.send(f)
        } catch {
          break
        }
      }
      await Promise.race([closed(ws, 120), wait(120)])
      ws.terminate()
      await closed(ws, 200)
    }
    await wait(100)
    expect(unhandled).toEqual([])
    // Still serving a real phone.
    const c = await h.connect(pair)
    expect(((await c.rpc('remote.health')) as { gatewayConnected: boolean }).gatewayConnected).toBe(true)
    c.disconnect()
  }, 120_000)

  /** A raw device-side session: real handshake and auth, then hand-built frames. */
  async function session(pair: PairResult): Promise<{ ws: WebSocket; ch: SecureChannel; send: (v: unknown) => void; sendRaw: (b: Uint8Array) => void }> {
    const ws = await open()
    const eph = generateIdentity()
    let ch: SecureChannel | null = null
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('handshake timeout')), 4000)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const f = JSON.parse(data.toString()) as Record<string, unknown>
        if (f.t === 'hello_ack') {
          const keys = deriveSessionKeys(null, 'device', { myEphemeral: eph, theirEphemeralPk: fromB64(null, String(f.ephPk)), myStatic: pair.identity, theirStaticPk: pair.hostPublicKey })
          ch = SecureChannel.create(null, keys, { acceptCompressed: true })
          ws.send(JSON.stringify({ t: 'hdr', hdr: toB64(null, ch.startSend()) }))
        } else if (f.t === 'hdr' && ch) {
          ch.startReceive(fromB64(null, String(f.hdr)))
          clearTimeout(t)
          resolve()
        }
      })
    })
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, deviceId: pair.deviceId, ephPk: toB64(null, eph.publicKey) }))
    await ready
    const channel = ch as SecureChannel | null
    if (!channel) throw new Error('no channel')
    const sendRaw = (b: Uint8Array): void => ws.send(Buffer.from(b))
    const send = (v: unknown): void => sendRaw(channel.seal(v))
    send({ t: 'auth', caps: [CAP_DEFLATE] })
    return { ws, ch: channel, send, sendRaw }
  }

  it('survives garbage after the handshake (undecryptable frames, wrong channel use)', async () => {
    const r = rng(0xbadf00d)
    const pair = await h.pairApproved('Fuzz post A')
    for (let i = 0; i < 80; i++) {
      const s = await session(pair)
      const kind = i % 5
      if (kind === 0) s.sendRaw(randomBytes(Math.floor(r() * 500)))
      else if (kind === 1) s.ws.send(JSON.stringify({ t: 'hdr', hdr: toB64(null, randomBytes(24)) })) // replayed header
      else if (kind === 2) s.ws.send(JSON.stringify(randomJsonValue(r)))
      else if (kind === 3) {
        const good = s.ch.seal({ t: 'ping', ts: 1 })
        good[Math.floor(r() * good.length)]! ^= 1 << Math.floor(r() * 8) // one flipped bit
        s.sendRaw(good)
      } else s.sendRaw(new Uint8Array(0))
      await Promise.race([closed(s.ws, 400), wait(150)])
      s.ws.terminate()
    }
    expect(unhandled).toEqual([])
    const c = await h.connect(pair)
    expect(c.state).toBe('ready')
    c.disconnect()
  }, 120_000)

  it('survives thousands of authenticated envelopes with random methods and params', async () => {
    const r = rng(0x5eed)
    const pair = await h.pairApproved('Fuzz post B', [...SCOPES])
    const methods = methodsForScopes([...SCOPES])
    const randomMethod = (): unknown =>
      r() < 0.8 ? methods[Math.floor(r() * methods.length)] : r() < 0.5 ? ['', '__proto__', 'remote.', 'shell.' + 'x'.repeat(50), 'tool.approve\n'][Math.floor(r() * 5)] : randomJsonValue(r)
    let sent = 0
    let answered = 0
    for (let round = 0; round < 60; round++) {
      const s = await session(pair)
      s.ws.on('message', (_d, isBinary) => {
        if (isBinary) answered++
      })
      for (let i = 0; i < 250; i++) {
        const kind = r()
        if (kind < 0.85) s.send({ t: 'rpc', id: Math.floor(r() * 1e6), method: randomMethod(), params: randomJsonValue(r) })
        else if (kind < 0.93) s.send({ t: 'rpc', id: randomJsonValue(r), method: randomMethod(), params: randomJsonValue(r) })
        else if (kind < 0.97) s.send(randomJsonValue(r))
        else s.send({ t: ['ping', 'auth', 'rpc', 'event', 'pong', 'x', null, 5][Math.floor(r() * 8)], ts: randomJsonValue(r), ...(randomJsonValue(r) as object) })
        sent++
        if (s.ws.readyState !== WebSocket.OPEN) break
        if (i % 25 === 0) await wait(5)
      }
      await wait(60)
      s.ws.terminate()
    }
    // A floor, not a target: the bridge may close a connection early on abuse, so timing decides how many frames get in.
    expect(sent).toBeGreaterThan(1000)
    expect(answered).toBeGreaterThan(100) // the dispatcher really ran (rpc_res frames came back)
    expect(unhandled).toEqual([])
    const c = await h.connect(pair)
    await until(() => c.state === 'ready', 3000, 'ready after fuzz')
    expect(((await c.rpc('remote.health')) as { gatewayConnected: boolean }).gatewayConnected).toBe(true)
    c.disconnect()
  }, 180_000)
})
