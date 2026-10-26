import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DeviceSummary, Scope } from '@dorabot-remote/protocol'
import { SCOPE_DEFAULTS } from '@dorabot-remote/protocol'

export interface DeviceRecord {
  id: string
  name: string
  platform: string
  publicKey: string
  scopes: Scope[]
  createdAt: number
  lastSeenAt: number | null
  revoked: boolean
  /** FCM/APNs token the phone registered over the E2E channel, if any. */
  pushToken?: string | null
  pushPlatform?: 'ios' | 'android' | null
  /** APNs environment the iOS token belongs to. */
  pushEnv?: 'production' | 'sandbox'
  /** Also push when a run finishes or fails. Off by default. */
  pushOnResult?: boolean
  /** base64 32-byte key the phone generated; encrypts push content. Never logged or sent anywhere but used locally. */
  pushKey?: string | null
  /** Paired, but the user has not approved it on the Mac yet. Must never act. */
  pending?: boolean
  pendingSince?: number | null
  /** Set when the bridge (not the user) revoked it, e.g. 'expired', 'lost', 'lockdown'. */
  revokedReason?: string | null
  /** Still-running time limits: scope -> epoch ms it lapses. A lapsed scope is already absent from `scopes`. */
  scopeExpiry?: Record<string, number>
}

export interface AuditEntry {
  /** Device that acted, or null for actions taken on the Mac itself. */
  deviceId?: string | null
  deviceName?: string | null
  /** e.g. pair, approve, reject, revoke, scopes, rpc */
  action: string
  /** RPC method for action 'rpc'. */
  method?: string | null
  requestId?: string | null
  /** Short, non-sensitive description. Never prompt text or file contents. */
  summary?: string | null
  /** direct | relay | mac | local */
  transport?: string | null
}

export interface AuditRecord {
  id: number
  at: number
  deviceId: string | null
  deviceName: string | null
  action: string
  method: string | null
  requestId: string | null
  summary: string | null
  transport: string | null
}

export interface ScopeRequest {
  id: string
  deviceId: string
  deviceName: string
  scope: Scope
  reason: string
  createdAt: number
  status: 'pending' | 'granted' | 'denied'
}

export interface PinRecord {
  id: string
  pinnedAt: number
}

export interface AllowRuleRecord {
  id: string
  kind: 'tool' | 'exact'
  toolName: string
  command: string | null
  createdAt: number
  createdBy: string | null
}

export interface StoredEvent {
  seq: number
  event: string
  sessionKey: string | null
  data: string
  createdAt: number
}

/**
 * Bridge state: paired devices, live pairing codes, and a durable copy of the
 * session event stream.
 *
 * The event log exists because dorabot prunes its own `stream_events` ten minutes
 * after a run finishes. A phone that was in a tunnel for an hour would otherwise
 * reconnect to nothing. We keep our own copy and replay from it, paced, which also
 * sidesteps the gateway's unpaced replay path tripping its own 2 MiB backpressure
 * cutoff.
 */
export class Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') this.lockDownFiles(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** The DB holds device keys' public halves, push tokens and the audit log: owner only. */
  private lockDownFiles(path: string): void {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        if (existsSync(f)) chmodSync(f, 0o600)
      } catch {
        // Not ours to chmod; nothing more we can do.
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        platform    TEXT NOT NULL DEFAULT 'unknown',
        public_key  TEXT NOT NULL UNIQUE,
        scopes      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pairings (
        code        TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        scopes      TEXT NOT NULL,
        used_at     INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        event       TEXT NOT NULL,
        session_key TEXT,
        data        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_seq ON events (session_key, seq);
      CREATE INDEX IF NOT EXISTS events_created ON events (created_at);

      CREATE TABLE IF NOT EXISTS scope_requests (
        id          TEXT PRIMARY KEY,
        device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        scope       TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS scope_requests_status ON scope_requests (status);

      CREATE TABLE IF NOT EXISTS pins (
        id        TEXT PRIMARY KEY,
        pinned_at INTEGER NOT NULL
      );

      -- Bridge-managed auto-approve rules ("always allow"). Never touches dorabot's own config.
      CREATE TABLE IF NOT EXISTS allow_rules (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        tool_name  TEXT NOT NULL,
        command    TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT
      );

      -- Coarse network keys each device has connected from (see network-class.ts), for new-network alerts.
      CREATE TABLE IF NOT EXISTS device_networks (
        device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        net_key    TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL,
        PRIMARY KEY (device_id, net_key)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS login_tokens (
        hash       TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          INTEGER NOT NULL,
        device_id   TEXT,
        device_name TEXT,
        action      TEXT NOT NULL,
        method      TEXT,
        request_id  TEXT,
        summary     TEXT,
        transport   TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_device ON audit_log (device_id, id);
      -- Append-only: rows can be neither edited nor removed.
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    `)
    // Added after the first release, so existing databases need the columns grafted on.
    const cols = (this.db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>).map((c) => c.name)
    if (!cols.includes('push_token')) this.db.exec('ALTER TABLE devices ADD COLUMN push_token TEXT')
    if (!cols.includes('push_platform')) this.db.exec('ALTER TABLE devices ADD COLUMN push_platform TEXT')
    if (!cols.includes('push_env')) this.db.exec("ALTER TABLE devices ADD COLUMN push_env TEXT NOT NULL DEFAULT 'production'")
    if (!cols.includes('push_key')) this.db.exec('ALTER TABLE devices ADD COLUMN push_key TEXT')
    if (!cols.includes('pending')) this.db.exec('ALTER TABLE devices ADD COLUMN pending INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('pending_since')) this.db.exec('ALTER TABLE devices ADD COLUMN pending_since INTEGER')
    if (!cols.includes('revoked_reason')) this.db.exec('ALTER TABLE devices ADD COLUMN revoked_reason TEXT')
    if (!cols.includes('scope_expiry')) this.db.exec('ALTER TABLE devices ADD COLUMN scope_expiry TEXT')
    if (!cols.includes('push_on_result')) this.db.exec('ALTER TABLE devices ADD COLUMN push_on_result INTEGER NOT NULL DEFAULT 0')
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Small key/value store, used for gateway replay cursors
  // -------------------------------------------------------------------------

  getMeta<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // -------------------------------------------------------------------------
  // Pinned sessions (shared by every paired device; dorabot itself has no pins)
  // -------------------------------------------------------------------------

  /** Pins, most recently pinned first. `id` is the session key (`channel:chatType:chatId`). */
  listPins(): PinRecord[] {
    const rows = this.db.prepare('SELECT id, pinned_at FROM pins ORDER BY pinned_at DESC, id ASC').all() as Array<{
      id: string
      pinned_at: number
    }>
    return rows.map((r) => ({ id: r.id, pinnedAt: Number(r.pinned_at) }))
  }

  /** Returns true when the set of pins changed. Re-pinning keeps the original pinnedAt. */
  setPin(id: string, pinned: boolean): boolean {
    if (pinned) {
      return this.db.prepare('INSERT OR IGNORE INTO pins (id, pinned_at) VALUES (?, ?)').run(id, Date.now()).changes > 0
    }
    return this.db.prepare('DELETE FROM pins WHERE id = ?').run(id).changes > 0
  }

  // -------------------------------------------------------------------------
  // Always-allow rules
  // -------------------------------------------------------------------------

  listRules(): AllowRuleRecord[] {
    const rows = this.db.prepare('SELECT * FROM allow_rules ORDER BY created_at DESC, id ASC').all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind === 'exact' ? 'exact' : 'tool',
      toolName: String(r.tool_name),
      command: (r.command as string | null) ?? null,
      createdAt: Number(r.created_at),
      createdBy: (r.created_by as string | null) ?? null,
    }))
  }

  /** Adds a rule, or returns the existing identical one. */
  addRule(rule: { kind: 'tool' | 'exact'; toolName: string; command?: string | null; createdBy?: string | null }): AllowRuleRecord {
    const command = rule.kind === 'exact' ? (rule.command ?? '') : null
    const dupe = this.listRules().find((r) => r.kind === rule.kind && r.toolName === rule.toolName && r.command === command)
    if (dupe) return dupe
    const id = randomBytes(5).toString('hex')
    this.db
      .prepare('INSERT INTO allow_rules (id, kind, tool_name, command, created_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(id, rule.kind, rule.toolName, command, Date.now(), rule.createdBy ?? null)
    return this.listRules().find((r) => r.id === id)!
  }

  removeRule(id: string): AllowRuleRecord | null {
    const rule = this.listRules().find((r) => r.id === id) ?? null
    if (!rule) return null
    this.db.prepare('DELETE FROM allow_rules WHERE id = ?').run(id)
    return rule
  }

  /** Drop pins whose id is not in `keep`. Returns how many were removed. */
  prunePins(keep: ReadonlySet<string>): number {
    let removed = 0
    for (const p of this.listPins()) {
      if (!keep.has(p.id) && this.setPin(p.id, false)) removed++
    }
    return removed
  }

  // -------------------------------------------------------------------------
  // Pairing codes
  // -------------------------------------------------------------------------

  /** Create a single-use, expiring pairing code. Unambiguous alphabet, no 0/O/1/I. */
  createPairing(ttlMs: number, scopes: Scope[] = SCOPE_DEFAULTS): { code: string; expiresAt: number } {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = randomBytes(10)
    let code = ''
    for (let i = 0; i < 10; i++) code += alphabet[bytes[i]! % alphabet.length]
    const now = Date.now()
    const expiresAt = now + ttlMs
    this.db
      .prepare('INSERT INTO pairings (code, created_at, expires_at, scopes) VALUES (?, ?, ?, ?)')
      .run(code, now, expiresAt, JSON.stringify(scopes))
    return { code, expiresAt }
  }

  /**
   * Atomically consume a pairing code. Returns the granted scopes, or null if the
   * code is unknown, already used, or expired. The UPDATE ... WHERE used_at IS NULL
   * is what makes it single-use even if two devices race.
   */
  consumePairing(code: string): Scope[] | null {
    const row = this.db.prepare('SELECT code, expires_at, used_at, scopes FROM pairings WHERE code = ?').get(code) as
      | { code: string; expires_at: number; used_at: number | null; scopes: string }
      | undefined
    if (!row) return null
    if (row.used_at !== null) return null
    if (row.expires_at < Date.now()) return null
    const res = this.db.prepare('UPDATE pairings SET used_at = ? WHERE code = ? AND used_at IS NULL').run(Date.now(), code)
    if (res.changes !== 1) return null
    return JSON.parse(row.scopes) as Scope[]
  }

  /** Cancel every pairing code that has not been used yet (lockdown). Returns how many. */
  cancelOpenPairings(): number {
    return this.db.prepare('DELETE FROM pairings WHERE used_at IS NULL').run().changes as number
  }

  purgeExpiredPairings(): void {
    this.db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(Date.now() - 60 * 60 * 1000)
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  createDevice(args: { name: string; platform: string; publicKey: string; scopes: Scope[]; pending?: boolean }): DeviceRecord {
    const now = Date.now()
    const id = randomUUID()
    // Re-pairing the same physical device replaces the old record rather than
    // accumulating duplicates, since the public key identifies it.
    this.db.prepare('DELETE FROM devices WHERE public_key = ?').run(args.publicKey)
    this.db
      .prepare(
        'INSERT INTO devices (id, name, platform, public_key, scopes, created_at, last_seen_at, revoked, pending, pending_since) VALUES (?,?,?,?,?,?,NULL,0,?,?)',
      )
      .run(id, args.name, args.platform, args.publicKey, JSON.stringify(args.scopes), now, args.pending ? 1 : 0, args.pending ? now : null)
    return {
      id,
      name: args.name,
      platform: args.platform,
      publicKey: args.publicKey,
      scopes: args.scopes,
      createdAt: now,
      lastSeenAt: null,
      revoked: false,
      pending: Boolean(args.pending),
      pendingSince: args.pending ? now : null,
      revokedReason: null,
    }
  }

  private hydrate(row: Record<string, unknown> | undefined): DeviceRecord | null {
    if (!row) return null
    // The policy check: a scope whose time limit has passed is not granted, whether or not the sweep has
    // cleaned the row up yet.
    const now = Date.now()
    const expiry = parseExpiry(row.scope_expiry)
    const live: Record<string, number> = {}
    for (const [scope, at] of Object.entries(expiry)) if (at > now) live[scope] = at
    const scopes = (JSON.parse(row.scopes as string) as Scope[]).filter((s) => !(s in expiry) || (expiry[s] as number) > now)
    return {
      id: row.id as string,
      name: row.name as string,
      platform: row.platform as string,
      publicKey: row.public_key as string,
      scopes,
      scopeExpiry: live,
      createdAt: row.created_at as number,
      lastSeenAt: (row.last_seen_at as number | null) ?? null,
      revoked: Boolean(row.revoked),
      pushToken: (row.push_token as string | null) ?? null,
      pushPlatform: (row.push_platform as 'ios' | 'android' | null) ?? null,
      pushEnv: row.push_env === 'sandbox' ? 'sandbox' : 'production',
      pushOnResult: Boolean(row.push_on_result),
      pushKey: (row.push_key as string | null) ?? null,
      pending: Boolean(row.pending),
      pendingSince: (row.pending_since as number | null) ?? null,
      revokedReason: (row.revoked_reason as string | null) ?? null,
    }
  }

  getDevice(id: string): DeviceRecord | null {
    return this.hydrate(this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Record<string, unknown>)
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map((r) => this.hydrate(r)!).filter(Boolean)
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id)
  }

  /** Revoking also drops the push token: a revoked device must never be notified. */
  setRevoked(id: string, revoked: boolean, reason: string | null = null): boolean {
    if (revoked) this.db.prepare('UPDATE devices SET push_token = NULL, push_platform = NULL, push_key = NULL WHERE id = ?').run(id)
    return (
      this.db.prepare('UPDATE devices SET revoked = ?, revoked_reason = ? WHERE id = ?').run(revoked ? 1 : 0, revoked ? reason : null, id).changes > 0
    )
  }

  listPending(): DeviceRecord[] {
    const rows = this.db.prepare('SELECT * FROM devices WHERE pending = 1 ORDER BY created_at DESC').all() as Record<string, unknown>[]
    return rows.map((r) => this.hydrate(r)!)
  }

  /** Activate a pending device. False if it is not (or no longer) pending. */
  approveDevice(id: string): boolean {
    return this.db.prepare('UPDATE devices SET pending = 0, pending_since = NULL WHERE id = ? AND pending = 1').run(id).changes > 0
  }

  /** Delete a pending device. Only ever touches pending rows. */
  rejectDevice(id: string): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ? AND pending = 1').run(id).changes > 0
  }

  /** Delete pending devices nobody approved in time. Returns them (for logging/audit). */
  expirePending(maxAgeMs: number, now = Date.now()): DeviceRecord[] {
    const stale = this.listPending().filter((d) => (d.pendingSince ?? d.createdAt) < now - maxAgeMs)
    for (const d of stale) this.rejectDevice(d.id)
    return stale
  }

  /**
   * Lost phone: revoke EVERY device at once (push token and key dropped by setRevoked), delete the ones still
   * waiting for approval, and deny open permission requests. Returns what changed so callers can audit it.
   */
  lockdown(reason = 'lockdown'): { revoked: DeviceRecord[]; rejected: DeviceRecord[] } {
    const revoked: DeviceRecord[] = []
    const rejected: DeviceRecord[] = []
    for (const d of this.listDevices()) {
      if (d.pending) {
        if (this.rejectDevice(d.id)) rejected.push(d)
      } else if (!d.revoked) {
        this.setRevoked(d.id, true, reason)
        revoked.push(d)
      }
    }
    this.db.prepare("UPDATE scope_requests SET status = 'denied' WHERE status = 'pending'").run()
    return { revoked, rejected }
  }

  /** Revoke active devices unseen for maxAgeMs (never-connected devices count from creation). */
  expireStaleDevices(maxAgeMs: number, now = Date.now()): DeviceRecord[] {
    const stale = this.listDevices().filter(
      (d) => !d.revoked && !d.pending && (d.lastSeenAt ?? d.createdAt) < now - maxAgeMs,
    )
    for (const d of stale) this.setRevoked(d.id, true, 'expired')
    return stale
  }

  // -------------------------------------------------------------------------
  // Networks a device has connected from
  // -------------------------------------------------------------------------

  /**
   * Note that a device connected from a network. 'baseline' is the first network ever seen for the device
   * (nothing to compare against, so no alert), 'new' is one it has not used before, 'known' is a repeat.
   */
  recordNetwork(deviceId: string, key: string, now = Date.now()): 'baseline' | 'new' | 'known' {
    const had = this.db.prepare('SELECT COUNT(*) AS n FROM device_networks WHERE device_id = ?').get(deviceId) as { n: number }
    const upd = this.db.prepare('UPDATE device_networks SET last_seen = ? WHERE device_id = ? AND net_key = ?').run(now, deviceId, key)
    if (upd.changes > 0) return 'known'
    this.db.prepare('INSERT INTO device_networks (device_id, net_key, first_seen, last_seen) VALUES (?,?,?,?)').run(deviceId, key, now, now)
    // Bounded: forget the least recently used beyond 50.
    this.db
      .prepare('DELETE FROM device_networks WHERE device_id = ? AND net_key NOT IN (SELECT net_key FROM device_networks WHERE device_id = ? ORDER BY last_seen DESC LIMIT 50)')
      .run(deviceId, deviceId)
    return Number(had.n) === 0 ? 'baseline' : 'new'
  }

  listNetworks(deviceId: string): string[] {
    return (this.db.prepare('SELECT net_key FROM device_networks WHERE device_id = ? ORDER BY first_seen').all(deviceId) as Array<{ net_key: string }>).map((r) => r.net_key)
  }

  // -------------------------------------------------------------------------
  // One-time login tokens for the local control page
  // -------------------------------------------------------------------------

  /** Returns a fresh single-use token; only its hash is stored. */
  createLoginToken(ttlMs = 5 * 60 * 1000): string {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now)
    this.db.prepare('INSERT INTO login_tokens (hash, expires_at) VALUES (?, ?)').run(sha256(token), now + ttlMs)
    return token
  }

  consumeLoginToken(token: string): boolean {
    if (!token || token.length > 200) return false
    const res = this.db
      .prepare('UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at >= ?')
      .run(Date.now(), sha256(token), Date.now())
    return res.changes === 1
  }

  // -------------------------------------------------------------------------
  // Audit log (append-only; enforced by triggers)
  // -------------------------------------------------------------------------

  recordAudit(e: AuditEntry): void {
    this.db
      .prepare('INSERT INTO audit_log (at, device_id, device_name, action, method, request_id, summary, transport) VALUES (?,?,?,?,?,?,?,?)')
      .run(
        Date.now(),
        e.deviceId ?? null,
        e.deviceName ?? null,
        e.action,
        e.method ?? null,
        e.requestId ?? null,
        e.summary ? e.summary.slice(0, 200) : null,
        e.transport ?? null,
      )
  }

  /** Newest first. */
  listAudit(opts: { limit?: number; deviceId?: string } = {}): AuditRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
    const rows = (
      opts.deviceId
        ? this.db.prepare('SELECT * FROM audit_log WHERE device_id = ? ORDER BY id DESC LIMIT ?').all(opts.deviceId, limit)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      deviceId: (r.device_id as string | null) ?? null,
      deviceName: (r.device_name as string | null) ?? null,
      action: r.action as string,
      method: (r.method as string | null) ?? null,
      requestId: (r.request_id as string | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      transport: (r.transport as string | null) ?? null,
    }))
  }

  /**
   * Replace a device's scopes. `expiryPatch` sets (epoch ms) or clears (null) time limits per scope; limits of
   * scopes that are no longer granted are dropped, and the rest are kept.
   */
  setScopes(id: string, scopes: Scope[], expiryPatch: Record<string, number | null> = {}): boolean {
    const row = this.db.prepare('SELECT scope_expiry FROM devices WHERE id = ?').get(id) as { scope_expiry: string | null } | undefined
    if (!row) return false
    const expiry = parseExpiry(row.scope_expiry)
    for (const [scope, at] of Object.entries(expiryPatch)) {
      if (at === null) delete expiry[scope]
      else expiry[scope] = at
    }
    for (const scope of Object.keys(expiry)) if (!scopes.includes(scope as Scope)) delete expiry[scope]
    const json = Object.keys(expiry).length ? JSON.stringify(expiry) : null
    return this.db.prepare('UPDATE devices SET scopes = ?, scope_expiry = ? WHERE id = ?').run(JSON.stringify(scopes), json, id).changes > 0
  }

  /**
   * The sweep: physically remove scopes whose time limit has passed. Returns what lapsed so the caller can
   * audit it and tell live connections. (Enforcement itself does not wait for this: see hydrate.)
   */
  expireScopes(now = Date.now()): Array<{ device: DeviceRecord; scopes: Scope[] }> {
    const out: Array<{ device: DeviceRecord; scopes: Scope[] }> = []
    const rows = this.db.prepare('SELECT id, scopes, scope_expiry FROM devices WHERE scope_expiry IS NOT NULL').all() as Array<{ id: string; scopes: string; scope_expiry: string }>
    for (const r of rows) {
      const expiry = parseExpiry(r.scope_expiry)
      const lapsed = Object.keys(expiry).filter((s) => (expiry[s] as number) <= now)
      if (lapsed.length === 0) continue
      const scopes = (JSON.parse(r.scopes) as Scope[]).filter((s) => !lapsed.includes(s))
      for (const s of lapsed) delete expiry[s]
      this.db
        .prepare('UPDATE devices SET scopes = ?, scope_expiry = ? WHERE id = ?')
        .run(JSON.stringify(scopes), Object.keys(expiry).length ? JSON.stringify(expiry) : null, r.id)
      const device = this.getDevice(r.id)
      if (device) out.push({ device, scopes: lapsed as Scope[] })
    }
    return out
  }

  /** Every (re-)registration replaces the key, so passing none drops the old one (rotation); clearing the token drops it too. */
  setPushToken(
    id: string,
    token: string | null,
    platform: 'ios' | 'android' | null,
    env: 'production' | 'sandbox' = 'production',
    pushKey: string | null = null,
  ): boolean {
    return (
      this.db
        .prepare('UPDATE devices SET push_token = ?, push_platform = ?, push_env = ?, push_key = ? WHERE id = ?')
        .run(token, platform, env, token ? pushKey : null, id).changes > 0
    )
  }

  /** Remove a token only if it is still the one we sent with (a newer registration may have replaced it). */
  clearPushTokenIf(id: string, token: string): boolean {
    return this.db.prepare('UPDATE devices SET push_token = NULL, push_platform = NULL, push_key = NULL WHERE id = ? AND push_token = ?').run(id, token).changes > 0
  }

  setPushOnResult(id: string, on: boolean): boolean {
    return this.db.prepare('UPDATE devices SET push_on_result = ? WHERE id = ?').run(on ? 1 : 0, id).changes > 0
  }

  renameDevice(id: string, name: string): boolean {
    return this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id).changes > 0
  }

  deleteDevice(id: string): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0
  }

  // -------------------------------------------------------------------------
  // Scope requests (how a phone asks for the terminal)
  // -------------------------------------------------------------------------

  createScopeRequest(deviceId: string, scope: Scope, reason: string): ScopeRequest {
    // One pending request per device+scope; asking again refreshes the existing one.
    this.db
      .prepare("DELETE FROM scope_requests WHERE device_id = ? AND scope = ? AND status = 'pending'")
      .run(deviceId, scope)
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare("INSERT INTO scope_requests (id, device_id, scope, reason, created_at, status) VALUES (?,?,?,?,?,'pending')")
      .run(id, deviceId, scope, reason, now)
    const device = this.getDevice(deviceId)
    return {
      id,
      deviceId,
      deviceName: device?.name ?? 'Unknown device',
      scope,
      reason,
      createdAt: now,
      status: 'pending',
    }
  }

  listScopeRequests(status: 'pending' | 'all' = 'pending'): ScopeRequest[] {
    const sql =
      status === 'all'
        ? 'SELECT r.*, d.name AS device_name FROM scope_requests r JOIN devices d ON d.id = r.device_id ORDER BY r.created_at DESC'
        : "SELECT r.*, d.name AS device_name FROM scope_requests r JOIN devices d ON d.id = r.device_id WHERE r.status = 'pending' ORDER BY r.created_at DESC"
    const rows = this.db.prepare(sql).all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      deviceId: r.device_id as string,
      deviceName: r.device_name as string,
      scope: r.scope as Scope,
      reason: r.reason as string,
      createdAt: r.created_at as number,
      status: r.status as ScopeRequest['status'],
    }))
  }

  /** Approve a pending request and add the scope to the device in one step. */
  resolveScopeRequest(id: string, approve: boolean, expiresAt: number | null = null): { device: DeviceRecord; scope: Scope } | null {
    const row = this.db.prepare("SELECT * FROM scope_requests WHERE id = ? AND status = 'pending'").get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    this.db.prepare('UPDATE scope_requests SET status = ? WHERE id = ?').run(approve ? 'granted' : 'denied', id)
    const device = this.getDevice(row.device_id as string)
    if (!device) return null
    const scope = row.scope as Scope
    if (approve) {
      const next = device.scopes.includes(scope) ? device.scopes : [...device.scopes, scope]
      this.setScopes(device.id, next, { [scope]: expiresAt })
      return { device: this.getDevice(device.id) ?? device, scope }
    }
    return { device, scope }
  }

  // -------------------------------------------------------------------------
  // Durable event log
  // -------------------------------------------------------------------------

  appendEvent(event: string, sessionKey: string | null, data: unknown): number {
    const res = this.db
      .prepare('INSERT INTO events (event, session_key, data, created_at) VALUES (?,?,?,?)')
      .run(event, sessionKey, JSON.stringify(data), Date.now())
    return Number(res.lastInsertRowid)
  }

  currentSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number }
    return Number(row.s)
  }

  /** Events after `afterSeq`, oldest first. Used to catch a reconnecting device up. */
  eventsSince(afterSeq: number, limit: number, sessionKeys?: string[]): StoredEvent[] {
    let rows: Record<string, unknown>[]
    if (sessionKeys && sessionKeys.length > 0) {
      const placeholders = sessionKeys.map(() => '?').join(',')
      rows = this.db
        .prepare(
          `SELECT seq, event, session_key, data, created_at FROM events
           WHERE seq > ? AND (session_key IS NULL OR session_key IN (${placeholders}))
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(afterSeq, ...sessionKeys, limit) as Record<string, unknown>[]
    } else {
      rows = this.db
        .prepare('SELECT seq, event, session_key, data, created_at FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
        .all(afterSeq, limit) as Record<string, unknown>[]
    }
    return rows.map((r) => ({
      seq: Number(r.seq),
      event: r.event as string,
      sessionKey: (r.session_key as string | null) ?? null,
      data: r.data as string,
      createdAt: Number(r.created_at),
    }))
  }

  pruneEvents(olderThanMs: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE created_at < ?').run(Date.now() - olderThanMs).changes)
  }

  toSummary(device: DeviceRecord, fingerprint: string): DeviceSummary {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      scopes: device.scopes,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revoked: device.revoked,
      fingerprint,
      ...(device.pending ? { pending: true } : {}),
      ...(device.scopeExpiry && Object.keys(device.scopeExpiry).length ? { scopeExpiry: device.scopeExpiry } : {}),
      ...(device.revokedReason ? { revokedReason: device.revokedReason } : {}),
    }
  }
}

function parseExpiry(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, number> = {}
    for (const [k, at] of Object.entries(v)) if (typeof at === 'number' && Number.isFinite(at)) out[k] = at
    return out
  } catch {
    return {}
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
