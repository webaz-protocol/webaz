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

const selection = section('function selectedCartRows()', 'function setBusy')
const removeChecked = section('window.cartRemoveChecked = async () =>', 'window.cartChangeQty')
const changeQty = section('window.cartChangeQty = async (productId, qty) =>', 'window.cartRemove = async (productId) =>')
const removeOne = section('window.cartRemove = async (productId) =>', 'window.cartCheckout = async () =>')
const checkout = section('window.cartCheckout = async () =>', '// ─── 订单列表页')

ok('cart action module is loaded by the PWA', index.includes('/app-cart-actions.js'))
ok('selection derives rows only from checked cart entries', /querySelectorAll\('\.cart-item-check'\)[\s\S]*filter\(cb => cb\.checked\)/.test(selection))
ok('checkout intent binds product id, quantity and unit price', /selectedCheckoutItems[\s\S]*product_id:[\s\S]*qty:[\s\S]*unit_price:/.test(selection))
ok('cart rows expose the confirmed quantity and unit price', /data-qty=/.test(app) && /data-unit-price=/.test(app))
ok('checkout refuses an empty local selection', /selectedCheckoutItems\(\)[\s\S]*items\.length === 0/.test(checkout))
ok('checkout posts selected item intents with address_id or legacy address fallback',
  /POST\('\/cart\/checkout',\s*\{\s*\.\.\.\(address_id \? \{ address_id \} : \{ shipping_address: addr \}\),\s*items\s*\}\)/.test(checkout))
ok('checkout accepts address book id before requiring manual address', /if \(!addr && !address_id\)/.test(checkout))
ok('bulk removal deletes each selected product independently', /for \(const pid of ids\)[\s\S]*DELETE\(`\/cart\/\$\{encodeURIComponent\(pid\)\}`\)/.test(removeChecked))
ok('bulk removal never calls the retired cart/remove endpoint', !(app + cart).includes('/cart/remove'))
ok('bulk removal always releases busy state after refresh/network failure', /finally\s*\{\s*setBusy\(false\)\s*\}/.test(removeChecked))
ok('busy state disables every per-item cart mutation control', /\.cart-mutation-control/.test(cart) && (app.match(/cart-mutation-control/g) || []).length === 3)
ok('quantity and single-delete handlers reject overlap and release busy state', /if \(cartBusy\) return/.test(changeQty) && /finally \{ setBusy\(false\) \}/.test(changeQty)
  && /if \(cartBusy\) return/.test(removeOne) && /finally \{ setBusy\(false\) \}/.test(removeOne))

if (fail > 0) {
  console.error(`\nFAIL cart UI contract\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`PASS cart UI contract\n  pass ${pass}`)
