/**
 * End-to-end test of the pairing and session protocol, against a real bridge
 * listening on a real port, driven by the exact client the phone app ships.
 *
 * A fake gateway stands in for dorabot so these run anywhere, including CI, with
 * no dorabot installed. The live smoke test against a real gateway is separate.
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClient, decodePairingPayload, pairWithHost, type PairResult } from '@dorabot-remote/protocol'
import { WebSocket, WebSocketServer } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge } from './bridge.js'
import { loadSettings, resolvePaths, type BridgePaths } from './config.js'

const PORT = 7861
const GATEWAY_SOCKET = join(tmpdir(), `dr-fake-gw-${process.pid}.sock`)

/**
 * A stand-in for the dorabot gateway: speaks the same auth handshake, answers a
 * few RPCs, and can push events on demand.
 */
class FakeGateway {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  calls: Array<{ method: string; params: Record<string, unknown> }> = []

  async start(socketPath: string, token: string): Promise<void> {
    rmSync(socketPath, { force: true })
    const server = createServer()
    const wss = new WebSocketServer({ server })

    wss.on('connection', (ws) => {
      let authed = false
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { id?: number; method: string; params?: Record<string, unknown> }
        if (!authed) {
          if (msg.method !== 'auth' || msg.params?.token !== token) {
            ws.send(JSON.stringify({ id: msg.id, error: 'invalid token' }))
            ws.close()
            return
          }
          authed = true
          this.clients.add(ws)
          // Same frame order as the real gateway: two events, then the reply.
          ws.send(JSON.stringify({ event: 'gateway.telemetry', data: { connect_id: 'conn-1' } }))
          ws.send(
            JSON.stringify({
              event: 'status.update',
              data: {
                running: true,
                sessions: [
                  { key: 'desktop:dm:abc', channel: 'desktop', chatType: 'dm', chatId: 'abc', sessionId: 'sid-1', messageCount: 2, lastMessageAt: Date.now(), activeRun: false },
                ],
              },
            }),
          )
          ws.send(JSON.stringify({ id: msg.id, result: { authenticated: true, connectId: 'conn-1' } }))
          return
        }

        this.calls.push({ method: msg.method, params: msg.params ?? {} })
        switch (msg.method) {
          case 'ping':
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true, timestamp: Date.now() } }))
            return
          case 'status':
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { running: true, sessions: [{ key: 'desktop:dm:abc', sessionId: 'sid-1' }] },
              }),
            )
            return
          case 'sessions.subscribe':
            ws.send(JSON.stringify({ id: msg.id, result: { subscribed: msg.params?.sessionKeys, replayCount: 0 } }))
            return
          case 'sessions.list':
            ws.send(JSON.stringify({ id: msg.id, result: [{ id: 'sid-1', messageCount: 2, createdAt: '', updatedAt: '' }] }))
            return
          case 'chat.send':
            ws.send(JSON.stringify({ id: msg.id, result: { sessionKey: 'desktop:dm:abc', sessionId: 'sid-1', queued: true } }))
            return
          case 'shell.spawn':
            ws.send(JSON.stringify({ id: msg.id, result: { spawned: true } }))
            return
          case 'config.set':
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
            return
          default:
            ws.send(JSON.stringify({ id: msg.id, error: `unknown method: ${msg.method}` }))
        }
      })
      ws.on('close', () => this.clients.delete(ws))
    })

    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    this.server = server
    this.wss = wss
  }

  push(event: string, data: unknown, seq?: number): void {
    const frame = JSON.stringify(seq === undefined ? { event, data } : { event, data, seq })
    for (const ws of this.clients) ws.send(frame)
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close()
    this.wss?.close()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    rmSync(GATEWAY_SOCKET, { force: true })
  }
}

const createSocket = (url: string) => new WebSocket(url) as never

let bridge: Bridge
let gateway: FakeGateway
let home: string
let paths: BridgePaths

async function freshPairing(scopes?: string[]): Promise<PairResult> {
  const { uri } = bridge.newPairingPayload(scopes as never)
  return pairWithHost({
    payload: decodePairingPayload(uri),
    deviceName: 'Test iPhone',
    platform: 'ios',
    createSocket,
  })
}

async function connectAs(pair: PairResult): Promise<RemoteClient> {
  const client = new RemoteClient({
    identity: pair.identity,
    deviceId: pair.deviceId,
    hostPublicKey: pair.hostPublicKey,
    addresses: [`127.0.0.1:${PORT}`],
    createSocket,
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 8000)
    const original = client.state
    void original
    const check = setInterval(() => {
      if (client.state === 'ready') {
        clearInterval(check)
        clearTimeout(timer)
        resolve()
      }
    }, 20)
    client.connect()
  })
  return client
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dorabot-remote-test-'))
  gateway = new FakeGateway()
  const token = 'a'.repeat(64)
  paths = resolvePaths({
    root: home,
    db: join(home, 'bridge.db'),
    identity: join(home, 'host-key.json'),
    settings: join(home, 'settings.json'),
    gatewaySocket: GATEWAY_SOCKET,
    gatewayToken: join(home, 'gateway-token'),
  })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(paths.gatewayToken, token)
  await gateway.start(GATEWAY_SOCKET, token)

  const settings = loadSettings(paths)
  settings.port = PORT
  settings.bind = '127.0.0.1'
  bridge = new Bridge({ paths, settings })
  await bridge.start()
  await new Promise((r) => setTimeout(r, 400))
}, 30_000)

afterAll(async () => {
  await bridge?.stop()
  await gateway?.stop()
  rmSync(home, { recursive: true, force: true })
})

describe('pairing', () => {
  it('pairs a device and grants only the default scopes', async () => {
    const pair = await freshPairing()
    expect(pair.deviceId).toBeTruthy()
    expect(pair.hostName).toBeTruthy()
    expect(pair.scopes.sort()).toEqual(['approvals', 'chat', 'sessions', 'work'])
    // Terminal is never granted at pairing time.
    expect(pair.scopes).not.toContain('terminal')
  })

  it('refuses to reuse a pairing code', async () => {
    const { uri } = bridge.newPairingPayload()
    const payload = decodePairingPayload(uri)
    await pairWithHost({ payload, deviceName: 'First', platform: 'ios', createSocket })
    await expect(
      pairWithHost({ payload, deviceName: 'Second', platform: 'ios', createSocket }),
    ).rejects.toThrow()
  })

  it('refuses an unknown pairing code', async () => {
    const { uri } = bridge.newPairingPayload()
    const payload = { ...decodePairingPayload(uri), c: 'ZZZZZZZZZZ' }
    await expect(pairWithHost({ payload, deviceName: 'Nope', platform: 'ios', createSocket })).rejects.toThrow()
  })
})

describe('connection', () => {
  it('completes the handshake and reports host state', async () => {
    const client = await connectAs(await freshPairing())
    expect(client.state).toBe('ready')
    expect(client.device?.name).toBe('Test iPhone')
    expect(client.gatewayConnected).toBe(true)
    client.disconnect()
  })

  it('rejects a device whose long-term key does not match the record', async () => {
    const pair = await freshPairing()
    const { generateIdentity } = await import('@dorabot-remote/protocol')
    const impostor = new RemoteClient({
      identity: generateIdentity(),
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
    })
    impostor.connect()
    await new Promise((r) => setTimeout(r, 1500))
    expect(impostor.state).not.toBe('ready')
    impostor.disconnect()
  })

  it('refuses a revoked device', async () => {
    const pair = await freshPairing()
    bridge.store.setRevoked(pair.deviceId, true)
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 1200))
    expect(client.state).not.toBe('ready')
    client.disconnect()
  })
})

describe('authorisation', () => {
  it('forwards a method inside the device scopes', async () => {
    const client = await connectAs(await freshPairing())
    const res = await client.rpc('chat.send', { prompt: 'hello' })
    expect(res).toMatchObject({ sessionKey: 'desktop:dm:abc' })
    client.disconnect()
  })

  it('refuses a method outside the device scopes, with a reason', async () => {
    const client = await connectAs(await freshPairing())
    await expect(client.rpc('git.push', {})).rejects.toThrow(/"git" permission/)
    client.disconnect()
  })

  it('refuses the terminal until the scope is granted', async () => {
    const pair = await freshPairing()
    const client = await connectAs(pair)
    await expect(client.rpc('shell.spawn', { shellId: 's1' })).rejects.toThrow(/"terminal" permission/)
    client.disconnect()
  })

  it('allows the terminal once the Mac grants it', async () => {
    const pair = await freshPairing()
    const client = await connectAs(pair)
    await client.rpc('remote.requestScope', { scope: 'terminal', reason: 'I need a shell' })
    const req = bridge.store.listScopeRequests('pending').find((r) => r.deviceId === pair.deviceId)
    expect(req).toBeTruthy()
    expect(bridge.applyScopeDecision(req!.id, true)).toBe(true)

    const res = await client.rpc('shell.spawn', { shellId: 's1', cols: 80, rows: 24 })
    expect(res).toMatchObject({ spawned: true })
    client.disconnect()
  })

  it('never forwards a credential method even with every scope', async () => {
    const pair = await freshPairing(['sessions', 'chat', 'approvals', 'work', 'files', 'git', 'terminal', 'admin'])
    const client = await connectAs(pair)
    await expect(client.rpc('provider.auth.apiKey', { key: 'x' })).rejects.toThrow(/never be called/)
    client.disconnect()
  })
})

describe('terminal isolation', () => {
  it('namespaces shell ids so one device cannot address another device shell', async () => {
    const pair = await freshPairing(['sessions', 'terminal'])
    const client = await connectAs(pair)
    gateway.calls.length = 0
    await client.rpc('shell.spawn', { shellId: 'mine', cols: 80, rows: 24 })
    const spawn = gateway.calls.find((c) => c.method === 'shell.spawn')
    expect(spawn?.params.shellId).toMatch(/^rem-.*-mine$/)
    client.disconnect()
  })

  it('refuses to write to a shell this device did not spawn', async () => {
    const pair = await freshPairing(['sessions', 'terminal'])
    const client = await connectAs(pair)
    await expect(client.rpc('shell.write', { shellId: 'someone-elses', data: 'ls\n' })).rejects.toThrow(
      /does not own that shell/,
    )
    client.disconnect()
  })

  it('does not deliver shell output for a shell the device does not own', async () => {
    const pair = await freshPairing(['sessions', 'terminal'])
    const events: string[] = []
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (event) => events.push(event),
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 800))

    // A terminal opened on the Mac itself. The gateway broadcasts this to every
    // authenticated client with no scoping; the bridge must swallow it.
    gateway.push('shell.data', { shellId: 'desktop-terminal-1', type: 'data', data: 'secret token abc123\n' })
    await new Promise((r) => setTimeout(r, 300))

    expect(events).not.toContain('shell.data')
    client.disconnect()
  })
})

describe('event delivery and resume', () => {
  it('only delivers session events to subscribers', async () => {
    const pair = await freshPairing()
    const seen: Array<{ event: string; key?: string }> = []
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (event, _data, _seq, sessionKey) => seen.push({ event, key: sessionKey }),
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 800))

    gateway.push('agent.message', { sessionKey: 'other:dm:zzz', message: 'not for you' })
    await new Promise((r) => setTimeout(r, 200))
    expect(seen.filter((s) => s.key === 'other:dm:zzz')).toHaveLength(0)

    await client.subscribe(['desktop:dm:abc'])
    gateway.push('agent.message', { sessionKey: 'desktop:dm:abc', message: 'for you' })
    await new Promise((r) => setTimeout(r, 300))
    expect(seen.some((s) => s.key === 'desktop:dm:abc')).toBe(true)
    client.disconnect()
  })

  it('replays missed events from the durable log after a reconnect', async () => {
    const pair = await freshPairing()
    const first: unknown[] = []
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (_e, data) => first.push(data),
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 800))
    await client.subscribe(['desktop:dm:abc'])
    const cursor = client.lastSeq
    client.disconnect()
    await new Promise((r) => setTimeout(r, 200))

    // Events arrive while the phone is away.
    gateway.push('agent.message', { sessionKey: 'desktop:dm:abc', message: 'missed one' })
    gateway.push('agent.message', { sessionKey: 'desktop:dm:abc', message: 'missed two' })
    await new Promise((r) => setTimeout(r, 300))

    const replayed: string[] = []
    const resumed = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      lastSeq: cursor,
      onEvent: (_e, data) => replayed.push((data as { message?: string }).message ?? ''),
    })
    resumed.connect()
    await new Promise((r) => setTimeout(r, 1200))

    expect(replayed).toContain('missed one')
    expect(replayed).toContain('missed two')
    resumed.disconnect()
  }, 20_000)

  it('backfills a session the device subscribes to late', async () => {
    const pair = await freshPairing()
    const seen: string[] = []
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (_e, data) => seen.push((data as { message?: string }).message ?? ''),
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 800))

    // The phone starts a run, so the first events land before it can subscribe.
    gateway.push('agent.message', { sessionKey: 'desktop:dm:late', message: 'first thing that happened' })
    await new Promise((r) => setTimeout(r, 200))
    expect(seen).not.toContain('first thing that happened')

    await client.subscribe(['desktop:dm:late'])
    await new Promise((r) => setTimeout(r, 400))
    expect(seen).toContain('first thing that happened')
    client.disconnect()
  })

  it('does not deliver the same event twice', async () => {
    const pair = await freshPairing()
    const seen: number[] = []
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (_e, _d, seq) => {
        if (typeof seq === 'number') seen.push(seq)
      },
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 800))
    await client.subscribe(['desktop:dm:dup'])
    gateway.push('agent.message', { sessionKey: 'desktop:dm:dup', message: 'once' })
    await new Promise((r) => setTimeout(r, 300))
    // Re-subscribing must not replay what the device already has.
    await client.subscribe(['desktop:dm:dup'])
    await new Promise((r) => setTimeout(r, 300))
    expect(new Set(seen).size).toBe(seen.length)
    client.disconnect()
  })

  it('unwraps agent.stream_batch into per-session stream events', async () => {
    const pair = await freshPairing()
    const events: Array<{ event: string; data: unknown }> = []
    const client = new RemoteClient({
      identity: pair.identity,
      deviceId: pair.deviceId,
      hostPublicKey: pair.hostPublicKey,
      addresses: [`127.0.0.1:${PORT}`],
      createSocket,
      onEvent: (event, data) => events.push({ event, data }),
    })
    client.connect()
    await new Promise((r) => setTimeout(r, 800))
    await client.subscribe(['desktop:dm:abc'])

    gateway.push('agent.stream_batch', [
      { event: 'agent.stream', data: { sessionKey: 'desktop:dm:abc', event: { type: 'content_block_start', content_block: { type: 'text' } } } },
      { event: 'agent.stream', data: { sessionKey: 'desktop:dm:abc', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } } },
    ])
    await new Promise((r) => setTimeout(r, 400))

    const streams = events.filter((e) => e.event === 'agent.stream')
    expect(streams.length).toBe(2)
    expect(events.some((e) => e.event === 'agent.stream_batch')).toBe(false)
    client.disconnect()
  })
})
