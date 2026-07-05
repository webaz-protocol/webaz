#!/usr/bin/env tsx
/**
 * 跨境交易条款快照(S0)—— schema 列就位 + 建单冻结 + 事后改设置不影响旧单 + 询价补记 + 清关字段路由校验。
 *   刻意验证:sale_regions/tax_lines/import_duty_terms 列存在但【不被商品 API 接受】(不上假开关,S1/S3 才开)。
 * Usage: npm run test:trade-terms-snapshot
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'tts-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const TT = await import('../src/trade-terms.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db); initSystemUser(db); initOrderChainSchema(db)

// ── ① fresh DB schema:S0 列全部就位(ALTER AFTER CREATE 铁律的 silent-fail 防线) ──
{
  const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name)
  const pc = cols('products'); const uc = cols('users'); const oc = cols('orders')
  ok('1a. products S0 columns', ['package_size', 'origin_country', 'country_of_origin', 'customs_description', 'hs_code', 'sale_regions', 'tax_lines', 'import_duty_terms'].every(c => pc.includes(c)))
  ok('1b. users store-level columns', ['store_sale_regions', 'store_tax_lines', 'store_import_duty_terms'].every(c => uc.includes(c)))
  ok('1c. orders.trade_terms_snapshot', oc.includes('trade_terms_snapshot'))
}

for (const c of ['weight_kg REAL', 'estimated_days TEXT', 'return_condition TEXT', 'warranty_days INTEGER']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${c}`) } catch { /* 已存在 */ } }   // 商品扩展列历史上在 server.ts 迁移段,bare init+bridge 缺(test 前置补齐)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','b','buyer','kb'),('s1','s','seller','ks')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,stock,handling_hours,estimated_days,return_days,return_condition,warranty_days,weight_kg,ship_regions,package_size,origin_country,country_of_origin,customs_description,hs_code)
  VALUES ('p1','s1','T','d',50,10,24,'5-9',7,'unopened',0,1.2,'全国','30x20x10 cm','SG','CN','ceramic mug','6912.00')`).run()

// ── ② dp 建单冻结快照 ──
const SNAP = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG'], perTxCapUnits: 50_000_000, sellerBreakerTripped: false, decisionCode: 'OK' }
let n = 0; const generateId = (p: string): string => `${p}_${++n}`
const deps = { generateId, transition, appendOrderEvent }
const { orderId } = createDirectPayOrder(db, deps as never, {
  productId: 'p1', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 50, totalAmount: 55,
  instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600e3).toISOString(),
  shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP, acceptMode: 'auto',
  shipping: { region: 'SG', fee: 5, estDays: '3-5' },
})
const snapOf = (id: string): Record<string, any> | null => TT.readTradeTermsSnapshot((db.prepare('SELECT trade_terms_snapshot t FROM orders WHERE id=?').get(id) as { t: string | null }).t)
{
  const s = snapOf(orderId)
  ok('2a. dp create freezes snapshot (v1)', !!s && s.v === 1, JSON.stringify(s)?.slice(0, 80))
  ok('2b. shipping ruling recorded (template SG fee=5)', s?.shipping.source === 'template' && s?.shipping.region === 'SG' && s?.shipping.fee === 5)
  ok('2c. fulfilment promises frozen', s?.fulfilment.return_days === 7 && s?.fulfilment.handling_hours === 24 && s?.fulfilment.estimated_days === '5-9')
  ok('2d. customs/logistics evidence frozen', s?.logistics.hs_code === '6912.00' && s?.logistics.country_of_origin === 'CN' && s?.logistics.weight_kg === 1.2 && s?.logistics.package_size === '30x20x10 cm')
  ok('2e. reserved slots null until S1/S3', s?.declarations.sale_regions_rule === null && s?.declarations.tax_lines === null && s?.declarations.import_duty_terms === null)
  ok('2f. accept_mode recorded', s?.accept_mode === 'auto')
}

// ── ③ 事后改设置不影响旧单(快照不可变) ──
{
  db.prepare("UPDATE products SET return_days = 30, hs_code = '9999.99', handling_hours = 72 WHERE id = 'p1'").run()
  const s = snapOf(orderId)
  ok('3. seller edits after order do NOT alter the frozen snapshot', s?.fulfilment.return_days === 7 && s?.logistics.hs_code === '6912.00' && s?.fulfilment.handling_hours === 24)
}

// ── ④ 询价单:quote_pending → confirm 后补记 quote 裁决 ──
{
  const { orderId: oq } = createDirectPayOrder(db, deps as never, {
    productId: 'p1', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 50, totalAmount: 50,
    instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600e3).toISOString(),
    shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP, acceptMode: 'auto',
    pendingAcceptDeadlineIso: new Date(Date.now() + 48 * 3600e3).toISOString(),
    shipping: { region: 'US', fee: 0, estDays: null, quoteRequired: true },
  })
  ok('4a. quote order snapshot source=quote_pending, fee=null', snapOf(oq)?.shipping.source === 'quote_pending' && snapOf(oq)?.shipping.fee === null)
  TT.updateSnapshotShippingQuote(db, oq, 25, '10-20')
  const s = snapOf(oq)
  ok('4b. quote confirmation merges ruling (source=quote fee=25), other slots untouched', s?.shipping.source === 'quote' && s?.shipping.fee === 25 && s?.fulfilment.return_days === 30)
}

// ── ⑤ readTradeTermsSnapshot 容错(pre-S0 旧单/坏 JSON → null) ──
ok('5. parse tolerates null/garbage', TT.readTradeTermsSnapshot(null) === null && TT.readTradeTermsSnapshot('not json') === null && TT.readTradeTermsSnapshot('{"v":2}') === null)

// ── ⑥ 静态接线:两轨建单 + 询价确认 + DTO + 列表剥离 ──
{
  const OC = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  const PA = readFileSync('src/pwa/routes/direct-pay-pending-accept.ts', 'utf8')
  const OR = readFileSync('src/pwa/routes/orders-read.ts', 'utf8')
  ok('6a. escrow create writes snapshot after INSERT', /writeTradeTermsSnapshot\(db, orderId, buildTradeTermsSnapshot/.test(OC))
  ok('6b. confirm-quote merges shipping ruling', /updateSnapshotShippingQuote\(db, order\.id, feeR/.test(PA))
  ok('6c. order detail exposes parsed trade_terms, raw column never serialized', /order\.trade_terms = readTradeTermsSnapshot\(order\.trade_terms_snapshot\); delete order\.trade_terms_snapshot/.test(OR) && /delete o\.trade_terms_snapshot/.test(OR))
}

// ── ⑦ 商品路由:清关字段接受+校验;保留槽【不】接受(不上假开关) ──
{
  const PC = readFileSync('src/pwa/routes/products-create.ts', 'utf8')
  const PU = readFileSync('src/pwa/routes/products-update.ts', 'utf8')
  ok('7a. create accepts the 5 customs fields + validates hs_code', /package_size, origin_country, country_of_origin, customs_description, hs_code/.test(PC) && /INVALID_HS_CODE/.test(PC))
  ok('7b. update accepts them with explicit-null-clears semantics', /INVALID_HS_CODE/.test(PU) && /=== undefined \? product\.hs_code/.test(PU))
  ok('7c. reserved fields NOT accepted anywhere yet (sale_regions/tax_lines/import_duty_terms)',
    !/req\.body[\s\S]{0,200}?sale_regions/.test(PC) && !/\bsale_regions\b/.test(PC.split('} = req.body')[0].split('const {').slice(1).join('')) && !/import_duty_terms/.test(PC) && !/tax_lines/.test(PU))
}

if (fail > 0) { console.error(`\n❌ trade-terms-snapshot FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ trade-terms snapshot (S0): schema + both-rail freeze + immutability after seller edits + quote merge + null-tolerant parse + no fake switches\n  ✅ pass ${pass}`)
