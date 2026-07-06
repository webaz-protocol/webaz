#!/usr/bin/env tsx
/**
 * 币种展示归一化 (audit Claim 5) —— agent-facing 输出统一 WAZ,遗留 'DCP' 读时归一化,【绝不】外泄 DCP。
 * 验 displayCurrency 纯函数 + ACP 发现 feed(即便产品行 currency='DCP' 也只输出 WAZ,整份 feed 无 'DCP')。
 * 注:schema DEFAULT 'DCP' 的翻转 + 存量 backfill 是独立 gated PR;本测只覆盖展示层。
 * Usage: npm run test:currency-display
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'cur-disp-'))

const { displayCurrency, PROTOCOL_CURRENCY } = await import('../src/currency.js')
const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { buildAcpProductFeed } = await import('../src/pwa/acp-feed.js')
const { SKILL_TYPE_META } = await import('../src/layer4-economics/L4-4-skill-market/skill-engine.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? ` (${d})` : ''}`) } }

// 1. displayCurrency 纯函数
ok('1. PROTOCOL_CURRENCY is WAZ', PROTOCOL_CURRENCY === 'WAZ')
ok("2. 'DCP' (legacy) → WAZ", displayCurrency('DCP') === 'WAZ')
ok("3. 'dcp' (case) → WAZ", displayCurrency('dcp') === 'WAZ')
ok('4. empty/null/undefined → WAZ', displayCurrency('') === 'WAZ' && displayCurrency(null) === 'WAZ' && displayCurrency(undefined) === 'WAZ')
ok("5. 'USDC' passes through", displayCurrency('USDC') === 'USDC')
ok("6. 'sgd' → 'SGD' (uppercased)", displayCurrency('sgd') === 'SGD')
ok('7. non-string → WAZ', displayCurrency(42 as unknown) === 'WAZ')

// 2. ACP feed never emits DCP even when a product row is stored as 'DCP'
const db = initDatabase()
db.pragma('foreign_keys = OFF')
// the ACP feed SELECT reads columns added outside initDatabase (runtime/inline DDL); add them so the fresh test DB matches prod shape
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','Seller','seller','k1')").run()
const mkP = (id: string, cur: string | null) => db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status, currency) VALUES (?,?,?,?,?,?, 'active', ?)").run(id, 's1', 'P-' + id, 'desc', 10, 5, cur)
mkP('p_dcp', 'DCP')      // legacy row
mkP('p_null', null)      // defaulted (schema DEFAULT still 'DCP' → stored DCP; but explicit null here)
mkP('p_usdc', 'USDC')

const feed = buildAcpProductFeed(db) as { products: Array<{ item_id: string; price: { currency: string } }> }
const byId = Object.fromEntries((feed.products || []).map(p => [p.item_id, p]))
ok('8. legacy DCP product → feed currency WAZ', byId['p_dcp']?.price?.currency === 'WAZ', byId['p_dcp']?.price?.currency)
ok('9. null-currency product → feed currency WAZ', byId['p_null']?.price?.currency === 'WAZ')
ok('10. USDC product → feed currency USDC (passthrough)', byId['p_usdc']?.price?.currency === 'USDC')
ok('11. no feed item emits currency "DCP"', (feed.products || []).every(p => p.price?.currency !== 'DCP'))
// whole-feed guard: the serialized feed (items + disclosures) must contain no "DCP" token at all
ok('12. entire feed JSON contains no "DCP"', !/DCP/.test(JSON.stringify(feed)))

// 3. MCP skill-types agent-facing surface (webaz_skill list → SKILL_TYPE_META.description) must not leak DCP
const skillMetaStr = JSON.stringify(SKILL_TYPE_META)
ok('13. SKILL_TYPE_META (webaz_skill list) contains no "DCP" token', !/DCP/.test(skillMetaStr))
for (const [k, m] of Object.entries(SKILL_TYPE_META as Record<string, { description: string; description_en: string }>)) {
  ok(`13.${k}: zh+en descriptions DCP-free`, !/DCP/.test(m.description) && !/DCP/.test(m.description_en))
}

if (fail > 0) { console.error(`\n❌ currency display normalization FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ currency display: agent-facing币种统一 WAZ · 遗留 'DCP'/空 读时归一化 · USDC 等原样 · ACP feed 即便 DCP 行也只输出 WAZ,整份 feed 无 DCP\n  ✅ pass ${pass}`)
