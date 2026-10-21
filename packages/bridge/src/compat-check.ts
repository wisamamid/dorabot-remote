/**
 * Dorabot version compatibility check.
 *
 * Compares the installed dorabot version against a tested list and probes the
 * gateway for required RPC methods. Reports drift so users can update.
 */

export interface CompatCheckOptions {
  log: (msg: string) => void
  notify: (title: string, body: string) => void
}

export interface CompatStatus {
  dorabotVersion?: string
  tested: boolean
  missingMethods: string[]
}

/**
 * List of dorabot versions known to work with this bridge.
 * Update when releasing compatibility with a new dorabot version.
 */
export const TESTED_DORABOT_VERSIONS = ['0.3.4']

/**
 * RPC methods we rely on. Subset of the gateway API; skips streaming/paginated methods like chat.history.
 */
const REQUIRED_RPC_METHODS = ['status', 'sessions.list', 'tool.pending', 'tasks.list', 'projects.list', 'research.list', 'provider.detect']

export class CompatChecker {
  private lastCheckAt = 0
  private lastStatus: CompatStatus = { tested: false, missingMethods: [] }
  private readonly log: (msg: string) => void
  private readonly notify: (title: string, body: string) => void

  constructor(opts: CompatCheckOptions) {
    this.log = opts.log
    this.notify = opts.notify
  }

  /**
   * Check dorabot version and gateway methods. Call at bridge startup and
   * whenever gateway reconnects.
   *
   * Returns false if the check times out or network fails (do not block
   * the bridge; only log warnings).
   */
  async check(opts: {
    dorabotVersion?: string
    callGateway: (method: string, params: Record<string, unknown>) => Promise<unknown>
  }): Promise<void> {
    try {
      const version = opts.dorabotVersion
      const tested = !version || TESTED_DORABOT_VERSIONS.includes(version)

      // Probe for required methods. Each call should fail quickly if the method is unknown.
      const missing: string[] = []
      for (const method of REQUIRED_RPC_METHODS) {
        try {
          // Each method with an empty params object. They should all either succeed
          // (returning data) or fail with "unknown method". Any other error is ignored.
          await opts.callGateway(method, {})
        } catch (err) {
          const msg = (err as Error)?.message || ''
          if (msg.includes('unknown method') || msg.includes('Unknown method')) {
            missing.push(method)
          }
          // Ignore other errors (gateway not ready, etc.). We're just checking if
          // the method exists, not that it returns valid data.
        }
      }

      this.lastStatus = { dorabotVersion: version, tested, missingMethods: missing }
      this.lastCheckAt = Date.now()

      // Log warnings if incompatible.
      if (!tested) {
        this.log(`dorabot ${version} is newer than this bridge was tested with (tested: ${TESTED_DORABOT_VERSIONS.join(', ')}); check for a dorabot-remote update`)
        this.notify('dorabot remote', `dorabot ${version} is newer than this bridge was tested with; check for a dorabot-remote update`)
      }
      if (missing.length > 0) {
        this.log(`gateway is missing RPC methods: ${missing.join(', ')}; check for a dorabot-remote update`)
      }
    } catch (err) {
      // Timeout or network error during check. Log but do not fail.
      this.log(`compat check failed: ${(err as Error).message}`)
    }
  }

  getStatus(): CompatStatus {
    return { ...this.lastStatus }
  }

  reset(): void {
    this.lastStatus = { tested: false, missingMethods: [] }
    this.lastCheckAt = 0
  }
}
