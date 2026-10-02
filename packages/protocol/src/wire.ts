/**
 * Frames on the phone <-> bridge socket.
 *
 * Handshake frames travel as JSON text. Everything after the handshake is a
 * binary secretstream frame whose plaintext is one of the Envelope types below.
 */

export const DEFAULT_BRIDGE_PORT = 7788

// ---------------------------------------------------------------------------
// Handshake (plaintext JSON text frames)
// ---------------------------------------------------------------------------

export interface HelloFrame {
  t: 'hello'
  v: number
  deviceId: string
  /** base64url X25519 ephemeral public key */
  ephPk: string
}

export interface HelloAckFrame {
  t: 'hello_ack'
  v: number
  ephPk: string
  hostId: string
  hostName: string
}

/** Each side's secretstream header, sent once, right after hello/hello_ack. */
export interface HeaderFrame {
  t: 'hdr'
  hdr: string
}

export interface HandshakeErrorFrame {
  t: 'err'
  code: 'bad_version' | 'unknown_device' | 'revoked' | 'bad_handshake' | 'rate_limited' | 'internal'
  message: string
}

/** Pairing happens on its own short-lived connection. */
export interface PairFrame {
  t: 'pair'
  v: number
  /** sealed-box(PairingRequest) to the host public key from the QR, base64url */
  sealed: string
}

export interface PairOkFrame {
  t: 'pair_ok'
  v: number
  /** sealed-box(PairingResponse) to the device public key, base64url */
  sealed: string
}

export type HandshakeFrame =
  | HelloFrame
  | HelloAckFrame
  | HeaderFrame
  | HandshakeErrorFrame
  | PairFrame
  | PairOkFrame

// ---------------------------------------------------------------------------
// Encrypted envelopes
// ---------------------------------------------------------------------------

export interface RpcEnvelope {
  t: 'rpc'
  id: number
  method: string
  params?: unknown
}

export interface RpcResultEnvelope {
  t: 'rpc_res'
  id: number
  result?: unknown
  error?: { message: string; code?: string }
}

export interface EventEnvelope {
  t: 'event'
  event: string
  data: unknown
  /** Bridge-assigned monotonic cursor, used for gap-free resume. */
  seq?: number
  /** Present when the event belongs to one session. */
  sessionKey?: string
}

export interface PingEnvelope {
  t: 'ping'
  ts: number
}

export interface PongEnvelope {
  t: 'pong'
  ts: number
}

/** First encrypted frame from the device. Proves the handshake agreed. */
export interface AuthEnvelope {
  t: 'auth'
  /** Resume point: highest bridge seq the device already has. */
  lastSeq?: number
  clientVersion?: string
}

export interface ReadyEnvelope {
  t: 'ready'
  device: DeviceSummary
  host: HostSummary
  /** Methods this device may call. */
  allowed: string[]
  /** Current bridge cursor. */
  seq: number
  /** Whether the bridge currently holds a live connection to the dorabot gateway. */
  gatewayConnected: boolean
}

export type Envelope =
  | RpcEnvelope
  | RpcResultEnvelope
  | EventEnvelope
  | PingEnvelope
  | PongEnvelope
  | AuthEnvelope
  | ReadyEnvelope

// ---------------------------------------------------------------------------
// Devices and scopes
// ---------------------------------------------------------------------------

/**
 * Scopes are coarse on purpose: each maps to a set of gateway RPC methods.
 * `terminal` is never granted at pairing time; see SCOPE_DEFAULTS.
 */
export const SCOPES = ['sessions', 'chat', 'approvals', 'work', 'files', 'git', 'terminal', 'admin'] as const
export type Scope = (typeof SCOPES)[number]

/** What a freshly paired device gets. Terminal, files, git and admin stay off. */
export const SCOPE_DEFAULTS: Scope[] = ['sessions', 'chat', 'approvals', 'work']

export const SCOPE_LABELS: Record<Scope, string> = {
  sessions: 'Sessions',
  chat: 'Chat',
  approvals: 'Approvals',
  work: 'Tasks & projects',
  files: 'File browsing',
  git: 'Git',
  terminal: 'Terminal',
  admin: 'Settings & devices',
}

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  sessions: 'List, open, rename, fork and abort sessions.',
  chat: 'Send prompts and images, read history, answer questions.',
  approvals: 'Approve or deny tool calls the agent is waiting on.',
  work: 'Read and edit tasks, projects, research and the schedule.',
  files: 'Browse and read files on the host machine.',
  git: 'Read git status and diffs, stage, commit and push.',
  terminal: 'Open a real shell on the host machine. Full control.',
  admin: 'Change dorabot settings and manage paired devices.',
}

export interface DeviceSummary {
  id: string
  name: string
  platform: string
  scopes: Scope[]
  createdAt: number
  lastSeenAt: number | null
  revoked: boolean
  fingerprint: string
}

export interface HostSummary {
  id: string
  name: string
  fingerprint: string
  version: string
  dorabotVersion?: string
}

// ---------------------------------------------------------------------------
// QR payload
// ---------------------------------------------------------------------------

export interface PairingPayload {
  v: number
  /** host id */
  h: string
  /** host display name */
  n: string
  /** host long-term public key, base64url */
  k: string
  /** single-use pairing code */
  c: string
  /** candidate "host:port" addresses, most-local first */
  a: string[]
  /** expiry, unix ms */
  e: number
}

export const PAIRING_URL_SCHEME = 'dorabot-remote://pair'

export function encodePairingPayload(p: PairingPayload): string {
  const json = JSON.stringify(p)
  const b64 = base64UrlEncode(new TextEncoder().encode(json))
  return `${PAIRING_URL_SCHEME}#${b64}`
}

export function decodePairingPayload(input: string): PairingPayload {
  let b64 = input.trim()
  const hash = b64.indexOf('#')
  if (hash >= 0) b64 = b64.slice(hash + 1)
  const json = new TextDecoder().decode(base64UrlDecode(b64))
  const parsed = JSON.parse(json) as PairingPayload
  if (parsed.v !== 1) throw new Error(`Unsupported pairing code version ${parsed.v}`)
  if (!parsed.k || !parsed.c || !Array.isArray(parsed.a) || parsed.a.length === 0) {
    throw new Error('Pairing code is missing required fields')
  }
  return parsed
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

function base64UrlDecode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}
