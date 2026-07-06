#!/usr/bin/env tsx
/**
 * 买家下单前【购买条款聚合】(S5)—— GET /products/:id/shipping-options?ship_to_region 只读聚合 S1-S4 判定:
 *   可售裁定(平台合规 > 商家可售区;product ?? store)+ 目的区运费(covered/quote_required)+ 满额免邮阈值(product ?? store)
 *   + DDP/DDU + 价内含税(按目的区过滤)+ 平台不代收税声明。不动订单金额、不收税、不建单。
 * Usage: npm run test:purchase-terms
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'pterms-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerShippingTemplateRoutes } = await import('../src/pwa/routes/shipping-templates.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db)
db.exec("CREATE TABLE IF NOT EXISTS protocol_params (key TEXT PRIMARY KEY, value TEXT, type TEXT)")

// 卖家店铺默认:模板覆盖 SG(费 8,时效 3-6);满额免邮 200;DDU;价内 SG GST 9%;可售区 = 仅 SG,MY
db.prepare(`INSERT INTO users (id,name,role,api_key,store_shipping_template,store_shipping_quote_ok,store_free_shipping_threshold,store_import_duty_terms,store_tax_lines,store_sale_regions) VALUES
  ('s1','s','seller','ks',?,0,200,'ddu',?,?)`).run(
  JSON.stringify([{ region: 'SG', fee: 8, est_days: '3-6' }]),
  JSON.stringify([{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }]),
  JSON.stringify({ mode: 'list', include: ['SG', 'MY'] }))

// p_store:全继承店铺默认(无任何单品覆盖)
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p_store','s1','T','d',120,10)").run()
// p_override:单品全面覆盖店铺 —— 可售区仅 JP、免邮阈值 50、DDP、模板覆盖 JP(费 20)、模板外可询价
db.prepare(`UPDATE products SET shipping_template=?, shipping_quote_ok=1, free_shipping_threshold=50, import_duty_terms='ddp', sale_regions=? WHERE id='p_override'`).run(
  JSON.stringify([{ region: 'JP', fee: 20, est_days: '5-9' }]), JSON.stringify({ mode: 'list', include: ['JP'] }))
// UPDATE 前需先存在
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p_override','s1','T','d',120,10)").run()
db.prepare(`UPDATE products SET shipping_template=?, shipping_quote_ok=1, free_shipping_threshold=50, import_duty_terms='ddp', sale_regions=? WHERE id='p_override'`).run(
  JSON.stringify([{ region: 'JP', fee: 20, est_days: '5-9' }]), JSON.stringify({ mode: 'list', include: ['JP'] }))
// p_quote:模板仅覆盖 SG,开询价;无可售区限制
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,shipping_template,shipping_quote_ok) VALUES ('p_quote','s1','T','d',120,10,?,1)").run(
  JSON.stringify([{ region: 'SG', fee: 8 }]))

const app = express(); app.use(express.json())
registerShippingTemplateRoutes(app, {
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null }; return db.prepare('SELECT * FROM users WHERE id=?').get(uid) as Record<string, unknown> },
  errorRes: (res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, error_code: code }),
} as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
type Resp = { status: number; json: Record<string, unknown> }
const get = (path: string): Promise<Resp> => new Promise((resolve, reject) => {
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api' + path }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} })) })
  rq.on('error', reject); rq.end()
})

try {
  // ── ① 店铺默认生效(全继承)──
  {
    const r = await get('/products/p_store/shipping-options?ship_to_region=SG')
    ok('1a. store default: sellable ok for allowed SG', (r.json.sellable as { ok: boolean }).ok === true)
    ok('1b. store default: free_shipping_threshold inherits store (200)', r.json.free_shipping_threshold === 200)
    ok('1c. store default: DDU inherited', r.json.import_duty_terms === 'ddu')
    ok('1d. store default: SG GST tax line disclosed', (r.json.tax_included_lines as { label: string }[]).some(l => l.label === 'GST'))
    ok('1e. store default: SG covered via store template (fee 8)', (r.json.resolved_shipping as { covered: boolean; fee: number }).covered === true && (r.json.resolved_shipping as { fee: number }).fee === 8)
  }

  // ── ② 单品覆盖【压过】店铺默认 ──
  {
    const jp = await get('/products/p_override/shipping-options?ship_to_region=JP')
    ok('2a. override: JP sellable ok (product sale_regions=JP, not store SG/MY)', (jp.json.sellable as { ok: boolean }).ok === true)
    ok('2b. override: free_shipping_threshold=50 beats store 200', jp.json.free_shipping_threshold === 50)
    ok('2c. override: DDP beats store DDU', jp.json.import_duty_terms === 'ddp')
    ok('2d. override: JP covered via product template (fee 20)', (jp.json.resolved_shipping as { covered: boolean; fee: number }).covered === true && (jp.json.resolved_shipping as { fee: number }).fee === 20)
    // 店铺默认允许 SG,但单品可售区收窄为仅 JP → SG 不可售(单品覆盖生效,不回落店铺可售区)
    const sg = await get('/products/p_override/shipping-options?ship_to_region=SG')
    ok('2e. override: product sale_regions narrows out SG (reason region_not_for_sale)', (sg.json.sellable as { ok: boolean; reason: string }).ok === false && (sg.json.sellable as { reason: string }).reason === 'region_not_for_sale')
  }

  // ── ③ 可售区限制:未选目的地 → region_required;不销往区 → region_not_for_sale ──
  {
    const none = await get('/products/p_store/shipping-options')
    ok('3a. sale rule + no ship_to_region → sellable.reason=region_required', (none.json.sellable as { ok: boolean; reason: string }).ok === false && (none.json.sellable as { reason: string }).reason === 'region_required')
    ok('3b. region_required flag true when restricted', none.json.region_required === true)
    const de = await get('/products/p_store/shipping-options?ship_to_region=DE')
    ok('3c. DE not in store sale_regions → region_not_for_sale', (de.json.sellable as { reason: string }).reason === 'region_not_for_sale')
  }

  // ── ④ 平台合规 blocklist:商家不可放宽(优先于商家可售区)──
  {
    db.prepare("INSERT OR REPLACE INTO protocol_params (key,value,type) VALUES ('trade.platform_region_blocklist','[\"KP\"]','json')").run()
    // 让 p_store 可售区包含 KP 的反例不成立(店铺 include 仅 SG,MY);改测一个 include KP 的单品覆盖仍被平台挡
    db.prepare("UPDATE products SET sale_regions=? WHERE id='p_quote'").run(JSON.stringify({ mode: 'list', include: ['KP', 'SG'] }))
    const kp = await get('/products/p_quote/shipping-options?ship_to_region=KP')
    ok('4a. platform blocklist rejects KP even when seller lists it (reason product_restricted)', (kp.json.sellable as { ok: boolean; reason: string }).ok === false && (kp.json.sellable as { reason: string }).reason === 'product_restricted')
    db.prepare("UPDATE products SET sale_regions=NULL WHERE id='p_quote'").run()   // 复位供后续询价用例
    db.prepare("DELETE FROM protocol_params WHERE key='trade.platform_region_blocklist'").run()
  }

  // ── ⑤ 询价:模板外地区 → quote_required 浮现 ──
  {
    const de = await get('/products/p_quote/shipping-options?ship_to_region=DE')
    ok('5a. outside-template region with quote_ok → resolved_shipping.quote_required', (de.json.resolved_shipping as { covered: boolean; quote_required: boolean }).covered === false && (de.json.resolved_shipping as { quote_required: boolean }).quote_required === true)
    ok('5b. quote_outside_template surfaced', de.json.quote_outside_template === true)
    const sg = await get('/products/p_quote/shipping-options?ship_to_region=SG')
    ok('5c. covered region is not quote-required', (sg.json.resolved_shipping as { covered: boolean; quote_required: boolean }).covered === true && (sg.json.resolved_shipping as { quote_required: boolean }).quote_required === false)
  }

  // ── ⑥ 税/进口披露 + 平台不代收声明恒定 + 无钱路语义 ──
  {
    const r = await get('/products/p_store/shipping-options?ship_to_region=SG')
    ok('6a. tax_disclosure constant = seller_declared_platform_no_collect', r.json.tax_disclosure === 'seller_declared_platform_no_collect')
    ok('6b. response carries no price/total field (read-only aggregation, no money path)', !('total_amount' in r.json) && !('total' in r.json) && !('price' in r.json))
    // 目的区过滤:MY 无 MY 专属税且店铺 GST 标 SG → MY 不应误示 SG GST(仅当有 '*' 才通用)
    const my = await get('/products/p_store/shipping-options?ship_to_region=MY')
    ok('6c. tax lines region-filtered: MY does not leak SG-only GST', (my.json.tax_included_lines as { region: string }[]).every(l => l.region !== 'SG'))
  }

  // ── ⑦ 静态:UI 装载 + 买单页注入 + 区变刷新接线 + i18n parity ──
  {
    const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
    const APPJS = readFileSync('src/pwa/public/app.js', 'utf8')
    const ACC = readFileSync('src/pwa/public/app-order-accept-ui.js', 'utf8')
    const UI = readFileSync('src/pwa/public/app-purchase-terms-ui.js', 'utf8')
    ok('7a. module loaded in index.html', HTML.includes('app-purchase-terms-ui.js'))
    ok('7b. buy sheet injects purchaseTermsBlockHtml (net-zero of old tradeTaxBlockHtml)', /purchaseTermsBlockHtml \? window\.purchaseTermsBlockHtml/.test(APPJS) && !/tradeTaxBlockHtml/.test(APPJS))
    ok('7c. region selector refreshes via _purchaseTermsRefresh (both onchange + oninput)', (ACC.match(/_purchaseTermsRefresh/g) || []).length >= 2 && !/_tradeTaxRefresh/.test(ACC))
    ok('7d. card consumes S5 fields + states platform no-collect', /sellable/.test(UI) && /resolved_shipping/.test(UI) && /free_shipping_threshold/.test(UI) && /平台不代收代缴/.test(UI))
    const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
    const keys = new Set<string>()
    for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
    const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
    ok('7e. i18n parity', keys.size >= 12 && noEn.length === 0, noEn.slice(0, 3).join(' | '))
  }
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ purchase-terms FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ buyer pre-checkout purchase terms (S5, read-only aggregation): sellable verdict (platform>seller, product??store) + resolved shipping/quote + free-ship threshold hierarchy + DDP/DDU + region-filtered tax + no-collect disclosure + no money path\n  ✅ pass ${pass}`)
