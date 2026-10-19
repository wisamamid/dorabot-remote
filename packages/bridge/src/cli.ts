#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SCOPES, type Scope, fingerprint, fromB64, generateIdentity, toB64 } from '@dorabot-remote/protocol'
import QRCode from 'qrcode'
import { candidateAddresses } from './addresses.js'
import { BRIDGE_VERSION, loadIdentity, loadSettings, resolvePaths, saveSettings } from './config.js'
import { Bridge } from './bridge.js'
import { Store } from './store.js'
import * as launchd from './launchd.js'
import { SetupError, isFirstRun, runSetup, runUninstall } from './setup.js'

const USAGE = `dorabot-remote ${BRIDGE_VERSION}

  Pair your phone with the dorabot running on this machine.

  setup                       One-command install: run at login, then show the pairing QR
  update                      Re-run setup with this version (npx dorabot-remote@latest update)
  start                       Run the bridge (also opens the pairing page)
  pair                        Print a pairing QR in the terminal
  devices                     List paired devices
  grant <deviceId> <scope>    Add a permission to a device
  revoke <deviceId>           Block a device without deleting it
  remove <deviceId>           Delete a device entirely
  addresses                   Show the addresses a phone can reach this Mac on
  config                      Show or change settings
  install                     Run the bridge at login as a launchd agent (macOS)
  uninstall                   Stop and remove the launchd agent and installed app
                              (keeps keys and devices; --purge deletes those too)
  status                      Show whether the launchd agent is running

Options
  --port <n>          Port to listen on (default 7788)
  --bind <addr>       Interface to bind (default 0.0.0.0)
  --advertise <addr>  Extra address to put in the QR, e.g. a Tailscale name
  --scopes <a,b,c>    Permissions to grant at pairing time
  --open              Open the control page in a browser on start
  --yes               Do not ask questions (setup)
  --purge             With uninstall: also delete keys and paired devices

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
      yes: { type: 'boolean', short: 'y' },
      purge: { type: 'boolean' },
      uninstall: { type: 'boolean' },
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
  const firstRun = positionals.length === 0 && isFirstRun(paths, launchd)
  if (firstRun && process.stdout.isTTY) {
    process.stdout.write(
      `dorabot-remote ${BRIDGE_VERSION}\n\n  First run. To install the bridge and pair your phone, run:\n\n    npx dorabot-remote setup\n\n  (or "dorabot-remote start" to run it in the foreground.)\n`,
    )
    return
  }
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
    case 'setup':
    case 'update':
      if (values.uninstall) {
        await runUninstall({ paths, launchd, log: say }, values.purge === true)
        return
      }
      await cmdSetup(command === 'update', values.yes === true)
      return
    case 'install':
      cmdInstall()
      return
    case 'uninstall':
      await runUninstall({ paths, launchd, log: say }, values.purge === true)
      return
    case 'status':
      cmdStatus()
      return
    case 'config':
      process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`)
      return
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`)
      process.exitCode = 1
  }

  function say(line: string): void {
    process.stdout.write(`${line}\n`)
  }

  async function cmdSetup(isUpdate: boolean, yes: boolean): Promise<void> {
    const env: Record<string, string> = {}
    for (const key of ['DORABOT_REMOTE_HOME', 'DORABOT_HOME']) {
      const v = process.env[key]
      if (v) env[key] = v
    }
    const interactive = !yes && process.stdin.isTTY === true && process.stdout.isTTY === true
    try {
      await runSetup({
        paths,
        version: BRIDGE_VERSION,
        sourceDir: dirname(fileURLToPath(import.meta.url)),
        nodePath: process.execPath,
        nodeVersion: process.versions.node,
        platform: process.platform,
        port: settings.port,
        launchd,
        env,
        log: say,
        health: async () => (await fetch(`http://127.0.0.1:${settings.port}/api/state`)).ok,
        pair: () => cmdPair(undefined),
        skipPair: isUpdate,
        openUrl: (url) => {
          void import('node:child_process').then(({ spawn }) => spawn('open', [url], { stdio: 'ignore', detached: true }).unref())
        },
        confirm: interactive
          ? async (q) => {
              const { createInterface } = await import('node:readline/promises')
              const rl = createInterface({ input: process.stdin, output: process.stdout })
              const a = (await rl.question(`${q} [Y/n] `)).trim().toLowerCase()
              rl.close()
              return a === '' || a === 'y' || a === 'yes'
            }
          : undefined,
      })
    } catch (err) {
      if (err instanceof SetupError) {
        process.stderr.write(`\n${err.message}\n`)
        process.exitCode = 1
        return
      }
      throw err
    }
  }

  async function cmdStart(open: boolean): Promise<void> {
    const bridge = new Bridge({ paths, settings, log: (m) => process.stdout.write(`${m}\n`) })
    await bridge.start()

    const addrs = candidateAddresses(settings.port, settings.extraAddresses, settings.bind)
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
      a: candidateAddresses(settings.port, settings.extraAddresses, settings.bind).map((a) => a.address),
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

  function cmdInstall(): void {
    const env: Record<string, string> = {}
    for (const key of ['DORABOT_REMOTE_HOME', 'DORABOT_HOME']) {
      const v = process.env[key]
      if (v) env[key] = v
    }
    const file = launchd.install({ cliPath: fileURLToPath(import.meta.url), root: paths.root, env })
    process.stdout.write(`Installed ${file}\nThe bridge now starts at login and restarts if it stops.\nLogs: ${join(paths.root, 'logs')}\n`)
  }

  function cmdStatus(): void {
    const s = launchd.status()
    if (!s.installed && !s.loaded) {
      process.stdout.write('Not installed. Run "dorabot-remote install" to start the bridge at login.\n')
      return
    }
    process.stdout.write(`${s.loaded ? (s.pid ? `Running (pid ${s.pid})` : 'Loaded, not running') : 'Installed but not loaded'}\n${s.plist}\n`)
  }

  function cmdAddresses(): void {
    for (const a of candidateAddresses(settings.port, settings.extraAddresses, settings.bind)) {
      process.stdout.write(`${a.address.padEnd(28)} ${a.label}\n`)
    }
  }
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
