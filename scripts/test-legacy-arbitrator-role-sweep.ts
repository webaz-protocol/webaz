#!/usr/bin/env tsx
/**
 * legacy `user.role === 'arbitrator'` 授权旁路清扫(PR #218 审计发现 5 的 follow-up)。
 * 仲裁能力唯一 runtime 源 = active arbitrator_whitelist;残留 role 旁路的危害是双向的:
 *   role-only / 已 suspend-revoke 但主 role 未同步的账号仍有能力,而真·白名单仲裁员(role=buyer)反被 403。
 *
 * ① 行为:dispute-engine 导出的 isActiveWhitelistArbitrator —— active=true;suspended/revoked/role-only/不存在=false;
 *    legacy NULL status 视为 active;whitelist 表缺失 → fail-closed false(MCP fresh-DB 场景)。
 * ② 静态:四个曾用 legacy role 的授权点已换白名单谓词,且不再出现 role 旁路:
 *    - external-anchors distribute-rewards(动钱)
 *    - snf /:id/verify(争议证据面)
 *    - MCP webaz_update_order 参与方旁路 + webaz_dispute list_open
 *    - notification-engine 'arbitrators' 收件组(死分支,防未来规则复活 legacy 源)
 * Usage: npm run test:legacy-arbitrator-role-sweep
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arb-sweep-'))
import { readFileSync } from 'fs'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initArbitratorReviewSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { isActiveWhitelistArbitrator } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { grantArbitrator, suspendArbitrator, revokeArbitrator } = await import('../src/pwa/arbitrator-lifecycle.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── ① 行为 ──
const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db); initArbitratorReviewSchema(db); initWebauthnSchema(db)
const mkUser = (id: string, role = 'buyer'): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_' + id, id, Buffer.from([1]))
}
mkUser('act'); mkUser('sus'); mkUser('rev'); mkUser('roleOnly', 'arbitrator')
grantArbitrator(db, { userId: 'act', grantedBy: 'a1' })
grantArbitrator(db, { userId: 'sus', grantedBy: 'a1' }); suspendArbitrator(db, { userId: 'sus' })
grantArbitrator(db, { userId: 'rev', grantedBy: 'a1' }); revokeArbitrator(db, { userId: 'rev' })
ok('1. active whitelist → true', isActiveWhitelistArbitrator(db, 'act') === true)
ok('2. suspended → false', isActiveWhitelistArbitrator(db, 'sus') === false)
ok('3. revoked → false', isActiveWhitelistArbitrator(db, 'rev') === false)
ok('4. role-only (users.role=arbitrator, not whitelisted) → false', isActiveWhitelistArbitrator(db, 'roleOnly') === false)
ok('5. unknown user → false', isActiveWhitelistArbitrator(db, 'ghost') === false)
db.prepare("UPDATE arbitrator_whitelist SET status = NULL WHERE user_id = 'act'").run()
ok('6. legacy NULL status treated as active', isActiveWhitelistArbitrator(db, 'act') === true)
db.exec('DROP TABLE arbitrator_whitelist')
ok('7. whitelist table missing → fail-closed false (no throw)', isActiveWhitelistArbitrator(db, 'act') === false)

// ── ② 静态:四个站点用白名单谓词,不再留 role 旁路 ──
const EXT = readFileSync('src/pwa/routes/external-anchors.ts', 'utf8')
ok('8. external-anchors distribute-rewards uses isEligibleArbitrator, no role bypass', /!isEligibleArbitrator\(db, user\.id as string\)\.ok/.test(EXT) && !/user\.role !== 'arbitrator'|user\.role === 'arbitrator'/.test(EXT))
const SNF = readFileSync('src/pwa/routes/snf.ts', 'utf8')
ok('9. snf verify uses isEligibleArbitrator, no role bypass', /!isEligibleArbitrator\(db, uid\)\.ok/.test(SNF) && !/role !== 'arbitrator'|role === 'arbitrator'/.test(SNF))
const MCP = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
ok('10. MCP order-action + list_open use isActiveWhitelistArbitrator, no role bypass', (MCP.match(/isActiveWhitelistArbitrator\(db, user\.id as string\)/g) || []).length >= 2 && !/user\.role !== 'arbitrator'|user\.role === 'arbitrator'/.test(MCP))
const NE = readFileSync('src/layer2-business/L2-6-notifications/notification-engine.ts', 'utf8')
ok("11. notification 'arbitrators' recipients resolve from active whitelist, not users.role", /FROM arbitrator_whitelist WHERE status IS NULL OR status = 'active'/.test(NE) && !/FROM users WHERE role = 'arbitrator'/.test(NE))
// 路由层全量负向:src/pwa/routes 不再有任何 `user.role ==/!= 'arbitrator'` 授权判定(governance-onboarding 的 role 是申请类型参数,非 user.role)
const { execSync } = await import('node:child_process')
const grep = (() => { try { return execSync("grep -rn \"user.role === 'arbitrator'\\|user.role !== 'arbitrator'\" src/pwa/routes src/pwa/server.ts src/layer1-agent 2>/dev/null || true", { encoding: 'utf8' }).trim() } catch { return '' } })()
ok('12. repo sweep: no remaining user.role arbitrator authz guards in routes/server/MCP', grep === '', grep)

if (fail > 0) { console.error(`\n❌ legacy-arbitrator-role-sweep FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ legacy-arbitrator-role-sweep: whitelist predicate behavioral (active/suspended/revoked/role-only/missing-table) + 4 sites swapped + repo-wide negative sweep\n  ✅ pass ${pass}`)
