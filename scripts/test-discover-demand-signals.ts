#!/usr/bin/env tsx
/**
 * RFC-025 PR-2 — webaz_discover + demand_signals(「有结果输出结果,没结果记录,形成商机」)。
 *   用法:npm run test:discover-demand-signals
 *
 * 真实 ephemeral PWA + 真实 grant(不桩被测组件)。覆盖:
 *   诚实纪律:候选恒标 discovery_candidate;0 命中 → no_candidates + 引导,绝不相似冒充;
 *   采集:【每次】查询落一行 demand_signals(result_count 含 0);intent 只存 allowlist 字段;
 *   披露:响应带 disclosure;工具 description 含采集披露(源守卫);
 *   边界:目的地 sale_regions 过滤 · 预算过滤 · 空 intent 400 · 缺 scope PERMISSION_REQUIRED ·
 *         非-grandfathering(旧 read 快照 grant 不自动获得 buyer_discover)· LIKE 通配转义。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-disc-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('seller1','S','seller','k_s')").run()
// 商品:两个 stand(一个限售 SG,一个全球),一个贵的,一个 paused(不可见),一个 0 库存(不可见)
const insP = db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,sale_regions) VALUES (?,?,?,?,?,?,?,?,?,?)`)
insP.run('prd_sg', 'seller1', 'Aluminum Phone Stand SG', 'd', 20, 'WAZ', 5, 'phone_stand', 'active', JSON.stringify({ mode: 'list', include: ['SG'] }))
insP.run('prd_all', 'seller1', 'Bamboo Phone Stand Global', 'd', 15, 'WAZ', 5, 'phone_stand', 'active', null)
insP.run('prd_rich', 'seller1', 'Titanium Phone Stand Pro', 'd', 900, 'WAZ', 5, 'phone_stand', 'active', null)
insP.run('prd_paused', 'seller1', 'Paused Phone Stand', 'd', 10, 'WAZ', 5, 'phone_stand', 'paused', null)
insP.run('prd_oos', 'seller1', 'OOS Phone Stand', 'd', 10, 'WAZ', 0, 'phone_stand', 'active', null)
insP.run('prd_pct', 'seller1', 'Deal 100% Cotton Towel', 'd', 8, 'WAZ', 5, 'towel', 'active', null)

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const mkGrant = (grantId: string, humanId: string, bearer: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
    .run(grantId, humanId, 'DA', JSON.stringify(caps.map(c => ({ capability: c }))), sha(bearer), new Date(Date.now() + 3600_000).toISOString())
}
const useCred = (grantId: string, bearer: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token: bearer, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const signals = () => db.prepare('SELECT * FROM demand_signals ORDER BY created_at, id').all() as Array<Record<string, unknown>>

mkGrant('grt_disc', 'buyer1', 'gtk_disc', ['buyer_discover'])
// 非-grandfathering:旧 read 快照(PR-2 之前铸的,含 PR-1 的 buyer_orders_read_minimal 但无 buyer_discover)
const OLD_READ_SET = ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal', 'buyer_orders_read_minimal']
mkGrant('grt_oldread', 'buyer1', 'gtk_old', OLD_READ_SET)

try {
  clearCred()
  ok('D-1 no grant → GRANT_REQUIRED', (await mcp.handleDiscover({ category: 'phone_stand' })).error_code === 'GRANT_REQUIRED')
  ok('D-1b no signal recorded without a grant', signals().length === 0)

  useCred('grt_disc', 'gtk_disc', ['buyer_discover'])
  { const r = await mcp.handleDiscover({ category: 'phone_stand', max_price: 50 })   // 命中(预算滤掉 900)
    const cands = r.candidates as Array<Record<string, unknown>> | undefined
    ok('D-2 hits → candidates (budget filters out the 900 one; paused/OOS invisible)', Array.isArray(cands) && cands.length === 2, JSON.stringify(r).slice(0, 300))
    ok('D-3 EVERY candidate labeled discovery_candidate (honest, never exact-match cosplay)', !!cands?.length && cands.every(c => c.label === 'discovery_candidate'))
    ok('D-4 response carries the collection disclosure', /demand signal/i.test(String(r.disclosure)))
    const sig = signals()
    ok('D-5 hit query ALSO recorded (result_count = 2)', sig.length === 1 && sig[0].result_count === 2 && sig[0].human_id === 'buyer1' && sig[0].source === 'mcp_discover', JSON.stringify(sig).slice(0, 200))
    // RFC-029 后续 — discover 多结果契约:签发 result_handle + detail_fetch_template(UP TO 5 一张对比卡),
    //   不funnel成"复制某款完整标题去 webaz_search"(严格匹配→单品),也不模糊乱凑。
    ok('D-5a multi-result → result_handle + selectable_ids (id-面渲染,不复制标题)', typeof r.result_handle === 'string' && Array.isArray(r.selectable_ids) && (r.selectable_ids as unknown[]).length === cands!.length)
    ok('D-5b detail_fetch_template = webaz_search(result_handle, selected_ids) with UP TO 5 ids (not 1)', (() => { const t = r.detail_fetch_template as { tool?: string; arguments?: { result_handle?: string; selected_ids?: unknown[] } } | undefined; return !!t && t.tool === 'webaz_search' && t.arguments?.result_handle === r.result_handle && Array.isArray(t.arguments?.selected_ids) && (t.arguments!.selected_ids as unknown[]).length === Math.min(5, cands!.length) })())
    ok('D-5c display_hint steers a multi-product comparison card + recommend_id, NEVER "exact product title you picked"', typeof r.display_hint === 'string' && /comparison card|up to 5/i.test(String(r.display_hint)) && /recommend_id/.test(String(r.display_hint)) && !/exact product title you picked/i.test(String(r.display_hint))) }
  // 6-candidate case → count=6, selectable_ids=6, template caps selected_ids at 5 (一张卡展示5,不缩1、不越5)
  db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('seller_m','SM','seller','k_sm')").run()
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES (?,?,?,?,?,?,?,?,?)").run('prd_m' + i, 'seller_m', 'Multi Tray ' + i, 'd', 10 + i, 'WAZ', 5, 'desk_organizer', 'active')
  { const r = await mcp.handleDiscover({ category: 'desk_organizer' })
    const cands = r.candidates as Array<Record<string, unknown>> | undefined
    ok('D-5d 6 candidates → count=6, selectable_ids=6 (all preserved, none dropped)', Array.isArray(cands) && cands.length === 6 && Array.isArray(r.selectable_ids) && (r.selectable_ids as unknown[]).length === 6)
    ok('D-5e template caps at 5 for the one comparison card', ((r.detail_fetch_template as { arguments?: { selected_ids?: unknown[] } }).arguments!.selected_ids as unknown[]).length === 5) }
  { const r = await mcp.handleDiscover({ category: 'phone_stand', ship_to_region: 'US', max_price: 50 })   // SG-only 被目的地过滤
    const cands = r.candidates as Array<Record<string, unknown>> | undefined
    ok('D-6 sale_regions destination filter (SG-only listing excluded for US)', Array.isArray(cands) && cands.length === 1 && cands[0].product_id === 'prd_all', JSON.stringify(r).slice(0, 300)) }
  { const before = signals()
    const r = await mcp.handleDiscover({ keywords: ['nonexistent-gadget-xyz'] })   // 0 命中
    ok('D-7 zero hits → honest no_candidates + guidance (RFQ / #discover), nothing similar substituted', r.no_candidates === true && (r.candidates as unknown[]).length === 0 && /RFQ/.test(String(r.note)))
    const added = signals().filter(a => !before.some(bb => bb.id === a.id))
    ok('D-8 zero-hit query recorded as demand signal (result_count = 0 = 商机)', added.length === 1 && added[0].result_count === 0, JSON.stringify(added).slice(0, 200))
    const intent = JSON.parse(String(added[0]?.intent_json ?? '{}'))
    ok('D-9 intent_json = allowlist fields ONLY (no free text keys)', JSON.stringify(Object.keys(intent).sort()) === JSON.stringify(['category', 'keyword_match', 'keywords', 'max_price', 'quantity', 'ship_to_region'])) }
  { const r = await mcp.handleDiscover({ keywords: ['100%'] })   // LIKE 通配转义:字面匹配 '100%',不是"任意"
    const cands = r.candidates as Array<Record<string, unknown>> | undefined
    ok('D-10 LIKE wildcard escaped: "100%" matches literally (1 hit), not everything', Array.isArray(cands) && cands.length === 1 && cands[0].product_id === 'prd_pct', JSON.stringify(r).slice(0, 200)) }
  { const r = await mcp.handleDiscover({})   // 空 intent
    ok('D-11 empty intent → EMPTY_INTENT 400 (free chat text not accepted)', r.error_code === 'EMPTY_INTENT') }

  useCred('grt_oldread', 'gtk_old', OLD_READ_SET)
  { const before13 = signals().length
    const r = await mcp.handleDiscover({ category: 'phone_stand' })
    ok('D-12 NON-GRANDFATHERING: pre-PR read-snapshot grant does NOT gain buyer_discover', r.error_code === 'PERMISSION_REQUIRED', JSON.stringify(r).slice(0, 200))
    ok('D-13 denied call records NO signal (explicit before/after)', signals().length === before13) }

  // 源守卫:工具 description 必须披露采集(诚实化方法论)
  const src = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('D-14 tool description discloses the demand-signal recording', /DISCLOSURE: every VALID query is recorded/.test(src))

  // ── 对抗性隐私(Codex PR-2 High/Medium):走私 PII 必须 400 且【零落库】——披露"不收自由文本/PII"必须为真 ──
  useCred('grt_disc', 'gtk_disc', ['buyer_discover'])
  for (const [name, payload] of [
    ['email in keywords', { keywords: ['john.doe@example.com'] }],
    ['phone in keywords', { keywords: ['+65 9123 4567'] }],
    ['URL in keywords', { keywords: ['https://evil.example/x'] }],
    ['email in category', { category: 'contact me a@b.co' }],
    ['phone-run in category', { category: 'call 91234567 now' }],
    ['free chat punctuation', { keywords: ['hi, please find me a stand!'] }],
    // round-2 绕过向量(Codex):超长静默截断 / 分隔符打断电话数字连
    ['overlength (41ch, marker after cut)', { keywords: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@'] }],
    ['phone via underscore separators', { keywords: ['912_3456_7'] }],
    ['phone via plus separators', { category: '912+3456+7' }],
    ['more than 5 keywords', { keywords: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] }],
  ] as const) {
    const before = signals().length
    const r = await mcp.handleDiscover(payload as Record<string, unknown>)
    ok(`D-15 PII smuggle rejected as HTTP 400 + unrecorded (${name})`, r.error_code === 'INVALID_INTENT_TEXT' && r.http_status === 400 && signals().length === before, JSON.stringify(r).slice(0, 150))
  }

  // ── 失败诚实(Codex PR-2 Low):落库不可用 ⇒ 503 且不带 candidates(披露为记录的绝不无记录运行) ──
  { db.exec('ALTER TABLE demand_signals RENAME TO demand_signals_hidden')
    const r = await mcp.handleDiscover({ category: 'phone_stand' })
    ok('D-16 signal-write failure → 503 DEMAND_SIGNAL_WRITE_FAILED, NO candidates escape', r.error_code === 'DEMAND_SIGNAL_WRITE_FAILED' && r.candidates === undefined, JSON.stringify(r).slice(0, 200))
    db.exec('ALTER TABLE demand_signals_hidden RENAME TO demand_signals')
    const before17 = signals().length
    const r2 = await mcp.handleDiscover({ category: 'phone_stand', max_price: 50 })
    ok('D-17 recovers after ledger returns (candidates AND exactly one new signal row)', Array.isArray(r2.candidates) && (r2.candidates as unknown[]).length === 2 && signals().length === before17 + 1) }

  // ── admin 隔离(源守卫):raw signals 端点第一行必须是 adminAuth 门 ──
  const adminSrc = readFileSync('src/pwa/routes/admin-analytics.ts', 'utf8')
  ok('D-18 /api/admin/demand-signals is adminAuth-gated (guard precedes any query)',
    /app\.get\('\/api\/admin\/demand-signals', async \(req, res\) => \{\n    if \(!adminAuth\(req, res\)\) return/.test(adminSrc))
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ discover-demand-signals FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ discover-demand-signals: 有结果输出结果(诚实标注),没结果记录(形成商机)· allowlist intent · 披露 · 目的地/预算过滤 · 非-grandfathering\n  ✅ pass ${pass}`)
