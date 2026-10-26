/** T9b: a device connecting from a network it has not used before is audited and notified. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyNetwork } from './network-class.js'
import { Store } from './store.js'
import { startHarness, type Harness } from '../test/harness.js'

describe('classifyNetwork', () => {
  it('relay is one network', () => {
    expect(classifyNetwork('relay', 'anything').key).toBe('relay')
  })
  it('private LANs are keyed by /24', () => {
    expect(classifyNetwork('direct', '192.168.1.23').key).toBe('lan:192.168.1')
    expect(classifyNetwork('direct', '::ffff:192.168.1.99').key).toBe('lan:192.168.1')
    expect(classifyNetwork('direct', '192.168.2.23').key).toBe('lan:192.168.2')
    expect(classifyNetwork('direct', '10.4.5.6').key).toBe('lan:10.4.5')
    expect(classifyNetwork('direct', '172.20.0.9').key).toBe('lan:172.20.0')
    expect(classifyNetwork('direct', '172.32.0.9').key).toBe('ip:172.32')
  })
  it('tailscale, loopback, link-local and public', () => {
    expect(classifyNetwork('direct', '100.101.102.103').key).toBe('tailscale')
    expect(classifyNetwork('direct', 'fd7a:115c:a1e0::1').key).toBe('tailscale')
    expect(classifyNetwork('direct', '127.0.0.1').key).toBe('local')
    expect(classifyNetwork('direct', '::1').key).toBe('local')
    expect(classifyNetwork('direct', '169.254.3.4').key).toBe('lan:link-local')
    expect(classifyNetwork('direct', 'fe80::1%en0').key).toBe('lan6:link-local')
    expect(classifyNetwork('direct', '8.8.4.4').key).toBe('ip:8.8')
    expect(classifyNetwork('direct', '2001:db8:1234:5678::1').key).toBe('ip6:2001:db8:1234')
    expect(classifyNetwork('direct', 'garbage').key).toBe('unknown')
  })
  it('labels never contain a full address', () => {
    expect(classifyNetwork('direct', '192.168.1.23').label).toBe('LAN 192.168.1.x')
    expect(classifyNetwork('direct', '8.8.4.4').label).not.toContain('8.8.4.4')
  })
})

describe('store.recordNetwork', () => {
  it('baseline, then new, then known', () => {
    const s = new Store(':memory:')
    const d = s.createDevice({ name: 'p', platform: 'ios', publicKey: 'pk', scopes: ['sessions'] })
    expect(s.recordNetwork(d.id, 'lan:192.168.1')).toBe('baseline')
    expect(s.recordNetwork(d.id, 'lan:192.168.1')).toBe('known')
    expect(s.recordNetwork(d.id, 'relay')).toBe('new')
    expect(s.recordNetwork(d.id, 'relay')).toBe('known')
    expect(s.listNetworks(d.id)).toEqual(['lan:192.168.1', 'relay'])
    s.deleteDevice(d.id)
    expect(s.listNetworks(d.id)).toEqual([])
    s.close()
  })
  it('is per device', () => {
    const s = new Store(':memory:')
    const a = s.createDevice({ name: 'a', platform: 'ios', publicKey: 'pa', scopes: [] })
    const b = s.createDevice({ name: 'b', platform: 'ios', publicKey: 'pb', scopes: [] })
    expect(s.recordNetwork(a.id, 'relay')).toBe('baseline')
    expect(s.recordNetwork(b.id, 'relay')).toBe('baseline')
    s.close()
  })
})

let h: Harness
describe('bridge', () => {
  beforeAll(async () => {
    h = await startHarness(7883)
  }, 30_000)
  afterAll(async () => {
    await h?.stop()
  })

  it('stays quiet on the first connection and on repeats, alerts on a new network', async () => {
    const pair = await h.pairApproved('iPhone X')
    const c1 = await h.connect(pair)
    c1.disconnect()
    const c2 = await h.connect(pair)
    c2.disconnect()
    expect(h.notices.filter((n) => n.includes('new network'))).toHaveLength(0)
    expect(h.bridge.store.listNetworks(pair.deviceId)).toEqual(['local'])

    const device = h.bridge.store.getDevice(pair.deviceId)!
    expect(h.bridge.noteNetwork(device, 'direct', '192.168.7.20')).toBe('new')
    const audit = h.bridge.store.listAudit({ deviceId: pair.deviceId }).filter((e) => e.action === 'new_network')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.summary).toBe('iPhone X connected from a new network (LAN 192.168.7.x)')
    expect(h.notices.filter((n) => n.includes('iPhone X connected from a new network'))).toHaveLength(1)

    // Same network again, and the relay for the first time.
    expect(h.bridge.noteNetwork(device, 'direct', '192.168.7.31')).toBe('known')
    expect(h.bridge.noteNetwork(device, 'relay', 'rel-1')).toBe('new')
    expect(h.bridge.noteNetwork(device, 'relay', 'rel-2')).toBe('known')
    expect(h.notices.filter((n) => n.includes('new network'))).toHaveLength(2)
  })
})
