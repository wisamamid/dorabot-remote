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
export function candidateAddresses(port: number, extra: string[] = []): Candidate[] {
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
  const host = hostname()
  const mdns = host.endsWith('.local') ? host : `${host}.local`
  push(`${mdns}:${port}`, 'bonjour', 3)

  return out.sort((a, b) => a.rank - b.rank)
}

export function primaryAddress(port: number, extra: string[] = []): string {
  const c = candidateAddresses(port, extra)
  return c[0]?.address ?? `127.0.0.1:${port}`
}
