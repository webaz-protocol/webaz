#!/usr/bin/env tsx
/**
 * PR-C:HTTP 人类仲裁路由移除 is_system Passkey 旁路。
 *  - arbitrate:所有真人仲裁员(含 is_system fixture)都必须现场 Passkey(consumeGateToken),无旁路。
 *  - vote:is_system 旁路【保留】(仅移除 arbitrate,不动 verifier 投票)。
 *  - sys_protocol 自动裁决走 engine arbitrateDispute(role=system,不经 requireHumanPresence),不受影响
 *    —— 由 test-arbitrator-lifecycle 案 10 证明。
 * Usage: npm run test:arbitrate-human-presence
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arb-hp-'))
const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initArbitratorReviewSchema, initWebauthnSchema, initVerifierWhitelistSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF')
initArbitratorReviewSchema(db); initWebauthnSchema(db); initVerifierWhitelistSchema(db)
try { db.exec('ALTER TABLE verifier_whitelist ADD COLUMN is_system INTEGER DEFAULT 0') } catch { /* prod 由 server.ts migration 加 */ }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('sysArb','a','arbitrator','ka')").run()
db.prepare("INSERT INTO arbitrator_whitelist (user_id,is_system,status) VALUES ('sysArb',1,'active')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('sysVoter','v','verifier','kv')").run()
db.prepare("INSERT INTO verifier_whitelist (user_id,is_system) VALUES ('sysVoter',1)").run()

const { requireHumanPresence } = createHumanPresence(db, (((_k: string, _d: number) => 1) as unknown) as never)  // param 开启

// arbitrate:is_system 旁路已移除 → 无 token 必须被拦
const noTok = requireHumanPresence('sysArb', 'arbitrate', undefined, 'require_human_presence_for_arbitrate')
ok('arbitrate: is_system bypass REMOVED → HUMAN_PRESENCE_REQUIRED without token', noTok.ok === false && noTok.error_code === 'HUMAN_PRESENCE_REQUIRED')
// 有一次性未过期 token → 放行
db.prepare("INSERT INTO webauthn_gate_tokens (id,user_id,purpose,purpose_data,expires_at,consumed_at) VALUES ('tok1','sysArb','arbitrate',NULL,datetime('now','+60 seconds'),NULL)").run()
ok('arbitrate: WITH live Passkey token → ok', requireHumanPresence('sysArb', 'arbitrate', 'tok1', 'require_human_presence_for_arbitrate').ok === true)
// vote:is_system 旁路保留(未改)
ok('vote: is_system bypass KEPT (only arbitrate changed)', requireHumanPresence('sysVoter', 'vote', undefined, 'require_human_presence_for_vote').ok === true)
// 协议参数关闭 → 不强制(sanity)
const off = createHumanPresence(db, (((_k: string, _d: number) => 0) as unknown) as never)
ok('param disabled → not enforced', off.requireHumanPresence('sysArb', 'arbitrate', undefined, 'require_human_presence_for_arbitrate').ok === true)

if (fail > 0) { console.error(`\n❌ arbitrate-human-presence FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ arbitrate-human-presence: is_system arbitrate bypass removed (Passkey required) · vote bypass kept · sys_protocol engine path unaffected\n  ✅ pass ${pass}`)
