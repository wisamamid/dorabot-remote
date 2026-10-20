import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { generateSigningKey, relayIdFromPublicKey } from '@dorabot-remote/protocol'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPushContent, decryptPushContent, displayToolName, encryptPushContent, parsePushKey, pushKeyId, summarizeToolInput } from './push-content.js'
import { PushNotifier } from './push.js'
import { Store } from './store.js'

const KEY = new Uint8Array(32).map((_, i) => i + 1)
const KEY_B64 = Buffer.from(KEY).toString('base64')
const TOKEN = 'ab'.repeat(32)

describe('buildPushContent', () => {
  it('question: first question, truncated, with options', () => {
    const c = buildPushContent(
      'agent.ask_user',
      { requestId: 'q1', sessionKey: 'telegram:dm:1', questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }, { question: 'second' }] },
      'q1',
    )!
    expect(c).toEqual({ kind: 'question', rid: 'q1', sessionKey: 'telegram:dm:1', title: 'dorabot asks', body: 'Which DB?\nPostgres / SQLite' })
    const long = buildPushContent('agent.ask_user', { questions: [{ question: 'x'.repeat(500), options: [] }] }, 'q')!
    expect(Array.from(long.body).length).toBe(180)
    expect(long.body.endsWith('…')).toBe(true)
  })

  it('approval: tool-specific one-line summary', () => {
    const t = (toolName: string, input: Record<string, unknown>) => buildPushContent('agent.tool_approval', { toolName, input }, 'a1')!
    expect(t('Bash', { command: 'rm -rf\n  build' })).toMatchObject({ kind: 'approval', title: 'Approve Bash?', body: 'rm -rf build' })
    expect(t('Write', { file_path: '/a/b.ts', content: 'secret' }).body).toBe('/a/b.ts')
    expect(t('Edit', { file_path: '/a/c.ts' }).body).toBe('/a/c.ts')
    expect(t('mcp__dorabot-tools__browser', { action: 'navigate', url: 'https://x.test' })).toMatchObject({ title: 'Approve browser?', body: 'navigate https://x.test' })
    expect(t('Weird', {}).body).toBe('Weird')
    expect(displayToolName('mcp__a__b__c')).toBe('b__c')
    expect(summarizeToolInput('Bash', undefined)).toBe('Bash')
  })

  it('elicitation uses its message; other events are not described', () => {
    expect(buildPushContent('agent.elicitation', { message: 'Enter token', sessionKey: 's' }, 'e1')).toMatchObject({ kind: 'question', body: 'Enter token' })
    expect(buildPushContent('agent.result', {}, 'r')).toBeNull()
  })
})

describe('encryption', () => {
  it('round-trips with @noble and the documented layout', () => {
    const content = buildPushContent('agent.tool_approval', { toolName: 'Bash', input: { command: 'ls' }, sessionKey: 'k' }, 'a1')!
    const nonce = new Uint8Array(12).fill(7)
    const enc = encryptPushContent(content, KEY, nonce)
    const raw = new Uint8Array(Buffer.from(enc, 'base64'))
    expect(Array.from(raw.subarray(0, 12))).toEqual(Array.from(nonce))
    const plain = chacha20poly1305(KEY, raw.subarray(0, 12)).decrypt(raw.subarray(12))
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(content)
    expect(raw.length).toBe(12 + plain.length + 16)
    expect(decryptPushContent(enc, KEY)).toEqual(content)
    expect(decryptPushContent(enc, new Uint8Array(32))).toBeNull()
  })

  it('uses a fresh nonce each time and stays under the enc budget for worst-case text', () => {
    const c = buildPushContent('agent.ask_user', { sessionKey: 's'.repeat(300), questions: [{ question: '\u{1F600}'.repeat(400), options: [{ label: '中'.repeat(100) }] }] }, 'r'.repeat(128))!
    const a = encryptPushContent(c, KEY)
    expect(a).not.toBe(encryptPushContent(c, KEY))
    expect(a.length).toBeLessThanOrEqual(3000)
  })

  it('parsePushKey', () => {
    expect(parsePushKey(KEY_B64)).toEqual(KEY)
    expect(parsePushKey('short')).toBeNull()
    expect(parsePushKey(undefined)).toBeNull()
    expect(parsePushKey(Buffer.alloc(31).toString('base64'))).toBeNull()
  })
})

describe('PushNotifier with a push key', () => {
  const key = generateSigningKey()
  const relayId = relayIdFromPublicKey(key.publicKey)
  function setup() {
    const store = new Store(':memory:')
    const calls: Array<Record<string, unknown>> = []
    const logs: string[] = []
    const n = new PushNotifier({
      store,
      relay: { url: 'wss://relay.test/', id: relayId },
      signingKey: key,
      isConnected: () => false,
      log: (m) => logs.push(m),
      fetch: (async (_u: string, init: RequestInit) => {
        calls.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)))
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    const d = store.createDevice({ name: 'Phone', platform: 'ios', publicKey: 'pk', scopes: ['approvals'] as never })
    return { store, calls, logs, n, d }
  }

  it('sends enc for a keyed iOS device and contentless otherwise', async () => {
    const s = setup()
    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', KEY_B64)
    await Promise.all(s.n.onGatewayEvent('agent.ask_user', { requestId: 'q1', questions: [{ question: 'Proceed?', options: [] }] }))
    expect(s.calls[0]!.enc).toEqual(expect.any(String))
    expect(decryptPushContent(s.calls[0]!.enc as string, KEY)).toMatchObject({ kind: 'question', rid: 'q1', body: 'Proceed?' })
    expect(JSON.stringify(s.logs)).not.toContain(KEY_B64)
    expect(JSON.stringify(s.logs)).not.toContain(String(s.calls[0]!.enc))

    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', null)
    await Promise.all(s.n.onGatewayEvent('agent.ask_user', { requestId: 'q2', questions: [{ question: 'x' }] }))
    expect(s.calls[1]!.enc).toBeUndefined()
  })

  it('includes hostId/hostName in the encrypted content and a kid beside enc', async () => {
    const store = new Store(':memory:')
    const calls: Array<Record<string, unknown>> = []
    const n = new PushNotifier({
      store,
      relay: { url: 'wss://relay.test/', id: relayId },
      signingKey: key,
      host: { id: 'host-abc', name: 'Studio Mac' },
      isConnected: () => false,
      log: () => {},
      fetch: (async (_u: string, init: RequestInit) => {
        calls.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)))
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    const d = store.createDevice({ name: 'Phone', platform: 'ios', publicKey: 'pk', scopes: ['approvals'] as never })
    store.setPushToken(d.id, TOKEN, 'ios', 'production', KEY_B64)
    await Promise.all(n.onGatewayEvent('agent.ask_user', { requestId: 'q1', questions: [{ question: 'Go?' }] }))
    expect(decryptPushContent(calls[0]!.enc as string, KEY)).toMatchObject({ hostId: 'host-abc', hostName: 'Studio Mac' })
    expect(calls[0]!.kid).toBe(pushKeyId('host-abc'))
    expect(String(calls[0]!.kid)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('pushKeyId is the first 8 hex of sha256(hostId)', () => {
    // sha256("host-abc") fixed vector, shared with the mobile and Swift implementations.
    expect(pushKeyId('host-abc')).toBe(createHash('sha256').update('host-abc').digest('hex').slice(0, 8))
    expect(pushKeyId('host-abc')).toBe('dcf4a872')
    expect(pushKeyId('a')).toBe('ca978112')
  })

  it('result pushes carry no enc even for keyed devices', async () => {
    const s = setup()
    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', KEY_B64)
    s.store.setPushOnResult(s.d.id, true)
    await Promise.all(s.n.onGatewayEvent('agent.result', { sessionKey: 'k' }))
    expect(s.calls[0]!.kind).toBe('result')
    expect(s.calls[0]!.enc).toBeUndefined()
  })

  it('drops the key on rotation, token clear and revoke', () => {
    const s = setup()
    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', KEY_B64)
    expect(s.store.getDevice(s.d.id)!.pushKey).toBe(KEY_B64)
    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', Buffer.alloc(32, 9).toString('base64'))
    expect(s.store.getDevice(s.d.id)!.pushKey).toBe(Buffer.alloc(32, 9).toString('base64'))
    s.store.clearPushTokenIf(s.d.id, TOKEN)
    expect(s.store.getDevice(s.d.id)!.pushKey).toBeNull()
    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', KEY_B64)
    s.store.setRevoked(s.d.id, true)
    expect(s.store.getDevice(s.d.id)!.pushKey).toBeNull()
    s.store.setPushToken(s.d.id, TOKEN, 'ios', 'production', KEY_B64)
    s.store.setPushToken(s.d.id, null, null)
    expect(s.store.getDevice(s.d.id)!.pushKey).toBeNull()
  })
})
