/** T9c: bridge secrets in the login Keychain, with the `security` command mocked. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadIdentity, loadSigningKey, resolvePaths } from './config.js'
import { controlSecretPath, loadControlSecret } from './control-auth.js'
import {
  KEYCHAIN_SERVICE,
  KeychainUnavailableError,
  createKeychainStore,
  keychainEnabled,
  keychainScope,
  loadSecret,
  resetKeychainWarnings,
  shredFile,
  type KeyStore,
  type SecretIO,
  type SecurityRunner,
} from './keychain.js'
import { runUninstall } from './setup.js'

/** An in-memory `security`: same argument shapes, same exit codes for "not found". */
function fakeSecurity(opts: { fail?: (args: string[]) => { status?: number; stderr: string } | null; corruptReads?: boolean } = {}) {
  const items = new Map<string, string>()
  const calls: string[][] = []
  const run: SecurityRunner = (args) => {
    calls.push(args)
    const fail = opts.fail?.(args)
    if (fail) throw Object.assign(new Error('security failed'), fail)
    const verb = args[0]
    const get = (flag: string): string => args[args.indexOf(flag) + 1] ?? ''
    const key = `${get('-s')}|${get('-a')}`
    if (verb === 'add-generic-password') {
      items.set(key, get('-w'))
      return ''
    }
    if (verb === 'find-generic-password') {
      if (!items.has(key)) throw Object.assign(new Error('nf'), { status: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' })
      return `${opts.corruptReads ? 'Zm9v' : items.get(key)}\n`
    }
    if (verb === 'delete-generic-password') {
      if (!items.delete(key)) throw Object.assign(new Error('nf'), { status: 44, stderr: 'could not be found' })
      return ''
    }
    throw new Error(`unexpected security verb ${verb}`)
  }
  return { run, items, calls }
}

let dir: string
const warnings: string[] = []
const shredded: string[] = []
function io(store: KeyStore | null): SecretIO {
  return {
    store,
    warn: (m) => warnings.push(m),
    shred: (p) => {
      shredded.push(p)
      shredFile(p)
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dr-kc-'))
  warnings.length = 0
  shredded.length = 0
  resetKeychainWarnings()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('keychain store (security command)', () => {
  it('uses the documented argument vectors, no shell', () => {
    const f = fakeSecurity()
    const store = createKeychainStore(f.run)
    store.set('host-identity', 'QUJD')
    expect(store.get('host-identity')).toBe('QUJD')
    store.delete('host-identity')
    expect(f.calls).toEqual([
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'host-identity', '-w', 'QUJD', '-U'],
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'host-identity', '-w'],
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'host-identity'],
    ])
  })

  it('not found is null; other failures are "unavailable"', () => {
    expect(createKeychainStore(fakeSecurity().run).get('x')).toBeNull()
    const locked = createKeychainStore(fakeSecurity({ fail: () => ({ status: 36, stderr: 'User interaction is not allowed.' }) }).run)
    expect(() => locked.get('x')).toThrow(KeychainUnavailableError)
    expect(() => locked.set('x', 'QQ==')).toThrow(/could not write/)
  })

  it('scopes the account for a custom home', () => {
    const f = fakeSecurity()
    createKeychainStore(f.run, 'abcd1234').set('signing-key', 'QQ==')
    expect(f.calls[0]).toContain('signing-key:abcd1234')
    expect(keychainScope('/Users/x/.dorabot-remote')).toBe(keychainScope('/Users/x/.dorabot-remote'))
    expect(keychainScope('/tmp/other')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is only enabled on macOS outside tests and when not switched off', () => {
    expect(keychainEnabled({}, 'darwin')).toBe(true)
    expect(keychainEnabled({}, 'linux')).toBe(false)
    expect(keychainEnabled({ VITEST: 'true' }, 'darwin')).toBe(false)
    expect(keychainEnabled({ NODE_ENV: 'test' }, 'darwin')).toBe(false)
    expect(keychainEnabled({ DORABOT_REMOTE_KEYCHAIN: 'off' }, 'darwin')).toBe(false)
    // Running under vitest right now: the real Keychain must never be touched by this suite.
    expect(keychainEnabled()).toBe(false)
  })
})

describe('loadSecret', () => {
  const spec = (file: string) => ({ name: 'host-identity', file, create: () => '{"made":"fresh"}' })

  it('creates a new secret in the Keychain and writes no file', () => {
    const f = fakeSecurity()
    const file = join(dir, 'host-key.json')
    const text = loadSecret(spec(file), io(createKeychainStore(f.run)))
    expect(text).toBe('{"made":"fresh"}')
    expect(existsSync(file)).toBe(false)
    expect(Buffer.from([...f.items.values()][0]!, 'base64').toString()).toBe('{"made":"fresh"}')
    // Second start reads the same value back.
    expect(loadSecret({ ...spec(file), create: () => 'NOT USED' }, io(createKeychainStore(f.run)))).toBe('{"made":"fresh"}')
  })

  it('migrates an existing file: verify read-back, then securely delete the file', () => {
    const f = fakeSecurity()
    const file = join(dir, 'host-key.json')
    writeFileSync(file, '{"old":"identity"}', { mode: 0o600 })
    const text = loadSecret(spec(file), io(createKeychainStore(f.run)))
    expect(text).toBe('{"old":"identity"}')
    expect(existsSync(file)).toBe(false)
    expect(shredded).toEqual([file])
    // The order matters: write, then read back, before anything is deleted.
    expect(f.calls.map((c) => c[0])).toEqual(['find-generic-password', 'add-generic-password', 'find-generic-password'])
    expect(warnings.some((w) => w.includes('securely deleted'))).toBe(true)
    // And it still loads after the file is gone.
    expect(loadSecret(spec(file), io(createKeychainStore(f.run)))).toBe('{"old":"identity"}')
  })

  it('keeps the file when the read-back does not match, and cleans up the bad item', () => {
    const f = fakeSecurity({ corruptReads: true })
    const file = join(dir, 'host-key.json')
    writeFileSync(file, '{"old":"identity"}', { mode: 0o600 })
    const text = loadSecret(spec(file), io(createKeychainStore(f.run)))
    expect(text).toBe('{"old":"identity"}')
    expect(existsSync(file)).toBe(true)
    expect(shredded).toEqual([])
    expect(f.items.size).toBe(0)
    expect(warnings.some((w) => w.includes('using') && w.includes('instead'))).toBe(true)
  })

  const locked = () => fakeSecurity({ fail: () => ({ status: 36, stderr: 'User interaction is not allowed.' }) })

  it('falls back to the file with a warning when the Keychain is unavailable', () => {
    const file = join(dir, 'host-key.json')
    writeFileSync(file, '{"old":"identity"}', { mode: 0o600 })
    expect(loadSecret(spec(file), io(createKeychainStore(locked().run)))).toBe('{"old":"identity"}')
    expect(existsSync(file)).toBe(true)
    expect(warnings.join('\n')).toMatch(/not usable \(User interaction is not allowed\.\)/)
  })

  it('creates a new file (0600) when headless and nothing exists yet', () => {
    const file = join(dir, 'host-key.json')
    expect(loadSecret(spec(file), io(createKeychainStore(locked().run)))).toBe('{"made":"fresh"}')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses to invent a new secret when it was moved to the Keychain and the Keychain is unavailable', () => {
    const f = fakeSecurity()
    const file = join(dir, 'host-key.json')
    loadSecret(spec(file), io(createKeychainStore(f.run))) // now in the Keychain, marker written
    expect(() => loadSecret(spec(file), io(createKeychainStore(locked().run)))).toThrow(/Not creating a new one/)
    expect(existsSync(file)).toBe(false)
  })

  it('with no Keychain at all (non-macOS, tests) it is the plain file behaviour', () => {
    const file = join(dir, 'host-key.json')
    expect(loadSecret(spec(file), io(null))).toBe('{"made":"fresh"}')
    expect(readFileSync(file, 'utf8')).toBe('{"made":"fresh"}')
    expect(loadSecret({ ...spec(file), create: () => 'x' }, io(null))).toBe('{"made":"fresh"}')
    expect(existsSync(`${file}.keychain`)).toBe(false)
  })

  it('removes a leftover identical file, and leaves a differing one alone', () => {
    const f = fakeSecurity()
    const file = join(dir, 'host-key.json')
    loadSecret(spec(file), io(createKeychainStore(f.run)))
    writeFileSync(file, '{"made":"fresh"}')
    loadSecret(spec(file), io(createKeychainStore(f.run)))
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, '{"something":"else"}')
    expect(loadSecret(spec(file), io(createKeychainStore(f.run)))).toBe('{"made":"fresh"}')
    expect(existsSync(file)).toBe(true)
    expect(warnings.some((w) => w.includes('differs'))).toBe(true)
  })

  it('treats an unusable stored value as absent', () => {
    const file = join(dir, 'control-secret')
    writeFileSync(file, 'garbage')
    const text = loadSecret({ name: 'control-secret', file, create: () => 'good', valid: (t) => t === 'good' }, io(null))
    expect(text).toBe('good')
  })
})

describe('the three bridge secrets', () => {
  it('identity, signing key and control secret migrate, survive restarts and leave no files', () => {
    const f = fakeSecurity()
    const paths = resolvePaths({ root: dir, db: join(dir, 'b.db'), identity: join(dir, 'host-key.json'), signingKey: join(dir, 'signing-key.json'), settings: join(dir, 'settings.json') })
    // A pre-Keychain install: all three as files.
    const idBefore = loadIdentity(null, paths, io(null))
    const sigBefore = loadSigningKey(paths, io(null))
    const secretBefore = loadControlSecret(dir, io(null))
    expect(existsSync(paths.identity) && existsSync(paths.signingKey) && existsSync(controlSecretPath(dir))).toBe(true)

    const kc = io(createKeychainStore(f.run))
    const id = loadIdentity(null, paths, kc)
    const sig = loadSigningKey(paths, kc)
    const secret = loadControlSecret(dir, kc)
    expect(Buffer.from(id.privateKey)).toEqual(Buffer.from(idBefore.privateKey))
    expect(Buffer.from(sig.privateKey)).toEqual(Buffer.from(sigBefore.privateKey))
    expect(secret).toBe(secretBefore)
    expect(existsSync(paths.identity) || existsSync(paths.signingKey) || existsSync(controlSecretPath(dir))).toBe(false)
    expect([...f.items.keys()].sort()).toEqual(['dorabot-remote|control-secret', 'dorabot-remote|host-identity', 'dorabot-remote|signing-key'])

    // Next start: from the Keychain alone.
    expect(Buffer.from(loadIdentity(null, paths, kc).privateKey)).toEqual(Buffer.from(idBefore.privateKey))
    expect(loadControlSecret(dir, kc)).toBe(secretBefore)
  })

  it('a fresh install writes straight to the Keychain', () => {
    const f = fakeSecurity()
    const paths = resolvePaths({ root: dir, identity: join(dir, 'host-key.json'), signingKey: join(dir, 'signing-key.json') })
    const kc = io(createKeychainStore(f.run))
    loadIdentity(null, paths, kc)
    loadSigningKey(paths, kc)
    expect(loadControlSecret(dir, kc)).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(paths.identity) || existsSync(paths.signingKey) || existsSync(controlSecretPath(dir))).toBe(false)
    expect(f.items.size).toBe(3)
  })
})

describe('uninstall --purge', () => {
  it('removes the Keychain items too', async () => {
    const f = fakeSecurity()
    const store = createKeychainStore(f.run)
    for (const n of ['host-identity', 'signing-key', 'control-secret']) store.set(n, 'QQ==')
    const log: string[] = []
    const root = join(dir, 'root')
    await runUninstall(
      { paths: resolvePaths({ root }), launchd: { install: () => '', uninstall: () => false, status: () => ({ installed: false, loaded: false }) as never }, log: (l) => log.push(l), keychain: store },
      true,
    )
    expect(f.items.size).toBe(0)
    expect(log.join('\n')).toContain('login Keychain')
  })
})

describe('shredFile', () => {
  it('overwrites and deletes', () => {
    const p = join(dir, 's')
    writeFileSync(p, 'top secret')
    shredFile(p)
    expect(existsSync(p)).toBe(false)
  })
})
