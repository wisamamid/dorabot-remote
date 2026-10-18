import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * A stand-in for the dorabot gateway: speaks the same auth handshake, answers a
 * few RPCs, and can push events on demand.
 */
export class FakeGateway {
  /** Per-method canned results, for tests that need an unusual reply. */
  overrides = new Map<string, unknown>()
  private socketPath = ''
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  calls: Array<{ method: string; params: Record<string, unknown> }> = []

  async start(socketPath: string, token: string): Promise<void> {
    this.socketPath = socketPath
    rmSync(socketPath, { force: true })
    const server = createServer()
    const wss = new WebSocketServer({ server })

    wss.on('connection', (ws) => {
      let authed = false
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { id?: number; method: string; params?: Record<string, unknown> }
        if (!authed) {
          if (msg.method !== 'auth' || msg.params?.token !== token) {
            ws.send(JSON.stringify({ id: msg.id, error: 'invalid token' }))
            ws.close()
            return
          }
          authed = true
          this.clients.add(ws)
          // Same frame order as the real gateway: two events, then the reply.
          ws.send(JSON.stringify({ event: 'gateway.telemetry', data: { connect_id: 'conn-1' } }))
          ws.send(
            JSON.stringify({
              event: 'status.update',
              data: {
                running: true,
                sessions: [
                  { key: 'desktop:dm:abc', channel: 'desktop', chatType: 'dm', chatId: 'abc', sessionId: 'sid-1', messageCount: 2, lastMessageAt: Date.now(), activeRun: false },
                ],
              },
            }),
          )
          ws.send(JSON.stringify({ id: msg.id, result: { authenticated: true, connectId: 'conn-1' } }))
          return
        }

        this.calls.push({ method: msg.method, params: msg.params ?? {} })
        if (this.overrides.has(msg.method)) {
          ws.send(JSON.stringify({ id: msg.id, result: this.overrides.get(msg.method) }))
          return
        }
        switch (msg.method) {
          case 'ping':
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true, timestamp: Date.now() } }))
            return
          case 'status':
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { running: true, sessions: [{ key: 'desktop:dm:abc', sessionId: 'sid-1' }] },
              }),
            )
            return
          case 'sessions.subscribe':
            ws.send(JSON.stringify({ id: msg.id, result: { subscribed: msg.params?.sessionKeys, replayCount: 0 } }))
            return
          case 'sessions.list':
            ws.send(JSON.stringify({ id: msg.id, result: [{ id: 'sid-1', messageCount: 2, createdAt: '', updatedAt: '' }] }))
            return
          case 'chat.send':
            ws.send(JSON.stringify({ id: msg.id, result: { sessionKey: 'desktop:dm:abc', sessionId: 'sid-1', queued: true } }))
            return
          case 'shell.spawn':
            ws.send(JSON.stringify({ id: msg.id, result: { spawned: true } }))
            return
          case 'config.set':
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
            return
          default:
            ws.send(JSON.stringify({ id: msg.id, error: `unknown method: ${msg.method}` }))
        }
      })
      ws.on('close', () => this.clients.delete(ws))
    })

    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    this.server = server
    this.wss = wss
  }

  push(event: string, data: unknown, seq?: number): void {
    const frame = JSON.stringify(seq === undefined ? { event, data } : { event, data, seq })
    for (const ws of this.clients) ws.send(frame)
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close()
    this.wss?.close()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    rmSync(this.socketPath, { force: true })
  }
}
