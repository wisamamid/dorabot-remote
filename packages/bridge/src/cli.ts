#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { SCOPES, type Scope, fingerprint, fromB64, generateIdentity, toB64 } from '@dorabot-remote/protocol'
import QRCode from 'qrcode'
import { candidateAddresses } from './addresses.js'
import { BRIDGE_VERSION, loadIdentity, loadSettings, resolvePaths, saveSettings } from './config.js'
import { Bridge } from './bridge.js'
import { Store } from './store.js'

const USAGE = `dorabot-remote ${BRIDGE_VERSION}

  Pair your phone with the dorabot running on this machine.

  start                       Run the bridge (also opens the pairing page)
  pair                        Print a pairing QR in the terminal
  devices                     List paired devices
  grant <deviceId> <scope>    Add a permission to a device
  revoke <deviceId>           Block a device without deleting it
  remove <deviceId>           Delete a device entirely
  addresses                   Show the addresses a phone can reach this Mac on
  config                      Show or change settings

Options
  --port <n>          Port to listen on (default 7788)
  --bind <addr>       Interface to bind (default 0.0.0.0)
  --advertise <addr>  Extra address to put in the QR, e.g. a Tailscale name
  --scopes <a,b,c>    Permissions to grant at pairing time
  --open              Open the control page in a browser on start

Permissions: ${SCOPES.join(', ')}
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      bind: { type: 'string' },
      advertise: { type: 'string', multiple: true },
      scopes: { type: 'string' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (values.version) {
    process.stdout.write(`${BRIDGE_VERSION}\n`)
    return
  }

  const paths = resolvePaths()
  const settings = loadSettings(paths)
  let dirty = false
  if (values.port) {
    settings.port = Number(values.port)
    dirty = true
  }
  if (values.bind) {
    settings.bind = values.bind
    dirty = true
  }
  if (values.advertise?.length) {
    settings.extraAddresses = [...new Set([...settings.extraAddresses, ...values.advertise])]
    dirty = true
  }
  if (dirty) saveSettings(paths, settings)

  const scopes = values.scopes
    ? (values.scopes.split(',').map((s) => s.trim()) as Scope[]).filter((s) => SCOPES.includes(s))
    : undefined

  const command = positionals[0] ?? 'start'

  switch (command) {
    case 'start':
      await cmdStart(values.open === true)
      return
    case 'pair':
      await cmdPair(scopes)
      return
    case 'devices':
      await cmdDevices()
      return
    case 'grant':
      await cmdGrant(positionals[1], positionals[2] as Scope)
      return
    case 'revoke':
      cmdSetRevoked(positionals[1], true)
      return
    case 'unrevoke':
      cmdSetRevoked(positionals[1], false)
      return
    case 'remove':
      cmdRemove(positionals[1])
      return
    case 'addresses':
      cmdAddresses()
      return
    case 'config':
      process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`)
      return
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`)
      process.exitCode = 1
  }

  async function cmdStart(open: boolean): Promise<void> {
    const bridge = new Bridge({ paths, settings, log: (m) => process.stdout.write(`${m}\n`) })
    await bridge.start()

    const addrs = candidateAddresses(settings.port, settings.extraAddresses)
    process.stdout.write(`\n  dorabot remote is running.\n\n`)
    process.stdout.write(`  Control page   http://127.0.0.1:${settings.port}/\n`)
    process.stdout.write(`  Host key       ${bridge.hostSummary.fingerprint}\n`)
    process.stdout.write(`  Reachable at   ${addrs.map((a) => a.address).join('\n                 ')}\n`)
    const devices = bridge.store.listDevices()
    process.stdout.write(
      devices.length === 0
        ? `\n  No devices paired yet. Open the control page, or run "dorabot-remote pair".\n\n`
        : `\n  ${devices.length} device(s) paired.\n\n`,
    )

    if (open) {
      const { spawn } = await import('node:child_process')
      spawn('open', [`http://127.0.0.1:${settings.port}/`], { stdio: 'ignore', detached: true }).unref()
    }

    const shutdown = async (): Promise<void> => {
      process.stdout.write('\nshutting down…\n')
      await bridge.stop()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  }

  /**
   * Prints a QR straight into the terminal, so pairing works over SSH with no
   * browser. The payload is identical to the one the control page renders.
   */
  async function cmdPair(withScopes?: Scope[]): Promise<void> {
    const identity = loadIdentity(null, paths)
    const store = new Store(paths.db)
    const { code, expiresAt } = store.createPairing(settings.pairingTtlMs, withScopes)
    const payload = {
      v: 1,
      h: settings.hostId,
      n: settings.hostName,
      k: toB64(null, identity.publicKey),
      c: code,
      a: candidateAddresses(settings.port, settings.extraAddresses).map((a) => a.address),
      e: expiresAt,
    }
    const uri = `dorabot-remote://pair#${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
    const art = await QRCode.toString(uri, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
    process.stdout.write(`\n${art}\n`)
    process.stdout.write(`  Code        ${code}\n`)
    process.stdout.write(`  Host key    ${fingerprint(null, identity.publicKey)}\n`)
    process.stdout.write(`  Expires     ${new Date(expiresAt).toLocaleTimeString()}\n`)
    process.stdout.write(`  Addresses   ${payload.a.join('\n              ')}\n\n`)
    process.stdout.write(`  The bridge must be running for the phone to connect: dorabot-remote start\n\n`)
    store.close()
  }

  async function cmdDevices(): Promise<void> {
    const store = new Store(paths.db)
    const devices = store.listDevices()
    if (devices.length === 0) {
      process.stdout.write('No devices paired.\n')
    }
    for (const d of devices) {
      const fp = fingerprint(null, fromB64(null, d.publicKey))
      process.stdout.write(
        `${d.revoked ? '✗' : '✓'} ${d.name}  (${d.platform})\n` +
          `  id        ${d.id}\n` +
          `  key       ${fp}\n` +
          `  allowed   ${d.scopes.join(', ')}\n` +
          `  last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}\n\n`,
      )
    }
    store.close()
  }

  async function cmdGrant(deviceId: string | undefined, scope: Scope | undefined): Promise<void> {
    if (!deviceId || !scope || !SCOPES.includes(scope)) {
      process.stderr.write(`Usage: dorabot-remote grant <deviceId> <${SCOPES.join('|')}>\n`)
      process.exitCode = 1
      return
    }
    const store = new Store(paths.db)
    const device = store.getDevice(deviceId)
    if (!device) {
      process.stderr.write(`No device with id ${deviceId}\n`)
      process.exitCode = 1
      store.close()
      return
    }
    if (!device.scopes.includes(scope)) store.setScopes(deviceId, [...device.scopes, scope])
    process.stdout.write(`Granted "${scope}" to ${device.name}.\n`)
    if (scope === 'terminal') {
      process.stdout.write('That device can now open a real shell on this machine.\n')
    }
    process.stdout.write('Reconnect the device for it to take effect immediately.\n')
    store.close()
  }

  function cmdSetRevoked(deviceId: string | undefined, revoked: boolean): void {
    if (!deviceId) {
      process.stderr.write('Usage: dorabot-remote revoke <deviceId>\n')
      process.exitCode = 1
      return
    }
    const store = new Store(paths.db)
    const ok = store.setRevoked(deviceId, revoked)
    process.stdout.write(ok ? `${revoked ? 'Revoked' : 'Restored'} ${deviceId}.\n` : `No device with id ${deviceId}\n`)
    store.close()
  }

  function cmdRemove(deviceId: string | undefined): void {
    if (!deviceId) {
      process.stderr.write('Usage: dorabot-remote remove <deviceId>\n')
      process.exitCode = 1
      return
    }
    const store = new Store(paths.db)
    process.stdout.write(store.deleteDevice(deviceId) ? `Removed ${deviceId}.\n` : `No device with id ${deviceId}\n`)
    store.close()
  }

  function cmdAddresses(): void {
    for (const a of candidateAddresses(settings.port, settings.extraAddresses)) {
      process.stdout.write(`${a.address.padEnd(28)} ${a.label}\n`)
    }
  }
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
