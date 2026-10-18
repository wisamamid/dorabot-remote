import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClient, decodePairingPayload, pairWithHost, type PairResult } from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge } from './bridge.js'
import { DeviceConnection } from './connection.js'
import { FakeGateway } from '../test/fake-gateway.js'
import { loadSettings, readDorabotVersion, resolvePaths, type BridgePaths } from './config.js'
import { mdnsName } from './addresses.js'
import { checkPathParams } from './path-guard.js'
import { trimHistoryResult } from './history-trim.js'
import { applyEventToSnapshots } from './snapshot-state.js'

const PORT = 7862
const SOCK = join(tmpdir(), `dr-fake-gw-fixes-${process.pid}.sock`)
const createSocket = (url: string) => new WebSocket(url) as never
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let bridge: Bridge
let gateway: FakeGateway
let home: string
let paths: BridgePaths

async function pair(scopes?: string[]): Promise<PairResult> {
  const { uri } = bridge.newPairingPayload(scopes as never)
  return pairWithHost({ payload: decodePairingPayload(uri), deviceName: 'T', platform: 'ios', createSocket })
}
type Ev = { event: string; data: any; seq?: number }
async function connect(p: PairResult, extra: { lastSeq?: number } = {}): Promise<{ c: RemoteClient; ev: Ev[] }> {
  const ev: Ev[] = []
  const c = new RemoteClient({
    identity: p.identity,
    deviceId: p.deviceId,
    hostPublicKey: p.hostPublicKey,
    addresses: [`127.0.0.1:${PORT}`],
    createSocket,
    onEvent: (event, data, seq) => ev.push({ event, data, seq }),
    ...extra,
  })
  c.connect()
  for (let i = 0; i < 200 && c.state !== 'ready'; i++) await wait(20)
  return { c, ev }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dorabot-remote-fixes-'))
  gateway = new FakeGateway()
  paths = resolvePaths({
    root: home,
    db: join(home, 'bridge.db'),
    identity: join(home, 'host-key.json'),
    settings: join(home, 'settings.json'),
    gatewaySocket: SOCK,
    gatewayToken: join(home, 'gateway-token'),
  })
  writeFileSync(paths.gatewayToken, 'b'.repeat(64))
  await gateway.start(SOCK, 'b'.repeat(64))
  const settings = loadSettings(paths)
  settings.port = PORT
  settings.bind = '127.0.0.1'
  bridge = new Bridge({ paths, settings })
  await bridge.start()
  await wait(400)
}, 30_000)

afterAll(async () => {
  await bridge?.stop()
  await gateway?.stop()
  rmSync(home, { recursive: true, force: true })
})

describe('snapshot cache stays current', () => {
  const snap = (extra: object = {}) => ({
    sessionKey: 's', status: 'idle', text: '', currentTool: null, completedTools: [],
    pendingApproval: null, pendingQuestion: null, updatedAt: 1, ...extra,
  })
  it('applies approval, question and elicitation events (unit)', () => {
    const m = new Map<string, any>([['s', snap()]])
    applyEventToSnapshots(m, 'agent.tool_approval', { sessionKey: 's', requestId: 'r1', toolName: 'Bash' })
    expect(m.get('s').pendingApproval.requestId).toBe('r1')
    applyEventToSnapshots(m, 'agent.tool_approval_resolved', { requestId: 'r1' })
    expect(m.get('s').pendingApproval).toBeNull()
    applyEventToSnapshots(m, 'agent.ask_user', { sessionKey: 's', requestId: 'q1', questions: [] })
    expect(m.get('s').pendingQuestion.requestId).toBe('q1')
    applyEventToSnapshots(m, 'agent.question_state', { requestId: 'q1', status: 'answered' })
    expect(m.get('s').pendingQuestion).toBeNull()
    applyEventToSnapshots(m, 'agent.elicitation', { sessionKey: 's', elicitationId: 'e1' })
    expect(m.get('s').pendingElicitation.elicitationId).toBe('e1')
    applyEventToSnapshots(m, 'agent.elicitation_result', { sessionKey: 's' })
    expect(m.get('s').pendingElicitation).toBeNull()
  })

  it('does not replay a resolved approval to a later subscriber', async () => {
    gateway.push('session.snapshot', snap({ sessionKey: 'desktop:dm:snap', pendingApproval: { requestId: 'r9', toolName: 'Bash', input: {}, timestamp: 1 } }))
    gateway.push('agent.tool_approval_resolved', { requestId: 'r9' })
    await wait(200)
    const { c, ev } = await connect(await pair())
    await c.subscribe(['desktop:dm:snap'])
    await wait(300)
    const s = ev.find((e) => e.event === 'session.snapshot')
    expect(s).toBeTruthy()
    expect(s!.data.pendingApproval).toBeNull()
    c.disconnect()
  })
})

describe('stream_batch cursor', () => {
  it('advances the gateway cursor from inner frames', async () => {
    gateway.push('agent.stream_batch', [
      { event: 'agent.stream', seq: 501, data: { sessionKey: 'desktop:dm:cur', event: {} } },
      { event: 'agent.stream', seq: 502, data: { sessionKey: 'desktop:dm:cur', event: {} } },
    ])
    await wait(200)
    const cur = bridge.store.getMeta<Record<string, number>>('gateway.lastSeqBySession', {})
    expect(cur['desktop:dm:cur']).toBe(502)
  })
})

describe('fresh device and dedupe', () => {
  it('does not replay history for a fresh device (lastSeq 0)', async () => {
    gateway.push('agent.message', { sessionKey: 'desktop:dm:abc', message: 'old' })
    await wait(200)
    const { c, ev } = await connect(await pair(), { lastSeq: 0 })
    await wait(600)
    expect(ev.filter((e) => e.event === 'agent.message')).toHaveLength(0)
    c.disconnect()
  })

  it('never sends a seq at or below what was already sent', () => {
    const sent: unknown[] = []
    const ws = { on() {}, close() {}, send() {} } as never
    const conn = new DeviceConnection(ws, { onClosed() {} } as never, 'x') as any
    conn.send = (e: unknown) => sent.push(e)
    conn.deliver('a', {}, 5, 'k')
    conn.deliver('a', {}, 5, 'k')
    conn.deliver('a', {}, 4, 'k')
    conn.deliver('a', {}, 6, 'k')
    conn.deliver('g', {}, 3, null)
    conn.deliver('g', {}, 3, null)
    expect(sent).toHaveLength(3)
    conn.close()
  })
})

describe('scopes', () => {
  it('remote.events needs the sessions scope', async () => {
    const { c } = await connect(await pair(['chat']))
    await expect(c.rpc('remote.events', {})).rejects.toThrow(/permission/)
    c.disconnect()
    const ok = await connect(await pair(['sessions']))
    await expect(ok.c.rpc('remote.events', {})).resolves.toBeTruthy()
    ok.c.disconnect()
  })
})

describe('live device record', () => {
  it('closes a connection whose device was revoked out-of-band', async () => {
    const p = await pair()
    const { c } = await connect(p)
    bridge.store.setRevoked(p.deviceId, true)
    await expect(c.rpc('ping')).rejects.toThrow()
    await wait(100)
    expect(c.state).not.toBe('ready')
    c.disconnect()
  })
})

describe('path guard', () => {
  const h = homedir()
  it('blocks secrets and escapes, allows normal files', () => {
    const extra = [home]
    expect(checkPathParams('fs.read', { path: join(home, 'host-key.json') }, extra)).toMatch(/blocked/)
    expect(checkPathParams('fs.read', { path: '~/.ssh/id_rsa' }, extra)).toMatch(/blocked/)
    expect(checkPathParams('fs.list', { path: '~/Documents/../.aws' }, extra)).toMatch(/blocked/)
    expect(checkPathParams('fs.read', { path: '.config/gh/hosts.yml' }, extra)).toMatch(/blocked/)
    expect(checkPathParams('fs.read', { path: join(h, 'proj/.env') }, extra)).toMatch(/blocked/)
    expect(checkPathParams('fs.read', { path: join(h, 'proj/a.pem') }, extra)).toMatch(/blocked/)
    expect(checkPathParams('search.files', { path: h, query: 'x' }, extra)).toMatch(/blocked/)
    expect(checkPathParams('fs.read', { path: join(h, 'proj/readme.md') }, extra)).toBeNull()
    expect(checkPathParams('git.log', { path: '~/.ssh' }, extra)).toBeNull()
  })
  it('follows symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-'))
    mkdirSync(join(dir, 'secret'))
    symlinkSync(join(dir, 'secret'), join(dir, 'link'))
    expect(checkPathParams('fs.read', { path: join(dir, 'link/x') }, [join(dir, 'secret')])).toMatch(/blocked/)
    rmSync(dir, { recursive: true, force: true })
  })
  it('is enforced on forwarded RPCs', async () => {
    const { c } = await connect(await pair())
    await expect(c.rpc('fs.read', { path: join(home, 'host-key.json') })).rejects.toThrow(/blocked/)
    c.disconnect()
  })
})

describe('control page host/origin checks', () => {
  const get = (host: string, origin?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: PORT, path: '/api/state', headers: { host, ...(origin ? { origin } : {}) } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0) },
      )
      req.on('error', reject)
      req.end()
    })
  it('rejects rebinding hosts and foreign origins', async () => {
    expect(await get(`127.0.0.1:${PORT}`)).toBe(200)
    expect(await get(`localhost:${PORT}`, `http://localhost:${PORT}`)).toBe(200)
    expect(await get(`evil.example:${PORT}`)).toBe(403)
    expect(await get(`127.0.0.1:${PORT}`, 'http://evil.example')).toBe(403)
  })
})

describe('shell ownership', () => {
  it('owns the shell before spawn returns and rolls back on error', async () => {
    const calls: string[] = []
    let fail = false
    let owned = false
    const host = {
      callGateway: async (m: string, p: any) => {
        calls.push(m)
        owned = [...conn.ownedShells].includes(p.shellId)
        if (fail) throw new Error('boom')
        return { spawned: true }
      },
      log() {},
      onClosed() {},
    } as never
    const ws = { on() {}, close() {}, send() {} } as never
    const conn = new DeviceConnection(ws, host, 'x') as any
    await conn.handleShell('shell.spawn', { shellId: 'a' })
    expect(owned).toBe(true)
    expect(conn.ownedShells.size).toBe(1)
    fail = true
    await expect(conn.handleShell('shell.spawn', { shellId: 'b' })).rejects.toThrow()
    expect(conn.ownedShells.size).toBe(1)
    conn.close()
  })
})

describe('history trimming', () => {
  const msg = (i: number, n = 1000) => ({ i, content: 'x'.repeat(n) })
  it('keeps the newest messages and flags truncation', () => {
    const messages = Array.from({ length: 2000 }, (_, i) => msg(i))
    const out = trimHistoryResult('sessions.get', { sessionId: 's', messages }, 1024 * 1024) as any
    expect(out.truncated).toBe(true)
    expect(out.totalMessages).toBe(2000)
    expect(out.returnedMessages).toBe(out.messages.length)
    expect(out.messages.at(-1).i).toBe(1999)
    expect(JSON.stringify(out).length).toBeLessThan(800 * 1024)
  })
  it('clips huge strings and handles bare arrays', () => {
    const out = trimHistoryResult('chat.history', [msg(0, 900_000)], 512 * 1024) as any[]
    expect(out).toHaveLength(1)
    expect(out[0].content.length).toBeLessThan(60 * 1024)
  })
  it('leaves small results and other methods alone', () => {
    const r = { sessionId: 's', messages: [msg(0)] }
    expect(trimHistoryResult('sessions.get', r, 512 * 1024)).toBe(r)
    expect(trimHistoryResult('sessions.list', [msg(0, 5_000_000)], 1000)).toBeTruthy()
  })
})

describe('host naming', () => {
  it('builds a single .local mDNS name', () => {
    const n = mdnsName()
    expect(n.endsWith('.local')).toBe(true)
    expect(n).not.toMatch(/\.lan\.local$|\.local\.local$/)
  })
  it('reads the dorabot version from Info.plist when installed', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync('/Applications/dorabot.app/Contents/Info.plist')) {
      expect(readDorabotVersion(paths)).toMatch(/^\d+\.\d+/)
    }
  })
})
