#!/usr/bin/env tsx
/**
 * 跨境税费/进口责任声明层(S3)—— DDP/DDU + 价内含税(仅 included)校验 + 层级 + 披露端点 + 快照填充 + 无钱路。
 *   语义锚:'added' 税明确拒(平台不代收,钱路未开);total_amount 绝不因声明改变;非托管≠免平台义务(见 INTERNAL doc)。
 * Usage: npm run test:trade-tax
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'ttax-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser, transition } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initOrderChainSchema, appendOrderEvent } = await import('../src/layer0-foundation/L0-2-state-machine/order-chain.js')
const TX = await import('../src/trade-tax.js')
const TT = await import('../src/trade-terms.js')
const { createDirectPayOrder } = await import('../src/direct-pay-create.js')
const { registerShippingTemplateRoutes } = await import('../src/pwa/routes/shipping-templates.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db); initSystemUser(db); initOrderChainSchema(db)
for (const c of ['handling_hours INTEGER', 'estimated_days TEXT', 'return_days INTEGER', 'return_condition TEXT', 'warranty_days INTEGER', 'weight_kg REAL']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${c}`) } catch { /* 已有 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('b1','b','buyer','kb'),('s1','s','seller','ks')").run()

// ── ① DDP/DDU 校验 ──
{
  ok('1a. ddu/ddp accepted', (TX.validateImportDutyTerms('ddu') as { value: string }).value === 'ddu' && (TX.validateImportDutyTerms('ddp') as { value: string }).value === 'ddp')
  ok('1b. null clears', (TX.validateImportDutyTerms(null) as { value: null }).value === null && (TX.validateImportDutyTerms('') as { value: null }).value === null)
  ok('1c. garbage rejected', 'error' in TX.validateImportDutyTerms('dap') && 'error' in TX.validateImportDutyTerms(1))
}

// ── ② tax_lines 校验:included only,added 拒 ──
{
  const v = TX.validateTaxLines([{ region: 'sg', label: 'GST', rate_pct: 9, kind: 'included' }])
  ok('2a. included line normalized (region upper)', 'value' in v && JSON.parse((v as { value: string }).value)[0].region === 'SG')
  ok('2b. kind added REJECTED (platform does not collect tax; money path not open)', 'error' in TX.validateTaxLines([{ region: 'US', label: 'Sales Tax', rate_pct: 7, kind: 'added' }]))
  ok('2c. missing label rejected', 'error' in TX.validateTaxLines([{ region: 'SG', rate_pct: 9 }]))
  ok('2d. bad region rejected', 'error' in TX.validateTaxLines([{ region: '税', label: 'x' }]))
  ok('2e. rate out of range rejected', 'error' in TX.validateTaxLines([{ region: 'SG', label: 'GST', rate_pct: 101 }]))
  ok('2f. dup region rejected', 'error' in TX.validateTaxLines([{ region: 'SG', label: 'A' }, { region: 'SG', label: 'B' }]))
  ok('2g. null clears / non-array rejected', (TX.validateTaxLines(null) as { value: null }).value === null && 'error' in TX.validateTaxLines('x'))
  ok('2h. wildcard region + kind defaulted to included', (() => { const r = TX.validateTaxLines([{ region: '*', label: 'VAT' }]); return 'value' in r && JSON.parse(r.value)[0].kind === 'included' && JSON.parse(r.value)[0].region === '*' })())
}

// ── ③ 生效层级:商品 ?? 店铺 ──
{
  ok('3a. duty: product overrides store', TX.effectiveImportDutyTerms('ddp', 'ddu') === 'ddp')
  ok('3b. duty: store fallback', TX.effectiveImportDutyTerms(null, 'ddu') === 'ddu')
  ok('3c. duty: neither → null', TX.effectiveImportDutyTerms(null, null) === null)
  const store = JSON.stringify([{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }])
  ok('3d. tax: store fallback when product empty', TX.effectiveTaxLines(null, store)?.[0].label === 'GST')
  ok('3e. tax: product overrides store', TX.effectiveTaxLines(JSON.stringify([{ region: 'MY', label: 'SST', kind: 'included' }]), store)?.[0].label === 'SST')
  ok('3f. tax: garbage → null (fail to no-declaration)', TX.effectiveTaxLines('not json', null) === null)
}

// ── ④ 快照填充(S0 slot 从列自动读)+ 无钱路(total 不变) ──
db.prepare("UPDATE products SET import_duty_terms='ddu', tax_lines=? WHERE id='p1'").run(JSON.stringify([{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }]))
{
  // seed product needs to exist first
}
db.prepare("INSERT OR IGNORE INTO products (id,seller_id,title,description,price,stock,import_duty_terms,tax_lines) VALUES ('p1','s1','T','d',50,10,'ddu',?)").run(JSON.stringify([{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }]))
db.prepare("UPDATE products SET import_duty_terms='ddu', tax_lines=? WHERE id='p1'").run(JSON.stringify([{ region: 'SG', label: 'GST', rate_pct: 9, kind: 'included' }]))
{
  const SNAP = { enabled: true, railBreakerTripped: false, region: 'SG', regionAllowlist: ['SG'], perTxCapUnits: 500_000_000, sellerBreakerTripped: false, decisionCode: 'OK' }
  let n = 0
  const { orderId } = createDirectPayOrder(db, { generateId: (p: string) => `${p}_${++n}`, transition, appendOrderEvent } as never, {
    productId: 'p1', sellerId: 's1', buyerId: 'b1', quantity: 1, unitPrice: 50, totalAmount: 50,
    instructionSnapshot: 'PayNow', windowDeadlineIso: new Date(Date.now() + 4 * 3600e3).toISOString(),
    shippingAddress: 'addr', accountSnapshot: null, snapshot: SNAP, acceptMode: 'auto', shipping: { region: 'SG', fee: 0, estDays: null },
  })
  const row = db.prepare('SELECT total_amount, trade_terms_snapshot FROM orders WHERE id=?').get(orderId) as { total_amount: number; trade_terms_snapshot: string | null }
  const snap = TT.readTradeTermsSnapshot(row.trade_terms_snapshot)
  ok('4a. snapshot declarations fill import_duty_terms from column (S0 slot)', snap?.declarations.import_duty_terms === 'ddu')
  ok('4b. snapshot declarations fill tax_lines from column', Array.isArray(snap?.declarations.tax_lines) && (snap!.declarations.tax_lines as unknown[]).length === 1)
  ok('4c. NO money path: total_amount unaffected by tax declaration', row.total_amount === 50)
}

// ── ⑤ 路由:写入 + 披露端点 ──
const app = express(); app.use(express.json())
registerShippingTemplateRoutes(app, {
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null }; return db.prepare('SELECT * FROM users WHERE id=?').get(uid) as Record<string, unknown> },
  errorRes: (res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, error_code: code }),
} as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const call = (method: string, path: string, uid: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : ''
  const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
  if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method, path: '/api' + path, headers }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} })) })
  rq.on('error', reject); if (payload) rq.write(payload); rq.end()
})
try {
  ok('5a. seller sets store DDP/DDU + tax', (await call('POST', '/seller/shipping-template', 's1', { store_import_duty_terms: 'ddu', store_tax_lines: [{ region: 'SG', label: 'GST', rate_pct: 9 }] })).status === 200
    && (db.prepare("SELECT store_import_duty_terms d FROM users WHERE id='s1'").get() as { d: string }).d === 'ddu')
  ok('5b. added tax line rejected at route (400 BAD_TAX_LINES)', (await call('POST', '/seller/shipping-template', 's1', { store_tax_lines: [{ region: 'US', label: 'ST', kind: 'added' }] })).status === 400)
  ok('5c. bad duty rejected (400 BAD_IMPORT_DUTY_TERMS)', (await call('POST', '/seller/shipping-template', 's1', { store_import_duty_terms: 'dap' })).json.error_code === 'BAD_IMPORT_DUTY_TERMS')
  ok('5d. non-owner product duty rejected (403)', (await call('POST', '/seller/shipping-template', 'b1', { product_id: 'p1', import_duty_terms: 'ddp' })).status === 403 || (await call('POST', '/seller/shipping-template', 'b1', { product_id: 'p1', import_duty_terms: 'ddp' })).status === 401)
  const opts = await call('GET', '/products/p1/shipping-options', null)
  ok('5e. shipping-options exposes import_duty_terms + tax_included_lines (buyer disclosure)', opts.json.import_duty_terms === 'ddu' && Array.isArray(opts.json.tax_included_lines))
  // 多区税声明 → 披露按收货地区过滤(目的区 + '*';无地区参数=仅 '*';不误示他区税)
  await call('POST', '/seller/shipping-template', 's1', { product_id: 'p1', tax_lines: [{ region: 'SG', label: 'GST', rate_pct: 9 }, { region: 'EU', label: 'VAT', rate_pct: 20 }, { region: '*', label: 'Levy' }] })
  const noRegion = await call('GET', '/products/p1/shipping-options', null)
  ok('5e2. no ship_to_region → only wildcard * lines disclosed', (noRegion.json.tax_included_lines as { region: string }[]).length === 1 && (noRegion.json.tax_included_lines as { region: string }[])[0].region === '*')
  const sg = await call('GET', '/products/p1/shipping-options?ship_to_region=SG', null)
  const sgRegions = (sg.json.tax_included_lines as { region: string }[]).map(l => l.region).sort()
  ok('5e3. ship_to_region=SG → SG + * only (NOT EU)', sgRegions.join(',') === '*,SG')
  const my = await call('GET', '/products/p1/shipping-options?ship_to_region=MY', null)
  ok('5e4. ship_to_region=MY (no MY line) → only * (no wrong-region leak)', (my.json.tax_included_lines as { region: string }[]).map(l => l.region).join(',') === '*')
  const setg = await call('GET', '/seller/shipping-settings', 's1')
  ok('5f. settings echoes store_import_duty_terms + parsed store_tax_lines', setg.json.store_import_duty_terms === 'ddu' && Array.isArray(setg.json.store_tax_lines))
} finally { server!.close() }

// ── ⑥ 静态:域归属 + UI 装载 + 合规 doc + i18n ──
{
  const RT = readFileSync('src/pwa/routes/shipping-templates.ts', 'utf8')
  ok('6a. write branches store + product for both fields', /store_import_duty_terms' in b/.test(RT) && /'product_id' in b && 'import_duty_terms' in b/.test(RT) && /store_tax_lines' in b/.test(RT) && /'product_id' in b && 'tax_lines' in b/.test(RT))
  const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
  ok('6b. buyer disclosure module loaded + injected in buy sheet', HTML.includes('app-trade-tax-ui.js') && /tradeTaxBlockHtml \? window\.tradeTaxBlockHtml/.test(readFileSync('src/pwa/public/app.js', 'utf8')))
  const UI = readFileSync('src/pwa/public/app-trade-tax-ui.js', 'utf8')
  ok('6c. disclosure states platform does not collect/remit', /平台不代收代缴/.test(UI))
  ok('6c2. tax disclosure is region-aware (route filters via taxLinesForRegion; UI refreshes on region change)',
    /taxLinesForRegion\(effectiveTaxLines/.test(readFileSync('src/pwa/routes/shipping-templates.ts', 'utf8'))
    && /_tradeTaxRefresh/.test(UI) && /_tradeTaxRefresh\(\)/.test(readFileSync('src/pwa/public/app-order-accept-ui.js', 'utf8')))
  const DOC = readFileSync('docs/COMPLIANCE-CROSS-BORDER-TAX.INTERNAL.md', 'utf8')
  ok('6d. INTERNAL compliance doc records the deemed-supplier finding + counsel-gate', /deemed[ -]supplier/i.test(DOC) && /trade\.platform_region_blocklist/.test(DOC))
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('6e. i18n parity', keys.size >= 10 && noEn.length === 0, noEn.slice(0, 3).join(' | '))
}

if (fail > 0) { console.error(`\n❌ trade-tax FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ cross-border tax (S3, declaration+disclosure only): DDP/DDU + included-tax validation (added rejected) + product??store + snapshot fill + NO money path + buyer disclosure + compliance doc\n  ✅ pass ${pass}`)
