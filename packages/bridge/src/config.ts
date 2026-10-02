import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_BRIDGE_PORT, identityFromB64, identityToB64, generateIdentity } from '@dorabot-remote/protocol'
import type { KeyPair, Sodium } from '@dorabot-remote/protocol'

export const BRIDGE_VERSION = '0.1.0'

export interface BridgePaths {
  root: string
  db: string
  identity: string
  settings: string
  /** dorabot's own files, which we only ever read. */
  dorabotRoot: string
  gatewaySocket: string
  gatewayToken: string
}

export function resolvePaths(overrides: Partial<BridgePaths> = {}): BridgePaths {
  const home = homedir()
  const root = overrides.root ?? process.env.DORABOT_REMOTE_HOME ?? join(home, '.dorabot-remote')
  const dorabotRoot = overrides.dorabotRoot ?? process.env.DORABOT_HOME ?? join(home, '.dorabot')
  return {
    root,
    db: overrides.db ?? join(root, 'bridge.db'),
    identity: overrides.identity ?? join(root, 'host-key.json'),
    settings: overrides.settings ?? join(root, 'settings.json'),
    dorabotRoot,
    gatewaySocket: overrides.gatewaySocket ?? join(dorabotRoot, 'gateway.sock'),
    gatewayToken: overrides.gatewayToken ?? join(dorabotRoot, 'gateway-token'),
  }
}

export interface BridgeSettings {
  hostId: string
  hostName: string
  port: number
  /** Bind address. 0.0.0.0 so Tailscale and LAN interfaces both work. */
  bind: string
  /** How long a pairing code stays valid, ms. */
  pairingTtlMs: number
  /** How long the bridge keeps session events for offline resume, ms. */
  eventRetentionMs: number
  /** Extra hostnames or IPs to advertise in the QR, e.g. a Tailscale MagicDNS name. */
  extraAddresses: string[]
}

const DEFAULT_SETTINGS = (): BridgeSettings => ({
  hostId: randomUUID(),
  hostName: hostname().replace(/\.local$/, ''),
  port: DEFAULT_BRIDGE_PORT,
  bind: '0.0.0.0',
  pairingTtlMs: 5 * 60 * 1000,
  // The gateway deletes its own stream_events 10 minutes after a run ends, so the
  // bridge keeps its own copy. A week is enough to catch up after a trip.
  eventRetentionMs: 7 * 24 * 60 * 60 * 1000,
  extraAddresses: [],
})

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

export function loadSettings(paths: BridgePaths): BridgeSettings {
  ensureDir(paths.settings)
  if (!existsSync(paths.settings)) {
    const fresh = DEFAULT_SETTINGS()
    writeFileSync(paths.settings, JSON.stringify(fresh, null, 2), { mode: 0o600 })
    return fresh
  }
  const parsed = JSON.parse(readFileSync(paths.settings, 'utf8')) as Partial<BridgeSettings>
  return { ...DEFAULT_SETTINGS(), ...parsed }
}

export function saveSettings(paths: BridgePaths, settings: BridgeSettings): void {
  ensureDir(paths.settings)
  writeFileSync(paths.settings, JSON.stringify(settings, null, 2), { mode: 0o600 })
}

/**
 * Load the host's long-term X25519 identity, creating it on first run.
 * This key is what the QR advertises and what every paired device authenticates
 * against, so it must survive restarts and must not leave the machine.
 */
export function loadIdentity(_sodium: Sodium | null, paths: BridgePaths): KeyPair {
  ensureDir(paths.identity)
  if (!existsSync(paths.identity)) {
    const kp = generateIdentity()
    writeFileSync(paths.identity, JSON.stringify(identityToB64(null, kp), null, 2), { mode: 0o600 })
    return kp
  }
  const raw = JSON.parse(readFileSync(paths.identity, 'utf8')) as { publicKey: string; privateKey: string }
  return identityFromB64(null, raw)
}

/**
 * The dorabot gateway's bearer token. The bridge is the only thing that ever holds
 * it; it is never sent to a device, and never written anywhere by us.
 */
export function readGatewayToken(paths: BridgePaths): string {
  if (!existsSync(paths.gatewayToken)) {
    throw new Error(
      `No dorabot gateway token at ${paths.gatewayToken}. Start dorabot at least once, then run this again.`,
    )
  }
  return readFileSync(paths.gatewayToken, 'utf8').trim()
}

export function readDorabotVersion(paths: BridgePaths): string | undefined {
  for (const candidate of [
    '/Applications/dorabot.app/Contents/Resources/app.asar.unpacked/package.json',
    join(paths.dorabotRoot, 'version'),
  ]) {
    try {
      if (!existsSync(candidate)) continue
      const text = readFileSync(candidate, 'utf8')
      if (candidate.endsWith('.json')) return (JSON.parse(text) as { version?: string }).version
      return text.trim()
    } catch {
      // Version is cosmetic; never fail startup over it.
    }
  }
  return undefined
}
