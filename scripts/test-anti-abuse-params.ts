#!/usr/bin/env tsx
/**
 * #420 P1-2/P1-3/P1-4 — 反滥用阈值 governance-adjustable 化的回归测试。
 *   用法:npm run test:anti-abuse-params
 *
 * 证明四件事(对应 #420 acceptance):
 *   A. 默认 protocol_params === 抽取前硬编码字面量 ⇒ 当前生产行为不变(behavior-preserving)。
 *   B/C/D/E. 生产与测试【共用同一】纯决策函数(agentTrustLevel / agentStrikeSeverity /
 *      verifierOutlierBand / agentSybilPenalty):默认参数复现旧行为,改参数则判定随之移动
 *      ⇒ 治理可调真实生效(非装饰)。
 *   F. readAntiAbuseThresholds:缺行/坏值回落默认;写入新值后读取反映新值(治理读路径)。
 *   G. 治理/配置路径:PATCH /api/admin/protocol-params/:key 对新参数 in-range 成功+落库+
 *      reader 反映;out-of-range(min/max)被拒 ⇒ 改参数走既定治理接口可行且有护栏。
 *   H. 结构不变量守卫:MCP handleRegister 在 NETWORK 模式下的"不自助建号 → 引导真人"守卫
 *      必须存在且【先于】任何建号 INSERT(network self-create 永远走不到建号)。MCP server
 *      import 即起 stdio transport,故用源码不变量守卫(非行为测试)护住这条铁律不被误删。
 *
 * 邀请制注册强制 / 邮箱验证优先 由 test:register-email-verify 覆盖(本 PR 同时跑作回归)。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import {
  ANTI_ABUSE_PARAMS, DEFAULT_ANTI_ABUSE_THRESHOLDS, readAntiAbuseThresholds,
  agentTrustLevel, agentStrikeSeverity, verifierOutlierBand, agentSybilPenalty,
  type AntiAbuseThresholds,
} from '../src/pwa/anti-abuse-thresholds.js'
import { registerAdminProtocolParamsRoutes } from '../src/pwa/routes/admin-protocol-params.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Part A — 默认值锁(独立硬编码 expected,捕捉任何字面量漂移) ───────────────
// 这些数字 = 抽取前 server.ts / claim-verify.ts 里的原始字面量。
const EXPECTED_OLD_LITERALS: Record<string, number> = {
  agent_trust_dispute_penalty: 10,
  agent_trust_sybil_free_threshold: 3,
  agent_trust_sybil_penalty: 5,
  agent_trust_cross_penalty: 3,
  agent_trust_ratelimit_penalty: 2,
  agent_trust_level_trusted: 20,
  agent_trust_level_quality: 50,
  agent_trust_level_legend: 80,
  agent_strike_warn_window_days: 7,
  agent_strike_warn_escalate_count: 1,
  agent_strike_suspend_window_days: 30,
  agent_strike_suspend_escalate_count: 2,
  agent_strike_warn_expiry_hours: 24,
  agent_strike_suspend_expiry_days: 7,
  verifier_outlier_window_days: 180,
  verifier_outlier_suspend_count: 3,
  verifier_outlier_revoke_count: 5,
  verifier_outlier_suspend_days: 30,
}

function partA(): void {
  const byKey = new Map(ANTI_ABUSE_PARAMS.map(p => [p.key, p]))
  // 每个 expected key 都有对应 param,且默认值 === 旧字面量,且有 type/min/max
  for (const [key, lit] of Object.entries(EXPECTED_OLD_LITERALS)) {
    const p = byKey.get(key)
    ok(`A: param 存在 ${key}`, !!p)
    if (!p) continue
    ok(`A: ${key} value=${lit}`, Number(p.value) === lit, `got ${p.value}`)
    ok(`A: ${key} type=number`, p.type === 'number')
    ok(`A: ${key} 有 min/max 护栏`, typeof p.min === 'number' && typeof p.max === 'number', `min=${p.min} max=${p.max}`)
    ok(`A: ${key} 默认在 [min,max] 内`, p.min! <= lit && lit <= p.max!, `${p.min}..${p.max}`)
  }
  // 反向:没有多余/漏掉的 param
  ok('A: ANTI_ABUSE_PARAMS 数量 === expected', ANTI_ABUSE_PARAMS.length === Object.keys(EXPECTED_OLD_LITERALS).length,
    `params=${ANTI_ABUSE_PARAMS.length} expected=${Object.keys(EXPECTED_OLD_LITERALS).length}`)
  for (const p of ANTI_ABUSE_PARAMS) ok(`A: ${p.key} 在 expected 表内`, p.key in EXPECTED_OLD_LITERALS)
  // DEFAULT_ANTI_ABUSE_THRESHOLDS 与 param 默认值一致(防两处真相源漂移)
  const t = DEFAULT_ANTI_ABUSE_THRESHOLDS
  ok('A: defaults.trustDisputePenalty', t.trustDisputePenalty === 10)
  ok('A: defaults.trustSybilFreeThreshold', t.trustSybilFreeThreshold === 3)
  ok('A: defaults.trustLevelLegend', t.trustLevelLegend === 80)
  ok('A: defaults.strikeWarnEscalateCount', t.strikeWarnEscalateCount === 1)
  ok('A: defaults.strikeSuspendEscalateCount', t.strikeSuspendEscalateCount === 2)
  ok('A: defaults.outlierSuspendCount', t.outlierSuspendCount === 3)
  ok('A: defaults.outlierRevokeCount', t.outlierRevokeCount === 5)
  ok('A: defaults.outlierWindowDays', t.outlierWindowDays === 180)
}

// ─── Part B — agentTrustLevel(P1-2 等级 cutoff) ────────────────────────────
function partB(): void {
  const d = DEFAULT_ANTI_ABUSE_THRESHOLDS
  ok('B: 0 → new', agentTrustLevel(0, d) === 'new')
  ok('B: 19.99 → new', agentTrustLevel(19.99, d) === 'new')
  ok('B: 20 → trusted', agentTrustLevel(20, d) === 'trusted')
  ok('B: 49.99 → trusted', agentTrustLevel(49.99, d) === 'trusted')
  ok('B: 50 → quality', agentTrustLevel(50, d) === 'quality')
  ok('B: 79.99 → quality', agentTrustLevel(79.99, d) === 'quality')
  ok('B: 80 → legend', agentTrustLevel(80, d) === 'legend')
  // 治理收紧:cutoff 下移则同一分数升级更易
  const tighter: AntiAbuseThresholds = { ...d, trustLevelTrusted: 10, trustLevelQuality: 30, trustLevelLegend: 60 }
  ok('B: 治理改 cutoff → 10 现在 trusted', agentTrustLevel(10, tighter) === 'trusted')
  ok('B: 治理改 cutoff → 60 现在 legend', agentTrustLevel(60, tighter) === 'legend')
  ok('B: 治理改 cutoff → 9 仍 new', agentTrustLevel(9, tighter) === 'new')
}

// ─── Part C — agentStrikeSeverity(P1-4 升级阶梯) ───────────────────────────
function partC(): void {
  const d = DEFAULT_ANTI_ABUSE_THRESHOLDS
  ok('C: warning + 0 prior → warning', JSON.stringify(agentStrikeSeverity('warning', 0, 0, d)) === JSON.stringify({ severity: 'warning', escalated: false }))
  ok('C: warning + 1 prior warn → suspend_7d(escalate)', JSON.stringify(agentStrikeSeverity('warning', 1, 0, d)) === JSON.stringify({ severity: 'suspend_7d', escalated: true }))
  ok('C: warning + 1 warn + 2 susp → permanent', JSON.stringify(agentStrikeSeverity('warning', 1, 2, d)) === JSON.stringify({ severity: 'permanent', escalated: true }))
  ok('C: suspend_7d + 1 prior susp → suspend_7d', JSON.stringify(agentStrikeSeverity('suspend_7d', 0, 1, d)) === JSON.stringify({ severity: 'suspend_7d', escalated: false }))
  ok('C: suspend_7d + 2 prior susp → permanent', JSON.stringify(agentStrikeSeverity('suspend_7d', 0, 2, d)) === JSON.stringify({ severity: 'permanent', escalated: true }))
  ok('C: permanent 不再二次 escalate', JSON.stringify(agentStrikeSeverity('permanent', 9, 9, d)) === JSON.stringify({ severity: 'permanent', escalated: false }))
  // 治理放宽 warn 升级阈值:需要 2 次 prior 才升级
  const looser: AntiAbuseThresholds = { ...d, strikeWarnEscalateCount: 2 }
  ok('C: 治理改 warnEscalate=2 → 1 prior 仍 warning', JSON.stringify(agentStrikeSeverity('warning', 1, 0, looser)) === JSON.stringify({ severity: 'warning', escalated: false }))
  ok('C: 治理改 warnEscalate=2 → 2 prior → suspend', JSON.stringify(agentStrikeSeverity('warning', 2, 0, looser)) === JSON.stringify({ severity: 'suspend_7d', escalated: true }))
}

// ─── Part D — verifierOutlierBand(P1-3 outlier 档位) ───────────────────────
function partD(): void {
  const d = DEFAULT_ANTI_ABUSE_THRESHOLDS
  ok('D: 0 → none', verifierOutlierBand(0, d) === 'none')
  ok('D: 2 → none', verifierOutlierBand(2, d) === 'none')
  ok('D: 3 → suspend', verifierOutlierBand(3, d) === 'suspend')
  ok('D: 4 → suspend', verifierOutlierBand(4, d) === 'suspend')
  ok('D: 5 → revoke', verifierOutlierBand(5, d) === 'revoke')
  ok('D: 10 → revoke', verifierOutlierBand(10, d) === 'revoke')
  const tighter: AntiAbuseThresholds = { ...d, outlierSuspendCount: 2, outlierRevokeCount: 4 }
  ok('D: 治理改 → 2 现在 suspend', verifierOutlierBand(2, tighter) === 'suspend')
  ok('D: 治理改 → 4 现在 revoke', verifierOutlierBand(4, tighter) === 'revoke')
}

// ─── Part E — agentSybilPenalty(P1-2 sybil 罚分) ──────────────────────────
function partE(): void {
  const d = DEFAULT_ANTI_ABUSE_THRESHOLDS
  ok('E: size 3 → 0(free 阈值内)', agentSybilPenalty(3, d) === 0)
  ok('E: size 4 → -5', agentSybilPenalty(4, d) === -5)
  ok('E: size 6 → -15', agentSybilPenalty(6, d) === -15)
  ok('E: size 0 → 0', agentSybilPenalty(0, d) === 0)
  const tighter: AntiAbuseThresholds = { ...d, trustSybilFreeThreshold: 1, trustSybilPenalty: 2 }
  ok('E: 治理改 → size 3 现在 -4', agentSybilPenalty(3, tighter) === -4)
}

// ─── Part F — readAntiAbuseThresholds(读路径 + 回落) ──────────────────────
function makeParamsDb(): any {
  const db: any = new Database(':memory:')
  db.exec(`CREATE TABLE protocol_params (key TEXT PRIMARY KEY, value TEXT, type TEXT, description TEXT, category TEXT, default_value TEXT, min_value REAL, max_value REAL, updated_at TEXT, updated_by TEXT, requires_meta_rule_change INTEGER)`)
  db.exec(`CREATE TABLE protocol_params_log (id TEXT PRIMARY KEY, key TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, action TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  return db
}
function seedAntiAbuseParams(db: any): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO protocol_params (key, value, type, description, category, default_value, min_value, max_value) VALUES (?,?,?,?,?,?,?,?)`)
  for (const p of ANTI_ABUSE_PARAMS) ins.run(p.key, p.value, p.type, p.description, p.category, p.value, p.min ?? null, p.max ?? null)
}

function partF(): void {
  // 空表(无任何参数行)→ 全部回落默认
  const empty = makeParamsDb()
  ok('F: 空表 → 默认', JSON.stringify(readAntiAbuseThresholds(empty)) === JSON.stringify(DEFAULT_ANTI_ABUSE_THRESHOLDS))
  // 灌默认 seed → 与默认完全一致
  const seeded = makeParamsDb(); seedAntiAbuseParams(seeded)
  ok('F: 默认 seed → 默认', JSON.stringify(readAntiAbuseThresholds(seeded)) === JSON.stringify(DEFAULT_ANTI_ABUSE_THRESHOLDS))
  // 改一行 → reader 反映新值
  seeded.prepare(`UPDATE protocol_params SET value = '60' WHERE key = 'agent_trust_level_legend'`).run()
  seeded.prepare(`UPDATE protocol_params SET value = '99' WHERE key = 'verifier_outlier_window_days'`).run()
  const after = readAntiAbuseThresholds(seeded)
  ok('F: 改 legend cutoff → 反映 60', after.trustLevelLegend === 60)
  ok('F: 改 outlier window → 反映 99', after.outlierWindowDays === 99)
  ok('F: 未改字段保持默认', after.trustLevelTrusted === 20)
  // 坏值(非数字)→ 回落默认(不抛)
  const bad = makeParamsDb(); seedAntiAbuseParams(bad)
  bad.prepare(`UPDATE protocol_params SET value = 'NaN' WHERE key = 'agent_trust_dispute_penalty'`).run()
  ok('F: 坏值 → 回落默认 10', readAntiAbuseThresholds(bad).trustDisputePenalty === 10)
  // 窗口天数做整数化(intNum)
  const frac = makeParamsDb(); seedAntiAbuseParams(frac)
  frac.prepare(`UPDATE protocol_params SET value = '90.7' WHERE key = 'verifier_outlier_window_days'`).run()
  ok('F: 窗口天数取整 90.7 → 91', readAntiAbuseThresholds(frac).outlierWindowDays === 91)
}

// ─── Part G — 治理/配置路径(admin PATCH 真实接口) ────────────────────────
const post = (port: number, method: 'PATCH', path: string, body: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = JSON.stringify(body)
  const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch { /* noop */ } resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.write(p); r.end()
})

async function partG(): Promise<void> {
  const db: any = makeParamsDb(); seedAntiAbuseParams(db)
  setSeamDb(db)
  const app = express(); app.use(express.json())
  const adminStub = (_req: Request, _res: Response) => ({ id: 'usr_admin_test' })
  registerAdminProtocolParamsRoutes(app, {
    db,
    generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`,
    requireAdmin: adminStub,
    requireProtocolAdmin: adminStub,
  })
  const server: Server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port

  // in-range 修改成功 + 落库 + reader 反映
  const r1 = await post(port, 'PATCH', '/api/admin/protocol-params/agent_strike_warn_escalate_count', { value: 3 })
  ok('G: in-range PATCH → 200', r1.status === 200 && r1.json?.success === true, `status=${r1.status} body=${JSON.stringify(r1.json)}`)
  ok('G: 落库 value=3', String(db.prepare(`SELECT value FROM protocol_params WHERE key='agent_strike_warn_escalate_count'`).get()?.value) === '3')
  ok('G: reader 反映 3', readAntiAbuseThresholds(db).strikeWarnEscalateCount === 3)
  // 改完后纯决策函数随新阈值移动(端到端:治理改 → 行为变)
  ok('G: 端到端 warnEscalate=3 → 2 prior 仍 warning', agentStrikeSeverity('warning', 2, 0, readAntiAbuseThresholds(db)).severity === 'warning')

  // out-of-range:超过 max(level_legend max=1000)
  const r2 = await post(port, 'PATCH', '/api/admin/protocol-params/agent_trust_level_legend', { value: 99999 })
  ok('G: 超 max → 400', r2.status === 400, `status=${r2.status}`)
  ok('G: 超 max 不落库(仍 80)', String(db.prepare(`SELECT value FROM protocol_params WHERE key='agent_trust_level_legend'`).get()?.value) === '80')

  // out-of-range:低于 min(suspend_count min=1)
  const r3 = await post(port, 'PATCH', '/api/admin/protocol-params/verifier_outlier_suspend_count', { value: 0 })
  ok('G: 低于 min → 400', r3.status === 400, `status=${r3.status}`)

  // 类型错误
  const r4 = await post(port, 'PATCH', '/api/admin/protocol-params/agent_trust_dispute_penalty', { value: 'abc' })
  ok('G: 非数字 → 400', r4.status === 400, `status=${r4.status}`)

  await new Promise<void>(r => server.close(() => r()))
}

// ─── Part H — MCP network self-create 守卫(源码不变量) ────────────────────
function partH(): void {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let src = ''
  try { src = readFileSync(path.join(here, '../src/layer1-agent/L1-1-mcp-server/server.ts'), 'utf8') } catch { /* noop */ }
  ok('H: 读到 MCP server 源码', src.length > 0)
  if (!src) return
  const startIdx = src.indexOf('function handleRegister')
  ok('H: handleRegister 存在', startIdx >= 0)
  if (startIdx < 0) return
  const rest = src.slice(startIdx + 'function handleRegister'.length)
  const nextFn = rest.search(/\nfunction [a-zA-Z]/)
  const body = nextFn >= 0 ? rest.slice(0, nextFn) : rest
  const guardIdx = body.indexOf('isNetworkMode()')
  const redirectIdx = body.indexOf('must_be_done_by_human_at_webaz_xyz')
  const insertIdx = body.indexOf('INSERT INTO users')
  ok('H: 含 isNetworkMode 守卫', guardIdx >= 0)
  ok('H: 含 human 重定向(NETWORK 不自助建号)', redirectIdx >= 0)
  ok('H: 含 sandbox 建号路径(INSERT INTO users)', insertIdx >= 0)
  // 铁律:network 守卫 + 重定向【先于】建号 INSERT ⇒ NETWORK 模式永远走不到自助建号
  ok('H: network 守卫先于建号 INSERT', guardIdx >= 0 && redirectIdx >= 0 && insertIdx >= 0 && guardIdx < insertIdx && redirectIdx < insertIdx,
    `guard=${guardIdx} redirect=${redirectIdx} insert=${insertIdx}`)
}

async function main(): Promise<void> {
  partA(); partB(); partC(); partD(); partE(); partF()
  await partG()
  partH()

  console.log(`\n${fail === 0 ? '✅' : '❌'} anti-abuse-params: ${pass} pass / ${fail} fail`)
  if (fail > 0) { console.log(fails.join('\n')); process.exit(1) }
}
main().catch(e => { console.error(e); process.exit(1) })
