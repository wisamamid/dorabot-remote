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
import { loginUrl } from './control-auth.js'
import { describeRule } from './rules.js'
import { createRootsStore, rootsFilePath } from './roots.js'
import * as launchd from './launchd.js'
import { SetupError, isFirstRun, runSetup, runUninstall } from './setup.js'

const USAGE = `dorabot-remote ${BRIDGE_VERSION}

  Pair your phone with the dorabot running on this machine.

  setup                       One-command install: run at login, then show the pairing QR
  update                      Re-run setup with this version (npx dorabot-remote@latest update)
  start                       Run the bridge (also opens the pairing page)
  open                        Open the control page (prints a one-time login link)
  pair                        Print a pairing QR in the terminal (--open: also open the control page)
  devices                     List paired devices (--pending: only those awaiting approval)
  approve <deviceId>          Allow a newly paired phone to control dorabot
  reject <deviceId>           Refuse and delete a newly paired phone
  audit                       Show recent security-relevant actions (--device <id>, --limit <n>)
  folders [add|remove <path>] List, add or remove shared folders
  rules [remove <id>]         List or remove always-allow approval rules
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
  --open              Open the control page in a browser (start, pair)
  --pending           With devices: only phones waiting for approval
  --device <id>       With audit: only this device
  --limit <n>         With audit: how many entries (default 50)
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
      pending: { type: 'boolean' },
      device: { type: 'string' },
      limit: { type: 'string' },
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
    case 'open':
      await cmdOpen()
      return
    case 'pair':
      await cmdPair(scopes, values.open === true)
      return
    case 'devices':
      await cmdDevices(values.pending === true)
      return
    case 'approve':
      cmdDecide(positionals[1], true)
      return
    case 'reject':
      cmdDecide(positionals[1], false)
      return
    case 'audit':
      cmdAudit(values.device, Number(values.limit ?? 50))
      return
    case 'rules':
      cmdRules(positionals[1], positionals[2])
      return
    case 'folders':
      await cmdFolders(positionals[1], positionals[2])
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
        health: async () => (await fetch(`http://127.0.0.1:${settings.port}/health`)).ok,
        pair: () => cmdPair(undefined, false),
        skipPair: isUpdate,
        // The control page needs a one-time login link, not the bare URL.
        openUrl: () => openBrowser(mintLoginUrl()),
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
    // Only mint a login link when someone is looking (a TTY) or asked for one; under
    // launchd the log would otherwise collect live links.
    const link = open || process.stdout.isTTY ? loginUrl(settings.port, bridge.store.createLoginToken()) : null
    process.stdout.write(
      link
        ? `  Control page   ${link}\n                 (one-time link, valid 5 minutes; run "dorabot-remote open" for a new one)\n`
        : `  Control page   run "dorabot-remote open"\n`,
    )
    process.stdout.write(`  Host key       ${bridge.hostSummary.fingerprint}\n`)
    process.stdout.write(`  Reachable at   ${addrs.map((a) => a.address).join('\n                 ')}\n`)
    const devices = bridge.store.listDevices()
    process.stdout.write(
      devices.length === 0
        ? `\n  No devices paired yet. Open the control page, or run "dorabot-remote pair".\n\n`
        : `\n  ${devices.length} device(s) paired.\n\n`,
    )

    if (open && link) openBrowser(link)

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
  function mintLoginUrl(): string {
    const store = new Store(paths.db)
    try {
      return loginUrl(settings.port, store.createLoginToken())
    } finally {
      store.close()
    }
  }

  function openBrowser(url: string): void {
    void import('node:child_process').then(({ spawn }) => spawn('open', [url], { stdio: 'ignore', detached: true }).unref())
  }

  async function cmdOpen(): Promise<void> {
    const url = mintLoginUrl()
    process.stdout.write(`${url}\n(one-time link, valid 5 minutes)\n`)
    openBrowser(url)
  }

  async function cmdPair(withScopes?: Scope[], open = false): Promise<void> {
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
    process.stdout.write(`  The bridge must be running for the phone to connect: dorabot-remote start\n`)
    process.stdout.write(`  After pairing, approve the phone on this Mac: the control page, or "dorabot-remote approve <id>".\n\n`)
    store.close()
    if (open) await cmdOpen()
  }

  async function cmdDevices(pendingOnly = false): Promise<void> {
    const store = new Store(paths.db)
    const devices = pendingOnly ? store.listPending() : store.listDevices()
    if (devices.length === 0) {
      process.stdout.write(pendingOnly ? 'No devices waiting for approval.\n' : 'No devices paired.\n')
    }
    for (const d of devices) {
      const fp = fingerprint(null, fromB64(null, d.publicKey))
      process.stdout.write(
        `${d.pending ? '?' : d.revoked ? '✗' : '✓'} ${d.name}  (${d.platform})${d.pending ? '  WAITING FOR APPROVAL' : ''}${d.revokedReason === 'expired' ? '  revoked: unseen for 90 days' : ''}\n` +
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
    if (!device.scopes.includes(scope)) {
      store.setScopes(deviceId, [...device.scopes, scope])
      store.recordAudit({ deviceId, deviceName: device.name, action: 'scopes', summary: `+[${scope}]`, transport: 'cli' })
    }
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
    const dev = store.getDevice(deviceId)
    const ok = store.setRevoked(deviceId, revoked)
    if (ok) {
      // Restoring restarts the 90-day unseen clock so the expiry sweep does not undo it.
      if (!revoked) store.touchDevice(deviceId)
      store.recordAudit({ deviceId, deviceName: dev?.name, action: revoked ? 'revoke' : 'restore', transport: 'cli' })
    }
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
    const dev = store.getDevice(deviceId)
    const ok = store.deleteDevice(deviceId)
    if (ok) store.recordAudit({ deviceId, deviceName: dev?.name, action: 'delete', transport: 'cli' })
    process.stdout.write(ok ? `Removed ${deviceId}.\n` : `No device with id ${deviceId}\n`)
    store.close()
  }

  function cmdDecide(deviceId: string | undefined, approve: boolean): void {
    if (!deviceId) {
      process.stderr.write(`Usage: dorabot-remote ${approve ? 'approve' : 'reject'} <deviceId>   (see: dorabot-remote devices --pending)\n`)
      process.exitCode = 1
      return
    }
    const store = new Store(paths.db)
    const dev = store.getDevice(deviceId)
    const ok = dev ? (approve ? store.approveDevice(deviceId) : store.rejectDevice(deviceId)) : false
    if (ok) {
      store.recordAudit({
        deviceId,
        deviceName: dev?.name,
        action: approve ? 'approve' : 'reject',
        summary: approve ? `scopes=${dev?.scopes.join(',')}` : undefined,
        transport: 'cli',
      })
      process.stdout.write(approve ? `Approved ${dev?.name}. It can connect now.\n` : `Rejected and removed ${dev?.name}.\n`)
    } else {
      process.stderr.write(`No pending device with id ${deviceId}\n`)
      process.exitCode = 1
    }
    store.close()
  }

  function cmdAudit(deviceId: string | undefined, limit: number): void {
    const store = new Store(paths.db)
    const rows = store.listAudit({ deviceId, limit: Number.isFinite(limit) && limit > 0 ? limit : 50 })
    if (rows.length === 0) process.stdout.write('Nothing recorded yet.\n')
    for (const r of rows) {
      process.stdout.write(
        `${new Date(r.at).toLocaleString()}  ${(r.deviceName ?? (r.deviceId ? r.deviceId.slice(0, 8) : 'this Mac')).padEnd(18)} ` +
          `${(r.action === 'rpc' ? r.method : r.action)?.padEnd(20)} ${[r.summary, r.requestId ? `req ${r.requestId}` : '', r.transport ?? ''].filter(Boolean).join(' | ')}\n`,
      )
    }
    store.close()
  }

  const rootsStore = createRootsStore(() => rootsFilePath(paths.root), { protectedPaths: () => [paths.root, paths.db, paths.identity, paths.signingKey, paths.settings, paths.dorabotRoot, paths.gatewayToken, paths.gatewaySocket] })
  async function cmdFolders(sub: string | undefined, path: string | undefined): Promise<void> {
    if (sub === 'add' || sub === 'remove') {
      if (!path) {
        process.stderr.write(`Usage: dorabot-remote folders ${sub} <absolute path>\n`)
        process.exitCode = 1
        return
      }
      try {
        if (sub === 'add') rootsStore.addRoot(path)
        else rootsStore.removeRoot(path)
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exitCode = 1
        return
      }
      const store = new Store(paths.db)
      store.recordAudit({ action: sub === 'add' ? 'folder_add' : 'folder_remove', summary: path.slice(0, 150), transport: 'cli' })
      store.close()
    } else if (sub !== undefined) {
      process.stderr.write('Usage: dorabot-remote folders [add|remove <absolute path>]\n')
      process.exitCode = 1
      return
    }
    const roots = rootsStore.listRoots()
    process.stdout.write(roots.length ? `${roots.join('\n')}\n` : 'No folders shared.\n')
  }

  function cmdRules(sub: string | undefined, id: string | undefined): void {
    if (sub !== undefined && sub !== 'remove') {
      process.stderr.write('Usage: dorabot-remote rules [remove <id>]\n')
      process.exitCode = 1
      return
    }
    const store = new Store(paths.db)
    try {
      if (sub === 'remove') {
        const removed = id ? store.removeRule(id) : null
        if (!removed) {
          process.stderr.write(id ? `No rule with id ${id}\n` : 'Usage: dorabot-remote rules remove <id>\n')
          process.exitCode = 1
          return
        }
        store.recordAudit({ action: 'rule_remove', summary: `rule=${removed.id} ${describeRule(removed)}`, transport: 'cli' })
        process.stdout.write(`Removed rule ${removed.id}. A running bridge picks this up on the next approval.\n`)
      }
      const rules = store.listRules()
      if (rules.length === 0) process.stdout.write('No always-allow rules.\n')
      for (const r of rules) process.stdout.write(`${r.id}  ${describeRule(r)}  (${r.createdBy ?? 'unknown'}, ${new Date(r.createdAt).toLocaleDateString()})\n`)
    } finally {
      store.close()
    }
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
