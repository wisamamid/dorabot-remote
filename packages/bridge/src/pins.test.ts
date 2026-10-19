import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClient, decodePairingPayload, pairWithHost, type PairResult } from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge } from './bridge.js'
import { FakeGateway } from '../test/fake-gateway.js'
import { loadSettings, resolvePaths } from './config.js'
import { Store } from './store.js'

const PORT = 7863
const SOCK = join(tmpdir(), `dr-fake-gw-pins-${process.pid}.sock`)
const createSocket = (url: string) => new WebSocket(url) as never
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Store pins', () => {
  it('pins, unpins, orders newest first and is idempotent', async () => {
    const s = new Store(':memory:')
    expect(s.listPins()).toEqual([])
    expect(s.setPin('a:dm:1', true)).toBe(true)
    await wait(5)
    expect(s.setPin('b:dm:2', true)).toBe(true)
    expect(s.setPin('a:dm:1', true)).toBe(false)
    expect(s.listPins().map((p) => p.id)).toEqual(['b:dm:2', 'a:dm:1'])
    expect(s.setPin('a:dm:1', false)).toBe(true)
    expect(s.setPin('a:dm:1', false)).toBe(false)
    expect(s.listPins().map((p) => p.id)).toEqual(['b:dm:2'])
    s.close()
  })

  it('prunes pins that are not kept', () => {
    const s = new Store(':memory:')
    s.setPin('a:dm:1', true)
    s.setPin('b:dm:2', true)
    expect(s.prunePins(new Set(['a:dm:1']))).toBe(1)
    expect(s.listPins().map((p) => p.id)).toEqual(['a:dm:1'])
    s.close()
  })
})

describe('remote.pins.*', () => {
  let bridge: Bridge
  let gateway: FakeGateway
  let home: string
  const clients: RemoteClient[] = []

  async function connect(scopes?: string[]): Promise<{ c: RemoteClient; ev: Array<{ event: string; data: any }> }> {
    const { uri } = bridge.newPairingPayload(scopes as never)
    const p: PairResult = await pairWithHost({ payload: decodePairingPayload(uri), deviceName: 'T', platform: 'ios', createSocket })
    const ev: Array<{ event: string; data: any }> = []
    const c = new RemoteClient({
      identity: p.identity,
      deviceId: p.deviceId,
      hostPublicKey: p.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (event, data) => ev.push({ event, data }),
    })
    clients.push(c)
    c.connect()
    for (let i = 0; i < 200 && c.state !== 'ready'; i++) await wait(20)
    return { c, ev }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dorabot-remote-pins-'))
    gateway = new FakeGateway()
    const paths = resolvePaths({
      root: home,
      db: join(home, 'bridge.db'),
      identity: join(home, 'host-key.json'),
      settings: join(home, 'settings.json'),
      gatewaySocket: SOCK,
      gatewayToken: join(home, 'gateway-token'),
    })
    writeFileSync(paths.gatewayToken, 'c'.repeat(64))
    await gateway.start(SOCK, 'c'.repeat(64))
    const settings = loadSettings(paths)
    settings.port = PORT
    settings.bind = '127.0.0.1'
    bridge = new Bridge({ paths, settings })
    await bridge.start()
    await wait(400)
  }, 30_000)

  afterAll(async () => {
    for (const c of clients) c.disconnect()
    await bridge?.stop()
    await gateway?.stop()
    rmSync(home, { recursive: true, force: true })
  })

  it('sets, lists and broadcasts to every device', async () => {
    const a = await connect()
    const b = await connect()
    const res = await a.c.rpc<{ pins: Array<{ id: string; pinnedAt: number }> }>('remote.pins.set', { id: 'desktop:dm:abc', pinned: true })
    expect(res.pins.map((p) => p.id)).toEqual(['desktop:dm:abc'])
    await wait(150)
    for (const side of [a, b]) {
      const e = side.ev.find((x) => x.event === 'remote.pins_changed')
      expect(e?.data.pins.map((p: { id: string }) => p.id)).toEqual(['desktop:dm:abc'])
    }
    // no-op set does not broadcast again
    const before = b.ev.filter((x) => x.event === 'remote.pins_changed').length
    await a.c.rpc('remote.pins.set', { id: 'desktop:dm:abc', pinned: true })
    await wait(100)
    expect(b.ev.filter((x) => x.event === 'remote.pins_changed').length).toBe(before)
    const list = await b.c.rpc<Array<{ id: string }>>('remote.pins.list')
    expect(list.map((p) => p.id)).toEqual(['desktop:dm:abc'])
    await a.c.rpc('remote.pins.set', { id: 'desktop:dm:abc', pinned: false })
    expect(await b.c.rpc('remote.pins.list')).toEqual([])
  })

  it('rejects malformed input and devices without the sessions scope', async () => {
    const a = await connect()
    await expect(a.c.rpc('remote.pins.set', { id: 'nope', pinned: true })).rejects.toThrow()
    await expect(a.c.rpc('remote.pins.set', { id: 'a:dm:1', pinned: 'yes' })).rejects.toThrow()
    const limited = await connect(['chat'])
    await expect(limited.c.rpc('remote.pins.list')).rejects.toThrow(/sessions/)
  })

  it('prunes pins for sessions the gateway no longer lists', async () => {
    const a = await connect()
    gateway.overrides.set('sessions.list', [{ id: 'sid-1', channel: 'desktop', chatType: 'dm', chatId: 'abc' }])
    await a.c.rpc('remote.pins.set', { id: 'desktop:dm:abc', pinned: true })
    await a.c.rpc('remote.pins.set', { id: 'desktop:dm:gone', pinned: true })
    const list = await a.c.rpc<Array<{ id: string }>>('remote.pins.list')
    expect(list.map((p) => p.id)).toEqual(['desktop:dm:abc'])
    gateway.overrides.delete('sessions.list')
    await a.c.rpc('remote.pins.set', { id: 'desktop:dm:abc', pinned: false })
  })
})
