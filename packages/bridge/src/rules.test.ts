import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClient, decodePairingPayload, pairWithHost, type PairResult } from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge } from './bridge.js'
import { FakeGateway } from '../test/fake-gateway.js'
import { loadSettings, resolvePaths } from './config.js'
import { findMatchingRule, parseNewRule } from './rules.js'
import { Store } from './store.js'

const PORT = 7874
const SOCK = join(tmpdir(), `dr-fake-gw-rules-${process.pid}.sock`)
const createSocket = (url: string) => new WebSocket(url) as never
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('parseNewRule', () => {
  it('accepts a tool rule and an exact Bash rule', () => {
    expect(parseNewRule({ kind: 'tool', toolName: 'WebFetch' })).toEqual({ kind: 'tool', toolName: 'WebFetch' })
    expect(parseNewRule({ kind: 'exact', toolName: 'Bash', command: 'npm test' })).toEqual({ kind: 'exact', toolName: 'Bash', command: 'npm test' })
  })
  it('refuses anything broader or riskier than the phone would offer', () => {
    expect(() => parseNewRule({ kind: 'tool', toolName: 'Bash' })).toThrow()
    expect(() => parseNewRule({ kind: 'tool', toolName: 'Write', command: 'x' })).toThrow()
    expect(() => parseNewRule({ kind: 'exact', toolName: 'Write', command: 'x' })).toThrow()
    expect(() => parseNewRule({ kind: 'exact', toolName: 'Bash', command: 'rm -rf /' })).toThrow(/risky/)
    expect(() => parseNewRule({ kind: 'exact', toolName: 'Bash', command: '' })).toThrow()
    expect(() => parseNewRule({ kind: 'nope', toolName: 'X' })).toThrow()
    expect(() => parseNewRule({ kind: 'tool', toolName: '' })).toThrow()
  })
})

describe('Store rules and findMatchingRule', () => {
  it('adds idempotently, lists, removes', () => {
    const s = new Store(':memory:')
    const a = s.addRule({ kind: 'exact', toolName: 'Bash', command: 'npm test', createdBy: 'iPhone' })
    expect(s.addRule({ kind: 'exact', toolName: 'Bash', command: 'npm test' }).id).toBe(a.id)
    const b = s.addRule({ kind: 'tool', toolName: 'WebFetch' })
    expect(s.listRules()).toHaveLength(2)
    expect(findMatchingRule(s.listRules(), 'Bash', { command: 'npm test' })?.id).toBe(a.id)
    expect(findMatchingRule(s.listRules(), 'Bash', { command: 'npm test && rm -rf x' })).toBeNull()
    expect(findMatchingRule(s.listRules(), 'WebFetch', { url: 'https://x' })?.id).toBe(b.id)
    expect(findMatchingRule(s.listRules(), 'Write', { file_path: 'a' })).toBeNull()
    expect(s.removeRule(a.id)?.id).toBe(a.id)
    expect(s.removeRule(a.id)).toBeNull()
    s.close()
  })
  it('a stored rule never matches a risky input', () => {
    const s = new Store(':memory:')
    s.addRule({ kind: 'tool', toolName: 'Write' })
    expect(findMatchingRule(s.listRules(), 'Write', { file_path: '/Users/me/.zshrc', content: '' })).toBeNull()
    expect(findMatchingRule(s.listRules(), 'Write', { file_path: 'a.ts', content: '' }, { blockedPath: '/x' })).toBeNull()
    s.close()
  })
})

describe('remote.rules.* and auto-approve', () => {
  let bridge: Bridge
  let gateway: FakeGateway
  let home: string
  const clients: RemoteClient[] = []

  async function connect(scopes?: string[]): Promise<{ c: RemoteClient; ev: Array<{ event: string; data: any }> }> {
    const { uri } = bridge.newPairingPayload(scopes as never)
    const p: PairResult = await pairWithHost({ payload: decodePairingPayload(uri), deviceName: 'T', platform: 'ios', createSocket })
    bridge.approveDevice(p.deviceId)
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
    await c.rpc('sessions.subscribe', { sessionKeys: ['desktop:dm:abc'] }).catch(() => {})
    return { c, ev }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dorabot-remote-rules-'))
    gateway = new FakeGateway()
    gateway.overrides.set('tool.approve', { ok: true })
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

  /** The two-step add: challenge, then echo the nonce. */
  async function addRule<T = unknown>(c: RemoteClient, params: Record<string, unknown>): Promise<T> {
    const { nonce } = await c.rpc<{ nonce: string }>('remote.rules.challenge')
    return c.rpc<T>('remote.rules.add', { ...params, freshAuth: nonce })
  }

  it('needs the approvals scope and a fresh Face ID flag to add', async () => {
    const a = await connect()
    await expect(a.c.rpc('remote.rules.add', { kind: 'tool', toolName: 'WebFetch' })).rejects.toThrow(/Face ID/)
    await expect(a.c.rpc('remote.rules.add', { kind: 'tool', toolName: 'WebFetch', freshAuth: 'true' })).rejects.toThrow(/Face ID/)
    const limited = await connect(['chat'])
    await expect(limited.c.rpc('remote.rules.list')).rejects.toThrow()
    await expect(limited.c.rpc('remote.rules.add', { kind: 'tool', toolName: 'WebFetch', freshAuth: 'x' })).rejects.toThrow()
    expect(await a.c.rpc('remote.rules.list')).toEqual([])
    // Nonce rules: unknown, reused and other-connection nonces are refused.
    const { nonce } = await a.c.rpc<{ nonce: string }>('remote.rules.challenge')
    const other = await connect()
    await expect(other.c.rpc('remote.rules.add', { kind: 'tool', toolName: 'WebFetch', freshAuth: nonce })).rejects.toThrow(/Face ID/)
    await a.c.rpc('remote.rules.add', { kind: 'tool', toolName: 'WebFetch', freshAuth: nonce })
    await expect(a.c.rpc('remote.rules.add', { kind: 'tool', toolName: 'Read', freshAuth: nonce })).rejects.toThrow(/Face ID/)
    await a.c.rpc('remote.rules.remove', { id: (await a.c.rpc<Array<{ id: string }>>('remote.rules.list'))[0]!.id })
    await expect(limited.c.rpc('remote.rules.challenge')).rejects.toThrow()
  })

  it('adds, lists, broadcasts and removes; audits both', async () => {
    const a = await connect()
    const b = await connect()
    const res = await addRule<{ rule: { id: string }; rules: unknown[] }>(a.c, { kind: 'exact', toolName: 'Bash', command: 'npm test' })
    expect(res.rules).toHaveLength(1)
    await wait(150)
    expect(b.ev.find((e) => e.event === 'remote.rules_changed')?.data.rules).toHaveLength(1)
    await expect(addRule(a.c, { kind: 'exact', toolName: 'Bash', command: 'rm -rf /' })).rejects.toThrow(/risky/)
    const removed = await b.c.rpc<{ removed: boolean; rules: unknown[] }>('remote.rules.remove', { id: res.rule.id })
    expect(removed).toMatchObject({ removed: true, rules: [] })
    expect((await b.c.rpc<{ removed: boolean }>('remote.rules.remove', { id: res.rule.id })).removed).toBe(false)
    const audit = new Store(join(home, 'bridge.db')).listAudit({ limit: 50 }).map((r) => r.action)
    expect(audit).toContain('rule_add')
    expect(audit).toContain('rule_remove')
  })

  it('auto-approves a matching request with only {requestId}, audits it and keeps it off the phones', async () => {
    const a = await connect()
    await addRule(a.c, { kind: 'exact', toolName: 'Bash', command: 'npm test' })
    gateway.calls.length = 0
    a.ev.length = 0
    gateway.push('agent.tool_approval', { requestId: 'auto-1', toolName: 'Bash', input: { command: 'npm test' }, sessionKey: 'desktop:dm:abc', timestamp: 1 })
    await wait(300)
    expect(gateway.calls.filter((c) => c.method === 'tool.approve')).toEqual([{ method: 'tool.approve', params: { requestId: 'auto-1' } }])
    expect(a.ev.some((e) => e.event === 'agent.tool_approval')).toBe(false)
    const row = new Store(join(home, 'bridge.db')).listAudit({ limit: 50 }).find((r) => r.action === 'auto_approve')
    expect(row).toMatchObject({ requestId: 'auto-1', transport: 'rule' })
  })

  it('does not auto-approve a different or risky request; those reach the phone', async () => {
    const a = await connect()
    gateway.calls.length = 0
    a.ev.length = 0
    gateway.push('agent.tool_approval', { requestId: 'no-1', toolName: 'Bash', input: { command: 'npm test; rm -rf /' }, sessionKey: 'desktop:dm:abc', timestamp: 1 })
    gateway.push('agent.tool_approval', { requestId: 'no-2', toolName: 'Bash', input: { command: 'ls' }, sessionKey: 'desktop:dm:abc', timestamp: 1 })
    await wait(300)
    expect(gateway.calls.filter((c) => c.method === 'tool.approve')).toEqual([])
    expect(a.ev.filter((e) => e.event === 'agent.tool_approval')).toHaveLength(2)
  })

  it('falls back to asking the phone when the gateway refuses the approval', async () => {
    const a = await connect()
    const rules = await a.c.rpc<Array<{ id: string }>>('remote.rules.list')
    expect(rules.length).toBeGreaterThan(0)
    gateway.overrides.delete('tool.approve') // fake gateway then errors: "unknown method"
    a.ev.length = 0
    gateway.push('agent.tool_approval', { requestId: 'auto-2', toolName: 'Bash', input: { command: 'npm test' }, sessionKey: 'desktop:dm:abc', timestamp: 1 })
    await wait(400)
    expect(a.ev.filter((e) => e.event === 'agent.tool_approval')).toHaveLength(1)
    gateway.overrides.set('tool.approve', { ok: true })
  })
})
