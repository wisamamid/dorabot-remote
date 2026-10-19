import {
  MuxKind,
  decodeMux,
  decodeMuxClose,
  encodeMux,
  encodeMuxClose,
  encodeMuxText,
  fromUtf8,
  generateSigningKey,
  relayIdFromPublicKey,
  signBytes,
  signChallenge,
} from '@dorabot-remote/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDevServer, type DevServer } from './dev-server.js'
import { Peer, connectHost, newIdentity } from './peer.js'

let dev: DevServer
const peers: Peer[] = []
const track = (p: Peer): Peer => {
  peers.push(p)
  return p
}

beforeAll(async () => {
  dev = await startDevServer()
})
afterAll(async () => {
  for (const p of peers) p.close()
  await dev?.stop()
})

const host = async (id = newIdentity()) => ({ id, peer: track(await connectHost(dev.ws, id)) })
const device = async (relayId: string): Promise<Peer> => {
  const d = track(new Peer(`${dev.ws}/d/${relayId}`))
  await d.opened()
  return d
}
/** The host sees `open` for each device; returns its connId. */
const expectOpen = async (h: Peer): Promise<number> => {
  const f = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
  expect(f.kind).toBe(MuxKind.open)
  return f.connId
}

describe('http surface', () => {
  it('serves /health and 404s malformed ids before touching a room', async () => {
    expect(await (await fetch(`${dev.http}/health`)).text()).toBe('ok')
    await expect(track(new Peer(`${dev.ws}/h/short`)).opened()).rejects.toThrow('404')
    await expect(track(new Peer(`${dev.ws}/d/${'a'.repeat(23)}`)).opened()).rejects.toThrow('404')
    expect((await fetch(`${dev.http}/nope`)).status).toBe(404)
  })
})

describe('host auth', () => {
  it('accepts a correctly signed challenge', async () => {
    const { peer } = await host()
    expect(peer.closed).toBeNull()
  })

  it('closes 4401 on a bad signature', async () => {
    const id = newIdentity()
    const h = track(new Peer(`${dev.ws}/h/${id.relayId}`))
    await h.opened()
    const ch = JSON.parse((await h.next()).data as string) as { n: string }
    const forged = signChallenge(generateSigningKey(), id.relayId, ch.n)
    h.send(JSON.stringify({ t: 'auth', ...forged }))
    expect((await h.waitClosed()).code).toBe(4401)
  })

  it('closes 4401 when the key does not own the relayId', async () => {
    const id = newIdentity()
    const other = generateSigningKey()
    const h = track(new Peer(`${dev.ws}/h/${id.relayId}`))
    await h.opened()
    const ch = JSON.parse((await h.next()).data as string) as { n: string }
    // A perfectly valid signature, but by a key that hashes to a different id.
    h.send(JSON.stringify({ t: 'auth', ...signChallenge(other, id.relayId, ch.n) }))
    expect((await h.waitClosed()).code).toBe(4401)
  })

  it('closes 4401 on garbage', async () => {
    const id = newIdentity()
    const h = track(new Peer(`${dev.ws}/h/${id.relayId}`))
    await h.opened()
    await h.next()
    h.send('not json')
    expect((await h.waitClosed()).code).toBe(4401)
  })

  it('closes 4401 if the host never answers', async () => {
    const id = newIdentity()
    const h = track(new Peer(`${dev.ws}/h/${id.relayId}`))
    await h.opened()
    await h.next()
    expect((await h.waitClosed(15_000)).code).toBe(4401)
  }, 20_000)

  it('routes nothing until authenticated', async () => {
    const id = newIdentity()
    const h = track(new Peer(`${dev.ws}/h/${id.relayId}`))
    await h.opened()
    await h.next()
    const d = await device(id.relayId)
    expect((await d.waitClosed()).code).toBe(4404)
  })
})

describe('routing', () => {
  it('closes a device 4404 host_offline when there is no host', async () => {
    const d = await device(newIdentity().relayId)
    expect(await d.waitClosed()).toEqual({ code: 4404, reason: 'host_offline' })
  })

  it('forwards device frames to the host and back, text and binary', async () => {
    const { id, peer: h } = await host()
    const d = await device(id.relayId)
    const connId = await expectOpen(h)

    d.send('{"t":"hello"}')
    const t = decodeMux((await h.next()).data as Uint8Array)!
    expect([t.kind, t.connId, fromUtf8(null, t.payload)]).toEqual([MuxKind.text, connId, '{"t":"hello"}'])

    d.send(new Uint8Array([9, 8, 7]))
    const b = decodeMux((await h.next()).data as Uint8Array)!
    expect([b.kind, b.connId, [...b.payload]]).toEqual([MuxKind.binary, connId, [9, 8, 7]])

    h.send(encodeMuxText(connId, 'héllo'))
    const back = await d.next()
    expect([back.isBinary, back.data]).toEqual([false, 'héllo'])

    h.send(encodeMux(MuxKind.binary, connId, new Uint8Array([1, 2, 3, 4])))
    const bin = await d.next()
    expect(bin.isBinary).toBe(true)
    expect([...(bin.data as Uint8Array)]).toEqual([1, 2, 3, 4])
  })

  it('keeps devices separate', async () => {
    const { id, peer: h } = await host()
    const d1 = await device(id.relayId)
    const c1 = await expectOpen(h)
    const d2 = await device(id.relayId)
    const c2 = await expectOpen(h)
    expect(c1).not.toBe(c2)
    h.send(encodeMuxText(c2, 'only-two'))
    expect((await d2.next()).data).toBe('only-two')
    expect(d1.queue.length).toBe(0)
  })

  it('tells the host when a device leaves, and closes a device on the host\'s request', async () => {
    const { id, peer: h } = await host()
    const d1 = await device(id.relayId)
    const c1 = await expectOpen(h)
    d1.ws.close(1000, 'bye')
    const f = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
    expect(f.kind).toBe(MuxKind.close)
    expect(f.connId).toBe(c1)
    expect(decodeMuxClose(f.payload).code).toBe(1000)

    const d2 = await device(id.relayId)
    const c2 = await expectOpen(h)
    h.send(encodeMuxClose(c2, 4101, 'nope'))
    expect(await d2.waitClosed()).toEqual({ code: 4101, reason: 'nope' })
  })

  it('closes every device 4404 when the host disconnects', async () => {
    const { id, peer: h } = await host()
    const d = await device(id.relayId)
    await expectOpen(h)
    h.close()
    expect((await d.waitClosed()).code).toBe(4404)
    const late = await device(id.relayId)
    expect((await late.waitClosed()).code).toBe(4404)
  })

  it('lets a new host replace the old one', async () => {
    const { id, peer: oldHost } = await host()
    const d = await device(id.relayId)
    await expectOpen(oldHost)

    const newHost = track(await connectHost(dev.ws, id))
    expect((await oldHost.waitClosed()).code).toBe(4000)
    expect((await d.waitClosed()).code).toBe(4404)

    const d2 = await device(id.relayId)
    const c = await expectOpen(newHost)
    newHost.send(encodeMuxText(c, 'hi'))
    expect((await d2.next()).data).toBe('hi')
  })

  it('does not leak between rooms', async () => {
    const a = await host()
    const b = await host()
    const d = await device(a.id.relayId)
    await expectOpen(a.peer)
    d.send('secret')
    await new Promise((r) => setTimeout(r, 300))
    expect(b.peer.queue.length).toBe(0)
  })
})

describe('limits', () => {
  it('closes 1009 on an oversize frame', async () => {
    const { id, peer: h } = await host()
    const d = await device(id.relayId)
    await expectOpen(h)
    d.send(new Uint8Array(1024 * 1024 + 1))
    expect((await d.waitClosed()).code).toBe(1009)
  })

  it('closes 4429 when a device floods', async () => {
    const { id, peer: h } = await host()
    const d = await device(id.relayId)
    await expectOpen(h)
    for (let i = 0; i < 400; i++) d.send('x')
    expect((await d.waitClosed()).code).toBe(4429)
  })

  it('caps a room at 32 devices', async () => {
    const { id, peer: h } = await host()
    const devs: Peer[] = []
    for (let i = 0; i < 32; i++) {
      devs.push(await device(id.relayId))
      await expectOpen(h)
    }
    const extra = await device(id.relayId)
    expect((await extra.waitClosed()).code).toBe(4429)
    expect(devs.every((d) => d.closed === null)).toBe(true)
  }, 60_000)
})

describe('push route', () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ token: 'tok-12345678', platform: 'ios', kind: 'question', rid: 'r1', ts: Date.now(), ...over })
  const post = (relayId: string, raw: string, headers: Record<string, string>) =>
    fetch(`${dev.http}/push/${relayId}`, { method: 'POST', body: raw, headers })

  it('returns 503 push_not_configured for a correctly signed request', async () => {
    const id = newIdentity()
    const raw = body()
    const res = await post(id.relayId, raw, headerFor(id.key, raw))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'push_not_configured' })
  })

  it('rejects a bad signature, a foreign key and a stale timestamp', async () => {
    const id = newIdentity()
    const raw = body()
    expect((await post(id.relayId, raw, headerFor(generateSigningKey(), raw))).status).toBe(401)
    expect((await post(id.relayId, raw + ' ', headerFor(id.key, raw))).status).toBe(401)
    expect((await post(id.relayId, raw, {})).status).toBe(401)
    const stale = body({ ts: Date.now() - 120_000 })
    expect((await post(id.relayId, stale, headerFor(id.key, stale))).status).toBe(400)
    const other = relayIdFromPublicKey(generateSigningKey().publicKey)
    expect((await post(other, raw, headerFor(id.key, raw))).status).toBe(401)
  })
})

function headerFor(key: ReturnType<typeof generateSigningKey>, raw: string): Record<string, string> {
  const { pk, sig } = signBytes(key, new TextEncoder().encode(raw))
  return { 'x-dr-pk': pk, 'x-dr-sig': sig }
}

describe('host liveness', () => {
  it('answers the application heartbeat itself and does not forward it', async () => {
    const { id, peer: h } = await host()
    h.send('{"t":"hb"}')
    const r = await h.nextWhere((m) => !m.isBinary)
    expect(r.data).toBe('{"t":"hb_ack"}')
    // A device is still opened normally: the heartbeat stamped liveness, nothing else changed.
    const d = await device(id.relayId)
    await expectOpen(h)
    d.close()
  })

  it('keeps a host alive that heartbeats, and drops nothing for one that is merely idle < threshold', async () => {
    const { id, peer: h } = await host()
    await new Promise((r) => setTimeout(r, 1500))
    const d = await device(id.relayId)
    await expectOpen(h)
    d.close()
  })
})

describe('stale host (short threshold)', () => {
  let short: DevServer
  const sp: Peer[] = []
  const strack = (p: Peer): Peer => {
    sp.push(p)
    return p
  }
  beforeAll(async () => {
    short = await startDevServer(['--var', 'HOST_STALE_MS:2500'])
  })
  afterAll(async () => {
    for (const p of sp) p.close()
    await short?.stop()
  })

  it('rejects a device 4404 when the host has stopped heartbeating, and logs host_stale', async () => {
    const id = newIdentity()
    const h = strack(await connectHost(short.ws, id))
    h.send('{"t":"hb"}')
    await h.nextWhere((m) => !m.isBinary)
    await new Promise((r) => setTimeout(r, 3500))
    const d = strack(new Peer(`${short.ws}/d/${id.relayId}`))
    await d.opened()
    expect(await d.waitClosed()).toEqual({ code: 4404, reason: 'host_offline' })
    // The zombie host is closed so the bridge reconnects.
    expect((await h.waitClosed()).reason).toBe('host_stale')
  }, 20_000)

  it('serves a host again once it heartbeats, and prefers it over a stale one', async () => {
    const id = newIdentity()
    const h1 = strack(await connectHost(short.ws, id))
    await new Promise((r) => setTimeout(r, 3000))
    // h1 is silent past the threshold; a fresh host takes over.
    const h2 = strack(await connectHost(short.ws, id))
    h2.send('{"t":"hb"}')
    await h2.nextWhere((m) => !m.isBinary)
    const d = strack(new Peer(`${short.ws}/d/${id.relayId}`))
    await d.opened()
    await expectOpen(h2)
    expect(h1.closed ?? (await h1.waitClosed()).code).toBeTruthy()
    d.close()
  }, 20_000)

  it('a heartbeating host stays serviceable well past the threshold', async () => {
    const id = newIdentity()
    const h = strack(await connectHost(short.ws, id))
    for (let i = 0; i < 5; i++) {
      h.send('{"t":"hb"}')
      await new Promise((r) => setTimeout(r, 1000))
    }
    const d = strack(new Peer(`${short.ws}/d/${id.relayId}`))
    await d.opened()
    await expectOpen(h)
    d.close()
  }, 20_000)
})
