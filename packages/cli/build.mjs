// Bundles the bridge CLI and the protocol package into one self-contained ESM file.
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const pkg = JSON.parse(readFileSync(here('package.json'), 'utf8'))

// The version the installer stamps on ~/.dorabot-remote/app/<version> comes from the bridge source.
const configSrc = readFileSync(here('../bridge/src/config.ts'), 'utf8')
const bridgeVersion = /BRIDGE_VERSION = '([^']+)'/.exec(configSrc)?.[1]
if (bridgeVersion !== pkg.version) {
  console.error(`Version mismatch: BRIDGE_VERSION is ${bridgeVersion} but packages/cli is ${pkg.version}. Keep them equal.`)
  process.exit(1)
}

if (process.argv.includes('--check')) process.exit(0)

rmSync(here('dist'), { recursive: true, force: true })
await build({
  entryPoints: [here('../bridge/src/cli.ts')],
  outfile: here('dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  // ws tries these optionally inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // Some bundled dependencies are CommonJS and call require() on node builtins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
})
chmodSync(here('dist/cli.js'), 0o755)
