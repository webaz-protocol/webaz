#!/usr/bin/env tsx
/** Cart selected-intent source contract. Usage: npm run test:cart-ui-contract */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

execFileSync(process.execPath, ['--check', 'src/pwa/public/app-cart-actions.js'], { stdio: 'pipe' })

const app = readFileSync('src/pwa/public/app.js', 'utf8')
const cart = readFileSync('src/pwa/public/app-cart-actions.js', 'utf8')
const index = readFileSync('src/pwa/public/index.html', 'utf8')
let pass = 0
let fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}
const section = (start: string, end: string): string => {
  const from = cart.indexOf(start)
  const to = cart.indexOf(end, from)
  return cart.slice(from, to === -1 ? cart.length : to)
}

const selection = section('function selectedProductIds()', 'function setBusy')
const removeChecked = section('window.cartRemoveChecked = async () =>', 'window.cartChangeQty')
const checkout = section('window.cartCheckout = async () =>', '// ─── 订单列表页')

ok('cart action module is loaded by the PWA', index.includes('/app-cart-actions.js'))
ok('selection derives IDs only from checked cart rows', /querySelectorAll\('\.cart-item-check'\)[\s\S]*filter\(cb => cb\.checked\)[\s\S]*map\(cb => cb\.dataset\.pid\)/.test(selection))
ok('checkout refuses an empty local selection', /selectedProductIds\(\)[\s\S]*productIds\.length === 0/.test(checkout))
ok('checkout posts selected product_ids with the address', /POST\('\/cart\/checkout',\s*\{\s*shipping_address:\s*addr,\s*product_ids:\s*productIds\s*\}\)/.test(checkout))
ok('bulk removal deletes each selected product independently', /for \(const pid of ids\)[\s\S]*DELETE\(`\/cart\/\$\{encodeURIComponent\(pid\)\}`\)/.test(removeChecked))
ok('bulk removal never calls the retired cart/remove endpoint', !(app + cart).includes('/cart/remove'))
ok('bulk removal always releases busy state after refresh/network failure', /finally\s*\{\s*setBusy\(false\)\s*\}/.test(removeChecked))

if (fail > 0) {
  console.error(`\nFAIL cart UI contract\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`PASS cart UI contract\n  pass ${pass}`)
