import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BridgePaths } from './config.js'
import type { KeyStore } from './keychain.js'
import type { LaunchdStatus } from './launchd.js'

/** node:sqlite is unflagged from 22.13. */
export const MIN_NODE = [22, 13] as const

export interface LaunchdLike {
  install(args: { cliPath: string; root: string; env?: Record<string, string>; nodePath?: string }): string
  uninstall(): boolean
  status(): LaunchdStatus
}

export interface SetupDeps {
  paths: BridgePaths
  version: string
  /** Directory holding the built app (cli.js and friends) to copy. */
  sourceDir: string
  nodePath: string
  nodeVersion: string
  platform: string
  port: number
  launchd: LaunchdLike
  /** Resolves true once the control API answers. */
  health: () => Promise<boolean>
  pair: () => Promise<void>
  /** Ask a yes/no question; undefined when not interactive. */
  confirm?: (question: string) => Promise<boolean>
  openUrl?: (url: string) => void
  log: (line: string) => void
  env?: Record<string, string>
  healthTimeoutMs?: number
  /** Skip the pairing QR (used by `update`). */
  skipPair?: boolean
}

export class SetupError extends Error {}

export function nodeOk(version: string): boolean {
  const [maj = 0, min = 0] = version.split('.').map(Number)
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])
}

export const appDir = (paths: BridgePaths): string => join(paths.root, 'app')

export function checkPrerequisites(d: SetupDeps): void {
  if (!nodeOk(d.nodeVersion)) {
    throw new SetupError(
      `Node ${MIN_NODE.join('.')} or newer is required (you have ${d.nodeVersion}).\n` +
        `  With nvm:       nvm install 24 && nvm use 24\n` +
        `  With Homebrew:  brew install node\n` +
        `Then run this again.`,
    )
  }
  if (d.platform !== 'darwin') {
    throw new SetupError('Automatic setup is macOS only. Run "dorabot-remote start" to run the bridge in the foreground.')
  }
  const { gatewaySocket, gatewayToken } = d.paths
  if (!existsSync(gatewayToken) || !existsSync(gatewaySocket)) {
    const missing = [!existsSync(gatewaySocket) && gatewaySocket, !existsSync(gatewayToken) && gatewayToken].filter(Boolean)
    throw new SetupError(
      `dorabot does not look like it is installed and running (missing ${missing.join(' and ')}).\n` +
        `Install dorabot (https://github.com/suitedaces/dorabot), open it once so its gateway starts, then run this again.`,
    )
  }
}

/** Copy the built app to a stable location and point `current` at it. Returns the cli path. */
export function stageApp(d: SetupDeps): string {
  const base = appDir(d.paths)
  const target = join(base, d.version)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  rmSync(target, { recursive: true, force: true })
  cpSync(d.sourceDir, target, { recursive: true })
  // The copy lives outside the npm package, so tell node it is ESM.
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: 'dorabot-remote-app', version: d.version, type: 'module', private: true })}\n`)

  const current = join(base, 'current')
  rmSync(current, { recursive: true, force: true })
  symlinkSync(d.version, current, 'dir')

  // Keep the previous version around for rollback; drop anything older.
  const versions = readdirSync(base).filter((n) => n !== 'current' && n !== d.version)
  for (const old of versions.slice(0, Math.max(0, versions.length - 1))) {
    rmSync(join(base, old), { recursive: true, force: true })
  }
  return join(current, 'cli.js')
}

async function waitHealthy(d: SetupDeps): Promise<boolean> {
  const deadline = Date.now() + (d.healthTimeoutMs ?? 20000)
  while (Date.now() < deadline) {
    if (await d.health().catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

export async function runSetup(d: SetupDeps): Promise<void> {
  const say = d.log
  checkPrerequisites(d)
  say(`Node ${d.nodeVersion} ok. dorabot gateway found.`)

  const cliPath = stageApp(d)
  say(`Installed dorabot-remote ${d.version} to ${dirname(cliPath)}`)

  const env: Record<string, string> = { ...(d.env ?? {}) }
  const plist = d.launchd.install({ cliPath, root: d.paths.root, env, nodePath: d.nodePath })
  say(`Installed ${plist}`)

  if (!(await waitHealthy(d))) {
    throw new SetupError(
      `The bridge did not come up on 127.0.0.1:${d.port}. Check the logs in ${join(d.paths.root, 'logs')}.`,
    )
  }
  say('Bridge is running and starts at login.')

  if (!d.skipPair) await d.pair()
  const url = `http://127.0.0.1:${d.port}/`
  if (d.confirm && d.openUrl && (await d.confirm(`Open the control page (${url})?`))) d.openUrl(url)
  else say(`Control page: ${url}`)
}

/** The Keychain items the bridge creates (see keychain.ts). */
export const KEYCHAIN_SECRETS = ['host-identity', 'signing-key', 'control-secret'] as const

export async function runUninstall(d: Pick<SetupDeps, 'paths' | 'launchd' | 'log'> & { keychain?: KeyStore | null }, purge: boolean): Promise<void> {
  const had = d.launchd.uninstall()
  d.log(had ? 'Removed the launchd agent.' : 'The launchd agent was not installed.')
  rmSync(appDir(d.paths), { recursive: true, force: true })
  d.log('Removed the installed app.')
  if (purge) {
    rmSync(d.paths.root, { recursive: true, force: true })
    d.log(`Deleted ${d.paths.root} (keys, paired devices, logs).`)
    if (d.keychain) {
      for (const name of KEYCHAIN_SECRETS) {
        try {
          d.keychain.delete(name)
        } catch (err) {
          d.log(`Could not remove "${name}" from the login Keychain (${(err as Error).message}). Remove it in Keychain Access (service "dorabot-remote").`)
        }
      }
      d.log('Removed the bridge keys from the login Keychain.')
    }
  } else if (existsSync(d.paths.root)) {
    d.log(`Kept keys and paired devices in ${d.paths.root}. Add --purge to delete them too.`)
  }
}

export function isFirstRun(paths: BridgePaths, launchd: LaunchdLike): boolean {
  if (existsSync(paths.settings)) return false
  try {
    lstatSync(appDir(paths))
    return false
  } catch {
    return !launchd.status().installed
  }
}
