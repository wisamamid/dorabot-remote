/**
 * Readable push content, end-to-end encrypted to the phone.
 *
 * The relay and Apple only ever carry `enc`, an opaque blob. The phone's
 * Notification Service Extension (and the app) decrypt it with a key that never
 * left the phone and this bridge.
 *
 * Format: base64( nonce[12] || ciphertext || tag[16] ) using ChaCha20-Poly1305
 * (IETF, RFC 8439), a 32-byte key and a fresh random nonce per push. The
 * plaintext is UTF-8 JSON: {kind, rid, sessionKey?, title, body}.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from 'node:crypto'

export type ContentKind = 'question' | 'approval'

export interface PushContent {
  kind: ContentKind
  rid: string
  sessionKey?: string
  title: string
  body: string
}

export const PUSH_KEY_BYTES = 32
const NONCE_BYTES = 12
/** enc is capped at 3000 base64 chars by the relay: 2250 raw bytes, minus nonce and tag. */
export const MAX_PLAINTEXT_BYTES = 1800
const MAX_BODY = 180
const MAX_TITLE = 60
const MAX_OPTIONS = 80

const B64_KEY_RE = /^[A-Za-z0-9+/]{43}=?$/

/** Accepts a base64 32-byte key; returns the raw bytes or null. */
export function parsePushKey(b64: unknown): Uint8Array | null {
  if (typeof b64 !== 'string' || !B64_KEY_RE.test(b64)) return null
  const raw = Buffer.from(b64, 'base64')
  return raw.length === PUSH_KEY_BYTES ? new Uint8Array(raw) : null
}

const oneLine = (s: unknown): string => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim()

export function truncate(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`
}

/** `mcp__dorabot-tools__browser` -> `browser` */
export function displayToolName(name: string): string {
  return name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** One line describing what the tool is about to do. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const name = displayToolName(toolName)
  let s = ''
  switch (name) {
    case 'Bash':
      s = str(i.command)
      break
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Read':
      s = str(i.file_path) || str(i.notebook_path) || str(i.path)
      break
    case 'browser': {
      const action = str(i.action)
      const target = str(i.url) || str(i.selector) || str(i.text)
      s = [action, target].filter(Boolean).join(' ')
      break
    }
    case 'WebFetch':
      s = str(i.url)
      break
    default:
      s = str(i.command) || str(i.file_path) || str(i.path) || str(i.url) || str(i.query) || str(i.description)
  }
  return oneLine(s) || name
}

function questionContent(d: Record<string, unknown>): { title: string; body: string } {
  const qs = Array.isArray(d.questions) ? (d.questions as Array<Record<string, unknown>>) : []
  const q = qs[0] ?? {}
  let body = truncate(oneLine(q.question) || 'dorabot has a question', MAX_BODY)
  const opts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>).map((o) => oneLine(o?.label)).filter(Boolean) : []
  if (opts.length) body += `\n${truncate(opts.join(' / '), MAX_OPTIONS)}`
  return { title: 'dorabot asks', body }
}

/** Build the readable content for a gateway event, or null if it is not one we describe. */
export function buildPushContent(name: string, data: unknown, rid: string): PushContent | null {
  const d = (data ?? {}) as Record<string, unknown>
  const sessionKey = typeof d.sessionKey === 'string' && d.sessionKey ? d.sessionKey : undefined
  const base = { rid, ...(sessionKey ? { sessionKey } : {}) }
  switch (name) {
    case 'agent.ask_user':
      return { kind: 'question', ...base, ...questionContent(d) }
    case 'agent.elicitation':
      return { kind: 'question', ...base, title: 'dorabot asks', body: truncate(oneLine(d.message) || 'dorabot needs your input', MAX_BODY) }
    case 'agent.tool_approval': {
      const toolName = typeof d.toolName === 'string' && d.toolName ? d.toolName : 'tool'
      return {
        kind: 'approval',
        ...base,
        title: truncate(`Approve ${displayToolName(toolName)}?`, MAX_TITLE),
        body: truncate(summarizeToolInput(toolName, d.input as Record<string, unknown> | undefined), MAX_BODY),
      }
    }
    default:
      return null
  }
}

/** base64(nonce || ciphertext || tag). `nonce` is injectable for tests only. */
export function encryptPushContent(content: PushContent, key: Uint8Array, nonce: Uint8Array = new Uint8Array(randomBytes(NONCE_BYTES))): string {
  let c = content
  let plain = new TextEncoder().encode(JSON.stringify(c))
  // Multi-byte text can exceed the byte budget even within the character caps.
  while (plain.length > MAX_PLAINTEXT_BYTES && c.body.length > 1) {
    c = { ...c, body: truncate(c.body, Math.floor(Array.from(c.body).length * 0.8)) }
    plain = new TextEncoder().encode(JSON.stringify(c))
  }
  const ct = chacha20poly1305(key, nonce).encrypt(plain)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce, 0)
  out.set(ct, nonce.length)
  return Buffer.from(out).toString('base64')
}

export function decryptPushContent(enc: string, key: Uint8Array): PushContent | null {
  try {
    const raw = new Uint8Array(Buffer.from(enc, 'base64'))
    const plain = chacha20poly1305(key, raw.subarray(0, NONCE_BYTES)).decrypt(raw.subarray(NONCE_BYTES))
    return JSON.parse(new TextDecoder().decode(plain)) as PushContent
  } catch {
    return null
  }
}
