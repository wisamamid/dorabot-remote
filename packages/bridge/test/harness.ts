import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePairingPayload, pairWithHost, RemoteClient, type PairResult } from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { Bridge } from '../src/bridge.js'
import { loadSettings, resolvePaths, type BridgePaths } from '../src/config.js'
import { loadControlSecret } from '../src/control-auth.js'
import { FakeGateway } from './fake-gateway.js'

export const createSocket = (url: string) => new WebSocket(url) as never
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until(cond: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}

export interface Harness {
  bridge: Bridge
  gateway: FakeGateway
  home: string
  paths: BridgePaths
  port: number
  notices: string[]
  secret: string
  post(path: string, body: unknown): Promise<{ status: number; body: any }>
  get(path: string): Promise<{ status: number; body: any }>
  pairApproved(name?: string, scopes?: string[]): Promise<PairResult>
  connect(pair: PairResult): Promise<RemoteClient>
  stop(): Promise<void>
}

/** A real bridge on 127.0.0.1:<port> in a temp home, with a fake dorabot gateway behind it. */
export async function startHarness(port: number): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'dorabot-remote-h-'))
  const sock = join(tmpdir(), `dr-h-${port}-${process.pid}.sock`)
  const gateway = new FakeGateway()
  const paths = resolvePaths({
    root: home,
    db: join(home, 'bridge.db'),
    identity: join(home, 'host-key.json'),
    settings: join(home, 'settings.json'),
    gatewaySocket: sock,
    gatewayToken: join(home, 'gateway-token'),
  })
  writeFileSync(paths.gatewayToken, 'd'.repeat(64))
  await gateway.start(sock, 'd'.repeat(64))
  const settings = loadSettings(paths)
  settings.port = port
  settings.bind = '127.0.0.1'
  const notices: string[] = []
  const bridge = new Bridge({ paths, settings, notify: (t, b) => notices.push(`${t}: ${b}`) })
  await bridge.start()
  const secret = loadControlSecret(home)

  const call = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${secret}` } },
        (res) => {
          let b = ''
          res.on('data', (c) => (b += c))
          res.on('end', () => {
            let parsed: unknown = b
            try {
              parsed = JSON.parse(b)
            } catch {
              // keep text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('error', reject)
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })

  return {
    bridge,
    gateway,
    home,
    paths,
    port,
    notices,
    secret,
    post: (p, b) => call('POST', p, b),
    get: (p) => call('GET', p),
    async pairApproved(name = 'iPhone X', scopes) {
      const { uri } = bridge.newPairingPayload(scopes as never)
      const res = await pairWithHost({ payload: decodePairingPayload(uri), deviceName: name, platform: 'ios', createSocket })
      if (!bridge.approveDevice(res.deviceId)) throw new Error('approve failed')
      return res
    },
    async connect(pair) {
      const client = new RemoteClient({
        identity: pair.identity,
        deviceId: pair.deviceId,
        hostPublicKey: pair.hostPublicKey,
        addresses: [`127.0.0.1:${port}`],
        createSocket,
      })
      client.connect()
      await until(() => client.state === 'ready', 8000, 'client ready')
      return client
    },
    async stop() {
      await bridge.stop()
      await gateway.stop()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
