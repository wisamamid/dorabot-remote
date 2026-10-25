import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  SecureChannel,
  deriveSessionKeys,
  fromB64,
  generateIdentity,
  sodiumReady,
  toB64,
} from '@dorabot-remote/protocol'
import type { Scope } from '@dorabot-remote/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceConnection, type ConnectionHost } from './connection.js'
import { checkPathParams, filterSearchResult } from './path-guard.js'
import { createRootsStore } from './roots.js'
import { sanitizeParams } from './param-allowlist.js'
import type { DeviceRecord } from './store.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Connection harness: a real handshake against a fake socket and a stub host.
// ---------------------------------------------------------------------------

async function harness(scopes: Scope[], roots: string[] = []) {
  const s = await sodiumReady()
  const hostId = generateIdentity(s)
  const devId = generateIdentity(s)
  const record = {
    id: 'dev1', name: 'Phone', platform: 'ios', publicKey: toB64(s, devId.publicKey), scopes,
    createdAt: 0, lastSeenAt: null, revoked: false,
  } as DeviceRecord
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const gatewayResults = new Map<string, unknown>()
  const host = {
    sodium: s, hostIdentity: hostId, hostSummary: { id: 'h', name: 'Mac' } as never,
    getDevice: () => record, touchDevice() {}, deviceSummary: () => ({}) as never,
    currentSeq: () => 0, eventsSince: () => [], snapshotFor: () => null, knownSessionKeys: () => [],
    gatewayConnected: () => true,
    callGateway: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return gatewayResults.get(method) ?? { ok: true }
    },
    handleBridgeMethod: async () => ({}), log() {}, onClosed() {},
    protectedPaths: () => [] as string[], allowedRoots: () => roots, hostSummaryFor: () => ({ id: 'h', name: 'Mac' }) as never,
  } as unknown as ConnectionHost

  const handlers: Record<string, (...a: never[]) => void> = {}
  const sent: Array<string | Buffer> = []
  let closed = false
  const ws = {
    on: (ev: string, fn: (...a: never[]) => void) => { handlers[ev] = fn },
    send: (d: string | Buffer) => { sent.push(d) },
    close: () => { closed = true },
    bufferedAmount: 0,
  }
  new DeviceConnection(ws as never, host, '127.0.0.1')
  const text = (o: unknown) => (handlers.message as (b: Buffer, bin: boolean) => void)(Buffer.from(JSON.stringify(o)), false)
  const bin = (b: Uint8Array) => (handlers.message as (b: Buffer, bin: boolean) => void)(Buffer.from(b), true)

  const devEph = generateIdentity(s)
  text({ t: 'hello', v: PROTOCOL_VERSION, deviceId: 'dev1', ephPk: toB64(s, devEph.publicKey) })
  await wait(20)
  const ack = JSON.parse(String(sent[0])) as { ephPk: string }
  const hostHdr = JSON.parse(String(sent[1])) as { hdr: string }
  const ch = SecureChannel.create(s, deriveSessionKeys(s, 'device', {
    myEphemeral: devEph, theirEphemeralPk: fromB64(s, ack.ephPk), myStatic: devId, theirStaticPk: hostId.publicKey,
  }))
  ch.startReceive(fromB64(s, hostHdr.hdr))
  const myHdr = ch.startSend()
  text({ t: 'hdr', hdr: toB64(s, myHdr) })
  await wait(10)
  bin(ch.seal({ t: 'auth', lastSeq: 0 }))
  await wait(30)

  let nextId = 1
  let cursor = 2
  const replies = new Map<number, { result?: unknown; error?: { message: string } }>()
  const drain = (): void => {
    while (cursor < sent.length) {
      const f = sent[cursor++]
      if (typeof f === 'string') continue
      const env = ch.open<{ t: string; id?: number }>(new Uint8Array(f))
      if (env.t === 'rpc_res' && typeof env.id === 'number') replies.set(env.id, env as never)
    }
  }
  const rpc = async (method: string, params?: unknown): Promise<{ result?: unknown; error?: { message: string } }> => {
    const id = nextId++
    bin(ch.seal({ t: 'rpc', id, method, params }))
    for (let i = 0; i < 100; i++) {
      await wait(10)
      drain()
      const r = replies.get(id)
      if (r) return r
    }
    throw new Error('no reply')
  }
  return { rpc, calls, gatewayResults, text, ch, s, isClosed: () => closed, sent, record }
}

describe('C1: tool.approve cannot rewrite the approved input', () => {
  it('strips modifiedInput and unknown keys without terminal scope', async () => {
    const h = await harness(['approvals'])
    const r = await h.rpc('tool.approve', { requestId: 'r1', modifiedInput: { command: 'rm -rf ~' }, extra: 1 })
    expect(r.error).toBeUndefined()
    expect(h.calls).toEqual([{ method: 'tool.approve', params: { requestId: 'r1' } }])
  })

  it('keeps modifiedInput only for devices with terminal', async () => {
    const h = await harness(['approvals', 'terminal'])
    await h.rpc('tool.approve', { requestId: 'r1', modifiedInput: { command: 'ls' }, extra: 1 })
    expect(h.calls[0]?.params).toEqual({ requestId: 'r1', modifiedInput: { command: 'ls' } })
  })

  it('tolerates non-object params', async () => {
    const h = await harness(['approvals'])
    await h.rpc('tool.approve', 'nope')
    expect(h.calls[0]?.params).toEqual({})
  })
})

describe('param allowlists', () => {
  it('drops unknown keys on sensitive methods', () => {
    const sc: Scope[] = ['chat']
    expect(sanitizeParams('chat.send', { prompt: 'x', sessionKey: 'k', inputItems: [1], cwd: '/', permissionMode: 'bypass' }, sc)).toEqual({ prompt: 'x', sessionKey: 'k' })
    expect(sanitizeParams('chat.answerQuestion', { requestId: 'r', answers: {}, modifiedInput: {} }, sc)).toEqual({ requestId: 'r', answers: {} })
    expect(sanitizeParams('chat.answerElicitation', { elicitationId: 'e', values: {}, sessionKey: 's', x: 1 }, sc)).toEqual({ elicitationId: 'e', values: {}, sessionKey: 's' })
    expect(sanitizeParams('shell.spawn', { shellId: 'a', cols: 1, rows: 2, cwd: '/etc' }, ['terminal'])).toEqual({ shellId: 'a', cols: 1, rows: 2 })
    expect(sanitizeParams('git.commit', { path: '/p', message: 'm', args: ['--amend'] }, ['git_write'])).toEqual({ path: '/p', message: 'm' })
    expect(sanitizeParams('cron.add', { summary: 's', message: 'm', channel: 'whatsapp', to: '+1', deliver: true }, ['schedule'])).toEqual({ summary: 's', message: 'm' })
    expect(sanitizeParams('sessions.setModel', { sessionId: 'a', model: 'm', evil: 1 }, sc)).toEqual({ sessionId: 'a', model: 'm' })
    // Unlisted methods pass through unchanged.
    expect(sanitizeParams('sessions.list', { a: 1 }, sc)).toEqual({ a: 1 })
  })
})

describe('H1: one plaintext hdr per connection', () => {
  it('closes the connection on a second hdr after the channel is established', async () => {
    const h = await harness(['sessions'])
    expect((await h.rpc('ping')).error).toBeUndefined()
    h.text({ t: 'hdr', hdr: toB64(h.s, new Uint8Array(h.ch.startSend().length)) })
    await wait(30)
    expect(h.isClosed()).toBe(true)
  })

  it('closes on any plaintext frame after establishment', async () => {
    const h = await harness(['sessions'])
    h.text({ t: 'hello', v: PROTOCOL_VERSION, deviceId: 'dev1', ephPk: 'AAAA' })
    await wait(30)
    expect(h.isClosed()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// H4: allowlist
// ---------------------------------------------------------------------------

describe('H4: folder allowlist', () => {
  let base: string
  let proj: string
  let outside: string
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join('/tmp', 's2-')))
    proj = join(base, 'proj')
    outside = join(base, 'other')
    mkdirSync(join(proj, '.ssh'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(proj, 'a.txt'), 'x')
    writeFileSync(join(outside, 'b.txt'), 'x')
    symlinkSync(outside, join(proj, 'link'))
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const ctx = (roots: string[]) => ({ roots, extraDenied: [], home: base })

  it('refuses everything while the list is empty', () => {
    for (const m of ['fs.read', 'fs.list', 'fs.stat', 'search.files', 'git.status', 'git.log']) {
      expect(checkPathParams(m, { path: join(proj, 'a.txt'), query: 'x' }, ctx([])), m).toMatch(/isn't shared/)
    }
  })

  it('allows inside a root and refuses outside, for fs, search and git', () => {
    const c = ctx([proj])
    expect(checkPathParams('fs.read', { path: join(proj, 'a.txt') }, c)).toBeNull()
    expect(checkPathParams('search.ripgrep', { path: proj, query: 'x' }, c)).toBeNull()
    expect(checkPathParams('git.status', { path: proj }, c)).toBeNull()
    for (const m of ['fs.read', 'fs.list', 'search.files', 'git.status', 'git.diff']) {
      expect(checkPathParams(m, { path: join(outside, 'b.txt') }, c), m).toMatch(/isn't shared/)
    }
    // sibling with a shared prefix, parent, and symlink escape
    expect(checkPathParams('fs.list', { path: proj + '-evil' }, c)).toMatch(/isn't shared/)
    expect(checkPathParams('fs.list', { path: base }, c)).toMatch(/isn't shared/)
    expect(checkPathParams('fs.read', { path: join(proj, 'link', 'b.txt') }, c)).toMatch(/isn't shared/)
    expect(checkPathParams('fs.read', { path: proj + '/../other/b.txt' }, c)).toMatch(/\.\./)
    // case-insensitive match of the root
    expect(checkPathParams('fs.read', { path: join(proj, 'A.TXT') }, c)).toBeNull()
  })

  it('checks every path-like param, including git file/second paths', () => {
    const c = ctx([proj])
    expect(checkPathParams('fs.read', { path: join(proj, 'a.txt'), root: outside }, c)).toMatch(/isn't shared/)
    expect(checkPathParams('git.showFile', { path: proj, file: 'a.txt' }, c)).toBeNull()
    expect(checkPathParams('git.showFile', { path: proj, file: '.env' }, c)).toMatch(/blocked/)
    expect(checkPathParams('git.showFile', { path: proj, file: '../other/b.txt' }, c)).toMatch(/\.\./)
    expect(checkPathParams('git.showFile', { path: proj, file: join(outside, 'b.txt') }, c)).toMatch(/isn't shared/)
    expect(checkPathParams('git.prFileDiff', { path: proj, file: 'secrets/x.pem', number: 1 }, c)).toMatch(/blocked/)
    expect(checkPathParams('git.status', { path: proj, cwd: outside }, c)).toMatch(/isn't shared/)
    expect(checkPathParams('git.status', {}, c)).toMatch(/path is required/)
    expect(checkPathParams('git.status', { path: 'relative/dir' }, c)).toMatch(/absolute/)
  })

  it('keeps the denylist inside roots', () => {
    const c = ctx([proj])
    for (const f of ['.env', '.env.local', 'k.pem', 'k.p8', 'id.key', '.ssh/id_rsa', '.aws/credentials', '.gnupg/x', '.git-credentials', '.zsh_history', '.netrc', '.npmrc', '.pypirc', 'Library/Keychains/x', '.git/config', '.ENV']) {
      expect(checkPathParams('fs.read', { path: join(proj, f) }, c), f).toMatch(/blocked/)
    }
    // bridge/dorabot data dirs, even if somehow inside a root
    expect(checkPathParams('fs.read', { path: join(proj, 'a.txt') }, { ...c, extraDenied: [proj] })).toMatch(/blocked/)
  })

  it('filters search results to shared, non-sensitive files', () => {
    const c = ctx([proj])
    const out = filterSearchResult('search.files', {
      results: [
        { path: join(proj, 'a.txt'), line: 1, text: 'ok' },
        { path: join(proj, '.env'), line: 1, text: 'SECRET=1' },
        { path: join(proj, 'k.pem'), line: 1, text: 'x' },
        { path: join(proj, 'link', 'b.txt'), line: 1, text: 'escape' },
        { path: join(outside, 'b.txt'), line: 1, text: 'out' },
        { line: 3, text: 'no path' },
      ],
    }, c) as { results: Array<{ path: string }> }
    expect(out.results.map((r) => r.path)).toEqual([join(proj, 'a.txt')])
    expect(filterSearchResult('search.files', 'garbage', c)).toEqual({ results: [] })
    expect(filterSearchResult('fs.read', { content: 'x' }, c)).toEqual({ content: 'x' })
  })

  it('enforces the guard and result filter on forwarded RPCs', async () => {
    const h = await harness(['files', 'git'], [proj])
    expect((await h.rpc('fs.read', { path: join(outside, 'b.txt') })).error?.message).toMatch(/isn't shared/)
    expect((await h.rpc('git.log', { path: outside })).error?.message).toMatch(/isn't shared/)
    expect((await h.rpc('search.files', { path: outside, query: 'x' })).error?.message).toMatch(/isn't shared/)
    expect(h.calls).toEqual([])
    h.gatewayResults.set('search.files', { results: [{ path: join(proj, '.env'), line: 1, text: 'S=1' }, { path: join(proj, 'a.txt'), line: 1, text: 'ok' }] })
    const r = await h.rpc('search.files', { path: proj, query: 'x' })
    expect(r.error).toBeUndefined()
    expect((r.result as { results: unknown[] }).results).toHaveLength(1)
    expect((await h.rpc('remote.roots')).result).toEqual({ roots: [proj], expiry: {} })
  })

  it('remote.roots needs files or git', async () => {
    const h = await harness(['chat'], [proj])
    expect((await h.rpc('remote.roots')).error?.message).toMatch(/permission/)
  })
})

describe('roots store validation', () => {
  let base: string
  beforeAll(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 's2r-'))) })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('starts empty and adds/removes folders', () => {
    const dir = join(base, 'p')
    mkdirSync(dir)
    const store = createRootsStore(join(base, 'data', 'roots.json'), { home: join(base, 'home') })
    expect(store.listRoots()).toEqual([])
    expect(store.addRoot(dir)).toBe(dir)
    expect(store.addRoot(dir)).toBe(dir)
    expect(store.listRoots()).toEqual([dir])
    expect(store.removeRoot(dir)).toBe(true)
    expect(store.removeRoot(dir)).toBe(false)
    expect(store.listRoots()).toEqual([])
  })

  it('rejects bad roots', () => {
    const home = join(base, 'home')
    const data = join(home, '.dorabot')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(base, 'file.txt'), 'x')
    const store = createRootsStore(join(base, 'roots2.json'), { home, protectedPaths: () => [data, join(base, 'bridge-data')] })
    expect(() => store.addRoot('relative')).toThrow(/absolute/)
    expect(() => store.addRoot(join(base, 'missing'))).toThrow(/does not exist/)
    expect(() => store.addRoot(join(base, 'file.txt'))).toThrow(/not a folder/)
    expect(() => store.addRoot('/')).toThrow(/not allowed/)
    expect(() => store.addRoot(home)).toThrow(/not allowed/)
    expect(() => store.addRoot(base)).toThrow(/contains DoraBot/)
    expect(() => store.addRoot(data)).toThrow(/DoraBot/)
    expect(() => store.addRoot(base + '/x/../home')).toThrow(/\.\./)
    expect(store.listRoots()).toEqual([])
  })
})
