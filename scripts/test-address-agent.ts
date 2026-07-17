#!/usr/bin/env tsx
/**
 * RFC-026 PR-5 — webaz_address(masked 读 + Passkey 门变更请求)。用法:npm run test:address-agent
 *
 * 真实 route + 真 oat_。覆盖:scope 双门/非-grandfathering · masked 读绝无子串 · 变更请求零直写 +
 * PII 只进专表(action_params/审计零全文)· 人工列表附全文(human-authed)· Passkey 三元组批准
 * 才写 users · 同 hash 幂等/异 hash 冲突 · 拒绝清 PII · 提交后 agent 仍只有 masked · drift 拒执行。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-addr-'))
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
try { db.exec('ALTER TABLE users ADD COLUMN default_address_text TEXT') } catch { /* boot ALTER */ }
try { db.exec('ALTER TABLE users ADD COLUMN default_address_region TEXT') } catch { /* boot ALTER */ }

const OLD_ADDR = 'Old Home 7 OLDSECRET Ave #01-01 +65 90000001'
const NEW_ADDR = 'Jane NEWSECRET / 22 New St #09-09 / Singapore / +65 91234567'
db.prepare("INSERT INTO users (id,name,handle,role,api_key,default_address_text,default_address_region) VALUES ('buyer1','B','h_b','buyer','k_b',?, 'SG')").run(OLD_ADDR)

const auth = (req: Request, res: Response) => {
  const uid = req.headers['x-test-uid'] as string | undefined
  const row = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined : undefined
  if (!row) { res.status(401).json({ error: 'login' }); return null }
  return row
}
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, {
  db, auth, generateId, rateLimitOk: () => true,
  requireHumanPresence: ((_uid: string, _purpose: string, token: string | undefined, _key: string, validate?: (d: unknown) => boolean) => {
    let data: unknown = null; try { data = token ? JSON.parse(token) : null } catch { data = null }
    return (validate ? validate(data) : true) ? { ok: true } : { ok: false, error_code: 'HUMAN_PRESENCE_REQUIRED', reason: 'binding mismatch' }
  }) as never,
} as never)
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const useCred = (g: string, b: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [g]: { token: b, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: g, handle: `file:~/.webaz/credentials#${g}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const mkOAuth = (gid: string, oat: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,NULL,'active',?)")
    .run(gid, 'buyer1', 'OAuth: addr-test', JSON.stringify(caps.map(c => ({ capability: c }))), FUTURE)
  db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
    .run(sha(oat), gid, 'cli_t', 'read address', 'https://webaz.xyz/mcp', FUTURE)
}
mkOAuth('grt_addr', 'oat_addr_full', ['address_read_masked', 'address_change_request'])
mkOAuth('grt_ro', 'oat_addr_ro', ['address_read_masked'])
const A = (a: Record<string, unknown>) => (mcp as unknown as { handleAddressAgent: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleAddressAgent(a)
const approve = async (reqId: string, pd: Record<string, unknown>) => {
  const resp = await fetch(`http://127.0.0.1:${port}/api/agent-grants/permission-requests/${encodeURIComponent(reqId)}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-uid': 'buyer1' }, body: JSON.stringify({ webauthn_token: JSON.stringify(pd) }) })
  return { status: resp.status, json: await resp.json() as Record<string, unknown> }
}
const userAddr = () => db.prepare("SELECT default_address_text t, default_address_region r FROM users WHERE id='buyer1'").get() as { t: string; r: string }
const PII_NEW = /NEWSECRET|22 New St|#09-09|91234567/i

try {
  clearCred()
  ok('A-1 no grant → GRANT_REQUIRED', (await A({ action: 'masked_read' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_ro', 'oat_addr_ro', ['address_read_masked'])
  const M0 = await A({ action: 'masked_read' })
  ok('A-2 masked read: region + presence ONLY — zero substrings of the stored address', M0.has_default === true && M0.address_region === 'SG' && !/OLDSECRET|90000001|#01-01/i.test(JSON.stringify(M0)), JSON.stringify(M0))
  ok('A-3 change_request without the capability → PERMISSION_REQUIRED (separate gate)', (await A({ action: 'change_request', address_text: NEW_ADDR, region: 'SG' })).error_code === 'PERMISSION_REQUIRED')

  useCred('grt_addr', 'oat_addr_full', ['address_read_masked', 'address_change_request'])
  const c1 = await A({ action: 'change_request', address_text: NEW_ADDR, region: 'SG' })
  ok('A-4 change request filed over REAL oat_: pending + deep link + NOT echoed + users UNCHANGED', c1.success === true && typeof c1.request_id === 'string' && String(c1.approval_url).includes(String(c1.request_id)) && !PII_NEW.test(JSON.stringify(c1)) && userAddr().t === OLD_ADDR, JSON.stringify(c1).slice(0, 250))
  const aprRow = db.prepare('SELECT action_params, params_hash FROM agent_permission_requests WHERE id = ?').get(String(c1.request_id)) as { action_params: string; params_hash: string }
  ok('A-5 PII isolation: action_params carries ONLY {address_sha256, region} — full text lives in the dedicated table',
    !PII_NEW.test(aprRow.action_params) && JSON.parse(aprRow.action_params).address_sha256 === sha(NEW_ADDR)
    && (db.prepare('SELECT address_text FROM address_change_requests WHERE request_id = ?').get(String(c1.request_id)) as { address_text: string }).address_text === NEW_ADDR)
  // 人工列表附全文(human-authed 本人)
  { const hres = await fetch(`http://127.0.0.1:${port}/api/agent-grants/permission-requests`, { headers: { 'x-test-uid': 'buyer1' } })
    const hj = await hres.json() as { requests: Array<Record<string, unknown>> }
    const row = hj.requests.find(x => x.id === c1.request_id)
    ok('A-6 HUMAN approvals list carries the FULL address for review', !!row && (row.address_change as Record<string, unknown>)?.address_text === NEW_ADDR, JSON.stringify(row?.address_change ?? {})) }
  // 同 hash 幂等 / 异 hash 冲突
  const c2 = await A({ action: 'change_request', address_text: NEW_ADDR, region: 'SG' })
  ok('A-7 same content again → idempotent reuse of the SAME request', c2.request_id === c1.request_id && (c2.idempotency as Record<string, unknown>)?.duplicate === true)
  const c3 = await A({ action: 'change_request', address_text: NEW_ADDR + ' unit B', region: 'SG' })
  ok('A-8 DIFFERENT content while one is pending → explicit conflict with the existing request id', c3.error_code === 'ADDRESS_CHANGE_PENDING' && c3.existing_request_id === c1.request_id, JSON.stringify(c3).slice(0, 200))
  // Passkey 三元组 {request_id, action, params_hash}:错 hash 412;对 hash 执行写 users
  { const bad = await approve(String(c1.request_id), { request_id: c1.request_id, action: 'address_change', params_hash: 'wrong' })
    ok('A-9 wrong params_hash in the Passkey binding → 412, users untouched', bad.status === 412 && userAddr().t === OLD_ADDR)
    const good = await approve(String(c1.request_id), { request_id: c1.request_id, action: 'address_change', params_hash: c1.params_hash })
    ok('A-10 Passkey approve → users.default_address updated atomically + executed', good.status === 200 && good.json.status === 'executed' && userAddr().t === NEW_ADDR && userAddr().r === 'SG', JSON.stringify(good.json))
    const again = await approve(String(c1.request_id), { request_id: c1.request_id, action: 'address_change', params_hash: c1.params_hash })
    ok('A-11 re-approve → already_executed (idempotent, no rewrite)', again.json.already_executed === true) }
  // 执行后 agent 仍只有 masked
  const M1 = await A({ action: 'masked_read' })
  ok('A-12 AFTER execution the agent still gets only the masked view (its own submitted text is not re-readable)', M1.has_default === true && !PII_NEW.test(JSON.stringify(M1)), JSON.stringify(M1))
  // 拒绝清 PII
  { const c4 = await A({ action: 'change_request', address_text: 'Reject Me 99 REJSECRET Rd Singapore town', region: 'SG' })
    const rj = await fetch(`http://127.0.0.1:${port}/api/agent-grants/permission-requests/${encodeURIComponent(String(c4.request_id))}/reject`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-uid': 'buyer1' }, body: '{}' })
    ok('A-13 reject PURGES the pending PII content immediately', (await rj.json() as { success?: boolean }).success === true
      && db.prepare('SELECT COUNT(*) c FROM address_change_requests WHERE request_id = ?').get(String(c4.request_id)) !== undefined
      && (db.prepare('SELECT COUNT(*) c FROM address_change_requests WHERE request_id = ?').get(String(c4.request_id)) as { c: number }).c === 0) }
  // drift:专表内容被直改 → hash 断 → 拒执行
  { const c5 = await A({ action: 'change_request', address_text: 'Drift Case 12 Drift Lane Singapore ok', region: 'SG' })
    db.prepare("UPDATE address_change_requests SET address_text = 'TAMPERED 666 Evil Rd' WHERE request_id = ?").run(String(c5.request_id))
    const dr = await approve(String(c5.request_id), { request_id: c5.request_id, action: 'address_change', params_hash: c5.params_hash })
    ok('A-14 tampered pending content → ADDRESS_CHANGE_DRIFT, users untouched', dr.json.error_code === 'ADDRESS_CHANGE_DRIFT' && userAddr().t === NEW_ADDR) }
  // drift 案例收尾:拒绝 c5(fail-closed 同事务清 PII,同时释放每人一活跃坑位)
  { const c5row = db.prepare("SELECT id FROM agent_permission_requests WHERE kind='address_change' AND status='pending' LIMIT 1").get() as { id: string } | undefined
    if (c5row) { const rj = await fetch(`http://127.0.0.1:${port}/api/agent-grants/permission-requests/${encodeURIComponent(c5row.id)}/reject`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-uid': 'buyer1' }, body: '{}' })
      ok('A-13b reject is ATOMIC fail-closed for address kind (terminal + purge together)', (await rj.json() as { success?: boolean }).success === true && (db.prepare('SELECT COUNT(*) c FROM address_change_requests WHERE request_id = ?').get(c5row.id) as { c: number }).c === 0) } }
  // ══ Codex round-1:搁浅恢复 / 执行清 PII / boot 保留期清理 ══
  { const c6 = await A({ action: 'change_request', address_text: 'Recovery 5 Comeback Ave Singapore ok', region: 'SG' })
    // 模拟崩溃边界:手工置 approved+未执行(claim 后写入前)→ 再批一次必须能恢复执行
    db.prepare("UPDATE agent_permission_requests SET status='approved' WHERE id = ?").run(String(c6.request_id))
    const rec = await approve(String(c6.request_id), { request_id: c6.request_id, action: 'address_change', params_hash: c6.params_hash })
    ok('A-16 approved+unexecuted (crash boundary) RECOVERS on re-approval — no stranding', rec.status === 200 && rec.json.status === 'executed' && userAddr().t === 'Recovery 5 Comeback Ave Singapore ok', JSON.stringify(rec.json))
    ok('A-17 execution PURGES the staging row in the same tx (canonical copy lives in users only)', (db.prepare('SELECT COUNT(*) c FROM address_change_requests WHERE request_id = ?').get(String(c6.request_id)) as { c: number }).c === 0) }
  { // 过期 pending 无后续提交:boot 级清理兜底
    db.prepare("INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, risk_level, duration, status, expires_at, kind, order_id, order_action, params_hash, action_params) VALUES ('apr_exp_addr','buyer1','g','A','[]','high','once','pending', datetime('now','-1 hour'), 'address_change','','address_change','ph','{}')").run()
    db.prepare("INSERT INTO address_change_requests (request_id, human_id, address_text, region) VALUES ('apr_exp_addr','buyer1','Expired 1 STALESECRET Rd Singapore','SG')").run()
    const { initAgentPermissionRequestsSchema } = await import('../src/runtime/webaz-schema-helpers.js') as unknown as { initAgentPermissionRequestsSchema: (d: unknown) => void }
    initAgentPermissionRequestsSchema(db)   // 重跑 boot 段 = TTL 清理
    ok('A-18 boot-time retention purge deletes expired-pending PII (no submit needed)', (db.prepare("SELECT COUNT(*) c FROM address_change_requests WHERE request_id='apr_exp_addr'").get() as { c: number }).c === 0) }
  { // A-18b/c:boot 清理的 executed 与孤儿分支
    db.prepare("INSERT INTO address_change_requests (request_id, human_id, address_text, region) VALUES ('apr_orphan','buyer1','Orphan 3 GHOSTSECRET Way Singapore','SG')").run()
    const { initAgentPermissionRequestsSchema: initAgain } = await import('../src/runtime/webaz-schema-helpers.js') as unknown as { initAgentPermissionRequestsSchema: (d: unknown) => void }
    initAgain(db)
    ok('A-18b boot purge also removes ORPHAN staging rows (no apr row)', (db.prepare("SELECT COUNT(*) c FROM address_change_requests WHERE request_id='apr_orphan'").get() as { c: number }).c === 0)
    ok('A-18c no executed request retains staging content anywhere', (db.prepare("SELECT COUNT(*) c FROM address_change_requests acr WHERE EXISTS (SELECT 1 FROM agent_permission_requests p WHERE p.id = acr.request_id AND p.executed_at IS NOT NULL)").get() as { c: number }).c === 0) }
  { // 源级事务结构守卫:approve/reject 的终结与 PII 清除必须同处一个 db.transaction(fail-closed 的结构性证明)
    const SRC = (await import('node:fs')).readFileSync('src/pwa/address-agent.ts', 'utf8')
    const approveTx = /db\.transaction\(\(\) => \{[\s\S]*?users SET default_address_text[\s\S]*?DELETE FROM address_change_requests[\s\S]*?\}\)\.immediate\(\)/.test(SRC)
    const rejectTx = /db\.transaction\(\(\) => \{[\s\S]*?status = 'rejected'[\s\S]*?DELETE FROM address_change_requests[\s\S]*?\}\)\.immediate\(\)/.test(SRC)
    ok('A-19 SOURCE GUARD: users-write+purge and reject+purge each live inside ONE db.transaction (fail-closed by construction)', approveTx && rejectTx) }
  ok('A-15 validation: short text / bad region rejected', (await A({ action: 'change_request', address_text: 'short', region: 'SG' })).error_code === 'ADDRESS_TEXT_INVALID' && (await A({ action: 'change_request', address_text: NEW_ADDR, region: 'Singapore' })).error_code === 'ADDRESS_REGION_INVALID')
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ address-agent FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ address-agent: 地址双路径 — masked 无子串 · PII 专表隔离 · Passkey 四元组写入 · 幂等/冲突 · 拒绝清 PII · drift 拒执行\n  ✅ pass ${pass}`)
