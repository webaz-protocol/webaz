#!/usr/bin/env tsx
/** Regression contract: public product lists must not hide items by seller count. */
import { readFileSync } from 'node:fs'

const SRC = readFileSync('src/pwa/routes/products-list.ts', 'utf8')

let pass = 0
let fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}

ok('no fixed per-seller product cap remains', !/SELLER_CAP|applySellerCap|perSeller/.test(SRC))
ok('list rows come from the complete SQL candidate set', SRC.includes('let rows = candidates'))
ok('requested page limit still applies', SRC.includes('rows = rows.slice(0, lim)'))
ok('trending keeps its jitter candidate buffer', SRC.includes("const buffer = sort === 'trending' ? Math.min(lim * 3, lim + 30) : lim"))

if (fail > 0) {
  console.error(`\nproducts-list no-seller-cap FAILED\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`products-list no-seller-cap: all eligible products may be returned; request limit preserved\n  pass ${pass}`)
