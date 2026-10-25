/**
 * T8: lost phone. Lockdown revokes every device at once; "Lost" revokes one. Both drop push keys and relay
 * access, close live sockets and are audit-logged.
 */
import { decodePairingPayload, pairWithHost } from '@dorabot-remote/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from './store.js'
import { createSocket, startHarness, until, type Harness } from '../test/harness.js'

let h: Harness
beforeAll(async () => {
  h = await startHarness(7881)
}, 30_000)
afterAll(async () => {
  await h?.stop()
})

describe('lockdown', () => {
  it('refuses without confirm', async () => {
    expect((await h.post('/api/lockdown', {})).status).toBe(400)
  })

  it('revokes every device, drops push keys, closes sockets and audits each', async () => {
    const a = await h.pairApproved('Phone A')
    const b = await h.pairApproved('Phone B')
    const pending = await pairWithHost({ payload: decodePairingPayload(h.bridge.newPairingPayload().uri), deviceName: 'Pending C', platform: 'ios', createSocket })
    h.bridge.store.setPushToken(a.deviceId, 'a'.repeat(64), 'ios', 'production', 'k'.repeat(44))
    const live = await h.connect(a)
    expect(live.state).toBe('ready')

    const res = await h.post('/api/lockdown', { confirm: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, revoked: 2, rejected: 1 })

    for (const p of [a, b]) {
      const d = h.bridge.store.getDevice(p.deviceId)!
      expect(d.revoked).toBe(true)
      expect(d.revokedReason).toBe('lockdown')
      expect(d.pushToken).toBeNull()
      expect(d.pushKey).toBeNull()
    }
    expect(h.bridge.store.getDevice(pending.deviceId)).toBeNull()
    await until(() => live.state !== 'ready', 3000, 'live socket closed')

    const audit = h.bridge.store.listAudit({ limit: 50 })
    expect(audit.filter((e) => e.action === 'revoke' && e.summary?.startsWith('lockdown')).length).toBe(2)
    expect(audit.some((e) => e.action === 'lockdown' && e.summary === 'revoked 2 device(s), removed 1 pending')).toBe(true)
    live.disconnect()
  })

  it('a second lockdown is a no-op', async () => {
    const res = await h.post('/api/lockdown', { confirm: true })
    expect(res.body).toMatchObject({ revoked: 0, rejected: 0 })
  })

  it('state shows the reason', async () => {
    const st = (await h.get('/api/state')).body
    expect(st.devices.every((d: any) => d.revoked && d.revokedReason === 'lockdown')).toBe(true)
  })
})

describe('lost', () => {
  it('revokes one device only, with reason and audit', async () => {
    const lost = await h.pairApproved('Lost phone')
    const other = await h.pairApproved('Other phone')
    h.bridge.store.setPushToken(lost.deviceId, 'b'.repeat(64), 'ios', 'production', 'k'.repeat(44))
    const res = await h.post('/api/device', { deviceId: lost.deviceId, action: 'lost' })
    expect(res.body.ok).toBe(true)
    const d = h.bridge.store.getDevice(lost.deviceId)!
    expect(d).toMatchObject({ revoked: true, revokedReason: 'lost', pushToken: null, pushKey: null })
    expect(h.bridge.store.getDevice(other.deviceId)!.revoked).toBe(false)
    expect(h.bridge.store.listAudit({ deviceId: lost.deviceId }).some((e) => e.action === 'lost')).toBe(true)
  })

  it('does not apply to pending or unknown devices', async () => {
    expect(h.bridge.markLost('nope')).toBe(false)
  })
})

describe('store.lockdown (CLI path)', () => {
  it('works straight on the database', () => {
    const s = new Store(':memory:')
    const mk = (n: string, pending = false) => s.createDevice({ name: n, platform: 'ios', publicKey: `pk-${n}`, scopes: ['sessions'], pending })
    const a = mk('a')
    mk('b', true)
    const c = mk('c')
    s.setRevoked(c.id, true)
    const out = s.lockdown()
    expect(out.revoked.map((d) => d.id)).toEqual([a.id])
    expect(out.rejected).toHaveLength(1)
    expect(s.listDevices().every((d) => d.revoked)).toBe(true)
    s.close()
  })
})
