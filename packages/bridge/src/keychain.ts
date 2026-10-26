import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * The bridge's long-term secrets (host identity key, relay signing key, control-page secret) live in the macOS
 * login Keychain instead of files in ~/.dorabot-remote. Only the `security` tool is used, always through
 * execFile with an argument vector (no shell). Values are base64 of the text the file used to hold.
 *
 * Fail-closed rules:
 *  - The file is deleted only after the value was written to the Keychain AND read back identical.
 *  - If the Keychain is unavailable (headless session, locked) the bridge falls back to the files with a
 *    warning, and never invents a replacement for a secret that already lives in the Keychain (a marker file
 *    records that, so a headless start cannot silently mint a new host identity and orphan every pairing).
 *
 * Note: `security add-generic-password -w <value>` puts the value on the command line for a moment. These are
 * local processes of the same user; it is the only non-interactive form the tool offers.
 */
export const KEYCHAIN_SERVICE = 'dorabot-remote'
const SECURITY = '/usr/bin/security'
/** `security` exits 44 when the item does not exist. */
const NOT_FOUND = 44

export type SecurityRunner = (args: string[]) => string

export const defaultSecurityRunner: SecurityRunner = (args) =>
  execFileSync(SECURITY, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })

export interface KeyStore {
  /** The stored base64 value, or null when there is no such item. Throws when the Keychain cannot be used. */
  get(name: string): string | null
  set(name: string, valueB64: string): void
  delete(name: string): void
}

export class KeychainUnavailableError extends Error {}

function reason(err: unknown): string {
  const e = err as { stderr?: unknown; message?: string }
  return String(e?.stderr || e?.message || err).trim().split('\n')[0] || 'security failed'
}

/** Not-found is an answer (null); anything else means the Keychain cannot be used right now. */
function classify(err: unknown): null {
  const e = err as { status?: number; stderr?: unknown }
  if (e?.status === NOT_FOUND) return null
  if (typeof e?.stderr === 'string' && /could not be found/i.test(e.stderr)) return null
  throw new KeychainUnavailableError(reason(err))
}

/** `scope` keeps separate bridge homes (DORABOT_REMOTE_HOME overrides) from sharing one Keychain item. */
export function createKeychainStore(run: SecurityRunner = defaultSecurityRunner, scope = ''): KeyStore {
  const account = (name: string): string => (scope ? `${name}:${scope}` : name)
  return {
    get(name) {
      try {
        const out = run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(name), '-w']).trim()
        return out || null
      } catch (err) {
        return classify(err)
      }
    },
    set(name, valueB64) {
      try {
        run(['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(name), '-w', valueB64, '-U'])
      } catch (err) {
        throw new KeychainUnavailableError(`could not write "${name}": ${reason(err)}`)
      }
    },
    delete(name) {
      try {
        run(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(name)])
      } catch (err) {
        classify(err)
      }
    },
  }
}

/** Real Keychain only on macOS, never under tests, and never if switched off (DORABOT_REMOTE_KEYCHAIN=off). */
export function keychainEnabled(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (platform !== 'darwin') return false
  if (env.VITEST || env.NODE_ENV === 'test') return false
  return (env.DORABOT_REMOTE_KEYCHAIN ?? '').toLowerCase() !== 'off'
}

/** Empty for the default home; a short hash for a custom one. */
export function keychainScope(root: string): string {
  if (root === join(homedir(), '.dorabot-remote')) return ''
  return createHash('sha256').update(root).digest('hex').slice(0, 8)
}

export interface SecretIO {
  store: KeyStore | null
  warn: (msg: string) => void
  /** Overwrite then delete. Injectable for tests. */
  shred: (path: string) => void
}

/** Best-effort secure delete: overwrite with random bytes, flush, unlink. (SSD/APFS cannot promise more.) */
export function shredFile(path: string): void {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r+')
    try {
      writeSync(fd, randomBytes(Math.max(size, 1)))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Still unlink below.
  }
  unlinkSync(path)
}

export function createSecretIO(root: string, warn: (msg: string) => void): SecretIO {
  return {
    store: keychainEnabled() ? createKeychainStore(defaultSecurityRunner, keychainScope(root)) : null,
    warn,
    shred: shredFile,
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8')
const warned = new Set<string>()

export interface SecretSpec {
  /** Keychain account name and marker name, e.g. 'host-identity'. */
  name: string
  /** Where the secret lived before (and lives, when the Keychain cannot be used). */
  file: string
  /** Makes the text to persist for a brand new secret. */
  create: () => string
  /** Is this stored text usable? An unusable one is treated as absent and replaced. */
  valid?: (text: string) => boolean
}

const markerPath = (file: string): string => `${file}.keychain`

function writeFile0600(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Load (or create) one secret. See the file comment for the fail-closed rules. */
export function loadSecret(spec: SecretSpec, io: SecretIO): string {
  const ok = spec.valid ?? (() => true)
  const fileText = existsSync(spec.file) ? readFileSync(spec.file, 'utf8') : null
  const usableFile = fileText !== null && ok(fileText) ? fileText : null

  if (io.store) {
    try {
      const kc = io.store.get(spec.name)
      const kcText = kc !== null ? unb64(kc) : null
      if (kcText !== null && ok(kcText)) {
        if (fileText !== null) {
          if (fileText === kcText) {
            io.shred(spec.file)
            io.warn(`keychain: removed the leftover ${spec.file} (the Keychain holds the same value)`)
          } else {
            io.warn(`keychain: ${spec.file} differs from the Keychain's "${spec.name}"; using the Keychain, leaving the file for you to inspect`)
          }
        }
        if (!existsSync(markerPath(spec.file))) writeFile0600(markerPath(spec.file), '')
        return kcText
      }

      const text = usableFile ?? spec.create()
      io.store.set(spec.name, b64(text))
      if (io.store.get(spec.name) !== b64(text)) {
        try {
          io.store.delete(spec.name)
        } catch {
          // best effort
        }
        throw new KeychainUnavailableError('read-back after write did not match')
      }
      writeFile0600(markerPath(spec.file), '')
      if (fileText !== null) {
        io.shred(spec.file)
        io.warn(`keychain: moved "${spec.name}" into the login Keychain and securely deleted ${spec.file}`)
      } else {
        io.warn(`keychain: created "${spec.name}" in the login Keychain`)
      }
      return text
    } catch (err) {
      const key = `${spec.name}:${(err as Error).message}`
      if (!warned.has(key)) {
        warned.add(key)
        io.warn(`keychain: not usable (${(err as Error).message}); using ${spec.file} instead`)
      }
      // fall through to the file
    }
  }

  if (usableFile !== null) return usableFile
  if (existsSync(markerPath(spec.file))) {
    // This secret was moved into the Keychain. Minting a new one would orphan every pairing.
    throw new Error(
      `"${spec.name}" is stored in the login Keychain, which is not available right now (locked, or no GUI session). ` +
        `Not creating a new one. Unlock the Keychain / run from your login session and try again.`,
    )
  }
  const text = spec.create()
  writeFile0600(spec.file, text)
  return text
}

/** Forget cached warnings (tests). */
export function resetKeychainWarnings(): void {
  warned.clear()
}
