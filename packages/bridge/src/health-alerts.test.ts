import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HealthAlerts, type RelayHealthState } from './health-alerts.js'

function setup() {
  let now = 1_000_000
  const logs: string[] = []
  const notifications: Array<{ title: string; body: string }> = []
  const alerts = new HealthAlerts({
    notify: (title, body) => notifications.push({ title, body }),
    log: (msg) => logs.push(msg),
    now: () => now,
  })
  return {
    alerts,
    logs,
    notifications,
    tick: (ms: number) => {
      now += ms
      return now
    },
    now: () => now,
  }
}

describe('HealthAlerts state machine', () => {
  it('starts in ok state', () => {
    const { alerts } = setup()
    const h = alerts.getHealth()
    expect(h.state).toBe('ok')
    expect(h.lastAlertAt).toBeUndefined()
  })

  it('transitions to degraded after 3 consecutive heartbeat misses', () => {
    const { alerts, notifications } = setup()
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('ok')
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('degraded')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.body).toBe("Your Mac lost its connection to the relay")
  })

  it('transitions to degraded when link is down for 3+ minutes', () => {
    const { alerts, notifications, tick } = setup()
    alerts.update({ relayState: 'offline' })
    expect(alerts.getHealth().state).toBe('ok')
    tick(3 * 60 * 1000 + 1)
    alerts.update({ relayState: 'offline' })
    expect(alerts.getHealth().state).toBe('degraded')
    expect(notifications).toHaveLength(1)
  })

  it('resets heartbeat miss counter on successful heartbeat', () => {
    const { alerts } = setup()
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('ok')
    alerts.update({ heartbeat: true })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('ok')
    // Needs 3 consecutive again
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('degraded')
  })

  it('clears link-down timer when relay comes online', () => {
    const { alerts, tick } = setup()
    alerts.update({ relayState: 'offline' })
    tick(2 * 60 * 1000)
    alerts.update({ relayState: 'online' })
    tick(2 * 60 * 1000) // Link still up but total downtime was only 2 min
    alerts.update({ relayState: 'online' })
    expect(alerts.getHealth().state).toBe('ok')
  })

  it('transitions back to ok when healthy', () => {
    const { alerts, notifications, tick } = setup()
    // Go degraded.
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('degraded')
    // Now get healthy again.
    alerts.update({ heartbeat: true })
    alerts.update({ relayState: 'online' })
    expect(alerts.getHealth().state).toBe('degraded') // Still in recovery period
    // Wait 1 minute for recovery to complete
    tick(60 * 1000)
    alerts.update({ heartbeat: true })
    expect(alerts.getHealth().state).toBe('ok')
    expect(notifications).toHaveLength(2)
    expect(notifications[1]!.body).toBe("Your Mac reconnected to the relay")
  })

  it('rate-limits alerts to 1 per 30 minutes per kind', () => {
    const { alerts, notifications, tick } = setup()
    // Trigger degraded alert.
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('degraded')
    expect(notifications).toHaveLength(1)

    // We're in degraded. Let's simulate it staying degraded for a bit then recovering.
    tick(1000)
    alerts.update({ heartbeat: true }) // successful heartbeat, start recovery
    alerts.update({ relayState: 'online' })

    // Still in recovery period (< 1 min)
    expect(alerts.getHealth().state).toBe('degraded')

    // Wait for recovery to complete (1 minute)
    tick(60 * 1000)
    alerts.update({ heartbeat: true })
    expect(alerts.getHealth().state).toBe('ok')
    expect(notifications).toHaveLength(2) // recovered alert

    // Now go degraded again immediately, within 30 min of first alert
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    // Should NOT send another alert because it's within 30 min of the first alert.
    expect(notifications).toHaveLength(2)

    // Wait 30 minutes from the first alert
    tick(30 * 60 * 1000 - 62 * 1000)
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    // Still suppressed
    expect(notifications).toHaveLength(2)

    // Wait a bit more to exceed 30 minutes from first alert
    tick(5000)
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    // Now the alert can go out
    expect(notifications).toHaveLength(3)
  })

  it('logs health transitions', () => {
    const { alerts, logs } = setup()
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(logs.some((l) => l.includes('health transitioned'))).toBe(true)
  })

  it('tracks since timestamp', () => {
    const { alerts, now, tick } = setup()
    const initial = alerts.getHealth().since
    expect(initial).toBe(now())

    tick(1000)
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    const degraded = alerts.getHealth()
    expect(degraded.since).toBe(now())
    expect(degraded.since).toBeGreaterThan(initial)
  })

  it('tracks lastAlertAt', () => {
    const { alerts, now, tick } = setup()
    expect(alerts.getHealth().lastAlertAt).toBeUndefined()

    tick(100)
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    const health = alerts.getHealth()
    expect(health.lastAlertAt).toBe(now())
  })

  it('reset() clears all state', () => {
    const { alerts } = setup()
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('degraded')

    alerts.reset()
    const h = alerts.getHealth()
    expect(h.state).toBe('ok')
    expect(h.lastAlertAt).toBeUndefined()
  })
})

describe('HealthAlerts with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('works correctly with fake time progression', () => {
    const logs: string[] = []
    const notifications: Array<{ title: string; body: string }> = []
    let now = 1_000_000
    const alerts = new HealthAlerts({
      notify: (title, body) => notifications.push({ title, body }),
      log: (msg) => logs.push(msg),
      now: () => now,
    })

    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    alerts.update({ heartbeat: false })
    expect(alerts.getHealth().state).toBe('degraded')
    expect(notifications).toHaveLength(1)

    // Advance and recover
    now += 60 * 1000
    alerts.update({ heartbeat: true })
    alerts.update({ relayState: 'online' })
    expect(alerts.getHealth().state).toBe('degraded') // Still in recovery
    now += 60 * 1000
    alerts.update({ heartbeat: true })
    expect(alerts.getHealth().state).toBe('ok')
    expect(notifications).toHaveLength(2)
  })
})
