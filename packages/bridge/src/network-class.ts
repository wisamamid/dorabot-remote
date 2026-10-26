/**
 * A coarse "which network is this device on" key, for new-network alerts.
 *
 * The bridge cannot see a relayed phone's real address (the relay's CF-Connecting-IP is not forwarded), so a
 * relayed connection is simply 'relay'. A direct connection is classed by where its source address lives:
 * a private LAN by its /24 (so moving between home and office is noticed), Tailscale as one network, anything
 * else by its /16. Deliberately simple: this is a tripwire, not a location service.
 */
export interface NetworkClass {
  key: string
  /** Human label for the notification. Contains no more than the coarse key. */
  label: string
}

export function classifyNetwork(transport: 'relay' | 'direct', remote: string): NetworkClass {
  if (transport === 'relay') return { key: 'relay', label: 'the relay (away from your network)' }
  const addr = remote.replace(/^::ffff:/i, '').replace(/%.*$/, '').toLowerCase()

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])]
    if (a === 127) return { key: 'local', label: 'this Mac' }
    if (a === 100 && b >= 64 && b <= 127) return { key: 'tailscale', label: 'Tailscale' }
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { key: `lan:${a}.${b}.${c}`, label: `LAN ${a}.${b}.${c}.x` }
    if (a === 169 && b === 254) return { key: 'lan:link-local', label: 'a link-local network' }
    return { key: `ip:${a}.${b}`, label: `the internet (${a}.${b}.x.x)` }
  }

  if (addr === '::1') return { key: 'local', label: 'this Mac' }
  if (addr.startsWith('fe80:')) return { key: 'lan6:link-local', label: 'a link-local network' }
  if (addr.startsWith('fd7a:115c:a1e0:')) return { key: 'tailscale', label: 'Tailscale' }
  const groups = addr.split(':').filter((g) => g !== '')
  if (/^f[cd]/.test(addr)) return { key: `lan6:${groups.slice(0, 4).join(':')}`, label: `LAN ${groups.slice(0, 4).join(':')}::/64` }
  if (groups.length >= 3 && addr.includes(':')) return { key: `ip6:${groups.slice(0, 3).join(':')}`, label: `the internet (${groups.slice(0, 3).join(':')}::/48)` }
  return { key: 'unknown', label: 'an unknown network' }
}
