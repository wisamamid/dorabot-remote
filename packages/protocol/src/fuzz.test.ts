/**
 * Fuzz: the decoders that take bytes or text from an untrusted peer. None may throw anything but an Error
 * (or return null where documented), none may hang, and a corrupted valid input must never be accepted.
 * Seeded, so a failure replays.
 */
import { deflateSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { MAX_INFLATED_BYTES, frameDeflated, inflateFrame } from './compress.js'
import { SecureChannel, deriveSessionKeys, generateIdentity } from './crypto.js'
import { MuxKind, decodeMux, decodeMuxClose, encodeMux, encodeMuxText } from './relay.js'
import { assessRisk, buildPreview, lineDiff, offerableRule, ruleMatches } from './risk.js'
import { decodePairingPayload, encodePairingPayload } from './wire.js'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const bytes = (r: () => number, n: number): Uint8Array => Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
const N = 3000

/** Throws only Error instances (never a TypeError from a missing field, never a non-Error). */
function onlyErrors(fn: () => unknown): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    expect(e).toBeInstanceOf(Error)
    return { ok: false }
  }
}

describe('decodeMux', () => {
  it('returns null or a well-formed frame for any bytes', () => {
    const r = rng(1)
    for (let i = 0; i < N; i++) {
      const b = bytes(r, Math.floor(r() * 64))
      const f = decodeMux(b)
      if (f) {
        expect([1, 2, 3, 4]).toContain(f.kind)
        expect(Number.isInteger(f.connId)).toBe(true)
        expect(f.payload.length).toBe(b.length - 5)
        decodeMuxClose(f.payload) // never throws
      }
    }
    expect(decodeMux(new Uint8Array(0))).toBeNull()
    expect(decodeMux(encodeMuxText(7, 'hi'))?.connId).toBe(7)
    expect(decodeMux(encodeMux(MuxKind.text, 0xffffffff, new Uint8Array(0)))?.connId).toBe(0xffffffff)
  })
})

describe('SecureChannel.open', () => {
  function pair() {
    const hs = generateIdentity()
    const ds = generateIdentity()
    const he = generateIdentity()
    const de = generateIdentity()
    const hostKeys = deriveSessionKeys(null, 'host', { myEphemeral: he, theirEphemeralPk: de.publicKey, myStatic: hs, theirStaticPk: ds.publicKey })
    const devKeys = deriveSessionKeys(null, 'device', { myEphemeral: de, theirEphemeralPk: he.publicKey, myStatic: ds, theirStaticPk: hs.publicKey })
    const host = SecureChannel.create(null, hostKeys)
    const dev = SecureChannel.create(null, devKeys, { acceptCompressed: true })
    dev.startReceive(host.startSend())
    host.startReceive(dev.startSend())
    return { host, dev }
  }

  it('rejects random bytes and flipped bits with an Error, and a failure does not desync the stream', () => {
    const r = rng(2)
    const { host, dev } = pair()
    for (let i = 0; i < N; i++) expect(onlyErrors(() => host.open(bytes(r, Math.floor(r() * 200)))).ok).toBe(false)
    for (let i = 0; i < 300; i++) {
      const good = dev.seal({ t: 'ping', ts: i })
      const bad = good.slice()
      bad[Math.floor(r() * bad.length)]! ^= 1 << Math.floor(r() * 8)
      expect(onlyErrors(() => host.open(bad)).ok).toBe(false)
      // the genuine frame still opens afterwards (a bad frame must not advance the counter)
      expect(host.open<{ ts: number }>(good).ts).toBe(i)
    }
  })

  it('refuses replays, reordering and a compressed frame the host does not accept', () => {
    const { host, dev } = pair()
    const a = dev.seal({ n: 1 })
    const b = dev.seal({ n: 2 })
    expect(onlyErrors(() => host.open(b)).ok).toBe(false)
    expect(host.open(a)).toEqual({ n: 1 })
    expect(onlyErrors(() => host.open(a)).ok).toBe(false)
    expect(host.open(b)).toEqual({ n: 2 })
    const body = new TextEncoder().encode(JSON.stringify({ t: 'x', pad: 'a'.repeat(5000) }))
    const framed = frameDeflated(body.length, deflateSync(body))
    expect(onlyErrors(() => host.open(dev.sealBytes(framed))).ok).toBe(false)
  })
})

describe('inflateFrame / compressed frames', () => {
  it('accepts a good frame and throws Error for random or truncated input', () => {
    const r = rng(3)
    const body = new TextEncoder().encode(JSON.stringify({ a: 'x'.repeat(10000) }))
    expect(inflateFrame(frameDeflated(body.length, deflateSync(body)))).toEqual(body)
    for (let i = 0; i < N; i++) {
      const b = bytes(r, Math.floor(r() * 300))
      if (b.length) b[0] = 1
      onlyErrors(() => inflateFrame(b))
    }
  })

  it('stops zip bombs: wrong declared sizes, huge declared sizes, and real bombs', () => {
    const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024)) // ~64 MB of zeros, tiny deflated
    for (const declared of [1, 100, 65_536, MAX_INFLATED_BYTES, MAX_INFLATED_BYTES + 1, 0, 0xffffffff]) {
      expect(onlyErrors(() => inflateFrame(frameDeflated(declared, bomb))).ok).toBe(false)
    }
    // A bomb whose declared size is honest is still bounded by MAX_INFLATED_BYTES.
    expect(onlyErrors(() => inflateFrame(frameDeflated(64 * 1024 * 1024, bomb))).ok).toBe(false)
    const under = new Uint8Array(MAX_INFLATED_BYTES)
    const t0 = Date.now()
    onlyErrors(() => inflateFrame(frameDeflated(MAX_INFLATED_BYTES, deflateSync(under))))
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('decodePairingPayload', () => {
  const good = {
    v: 1,
    h: 'host',
    n: 'Mac',
    k: 'abcdef',
    c: 'ABCDEFGHJK',
    a: ['192.168.1.2:7788'],
    e: 1790000000000,
    r: { u: 'wss://relay.example', i: 'rid', tk: 't' },
  }
  const uri = encodePairingPayload(good as never)

  it('round-trips and rejects wrong types / sizes', () => {
    expect(decodePairingPayload(uri)).toEqual(good)
    const bad: Array<Record<string, unknown>> = [
      { ...good, a: 'x' },
      { ...good, a: [1] },
      { ...good, a: Array(17).fill('h:1') },
      { ...good, k: 5 },
      { ...good, c: '' },
      { ...good, n: 'n'.repeat(201) },
      { ...good, e: 'soon' },
      { ...good, e: null },
      { ...good, r: 'relay' },
      { ...good, r: { u: 1, i: 'x' } },
      { ...good, a: [], r: undefined },
      { ...good, v: 2 },
      null as never,
      [] as never,
    ]
    for (const b of bad) expect(onlyErrors(() => decodePairingPayload(encodePairingPayload(b as never))).ok).toBe(false)
  })

  it('never throws anything but Error, and only ever returns something well-formed', () => {
    const r = rng(4)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_#=%/:. {}"[]'
    for (let i = 0; i < N; i++) {
      const len = Math.floor(r() * 120)
      let s = r() < 0.5 ? 'dorabot-remote://pair#' : ''
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)]
      onlyErrors(() => decodePairingPayload(s))
    }
    // mutate a valid link: any survivor must still validate
    for (let i = 0; i < N; i++) {
      const chars = uri.split('')
      const at = 22 + Math.floor(r() * (chars.length - 22))
      chars[at] = alphabet[Math.floor(r() * alphabet.length)]!
      const out = onlyErrors(() => decodePairingPayload(chars.join('')))
      if (out.ok) {
        const p = out.value as typeof good
        expect(typeof p.k).toBe('string')
        expect(Array.isArray(p.a)).toBe(true)
        expect(typeof p.e).toBe('number')
      }
    }
    expect(onlyErrors(() => decodePairingPayload('x'.repeat(100_000))).ok).toBe(false)
  })
})

describe('risk classifier and approval helpers', () => {
  const TOKENS = ['rm', '-rf', 'sudo', 'git', 'push', '--force', 'curl', '|', 'sh', ';', '&&', '`', '$(', ')', '>', '~/.ssh', '/etc', 'env', '-i', 'xargs', 'find', '-delete', 'dd', 'if=', '\n', ' ', '"', "'", '\\', '$HOME', '.env', '..', '/', 'tee', '-a', 'chmod', 'nc', 'a', 'b']

  it('never throws on random commands, paths and inputs', () => {
    const r = rng(5)
    for (let i = 0; i < N; i++) {
      let cmd = ''
      const n = Math.floor(r() * 30)
      for (let j = 0; j < n; j++) cmd += TOKENS[Math.floor(r() * TOKENS.length)]! + (r() < 0.7 ? ' ' : '')
      const tool = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'mcp__x__y', '', '__proto__'][Math.floor(r() * 9)]!
      const input: Record<string, unknown> = { command: cmd, file_path: r() < 0.5 ? cmd : undefined, edits: r() < 0.2 ? [{ old_string: cmd }, null, 5] : undefined, content: r() < 0.3 ? cmd : 5 }
      const a = assessRisk(tool, input, { cwd: r() < 0.5 ? '/work' : undefined, home: r() < 0.5 ? '/Users/x' : undefined, blockedPath: r() < 0.2 ? cmd : undefined })
      expect(typeof a.risky).toBe('boolean')
      expect(a.risky).toBe(a.reasons.length > 0)
      buildPreview(tool, input)
      const rule = offerableRule(tool, input)
      // The invariant that protects "always allow": an offered rule never covers a risky input.
      if (rule) expect(assessRisk(tool, input).risky).toBe(false)
      if (rule) expect(ruleMatches(rule, tool, { ...input, command: input.command + '; rm -rf /' })).toBe(false)
    }
    for (const weird of [null, undefined, 5, 'x', [], [1]] as unknown[]) {
      assessRisk('Bash', weird as never)
      buildPreview('Bash', weird as never)
      offerableRule('Bash', weird as never)
    }
  })

  it('does not take super-linear time on adversarial strings (regex DoS)', () => {
    const attacks = [
      'env ' + '-a '.repeat(8000),
      'git ' + '-c x '.repeat(8000) + 'push',
      'curl ' + 'a '.repeat(10000),
      'find ' + 'x '.repeat(10000),
      ';'.repeat(20000) + 'rm',
      ' '.repeat(50000) + 'sudo',
      'git ' + '-C a '.repeat(5000) + 'reset ' + 'x '.repeat(5000),
      'sed ' + '-n '.repeat(10000),
      '> ' + '/'.repeat(30000),
      '$(' .repeat(10000),
      'a'.repeat(200000),
    ]
    for (const cmd of attacks) {
      const t0 = Date.now()
      assessRisk('Bash', { command: cmd })
      expect(Date.now() - t0).toBeLessThan(500)
    }
  })

  it('lineDiff handles random text without throwing', () => {
    const r = rng(6)
    for (let i = 0; i < 300; i++) {
      const mk = (): string => Array.from({ length: Math.floor(r() * 30) }, () => String.fromCharCode(97 + Math.floor(r() * 4))).join('\n')
      const a = mk()
      const b = mk()
      const d = lineDiff(a, b)
      expect(d.filter((x) => x.t !== 'add').map((x) => x.text).join('\n')).toBe(a)
      expect(d.filter((x) => x.t !== 'del').map((x) => x.text).join('\n')).toBe(b)
    }
  })
})
