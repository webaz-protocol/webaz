#!/usr/bin/env tsx
/**
 * PR-B 仲裁员生产生命周期 —— 域单测。证明:
 *  grant→active→eligible / suspend→ineligible / reinstate→eligible / revoke→ineligible&终态;
 *  role-only(无 whitelist)不合格;拒 sys_protocol / system 角色 / 无 Passkey(合成/agent);
 *  COI 拦买家/卖家/物流/发起人/被诉人,非当事方放行;sys_protocol 自动裁决不受影响(0 仲裁员仍收口)。
 * Usage: npm run test:arbitrator-lifecycle
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'arb-life-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initArbitratorReviewSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { initDisputeSchema, createDispute, checkDisputeTimeouts, arbitrateDispute } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const L = await import('../src/pwa/arbitrator-lifecycle.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF')
initSystemUser(db); initArbitratorReviewSchema(db); initWebauthnSchema(db); initDisputeSchema(db)

const mkUser = (id: string, role = 'buyer', passkey = false): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  if (passkey) db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('cred_' + id, id, Buffer.from([1]))
}
mkUser('arb1', 'buyer', true)         // 真实人类候选(有 Passkey)
mkUser('roleArb', 'arbitrator', true) // role=arbitrator 但不在 whitelist
mkUser('nopk', 'buyer', false)        // 无 Passkey(合成/agent 代理)
mkUser('sysrole', 'system', true)     // system 角色
mkUser('agentUser', 'agent', true)    // role=agent(有 Passkey —— 仍须拒)
mkUser('agentInRoles', 'buyer', true); db.prepare(`UPDATE users SET roles='["buyer","agent"]' WHERE id='agentInRoles'`).run()  // roles 含 agent
mkUser('admin1', 'admin', true)
mkUser('buyerX', 'buyer', true); mkUser('sellerX', 'seller', true); mkUser('logiX', 'logistics', true); mkUser('outsider', 'buyer', true)

// ① grant → active → eligible
ok('1a. grant real human (passkey) → ok', L.grantArbitrator(db, { userId: 'arb1', grantedBy: 'admin1' }).ok)
ok('1b. granted → eligible', L.isEligibleArbitrator(db, 'arb1').ok)

// ⑤ role-only(无 whitelist)不合格 —— role 旁路已移除
ok('5. role=arbitrator WITHOUT whitelist → NOT eligible', !L.isEligibleArbitrator(db, 'roleArb').ok)

// 拒非人类
ok('reject: sys_protocol not grantable (NOT_HUMAN)', L.grantArbitrator(db, { userId: 'sys_protocol', grantedBy: 'admin1' }).error_code === 'NOT_HUMAN')
ok('reject: system-role not grantable (NOT_HUMAN)', L.grantArbitrator(db, { userId: 'sysrole', grantedBy: 'admin1' }).error_code === 'NOT_HUMAN')
ok('reject: no-passkey synthetic/agent not grantable (PASSKEY_REQUIRED)', L.grantArbitrator(db, { userId: 'nopk', grantedBy: 'admin1' }).error_code === 'PASSKEY_REQUIRED')
ok('reject: role=agent NOT grantable even WITH passkey (NOT_HUMAN)', L.grantArbitrator(db, { userId: 'agentUser', grantedBy: 'admin1' }).error_code === 'NOT_HUMAN')
ok('reject: roles-includes-agent NOT grantable (NOT_HUMAN)', L.grantArbitrator(db, { userId: 'agentInRoles', grantedBy: 'admin1' }).error_code === 'NOT_HUMAN')

// ② suspend → ineligible
ok('2a. suspend → ok', L.suspendArbitrator(db, { userId: 'arb1' }).ok)
ok('2b. suspended → NOT eligible', !L.isEligibleArbitrator(db, 'arb1').ok)

// ③ reinstate → eligible
ok('3a. reinstate → ok', L.reinstateArbitrator(db, { userId: 'arb1' }).ok)
ok('3b. reinstated → eligible', L.isEligibleArbitrator(db, 'arb1').ok)

// ④ revoke → ineligible + 终态(grant/reinstate 都不能复活)
ok('4a. revoke → ok', L.revokeArbitrator(db, { userId: 'arb1' }).ok)
ok('4b. revoked → NOT eligible', !L.isEligibleArbitrator(db, 'arb1').ok)
ok('4c. revoked is TERMINAL: grant cannot revive', L.grantArbitrator(db, { userId: 'arb1', grantedBy: 'admin1' }).error_code === 'REVOKED_TERMINAL')
ok('4d. revoked is TERMINAL: reinstate cannot revive', L.reinstateArbitrator(db, { userId: 'arb1' }).error_code === 'REVOKED_TERMINAL')
ok('4e. revoked → still NOT eligible after revive attempts', !L.isEligibleArbitrator(db, 'arb1').ok)

// ⑥⑦ COI
const orderId = 'ord_coi'
db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,logistics_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p','buyerX','sellerX','logiX',1,50,50,50,'disputed','escrow')").run(orderId)
for (const [who, uid] of [['buyer', 'buyerX'], ['seller', 'sellerX'], ['logistics', 'logiX']] as const)
  ok(`6. COI blocks ${who}`, L.arbitratorHasConflict(db, orderId, 'buyerX', 'sellerX', uid))
ok('6. COI blocks initiator', L.arbitratorHasConflict(db, orderId, 'someInit', 'someDef', 'someInit'))
ok('6. COI blocks defendant', L.arbitratorHasConflict(db, orderId, 'someInit', 'someDef', 'someDef'))
ok('7. non-party outsider → NO conflict', !L.arbitratorHasConflict(db, orderId, 'buyerX', 'sellerX', 'outsider'))

// ⑩ sys_protocol 自动裁决不受影响(0 仲裁员 → 超时仍收口)。direct_p2p 非托管 → 零资金。
const oaj = 'ord_autojudge'
db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p','buyerX','sellerX',1,50,50,0,'disputed','direct_p2p')").run(oaj)
const cd = createDispute(db, oaj, 'buyerX', '我已付款,卖家不认', [])
ok('10a. dispute created', cd.success === true, JSON.stringify(cd))
db.prepare("UPDATE disputes SET status='in_review', arbitrate_deadline=datetime('now','-1 hour') WHERE order_id=?").run(oaj)  // 仲裁员超时未裁定
const tr = checkDisputeTimeouts(db)
ok('10b. sys_protocol auto-judge processed the dispute (no arbitrator needed)', tr.processed >= 1)
ok('10c. order reached terminal (refunded_full) with 0 arbitrators', (db.prepare('SELECT status FROM orders WHERE id=?').get(oaj) as { status: string }).status === 'refunded_full')
ok('10d. dispute resolved', (db.prepare('SELECT status FROM disputes WHERE order_id=?').get(oaj) as { status: string }).status === 'resolved')

// ⑪ 引擎授权源 = active 白名单:whitelist-only(role=buyer)【能真正裁定】;suspended 不能。证明 grant→可仲裁 + role 旁路移除。
mkUser('humanArb', 'buyer', true); L.grantArbitrator(db, { userId: 'humanArb', grantedBy: 'admin1' })
mkUser('suspArb', 'buyer', true); L.grantArbitrator(db, { userId: 'suspArb', grantedBy: 'admin1' }); L.suspendArbitrator(db, { userId: 'suspArb' })
const mkDisp = (oid: string): string => {
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?, 'p','buyerX','sellerX',1,50,50,0,'disputed','direct_p2p')").run(oid)
  return createDispute(db, oid, 'buyerX', 'r', []).disputeId as string
}
const rArb = arbitrateDispute(db, mkDisp('ord_h1'), 'humanArb', 'refund_buyer', '裁定')
ok('11a. whitelist-only active arbitrator (role=buyer) CAN rule via engine', rArb.success === true, JSON.stringify(rArb))
ok('11b. order reached terminal after human ruling', (db.prepare('SELECT status FROM orders WHERE id=?').get('ord_h1') as { status: string }).status === 'refunded_full')
const rSusp = arbitrateDispute(db, mkDisp('ord_h2'), 'suspArb', 'refund_buyer', '裁定')
ok('11c. SUSPENDED arbitrator CANNOT rule via engine', rSusp.success === false)
ok('11d. role=arbitrator WITHOUT whitelist CANNOT rule via engine (bypass removed)', arbitrateDispute(db, mkDisp('ord_h3'), 'roleArb', 'refund_buyer', '裁定').success === false)

if (fail > 0) { console.error(`\n❌ arbitrator-lifecycle FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ arbitrator-lifecycle: grant/suspend/reinstate/revoke(terminal) + active-only eligibility + COI + sys_protocol auto-judge intact\n  ✅ pass ${pass}`)
