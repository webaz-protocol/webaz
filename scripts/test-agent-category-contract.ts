#!/usr/bin/env tsx
/**
 * 调用契约 P0 PR-AB — canonical 类目注册表 + keyword_match 契约 + 逐词命中诊断。
 *   用法:npm run test:agent-category-contract
 *
 * 覆盖(审计 §11 P0 / Holden 六条调整):
 *   [R] resolveCategory 五态:canonical / live 直通 / alias 唯一修正 / 多义 / 未知+近似提示;
 *   [T] 词表端点:注册表键零商品不消失;uncurated 自由类目在列;schema_version;
 *   [D] discover:alias 唯一 → 修正后继续并回显 category_resolved;多义 → 400 CATEGORY_AMBIGUOUS
 *       (带 options + recommended_next_call);未知 → 400 UNKNOWN_CATEGORY(category_table +
 *       recommended_next_call)且【不落 demand_signals】;
 *   [K] keyword_match:默认 all 合取(现语义零破坏);any 析取救活同义词组;INVALID 400;
 *       0 命中带 match_semantics + per_keyword_hits(同约束逐词计数,含 category/预算约束保留);
 *   [L] 台账:intent_json 记录 keyword_match + 修正后 canonical category。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-catc-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { resolveCategory, buildCategoryTable, CANONICAL_CATEGORIES } = await import('../src/pwa/agent-categories.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('seller1','S','seller','k_s')").run()
const insP = db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES (?,?,?,?,?,?,?,?,?)`)
// 家庭清洁/纸品:两款抽纸(标题含"抽纸",不含"纸巾")
insP.run('prd_cz1', 'seller1', '豪势纯木底部抽悬挂式底部抽纸 5层每提344抽', 'd', 19.9, 'WAZ', 5, '家庭清洁/纸品', 'active')
insP.run('prd_cz2', 'seller1', '心相印茶语精选悬挂式底部抽纸 4层每提280抽', 'd', 11.5, 'WAZ', 5, '家庭清洁/纸品', 'active')
// 自由类目(不在注册表)—— live 直通 + uncurated 在表
insP.run('prd_free', 'seller1', 'Ceramic Mug Set', 'd', 9, 'WAZ', 5, 'drinkware', 'active')

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const webazDir = join(tmpHome, '.webaz')
db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
  .run('grt_c', 'buyer1', 'C', JSON.stringify([{ capability: 'buyer_discover' }]), sha('gtk_c'), new Date(Date.now() + 3600_000).toISOString())
mkdirSync(webazDir, { recursive: true })
writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ grt_c: { token: 'gtk_c', stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: 'grt_c', handle: 'file:~/.webaz/credentials#grt_c', capabilities: [{ capability: 'buyer_discover' }], expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { handleDiscover: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }
const base = process.env.WEBAZ_API_URL

try {
  // ── [R] resolver 五态 ─────────────────────────────────────────────────────────────────────
  const r1 = await resolveCategory('家庭清洁/纸品')
  ok('R-1 canonical 精确', r1.status === 'canonical' && (r1 as { key: string }).key === '家庭清洁/纸品')
  const r2 = await resolveCategory('drinkware')
  ok('R-2 live 自由类目直通(卖家新类目即刻可用)', r2.status === 'live' && (r2 as { key: string }).key === 'drinkware')
  const r3 = await resolveCategory('household')
  ok('R-3 alias 唯一 → 修正为 canonical', r3.status === 'alias' && (r3 as { key: string }).key === '家庭清洁/纸品')
  const r4 = await resolveCategory('收纳')
  ok('R-4 多义 alias → ambiguous + options', r4.status === 'ambiguous' && (r4 as { options: string[] }).options.length === 4)
  const r5 = await resolveCategory('纸')
  ok('R-5 未知 → unknown + 近似提示', r5.status === 'unknown' && (r5 as { alias_hints: string[] }).alias_hints.includes('家庭清洁/纸品'))

  // ── [T] 词表 ──────────────────────────────────────────────────────────────────────────────
  const table = await buildCategoryTable()
  ok('T-1 注册表键零商品不消失(canonical registry 稳定)', table.filter(t => !t.uncurated).length === CANONICAL_CATEGORIES.length
    && table.some(t => t.key === '服装' && t.active_count === 0))
  ok('T-2 uncurated 自由类目在列(active>0)+ 有 count/samples', table.some(t => t.key === 'drinkware' && t.uncurated && t.active_count === 1 && t.samples.length === 1))
  const ep = await (await fetch(`${base}/api/agent/categories`)).json() as Record<string, unknown>
  ok('T-3 公共端点(无鉴权保底通道)schema + 内容同源', ep.schema_version === 'webaz.category_table.v1'
    && Array.isArray(ep.categories) && (ep.categories as unknown[]).length === table.length)

  // ── [D] discover 三分支(经真实 grant 全链)─────────────────────────────────────────────
  const call = (a: Record<string, unknown>) => mcp.handleDiscover(a)
  const d1 = await call({ category: 'household', keywords: ['抽纸'] })
  ok('D-1 alias 修正后继续:命中 + category_resolved 回显', Number(d1.count) === 2
    && (d1.category_resolved as Record<string, unknown>)?.canonical === '家庭清洁/纸品'
    && (d1.category_resolved as Record<string, unknown>)?.submitted === 'household', JSON.stringify(d1).slice(0, 200))
  const d2 = await call({ category: '收纳' })
  ok('D-2 多义 → CATEGORY_AMBIGUOUS + options + suggested_question + 逐选项调用数组', d2.error_code === 'CATEGORY_AMBIGUOUS'
    && Array.isArray(d2.options) && (d2.options as string[]).length === 4 && !!d2.suggested_question
    && Array.isArray(d2.recommended_next_calls) && d2.selection_required === true, JSON.stringify(d2).slice(0, 200))
  const before = (db.prepare('SELECT COUNT(*) c FROM demand_signals').get() as { c: number }).c
  const d3 = await call({ category: 'zzz-nope', keywords: ['抽纸'] })
  const after = (db.prepare('SELECT COUNT(*) c FROM demand_signals').get() as { c: number }).c
  ok('D-3 未知 → UNKNOWN_CATEGORY + 全量 category_table + next_call(保留 keywords 转 any)', d3.error_code === 'UNKNOWN_CATEGORY'
    && Array.isArray(d3.category_table) && (d3.category_table as unknown[]).length >= CANONICAL_CATEGORIES.length
    && JSON.stringify((d3.recommended_next_call as Record<string, unknown>)?.arguments).includes('"any"'), JSON.stringify(d3).slice(0, 220))
  ok('D-4 无效 intent(400)不落 demand_signals(防污染第一块)', after === before, `before=${before} after=${after}`)

  // ── [K] keyword_match 契约 ────────────────────────────────────────────────────────────────
  const k1 = await call({ keywords: ['抽纸', '纸巾'] })   // 默认 all:同义词组互斥 → 0
  ok('K-1 默认 all 合取(现语义零破坏)→ 0 + match_semantics', Number(k1.count) === 0 && k1.match_semantics === 'all', JSON.stringify(k1).slice(0, 160))
  const hits = (k1.per_keyword_hits ?? []) as Array<{ keyword: string; hits: number }>
  ok('K-2 per_keyword_hits 指认凶手("纸巾"=0 杀掉全集)', hits.length === 2
    && hits.find(h => h.keyword === '抽纸')?.hits === 2 && hits.find(h => h.keyword === '纸巾')?.hits === 0, JSON.stringify(hits))
  const k2 = await call({ keywords: ['抽纸', '纸巾'], keyword_match: 'any' })
  ok('K-3 any 析取救活同义词组', Number(k2.count) === 2 && k2.match_semantics === 'any')
  const k3 = await call({ keywords: ['抽纸'], keyword_match: 'both' })
  ok('K-4 非法 keyword_match → 400', k3.error_code === 'INVALID_KEYWORD_MATCH')
  const k4 = await call({ category: '家庭清洁/纸品', keywords: ['抽纸', '茶语'], max_price: 12 })
  ok('K-5 all + 约束保留:类目+预算下合取命中恰 1', Number(k4.count) === 1, JSON.stringify(k4).slice(0, 160))
  const k5 = await call({ category: '家庭清洁/纸品', keywords: ['抽纸', '不存在词'], max_price: 12 })
  const h5 = (k5.per_keyword_hits ?? []) as Array<{ keyword: string; hits: number }>
  ok('K-6 逐词计数在【同约束】下(类目+预算保留;"抽纸"=1 非 2)', Number(k5.count) === 0
    && h5.find(h => h.keyword === '抽纸')?.hits === 1, JSON.stringify(h5))

  // ── [S] URL/路径形态拒绝(Codex R1-1:'/' 只为类目键放行,域名/路径形态零落库)────────────
  const before2 = (db.prepare('SELECT COUNT(*) c FROM demand_signals').get() as { c: number }).c
  for (const bad of ['x.com/page', '//host/path', 'a/b/c/d', '/lead', 'trail/']) {   // 真 URL/路径形态(scheme/host/多段/首尾斜杠/点+斜杠)
    const rb = await call({ keywords: [bad] })
    ok(`S-1 路径形态 "${bad}" → 400 拒收`, rb.error_code === 'INVALID_INTENT_TEXT', JSON.stringify(rb).slice(0, 120))
  }
  const after2 = (db.prepare('SELECT COUNT(*) c FROM demand_signals').get() as { c: number }).c
  ok('S-2 全部路径形态零落库', after2 === before2, `before=${before2} after=${after2}`)
  const s3 = await resolveCategory('家庭清洁/纸品')
  ok('S-3 canonical 单斜杠键仍放行(形状门与注册表零矛盾)', s3.status === 'canonical')
  // 合法复合商品词(单内部斜杠、无点、非 URL)必须放行 —— 只拒 URL 不拒任意斜杠(Codex R3-2)
  for (const good of ['1/2 inch', 'A/B', 'wet/dry', 'salt/pepper', 'shampoo/conditioner', 'account/login']) {
    const rg = await call({ keywords: [good] })
    ok(`S-4 合法复合词 "${good}" 放行(非 URL,单内部斜杠)`, rg.error_code === undefined, JSON.stringify(rg).slice(0, 100))
  }
  const kmCarry = await call({ category: '收纳', keywords: ['盒'], keyword_match: 'any' })
  const kmCalls = (kmCarry.recommended_next_calls ?? []) as Array<{ arguments: Record<string, unknown> }>
  ok('S-5 多义重放调用携带显式 keyword_match(语义不被替换回默认 all)', kmCalls.length === 4
    && kmCalls.every(c => c.arguments.keyword_match === 'any'), JSON.stringify(kmCalls[0] ?? {}))

  // ── [P] next_call 可重放性(Codex R1-2:不丢约束、无假占位符、逐字重放必须成功)──────────
  const amb = await call({ category: '收纳', keywords: ['盒'], max_price: 50, ship_to_region: 'SG' })
  const ncs = (amb.recommended_next_calls ?? []) as Array<{ tool: string; arguments: Record<string, unknown> }>
  ok('P-1 多义 → 逐选项结构化调用数组 + selection_required(无假占位符)', amb.selection_required === true
    && ncs.length === 4 && ncs.every(c => typeof c.arguments.category === 'string' && !String(c.arguments.category).includes('<')
      && c.arguments.max_price === 50 && c.arguments.ship_to_region === 'SG'), JSON.stringify(ncs).slice(0, 220))
  const replay = await call(ncs[0].arguments)
  ok('P-2 多义选项逐字重放成功(200,非 400)', replay.error_code === undefined && replay.count !== undefined, JSON.stringify(replay).slice(0, 120))
  const unk = await call({ category: 'zzz-nope', keywords: ['抽纸'], max_price: 15 })
  const unc = (unk.recommended_next_call ?? {}) as { arguments?: Record<string, unknown> }
  ok('P-3 未知(带 keywords)→ next_call 保留 max_price 等全部约束', unc.arguments?.max_price === 15
    && unc.arguments?.keyword_match === 'any', JSON.stringify(unc))
  // Codex R3-1:调用方显式 keyword_match:'all' 时,UNKNOWN recovery 的 forced 'any' 必须胜出(否则重试仍 all,可能又 0)
  const unkAll = await call({ category: 'zzz-nope', keywords: ['抽纸', '纸巾'], keyword_match: 'all' })
  const uncAll = (unkAll.recommended_next_call ?? {}) as { arguments?: Record<string, unknown> }
  ok('P-3b 未知 + 显式 all → recovery 强制 any 胜出(不被调用方 all 覆盖)', uncAll.arguments?.keyword_match === 'any', JSON.stringify(uncAll))
  const replay2 = await call(unc.arguments as Record<string, unknown>)
  ok('P-4 未知分支重放成功且预算生效(15 内恰 1 件)', Number(replay2.count) === 1, JSON.stringify(replay2).slice(0, 140))
  const unk2 = await call({ category: 'zzz-nope' })
  ok('P-5 纯 category 未知 → 无假可执行重试,selection_required 让 agent 从表自选', unk2.error_code === 'UNKNOWN_CATEGORY'
    && unk2.recommended_next_call === undefined && unk2.selection_required === true, JSON.stringify(unk2).slice(0, 160))

  // ── [L] 台账语义 ──────────────────────────────────────────────────────────────────────────
  const last = db.prepare("SELECT intent_json, category FROM demand_signals WHERE category = '家庭清洁/纸品' ORDER BY rowid DESC LIMIT 1").get() as { intent_json: string; category: string }
  const li = JSON.parse(last.intent_json) as Record<string, unknown>
  ok('L-1 intent_json 记录 keyword_match + canonical category 列', li.keyword_match !== undefined && last.category === '家庭清洁/纸品', JSON.stringify(last).slice(0, 200))
  const aliasRow = db.prepare("SELECT intent_json FROM demand_signals WHERE intent_json LIKE '%category_submitted%' LIMIT 1").get() as { intent_json: string } | undefined
  ok('L-2 alias 修正留痕(category_submitted 原词入 intent_json)', !!aliasRow && JSON.parse(aliasRow.intent_json).category_submitted === 'household')
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ agent-category-contract FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent-category-contract: canonical 注册表五态 + keyword_match any/all + 逐词诊断 + 400 不落台账 — 全绿\n  ✅ pass ${pass}`)
process.exit(0)
