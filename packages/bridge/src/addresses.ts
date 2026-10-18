import { execFileSync } from 'node:child_process'
import { hostname, networkInterfaces } from 'node:os'

export interface Candidate {
  address: string
  label: string
  /** Lower sorts first. The phone tries candidates in this order. */
  rank: number
}

/**
 * Is this a Tailscale address? Tailscale hands out 100.64.0.0/10 (CGNAT space),
 * which is exactly how you tell it apart from an ordinary LAN address.
 */
function isTailscale(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

function isPrivateLan(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(Number.isNaN)) return false
  if (p[0] === 10) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) return true
  return false
}

/**
 * Every address the phone could plausibly reach this machine on, best first.
 *
 * The QR carries all of them and the app races them, which is what makes "same
 * WiFi" and "anywhere over Tailscale" the same code path with no mode switch and
 * no re-pairing when the phone moves between them.
 */
export function candidateAddresses(port: number, extra: string[] = [], bind = '0.0.0.0'): Candidate[] {
  // Bound to one specific interface: only that address is reachable, so
  // advertising LAN IPs or the .local name would send the phone to a closed port.
  if (bind !== '0.0.0.0' && bind !== '::') {
    return [...extra.map((e) => ({ address: e.includes(':') ? e : `${e}:${port}`, label: 'configured', rank: 0 })), { address: `${bind}:${port}`, label: `bound (${bind})`, rank: 1 }]
  }

  const out: Candidate[] = []
  const seen = new Set<string>()

  const push = (address: string, label: string, rank: number): void => {
    if (seen.has(address)) return
    seen.add(address)
    out.push({ address, label, rank })
  }

  // Explicit overrides win: this is where a Tailscale MagicDNS name goes.
  for (const e of extra) {
    const addr = e.includes(':') ? e : `${e}:${port}`
    push(addr, 'configured', 0)
  }

  const ifaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue
      if (a.family !== 'IPv4') continue
      if (isTailscale(a.address)) {
        push(`${a.address}:${port}`, `tailscale (${name})`, 1)
      } else if (isPrivateLan(a.address)) {
        push(`${a.address}:${port}`, `local network (${name})`, 2)
      }
    }
  }

  // mDNS name. Works on iOS once local network permission is granted, and keeps
  // working across DHCP lease changes, so it is a useful fallback even though it
  // resolves more slowly than a bare IP.
  const mdns = mdnsName()
  push(`${mdns}:${port}`, 'bonjour', 3)

  return out.sort((a, b) => a.rank - b.rank)
}

export function primaryAddress(port: number, extra: string[] = [], bind = '0.0.0.0'): string {
  const c = candidateAddresses(port, extra, bind)
  return c[0]?.address ?? `127.0.0.1:${port}`
}

/** The Bonjour name: macOS LocalHostName + .local, else the short hostname. */
export function mdnsName(): string {
  if (process.platform === 'darwin') {
    try {
      const n = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim()
      if (n) return `${n}.local`
    } catch {
      // Fall through.
    }
  }
  const host = hostname()
  if (host.endsWith('.local')) return host
  return `${host.split('.')[0]}.local`
}
