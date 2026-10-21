import { randomUUID } from 'node:crypto'
import {
  BRIDGE_METHODS,
  CAP_DEFLATE,
  SecureChannel,
  PROTOCOL_VERSION,
  deriveSessionKeys,
  denialReason,
  fromB64,
  generateIdentity,
  isMethodAllowed,
  methodsForScopes,
  toB64,
} from '@dorabot-remote/protocol'
import type {
  AuthEnvelope,
  DeviceSummary,
  Envelope,
  HostSummary,
  KeyPair,
  RpcEnvelope,
  Scope,
  Sodium,
} from '@dorabot-remote/protocol'
import type { DeviceSocket } from './device-socket.js'
import type { DeviceRecord } from './store.js'
import { trimHistoryResult } from './history-trim.js'
import { checkPathParams, filterSearchResult } from './path-guard.js'
import { sanitizeParams } from './param-allowlist.js'
import { encodeOutbound } from './compress.js'

/** Replay is paced against this so a long catch-up cannot blow the socket buffer. */
const SEND_HIGH_WATER_BYTES = 512 * 1024
const REPLAY_CHUNK = 200
/** XChaCha20-Poly1305 tag. */
const SEAL_OVERHEAD_BYTES = 16

export interface ConnectionHost {
  sodium: Sodium
  hostIdentity: KeyPair
  hostSummary: HostSummary
  /** [SEC-RELAY] hostSummary plus this device's relay token. */
  hostSummaryFor(device: { id: string }): HostSummary
  getDevice(id: string): DeviceRecord | null
  touchDevice(id: string): void
  deviceSummary(device: DeviceRecord): DeviceSummary
  currentSeq(): number
  eventsSince(afterSeq: number, limit: number, sessionKeys?: string[]): Array<{
    seq: number
    event: string
    sessionKey: string | null
    data: string
  }>
  /** Snapshot of a session's current state, cached from the gateway. */
  snapshotFor(sessionKey: string): unknown | null
  knownSessionKeys(): string[]
  gatewayConnected(): boolean
  callGateway(method: string, params: Record<string, unknown>): Promise<unknown>
  handleBridgeMethod(conn: DeviceConnection, method: string, params: Record<string, unknown>): Promise<unknown>
  log(msg: string): void
  onClosed(conn: DeviceConnection): void
  /** Bridge-owned directories that fs.* / search.* must never reach. */
  protectedPaths?(): string[]
  /** Folders shared with phones. Absent or empty means no file access at all. */
  allowedRoots?(): string[]
  /** When an unapproved device's pairing lapses (epoch ms). Display hint for the phone. */
  pendingExpiresAt?(device: DeviceRecord): number | undefined
  auditRpc?(conn: DeviceConnection, method: string, requestId: string | number | undefined, params: Record<string, unknown>): void // SEC-S3
}

/**
 * One paired device's live connection.
 *
 * Responsibilities, in order of how much they matter:
 *
 *  1. Mutual authentication and encryption. Nothing readable crosses the wire.
 *  2. Authorisation. The gateway has none; every forwarded method is checked
 *     against this device's scopes here, and refused by default.
 *  3. Shell ownership. The gateway broadcasts `shell.data` to every authenticated
 *     client with a shellId but no sessionKey, meaning the raw byte stream of
 *     every terminal on the machine, including ones opened on the Mac itself.
 *     A connection only ever receives data for shells it spawned.
 *  4. Paced replay from the bridge's durable log.
 */
export class DeviceConnection {
  readonly id = randomUUID()
  device: DeviceRecord | null = null
  private channel: SecureChannel | null = null
  private ephemeral: KeyPair | null = null
  private authed = false
  get isAuthed(): boolean {
    return this.authed && !this.closed
  }
  private closed = false
  /** Last time any frame arrived from the phone. A suspended app stops sending, even if the socket stays open. */
  lastInboundAt = Date.now()
  /** Session keys this device asked to follow. */
  subscriptions = new Set<string>()
  /** Shells this device spawned. The only ones it will ever see output from. */
  ownedShells = new Set<string>()
  /** Highest seq delivered per session, so a late subscribe can backfill exactly. */
  private sentSeqByKey = new Map<string, number>()
  /** Highest seq delivered for events that carry no session key. */
  private sentGlobalSeq = 0
  /** Live events held back while a reconnect replay is in flight, to keep order. */
  private replaying = false
  private heldLive: Array<[string, unknown, number | undefined, string | null]> = []
  /** The device's resume cursor at connect time. */
  private authSeq = 0
  private sendQueue: Promise<void> = Promise.resolve()
  private handshakeTimer: NodeJS.Timeout | null = null
  /** The one plaintext `hdr` this connection may receive. */
  private gotHdr = false
  /** The phone advertised 'deflate' in its encrypted auth envelope. */
  private peerDeflate = false

  constructor(
    private readonly ws: DeviceSocket,
    private readonly host: ConnectionHost,
    readonly remoteAddress: string,
  ) {
    this.handshakeTimer = setTimeout(() => {
      if (!this.authed) this.fail('bad_handshake', 'handshake timed out')
    }, 10_000)

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      this.lastInboundAt = Date.now()
      void this.onMessage(raw, isBinary)
    })
    ws.on('close', () => this.cleanup())
    ws.on('error', () => this.cleanup())
  }

  get scopes(): Scope[] {
    return this.device?.scopes ?? []
  }

  private cleanup(): void {
    if (this.closed) return
    this.closed = true
    if (!this.authed && !this.failedWith) {
      this.host.log?.(`device socket from ${this.remoteAddress} closed before auth${this.device ? ` (${this.device.name})` : ''}`)
    }
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.host.onClosed(this)
  }

  private failedWith: string | null = null

  private fail(code: string, message: string, extra: Record<string, unknown> = {}): void {
    if (!this.authed) {
      this.failedWith = code
      this.host.log?.(`device socket from ${this.remoteAddress} failed before auth: ${code} (${message})`)
    }
    try {
      this.ws.send(JSON.stringify({ t: 'err', code, message, ...extra }))
    } catch {
      // Socket already gone.
    }
    this.ws.close()
    this.cleanup()
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private async onMessage(raw: Buffer, isBinary: boolean): Promise<void> {
    if (this.closed) return
    try {
      if (!isBinary) {
        // Plaintext frames exist only for the handshake. Once the encrypted channel is
        // up, one more (e.g. a replayed or forged `hdr`) would reset the receive
        // counter and re-enable replay, so it ends the connection.
        if (this.channel?.established) {
          this.fail('bad_handshake', 'plaintext frame after handshake')
          return
        }
        await this.onHandshakeFrame(JSON.parse(raw.toString()) as Record<string, unknown>)
        return
      }
      if (!this.channel?.established) {
        this.fail('bad_handshake', 'encrypted frame before handshake finished')
        return
      }
      const env = this.channel.open<Envelope>(new Uint8Array(raw))
      await this.onEnvelope(env)
    } catch (err) {
      this.host.log(`device ${this.device?.name ?? this.remoteAddress}: ${(err as Error).message}`)
      this.fail('bad_handshake', 'frame rejected')
    }
  }

  private async onHandshakeFrame(frame: Record<string, unknown>): Promise<void> {
    const s = this.host.sodium

    if (frame.t === 'hello') {
      if (this.channel) {
        this.fail('bad_handshake', 'duplicate hello')
        return
      }
      if (frame.v !== PROTOCOL_VERSION) {
        this.fail('bad_version', `this host speaks protocol v${PROTOCOL_VERSION}`)
        return
      }
      const device = this.host.getDevice(String(frame.deviceId ?? ''))
      if (!device) {
        this.fail('unknown_device', 'this device is not paired with this host')
        return
      }
      if (device.revoked) {
        this.fail('revoked', 'access for this device was revoked')
        return
      }
      if (device.pending) { // SEC-S3
        const exp = this.host.pendingExpiresAt?.(device)
        this.fail('pending', 'waiting for approval on your Mac', exp ? { approvalExpiresAt: exp } : {})
        return
      }

      this.device = device

      this.ephemeral = generateIdentity(s)
      const theirEphPk = fromB64(s, String(frame.ephPk))
      const keys = deriveSessionKeys(s, 'host', {
        myEphemeral: this.ephemeral,
        theirEphemeralPk: theirEphPk,
        myStatic: this.host.hostIdentity,
        theirStaticPk: fromB64(s, device.publicKey),
      })
      this.channel = SecureChannel.create(s, keys)

      this.ws.send(
        JSON.stringify({
          t: 'hello_ack',
          v: PROTOCOL_VERSION,
          ephPk: toB64(s, this.ephemeral.publicKey),
          hostId: this.host.hostSummary.id,
          hostName: this.host.hostSummary.name,
        }),
      )
      this.ws.send(JSON.stringify({ t: 'hdr', hdr: toB64(s, this.channel.startSend()) }))
      return
    }

    if (frame.t === 'hdr') {
      if (!this.channel) {
        this.fail('bad_handshake', 'header before hello')
        return
      }
      if (this.gotHdr) {
        this.fail('bad_handshake', 'duplicate header')
        return
      }
      this.gotHdr = true
      // If the device used the wrong long-term key, the derived keys differ and
      // the first payload simply fails to decrypt. That is the authentication.
      this.channel.startReceive(fromB64(s, String(frame.hdr)))
      return
    }

    this.fail('bad_handshake', `unexpected frame "${String(frame.t)}"`)
  }

  private async onEnvelope(env: Envelope): Promise<void> {
    switch (env.t) {
      case 'auth': {
        if (this.authed) return
        this.authed = true
        this.peerDeflate = Array.isArray(env.caps) && env.caps.includes(CAP_DEFLATE)
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        const device = this.device!
        this.host.touchDevice(device.id)
        this.host.log(`device connected: ${device.name} (${this.remoteAddress})`)

        this.send({
          t: 'ready',
          device: this.host.deviceSummary(device),
          host: this.host.hostSummaryFor(device), // [SEC-RELAY] carries this device's relay token
          allowed: methodsForScopes(device.scopes),
          seq: this.host.currentSeq(),
          gatewayConnected: this.host.gatewayConnected(),
        })

        // A fresh device (no cursor) replays nothing: history comes from
        // sessions.get and pending prompts from the snapshot cache.
        this.authSeq =
          typeof env.lastSeq === 'number' && env.lastSeq > 0 ? env.lastSeq : this.host.currentSeq()
        if (this.authSeq < this.host.currentSeq()) void this.replayFrom(this.authSeq)
        return
      }

      case 'ping':
        this.send({ t: 'pong', ts: env.ts })
        return

      case 'rpc':
        await this.onRpc(env)
        return

      default:
        return
    }
  }

  private async onRpc(env: RpcEnvelope): Promise<void> {
    const rawParams = env.params
    let params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams : {}) as Record<string, unknown>
    const reply = (result: unknown): void => this.send({ t: 'rpc_res', id: env.id, result })
    const fail = (message: string, code?: string): void =>
      this.send({ t: 'rpc_res', id: env.id, error: { message, code } })

    if (!this.authed || !this.device) {
      fail('not authenticated', 'unauthenticated')
      return
    }

    // The CLI edits the device record from another process; pick that up here.
    this.recheckDevice()
    if (this.closed || !this.device) return

    if (!isMethodAllowed(env.method, this.device.scopes)) {
      this.host.log(`refused ${env.method} from ${this.device.name} (scopes: ${this.device.scopes.join(', ')})`)
      fail(denialReason(env.method, this.device.scopes), 'forbidden')
      return
    }

    // Drop params the phone has no business sending (e.g. tool.approve modifiedInput
    // without `terminal`). Done once, before anything is forwarded.
    params = sanitizeParams(env.method, params, this.device.scopes)

    this.host.auditRpc?.(this, env.method, env.id, params) // SEC-S3: audit log hook
    try {
      // Subscriptions are served by the bridge, not the gateway. The bridge holds
      // one subscription upstream covering every session and keeps its own durable
      // log, so a device resumes from the bridge's cursor rather than from the
      // gateway's, which is pruned ten minutes after each run ends.
      if (env.method === 'sessions.subscribe') {
        const keys = Array.isArray(params.sessionKeys) ? (params.sessionKeys as string[]) : []
        const fresh = keys.filter((k) => !this.subscriptions.has(k))
        for (const k of keys) this.subscriptions.add(k)
        reply({ subscribed: keys, seq: this.host.currentSeq() })

        // Backfill anything that happened on these sessions before the device
        // started following them. Without this, a session the phone itself just
        // started appears empty: its first events landed before the subscribe.
        for (const k of fresh) {
          const from = Math.max(this.sentSeqByKey.get(k) ?? 0, this.authSeq)
          const rows = this.host.eventsSince(from, 1000, [k]).filter((r) => r.sessionKey === k)
          for (const row of rows) this.deliver(row.event, JSON.parse(row.data), row.seq, k)
        }

        for (const k of keys) {
          const snap = this.host.snapshotFor(k)
          if (snap) this.send({ t: 'event', event: 'session.snapshot', data: snap, sessionKey: k })
        }
        return
      }

      if (env.method === 'sessions.unsubscribe') {
        const keys = Array.isArray(params.sessionKeys) ? (params.sessionKeys as string[]) : []
        for (const k of keys) this.subscriptions.delete(k)
        reply({ unsubscribed: keys })
        return
      }

      if (env.method === 'remote.roots') {
        reply({ roots: this.host.allowedRoots?.() ?? [] })
        return
      }

      const guardCtx = { roots: this.host.allowedRoots?.() ?? [], extraDenied: this.host.protectedPaths?.() ?? [] }
      const blocked = checkPathParams(env.method, params, guardCtx)
      if (blocked) {
        this.host.log(`refused ${env.method} from ${this.device.name}: ${blocked}`)
        fail(blocked, 'forbidden')
        return
      }

      if (BRIDGE_METHODS.has(env.method)) {
        reply(await this.host.handleBridgeMethod(this, env.method, params))
        return
      }

      // Shell calls are rewritten so a device can only ever address its own
      // shells. shellId is namespaced per connection, and kill/write/resize are
      // refused for ids this connection does not own; the gateway itself performs
      // no such check.
      if (env.method.startsWith('shell.')) {
        const result = await this.handleShell(env.method, params)
        reply(result)
        return
      }

      const result = await this.host.callGateway(env.method, params)
      reply(trimHistoryResult(env.method, filterSearchResult(env.method, result, guardCtx), this.ws.maxFrameBytes))
    } catch (err) {
      fail((err as Error).message)
    }
  }

  private async handleShell(method: string, params: Record<string, unknown>): Promise<unknown> {
    const requested = typeof params.shellId === 'string' ? params.shellId : ''

    if (method === 'shell.list') {
      // Only this device's own shells, never the machine's.
      return {
        active: [...this.ownedShells].map((id) => ({ shellId: id.slice(this.shellPrefix.length), live: true })),
        saved: [],
      }
    }

    if (!requested) throw new Error('shellId required')
    const scoped = requested.startsWith(this.shellPrefix) ? requested : `${this.shellPrefix}${requested}`

    if (method === 'shell.spawn') {
      // Own the id before the call so early output is not dropped; roll back on
      // failure. If the socket closed meanwhile, kill the shell we just made.
      this.ownedShells.add(scoped)
      let result: unknown
      try {
        result = await this.host.callGateway('shell.spawn', { ...params, shellId: scoped })
      } catch (err) {
        this.ownedShells.delete(scoped)
        throw err
      }
      if (this.closed) {
        void this.host.callGateway('shell.kill', { shellId: scoped }).catch(() => {})
        this.ownedShells.delete(scoped)
      }
      return result
    }

    if (!this.ownedShells.has(scoped)) {
      throw new Error('this device does not own that shell')
    }

    const result = await this.host.callGateway(method, { ...params, shellId: scoped })
    if (method === 'shell.kill') this.ownedShells.delete(scoped)
    return result
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Serialised through a promise chain so replay and live events can never
   * interleave out of order, and so a slow socket applies back-pressure to the
   * replay loop instead of to the kernel buffer.
   */
  private send(env: Envelope): void {
    if (this.closed || !this.channel) return
    this.sendQueue = this.sendQueue.then(async () => {
      if (this.closed || !this.channel) return
      try {
        const limit = this.ws.maxFrameBytes
        // Compress (if negotiated and large) before sealing; the relay budget applies to
        // the compressed+sealed size.
        let plain = encodeOutbound(env, this.peerDeflate)
        if (limit !== undefined) {
          // Sealing advances the stream counter, so an oversize frame cannot be
          // sealed and then discarded: the phone would lose sync. Size it first
          // (ciphertext = plaintext bytes + 16 byte tag) and substitute or drop.
          const size = plain.length + SEAL_OVERHEAD_BYTES
          if (size > limit) {
            if (env.t === 'rpc_res') {
              this.host.log(`response of ${size} bytes is too large for the relay; replacing with an error`)
              env = {
                t: 'rpc_res',
                id: env.id,
                error: { message: `response too large to send over the relay (${size} bytes)`, code: 'too_large' },
              }
              plain = encodeOutbound(env, this.peerDeflate)
            } else {
              this.host.log(`dropped a ${size} byte ${env.t} event: too large for the relay`)
              return
            }
          }
        }
        const frame = this.channel.sealBytes(plain)
        this.ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))
        await this.waitForDrain()
      } catch (err) {
        this.host.log(`send failed for ${this.device?.name ?? 'device'}: ${(err as Error).message}`)
        this.ws.close()
        this.cleanup()
      }
    })
  }

  private async waitForDrain(): Promise<void> {
    let waited = 0
    while (!this.closed && this.ws.bufferedAmount > SEND_HIGH_WATER_BYTES && waited < 30_000) {
      await new Promise((r) => setTimeout(r, 25))
      waited += 25
    }
  }

  /**
   * Forward a live event, if this device is allowed to see it.
   * Returns silently when it is not, which is the common case.
   */
  forward(event: string, data: unknown, seq: number | undefined, sessionKey: string | null): void {
    if (!this.authed) return
    if (sessionKey && !this.subscriptions.has(sessionKey)) return
    if (this.replaying) {
      this.heldLive.push([event, data, seq, sessionKey])
      return
    }
    this.deliver(event, data, seq, sessionKey)
  }

  /**
   * The single exit for events (replay, backfill, live). Never sends a seq at or
   * below the highest already sent for that session (or globally for events with
   * no session key), so overlapping paths cannot duplicate.
   */
  private deliver(event: string, data: unknown, seq: number | undefined, sessionKey: string | null): void {
    if (typeof seq === 'number') {
      if (sessionKey) {
        if (seq <= (this.sentSeqByKey.get(sessionKey) ?? 0)) return
        this.sentSeqByKey.set(sessionKey, seq)
      } else {
        if (seq <= this.sentGlobalSeq) return
        this.sentGlobalSeq = seq
      }
    }
    this.send({ t: 'event', event, data, seq, sessionKey: sessionKey ?? undefined })
  }

  /** Re-read this device's record: honour a revoke or scope change made elsewhere. */
  recheckDevice(): void {
    if (this.closed || !this.device) return
    const fresh = this.host.getDevice(this.device.id)
    if (!fresh || fresh.revoked) {
      this.close(fresh ? 'revoked' : 'removed')
      return
    }
    const key = (d: DeviceRecord): string => [...d.scopes].sort().join(',')
    if (key(fresh) !== key(this.device)) {
      this.device = fresh
      this.forward('remote.scopes_changed', { scopes: fresh.scopes, granted: null }, undefined, null)
    }
  }

  /** The internal, per-connection shell id prefix. */
  private get shellPrefix(): string {
    return `rem-${this.id}-`
  }

  /**
   * Terminal output for a shell this connection owns.
   *
   * The gateway broadcasts shell.data to every authenticated client with no
   * scoping at all, so the ownership check here is the only thing standing
   * between a remote device and every terminal on the machine. The namespaced
   * id is translated back to the one the device asked for, so the internal
   * naming never leaks past the bridge.
   */
  forwardShellData(shellId: string, data: Record<string, unknown>): void {
    if (!this.authed) return
    if (!this.ownedShells.has(shellId)) return
    if (!this.scopes.includes('terminal')) return
    this.sendShellData(shellId, data)
  }

  private sendShellData(shellId: string, data: Record<string, unknown>): void {
    const clientId = shellId.startsWith(this.shellPrefix) ? shellId.slice(this.shellPrefix.length) : shellId
    this.send({ t: 'event', event: 'shell.data', data: { ...data, shellId: clientId } })
  }

  /** Catch a reconnecting device up from the durable log, in paced chunks. */
  private async replayFrom(afterSeq: number): Promise<void> {
    this.replaying = true
    try {
      await this.replayLoop(afterSeq)
    } finally {
      this.replaying = false
      const held = this.heldLive
      this.heldLive = []
      for (const [e, d, s, k] of held) {
        if (k && !this.subscriptions.has(k)) continue
        this.deliver(e, d, s, k)
      }
    }
  }

  private async replayLoop(afterSeq: number): Promise<void> {
    let cursor = afterSeq
    const keys = this.subscriptions.size > 0 ? [...this.subscriptions] : this.host.knownSessionKeys()
    for (;;) {
      if (this.closed) return
      const rows = this.host.eventsSince(cursor, REPLAY_CHUNK, keys)
      if (rows.length === 0) break
      for (const row of rows) {
        this.deliver(row.event, JSON.parse(row.data), row.seq, row.sessionKey)
        cursor = row.seq
      }
      await this.sendQueue
      if (rows.length < REPLAY_CHUNK) break
    }
  }

  close(reason = 'closed'): void {
    try {
      this.ws.close(1000, reason)
    } catch {
      // Already gone.
    }
    this.cleanup()
  }
}
