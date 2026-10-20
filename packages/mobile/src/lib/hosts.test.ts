import { describe, expect, it } from 'vitest'
import { SessionAggregator } from '@dorabot-remote/protocol'
import { SECRET_KEY } from './platform.js'
import {
  HostCaches,
  LEGACY_CURSOR_KEY,
  LEGACY_PAIRING_KEY,
  PAIRINGS_KEY,
  activePairing,
  cursorKey,
  displayName,
  emptyPairings,
  loadPairings,
  parsePairingsFile,
  removeLegacyIfMatches,
  removePairing,
  renamePairing,
  setActiveHost,
  upsertPairing,
  type HostPairing,
  type KeyValueIO,
} from './hosts.js'

const mk = (hostId: string, over: Partial<HostPairing> = {}): HostPairing => ({
  deviceId: `dev-${hostId}`,
  hostId,
  hostName: `Mac ${hostId}`,
  hostPublicKey: `pk-${hostId}`,
  addresses: ['10.0.0.2:7777'],
  identity: { publicKey: 'ipub', privateKey: 'ipriv' },
  scopes: ['sessions', 'chat', 'approvals'],
  pairedAt: 100,
  addedAt: 100,
  ...over,
})

function memIO(initial: Record<string, string> = {}, failSet?: (k: string) => boolean): KeyValueIO & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      if (failSet?.(k)) throw new Error('disk full')
      data.set(k, v)
    },
    remove: async (k) => void data.delete(k),
  }
}

describe('secure storage routing', () => {
  it('keeps the pairings (v1 and v2) in secure storage, not preferences', () => {
    expect(SECRET_KEY.test(PAIRINGS_KEY)).toBe(true)
    expect(SECRET_KEY.test(LEGACY_PAIRING_KEY)).toBe(true)
    expect(SECRET_KEY.test(cursorKey('h'))).toBe(false)
  })
})

describe('migration from the single v1 pairing', () => {
  const { addedAt: _a, ...v1 } = mk('h1', { pairedAt: 555 })
  void _a

  it('wraps it into a one-entry list, makes it active, and copies the cursor', async () => {
    const io = memIO({ [LEGACY_PAIRING_KEY]: JSON.stringify(v1), [LEGACY_CURSOR_KEY]: '42' })
    const r = await loadPairings(io)
    expect(r.migrated).toBe(true)
    expect(r.file.activeHostId).toBe('h1')
    expect(r.file.pairings).toHaveLength(1)
    expect(r.file.pairings[0]).toMatchObject({ hostId: 'h1', deviceId: 'dev-h1', pairedAt: 555, addedAt: 555, identity: { privateKey: 'ipriv' } })
    expect(parsePairingsFile(io.data.get(PAIRINGS_KEY) ?? null)?.pairings[0]?.hostId).toBe('h1')
    expect(io.data.get(cursorKey('h1'))).toBe('42')
  })

  it('leaves v1 readable for rollback in this release', async () => {
    const io = memIO({ [LEGACY_PAIRING_KEY]: JSON.stringify(v1) })
    await loadPairings(io)
    expect(io.data.has(LEGACY_PAIRING_KEY)).toBe(true)
  })

  it('is idempotent: once v2 exists it is the only source', async () => {
    const io = memIO({ [LEGACY_PAIRING_KEY]: JSON.stringify(v1) })
    await loadPairings(io)
    const f = upsertPairing((await loadPairings(io)).file, mk('h2'))
    io.data.set(PAIRINGS_KEY, JSON.stringify(f))
    const again = await loadPairings(io)
    expect(again.migrated).toBe(false)
    expect(again.file.pairings.map((p) => p.hostId)).toEqual(['h1', 'h2'])
  })

  it('a failed v2 write still returns the pairing for this launch and does not claim success', async () => {
    const io = memIO({ [LEGACY_PAIRING_KEY]: JSON.stringify(v1) }, (k) => k === PAIRINGS_KEY)
    const r = await loadPairings(io)
    expect(r.migrated).toBe(false)
    expect(r.file.pairings[0]?.hostId).toBe('h1')
    expect(io.data.has(LEGACY_PAIRING_KEY)).toBe(true)
  })

  it('(b) a read error on v2 never writes: retries once, then runs read-only on v1 and flags degraded', async () => {
    const other = mk('h2')
    const v2 = JSON.stringify({ v: 2, activeHostId: 'h1', pairings: [mk('h1'), other] })
    const io = memIO({ [PAIRINGS_KEY]: v2, [LEGACY_PAIRING_KEY]: JSON.stringify(v1) })
    let reads = 0
    const flaky: KeyValueIO & { data: Map<string, string> } = {
      ...io,
      get: async (k) => {
        if (k === PAIRINGS_KEY) {
          reads++
          throw new Error('Secure storage did not respond')
        }
        return io.get(k)
      },
      set: async (k) => {
        throw new Error(`unexpected write ${k}`)
      },
    }
    const r = await loadPairings(flaky, { retryDelayMs: 0 })
    expect(reads).toBe(2)
    expect(r.degraded).toBe(true)
    expect(r.migrated).toBe(false)
    expect(r.file.pairings.map((p) => p.hostId)).toEqual(['h1'])
    expect(io.data.get(PAIRINGS_KEY)).toBe(v2) // the other Mac is untouched
  })

  it('(b) a transient read error is retried and succeeds', async () => {
    const v2 = JSON.stringify({ v: 2, activeHostId: 'h1', pairings: [mk('h1'), mk('h2')] })
    const io = memIO({ [PAIRINGS_KEY]: v2 })
    let first = true
    const r = await loadPairings({ ...io, get: async (k) => { if (k === PAIRINGS_KEY && first) { first = false; throw new Error('timeout') } return io.get(k) } }, { retryDelayMs: 0 })
    expect(r.degraded).toBe(false)
    expect(r.file.pairings).toHaveLength(2)
  })

  it('(c) an unparseable v2 is backed up before anything is rewritten, and never silently replaced', async () => {
    const io = memIO({ [PAIRINGS_KEY]: '{"v":3,"weird":true}', [LEGACY_PAIRING_KEY]: JSON.stringify(v1) })
    const logs: string[] = []
    const r = await loadPairings(io, { now: () => 777, log: (m) => logs.push(m) })
    const backup = `${PAIRINGS_KEY}.corrupt.777`
    expect(r.backedUpTo).toBe(backup)
    expect(io.data.get(backup)).toBe('{"v":3,"weird":true}')
    expect(logs.join('\n')).toContain(backup)
    expect(r.file.pairings[0]?.hostId).toBe('h1')
  })

  it('(c) if the backup itself cannot be written, nothing is overwritten', async () => {
    const io = memIO({ [PAIRINGS_KEY]: 'garbage', [LEGACY_PAIRING_KEY]: JSON.stringify(v1) }, () => true)
    const r = await loadPairings(io)
    expect(r.degraded).toBe(true)
    expect(io.data.get(PAIRINGS_KEY)).toBe('garbage')
  })

  it('drops a corrupt v1 record and starts empty', async () => {
    const io = memIO({ [LEGACY_PAIRING_KEY]: '{nope' })
    expect((await loadPairings(io)).file).toEqual(emptyPairings)
    expect(io.data.has(LEGACY_PAIRING_KEY)).toBe(false)
  })

  it('nothing stored is an empty list', async () => {
    expect(await loadPairings(memIO())).toEqual({ file: emptyPairings, migrated: false, degraded: false })
  })

  it('unpairing the migrated Mac removes the v1 copy so a rollback cannot resurrect it', async () => {
    const io = memIO({ [LEGACY_PAIRING_KEY]: JSON.stringify(v1), [LEGACY_CURSOR_KEY]: '1' })
    await removeLegacyIfMatches(io, 'other')
    expect(io.data.has(LEGACY_PAIRING_KEY)).toBe(true)
    await removeLegacyIfMatches(io, 'h1')
    expect(io.data.has(LEGACY_PAIRING_KEY)).toBe(false)
    expect(io.data.has(LEGACY_CURSOR_KEY)).toBe(false)
  })
})

describe('list operations', () => {
  it('adding makes the new Mac active; re-pairing the same Mac replaces it and keeps addedAt and nickname', () => {
    let f = upsertPairing(emptyPairings, mk('a', { addedAt: 1 }))
    f = renamePairing(f, 'a', 'Studio')
    f = upsertPairing(f, mk('b', { addedAt: 2 }))
    expect(f.activeHostId).toBe('b')
    f = upsertPairing(f, mk('a', { addedAt: 9, deviceId: 'new-dev' }))
    expect(f.pairings).toHaveLength(2)
    expect(f.activeHostId).toBe('a')
    expect(f.pairings.find((p) => p.hostId === 'a')).toMatchObject({ deviceId: 'new-dev', addedAt: 1, alias: 'Studio' })
  })

  it('removing the active Mac falls back to the newest remaining one; removing the last empties it', () => {
    let f = upsertPairing(upsertPairing(upsertPairing(emptyPairings, mk('a', { addedAt: 1 })), mk('b', { addedAt: 3 })), mk('c', { addedAt: 2 }))
    f = setActiveHost(f, 'c')
    f = removePairing(f, 'c')
    expect(f.activeHostId).toBe('b')
    f = removePairing(removePairing(f, 'a'), 'b')
    expect(f).toEqual(emptyPairings)
  })

  it('removing a non-active Mac keeps the active one', () => {
    const f = removePairing(setActiveHost(upsertPairing(upsertPairing(emptyPairings, mk('a')), mk('b')), 'a'), 'b')
    expect(f.activeHostId).toBe('a')
  })

  it('setActiveHost ignores unknown ids', () => {
    const f = upsertPairing(emptyPairings, mk('a'))
    expect(setActiveHost(f, 'zzz')).toBe(f)
  })

  it('local rename: nickname wins for display, blank clears it, the Mac name is untouched', () => {
    let f = upsertPairing(emptyPairings, mk('a'))
    f = renamePairing(f, 'a', '  Work   Mac ')
    expect(displayName(f.pairings[0]!)).toBe('Work Mac')
    expect(f.pairings[0]!.hostName).toBe('Mac a')
    f = renamePairing(f, 'a', '   ')
    expect(displayName(f.pairings[0]!)).toBe('Mac a')
    expect(activePairing(f)?.alias).toBeUndefined()
  })

  it('parse repairs a dangling active id and drops duplicates and junk', () => {
    const raw = JSON.stringify({ v: 2, activeHostId: 'gone', pairings: [mk('a'), mk('a'), { nope: 1 }, mk('b')] })
    const f = parsePairingsFile(raw)!
    expect(f.pairings.map((p) => p.hostId)).toEqual(['a', 'b'])
    expect(f.activeHostId).toBe('a')
    expect(parsePairingsFile('x')).toBeNull()
    expect(parsePairingsFile(JSON.stringify({ v: 1, pairings: [] }))).toBeNull()
  })
})

describe('per-host caches do not mix on switching', () => {
  it('each Mac gets its own aggregator, sessions, pins, history flags and cursor', () => {
    const c = new HostCaches()
    const a = c.get('a')
    const b = c.get('b')
    expect(a).not.toBe(b)
    expect(a.agg).not.toBe(b.agg)
    expect(a.loadedHistory).not.toBe(b.loadedHistory)
    a.agg.cursor = 17
    a.sessions = [{ id: 's1' } as never]
    a.pins = [{ id: 'k', pinnedAt: 1 }]
    a.loadedHistory.add('k')
    a.historyInfo.set('k', { shown: 1, total: 2 })
    expect(b.agg.cursor).toBe(0)
    expect(b.sessions).toEqual([])
    expect(b.pins).toEqual([])
    expect(b.loadedHistory.size).toBe(0)
    expect(b.historyInfo.size).toBe(0)
    // Switching back finds the same state, not a new one.
    expect(c.get('a')).toBe(a)
    expect(c.get('a').agg.cursor).toBe(17)
  })

  it('events applied to one Mac never appear in the other', () => {
    const c = new HostCaches()
    c.get('a').agg.get('k1')
    expect(c.get('a').agg.keys()).toContain('k1')
    expect(c.get('b').agg.keys()).toEqual([])
  })

  it('unpairing drops that Mac only; cursors are namespaced by host', () => {
    const c = new HostCaches()
    c.get('a')
    c.get('b')
    c.drop('a')
    expect(c.hostIds()).toEqual(['b'])
    expect(c.get('a').agg).toBeInstanceOf(SessionAggregator)
    expect(cursorKey('a')).not.toBe(cursorKey('b'))
  })
})
