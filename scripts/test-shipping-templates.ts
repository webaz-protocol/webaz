#!/usr/bin/env tsx
/**
 * 运费模板(PR-2)—— 域校验/匹配 + 建单守门 + dp 快照 + 设置/查询端点 + 静态接线锚。
 * Usage: npm run test:shipping-templates
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'shiptpl-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const { initNotificationSchema } = await import('../src/layer2-business/L2-6-notifications/notification-engine.js')
const ST = await import('../src/shipping-templates.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const { registerShippingTemplateRoutes } = await import('../src/pwa/routes/shipping-templates.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initOrderChainSchema(db); initNotificationSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('b1','b1','buyer','k_b1')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',50,10)").run()

// ── ① 域:parse 校验矩阵 ──
{
  ok('1. valid template normalizes (region uppercase, fee rounded)', (() => {
    const r = ST.parseShippingTemplate([{ region: ' cn ', fee: 5.999 }, { region: '*', fee: 25, est_days: '10-20' }])
    return r.ok && r.entries!.length === 2 && r.entries![0].region === 'CN' && r.entries![0].fee === 6 && r.entries![1].region === '*'
  })())
  ok('2. null / [] = clear', ST.parseShippingTemplate(null).ok && (ST.parseShippingTemplate([]) as { entries: unknown }).entries === null)
  ok('3. duplicate region rejected', !ST.parseShippingTemplate([{ region: 'CN', fee: 1 }, { region: 'cn', fee: 2 }]).ok)
  ok('4. negative / NaN / oversized fee rejected', !ST.parseShippingTemplate([{ region: 'CN', fee: -1 }]).ok
    && !ST.parseShippingTemplate([{ region: 'CN', fee: 'x' }]).ok && !ST.parseShippingTemplate([{ region: 'CN', fee: 2_000_000 }]).ok)
  ok('5. non-array rejected', !ST.parseShippingTemplate({ region: 'CN', fee: 1 }).ok)
  ok('6. resolveShipping: exact beats wildcard; uncovered without *', (() => {
    const t = [{ region: 'CN', fee: 0 }, { region: '*', fee: 25 }]
    return ST.resolveShipping(t, 'CN').fee === 0 && ST.resolveShipping(t, 'US').fee === 25 && ST.resolveShipping(t, 'US').matched === 'wildcard'
      && ST.resolveShipping([{ region: 'CN', fee: 0 }], 'US').covered === false
  })())
}

// ── ② 建单守门 gateShippingForCreate ──
const resStub = (): { status: (n: number) => { json: (b: unknown) => void }; _code: number | null; _body: Record<string, unknown> | null } => {
  const r = { _code: null as number | null, _body: null as Record<string, unknown> | null, status(n: number) { r._code = n; return { json(b: unknown) { r._body = b as Record<string, unknown> } } } }
  return r as never
}
{
  const r1 = resStub()
  const g1 = ST.gateShippingForCreate(db, r1 as never, { shipping_template: null }, 's1', 'us')
  ok('7. no template = pass-through (region normalized, fee 0)', !!g1 && g1.feeU === 0 && g1.region === 'US')
  db.prepare("UPDATE users SET store_shipping_template = ? WHERE id='s1'").run(JSON.stringify([{ region: 'CN', fee: 0, est_days: '2-4' }, { region: 'SG', fee: 5 }]))
  const r2 = resStub()
  ok('8. store template + no region → 400 SHIP_REGION_REQUIRED', ST.gateShippingForCreate(db, r2 as never, { shipping_template: null }, 's1', undefined) === null
    && r2._code === 400 && (r2._body as { error_code: string }).error_code === 'SHIP_REGION_REQUIRED')
  const r3 = resStub()
  ok('9. uncovered region → 409 SHIP_REGION_NOT_COVERED', ST.gateShippingForCreate(db, r3 as never, { shipping_template: null }, 's1', 'US') === null
    && r3._code === 409 && (r3._body as { error_code: string }).error_code === 'SHIP_REGION_NOT_COVERED')
  const g4 = ST.gateShippingForCreate(db, resStub() as never, { shipping_template: null }, 's1', 'sg')
  ok('10. covered region → fee from store template', !!g4 && g4.fee === 5 && g4.region === 'SG')
  // 单品覆盖优先于店铺默认
  const g5 = ST.gateShippingForCreate(db, resStub() as never, { shipping_template: JSON.stringify([{ region: 'SG', fee: 2, est_days: '1-2' }]) }, 's1', 'SG')
  ok('11. product template overrides store default', !!g5 && g5.fee === 2 && g5.estDays === '1-2')
  const r6 = resStub()
  ok('12. product template narrows coverage (store had CN, product only SG → CN now uncovered)',
    ST.gateShippingForCreate(db, r6 as never, { shipping_template: JSON.stringify([{ region: 'SG', fee: 2 }]) }, 's1', 'CN') === null && r6._code === 409)
  db.prepare("UPDATE users SET store_shipping_template = NULL WHERE id='s1'").run()
}

// ── ③ dp 建单快照三列 ──
{
  let n = 0
  const oid = createDirectPayOrder(db, { generateId: (p: string) => `${p}_${++n}`, transition, appendOrderEvent } as never, {
    productId: 'p', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 50, totalAmount: 55,
    instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600_000).toISOString(),
    shippingAddress: 'addr', accountSnapshot: null, acceptMode: 'auto',
    shipping: { region: 'SG', fee: 5, estDays: '3-5' },
    snapshot: { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG'], perTxCapUnits: 60_000_000, sellerBreakerTripped: false, decisionCode: 'OK' },
  }).orderId
  const o = db.prepare('SELECT ship_to_region, shipping_fee, shipping_est_days, total_amount FROM orders WHERE id = ?').get(oid) as Record<string, unknown>
  ok('13. dp order snapshots region/fee/est_days; total includes fee', o.ship_to_region === 'SG' && Number(o.shipping_fee) === 5 && o.shipping_est_days === '3-5' && Number(o.total_amount) === 55)
}

// ── ④ HTTP:设置 + 公开查询端点 ──
const app = express(); app.use(express.json())
registerShippingTemplateRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: uid === 's1' ? 'seller' : 'buyer' } },
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
} as never)
let server!: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
const call = (method: string, path: string, uid?: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
  rq.on('error', reject); if (body) rq.write(JSON.stringify(body)); rq.end()
})
try {
  ok('14. buyer cannot set template (403)', (await call('POST', '/api/seller/shipping-template', 'b1', { store_template: [] })).status === 403)
  ok('15. seller sets store template', (await call('POST', '/api/seller/shipping-template', 's1', { store_template: [{ region: 'cn', fee: 0 }, { region: '*', fee: 25 }] })).status === 200
    && !!(db.prepare("SELECT store_shipping_template t FROM users WHERE id='s1'").get() as { t: string }).t)
  ok('16. invalid template rejected 400', (await call('POST', '/api/seller/shipping-template', 's1', { store_template: [{ region: 'CN', fee: -3 }] })).status === 400)
  ok('17. per-product override set', (await call('POST', '/api/seller/shipping-template', 's1', { product_id: 'p', template: [{ region: 'SG', fee: 3 }] })).status === 200)
  // 审计 P2 回归:{product_id, store_free_shipping_threshold} 组合绝不能把商品模板静默清成 NULL(template 分支只认 'template' in b)
  await call('POST', '/api/seller/shipping-template', 's1', { product_id: 'p', store_free_shipping_threshold: 200 })
  ok('17b. store-threshold combo with product_id does NOT wipe the product template', !!(db.prepare("SELECT shipping_template t FROM products WHERE id='p'").get() as { t: string | null }).t)
  const opts = await call('GET', '/api/products/p/shipping-options')
  ok('18. public shipping-options resolves product override (source=product)', opts.status === 200 && opts.json.region_required === true
    && (opts.json.template as Array<{ region: string }>).length === 1 && opts.json.source === 'product')
  await call('POST', '/api/seller/shipping-template', 's1', { product_id: 'p', template: null })
  const opts2 = await call('GET', '/api/products/p/shipping-options')
  ok('19. clearing product override falls back to store (source=store)', opts2.json.source === 'store' && (opts2.json.template as Array<{ region: string }>).length === 2)
  await call('POST', '/api/seller/shipping-template', 's1', { store_template: null })
  const opts3 = await call('GET', '/api/products/p/shipping-options')
  ok('20. no template anywhere → region_required=false', opts3.json.region_required === false && opts3.json.template === null)
} finally { server.close() }

// ── ⑤ 静态接线锚:orders-create 守门 + 运费并入总额 + 快照列 + dp 透传 ──
{
  const OC = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  ok('21. orders-create calls gateShippingForCreate BEFORE totals (both rails share)', /gateShippingForCreate\(db, res, product/.test(OC))
  ok('22. shipping fee joins totalAmountU', /priceAfterCouponU \+ insurancePremiumU \+ _ship\.feeU/.test(OC))
  ok('23. escrow INSERT snapshots the 3 shipping cols', /ship_to_region, shipping_fee, shipping_est_days/.test(OC))
  ok('24. dp ctx passes shipping snapshot (+quoteRequired PR-3, +freeThresholdApplied S2)', /shipping: \{ region: _ship\.region, fee: _ship\.fee, estDays: _ship\.estDays, quoteRequired: _ship\.quoteRequired, freeThresholdApplied: _ship\.freeThresholdApplied \}/.test(OC))
}

if (fail > 0) { console.error(`\n❌ shipping-templates FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ shipping templates (PR-2): parse/resolve matrix + create gate (required/uncovered/override precedence) + dp snapshot + settings/public-options endpoints + wiring anchors\n  ✅ pass ${pass}`)
