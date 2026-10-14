import { generateSigningKey, relayIdFromPublicKey, signChallenge, type SigningKeyPair } from '@dorabot-remote/protocol'
import WebSocket from 'ws'

export interface Msg {
  data: string | Uint8Array
  isBinary: boolean
}

/** A ws client that queues everything it receives so tests can await it in order. */
export class Peer {
  readonly ws: WebSocket
  readonly queue: Msg[] = []
  closed: { code: number; reason: string } | null = null
  private waiters: Array<() => void> = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (raw: Buffer, isBinary: boolean) => {
      this.queue.push({ data: isBinary ? new Uint8Array(raw) : raw.toString(), isBinary })
      this.wake()
    })
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() }
      this.wake()
    })
    this.ws.on('error', () => {})
    // workerd's local proxy never finishes the TCP close for a socket whose client
    // has not yet sent a frame, so `ws` would sit in CLOSING for 30s. The close
    // frame itself has arrived by then; read the code from it. Browsers and phones
    // report close on the frame, so this only papers over the Node client.
    this.ws.once('open', () => {
      const receiver = (this.ws as unknown as { _receiver?: { on(e: string, f: (c: number, r: Buffer) => void): void } })._receiver
      receiver?.on('conclude', (code, reason) => {
        this.closed ??= { code, reason: reason.toString() }
        this.wake()
      })
    })
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  private async until<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const v = pick()
      if (v !== undefined) return v
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${what}`)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)))
    })
  }

  next(ms = 5000): Promise<Msg> {
    return this.until(() => this.queue.shift(), ms, 'a message')
  }

  /** Next frame matching `pred`, discarding anything before it. */
  async nextWhere(pred: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
    return this.until(
      () => {
        while (this.queue.length) {
          const m = this.queue.shift()!
          if (pred(m)) return m
        }
        return undefined
      },
      ms,
      'a matching message',
    )
  }

  waitClosed(ms = 5000): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closed ?? undefined, ms, 'close')
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // Already closed.
    }
  }
}

export interface Identity {
  key: SigningKeyPair
  relayId: string
}

export function newIdentity(): Identity {
  const key = generateSigningKey()
  return { key, relayId: relayIdFromPublicKey(key.publicKey) }
}

/** Connect as the host and answer the challenge. Resolves once the relay says ok. */
export async function connectHost(wsBase: string, id: Identity): Promise<Peer> {
  const host = new Peer(`${wsBase}/h/${id.relayId}`)
  await host.opened()
  const ch = JSON.parse((await host.next()).data as string) as { t: string; n: string }
  if (ch.t !== 'challenge') throw new Error('expected challenge')
  host.send(JSON.stringify({ t: 'auth', ...signChallenge(id.key, id.relayId, ch.n) }))
  const ok = JSON.parse((await host.next()).data as string) as { t: string }
  if (ok.t !== 'ok') throw new Error('expected ok')
  return host
}
