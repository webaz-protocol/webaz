#!/usr/bin/env tsx
/**
 * 满额免邮(营销域,S2 —— 用户裁定从运费模板返工至营销)。
 *   不变量:模板=纯成本结构(条目无促销字段);免邮=营销规则(店铺+单品双层),gate 在模板费为正时应用;
 *   券后货款整数 units 比较;询价路径天然豁免;快照 free_threshold_applied 留证。
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
const FS = await import('../src/free-shipping.js')
const { toUnits } = await import('../src/money.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const TT = await import('../src/trade-terms.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initSystemUser(db); initOrderChainSchema(db)
try { db.exec('ALTER TABLE orders ADD COLUMN draft_id TEXT') } catch { /* RFC-026 PR-1:生产由 runtime helper 加;裸 initDatabase fixture 补上以匹配 */ }
db.prepare("INSERT INTO users (id,name,role,api_key,store_free_shipping_threshold) VALUES ('b1','b','buyer','kb',NULL),('s1','s','seller','ks',NULL),('s2','s2','seller','k2',200)").run()

// ── ① 写入校验(营销域) ──
{
  ok('1a. valid threshold normalized', 'value' in FS.validateFreeShippingThreshold('100.005') && (FS.validateFreeShippingThreshold('100.005') as { value: number }).value === 100.01)
  ok('1b. null/empty clears', (FS.validateFreeShippingThreshold(null) as { value: null }).value === null && (FS.validateFreeShippingThreshold('') as { value: null }).value === null)
  ok('1c. non-positive/NaN rejected', 'error' in FS.validateFreeShippingThreshold(0) && 'error' in FS.validateFreeShippingThreshold(-5) && 'error' in FS.validateFreeShippingThreshold('abc'))
}

// ── ② 生效层级:商品 ?? 店铺 ──
{
  ok('2a. store threshold applies when product has none', FS.effectiveFreeShippingThreshold(db, { free_shipping_threshold: null }, 's2') === 200)
  ok('2b. product overrides store', FS.effectiveFreeShippingThreshold(db, { free_shipping_threshold: 50 }, 's2') === 50)
  ok('2c. neither → null (no rule)', FS.effectiveFreeShippingThreshold(db, { free_shipping_threshold: null }, 's1') === null)
}

// ── ③ 判免(整数 units 边界)+ gate 集成 ──
{
  ok('3a. exact boundary waives (>=)', FS.freeShippingWaives(db, { free_shipping_threshold: 100 }, 's1', toUnits(100)) === true)
  ok('3b. below does not', FS.freeShippingWaives(db, { free_shipping_threshold: 100 }, 's1', toUnits(99.99)) === false)
  const res = { status: () => ({ json: () => {} }) } as never
  const tplProd = { shipping_template: '[{"region":"SG","fee":5}]', free_shipping_threshold: 100 }
  const g1 = ST.gateShippingForCreate(db, res, tplProd, 's1', 'SG', 'escrow', toUnits(120))
  ok('3c. gate waives template fee via marketing rule', g1 !== null && g1.fee === 0 && g1.feeU === 0 && g1.freeThresholdApplied === true)
  const g2 = ST.gateShippingForCreate(db, res, tplProd, 's1', 'SG', 'escrow', toUnits(50))
  ok('3d. below threshold → full fee, no flag', g2 !== null && g2.fee === 5 && !g2.freeThresholdApplied)
  const g3 = ST.gateShippingForCreate(db, res, { shipping_template: '[{"region":"SG","fee":0}]', free_shipping_threshold: 10 }, 's1', 'SG', 'escrow', toUnits(120))
  ok('3e. fee=0 template entry → no marketing flag (nothing to waive)', g3 !== null && g3.fee === 0 && !g3.freeThresholdApplied)
  const g4 = ST.gateShippingForCreate(db, res, tplProd, 's1', 'SG', 'escrow')
  ok('3f. no subtotal passed → no waiver (backward compat)', g4 !== null && g4.fee === 5)
  const g5 = ST.gateShippingForCreate(db, res, { shipping_template: '[{"region":"SG","fee":5}]' }, 's2', 'SG', 'escrow', toUnits(250))
  ok('3g. store-level rule applies through gate', g5 !== null && g5.fee === 0 && g5.freeThresholdApplied === true)
}

// ── ④ 模板纯净:促销字段不再进条目 ──
{
  const p = ST.parseShippingTemplate([{ region: 'SG', fee: 5, free_threshold: 100 }])
  ok('4. template parse ignores promo fields (pure cost structure)', p.ok && p.entries?.[0] && !('free_threshold' in p.entries[0]))
}

// ── ⑤ dp 建单快照留证 ──
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,stock,shipping_template,free_shipping_threshold) VALUES
  ('p1','s1','T','d',120,10,'[{"region":"SG","fee":5}]',100)`).run()
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
  ok('5. snapshot records free_threshold_applied (争议对账:0 运费是免出来的)', snap?.shipping.free_threshold_applied === true)
}

// ── ⑥ 静态:域归属/gate 委托/询价豁免/路由分支/UI 营销卡/i18n ──
{
  const STF = readFileSync('src/shipping-templates.ts', 'utf8')
  ok('6a. template module has NO promo semantics; gate delegates to marketing module', !/free_threshold\b/.test(STF.replace(/free_shipping_threshold|freeThresholdApplied|freeShippingWaives/g, '')) && /freeShippingWaives\(db, product/.test(STF))
  const OC = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  ok('6b. create passes post-coupon goods subtotal into the gate', /gateShippingForCreate\(db, res,[\s\S]{0,300}?priceAfterCouponU\); if \(!_ship\) return/.test(OC))
  const PA = readFileSync('src/pwa/routes/direct-pay-pending-accept.ts', 'utf8')
  ok('6c. quote path never consults thresholds (human quote authoritative)', !/free_shipping|freeThresholdApplied|freeShippingWaives/.test(PA))
  const RT = readFileSync('src/pwa/routes/shipping-templates.ts', 'utf8')
  ok('6d. store + product write branches with validation', /store_free_shipping_threshold' in b/.test(RT) && /'product_id' in b && 'free_shipping_threshold' in b/.test(RT) && /BAD_FREE_SHIPPING_THRESHOLD/.test(RT))
  const APPJS = readFileSync('src/pwa/public/app.js', 'utf8')
  ok('6e. marketing tab hosts the card (net-zero hook)', /window\.freeShippingMarketingCard \? window\.freeShippingMarketingCard\(\) : ''/.test(APPJS))
  const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
  const UI = readFileSync('src/pwa/public/app-free-shipping-ui.js', 'utf8')
  ok('6f. module wired (index.html + save posts store_free_shipping_threshold)', HTML.includes('app-free-shipping-ui.js') && /store_free_shipping_threshold: raw === '' \? null : Number\(raw\)/.test(UI))
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  const keys = new Set<string>()
  for (const mm of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(mm[1])
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('6g. i18n parity', keys.size >= 7 && noEn.length === 0, noEn.slice(0, 2).join(' | '))
}

if (fail > 0) { console.error(`\n❌ shipping-free-threshold FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ free shipping (marketing domain): validation + product??store hierarchy + integer-units boundary + gate delegation (fee>0 only) + template purity + quote exempt + dp snapshot evidence + marketing-tab UI\n  ✅ pass ${pass}`)
