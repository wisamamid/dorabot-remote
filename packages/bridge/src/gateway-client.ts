import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { GATEWAY_LIMITS } from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'

export type GatewayState = 'connecting' | 'authenticating' | 'ready' | 'disconnected'

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export interface GatewayClientOptions {
  socketPath: string
  token: string
  log?: (msg: string) => void
}

/**
 * The bridge's connection to the local dorabot gateway.
 *
 * The gateway listens on a unix socket only (its `gateway.port` config field is
 * documented as deprecated and has no read sites), so this dials the socket and
 * speaks WebSocket over it, exactly as dorabot's own Electron main process does.
 *
 * Three gateway behaviours are handled here so nothing downstream has to:
 *
 *  - Auth is an RPC, and the reply is the THIRD frame, after an unsolicited
 *    `gateway.telemetry` and `status.update`. The reader must be live before the
 *    auth reply is awaited.
 *  - There are no WebSocket-level pings. The server drops any client silent for
 *    30 seconds, so we send an RPC `ping` every 10. The phone never sees this.
 *  - Close code 4101 means either heartbeat timeout or backpressure, told apart
 *    only by the reason string. Auth failure closes with no code at all, so the
 *    preceding `{error:'invalid token'}` frame is the only signal.
 */
export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private rpcId = 0
  private pending = new Map<number, PendingRpc>()
  private heartbeat: NodeJS.Timeout | null = null
  private heartbeatPending = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private closedByUs = false

  state: GatewayState = 'disconnected'
  connectId: string | null = null
  lastError: string | null = null

  private readonly log: (msg: string) => void

  constructor(private readonly opts: GatewayClientOptions) {
    super()
    this.log = opts.log ?? (() => {})
  }

  get connected(): boolean {
    return this.state === 'ready'
  }

  start(): void {
    this.closedByUs = false
    this.open()
  }

  stop(): void {
    this.closedByUs = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopHeartbeat()
    this.failPending(new Error('bridge shutting down'))
    this.ws?.close()
    this.ws = null
    this.setState('disconnected')
  }

  private setState(next: GatewayState): void {
    if (this.state === next) return
    this.state = next
    this.emit('state', next)
  }

  private open(): void {
    this.setState('connecting')
    const ws = new WebSocket('ws://localhost', {
      createConnection: () => createConnection({ path: this.opts.socketPath }),
    })
    this.ws = ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.setState('authenticating')
      void this.authenticate(ws)
    })

    ws.on('message', (raw: Buffer | string) => {
      if (this.ws !== ws) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }

      if (msg.id != null) {
        const id = Number(msg.id)
        const p = this.pending.get(id)
        if (p) {
          this.pending.delete(id)
          clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(String(msg.error)))
          else p.resolve(msg.result)
          return
        }
      }

      if (typeof msg.event === 'string') {
        this.emit('event', msg.event, msg.data, typeof msg.seq === 'number' ? msg.seq : undefined)
      }
    })

    ws.on('error', (err: Error) => {
      if (this.ws !== ws) return
      this.lastError = err.message
      this.log(`gateway socket error: ${err.message}`)
    })

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopHeartbeat()
      const reason = reasonBuf?.toString() || (code === 1005 || code === 1006 ? 'connection_lost' : `ws_close_${code}`)
      this.failPending(new Error(`gateway connection closed: ${reason}`))
      this.setState('disconnected')
      this.log(`gateway closed (${code} ${reason})`)
      this.scheduleReconnect(reason)
    })
  }

  private async authenticate(ws: WebSocket): Promise<void> {
    try {
      const res = (await this.rpc('auth', { token: this.opts.token }, GATEWAY_LIMITS.authTimeoutMs)) as {
        authenticated?: boolean
        connectId?: string
      }
      if (this.ws !== ws) return
      if (!res?.authenticated) throw new Error('gateway refused the token')
      this.connectId = res.connectId ?? null
      this.reconnectAttempt = 0
      this.lastError = null
      this.setState('ready')
      this.startHeartbeat()
      this.log(`gateway ready (${this.connectId})`)
      this.emit('ready')
    } catch (err) {
      this.lastError = (err as Error).message
      this.log(`gateway auth failed: ${this.lastError}`)
      try {
        ws.close()
      } catch {
        // Already closing.
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatPending = false
    this.heartbeat = setInterval(() => {
      if (this.state !== 'ready' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (this.heartbeatPending) {
        // Last ping never came back. Treat the socket as dead.
        this.log('gateway ping timed out, cycling connection')
        try {
          this.ws.close()
        } catch {
          // Already closing.
        }
        return
      }
      this.heartbeatPending = true
      this.rpc('ping', {}, GATEWAY_LIMITS.pingTimeoutMs).then(
        () => {
          this.heartbeatPending = false
        },
        () => {
          this.heartbeatPending = false
        },
      )
    }, GATEWAY_LIMITS.pingIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUs || this.reconnectTimer) return
    // Same shape as dorabot's own client: fast for the first 30 tries, then back
    // off to a slow poll so a gateway that is simply not running costs nothing.
    const slow = this.reconnectAttempt >= 30
    const base = slow ? 60_000 : Math.min(1000 * 2 ** Math.min(this.reconnectAttempt, 3), 10_000)
    const delay = base + Math.floor(Math.random() * 250)
    this.reconnectAttempt += 1
    this.log(`reconnecting to gateway in ${delay}ms (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected to the dorabot gateway'))
    }
    const id = ++this.rpcId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`gateway RPC timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

export interface GatewayClient {
  on(event: 'state', listener: (state: GatewayState) => void): this
  on(event: 'ready', listener: () => void): this
  on(event: 'event', listener: (name: string, data: unknown, seq?: number) => void): this
  emit(event: 'state', state: GatewayState): boolean
  emit(event: 'ready'): boolean
  emit(event: 'event', name: string, data: unknown, seq?: number): boolean
}
