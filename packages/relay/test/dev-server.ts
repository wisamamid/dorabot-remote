/**
 * Boots `wrangler dev --local` (real workerd, real Durable Objects, no Cloudflare
 * account) on a free port. Shared by the relay and bridge integration tests.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DevServer {
  /** http://127.0.0.1:port */
  http: string
  /** ws://127.0.0.1:port */
  ws: string
  stop(): Promise<void>
}

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

export async function startDevServer(extraArgs: string[] = []): Promise<DevServer> {
  const port = await freePort()
  const inspector = await freePort()
  const persist = mkdtempSync(join(tmpdir(), 'dr-relay-'))
  const child: ChildProcess = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', persist, ...extraArgs],
    {
      cwd: RELAY_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  const collect = (d: Buffer): void => {
    output += d
    if (process.env.DEV_SERVER_DEBUG) process.stderr.write(d)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const http = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 80_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output.slice(-2000)}`)
    try {
      const res = await fetch(`${http}/health`)
      if (res.ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`wrangler dev did not start:\n${output.slice(-2000)}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  return {
    http,
    ws: `ws://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.on('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
      rmSync(persist, { recursive: true, force: true })
    },
  }
}
