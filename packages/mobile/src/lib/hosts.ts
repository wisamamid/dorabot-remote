/**
 * Several paired Macs. Pure storage shape, migration and per-host cache logic;
 * the React layer (connection.tsx) wires it to the live client.
 *
 * Secrets stay in secure storage: the whole file below is one secure-storage
 * value. One Mac is active at a time (one RemoteClient).
 */
import { SessionAggregator, type RelayInfo, type Scope, type StoredSession } from '@dorabot-remote/protocol'
import type { Pin } from './pins.js'

export const PAIRINGS_KEY = 'dorabot-remote.pairings.v2'
/** The pre-D2 single pairing. Left in place after migration for one release so a rollback still finds it. */
export const LEGACY_PAIRING_KEY = 'dorabot-remote.pairing.v1'
export const LEGACY_CURSOR_KEY = 'dorabot-remote.cursor.v1'
/** Next release: set to false so a successful migration deletes the v1 copy. */
export const KEEP_LEGACY_V1 = true

export const cursorKey = (hostId: string): string => `dorabot-remote.cursor.v2.${hostId}`

export interface StoredPairing {
  deviceId: string
  hostId: string
  hostName: string
  hostPublicKey: string
  addresses: string[]
  /** Blind relay, persisted so a cold start off the LAN can still reach the Mac. */
  relay?: RelayInfo
  identity: { publicKey: string; privateKey: string }
  scopes: Scope[]
  pairedAt: number
}

export interface HostPairing extends StoredPairing {
  addedAt: number
  /** Local nickname; the Mac's own name stays in hostName. */
  alias?: string
}

export interface PairingsFile {
  v: 2
  activeHostId: string | null
  pairings: HostPairing[]
}

export const MAX_ALIAS = 40

export function displayName(p: Pick<HostPairing, 'hostName' | 'alias'>): string {
  return (p.alias && p.alias.trim()) || p.hostName || 'Mac'
}

export function normalizeAlias(raw: string): string | undefined {
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS)
  return s || undefined
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Accepts a v1 record (or a v2 entry); returns null if essential fields are missing. */
export function toHostPairing(v: unknown, now = Date.now()): HostPairing | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Partial<HostPairing>
  if (!isStr(p.deviceId) || !isStr(p.hostId) || !isStr(p.hostPublicKey) || !p.identity || !isStr(p.identity.publicKey) || !isStr(p.identity.privateKey)) return null
  if (!Array.isArray(p.addresses)) return null
  const pairedAt = typeof p.pairedAt === 'number' ? p.pairedAt : now
  return {
    deviceId: p.deviceId,
    hostId: p.hostId,
    hostName: typeof p.hostName === 'string' ? p.hostName : '',
    hostPublicKey: p.hostPublicKey,
    addresses: p.addresses.filter((a): a is string => typeof a === 'string'),
    ...(p.relay ? { relay: p.relay } : {}),
    identity: { publicKey: p.identity.publicKey, privateKey: p.identity.privateKey },
    scopes: Array.isArray(p.scopes) ? p.scopes : [],
    pairedAt,
    addedAt: typeof p.addedAt === 'number' ? p.addedAt : pairedAt,
    ...(typeof p.alias === 'string' && p.alias ? { alias: p.alias } : {}),
  }
}

export function parsePairingsFile(raw: string | null): PairingsFile | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PairingsFile>
    if (!v || v.v !== 2 || !Array.isArray(v.pairings)) return null
    const seen = new Set<string>()
    const pairings: HostPairing[] = []
    for (const e of v.pairings) {
      const p = toHostPairing(e)
      if (!p || seen.has(p.hostId)) continue
      seen.add(p.hostId)
      pairings.push(p)
    }
    const active = typeof v.activeHostId === 'string' && seen.has(v.activeHostId) ? v.activeHostId : (pairings[0]?.hostId ?? null)
    return { v: 2, activeHostId: active, pairings }
  } catch {
    return null
  }
}

export const emptyPairings: PairingsFile = { v: 2, activeHostId: null, pairings: [] }

export function activePairing(f: PairingsFile): HostPairing | null {
  return f.pairings.find((p) => p.hostId === f.activeHostId) ?? null
}

/** Add or (re-pairing the same Mac) replace by hostId, and make it active. addedAt of an existing Mac is kept. */
export function upsertPairing(f: PairingsFile, p: HostPairing): PairingsFile {
  const prev = f.pairings.find((x) => x.hostId === p.hostId)
  const merged: HostPairing = prev ? { ...p, addedAt: prev.addedAt, ...(prev.alias ? { alias: prev.alias } : {}) } : p
  const pairings = prev ? f.pairings.map((x) => (x.hostId === p.hostId ? merged : x)) : [...f.pairings, merged]
  return { v: 2, activeHostId: p.hostId, pairings }
}

export function setActiveHost(f: PairingsFile, hostId: string): PairingsFile {
  return f.pairings.some((p) => p.hostId === hostId) && f.activeHostId !== hostId ? { ...f, activeHostId: hostId } : f
}

/** Removing the active Mac falls back to the one added most recently. */
export function removePairing(f: PairingsFile, hostId: string): PairingsFile {
  const pairings = f.pairings.filter((p) => p.hostId !== hostId)
  let active = f.activeHostId
  if (active === hostId || !pairings.some((p) => p.hostId === active)) {
    active = [...pairings].sort((a, b) => b.addedAt - a.addedAt)[0]?.hostId ?? null
  }
  return { v: 2, activeHostId: active, pairings }
}

export function updatePairing(f: PairingsFile, hostId: string, patch: (p: HostPairing) => HostPairing): PairingsFile {
  return { ...f, pairings: f.pairings.map((p) => (p.hostId === hostId ? patch(p) : p)) }
}

export function renamePairing(f: PairingsFile, hostId: string, alias: string): PairingsFile {
  const a = normalizeAlias(alias)
  return updatePairing(f, hostId, (p) => {
    const { alias: _old, ...rest } = p
    void _old
    return a ? { ...rest, alias: a } : rest
  })
}

// ---- storage + migration ---------------------------------------------------

export interface KeyValueIO {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface LoadResult {
  file: PairingsFile
  /** True when this call converted a v1 pairing. */
  migrated: boolean
}

/**
 * Read the pairings. If only the v1 single pairing exists, convert it: write v2
 * first, copy its resume cursor to the per-host key, and only then (never in this
 * release, see KEEP_LEGACY_V1) delete v1. A failed v2 write keeps the app on the
 * v1 data for this launch and retries next time.
 */
export async function loadPairings(io: KeyValueIO): Promise<LoadResult> {
  const v2 = parsePairingsFile(await io.get(PAIRINGS_KEY).catch(() => null))
  if (v2) return { file: v2, migrated: false }

  const rawV1 = await io.get(LEGACY_PAIRING_KEY).catch(() => null)
  if (!rawV1) return { file: emptyPairings, migrated: false }
  let v1: HostPairing | null = null
  try {
    v1 = toHostPairing(JSON.parse(rawV1))
  } catch {
    v1 = null
  }
  if (!v1) {
    await io.remove(LEGACY_PAIRING_KEY).catch(() => {})
    return { file: emptyPairings, migrated: false }
  }
  const file: PairingsFile = { v: 2, activeHostId: v1.hostId, pairings: [v1] }
  try {
    await io.set(PAIRINGS_KEY, JSON.stringify(file))
    const cur = await io.get(LEGACY_CURSOR_KEY).catch(() => null)
    if (cur) await io.set(cursorKey(v1.hostId), cur).catch(() => {})
    if (!KEEP_LEGACY_V1) {
      await io.remove(LEGACY_PAIRING_KEY).catch(() => {})
      await io.remove(LEGACY_CURSOR_KEY).catch(() => {})
    }
    return { file, migrated: true }
  } catch {
    return { file, migrated: false }
  }
}

/** Drop the v1 copy if it is the Mac being unpaired, so a rollback build cannot resurrect it. */
export async function removeLegacyIfMatches(io: KeyValueIO, hostId: string): Promise<void> {
  const raw = await io.get(LEGACY_PAIRING_KEY).catch(() => null)
  if (!raw) return
  try {
    if ((JSON.parse(raw) as { hostId?: string }).hostId !== hostId) return
  } catch {
    // unreadable: remove it anyway
  }
  await io.remove(LEGACY_PAIRING_KEY).catch(() => {})
  await io.remove(LEGACY_CURSOR_KEY).catch(() => {})
}

// ---- per-host caches -------------------------------------------------------

/** Everything the UI keeps in memory for one Mac. Never shared between Macs. */
export interface HostCache {
  agg: SessionAggregator
  sessions: StoredSession[]
  pins: Pin[]
  loadedHistory: Set<string>
  historyInfo: Map<string, { shown: number; total: number }>
}

export class HostCaches {
  private readonly map = new Map<string, HostCache>()

  get(hostId: string): HostCache {
    let c = this.map.get(hostId)
    if (!c) {
      c = { agg: new SessionAggregator(), sessions: [], pins: [], loadedHistory: new Set(), historyInfo: new Map() }
      this.map.set(hostId, c)
    }
    return c
  }

  has(hostId: string): boolean {
    return this.map.has(hostId)
  }

  drop(hostId: string): void {
    this.map.delete(hostId)
  }

  hostIds(): string[] {
    return [...this.map.keys()]
  }
}
