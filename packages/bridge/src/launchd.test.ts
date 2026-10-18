import { describe, expect, it } from 'vitest'
import { LAUNCHD_LABEL, plistPath, renderPlist } from './launchd.js'

const opts = { nodePath: '/opt/node/bin/node', cliPath: '/repo/packages/bridge/dist/cli.js', logDir: '/Users/me/.dorabot-remote/logs' }

describe('launchd plist', () => {
  it('runs the current node on dist/cli.js start, always on', () => {
    const xml = renderPlist(opts)
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(xml).toMatch(/<string>\/opt\/node\/bin\/node<\/string>[\s\S]*<string>\/repo\/packages\/bridge\/dist\/cli\.js<\/string>\s*<string>start<\/string>/)
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
  })

  it('writes logs under the log dir', () => {
    const xml = renderPlist(opts)
    expect(xml).toContain('<string>/Users/me/.dorabot-remote/logs/bridge.out.log</string>')
    expect(xml).toContain('<string>/Users/me/.dorabot-remote/logs/bridge.err.log</string>')
  })

  it('escapes paths and renders environment overrides', () => {
    const xml = renderPlist({ ...opts, nodePath: '/Apps/R&D/node', env: { DORABOT_HOME: '/tmp/<x>' } })
    expect(xml).toContain('/Apps/R&amp;D/node')
    expect(xml).toContain('<key>DORABOT_HOME</key>')
    expect(xml).toContain('/tmp/&lt;x&gt;')
    expect(renderPlist(opts)).not.toContain('EnvironmentVariables')
  })

  it('lives in the user LaunchAgents directory', () => {
    expect(plistPath('/Users/me')).toBe(`/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`)
  })
})
