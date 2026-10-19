import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const LAUNCHD_LABEL = 'com.xische.dorabotremote.bridge'

export interface LaunchdOptions {
  /** Absolute path to the node binary that will run the bridge. */
  nodePath: string
  /** Absolute path to dist/cli.js. */
  cliPath: string
  /** Directory the bridge writes stdout/stderr logs to. */
  logDir: string
  /** Environment overrides to carry into the agent (e.g. DORABOT_REMOTE_HOME). */
  env?: Record<string, string>
}

export function plistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The launch agent definition. Kept pure so it can be tested without launchctl.
 *
 * KeepAlive restarts the bridge if it crashes, ThrottleInterval stops a crash
 * loop from hammering the machine, and the node path is absolute because a
 * launchd job does not inherit the shell PATH (nvm, Homebrew, ...).
 */
export function renderPlist(opts: LaunchdOptions): string {
  const env = Object.entries(opts.env ?? {})
  const envBlock = env.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`).join('\n')}
  </dict>
`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodePath)}</string>
    <string>--enable-source-maps</string>
    <string>${escapeXml(opts.cliPath)}</string>
    <string>start</string>
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.logDir, 'bridge.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.logDir, 'bridge.err.log'))}</string>
</dict>
</plist>
`
}

const domain = (): string => `gui/${process.getuid?.() ?? 501}`
const service = (): string => `${domain()}/${LAUNCHD_LABEL}`

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

export function isLoaded(): boolean {
  return launchctl(['print', service()]).ok
}

/** Write the plist and (re)load it. Safe to run repeatedly. */
export function install(args: { cliPath: string; root: string; env?: Record<string, string>; nodePath?: string }): string {
  if (process.platform !== 'darwin') throw new Error('The launchd agent is macOS only.')
  const file = plistPath()
  const logDir = join(args.root, 'logs')
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderPlist({ nodePath: args.nodePath ?? process.execPath, cliPath: args.cliPath, logDir, env: args.env }), { mode: 0o644 })

  if (isLoaded()) launchctl(['bootout', service()])
  const res = launchctl(['bootstrap', domain(), file])
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out.trim()}`)
  return file
}

/** Stop the agent and remove the plist. Safe when it was never installed. */
export function uninstall(): boolean {
  const file = plistPath()
  const wasLoaded = isLoaded()
  if (wasLoaded) launchctl(['bootout', service()])
  const hadFile = existsSync(file)
  rmSync(file, { force: true })
  return wasLoaded || hadFile
}

export interface LaunchdStatus {
  installed: boolean
  loaded: boolean
  pid: number | null
  plist: string
}

export function status(): LaunchdStatus {
  const file = plistPath()
  const printed = launchctl(['print', service()])
  const pid = printed.ok ? /\bpid = (\d+)/.exec(printed.out)?.[1] : undefined
  return { installed: existsSync(file), loaded: printed.ok, pid: pid ? Number(pid) : null, plist: file }
}
