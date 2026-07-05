#!/usr/bin/env tsx
/**
 * 可售区域(跨境 S1)—— 规则校验 + 建单硬门矩阵 + 层级覆盖 + 平台 overlay + 快照槽填充。
 *   语义锚:REGION_NOT_FOR_SALE 是硬拒 —— 即使卖家开了询价、即使直付轨,也不落 pending_accept(不卖≠运费问题)。
 * Usage: npm run test:sale-regions
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'slr-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const SR = await import('../src/sale-regions.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
db.prepare("INSERT INTO users (id,name,role,api_key,store_sale_regions) VALUES ('s1','s','seller','k1',NULL),('s2','s2','seller','k2','{\"mode\":\"list\",\"include\":[\"SG\",\"MY\"]}')").run()
try { db.exec("ALTER TABLE users ADD COLUMN region TEXT DEFAULT 'global'") } catch { /* 已存在 */ }
db.prepare("UPDATE users SET region = 'china' WHERE id = 's2'").run()   // s2=中国卖家,规则只卖新马 —— 所在地与可售方向解耦

// ── ① 写入校验 ──
{
  const v1 = SR.validateSaleRegionsInput({ mode: 'list', include: ['sg', 'my', 'SG'] })
  ok('1a. normalizes + uppercases + dedupes', 'json' in v1 && v1.json === '{"mode":"list","include":["SG","MY"]}')
  ok('1b. list mode requires non-empty include', 'error' in SR.validateSaleRegionsInput({ mode: 'list' }))
  ok('1c. bad region code rejected', 'error' in SR.validateSaleRegionsInput({ mode: 'all', exclude: ['美国'] }))
  ok('1d. bad mode rejected', 'error' in SR.validateSaleRegionsInput({ mode: 'some' }))
  ok('1e. null clears', 'json' in SR.validateSaleRegionsInput(null) && (SR.validateSaleRegionsInput(null) as { json: string | null }).json === null)
  ok('1f. >64 entries rejected', 'error' in SR.validateSaleRegionsInput({ mode: 'all', exclude: Array.from({ length: 65 }, (_, i) => 'R' + i) }))
}

// ── ② 规则判定 ──
{
  const list = SR.parseSaleRegionsRule('{"mode":"list","include":["SG","MY"]}')!
  const excl = SR.parseSaleRegionsRule('{"mode":"all","exclude":["US"]}')!
  ok('2a. list allows included', SR.regionAllowedByRule(list, 'SG') && SR.regionAllowedByRule(list, 'my'.toUpperCase()))
  ok('2b. list rejects others', !SR.regionAllowedByRule(list, 'US'))
  ok('2c. exclude rejects listed, allows rest', !SR.regionAllowedByRule(excl, 'US') && SR.regionAllowedByRule(excl, 'JP'))
  ok('2d. exclude wins even in list mode', !SR.regionAllowedByRule({ mode: 'list', include: ['SG'], exclude: ['SG'] }, 'SG'))
  ok('2e. bad JSON parses to null (fail-open to legacy)', SR.parseSaleRegionsRule('not json') === null && SR.parseSaleRegionsRule(null) === null)
}

// ── ③ 生效层级:商品 ?? 店铺 ──
{
  ok('3a. store rule applies when product has none', SR.effectiveSaleRegionsRule(db, { sale_regions: null }, 's2')?.mode === 'list')
  ok('3b. product overrides store', SR.effectiveSaleRegionsRule(db, { sale_regions: '{"mode":"all","exclude":["JP"]}' }, 's2')?.exclude?.[0] === 'JP')
  ok('3c. neither → null (unrestricted)', SR.effectiveSaleRegionsRule(db, { sale_regions: null }, 's1') === null)
}

// ── ④ 建单门矩阵(mock res 捕获) ──
const mkRes = (): { status: number; body: Record<string, unknown> | null; r: never } => {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 200, body: null }
  const r = { status: (n: number) => ({ json: (b: Record<string, unknown>) => { out.status = n; out.body = b } }) }
  return Object.assign(out, { r: r as never })
}
const P = <T,>(k: string, fb: T): T => (k === 'trade.platform_region_blocklist' ? '["KP"]' : fb) as T
const PEMPTY = <T,>(_k: string, fb: T): T => fb
{
  let m = mkRes()
  ok('4a. no rule + no platform list → pass (region optional, legacy behavior)', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's1', undefined, PEMPTY) === true)
  m = mkRes()
  ok('4b. rule exists + no region → 400 SHIP_REGION_REQUIRED (fail-closed)', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's2', undefined, PEMPTY) === false && m.status === 400 && m.body?.error_code === 'SHIP_REGION_REQUIRED')
  m = mkRes()
  ok('4c. store list blocks non-member → 409 REGION_NOT_FOR_SALE', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's2', 'US', PEMPTY) === false && m.status === 409 && m.body?.error_code === 'REGION_NOT_FOR_SALE')
  m = mkRes()
  ok('4d. store list passes member', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's2', 'sg', PEMPTY) === true)
  m = mkRes()
  ok('4e. product override widens past store rule', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: '{"mode":"all"}' }, 's2', 'US', PEMPTY) === true)
  m = mkRes()
  // 不变量(用户要求):卖家所在地区与可售地区完全解耦 —— 中国卖家可以只做跨境(本国不在 include 里),
  //   规则照常生效:卖到 SG 通过、卖回本国 CN 被自己的规则拒。gate 从不读 users.region。
  ok('4x1. CN seller selling ONLY abroad: SG passes (own region not required in list)', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's2', 'SG', PEMPTY) === true)
  m = mkRes()
  ok('4x2. same seller: own home region CN blocked by own rule (no home-region special case)', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's2', 'CN', PEMPTY) === false && m.body?.error_code === 'REGION_NOT_FOR_SALE')
  m = mkRes()
  ok('4f. platform blocklist → 409 PRODUCT_RESTRICTED (merchant cannot widen)', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: '{"mode":"all"}' }, 's2', 'KP', P) === false && m.body?.error_code === 'PRODUCT_RESTRICTED')
  m = mkRes()
  ok('4g. platform list alone forces region choice', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's1', undefined, P) === false && m.body?.error_code === 'SHIP_REGION_REQUIRED')
  m = mkRes()
  // 审计 P2:坏配置 fail-CLOSED —— 合规名单读不懂时放行=静默解除平台禁售;宁可挡单
  ok('4h. malformed platform param → 503 PLATFORM_REGION_POLICY_INVALID (fail-closed, NOT silently unrestricted)', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's1', 'SG', (<T,>(_k: string, fb: T): T => 'not json' as never ?? fb)) === false && m.status === 503 && m.body?.error_code === 'PLATFORM_REGION_POLICY_INVALID')
  m = mkRes()
  ok('4h2. non-array JSON also fail-closed', SR.gateSaleRegionForCreate(db, m.r, { sale_regions: null }, 's1', 'SG', (<T,>(_k: string, fb: T): T => '{"a":1}' as never ?? fb)) === false && m.body?.error_code === 'PLATFORM_REGION_POLICY_INVALID')
}

// ── ⑤ 静态接线:gate 在运费 gate 之前;硬拒语义;快照槽;写路由;UI 装载 ──
{
  const OC = readFileSync('src/pwa/routes/orders-create.ts', 'utf8')
  ok('5a. sale gate runs BEFORE shipping gate in create', OC.indexOf('gateSaleRegionForCreate') < OC.indexOf('gateShippingForCreate(db, res') && /if \(!gateSaleRegionForCreate\(db, res/.test(OC))
  const SRC = readFileSync('src/sale-regions.ts', 'utf8')
  ok('5x. gate never reads the seller own region (users.region) — sellable direction fully decoupled', !/users?\.region\b/.test(SRC) && !/SELECT region/.test(SRC))
  ok('5b. REGION_NOT_FOR_SALE copy says quote does NOT apply (hard reject semantics)', /不适用询价/.test(SRC))
  const TT = readFileSync('src/trade-terms.ts', 'utf8')
  ok('5c. snapshot slot reads sale_regions (S0 slot auto-fills)', /sale_regions_rule: parse\(p\?\.sale_regions\) \?\? parse\(u\?\.store_sale_regions\)/.test(TT))
  // 审计 P2:参数必须 seed(否则 admin PATCH 404,运营侧永远打不开合规门)+ admin 写入侧强校验
  const SRV = readFileSync('src/pwa/server.ts', 'utf8')
  ok('5y1. trade.platform_region_blocklist seeded in DEFAULT_PARAMS (type json, default [])', /key: 'trade\.platform_region_blocklist', value: '\[\]', type: 'json'/.test(SRV))
  const APP_ = readFileSync('src/pwa/routes/admin-protocol-params.ts', 'utf8')
  ok('5y2. admin PATCH validates json type + region-code array for this key', /param\.type === 'json'/.test(APP_) && /BAD_REGION_BLOCKLIST/.test(APP_))
  const RT = readFileSync('src/pwa/routes/shipping-templates.ts', 'utf8')
  ok('5d. write route: store + product branches with strict validation', /store_sale_regions' in b/.test(RT) && /'product_id' in b && 'sale_regions' in b/.test(RT) && /BAD_SALE_REGIONS/.test(RT))
  ok('5e. legacy bare-product_id template branch preserved, new combos not swallowed', /'template' in b \|\| \(\('product_id' in b\) && !\('quote_ok' in b\) && !\('sale_regions' in b\) && !\('free_shipping_threshold' in b\)\)/.test(RT))
  const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
  const UI = readFileSync('src/pwa/public/app-sale-regions-ui.js', 'utf8')
  ok('5f. UI module loaded after order-accept-ui (wrapper needs originals)', HTML.indexOf('app-sale-regions-ui.js') > HTML.indexOf('app-order-accept-ui.js') && HTML.indexOf('app-sale-regions-ui.js') > 0)
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  const keys = new Set<string>()
  for (const mm of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(mm[1])
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('5g. i18n parity', keys.size >= 6 && noEn.length === 0, noEn.slice(0, 2).join(' | '))
}

if (fail > 0) { console.error(`\n❌ sale-regions FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ sale regions (S1): validation + rule matrix + product??store hierarchy + platform overlay (not widenable) + fail-closed no-region + hard-reject (no quote path) + snapshot slot\n  ✅ pass ${pass}`)
