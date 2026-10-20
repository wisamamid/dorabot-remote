/**
 * An in-process stand-in for packages/relay's Room, mirroring its behaviour
 * (challenge, host replacement, mux routing, 1 MiB frame cap, close codes). The
 * real Room needs the Workers runtime, so it cannot be imported under Node.
 */
import { createServer, type Server } from 'node:http'
import {
  MuxKind,
  RELAY_CLOSE,
  RELAY_HB_REQUEST,
  RELAY_HB_RESPONSE,
  decodeMux,
  decodeMuxClose,
  encodeMux,
  encodeMuxClose,
  newChallengeNonce,
  relayTokenHash,
  verifyChallenge,
} from '@dorabot-remote/protocol'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_FRAME = 1024 * 1024

interface Host {
  ws: WebSocket
  rid: string
  nonce: string
  authed: boolean
}

export class FakeRelay {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private hosts = new Set<Host>()
  private devices = new Map<number, WebSocket>()
  private nextConn = 1
  port = 0
  /** Number of host sockets ever opened: the reconnect-loop counter. */
  hostAttempts = 0
  /** Largest frame the host sent us. Must stay under MAX_FRAME. */
  maxHostFrame = 0
  hostCloseCodes: number[] = []
  /** If set, the challenge is checked against this id instead of the URL's. */
  expectRelayId: string | null = null
  /** Close each host socket right after auth succeeds. */
  flap = false
  /** Answer the host's application heartbeat. False reproduces a room that is up at the ws level but silent. */
  answerHeartbeat = true
  /**
   * The production outage: the room accepts devices (and still answers heartbeats and
   * protocol pings) but never delivers anything to the host link.
   */
  blackHole = false
  heartbeats = 0
  /** Access state the host last pushed ({t:'tokens'}), mirroring the real Room. */
  tokenSet = new Set<string>()
  tickets = new Set<string>()
  enforce = false
  tokensFrames: Array<{ set: string[]; tickets: string[]; enforce: boolean }> = []
  /** Devices refused for a missing or wrong token. */
  unauthorized = 0
  devicesAccepted = 0

  get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    const server = createServer()
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME })
    wss.on('connection', (ws, req) => {
      const m = /^\/(h|d)\/([A-Za-z0-9_-]{22})$/.exec(req.url ?? '')
      if (!m) return void ws.close(1008, 'bad path')
      if (m[1] === 'h') this.acceptHost(ws, m[2]!)
      else this.acceptDevice(ws)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    this.port = (server.address() as { port: number }).port
    this.server = server
    this.wss = wss
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate()
    this.wss?.close()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  get authedHost(): Host | undefined {
    return [...this.hosts].find((h) => h.authed && h.ws.readyState === WebSocket.OPEN)
  }

  /** Simulate the relay (or the network) dropping the host. */
  dropHost(): void {
    this.authedHost?.ws.terminate()
  }

  private acceptHost(ws: WebSocket, rid: string): void {
    this.hostAttempts++
    const host: Host = { ws, rid, nonce: newChallengeNonce(), authed: false }
    this.hosts.add(host)
    ws.send(JSON.stringify({ t: 'challenge', n: host.nonce }))
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (raw.length > MAX_FRAME) return
      if (!host.authed) {
        let f: { t?: string; pk?: string; sig?: string } = {}
        try {
          f = JSON.parse(raw.toString())
        } catch {
          // Falls to unauthorized.
        }
        const rid2 = this.expectRelayId ?? host.rid
        if (isBinary || f.t !== 'auth' || !f.pk || !f.sig || !verifyChallenge(rid2, host.nonce, f.pk, f.sig)) {
          return void ws.close(RELAY_CLOSE.unauthorized, 'unauthorized')
        }
        for (const old of this.hosts) if (old !== host && old.authed) old.ws.close(RELAY_CLOSE.replaced, 'replaced')
        for (const d of this.devices.values()) d.close(RELAY_CLOSE.hostOffline, 'host_replaced')
        host.authed = true
        ws.send(JSON.stringify({ t: 'ok' }))
        if (this.flap) ws.close(1011, 'flap')
        return
      }
      this.maxHostFrame = Math.max(this.maxHostFrame, raw.length)
      if (!isBinary) {
        if (raw.toString().startsWith('{"t":"tokens"')) {
          const f = JSON.parse(raw.toString()) as { set: string[]; tickets?: string[]; enforce: boolean }
          this.tokenSet = new Set(f.set)
          this.tickets = new Set(f.tickets ?? [])
          this.enforce = f.enforce === true
          this.tokensFrames.push({ set: f.set, tickets: f.tickets ?? [], enforce: this.enforce })
          return
        }
        if (raw.toString() === RELAY_HB_REQUEST) {
          this.heartbeats++
          if (this.answerHeartbeat) ws.send(RELAY_HB_RESPONSE)
        }
        return
      }
      const frame = decodeMux(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
      if (!frame) return
      const target = this.devices.get(frame.connId)
      if (frame.kind === MuxKind.text) {
        if (target) target.send(Buffer.from(frame.payload).toString())
        else ws.send(encodeMuxClose(frame.connId, 1000, 'gone'))
      } else if (frame.kind === MuxKind.binary) {
        if (target) target.send(Buffer.from(frame.payload))
        else ws.send(encodeMuxClose(frame.connId, 1000, 'gone'))
      } else if (frame.kind === MuxKind.close && target) {
        const { code, reason } = decodeMuxClose(frame.payload)
        target.close(code === 1000 || (code >= 3000 && code <= 4999) || code === 1009 ? code : 1000, reason)
      }
    })
    ws.on('close', (code) => {
      this.hostCloseCodes.push(code)
      this.hosts.delete(host)
      if (host.authed && !this.authedHost) for (const d of this.devices.values()) d.close(RELAY_CLOSE.hostOffline, 'host_offline')
    })
    ws.on('error', () => {})
  }

  private acceptDevice(ws: WebSocket): void {
    const host = this.authedHost
    if (!host) return void ws.close(RELAY_CLOSE.hostOffline, 'host_offline')
    const connId = this.nextConn++
    let admitted = false
    const admit = (): void => {
      admitted = true
      this.devices.set(connId, ws)
      this.devicesAccepted++
      if (!this.blackHole) host.ws.send(encodeMux(MuxKind.open, connId))
    }
    // Not enforcing: legacy devices are admitted at once. Enforcing: only after a valid {t:'auth',tok} frame.
    if (!this.enforce) admit()
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (!isBinary && raw.length < 400 && raw.toString().includes('"auth"')) {
        try {
          const f = JSON.parse(raw.toString()) as { t?: string; tok?: string }
          if (f.t === 'auth') {
            const h = relayTokenHash(String(f.tok))
            if (!this.tokenSet.has(h) && !this.tickets.delete(h)) {
              this.unauthorized++
              return void ws.close(RELAY_CLOSE.unauthorized, 'unauthorized')
            }
            if (!admitted) admit()
            return
          }
        } catch {
          // Ordinary frame.
        }
      }
      if (!admitted) {
        this.unauthorized++
        return void ws.close(RELAY_CLOSE.unauthorized, 'unauthorized')
      }
      if (this.blackHole) return
      const h = this.authedHost
      if (!h) return void ws.close(RELAY_CLOSE.hostOffline, 'host_offline')
      h.ws.send(encodeMux(isBinary ? MuxKind.binary : MuxKind.text, connId, raw))
    })
    ws.on('close', (code, reason) => {
      this.devices.delete(connId)
      if (admitted && !this.blackHole) this.authedHost?.ws.send(encodeMuxClose(connId, code, reason.toString()))
    })
    ws.on('error', () => {})
  }
}
