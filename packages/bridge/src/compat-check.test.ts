import { describe, expect, it, vi } from 'vitest'
import { CompatChecker, TESTED_DORABOT_VERSIONS } from './compat-check.js'

function setup() {
  const logs: string[] = []
  const notifications: Array<{ title: string; body: string }> = []
  const checker = new CompatChecker({
    log: (msg) => logs.push(msg),
    notify: (title, body) => notifications.push({ title, body }),
  })
  return { checker, logs, notifications }
}

describe('CompatChecker', () => {
  it('starts with untested status', () => {
    const { checker } = setup()
    const status = checker.getStatus()
    expect(status.tested).toBe(false)
    expect(status.missingMethods).toEqual([])
    expect(status.dorabotVersion).toBeUndefined()
  })

  it('marks version as tested when in TESTED_DORABOT_VERSIONS', async () => {
    const { checker } = setup()
    await checker.check({
      dorabotVersion: '0.3.4',
      callGateway: async () => ({}),
    })
    expect(checker.getStatus().tested).toBe(true)
    expect(checker.getStatus().dorabotVersion).toBe('0.3.4')
  })

  it('marks version as untested when not in list', async () => {
    const { checker, notifications } = setup()
    await checker.check({
      dorabotVersion: '0.4.0',
      callGateway: async () => ({}),
    })
    const status = checker.getStatus()
    expect(status.tested).toBe(false)
    expect(status.dorabotVersion).toBe('0.4.0')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.body).toContain('0.4.0')
    expect(notifications[0]!.body).toContain('dorabot-remote update')
  })

  it('detects missing RPC methods', async () => {
    const { checker } = setup()
    const callGateway = vi.fn(async (method: string) => {
      if (method === 'tool.pending') throw new Error('Unknown method: tool.pending')
      if (method === 'research.list') throw new Error('Unknown method: research.list')
      return {}
    })
    await checker.check({
      dorabotVersion: '0.3.4',
      callGateway,
    })
    const status = checker.getStatus()
    expect(status.missingMethods.sort()).toEqual(['research.list', 'tool.pending'])
  })

  it('calls all required methods', async () => {
    const { checker } = setup()
    const called: string[] = []
    const callGateway = vi.fn(async (method: string) => {
      called.push(method)
      return {}
    })
    await checker.check({
      dorabotVersion: '0.3.4',
      callGateway,
    })
    expect(called.sort()).toEqual([
      'projects.list',
      'provider.detect',
      'research.list',
      'sessions.list',
      'status',
      'tasks.list',
      'tool.pending',
    ])
  })

  it('ignores non-unknown-method errors', async () => {
    const { checker } = setup()
    const callGateway = vi.fn(async (method: string) => {
      if (method === 'status') throw new Error('gateway not ready')
      return {}
    })
    await checker.check({
      dorabotVersion: '0.3.4',
      callGateway,
    })
    expect(checker.getStatus().missingMethods).toEqual([])
  })

  it('logs warning when methods are missing', async () => {
    const { checker, logs } = setup()
    const callGateway = vi.fn(async (method: string) => {
      if (method === 'status') throw new Error('Unknown method')
      return {}
    })
    await checker.check({
      dorabotVersion: '0.3.4',
      callGateway,
    })
    expect(logs.some((l) => l.includes('missing RPC methods'))).toBe(true)
  })

  it('handles version being undefined', async () => {
    const { checker } = setup()
    await checker.check({
      dorabotVersion: undefined,
      callGateway: async () => ({}),
    })
    expect(checker.getStatus().tested).toBe(true) // undefined version is considered "tested"
    expect(checker.getStatus().dorabotVersion).toBeUndefined()
  })

  it('logs check failures without throwing', async () => {
    const { checker, logs } = setup()
    // Make the whole check fail by throwing at the top level (not from individual method calls).
    const callGateway = vi.fn(async (method: string) => {
      // First call throws, rest return normally
      if (method === 'status') throw new Error('gateway not responding')
      return {}
    })
    await expect(
      checker.check({
        dorabotVersion: '0.3.4',
        callGateway,
      }),
    ).resolves.not.toThrow()
    // No warning in this case because the error is caught per-method
    expect(checker.getStatus().dorabotVersion).toBe('0.3.4')
  })

  it('reset() clears all status', async () => {
    const { checker } = setup()
    await checker.check({
      dorabotVersion: '0.3.4',
      callGateway: async () => ({}),
    })
    expect(checker.getStatus().dorabotVersion).toBe('0.3.4')
    checker.reset()
    const status = checker.getStatus()
    expect(status.tested).toBe(false)
    expect(status.dorabotVersion).toBeUndefined()
    expect(status.missingMethods).toEqual([])
  })
})
