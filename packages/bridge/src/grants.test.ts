/**
 * T9a: time-limited permissions. Scopes and shared folders can carry an expiry; the policy check ignores a
 * lapsed grant immediately, and the sweep makes it official (audit entry + phone notified).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_GRANT_MS, MIN_GRANT_MS, formatRemaining, parseDuration } from './duration.js'
import { createRootsStore } from './roots.js'
import { Store } from './store.js'
import { startHarness, until, wait, type Harness } from '../test/harness.js'

describe('parseDuration', () => {
  it('accepts the usual spellings', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('8h')).toBe(8 * 3_600_000)
    expect(parseDuration('24h')).toBe(86_400_000)
    expect(parseDuration('90m')).toBe(90 * 60_000)
    expect(parseDuration('2d')).toBe(2 * 86_400_000)
    expect(parseDuration('1.5 hours')).toBe(5_400_000)
  })
  it('refuses junk and out-of-range values', () => {
    for (const bad of ['', 'h', '1', '1x', '-1h', '30s', '31d', '0m', undefined, 5, null]) expect(parseDuration(bad as never)).toBeNull()
    expect(parseDuration('1m')).toBe(MIN_GRANT_MS)
    expect(parseDuration('30d')).toBe(MAX_GRANT_MS)
  })
  it('formats what is left', () => {
    expect(formatRemaining(30_000)).toBe('1m')
    expect(formatRemaining(8 * 3_600_000)).toBe('8h')
    expect(formatRemaining(90 * 60_000)).toBe('1h 30m')
    expect(formatRemaining(3 * 86_400_000)).toBe('3d')
  })
})

describe('store: scope expiry', () => {
  const mk = (s: Store) => s.createDevice({ name: 'p', platform: 'ios', publicKey: `pk${Math.random()}`, scopes: ['sessions', 'chat'], pending: false })

  it('a lapsed scope is not granted even before the sweep', () => {
    const s = new Store(':memory:')
    const d = mk(s)
    s.setScopes(d.id, ['sessions', 'chat', 'terminal'], { terminal: Date.now() + 60_000 })
    expect(s.getDevice(d.id)!.scopes).toContain('terminal')
    expect(s.getDevice(d.id)!.scopeExpiry!.terminal).toBeGreaterThan(Date.now())
    s.setScopes(d.id, ['sessions', 'chat', 'terminal'], { terminal: Date.now() - 1 })
    const got = s.getDevice(d.id)!
    expect(got.scopes).toEqual(['sessions', 'chat'])
    expect(got.scopeExpiry).toEqual({})
    s.close()
  })

  it('the sweep removes the lapsed scope once and reports it', () => {
    const s = new Store(':memory:')
    const d = mk(s)
    s.setScopes(d.id, ['sessions', 'terminal', 'files'], { terminal: Date.now() - 5, files: Date.now() + 60_000 })
    const out = s.expireScopes()
    expect(out).toHaveLength(1)
    expect(out[0]!.scopes).toEqual(['terminal'])
    expect(out[0]!.device.scopes).toEqual(['sessions', 'files'])
    expect(s.expireScopes()).toEqual([])
    s.close()
  })

  it('keeps limits of surviving scopes, drops limits of removed ones, and clears on null', () => {
    const s = new Store(':memory:')
    const d = mk(s)
    const at = Date.now() + 3_600_000
    s.setScopes(d.id, ['sessions', 'terminal', 'files'], { terminal: at, files: at })
    s.setScopes(d.id, ['sessions', 'terminal']) // files removed
    expect(s.getDevice(d.id)!.scopeExpiry).toEqual({ terminal: at })
    s.setScopes(d.id, ['sessions', 'terminal'], { terminal: null }) // made permanent
    expect(s.getDevice(d.id)!.scopeExpiry).toEqual({})
    s.close()
  })

  it('an approved request can carry a limit', () => {
    const s = new Store(':memory:')
    const d = mk(s)
    const req = s.createScopeRequest(d.id, 'terminal', 'need it')
    const at = Date.now() + 3_600_000
    const res = s.resolveScopeRequest(req.id, true, at)!
    expect(res.device.scopes).toContain('terminal')
    expect(res.device.scopeExpiry).toEqual({ terminal: at })
    s.close()
  })

  it('shows the limits in the device summary', () => {
    const s = new Store(':memory:')
    const d = mk(s)
    s.setScopes(d.id, ['sessions', 'terminal'], { terminal: Date.now() + 60_000 })
    expect(Object.keys(s.toSummary(s.getDevice(d.id)!, 'fp').scopeExpiry ?? {})).toEqual(['terminal'])
    s.close()
  })
})

describe('roots: folder expiry', () => {
  it('a lapsed folder is not listed, and the sweep removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-roots-'))
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a)
    mkdirSync(b)
    let now = 1_000_000
    const store = createRootsStore(join(dir, 'roots.json'), { home: '/nonexistent-home', now: () => now })
    const ra = store.addRoot(a, { expiresAt: now + 1000 })
    const rb = store.addRoot(b)
    expect(store.listRoots().sort()).toEqual([ra, rb].sort())
    expect(store.listExpiry()).toEqual({ [ra]: now + 1000 })
    now += 1001
    expect(store.listRoots()).toEqual([rb])
    expect(store.listExpiry()).toEqual({})
    expect(store.sweepExpired()).toEqual([ra])
    expect(store.sweepExpired()).toEqual([])
    expect(store.listRoots()).toEqual([rb])
    rmSync(dir, { recursive: true, force: true })
  })

  it('re-adding renews or clears the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-roots-'))
    const a = join(dir, 'a')
    mkdirSync(a)
    const store = createRootsStore(join(dir, 'roots.json'), { home: '/nonexistent-home' })
    const r = store.addRoot(a, { expiresAt: Date.now() + 5000 })
    expect(Object.keys(store.listExpiry())).toEqual([r])
    store.addRoot(a)
    expect(store.listExpiry()).toEqual({})
    expect(store.listRoots()).toEqual([r])
    rmSync(dir, { recursive: true, force: true })
  })
})

let h: Harness
describe('bridge enforcement', () => {
  beforeAll(async () => {
    h = await startHarness(7882)
  }, 30_000)
  afterAll(async () => {
    await h?.stop()
  })

  it('control API grants a scope for a time, audits it, and the phone sees the limit', async () => {
    const pair = await h.pairApproved('Timed phone')
    const client = await h.connect(pair)
    const before = h.bridge.store.getDevice(pair.deviceId)!
    const next = [...before.scopes, 'git']
    const res = await h.post('/api/device', { deviceId: pair.deviceId, action: 'scopes', scopes: next, scope: 'git', forMs: 3_600_000 })
    expect(res.body.ok).toBe(true)
    const d = h.bridge.store.getDevice(pair.deviceId)!
    expect(d.scopes).toContain('git')
    expect(d.scopeExpiry!.git).toBeGreaterThan(Date.now() + 3_500_000)
    expect(h.bridge.store.listAudit({ deviceId: pair.deviceId }).some((e) => e.action === 'scopes' && /git until 20/.test(e.summary ?? ''))).toBe(true)
    await until(() => client.hasScope('git'), 3000, 'phone sees git')
    expect(client.device?.scopeExpiry?.git).toBe(d.scopeExpiry!.git)
    client.disconnect()
  })

  it('rejects absurd limits', async () => {
    const pair = await h.pairApproved('Bad limit')
    const res = await h.post('/api/device', { deviceId: pair.deviceId, action: 'scopes', scopes: ['sessions', 'chat', 'git'], scope: 'git', forMs: 5 })
    expect(res.status).toBe(400)
  })

  it('enforces expiry at once and the sweep audits it and tells the phone', async () => {
    const pair = await h.pairApproved('Short lease')
    const client = await h.connect(pair)
    const base = h.bridge.store.getDevice(pair.deviceId)!.scopes
    // Granted through the API (pushes to the phone at once), then shortened so the test need not wait a minute.
    await h.post('/api/device', { deviceId: pair.deviceId, action: 'scopes', scopes: [...base, 'work'], scope: 'work', forMs: 3_600_000 })
    h.bridge.store.setScopes(pair.deviceId, [...base, 'work'], { work: Date.now() + 700 })
    await until(() => client.hasScope('work'), 3000, 'phone has work')
    const code = (): Promise<unknown> => client.rpc('tasks.list').then(() => 'ok', (e: { code?: string }) => e.code)
    expect(await code()).not.toBe('forbidden')
    await wait(800)
    // Policy check: the very next call is refused, before any sweep.
    expect(h.bridge.store.getDevice(pair.deviceId)!.scopes).not.toContain('work')
    expect(await code()).toBe('forbidden')
    // Sweep: audit + phone notified.
    expect(h.bridge.sweepExpiredGrants()).toBe(1)
    expect(h.bridge.sweepExpiredGrants()).toBe(0)
    await until(() => !client.hasScope('work'), 3000, 'phone drops work')
    const entries = h.bridge.store.listAudit({ deviceId: pair.deviceId }).filter((e) => e.action === 'scope_expire')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.summary).toBe('scope=work time limit ended')
    client.disconnect()
  }, 30_000)

  it('shared folders: limit via the API, listed to the phone, swept with an audit entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-share-'))
    const folder = join(dir, 'proj')
    mkdirSync(folder)
    const add = await h.post('/api/roots', { action: 'add', path: folder, forMs: 3_600_000 })
    expect(add.body.ok).toBe(true)
    const real = add.body.roots[0]
    expect(add.body.expiry[real]).toBeGreaterThan(Date.now())
    const st = (await h.get('/api/state')).body
    expect(st.rootsExpiry[real]).toBeGreaterThan(Date.now())

    const pair = await h.pairApproved('Files phone', ['sessions', 'files'])
    const client = await h.connect(pair)
    const roots = await client.rpc<{ roots: string[]; expiry: Record<string, number> }>('remote.roots')
    expect(roots.roots).toContain(real)
    expect(roots.expiry[real]).toBe(add.body.expiry[real])
    client.disconnect()

    // Force it to lapse, then sweep.
    h.bridge.roots.addRoot(folder, { expiresAt: Date.now() - 1 })
    expect(h.bridge.roots.listRoots()).not.toContain(real)
    expect(h.bridge.sweepExpiredGrants()).toBeGreaterThanOrEqual(1)
    expect(h.bridge.store.listAudit({ limit: 50 }).some((e) => e.action === 'folder_expire' && e.summary === real)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
