#!/usr/bin/env tsx
/**
 * 调用契约 P0 PR-C — search 0 命中 recovery 反转 + 无约束浏览守卫。
 *   用法:npm run test:discover-recovery-browse
 *
 * 覆盖(审计 §7 G2 / §8 G4):
 *   [REC] 0 命中 recovery.next_step 指向 webaz_discover(非"无 query 全目录浏览")+ 词表指针;短商品词→
 *         确定性转 discover 单词 any;复杂 query→不伪造关键词、导词表;catalog_sample 标注非匹配 ≤5。
 *   [UB]  agent 无约束浏览(无 query/category/过滤)limit>8 → 400 UNBOUNDED_CATALOG_BROWSE + 机器出路;
 *         limit≤8 放行;有 category/query/过滤不触发;raw 面(高信任 agent)不受此门影响。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-recb-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerProductsListRoutes } = await import('../src/pwa/routes/products-list.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
// products-list innerSelect 依赖的旁表(与 test-mcp-model-projection 同源;非被测,最小语义替身)
db.exec(`CREATE TABLE IF NOT EXISTS product_categories (id TEXT PRIMARY KEY, seasonal_months TEXT);
CREATE TABLE IF NOT EXISTS order_ratings (id TEXT, product_id TEXT, buyer_id TEXT, stars INTEGER);
CREATE TABLE IF NOT EXISTS dispute_cases (id TEXT, seller_id TEXT, winner TEXT);
CREATE TABLE IF NOT EXISTS product_trial_campaigns (id TEXT, product_id TEXT, status TEXT, quota_total INTEGER, quota_claimed INTEGER);
CREATE TABLE IF NOT EXISTS user_blocklist (blocker_id TEXT, blocked_id TEXT)`)
// products-list WHERE/innerSelect 依赖的 users/products 列(仅全 boot 时由 server.ts inline ALTER 加;
// 此处按 test-mcp-model-projection 同法手工补齐 —— 非被测,补全语义)
try { db.exec('ALTER TABLE users ADD COLUMN listing_paused INTEGER DEFAULT 0') } catch { /* 已存在 */ }
for (const col of ['claim_loss_count INTEGER DEFAULT 0', 'product_type TEXT', 'category_id TEXT']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
for (const col of ['verified INTEGER', 'revoked INTEGER', 'external_title TEXT']) { try { db.exec(`ALTER TABLE product_external_links ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller1','S','seller','k_s')").run()
const insP = db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES (?,?,?,?,?,?,?,?,?)`)
for (let i = 0; i < 12; i++) insP.run(`prd_${i}`, 'seller1', `Sample Product ${i}`, 'd', 10 + i, 'WAZ', 5, '家庭清洁/纸品', 'active')

const app = express(); app.use(express.json())
registerProductsListRoutes(app, {
  db, getUser: () => null,
  VALID_PRODUCT_TYPES: new Set(['retail', 'wholesale', 'service', 'digital']),
  RAW_MODE_MIN_TRUST: 30, getAgentTrustCached: () => ({ trust_score: 999 }),
  VALID_SORTS: new Set(['trending', 'newest', 'rating', 'price_asc', 'price_desc', 'random', 'recommended', 'seller_win_rate']),
  PRODUCT_LIMITS: { pwa: 30, agent: 200, raw: 500 },
  TRENDING_SCORE_EXPR: 'p.price',
  findProductsByAlias: () => new Set<string>(),
  decodeProductCursor: (c: string) => { try { const [s, id] = Buffer.from(c, 'base64url').toString().split(':'); return { score: Number(s), id } } catch { return null } },
  encodeProductCursor: (score: number, id: string) => Buffer.from(`${score}:${id}`).toString('base64url'),
  MASTER_SEED: 'test-seed',
  formatProductForAgent: (p: Record<string, unknown>) => ({ ...p, agent_summary: `${p.title}` }),
})
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
process.env.WEBAZ_API_URL = base

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { handleSearch: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }
const getJson = async (path: string, headers?: Record<string, string>): Promise<{ status: number; j: Record<string, unknown> }> => {
  const r = await fetch(base + path, { headers })
  return { status: r.status, j: await r.json() as Record<string, unknown> }
}

try {
  // ── [REC] recovery 反转(MCP handleSearch 0 命中路径)───────────────────────────────────────
  const short = await mcp.handleSearch({ query: 'phone stand' })
  const rec = (short.recovery ?? {}) as Record<string, unknown>
  const ns = (rec.next_step ?? {}) as Record<string, unknown>
  ok('REC-1 短商品词 0 命中 → recovery.next_step 指向 webaz_discover(非全目录浏览)', short.found === 0
    && ns.tool === 'webaz_discover' && !JSON.stringify(ns).includes('NO query'), JSON.stringify(ns).slice(0, 200))
  ok('REC-2 短词确定性转:query 作单个 keyword + keyword_match:any + 词表指针', Array.isArray((ns.arguments as Record<string, unknown>)?.keywords)
    && ((ns.arguments as Record<string, unknown>)?.keywords as string[])[0] === 'phone stand'
    && (ns.arguments as Record<string, unknown>)?.keyword_match === 'any' && typeof rec.category_vocabulary === 'string', JSON.stringify(ns).slice(0, 200))
  ok('REC-3 catalog_sample 标注非匹配 + ≤5 件', typeof rec.catalog_sample_note === 'string'
    && Array.isArray(rec.catalog_sample) && (rec.catalog_sample as unknown[]).length <= 5)
  const complex = await mcp.handleSearch({ query: 'alpha beta gamma delta epsilon zeta' })   // 6 词 → 非短商品词形态
  const cns = ((complex.recovery ?? {}) as Record<string, unknown>).next_step as Record<string, unknown> | undefined
  ok('REC-4 复杂 query 不伪造关键词 → 导词表(无 keywords 字段)', cns?.tool === 'webaz_discover'
    && (cns?.arguments as Record<string, unknown> | undefined)?.keywords === undefined && typeof cns?.category_vocabulary === 'string', JSON.stringify(complex).slice(0, 260))
  // REC-5(Codex R1-4):短词分类器与 discover 校验同源 —— URL/路径形态的 query 不得被转成会被 discover 400 的 keyword
  for (const bad of ['x.com/page', 'a/b/c', '/term', 'term/']) {
    const rb = await mcp.handleSearch({ query: bad })
    const bns = ((rb.recovery ?? {}) as Record<string, unknown>).next_step as Record<string, unknown> | undefined
    ok(`REC-5 URL/路径 query "${bad}" 不生成可执行 keyword(导词表,防自相矛盾 400)`,
      (bns?.arguments as Record<string, unknown> | undefined)?.keywords === undefined, JSON.stringify(bns).slice(0, 140))
  }

  // ── [UB] 无约束浏览守卫(直打 /api/products agent 模式)──────────────────────────────────────
  const ub1 = await getJson('/api/products?mode=agent&limit=50')
  ok('UB-1 agent 无约束 limit 50 → 400 UNBOUNDED_CATALOG_BROWSE + 机器出路', ub1.status === 400
    && ub1.j.error_code === 'UNBOUNDED_CATALOG_BROWSE' && !!ub1.j.recommended_next_call && !!ub1.j.sample_browse, JSON.stringify(ub1.j).slice(0, 200))
  const ub2 = await getJson('/api/products?mode=agent&limit=8')
  ok('UB-2 agent 无约束 limit 8 → 放行(≤8 样本)', ub2.status === 200 && Array.isArray(ub2.j.products))
  const ub3 = await getJson('/api/products?mode=agent&category=' + encodeURIComponent('家庭清洁/纸品') + '&limit=50')
  ok('UB-3 有 category 的浏览不触发守卫(有约束)', ub3.status === 200, JSON.stringify(ub3.j).slice(0, 120))
  const ub4 = await getJson('/api/products?mode=agent&q=Sample&limit=50')
  ok('UB-4 有 query 不触发守卫', ub4.status === 200)
  const ub5 = await getJson('/api/products?mode=agent&max_price=15&limit=50')
  ok('UB-5 有价格过滤不触发守卫', ub5.status === 200)
  const ub6 = await getJson('/api/products?mode=raw&limit=100', { authorization: 'Bearer k_s' })
  ok('UB-6 raw 面(高信任 agent)不受无约束守卫限制', ub6.status === 200, JSON.stringify(ub6.j).slice(0, 120))
  // Codex R1-1:result_handle 不是本 GET 路由能力,不得作守卫豁免(伪 handle 曾可绕过扫全目录)
  const ub7 = await getJson('/api/products?mode=agent&limit=200&result_handle=x')
  ok('UB-7 伪 result_handle 不豁免守卫(仍 400)', ub7.status === 400 && ub7.j.error_code === 'UNBOUNDED_CATALOG_BROWSE', JSON.stringify(ub7.j).slice(0, 120))
  // Codex R1-2:无约束 + cursor 翻页 → 400(8 件一翻可枚举全目录)
  const ub8 = await getJson('/api/products?mode=agent&limit=8&cursor=eyJ4IjoxfQ')
  ok('UB-8 无约束 + cursor → 400(禁翻页枚举)', ub8.status === 400 && ub8.j.error_code === 'UNBOUNDED_CATALOG_BROWSE', JSON.stringify(ub8.j).slice(0, 120))
  // Codex R1-3:product_type / since_days / has_trial 也是有效约束,不得误判 400
  const ub9 = await getJson('/api/products?mode=agent&product_type=retail&limit=50')
  ok('UB-9 product_type 约束不触发守卫', ub9.status === 200, JSON.stringify(ub9.j).slice(0, 120))
  const ub10 = await getJson('/api/products?mode=agent&since_days=7&limit=50')
  ok('UB-10 since_days 约束不触发守卫', ub10.status === 200, JSON.stringify(ub10.j).slice(0, 120))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ discover-recovery-browse FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ discover-recovery-browse: recovery 反转导向 discover + 无约束浏览守卫(≤8/400)— 全绿\n  ✅ pass ${pass}`)
process.exit(0)
