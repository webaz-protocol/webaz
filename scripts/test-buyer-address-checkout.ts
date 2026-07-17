#!/usr/bin/env tsx
/**
 * Buyer address-book checkout contract.
 * Verifies address_id resolves only for the buyer and checkout surfaces are wired to it.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'webaz-buyer-address-checkout-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initUserAddressesSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { resolveBuyerAddressSnapshot } = await import('../src/pwa/address-book.js')

let pass = 0
let fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean, detail = ''): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}${detail ? `\n    ${detail}` : ''}`) }
}

const db = initDatabase()
initUserAddressesSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer','Buyer','buyer','k_b'),('other','Other','buyer','k_o')").run()
db.prepare("INSERT INTO user_addresses (id,user_id,label,recipient,phone,region,detail,is_default) VALUES ('adr_1','buyer','Home','Jane','91234567','SG','1 Test St #05-01 123456',1),('adr_2','other','Other','Bob','81234567','SG','9 Other Rd',1)").run()

const own = resolveBuyerAddressSnapshot(db, 'buyer', { addressId: 'adr_1' })
ok('own address_id resolves to a shipping snapshot', own.ok && own.value.addressId === 'adr_1' && own.value.shipToRegion === 'SG' && /Jane/.test(own.value.shippingAddress), JSON.stringify(own))

const foreign = resolveBuyerAddressSnapshot(db, 'buyer', { addressId: 'adr_2' })
ok('foreign address_id is rejected', !foreign.ok && foreign.status === 404 && foreign.error_code === 'ADDRESS_NOT_FOUND', JSON.stringify(foreign))

const fallback = resolveBuyerAddressSnapshot(db, 'buyer', {})
ok('omitted address falls back to buyer default address', fallback.ok && fallback.value.addressId === 'adr_1' && /1 Test St/.test(fallback.value.shippingAddress), JSON.stringify(fallback))

const legacy = resolveBuyerAddressSnapshot(db, 'buyer', { shippingAddress: 'Manual address', shipToRegion: 'MY' })
ok('legacy shipping_address remains supported', legacy.ok && legacy.value.addressId === null && legacy.value.shippingAddress === 'Manual address' && legacy.value.shipToRegion === 'MY', JSON.stringify(legacy))

const ordersCreate = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
const cartRoute = readFileSync('src/pwa/routes/cart.ts', 'utf8')
const appJs = readFileSync('src/pwa/public/app.js', 'utf8')
const cartActions = readFileSync('src/pwa/public/app-cart-actions.js', 'utf8')
const shopJs = readFileSync('src/pwa/public/app-shop.js', 'utf8')

ok('orders-create resolves address_id before writing order snapshot',
  /resolveBuyerAddressSnapshot\(db, user\.id as string/.test(ordersCreate)
  && /shipToRegion: shippingRegion/.test(ordersCreate)
  && /shippingAddress, notes \|\| null/.test(ordersCreate))
ok('orders-create feeds address region into sale/shipping gates',
  /gateSaleRegionForCreate\(db, res, product[\s\S]*shippingRegion/.test(ordersCreate)
  && /gateShippingForCreate\(db, res, product[\s\S]*shippingRegion/.test(ordersCreate))
ok('cart checkout route accepts address_id and snapshots it through the same helper',
  /const \{ shipping_address, address_id, ship_to_region/.test(cartRoute)
  && /resolveBuyerAddressSnapshot\(db, String\(user\.id\)/.test(cartRoute)
  && /shippingAddress: addr\.value\.shippingAddress/.test(cartRoute))
ok('buyer PWA sends address_id for product and cart checkout',
  /id="inp-address-id"/.test(appJs)
  && /\.\.\.\(address_id \? \{ address_id \} : \{ shipping_address: addr \}\)/.test(appJs)
  && /id="cart-address-id"/.test(appJs)
  && /\.\.\.\(address_id \? \{ address_id \} : \{ shipping_address: addr \}\)/.test(cartActions))
ok('address book UI is SG-friendly and no longer says province/city/district in the main address-book form',
  /value="\$\{escHtml\(cur\.region \|\| 'SG'\)\}"/.test(shopJs)
  && /国家\/地区/.test(shopJs)
  && /街道、楼栋、单元号、邮编/.test(shopJs)
  && !/adr-region[\s\S]{0,120}省\/市\/区/.test(shopJs))

if (fail) {
  console.error(`\n❌ buyer address checkout tests failed: ${fail}`)
  for (const f of failures) console.error(f)
  process.exit(1)
}
console.log(`\n✅ buyer address checkout: ${pass} assertions passed`)
