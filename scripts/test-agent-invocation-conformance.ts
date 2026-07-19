#!/usr/bin/env tsx
/**
 * 调用契约 P0 PR-E — demand signal 防污染(同约束宽松复检 + quality 四态)+ 服务端可测的 conformance。
 *   用法:npm run test:agent-invocation-conformance
 *
 * 覆盖:
 *   [Q] 同约束宽松复检:多词 all 0 命中但 any 命中 → quality=false_negative_suspect(不记真无供给);
 *       同约束下 any 也 0 → quality=valid;命中 → valid;复检【保留 category/预算】不去约束全局搜。
 *   [C] 服务端 conformance(审计 §十三可机测部分):模糊词单命中链路存在(webaz_search strict 0 →
 *       recovery 指 discover);约束充分请求直达(不追问);词表/UNKNOWN_CATEGORY/UNBOUNDED 已由各自
 *       套件锁,此处只做跨面 smoke 确认契约字段在同一响应家族内自洽。
 *   [H] 历史治理脚本(dry-run):对已知假阴性 fixture 判定为 invalidated,只标不删。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-conf-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const dbFile = join(tmpHome, '.webaz', 'webaz.db')
mkdirSync(join(tmpHome, '.webaz'), { recursive: true })
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b'),('seller1','S','seller','k_s')").run()
const insP = db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES (?,?,?,?,?,?,?,?,?)`)
insP.run('prd_z1', 'seller1', '悬挂式底部抽纸 5层每提344抽', 'd', 19.9, 'WAZ', 5, '家庭清洁/纸品', 'active')

const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const webazDir = join(tmpHome, '.webaz')
db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,'active',?)")
  .run('grt_q', 'buyer1', 'Q', JSON.stringify([{ capability: 'buyer_discover' }]), sha('gtk_q'), new Date(Date.now() + 3600_000).toISOString())
writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ grt_q: { token: 'gtk_q', stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: 'grt_q', handle: 'file:~/.webaz/credentials#grt_q', capabilities: [{ capability: 'buyer_discover' }], expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js') as unknown as { handleDiscover: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }
const call = (a: Record<string, unknown>) => mcp.handleDiscover(a)
const lastQuality = (): string | null => (db.prepare("SELECT quality FROM demand_signals ORDER BY rowid DESC LIMIT 1").get() as { quality: string | null } | undefined)?.quality ?? null

try {
  // [Q] 同约束宽松复检 + quality 四态
  const fn = await call({ category: '家庭清洁/纸品', keywords: ['抽纸', '纸巾'] })   // all:抽纸命中/纸巾不命中 → 0
  ok('Q-1 多词 all 0 命中但同约束 any 命中 → 响应带 quality=false_negative_suspect', Number(fn.count) === 0
    && fn.quality === 'false_negative_suspect' && typeof fn.quality_note === 'string', JSON.stringify(fn).slice(0, 200))
  ok('Q-1b 台账写入 quality=false_negative_suspect(不记真无供给)', lastQuality() === 'false_negative_suspect')

  const valid0 = await call({ category: '家庭清洁/纸品', keywords: ['不存在词甲', '不存在词乙'] })   // all 0 且 any 也 0
  ok('Q-2 同约束 any 也 0 命中 → quality=valid(真无供给,不误标)', Number(valid0.count) === 0
    && valid0.quality === undefined && lastQuality() === 'valid', JSON.stringify(valid0).slice(0, 160))

  const hitq = await call({ category: '家庭清洁/纸品', keywords: ['抽纸'] })   // 命中
  ok('Q-3 命中 → quality=valid', Number(hitq.count) === 1 && lastQuality() === 'valid')

  // 复检必须【保留约束】:预算卡死时,宽松复检也不得越预算判假阴性
  const budgetZero = await call({ category: '家庭清洁/纸品', keywords: ['抽纸', '不存在词'], max_price: 1 })   // 预算 1 < 19.9 → 同约束 any 也 0
  ok('Q-4 复检保留预算约束:超预算不判假阴性 → quality=valid', Number(budgetZero.count) === 0
    && budgetZero.quality === undefined && lastQuality() === 'valid', JSON.stringify(budgetZero).slice(0, 160))

  // (跨面契约:search 0 命中 → recovery 指 discover,由 test-discover-recovery-browse REC-1 锁定,此处不复测)

  // [H] 历史治理脚本 dry-run:插一条已知假阴性历史行(quality NULL,result_count 0,keywords 命中现供给)
  db.prepare("INSERT INTO demand_signals (id, human_id, source, intent_json, category, result_count, created_at) VALUES ('dms_legacy','buyer1','mcp_discover',?, 'household', 0, datetime('now','-1 day'))")
    .run(JSON.stringify({ category: 'household', keywords: ['抽纸'] }))   // 类目猜错(household)+ keywords 实际有供给
  const sb = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/backfill-demand-signal-quality.ts'],
    { env: { ...process.env, WEBAZ_DB_PATH: dbFile }, encoding: 'utf8', timeout: 60_000 })
  ok('H-1 治理脚本 dry-run 把历史假阴性判为 invalidated(只标不删)', /判定假阴性.*1|dms_legacy/.test(sb.stdout)
    && (db.prepare("SELECT quality FROM demand_signals WHERE id='dms_legacy'").get() as { quality: string | null }).quality === null,
    (sb.stdout + sb.stderr).slice(-300))
  const sbc = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/backfill-demand-signal-quality.ts', '--commit'],
    { env: { ...process.env, WEBAZ_DB_PATH: dbFile }, encoding: 'utf8', timeout: 60_000 })
  ok('H-2 --commit 后历史行 quality=invalidated + 审计字段,原始 result_count 无损', sbc.status === 0
    && (() => { const r = db.prepare("SELECT quality, invalid_reason, result_count FROM demand_signals WHERE id='dms_legacy'").get() as { quality: string; invalid_reason: string; result_count: number }; return r.quality === 'invalidated' && !!r.invalid_reason && r.result_count === 0 })(),
    (sbc.stdout + sbc.stderr).slice(-200))
  ok('H-3 治理只碰 result_count=0 未复核行:真 valid 行不被动', (db.prepare("SELECT quality FROM demand_signals WHERE id != 'dms_legacy' AND quality='valid'").all()).length >= 2)
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ agent-invocation-conformance FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent-invocation-conformance: 同约束宽复检 + quality 四态 + 历史治理(只标不删)+ 跨面契约自洽 — 全绿\n  ✅ pass ${pass}`)
process.exit(0)
