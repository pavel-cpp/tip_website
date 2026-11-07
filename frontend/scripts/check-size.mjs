// Fails when the gzipped initial JS (entry chunk plus everything it statically imports) exceeds the budget.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = 250
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const html = readFileSync(join(dist, 'index.html'), 'utf8')

// Initial JS = scripts and modulepreloads referenced by index.html (lazy chunks are not listed there).
const files = new Set([...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]))
if (files.size === 0) {
  console.error('size: no initial JS found in dist/index.html (run `npm run build` first)')
  process.exit(1)
}

let total = 0
for (const f of files) {
  const gz = gzipSync(readFileSync(join(dist, f))).length
  total += gz
  console.log(`  ${f}  ${(gz / 1024).toFixed(1)} KB gzip`)
}
const kb = total / 1024
console.log(`initial JS: ${kb.toFixed(1)} KB gzip (budget ${BUDGET_KB} KB)`)
if (kb > BUDGET_KB) {
  console.error('size: budget exceeded')
  process.exit(1)
}
