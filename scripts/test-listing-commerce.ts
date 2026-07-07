#!/usr/bin/env tsx
/**
 * 单链接商务覆盖(S4)—— listingCommerceSave 的服务端集成:三端点(accept-mode + shipping-template 全键一体 body
 *   + products PUT customs)一次保存全部单品覆盖并持久化;+ 静态接线锚(section 注入 add/edit 表单 + 保存钩子)。
 *   核心风险验证:/seller/shipping-template 一个 body 带全部键 → 各分支都触发、模板不被误清(P2 修后)。
 * Usage: npm run test:listing-commerce
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'lc-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerShippingTemplateRoutes } = await import('../src/pwa/routes/shipping-templates.js')
const { registerDirectPayPendingAcceptRoutes } = await import('../src/pwa/routes/direct-pay-pending-accept.js')
const { registerProductsCreateRoutes } = await import('../src/pwa/routes/products-create.js')
const { registerProductsCrudRoutes } = await import('../src/pwa/routes/products-crud.js')
const { registerProductsUpdateRoutes } = await import('../src/pwa/routes/products-update.js')
const { initOrderChainSchema } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s','seller','ks'),('s2','s2','seller','k2')").run()
db.prepare("INSERT OR IGNORE INTO wallets (user_id,balance) VALUES ('s1',500),('s2',500)").run()
// 商品非钱路扩展列已收进 base schema(initDatabase),无需再手动补。仅 commission_rate 是钱路字段(佣金),刻意不进共享 schema —— 单独补。
try { db.exec('ALTER TABLE products ADD COLUMN commission_rate REAL DEFAULT 0.10') } catch { /* 已有 */ }
db.exec("CREATE TABLE IF NOT EXISTS reputation_scores (user_id TEXT PRIMARY KEY, total_points REAL DEFAULT 0, level TEXT DEFAULT 'new')")
db.exec("CREATE TABLE IF NOT EXISTS product_external_links (id TEXT PRIMARY KEY, product_id TEXT, url TEXT, verified INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0)")
try { db.exec("ALTER TABLE product_external_links ADD COLUMN revoked INTEGER DEFAULT 0") } catch { /* 已有 */ }
try { db.exec("ALTER TABLE verify_tasks ADD COLUMN status TEXT") } catch { /* 已有 */ }
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock,shipping_template) VALUES ('p1','s1','T','d',50,10,'[{\"region\":\"CN\",\"fee\":0}]')").run()

const app = express(); app.use(express.json())
const authStub = (req: Request, res: Response): Record<string, unknown> | null => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null }; return db.prepare('SELECT * FROM users WHERE id=?').get(uid) as Record<string, unknown> }
const errorRes = (res: Response, status: number, code: string, msg: string): void => { res.status(status).json({ error: msg, error_code: code }) }
registerShippingTemplateRoutes(app, { auth: authStub, errorRes } as never)
registerDirectPayPendingAcceptRoutes(app, { db, auth: authStub, errorRes, getProtocolParam: (<T,>(_k: string, fb: T): T => fb) } as never)
const hashStub = { makeCommitmentHash: () => 'h', makeDescriptionHash: () => 'h', makePriceHash: () => 'h' }
registerProductsCreateRoutes(app, { db, auth: authStub, generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`, checkSellerCanList: () => ({ ok: true }), getStakeDiscount: async () => 0, VALID_PRODUCT_TYPES: new Set(['retail', 'wholesale', 'service', 'digital']), parsePlatformUrl: () => null, ...hashStub } as never)
registerProductsCrudRoutes(app, { db, auth: authStub, errorRes, formatProductForAgent: (p: Record<string, unknown>) => ({ ...p }), retireAnchorsByTarget: () => {} } as never)
registerProductsUpdateRoutes(app, { db, auth: authStub, ...hashStub, notifyWaitlist: () => {}, notifyWishlistPriceDrop: () => {}, checkStockAndMaybeDelist: () => {} } as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const call = (method: string, path: string, uid: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : ''
  const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path: '/api' + path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = d ? JSON.parse(d) : {} } catch { j = { _raw: d.slice(0, 300) } } resolve({ status: res.statusCode || 0, json: j }) }) })
  rq.on('error', reject); if (payload) rq.write(payload); rq.end()
})
const prod = (): Record<string, unknown> => db.prepare("SELECT * FROM products WHERE id='p1'").get() as Record<string, unknown>

try {
  // ── ① 全键一体 body(listingCommerceSave 发的形状)→ 各分支都持久化,模板不被误清 ──
  const body = {
    product_id: 'p1',
    template: [{ region: 'SG', fee: 5, est_days: '3-5' }],
    quote_ok: true,
    sale_regions: { mode: 'list', include: ['SG', 'MY'] },
    free_shipping_threshold: 100,
    import_duty_terms: 'ddu',
    tax_lines: [{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }],
  }
  const r = await call('POST', '/seller/shipping-template', 's1', body)
  ok('1a. all-keys body → 200', r.status === 200, JSON.stringify(r.json))
  const p = prod()
  ok('1b. template persisted (NOT nulled by the multi-key body)', JSON.parse(p.shipping_template as string)[0].region === 'SG')
  ok('1c. quote_ok persisted', Number(p.shipping_quote_ok) === 1)
  ok('1d. sale_regions persisted', JSON.parse(p.sale_regions as string).include.join(',') === 'SG,MY')
  ok('1e. free_shipping_threshold persisted', Number(p.free_shipping_threshold) === 100)
  ok('1f. import_duty_terms persisted', p.import_duty_terms === 'ddu')
  ok('1g. tax_lines persisted', JSON.parse(p.tax_lines as string)[0].label === 'GST')

  // ── ② accept-mode 单品(独立端点)──
  ok('2. accept-mode per-product persisted', (await call('POST', '/seller/accept-mode', 's1', { product_id: 'p1', accept_mode: 'manual' })).status === 200
    && (prod()).accept_mode === 'manual')

  // ── ③ "继承"(null)清除覆盖 ──
  const clr = await call('POST', '/seller/shipping-template', 's1', { product_id: 'p1', template: null, quote_ok: null, sale_regions: null, free_shipping_threshold: null, import_duty_terms: null, tax_lines: null })
  ok('3a. null across the board clears overrides (inherit)', clr.status === 200 && prod().shipping_template === null && prod().sale_regions === null && prod().import_duty_terms === null && prod().free_shipping_threshold === null)
  ok('3b. accept-mode null clears', (await call('POST', '/seller/accept-mode', 's1', { product_id: 'p1', accept_mode: null })).status === 200 && prod().accept_mode === null)

  // ── ④ 所有权守卫 ──
  ok('4. non-owner rejected (403)', (await call('POST', '/seller/shipping-template', 's2', { product_id: 'p1', import_duty_terms: 'ddp' })).status === 403)

  // ── ⑤ 校验错误冒泡(listingCommerceSave 会把 error 透给用户)──
  ok('5. bad tax kind rejected 400', (await call('POST', '/seller/shipping-template', 's1', { product_id: 'p1', tax_lines: [{ region: 'US', label: 'ST', kind: 'added' }] })).status === 400)
  // ⑤b 评审补:多词 label + 末位税率 空格安全 round-trip(Sales Tax 5 → label='Sales Tax', rate=5),不被拆坏
  ok('5b. multi-word tax label accepted', (await call('POST', '/seller/shipping-template', 's1', { product_id: 'p1', tax_lines: [{ region: 'US', label: 'Sales Tax', rate_pct: 5, kind: 'included' }] })).status === 200
    && JSON.parse((prod()).tax_lines as string)[0].label === 'Sales Tax')
  // ── ⑥ 真实运行时:warehouse-first 原子性(用户要求,非 regex) ──
  const statusOf = (pid: string): string => (db.prepare('SELECT status FROM products WHERE id=?').get(pid) as { status: string }).status   // 直读 DB(不经重 GET 路由,避开其全量 schema 依赖)
  // ⑥a backend-only:create_status='warehouse' 确实落库
  const cW = await call('POST', '/products', 's1', { title: 'W', description: 'd', price: 20, stock: 3, create_status: 'warehouse' })
  ok('6a. POST /products create_status=warehouse → DB status=warehouse (not active)', cW.json.product_id !== undefined && statusOf(cW.json.product_id as string) === 'warehouse')
  // ⑥b 默认仍 active(无回归)
  const cA = await call('POST', '/products', 's1', { title: 'A', description: 'd', price: 20, stock: 3 })
  ok('6b. default create → active (no regression)', statusOf(cA.json.product_id as string) === 'active')
  // ⑥c 失败路径:warehouse 建 → 覆盖某步失败(bad tax kind)→ 不激活 → 仍 warehouse(不公开)
  const cF = await call('POST', '/products', 's1', { title: 'F', description: 'd', price: 20, stock: 3, create_status: 'warehouse' }); const fid = cF.json.product_id as string
  const badStep = await call('POST', '/seller/shipping-template', 's1', { product_id: fid, tax_lines: [{ region: 'US', label: 'x', kind: 'added' }] })
  ok('6c. failed override step (400) → product STAYS warehouse (never public active)', badStep.status === 400 && statusOf(fid) === 'warehouse')
  // ⑥d 成功路径:warehouse 建 → 三步覆盖全成功 → PATCH active → active + 字段落库
  const cS = await call('POST', '/products', 's1', { title: 'S', description: 'd', price: 20, stock: 3, create_status: 'warehouse' }); const sid = cS.json.product_id as string
  const r1 = await call('POST', '/seller/shipping-template', 's1', { product_id: sid, template: [{ region: 'SG', fee: 5 }], sale_regions: { mode: 'list', include: ['SG'] }, import_duty_terms: 'ddu', tax_lines: [{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }] })
  const r2 = await call('POST', '/seller/accept-mode', 's1', { product_id: sid, accept_mode: 'manual' })
  const r3 = await call('PUT', '/products/' + sid, 's1', { weight_kg: 1.5, hs_code: '6912.00' })
  const act = await call('PATCH', '/products/' + sid + '/status', 's1', { status: 'active' })
  const sp = () => db.prepare("SELECT * FROM products WHERE id=?").get(sid) as Record<string, unknown>
  ok('6d. success path: all overrides ok → activate → active + fields persisted', r1.status === 200 && r2.status === 200 && r3.error === undefined && act.error === undefined
    && statusOf(sid) === 'active' && JSON.parse(sp().sale_regions as string).include[0] === 'SG' && sp().import_duty_terms === 'ddu' && sp().accept_mode === 'manual' && Number(sp().weight_kg) === 1.5 && sp().hs_code === '6912.00')
} finally { server!.close() }

// ── ⑦ 静态接线锚(前端 hook,后端 runtime 测不到的部分)──
{
  const UI = readFileSync('src/pwa/public/app-listing-commerce-ui.js', 'utf8')
  ok('7a. save posts to the three validated endpoints', /\/seller\/accept-mode/.test(UI) && /\/seller\/shipping-template/.test(UI) && /PUT\(`\/products\//.test(UI))
  ok('7b. blank=inherit maps to null (clears override)', /accept_mode: v\('lc-accept'\) \|\| null/.test(UI) && /import_duty_terms: v\('lc-duty'\) \|\| null/.test(UI))
  ok('7b2. tax parse is space-safe (label may contain spaces; last numeric token = rate)', /hasRate = m\.length > 2 && \/\^\[0-9\.\]\+\$\/\.test\(last\)/.test(UI))
  ok('7b3. saves are serialized fail-fast (not Promise.all — no partial commit across the 3)', /for \(const step of steps\) \{ const r = await step\(\)/.test(UI) && !/Promise\.all/.test(UI))
  ok('7b5. atomic add: module exposes hasOverrides + activates on success (warehouse-first)', /listingCommerceHasOverrides/.test(UI) && /opts && opts\.activate/.test(UI) && /status: 'active'/.test(UI))
  const PC = readFileSync('src/pwa/routes/products-create.ts', 'utf8')
  ok('7b6. products-create honors create_status=warehouse (non-atomic-active hole closed)', /create_status === 'warehouse'/.test(PC) && /\? 'warehouse' : 'active'/.test(PC))
  const SCH = readFileSync('src/layer0-foundation/L0-1-database/schema.ts', 'utf8')
  ok('7b7. weight_kg in base schema (not just server.ts migration; all init paths consistent)', /ADD COLUMN weight_kg REAL/.test(SCH))
  const PU = readFileSync('src/pwa/routes/products-update.ts', 'utf8')
  ok('7b4. weight_kg wired into products-update (was a dead field; PUT now persists it)', /weight_kg, package_size/.test(PU) && /weight_kg=\?, package_size=\?/.test(PU) && /weight_kg === undefined \? product\.weight_kg/.test(PU))
  const APP = readFileSync('src/pwa/public/app.js', 'utf8')
  ok('6c. section injected in BOTH add (null) + edit (p) forms', /listingCommerceSectionHtml\(null\)/.test(APP) && /listingCommerceSectionHtml\(p\)/.test(APP))
  ok('7d. save hooked after create + update; add flow is warehouse-first + activate', /window\.listingCommerceSave\(res\.product_id, \{ activate: payload\.create_status === 'warehouse' \}\)/.test(APP) && /create_status: 'warehouse'/.test(APP) && /window\.listingCommerceSave\(productId\)/.test(APP))
  const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
  ok('7e. module loaded', HTML.includes('app-listing-commerce-ui.js'))
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('7f. i18n parity', keys.size >= 15 && noEn.length === 0, noEn.slice(0, 3).join(' | '))
}

if (fail > 0) { console.error(`\n❌ listing-commerce FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ listing commerce override (S4): all-keys body persists every override (template not wiped) + accept-mode + null=inherit clears + ownership + validation bubbles + add/edit form wiring\n  ✅ pass ${pass}`)
