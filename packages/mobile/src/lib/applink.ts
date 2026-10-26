/**
 * `dorabot-remote://ask?prompt=...&host=...&n=...` and `dorabot-remote://inbox?n=...`,
 * handed over by the App Intents (Siri / Shortcuts, ios/App/App/DorabotIntents.swift).
 * Parsing, a small expiring queue, and the pure "what next" decision for a queued
 * ask. The React layer (App.tsx) executes the steps.
 */
import type { ImageAttachment } from '@dorabot-remote/protocol'
import { displayName, type HostPairing } from './hosts.js'

export const MAX_PROMPT = 8000
export const MAX_HOST_NAME = 80
/** A queued request older than this is dropped rather than firing out of the blue. */
export const ASK_TTL_MS = 2 * 60_000

export type AppLink =
  /** `images` only ever comes from the Share Extension (never from a URL); `prompt` may then be empty. */
  | { type: 'ask'; prompt: string; host?: string; nonce?: string; images?: ImageAttachment[] }
  | { type: 'inbox'; nonce?: string }

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** `dorabot-remote://share?id=<uuid>` from the Share Extension: the id of the share waiting in the App Group, or null. */
export function parseShareLink(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'dorabot-remote:' || u.hostname.toLowerCase() !== 'share') return null
    const id = u.searchParams.get('id') ?? ''
    return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** Null for anything that is not a well-formed ask / inbox link (pair links and junk included). */
export function parseAppLink(url: string): AppLink | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'dorabot-remote:') return null
  const nonceRaw = u.searchParams.get('n')
  const nonce = nonceRaw && /^[A-Za-z0-9-]{1,64}$/.test(nonceRaw) ? nonceRaw : undefined
  const target = u.hostname.toLowerCase()
  if (target === 'inbox') return { type: 'inbox', ...(nonce ? { nonce } : {}) }
  if (target === 'ask') {
    const prompt = (u.searchParams.get('prompt') ?? '').replace(CONTROL, '').trim()
    if (!prompt || prompt.length > MAX_PROMPT) return null
    const hostRaw = (u.searchParams.get('host') ?? '').replace(CONTROL, '').trim()
    if (hostRaw.length > MAX_HOST_NAME) return null
    return { type: 'ask', prompt, ...(hostRaw ? { host: hostRaw } : {}), ...(nonce ? { nonce } : {}) }
  }
  return null
}

export interface QueuedLink {
  link: AppLink
  at: number
}

/** FIFO of pending links. Replays of the same nonce (cold-launch URL seen twice) are ignored. */
export class AppLinkQueue {
  private items: QueuedLink[] = []
  private seen: string[] = []

  constructor(private readonly max = 3) {}

  push(link: AppLink, now: number): boolean {
    if (link.nonce) {
      if (this.seen.includes(link.nonce)) return false
      this.seen.push(link.nonce)
      if (this.seen.length > 50) this.seen.shift()
    }
    this.items.push({ link, at: now })
    if (this.items.length > this.max) this.items.shift()
    return true
  }

  peek(): QueuedLink | null {
    return this.items[0] ?? null
  }

  shift(): QueuedLink | null {
    return this.items.shift() ?? null
  }

  get size(): number {
    return this.items.length
  }
}

type HostRef = Pick<HostPairing, 'hostId' | 'hostName' | 'alias'>

/** Exact (case-insensitive) match on nickname or Mac name, else a unique prefix / substring match. */
export function resolveHost(hosts: readonly HostRef[], requested: string): HostRef | null {
  const q = requested.trim().toLowerCase()
  if (!q) return null
  const names = (h: HostRef): string[] => [displayName(h), h.hostName].map((n) => n.toLowerCase())
  const exact = hosts.filter((h) => names(h).includes(q))
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null
  const loose = hosts.filter((h) => names(h).some((n) => n.startsWith(q) || n.includes(q)))
  return loose.length === 1 ? loose[0]! : null
}

export interface AskStepInput {
  prompt: string
  host?: string
  at: number
  now: number
  /** The connection layer has finished restoring pairings. */
  ready: boolean
  hosts: readonly HostRef[]
  activeHostId: string | null
  connState: string
  hasChatScope: boolean
  appLocked: boolean
  /** The user tapped Send on the confirmation sheet for this request. Unlocking the app is NOT consent. */
  confirmed: boolean
}

export type AskStep =
  | { do: 'wait' }
  | { do: 'drop'; message: string }
  | { do: 'confirm'; hostId: string; hostName: string }
  | { do: 'switch'; hostId: string }
  | { do: 'send'; hostId: string }

/** What to do next for the queued ask at the head of the queue. Re-evaluated on every relevant state change. */
export function nextAskStep(i: AskStepInput): AskStep {
  if (!i.ready) return { do: 'wait' }
  if (!i.confirmed && i.now - i.at > ASK_TTL_MS) return { do: 'drop', message: 'That request expired before dorabot was ready.' }
  if (i.hosts.length === 0) return { do: 'drop', message: 'Pair a Mac first, then try again.' }
  // The lock screen asks for Face ID by itself; nothing runs behind it.
  if (i.appLocked) return { do: 'wait' }
  let target: HostRef | null
  if (i.host) {
    target = resolveHost(i.hosts, i.host)
    if (!target) return { do: 'drop', message: `No paired Mac matches "${i.host}".` }
  } else {
    target = i.hosts.find((h) => h.hostId === i.activeHostId) ?? i.hosts[0] ?? null
  }
  if (!target) return { do: 'drop', message: 'Pair a Mac first, then try again.' }
  // Nothing is sent, and no Mac is switched to, until the user has seen the full prompt and tapped Send.
  if (!i.confirmed) return { do: 'confirm', hostId: target.hostId, hostName: displayName(target) }
  if (target.hostId !== i.activeHostId) return { do: 'switch', hostId: target.hostId }
  if (i.connState !== 'ready') return { do: 'wait' }
  if (!i.hasChatScope) return { do: 'drop', message: 'This phone is not allowed to start chats on that Mac.' }
  return { do: 'send', hostId: target.hostId }
}
