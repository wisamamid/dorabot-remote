/**
 * Connection diagnostics: a small persisted ring buffer of connection events, so a
 * failed connect outside the house can be explained afterwards.
 *
 * Only connection facts go in here (states, transports, addresses, close codes,
 * timings). Never message content, keys or tokens: callers pass short fixed-shape
 * strings and relay ids are truncated before they get here.
 */
import { storage } from './platform.js'

export const CONNLOG_KEY = 'dorabot-remote.connlog.v1'
export const CONNLOG_MAX = 300

export interface LogEntry {
  /** epoch ms */
  t: number
  /** short category: client, state, transport, net, app, rpc */
  k: string
  m: string
}

/** Facts shown at the top of the log screen. */
export interface ConnMeta {
  relayUrl?: string
  relayId?: string
  lan?: string[]
  netType?: string
  netConnected?: boolean
  transport?: string | null
}

type Listener = () => void

let entries: LogEntry[] = []
let meta: ConnMeta = {}
let version = 0
const listeners = new Set<Listener>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let loaded = false

function emit(): void {
  version += 1
  for (const l of listeners) l()
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushConnLog()
  }, 1000)
}

export async function flushConnLog(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    await storage.set(CONNLOG_KEY, JSON.stringify(entries))
  } catch {
    // Diagnostics must never break the app.
  }
}

/** Load the previous run's entries (once), keeping anything logged since launch after them. */
export async function loadConnLog(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = await storage.get(CONNLOG_KEY)
    if (!raw) return
    const old = JSON.parse(raw) as LogEntry[]
    if (!Array.isArray(old)) return
    const clean = old.filter((e) => e && typeof e.t === 'number' && typeof e.m === 'string')
    entries = [...clean, ...entries].slice(-CONNLOG_MAX)
    emit()
  } catch {
    // Corrupt or unavailable: start fresh.
  }
}

export function connLog(kind: string, msg: string): void {
  entries.push({ t: Date.now(), k: kind, m: msg.slice(0, 300) })
  if (entries.length > CONNLOG_MAX) entries = entries.slice(-CONNLOG_MAX)
  emit()
  scheduleSave()
}

export function clearConnLog(): void {
  entries = []
  emit()
  void flushConnLog()
}

export function setConnMeta(patch: Partial<ConnMeta>): void {
  meta = { ...meta, ...patch }
  emit()
}

export function getEntries(): LogEntry[] {
  return entries
}

export function getMeta(): ConnMeta {
  return meta
}

export function subscribeConnLog(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getConnLogVersion(): number {
  return version
}

/** Plain-text rendering, newest first, for the Copy button. */
export function formatConnLog(list: LogEntry[] = entries, m: ConnMeta = meta): string {
  const head = [
    `net: ${m.netType ?? '?'}${m.netConnected === false ? ' (offline)' : ''}`,
    `transport: ${m.transport ?? 'none'}`,
    `relay: ${m.relayUrl ? `${m.relayUrl} id=${m.relayId ?? '?'}` : 'none held'}`,
    `lan: ${m.lan && m.lan.length ? m.lan.join(', ') : 'none'}`,
  ]
  const lines = [...list].reverse().map((e) => `${fmtTime(e.t)} [${e.k}] ${e.m}`)
  return [...head, '', ...lines].join('\n')
}

export function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Clipboard with a fallback for WebViews where navigator.clipboard is missing or denied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Test seam. */
export function resetConnLogForTests(): void {
  entries = []
  meta = {}
  loaded = false
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}
