#!/usr/bin/env tsx
/**
 * 满额免邮(跨境 S2)—— 写入校验 + 整数 units 阈值判定 + 建单 gate 透传 + 两轨快照证据 + 询价不适用。
 * Usage: npm run test:shipping-free-threshold
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'sft-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const ST = await import('../src/shipping-templates.js')
const { toUnits } = await import('../src/money.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const TT = await import('../src/trade-terms.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initSystemUser(db); initOrderChainSchema(db)

// ── ① 写入校验 ──
{
  const p1 = ST.parseShippingTemplate([{ region: 'SG', fee: 5, free_threshold: 100 }])
  ok('1a. valid threshold accepted + rounded', p1.ok && p1.entries?.[0].free_threshold === 100)
  ok('1b. threshold on fee=0 entry rejected (meaningless config)', !ST.parseShippingTemplate([{ region: 'CN', fee: 0, free_threshold: 50 }]).ok)
  ok('1c. non-positive rejected', !ST.parseShippingTemplate([{ region: 'SG', fee: 5, free_threshold: 0 }]).ok && !ST.parseShippingTemplate([{ region: 'SG', fee: 5, free_threshold: -1 }]).ok)
  ok('1d. NaN rejected', !ST.parseShippingTemplate([{ region: 'SG', fee: 5, free_threshold: 'abc' }]).ok)
  ok('1e. entries without threshold unchanged (backward compat)', (() => { const p = ST.parseShippingTemplate([{ region: 'SG', fee: 5 }]); return p.ok && p.entries?.[0].free_threshold === undefined })())
}

// ── ② 阈值判定(整数 units,精确边界) ──
{
  const tpl = [{ region: 'SG', fee: 5, free_threshold: 100 }, { region: '*', fee: 25 }]
  ok('2a. below threshold → full fee', ST.resolveShipping(tpl, 'SG', toUnits(99.99)).fee === 5 && !ST.resolveShipping(tpl, 'SG', toUnits(99.99)).freeThresholdApplied)
  ok('2b. exactly at threshold → waived (>=)', ST.resolveShipping(tpl, 'SG', toUnits(100)).fee === 0 && ST.resolveShipping(tpl, 'SG', toUnits(100)).freeThresholdApplied === true)
  ok('2c. above threshold → waived', ST.resolveShipping(tpl, 'SG', toUnits(250)).fee === 0)
  ok('2d. no subtotal passed → no waiver (backward compat)', ST.resolveShipping(tpl, 'SG').fee === 5)
  ok('2e. wildcard entry without threshold unaffected', ST.resolveShipping(tpl, 'US', toUnits(999)).fee === 25)
  ok('2f. est_days survives waiver', (() => { const r = ST.resolveShipping([{ region: 'SG', fee: 5, est_days: '3-5', free_threshold: 10 }], 'SG', toUnits(10)); return r.fee === 0 && r.est_days === '3-5' })())
}

// ── ③ 建单 gate 透传(mock res) ──
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','b','buyer','kb'),('s1','s','seller','ks')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,stock,shipping_template) VALUES
  ('p1','s1','T','d',120,10,'[{"region":"SG","fee":5,"free_threshold":100}]')`).run()
{
  const out: { status: number; body: unknown } = { status: 200, body: null }
  const res = { status: (n: number) => ({ json: (b: unknown) => { out.status = n; out.body = b } }) } as never
  const g1 = ST.gateShippingForCreate(db, res, { shipping_template: '[{"region":"SG","fee":5,"free_threshold":100}]' }, 's1', 'SG', 'escrow', toUnits(120))
  ok('3a. gate waives fee at subtotal ≥ threshold', g1 !== null && g1.fee === 0 && g1.feeU === 0 && g1.freeThresholdApplied === true)
  const g2 = ST.gateShippingForCreate(db, res, { shipping_template: '[{"region":"SG","fee":5,"free_threshold":100}]' }, 's1', 'SG', 'escrow', toUnits(50))
  ok('3b. gate charges below threshold', g2 !== null && g2.fee === 5 && !g2.freeThresholdApplied)
}

// ── ④ dp 建单:免邮进快照证据 ──
{
  const SNAP = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG'], perTxCapUnits: 500_000_000, sellerBreakerTripped: false, decisionCode: 'OK' }
  let n = 0
  const { orderId } = createDirectPayOrder(db, { generateId: (p: string) => `${p}_${++n}`, transition, appendOrderEvent } as never, {
    productId: 'p1', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 120, totalAmount: 120,
    instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600e3).toISOString(),
    shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP, acceptMode: 'auto',
    shipping: { region: 'SG', fee: 0, estDays: null, freeThresholdApplied: true },
  })
  const snap = TT.readTradeTermsSnapshot((db.prepare('SELECT trade_terms_snapshot t FROM orders WHERE id=?').get(orderId) as { t: string | null }).t)
  ok('4. snapshot records free_threshold_applied (争议对账:0 运费是免出来的)', snap?.shipping.free_threshold_applied === true)
}

// ── ⑤ 静态:orders-create 传券后货款;询价路径不经 resolve;UI free: token;label i18n ──
{
  const OC = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  ok('5a. create passes post-coupon goods subtotal into the gate', /gateShippingForCreate\(db, res,[\s\S]{0,300}?priceAfterCouponU\); if \(!_ship\) return/.test(OC))
  const PA = readFileSync('src/pwa/routes/direct-pay-pending-accept.ts', 'utf8')
  ok('5b. quote path does NOT consult thresholds (human-priced quote authoritative)', !/free_threshold|freeThresholdApplied|resolveShipping/.test(PA))
  const UI = readFileSync('src/pwa/public/app-order-accept-ui.js', 'utf8')
  ok('5c. UI serializes + parses free:N token', /free:' \+ e\.free_threshold/.test(UI) && /startsWith\('free:'\)/.test(UI))
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('5d. updated template label has EN parity', I18N.includes("'运费模板(每行:地区代码 运费 [预计时效] [free:满额免邮阈值];* 为其余地区兜底)':"))
}

if (fail > 0) { console.error(`\n❌ shipping-free-threshold FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ shipping free threshold (S2): write validation (fee=0 rejected) + integer-units boundary (>=) + gate passthrough + dp snapshot evidence + quote path exempt + UI token\n  ✅ pass ${pass}`)
