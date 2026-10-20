/**
 * Regression for the self-test loop after the security release: the bridge's own probe
 * (auth frame, then selftest frame) failed with "unexpected first frame" because an auth
 * frame reached the bridge as a device's first frame. These run against the REAL Room
 * (wrangler dev / workerd) with the host NOT enforcing (the transition period).
 */
import { MuxKind, decodeMux, newRelayToken, relayAuthFrame, relayTokenHash } from '@dorabot-remote/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDevServer, type DevServer } from './dev-server.js'
import { Peer, connectHost, newIdentity } from './peer.js'

let dev: DevServer
const peers: Peer[] = []
let ipSeq = 0
beforeAll(async () => {
  dev = await startDevServer()
})
afterAll(async () => {
  for (const p of peers) p.close()
  await dev?.stop()
})

const quiet = (ms = 800) => new Promise((r) => setTimeout(r, ms))
async function setup(tokens: string[]) {
  const id = newIdentity()
  const h = await connectHost(dev.ws, id)
  peers.push(h)
  h.send(JSON.stringify({ t: 'tokens', set: tokens.map(relayTokenHash), tickets: [], enforce: false }))
  h.send('{"t":"hb"}')
  await h.nextWhere((m) => !m.isBinary && m.data === '{"t":"hb_ack"}')
  const device = async (): Promise<Peer> => {
    const d = new Peer(`${dev.ws}/d/${id.relayId}`, { headers: { 'CF-Connecting-IP': `10.7.0.${ipSeq++ & 255}` } })
    peers.push(d)
    await d.opened()
    return d
  }
  /** What the host has been told, in order: [kind, text payload]. */
  const seen = () => h.queue.filter((m) => m.isBinary).map((m) => decodeMux(m.data as Uint8Array)!).map((f) => [f.kind, new TextDecoder().decode(f.payload)] as const)
  return { h, device, seen }
}

describe('real Room, host not enforcing', () => {
  it("self-test probe: the host sees open then ONLY the selftest frame (the auth frame is consumed)", async () => {
    const tok = newRelayToken()
    const { device, seen } = await setup([tok])
    const d = await device()
    // Exactly what RelayClient.runSelfTest sends, back to back.
    d.send(relayAuthFrame(tok))
    d.send('{"t":"selftest","n":"abc"}')
    await quiet()
    expect(seen()).toEqual([
      [MuxKind.open, ''],
      [MuxKind.text, '{"t":"selftest","n":"abc"}'],
    ])
    expect(d.closed).toBeNull()
  })

  it('a device that presents a wrong token is refused and the host is NEVER told about it', async () => {
    const { device, seen } = await setup([newRelayToken()])
    const d = await device()
    d.send(relayAuthFrame(newRelayToken()))
    expect((await d.waitClosed()).code).toBe(4401)
    await quiet()
    expect(seen()).toEqual([])
  })

  it('a token-less device that speaks first is admitted, announced before its frame', async () => {
    const { device, seen } = await setup([newRelayToken()])
    const d = await device()
    d.send('{"t":"hello"}')
    await quiet()
    expect(seen()).toEqual([
      [MuxKind.open, ''],
      [MuxKind.text, '{"t":"hello"}'],
    ])
  })

  it('a silent token-less device is still admitted (after the short grace period)', async () => {
    const { device, seen } = await setup([])
    await device()
    await quiet(1500)
    expect(seen()).toEqual([[MuxKind.open, '']])
  })

  it('an auth frame with a valid token after a first frame is still consumed, not forwarded', async () => {
    const tok = newRelayToken()
    const { device, seen } = await setup([tok])
    const d = await device()
    d.send('{"t":"hello"}')
    d.send(relayAuthFrame(tok))
    await quiet()
    expect(seen()).toEqual([
      [MuxKind.open, ''],
      [MuxKind.text, '{"t":"hello"}'],
    ])
  })
})
