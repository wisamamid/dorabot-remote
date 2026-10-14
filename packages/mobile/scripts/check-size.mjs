// Fails when the entry chunk (the JS a phone must download before anything
// renders) goes over budget. Terminal and code viewer chunks are lazy and not
// counted: they only load when someone opens those screens.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = Number(process.env.SIZE_BUDGET_KB ?? 200)
const dist = new URL('../dist/', import.meta.url).pathname
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const entry = /<script[^>]+type="module"[^>]+src="\/?([^"]+\.js)"/.exec(html)?.[1]
if (!entry) {
  console.error('size: could not find the entry script in dist/index.html (run `npm run build` first)')
  process.exit(2)
}

const gz = (file) => gzipSync(readFileSync(join(dist, file))).length / 1024
const entryKb = gz(entry)

console.log('chunk'.padEnd(44), 'gzip kB')
for (const f of readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js')).sort()) {
  const kb = gz(join('assets', f))
  console.log(`${f.padEnd(44)} ${kb.toFixed(1).padStart(7)}${`assets/${f}` === entry ? '   <- entry' : ''}`)
}

if (entryKb > BUDGET_KB) {
  console.error(`\nsize: entry chunk is ${entryKb.toFixed(1)} kB gzip, budget is ${BUDGET_KB} kB`)
  process.exit(1)
}
console.log(`\nsize: entry chunk ${entryKb.toFixed(1)} kB gzip (budget ${BUDGET_KB} kB) ok`)
