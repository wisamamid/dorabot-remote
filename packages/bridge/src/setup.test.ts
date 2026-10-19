import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePaths } from './config.js'
import { SetupError, appDir, isFirstRun, nodeOk, runSetup, runUninstall, type LaunchdLike, type SetupDeps } from './setup.js'

let home: string
let src: string
let installs: Array<Record<string, unknown>>
let installed: boolean

const launchd: LaunchdLike = {
  install: (a) => {
    installs.push(a)
    installed = true
    return join(home, 'Library/LaunchAgents/x.plist')
  },
  uninstall: () => {
    const was = installed
    installed = false
    return was
  },
  status: () => ({ installed, loaded: installed, pid: null, plist: '' }),
}

function deps(over: Partial<SetupDeps> = {}, withDorabot = true): { d: SetupDeps; lines: string[]; paired: { n: number } } {
  const paths = resolvePaths({ root: join(home, '.dorabot-remote'), dorabotRoot: join(home, '.dorabot') })
  if (withDorabot) {
    mkdirSync(paths.dorabotRoot, { recursive: true })
    writeFileSync(paths.gatewaySocket, '')
    writeFileSync(paths.gatewayToken, 'tok')
  }
  const lines: string[] = []
  const paired = { n: 0 }
  return {
    lines,
    paired,
    d: {
      paths,
      version: '1.2.3',
      sourceDir: src,
      nodePath: '/opt/node/bin/node',
      nodeVersion: '24.1.0',
      platform: 'darwin',
      port: 7788,
      launchd,
      health: async () => true,
      pair: async () => {
        paired.n++
      },
      log: (l) => lines.push(l),
      healthTimeoutMs: 500,
      ...over,
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dr-setup-'))
  src = join(home, 'pkg-dist')
  mkdirSync(src)
  writeFileSync(join(src, 'cli.js'), '// bundle')
  installs = []
  installed = false
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('node version', () => {
  it('requires 22.13+', () => {
    expect(nodeOk('22.12.0')).toBe(false)
    expect(nodeOk('22.13.0')).toBe(true)
    expect(nodeOk('24.0.1')).toBe(true)
    expect(nodeOk('20.18.0')).toBe(false)
  })
  it('explains nvm and brew when too old', async () => {
    const { d } = deps({ nodeVersion: '20.1.0' })
    await expect(runSetup(d)).rejects.toThrow(/nvm install[\s\S]*brew install node/)
    expect(installs).toHaveLength(0)
  })
})

describe('setup', () => {
  it('fails clearly when dorabot is not running, touching nothing', async () => {
    const { d } = deps({}, false)
    await expect(runSetup(d)).rejects.toBeInstanceOf(SetupError)
    await expect(runSetup(d)).rejects.toThrow(/gateway\.sock/)
    expect(existsSync(appDir(d.paths))).toBe(false)
    expect(installs).toHaveLength(0)
  })

  it('stages the app, points current at it, installs the agent with the absolute node path, pairs', async () => {
    const { d, paired } = deps()
    await runSetup(d)
    const dir = join(appDir(d.paths), '1.2.3')
    expect(readFileSync(join(dir, 'cli.js'), 'utf8')).toBe('// bundle')
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type).toBe('module')
    expect(readlinkSync(join(appDir(d.paths), 'current'))).toBe('1.2.3')
    expect(installs[0]).toMatchObject({
      cliPath: join(appDir(d.paths), 'current', 'cli.js'),
      nodePath: '/opt/node/bin/node',
      root: d.paths.root,
    })
    expect(paired.n).toBe(1)
  })

  it('is idempotent and keeps only the previous version on update', async () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      const { d } = deps({ version: v, skipPair: v !== '1.0.0' })
      await runSetup(d)
    }
    const { d } = deps({ version: '1.2.0' })
    await runSetup(d)
    const dirs = ['1.0.0', '1.1.0', '1.2.0'].filter((v) => existsSync(join(appDir(d.paths), v)))
    expect(dirs).toEqual(['1.1.0', '1.2.0'])
    expect(readlinkSync(join(appDir(d.paths), 'current'))).toBe('1.2.0')
  })

  it('reports when the bridge never becomes healthy', async () => {
    const { d, paired } = deps({ health: async () => false, healthTimeoutMs: 600 })
    await expect(runSetup(d)).rejects.toThrow(/did not come up/)
    expect(paired.n).toBe(0)
  })

  it('offers to open the control page', async () => {
    const opened: string[] = []
    const { d } = deps({ confirm: async () => true, openUrl: (u) => opened.push(u) })
    await runSetup(d)
    expect(opened).toEqual(['http://127.0.0.1:7788/'])
  })

  it('refuses outside macOS', async () => {
    const { d } = deps({ platform: 'linux' })
    await expect(runSetup(d)).rejects.toThrow(/macOS only/)
  })
})

describe('uninstall', () => {
  it('removes the agent and app but keeps keys and devices', async () => {
    const { d } = deps()
    await runSetup(d)
    writeFileSync(d.paths.identity, 'key')
    writeFileSync(d.paths.db, 'db')
    await runUninstall(d, false)
    expect(installed).toBe(false)
    expect(existsSync(appDir(d.paths))).toBe(false)
    expect(existsSync(d.paths.identity)).toBe(true)
    expect(existsSync(d.paths.db)).toBe(true)
  })
  it('--purge deletes everything', async () => {
    const { d } = deps()
    await runSetup(d)
    writeFileSync(d.paths.identity, 'key')
    await runUninstall(d, true)
    expect(existsSync(d.paths.root)).toBe(false)
  })
  it('is safe when nothing is installed', async () => {
    const { d, lines } = deps()
    await runUninstall(d, false)
    expect(lines.join('\n')).toMatch(/not installed/)
  })
})

describe('first run detection', () => {
  it('is first run only with no settings, app, or agent', async () => {
    const { d } = deps()
    expect(isFirstRun(d.paths, launchd)).toBe(true)
    await runSetup(d)
    expect(isFirstRun(d.paths, launchd)).toBe(false)
    expect(lstatSync(appDir(d.paths)).isDirectory()).toBe(true)
  })
})
