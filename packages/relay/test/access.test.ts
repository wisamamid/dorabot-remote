import { MuxKind, decodeMux, encodeMuxClose, relayAuthFrame, relayTokenHash, relayTokenProtocol, newRelayToken } from '@dorabot-remote/protocol'
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
const rawDevice = async (relayId: string, opts?: ConstructorParameters<typeof Peer>[1]): Promise<Peer> => {
  const d = track(new Peer(`${dev.ws}/d/${relayId}`, opts))
  await d.opened()
  return d
}
const setTokens = (h: Peer, toks: string[], o: { tickets?: string[]; enforce?: boolean } = {}): Promise<void> => {
  h.send(JSON.stringify({ t: 'tokens', set: toks.map(relayTokenHash), tickets: (o.tickets ?? []).map(relayTokenHash), enforce: o.enforce ?? true }))
  // The room handles frames in order; a heartbeat round trip proves the tokens frame was applied.
  h.send('{"t":"hb"}')
  return h.nextWhere((m) => !m.isBinary && m.data === '{"t":"hb_ack"}').then(() => new Promise((r) => setTimeout(r, 100)))
}
const binaries = (h: Peer) => h.queue.filter((m) => m.isBinary).map((m) => decodeMux(m.data as Uint8Array)!)
const quiet = (ms = 600) => new Promise((r) => setTimeout(r, ms))

describe('token enforcement', () => {
  it('lets a valid token in, and only then tells the host', async () => {
    const { id, peer: h } = await host()
    const tok = newRelayToken()
    await setTokens(h, [tok])
    const d = await rawDevice(id.relayId)
    await quiet()
    expect(binaries(h)).toHaveLength(0)
    d.send(relayAuthFrame(tok))
    const open = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
    expect(open.kind).toBe(MuxKind.open)
    d.send('{"t":"hello"}')
    const f = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
    expect(f.kind).toBe(MuxKind.text)
    expect(new TextDecoder().decode(f.payload)).toBe('{"t":"hello"}')
  })

  it('rejects a wrong token, a missing token and a non-auth first frame with 4401, never telling the host', async () => {
    const { id, peer: h } = await host()
    await setTokens(h, [newRelayToken()])
    const wrong = await rawDevice(id.relayId)
    wrong.send(relayAuthFrame(newRelayToken()))
    expect((await wrong.waitClosed()).code).toBe(4401)
    const none = await rawDevice(id.relayId)
    none.send('{"t":"hello"}')
    expect((await none.waitClosed()).code).toBe(4401)
    await quiet()
    expect(binaries(h)).toHaveLength(0)
  })

  it('accepts a token in Sec-WebSocket-Protocol and rejects a wrong one', async () => {
    const { id, peer: h } = await host()
    const tok = newRelayToken()
    await setTokens(h, [tok])
    await rawDevice(id.relayId, { protocols: [relayTokenProtocol(tok)] })
    expect(decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!.kind).toBe(MuxKind.open)
    const bad = await rawDevice(id.relayId, { protocols: [relayTokenProtocol(newRelayToken())] })
    expect((await bad.waitClosed()).code).toBe(4401)
    expect(binaries(h)).toHaveLength(0)
  })

  it('closes an unauthenticated device socket after 5s, without telling the host', async () => {
    const { id, peer: h } = await host()
    await setTokens(h, [newRelayToken()])
    const t0 = Date.now()
    const d = await rawDevice(id.relayId)
    const c = await d.waitClosed(9000)
    expect(c.code).toBe(4401)
    expect(Date.now() - t0).toBeGreaterThan(4000)
    expect(binaries(h)).toHaveLength(0)
  }, 15_000)

  it('removing a token from the set drops that device at once and tells the host', async () => {
    const { id, peer: h } = await host()
    const a = newRelayToken()
    const b = newRelayToken()
    await setTokens(h, [a, b])
    const da = await rawDevice(id.relayId)
    da.send(relayAuthFrame(a))
    const connA = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!.connId
    const db = await rawDevice(id.relayId)
    db.send(relayAuthFrame(b))
    await h.nextWhere((m) => m.isBinary)
    await setTokens(h, [b])
    expect((await da.waitClosed()).code).toBe(4401)
    const close = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
    expect(close.kind).toBe(MuxKind.close)
    expect(close.connId).toBe(connA)
    expect(db.closed).toBeNull()
    // And the revoked token no longer gets in.
    const again = await rawDevice(id.relayId)
    again.send(relayAuthFrame(a))
    expect((await again.waitClosed()).code).toBe(4401)
  })

  it('a pairing ticket works once, and its socket survives the ticket being dropped from the set', async () => {
    const { id, peer: h } = await host()
    const ticket = newRelayToken()
    await setTokens(h, [], { tickets: [ticket] })
    const d = await rawDevice(id.relayId)
    d.send(relayAuthFrame(ticket))
    await h.nextWhere((m) => m.isBinary)
    // The bridge re-sends the set (ticket included, it does not know it was used): must not resurrect it.
    await setTokens(h, [], { tickets: [ticket] })
    const second = await rawDevice(id.relayId)
    second.send(relayAuthFrame(ticket))
    expect((await second.waitClosed()).code).toBe(4401)
    await setTokens(h, [], { tickets: [] })
    expect(d.closed).toBeNull()
    d.send('{"t":"pair"}')
    const f = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
    expect(f.kind).toBe(MuxKind.text)
  })

  it('an unknown ticket is refused', async () => {
    const { id, peer: h } = await host()
    await setTokens(h, [], { tickets: [newRelayToken()] })
    const d = await rawDevice(id.relayId)
    d.send(relayAuthFrame(newRelayToken()))
    expect((await d.waitClosed()).code).toBe(4401)
  })

  it('ignores a tokens frame from anything but the authenticated host, and survives garbage', async () => {
    const id = newIdentity()
    const junk = track(new Peer(`${dev.ws}/h/${id.relayId}`))
    await junk.opened()
    await junk.next()
    junk.send(JSON.stringify({ t: 'tokens', set: [], enforce: true }))
    expect((await junk.waitClosed()).code).toBe(4401)
    const h = track(await connectHost(dev.ws, id))
    h.send('{"t":"tokens","set":"nope","enforce":1}')
    const d = await rawDevice(id.relayId)
    // enforce was not literally true, so legacy access is unchanged.
    expect((await h.nextWhere((m) => m.isBinary)).isBinary).toBe(true)
    d.close()
  })
})

describe('transition (enforcement off)', () => {
  it('lets a token-less device in until the host enforces, then drops it and refuses new ones', async () => {
    const { id, peer: h } = await host()
    const tok = newRelayToken()
    await setTokens(h, [tok], { enforce: false })
    const legacy = await rawDevice(id.relayId)
    expect(decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!.kind).toBe(MuxKind.open)
    legacy.send('{"t":"hello"}')
    expect(decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!.kind).toBe(MuxKind.text)

    // A wrong token is refused even while not enforcing.
    const wrong = await rawDevice(id.relayId)
    wrong.send(relayAuthFrame(newRelayToken()))
    expect((await wrong.waitClosed()).code).toBe(4401)

    // A device with a good token can still send its auth frame; it is consumed, not forwarded.
    const modern = await rawDevice(id.relayId)
    modern.send(relayAuthFrame(tok))
    modern.send('{"t":"hello2"}')
    const seen: string[] = []
    for (;;) {
      const f = decodeMux((await h.nextWhere((m) => m.isBinary)).data as Uint8Array)!
      if (f.kind === MuxKind.text) {
        seen.push(new TextDecoder().decode(f.payload))
        break
      }
    }
    expect(seen).toEqual(['{"t":"hello2"}'])

    await setTokens(h, [tok], { enforce: true })
    expect((await legacy.waitClosed()).code).toBe(4401)
    expect(modern.closed).toBeNull()
    const late = await rawDevice(id.relayId)
    late.send('{"t":"hello"}')
    expect((await late.waitClosed()).code).toBe(4401)
  })
})

describe('host DoS', () => {
  it('an authenticating host evicts junk pending sockets, even past the pending cap', async () => {
    const id = newIdentity()
    const junk: Peer[] = []
    for (let i = 0; i < 8; i++) {
      const j = track(new Peer(`${dev.ws}/h/${id.relayId}`))
      await j.opened()
      junk.push(j)
    }
    const h = track(await connectHost(dev.ws, id))
    for (const j of junk) expect((await j.waitClosed()).code).toBeGreaterThan(4000)
    expect(h.closed).toBeNull()
  })
})

describe('per-IP limits', () => {
  const ipHdr = (ip: string) => ({ headers: { 'CF-Connecting-IP': ip } })

  it('caps concurrent device sockets per IP', async () => {
    const { id, peer: h } = await host()
    await setTokens(h, [], { enforce: false })
    const ds: Peer[] = []
    for (let i = 0; i < 8; i++) ds.push(await rawDevice(id.relayId, ipHdr('203.0.113.7')))
    const ninth = await rawDevice(id.relayId, ipHdr('203.0.113.7'))
    expect((await ninth.waitClosed()).code).toBe(4429)
    // Another IP is unaffected.
    await rawDevice(id.relayId, ipHdr('203.0.113.8'))
    expect(ds[0]!.closed).toBeNull()
  })

  it('rate limits connection attempts per IP with HTTP 429', async () => {
    const id = newIdentity()
    let refused = 0
    for (let i = 0; i < 24; i++) {
      const p = track(new Peer(`${dev.ws}/d/${id.relayId}`, ipHdr('198.51.100.9')))
      try {
        await p.opened()
      } catch (e) {
        if ((e as Error).message === 'http 429') refused++
      }
    }
    expect(refused).toBe(4)
    // A different IP still gets in.
    await rawDevice(id.relayId, ipHdr('198.51.100.10'))
  })
})
