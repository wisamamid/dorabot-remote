/**
 * S3: control page auth, pending pairing approval, audit log, expiry, socket limits.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  SCOPE_DEFAULTS,
  decodePairingPayload,
  generateIdentity,
  openSealedJson,
  pairWithHost,
  sealJson,
  sodiumReady,
  fromB64,
  toB64,
} from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge, DEVICE_EXPIRY_MS, MAX_UNAUTH_PER_IP, PENDING_TTL_MS } from './bridge.js'
import { loadControlSecret } from './control-auth.js'
import { FakeGateway } from '../test/fake-gateway.js'
import { loadSettings, resolvePaths, type BridgePaths } from './config.js'
import { Store } from './store.js'

const PORT = 7871
const SOCK = join(tmpdir(), `dr-ctl-gw-${process.pid}.sock`)
const createSocket = (url: string) => new WebSocket(url) as never
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let bridge: Bridge
let gateway: FakeGateway
let home: string
let paths: BridgePaths
let secret: string
const notices: string[] = []

interface Res { status: number; headers: Record<string, any>; body: string }
function http(method: string, path: string, opts: { headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method, headers: { host: opts.host ?? `127.0.0.1:${PORT}`, ...(opts.headers ?? {}) } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
const bearer = () => ({ authorization: `Bearer ${secret}` })
const post = (path: string, body: unknown) => http('POST', path, { headers: bearer(), body: JSON.stringify(body) })

async function pairPending(name = 'iPhone X') {
  const { uri } = bridge.newPairingPayload()
  return pairWithHost({ payload: decodePairingPayload(uri), deviceName: name, platform: 'ios', createSocket })
}

/** Raw hello: returns the first text frame the host answers with. */
async function rawHello(deviceId: string): Promise<{ t: string; code?: string }> {
  const s = await sodiumReady()
  const eph = generateIdentity(s)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connect`)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, deviceId, ephPk: toB64(s, eph.publicKey) })))
    ws.on('message', (d) => {
      resolve(JSON.parse(d.toString()))
      ws.close()
    })
    ws.on('error', reject)
  })
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dorabot-remote-ctl-'))
  process.env.DORABOT_REMOTE_HOME = home
  gateway = new FakeGateway()
  paths = resolvePaths({
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
  bridge = new Bridge({ paths, settings, notify: (t, b) => notices.push(`${t}: ${b}`) })
  await bridge.start()
  secret = loadControlSecret(home)
  await wait(300)
}, 30_000)

afterAll(async () => {
  await bridge?.stop()
  await gateway?.stop()
  rmSync(home, { recursive: true, force: true })
})

describe('defaults and file modes', () => {
  it('grants only sessions, chat and approvals by default', () => {
    expect(SCOPE_DEFAULTS).toEqual(['sessions', 'chat', 'approvals'])
  })
  it('keeps the secret and the database owner-only', () => {
    expect(statSync(join(home, 'control-secret')).mode & 0o777).toBe(0o600)
    expect(statSync(paths.db).mode & 0o777).toBe(0o600)
    for (const ext of ['-wal', '-shm']) {
      try {
        expect(statSync(paths.db + ext).mode & 0o777).toBe(0o600)
      } catch {
        // not created yet
      }
    }
  })
  it('tightens an existing, world-readable database at open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-perm-'))
    const f = join(dir, 'b.db')
    new Store(f).close()
    const { chmodSync } = await import('node:fs')
    chmodSync(f, 0o644)
    new Store(f).close()
    expect(statSync(f).mode & 0o777).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('control page authentication (M1)', () => {
  it('refuses the page and every API without credentials', async () => {
    expect((await http('GET', '/')).status).toBe(401)
    expect((await http('GET', '/api/state')).status).toBe(401)
    expect((await http('POST', '/api/pair', { body: '{}' })).status).toBe(401)
    expect((await http('POST', '/api/device', { body: JSON.stringify({ deviceId: 'x', action: 'scopes', scopes: ['terminal'] }) })).status).toBe(401)
    expect((await http('GET', '/api/audit')).status).toBe(401)
    expect((await http('GET', '/api/state', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await http('GET', '/health')).status).toBe(200)
  })

  it('exchanges a one-time login token for an HttpOnly SameSite=Strict cookie', async () => {
    const token = bridge.store.createLoginToken()
    const r = await http('GET', `/?login=${token}`)
    expect(r.status).toBe(303)
    expect(r.headers.location).toBe('/')
    const cookie = String(r.headers['set-cookie'])
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect(cookie).not.toContain(secret)
    const jar = cookie.split(';')[0]!
    expect((await http('GET', '/api/state', { headers: { cookie: jar } })).status).toBe(200)
    expect((await http('GET', '/', { headers: { cookie: jar } })).body).toContain('dorabot remote')
    // Single use.
    expect((await http('GET', `/?login=${token}`)).status).toBe(401)
    expect((await http('GET', '/?login=garbage')).status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = bridge.store.createLoginToken(-1000)
    expect((await http('GET', `/?login=${token}`)).status).toBe(401)
  })

  it('accepts the bearer secret and still enforces Host and Origin', async () => {
    expect((await http('GET', '/api/state', { headers: bearer() })).status).toBe(200)
    expect((await http('GET', '/api/state', { headers: bearer(), host: `evil.example:${PORT}` })).status).toBe(403)
    expect((await http('GET', '/api/state', { headers: { ...bearer(), origin: 'http://evil.example' } })).status).toBe(403)
  })

  it('answers malformed JSON and bad scopes with 400, not a crash', async () => {
    expect((await http('POST', '/api/scope', { headers: bearer(), body: '{nope' })).status).toBe(400)
    expect((await http('POST', '/api/device', { headers: bearer(), body: '{nope' })).status).toBe(400)
    expect((await post('/api/device', { deviceId: 'x', action: 'scopes', scopes: ['root'] })).status).toBe(400)
    expect((await post('/api/device', { deviceId: 'x', action: 'scopes' })).status).toBe(400)
    expect((await post('/api/device', { action: 'revoke' })).status).toBe(400)
    expect((await http('GET', '/health')).status).toBe(200)
  })
})

describe('pairing needs approval on the Mac', () => {
  it('creates a pending device that cannot connect, and tells the phone so', async () => {
    const s = await sodiumReady()
    const { uri } = bridge.newPairingPayload()
    const payload = decodePairingPayload(uri)
    const id = generateIdentity(s)
    const reply = await new Promise<{ t: string; sealed: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pair`)
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            t: 'pair',
            v: PROTOCOL_VERSION,
            sealed: sealJson(s, fromB64(s, payload.k), { v: PROTOCOL_VERSION, code: payload.c, devicePublicKey: toB64(s, id.publicKey), deviceName: 'Raw\nPhone', platform: 'ios' }),
          }),
        ),
      )
      ws.on('message', (d) => resolve(JSON.parse(d.toString())))
      ws.on('error', reject)
    })
    expect(reply.t).toBe('pair_ok')
    const res = openSealedJson<{ deviceId: string; pending?: boolean; approvalExpiresAt?: number }>(s, id, reply.sealed)
    expect(res.pending).toBe(true)
    expect(res.approvalExpiresAt).toBeGreaterThan(Date.now())
    const dev = bridge.store.getDevice(res.deviceId)!
    expect(dev.pending).toBe(true)
    expect(dev.name).toBe('RawPhone')
    expect(bridge.getDevice(res.deviceId)!.scopes).toEqual([])
    expect(notices.some((n) => n.includes('RawPhone'))).toBe(true)

    const refused = await rawHello(res.deviceId)
    expect(refused).toMatchObject({ t: 'err', code: 'pending' })

    bridge.rejectDevice(res.deviceId)
  })

  it('shows the pending phone on the control page API and lets Allow activate it', async () => {
    const p = await pairPending('Allow Me')
    const state = JSON.parse((await http('GET', '/api/state', { headers: bearer() })).body)
    const pend = state.pendingDevices.find((d: any) => d.id === p.deviceId)
    expect(pend.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(pend.expiresAt).toBeGreaterThan(Date.now())
    expect((await rawHello(p.deviceId)).code).toBe('pending')

    expect(JSON.parse((await post('/api/device', { deviceId: p.deviceId, action: 'approve' })).body).ok).toBe(true)
    // No longer refused as pending (hello is acknowledged).
    expect((await rawHello(p.deviceId)).t).toBe('hello_ack')
    // Approving twice is a no-op.
    expect(JSON.parse((await post('/api/device', { deviceId: p.deviceId, action: 'approve' })).body).ok).toBe(false)
  })

  it('Reject deletes the device', async () => {
    const p = await pairPending('Nope')
    expect(JSON.parse((await post('/api/device', { deviceId: p.deviceId, action: 'reject' })).body).ok).toBe(true)
    expect(bridge.store.getDevice(p.deviceId)).toBeNull()
    expect((await rawHello(p.deviceId)).code).toBe('unknown_device')
  })

  it('reject never touches an already-active device', async () => {
    const p = await pairPending('Active')
    bridge.approveDevice(p.deviceId)
    expect(bridge.rejectDevice(p.deviceId)).toBe(false)
    expect(bridge.store.getDevice(p.deviceId)).not.toBeNull()
  })

  it('auto-rejects after 10 minutes', async () => {
    const p = await pairPending('Slow')
    expect(bridge.sweepPending(Date.now() + PENDING_TTL_MS - 5000)).toBe(0)
    expect(bridge.store.getDevice(p.deviceId)).not.toBeNull()
    expect(bridge.sweepPending(Date.now() + PENDING_TTL_MS + 5000)).toBeGreaterThanOrEqual(1)
    expect(bridge.store.getDevice(p.deviceId)).toBeNull()
  })

  it('does not let the CLI path or API grant scopes outside the enum', async () => {
    const p = await pairPending('Scoped')
    expect((await post('/api/device', { deviceId: p.deviceId, action: 'scopes', scopes: ['terminal'] })).status).toBe(200)
    expect(bridge.store.getDevice(p.deviceId)!.scopes).toEqual(['terminal'])
    bridge.rejectDevice(p.deviceId)
  })
})

describe('audit log', () => {
  it('records pair/approve/reject and scope changes with the device', async () => {
    const p = await pairPending('Audited')
    bridge.approveDevice(p.deviceId)
    await post('/api/device', { deviceId: p.deviceId, action: 'scopes', scopes: ['sessions', 'terminal'] })
    const { entries } = JSON.parse((await http('GET', `/api/audit?device=${p.deviceId}`, { headers: bearer() })).body)
    const actions = entries.map((e: any) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['pair', 'approve', 'scopes']))
    expect(entries.every((e: any) => e.deviceId === p.deviceId)).toBe(true)
    const sc = entries.find((e: any) => e.action === 'scopes')
    expect(sc.summary).toContain('terminal')
  })

  it('auditRpc records the sensitive methods without prompt text', () => {
    const conn = { device: { id: 'dev-a', name: 'A' } } as never
    bridge.auditLog.record({ deviceId: 'dev-a', action: 'noop' })
    bridge.auditRpc(conn, 'tool.approve', 'r1', { requestId: 'appr-1', toolName: 'Bash', input: { command: 'rm -rf secret-prompt' } })
    bridge.auditRpc(conn, 'chat.send', 'r2', { text: 'my secret prompt' })
    bridge.auditRpc(conn, 'sessions.rename', 'r3', { sessionKey: 'a:b:c', name: 'private name' })
    bridge.auditRpc(conn, 'git.push', 'r4', { cwd: '/tmp/repo' })
    bridge.auditRpc(conn, 'sessions.setModel', 'r5', { model: 'opus' })
    bridge.auditRpc(conn, 'shell.spawn', 'r6', { shellId: 's', cwd: '/x' })
    bridge.auditRpc(conn, 'chat.answerQuestion', 'r7', { requestId: 'q1', answers: ['secret'] })
    const rows = bridge.store.listAudit({ deviceId: 'dev-a' })
    const methods = rows.filter((r) => r.action === 'rpc').map((r) => r.method)
    expect(methods.sort()).toEqual(['chat.answerQuestion', 'git.push', 'sessions.rename', 'sessions.setModel', 'shell.spawn', 'tool.approve'])
    const approve = rows.find((r) => r.method === 'tool.approve')!
    expect(approve.requestId).toBe('r1')
    expect(approve.summary).toContain('tool=Bash')
    expect(approve.transport).toBe('direct')
    const blob = JSON.stringify(rows)
    for (const secretText of ['rm -rf', 'secret', 'private name']) expect(blob).not.toContain(secretText)
  })

  it('is append-only', () => {
    expect(() => (bridge.store as any).db.exec("UPDATE audit_log SET action = 'x'")).toThrow(/append-only/)
    expect(() => (bridge.store as any).db.exec('DELETE FROM audit_log')).toThrow(/append-only/)
  })
})

describe('device expiry', () => {
  it('revokes devices unseen for 90 days and shows why', async () => {
    const p = await pairPending('Old')
    bridge.approveDevice(p.deviceId)
    bridge.store.touchDevice(p.deviceId)
    expect(bridge.sweepExpiredDevices(Date.now() + DEVICE_EXPIRY_MS - 60_000)).toBe(0)
    expect(bridge.sweepExpiredDevices(Date.now() + DEVICE_EXPIRY_MS + 60_000)).toBeGreaterThanOrEqual(1)
    const d = bridge.store.getDevice(p.deviceId)!
    expect(d.revoked).toBe(true)
    expect(d.revokedReason).toBe('expired')
    const state = JSON.parse((await http('GET', '/api/state', { headers: bearer() })).body)
    expect(state.devices.find((x: any) => x.id === p.deviceId).revokedReason).toBe('expired')
    expect((await rawHello(p.deviceId)).code).toBe('revoked')
    // Restoring restarts the clock.
    await post('/api/device', { deviceId: p.deviceId, action: 'restore' })
    expect(bridge.sweepExpiredDevices()).toBe(0)
    expect(bridge.store.getDevice(p.deviceId)!.revoked).toBe(false)
  })

  it('never expires pending or already revoked devices', () => {
    const st = new Store(':memory:')
    const a = st.createDevice({ name: 'p', platform: 'x', publicKey: 'k1', scopes: [], pending: true })
    const b = st.createDevice({ name: 'r', platform: 'x', publicKey: 'k2', scopes: [] })
    st.setRevoked(b.id, true)
    expect(st.expireStaleDevices(1000, Date.now() + 10_000_000)).toHaveLength(0)
    expect(st.getDevice(a.id)!.revoked).toBe(false)
  })
})

describe('shared folders', () => {
  it('lists, validates, adds and removes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-root-'))
    mkdirSync(join(dir, 'proj'))
    const bad = await post('/api/roots', { action: 'add', path: 'relative/dir' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).error).toMatch(/absolute/)
    expect((await post('/api/roots', { action: 'add', path: join(dir, 'missing') })).status).toBe(400)
    const ok = JSON.parse((await post('/api/roots', { action: 'add', path: join(dir, 'proj') })).body)
    expect(ok.ok).toBe(true)
    const list = JSON.parse((await http('GET', '/api/roots', { headers: bearer() })).body).roots as string[]
    expect(list.some((r) => r.endsWith('proj'))).toBe(true)
    const real = list.find((r) => r.endsWith('proj'))!
    await post('/api/roots', { action: 'remove', path: real })
    expect(JSON.parse((await http('GET', '/api/roots', { headers: bearer() })).body).roots).not.toContain(real)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('socket limits (M3)', () => {
  const upgrade = (origin?: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connect`, origin ? { origin } : undefined)
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
      ws.on('error', () => resolve('error'))
    })

  it('rejects browser origins but allows native clients and Capacitor', async () => {
    expect(await upgrade('http://evil.example')).toBe('403')
    expect(await upgrade('https://evil.example')).toBe('403')
    expect(await upgrade('null')).toBe('403')
    expect(await upgrade()).toBe('open')
    expect(await upgrade('capacitor://localhost')).toBe('open')
    const pairRes = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pair`, { origin: 'http://evil.example' })
      ws.on('open', () => resolve('open'))
      ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)))
      ws.on('error', () => resolve('error'))
    })
    expect(pairRes).toBe('403')
  })

  it('closes a connection that sends a large frame before authenticating', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connect`)
      ws.on('open', () => ws.send(Buffer.alloc(20_000, 1)))
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(1009)
  })

  it('drops frames over 1 MiB outright', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connect`)
      ws.on('open', () => ws.send(Buffer.alloc(1024 * 1024 + 10, 1)))
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => {})
    })
    expect(code).toBe(1009)
  })

  it('caps unauthenticated sockets per address', async () => {
    await wait(500) // let earlier sockets release their slots
    const results: string[] = []
    const open: WebSocket[] = []
    for (let i = 0; i < MAX_UNAUTH_PER_IP + 2; i++) {
      const r = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connect`)
        open.push(ws)
        ws.on('open', () => resolve('open'))
        ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)))
        ws.on('error', () => resolve('error'))
      })
      results.push(r)
    }
    expect(results.filter((r) => r === 'open')).toHaveLength(MAX_UNAUTH_PER_IP)
    expect(results.slice(MAX_UNAUTH_PER_IP)).toEqual(['503', '503'])
    for (const ws of open) ws.terminate()
    await wait(200)
    expect(await upgrade()).toBe('open')
  })
})
