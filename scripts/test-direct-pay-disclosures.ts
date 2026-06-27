#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) 两次披露契约门 + RISK-scope 强制 测试。Usage: npm run test:direct-pay-disclosures
 * 验收:
 *   - 最终确认门:缺任一次提醒 → 硬失败;两次都 ack → 放行(证据层证明两次分别发生)。
 *   - append-only:两 stage = 两行,各带 notice_version + acked_at。
 *   - D1(pre_select)买家单视角:不含卖家机制(质押/平台费/stake/bond)。
 *   - agent(无 Passkey)→ 直付 RISK 门硬拒,无自助批准路径。
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-disc-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const M = await import('../src/direct-pay-disclosures.js')
const { STAGE, D1, getBuyerDisclosures, recordDisclosureAck, requireBothDisclosuresAcked } = M
const { requireDirectPayHumanPasskey } = await import('../src/pwa/direct-pay-guards.js')
const { endpointToAction } = await import('../src/pwa/endpoint-actions.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
const mkOrder = (id: string) => db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail) VALUES (?, 'p1','buyer1','s1',1,50,50,0,'direct_pay_window','direct_p2p')").run(id)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','b','buyer','k1')").run()

// ── 两次披露门 ──
mkOrder('o1')
ok('final-confirm rejected when NEITHER reminder acked', requireBothDisclosuresAcked(db, 'o1').ok === false)
ok('  → missing both stages', (requireBothDisclosuresAcked(db, 'o1').missing || []).length === 2)
recordDisclosureAck(db, { orderId: 'o1', buyerId: 'buyer1', stage: STAGE.PRE_SELECT, ackId: 'a1' })
const afterOne = requireBothDisclosuresAcked(db, 'o1')
ok('rejected when ONLY pre_select acked (missing pre_confirm)', afterOne.ok === false && afterOne.missing?.includes(STAGE.PRE_CONFIRM) === true && !afterOne.missing?.includes(STAGE.PRE_SELECT))
recordDisclosureAck(db, { orderId: 'o1', buyerId: 'buyer1', stage: STAGE.PRE_CONFIRM, ackId: 'a2' })
ok('allowed when BOTH reminders acked', requireBothDisclosuresAcked(db, 'o1').ok === true)

// ── append-only: 两 stage = 两行,各带 version + timestamp ──
const rows = db.prepare("SELECT stage, notice_version, acked_at FROM direct_pay_disclosure_acks WHERE order_id='o1' ORDER BY stage").all() as Array<{ stage: string; notice_version: string; acked_at: string }>
ok('two distinct ack rows (one per stage)', rows.length === 2 && rows.some(r => r.stage === STAGE.PRE_SELECT) && rows.some(r => r.stage === STAGE.PRE_CONFIRM))
ok('each row carries notice_version + acked_at', rows.every(r => !!r.notice_version && !!r.acked_at))
// idempotent re-ack does not create a 3rd row
recordDisclosureAck(db, { orderId: 'o1', buyerId: 'buyer1', stage: STAGE.PRE_SELECT, ackId: 'a1b' })
ok('re-ack same stage idempotent (no extra row)', (db.prepare("SELECT COUNT(*) n FROM direct_pay_disclosure_acks WHERE order_id='o1'").get() as { n: number }).n === 2)

// ── D1 (pre_select) 买家单视角:无卖家机制 ──
const d1 = getBuyerDisclosures().preSelect
const sellerMechRe = /质押|平台费|保证金|stake|bond|platform fee|fee-stake/i
ok('D1 zh has NO seller-stake mechanics', !sellerMechRe.test(d1.zh), d1.zh)
ok('D1 en has NO seller-stake mechanics', !sellerMechRe.test(d1.en), d1.en)
ok('D1 conveys no-refund / reputation-only', /不退款/.test(d1.zh) && /no refund/i.test(d1.en))

// ── RISK scope: endpoint 分类 ──
ok('POST /api/direct-pay/orders → direct_pay', endpointToAction('POST', '/api/direct-pay/orders') === 'direct_pay')
ok('GET direct-pay → null', endpointToAction('GET', '/api/direct-pay/orders') === null)

// ── RISK scope: agent(无 Passkey)硬拒 + 无自助批准 ──
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)')
const agentRes = requireDirectPayHumanPasskey({ db, consumeGateToken: () => ({ ok: true }) }, { userId: 'agent1', purpose: 'direct_pay_confirm' })
ok('agent WITHOUT Passkey HARD-REJECTED even with permissive gate', agentRes.ok === false && agentRes.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY')
db.prepare("INSERT INTO webauthn_credentials (id,user_id) VALUES ('c1','human1')").run()
ok('human WITH Passkey + valid gate → ok', requireDirectPayHumanPasskey({ db, consumeGateToken: () => ({ ok: true }) }, { userId: 'human1', webauthnToken: 't', purpose: 'direct_pay_confirm' }).ok === true)
ok('human WITH Passkey but no fresh gate → HUMAN_PRESENCE_REQUIRED', requireDirectPayHumanPasskey({ db, consumeGateToken: () => ({ ok: false, reason: 'no token' }) }, { userId: 'human1', purpose: 'direct_pay_confirm' }).error_code === 'HUMAN_PRESENCE_REQUIRED')

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-disclosures tests passed`)
