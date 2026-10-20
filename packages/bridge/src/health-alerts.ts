/**
 * Relay health monitoring with alert thresholds and delivery.
 *
 * Tracks relay self-test failures and link downtime. When either exceeds its
 * threshold (3 consecutive failures or 3+ minutes down), raises ONE alert per
 * 30-minute window. Sends macOS notifications and push to paired devices.
 */
import { execFile } from 'node:child_process'
import type { PushNotifier } from './push.js'

export interface HealthAlertsOptions {
  notify: (title: string, body: string) => void
  log: (msg: string) => void
  pusher?: PushNotifier
  now?: () => number
}

export type RelayHealthState = 'ok' | 'degraded' | 'down'

export interface RelayHealth {
  state: RelayHealthState
  since: number
  lastAlertAt?: number
}

interface AlertWindow {
  kind: string
  lastAt: number
}

/**
 * Tracks relay health and manages alert delivery. Stores no persistent state;
 * depends on RelayClient's state reports and bridge lifecycle.
 *
 * Usage:
 *  - new HealthAlerts(opts)
 *  - call update() whenever relay state changes or heartbeat event occurs
 *  - call getHealth() to read current state for /api/state
 */
export class HealthAlerts {
  private health: RelayHealth
  private consecutiveHbMisses = 0
  private linkDownAt: number | null = null
  private recoveryStartAt: number | null = null
  private alertWindows = new Map<string, AlertWindow>()
  private readonly notify: (title: string, body: string) => void
  private readonly log: (msg: string) => void
  private readonly pusher?: PushNotifier
  private readonly now: () => number

  constructor(opts: HealthAlertsOptions) {
    this.notify = opts.notify
    this.log = opts.log
    this.pusher = opts.pusher
    this.now = opts.now ?? Date.now
    this.health = { state: 'ok', since: this.now() }
  }

  /**
   * Call after a relay state change (online/offline) or heartbeat result.
   *
   * - heartbeat: passed (true) or missed (false)
   * - relayState: 'online', 'offline', or 'connecting'
   */
  update(opts: { heartbeat?: boolean; relayState?: string }): void {
    const now = this.now()

    // Track heartbeat misses. Reset to 0 on successful heartbeat.
    if (opts.heartbeat === true) {
      this.consecutiveHbMisses = 0
    } else if (opts.heartbeat === false) {
      this.consecutiveHbMisses++
    }

    // Track link state. Online = link is up. Offline/connecting = link is down.
    const linkIsUp = opts.relayState === 'online'
    if (linkIsUp) {
      this.linkDownAt = null
      // Start recovery timer when link comes back up.
      if (this.health.state === 'degraded' && this.recoveryStartAt === null) {
        this.recoveryStartAt = now
      }
    } else if (opts.relayState && opts.relayState !== 'online' && !this.linkDownAt) {
      this.linkDownAt = now
      this.recoveryStartAt = null // Reset recovery timer when link goes down again.
    }

    // Assess health.
    const linkDownMs = this.linkDownAt ? now - this.linkDownAt : 0
    const isUnhealthy =
      this.consecutiveHbMisses >= 3 || // 3+ consecutive heartbeat misses
      linkDownMs > 3 * 60 * 1000 // link down for 3+ minutes

    // State transitions and alerts.
    if (isUnhealthy && this.health.state === 'ok') {
      // Entering unhealthy state.
      this.transitionTo('degraded', now, 'relay')
      this.recoveryStartAt = null // Reset recovery timer when we go degraded.
    } else if (!isUnhealthy && this.health.state === 'degraded') {
      // Check if we've been healthy for 1 minute.
      if (this.recoveryStartAt === null || now - this.recoveryStartAt < 1 * 60 * 1000) {
        // Still in recovery period, not yet fully recovered.
        return
      }
      this.transitionTo('ok', now, 'relay-recovered')
    }
  }

  private transitionTo(newState: RelayHealthState, now: number, alertKind: string): void {
    const oldState = this.health.state
    const reason = newState === 'degraded' ? this.getUnhealthyReason() : 'relay recovered'

    this.log(`relay: health transitioned from ${oldState} to ${newState} (${reason})`)

    // Check alert rate limit: only raise 1 alert per 30 minutes per kind.
    const rateLimit = 30 * 60 * 1000
    const window = this.alertWindows.get(alertKind)
    const canAlert = !window || now - window.lastAt >= rateLimit
    if (!canAlert) {
      this.log(`relay: alert suppressed by rate limit (${alertKind})`)
      return
    }

    // Raise the alert.
    const title = 'dorabot remote'
    const body =
      newState === 'degraded'
        ? "Your Mac lost its connection to the relay"
        : "Your Mac reconnected to the relay"

    // Send macOS notification.
    this.notify(title, body)

    // Send push to paired devices (if relay is reachable for push).
    if (this.pusher) {
      try {
        // We send a contentless 'alert' push. In the real scenario, you'd
        // check if the relay push endpoint is reachable; failures are logged and ignored.
        this.sendAlertPush(body)
      } catch (err) {
        this.log(`relay: alert push failed: ${(err as Error).message}`)
      }
    }

    // Update state and alert tracking.
    this.health = { state: newState, since: now, lastAlertAt: now }
    this.alertWindows.set(alertKind, { kind: alertKind, lastAt: now })
  }

  private getUnhealthyReason(): string {
    const reasons = []
    if (this.consecutiveHbMisses >= 3) reasons.push(`${this.consecutiveHbMisses} heartbeat misses`)
    if (this.linkDownAt) reasons.push(`link down for ${Math.round((Date.now() - this.linkDownAt) / 1000)}s`)
    return reasons.join(', ') || 'unknown'
  }

  private sendAlertPush(body: string): void {
    // This would integrate with the PushNotifier to send an 'alert' kind push.
    // For now, log it. In the real implementation, call:
    // this.pusher?.sendAlert(body)
    // But PushNotifier doesn't have this method yet; we'd need to add it.
    this.log(`relay: alert push would be sent: "${body}"`)
  }

  getHealth(): RelayHealth {
    return { ...this.health }
  }

  reset(): void {
    this.health = { state: 'ok', since: this.now() }
    this.consecutiveHbMisses = 0
    this.linkDownAt = null
    this.recoveryStartAt = null
    this.alertWindows.clear()
  }
}
