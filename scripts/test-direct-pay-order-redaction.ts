#!/usr/bin/env tsx
/**
 * Direct Pay 收款目标披露门 —— 共享投影器单测 (audit hardening)。
 * 验 redactUnackedDirectPayTarget(买家自视角:未 ack 删 instruction + 剥 qr_ref,留 method/currency/label;
 *   acked 全留;卖家看自己单不删;escrow 不动)+ stripDirectPayPaymentTarget(无条件删两快照)。
 * Usage: npm run test:direct-pay-order-redaction
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-redact-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { recordDisclosureAck } = await import('../src/direct-pay-disclosures.js')
const { redactUnackedDirectPayTarget, stripDirectPayPaymentTarget, projectDirectPayTargetForViewer } = await import('../src/pwa/direct-pay-order-redaction.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')   // unit test of the pure projector; not seeding orders/users
const acctSnap = () => JSON.stringify({ account_id: 'a1', method: 'PayNow', currency: 'SGD', label: 'A', qr_ref: 'qref1' })
const mkOrder = (over: Record<string, unknown> = {}) => ({ id: 'ord1', payment_rail: 'direct_p2p', buyer_id: 'b1', direct_pay_instruction_snapshot: 'SECRET', direct_pay_account_snapshot: acctSnap(), ...over })
const ackBoth = (orderId: string) => { recordDisclosureAck(db, { orderId, buyerId: 'b1', stage: 'pre_select', ackId: orderId + '_1' }); recordDisclosureAck(db, { orderId, buyerId: 'b1', stage: 'pre_confirm', ackId: orderId + '_2' }) }

// 1. buyer, NOT acked → instruction deleted, qr_ref stripped, method/currency/label kept
const o1 = mkOrder({ id: 'ord1' })
redactUnackedDirectPayTarget(db, o1, 'b1')
ok('1a. un-acked buyer: instruction snapshot deleted', !('direct_pay_instruction_snapshot' in o1))
{ const s = JSON.parse((o1.direct_pay_account_snapshot as string) || '{}'); ok('1b. un-acked: qr_ref stripped', s.qr_ref === undefined); ok('1c. un-acked: method/currency/label kept', s.method === 'PayNow' && s.currency === 'SGD' && s.label === 'A') }

// 2. buyer, BOTH acked → everything kept
ackBoth('ord2')
const o2 = mkOrder({ id: 'ord2' })
redactUnackedDirectPayTarget(db, o2, 'b1')
ok('2a. acked buyer: instruction snapshot kept', o2.direct_pay_instruction_snapshot === 'SECRET')
ok('2b. acked buyer: qr_ref kept', JSON.parse(o2.direct_pay_account_snapshot as string).qr_ref === 'qref1')

// 3. viewer is NOT the buyer (e.g. seller viewing own order) → untouched
const o3 = mkOrder({ id: 'ord3' })
redactUnackedDirectPayTarget(db, o3, 'seller_x')
ok('3. non-buyer viewer: nothing redacted (seller authored the instruction)', o3.direct_pay_instruction_snapshot === 'SECRET' && JSON.parse(o3.direct_pay_account_snapshot as string).qr_ref === 'qref1')

// 4. escrow order → untouched
const o4 = mkOrder({ id: 'ord4', payment_rail: 'escrow' })
redactUnackedDirectPayTarget(db, o4, 'b1')
ok('4. escrow order: untouched', o4.direct_pay_instruction_snapshot === 'SECRET')

// 5. stripDirectPayPaymentTarget: both snapshots removed unconditionally (third-party reader)
const o5 = mkOrder({ id: 'ord5' })
stripDirectPayPaymentTarget(o5)
ok('5a. strip: instruction snapshot removed', !('direct_pay_instruction_snapshot' in o5))
ok('5b. strip: account snapshot removed entirely', !('direct_pay_account_snapshot' in o5))

// 6. malformed account snapshot JSON → whole field dropped (fail-safe, no throw)
const o6 = mkOrder({ id: 'ord6', direct_pay_account_snapshot: '{not json' })
redactUnackedDirectPayTarget(db, o6, 'b1')
ok('6. malformed account snapshot → dropped, no throw', !('direct_pay_account_snapshot' in o6) && !('direct_pay_instruction_snapshot' in o6))

// ── 7. projectDirectPayTargetForViewer:唯一入口的按查看者矩阵(#218 审计发现 6)──
const p1 = mkOrder({ id: 'ord7', seller_id: 's1' })
projectDirectPayTargetForViewer(db, p1, 'b1')
ok('7a. projector/buyer un-acked: ack-gate applied', !('direct_pay_instruction_snapshot' in p1) && JSON.parse((p1.direct_pay_account_snapshot as string) || '{}').qr_ref === undefined)
ackBoth('ord8')
const p2 = mkOrder({ id: 'ord8', seller_id: 's1' })
projectDirectPayTargetForViewer(db, p2, 'b1')
ok('7b. projector/buyer acked: target kept', p2.direct_pay_instruction_snapshot === 'SECRET' && JSON.parse(p2.direct_pay_account_snapshot as string).qr_ref === 'qref1')
const p3 = mkOrder({ id: 'ord9', seller_id: 's1' })
projectDirectPayTargetForViewer(db, p3, 's1')
ok('7c. projector/seller (payee): untouched', p3.direct_pay_instruction_snapshot === 'SECRET' && JSON.parse(p3.direct_pay_account_snapshot as string).qr_ref === 'qref1')
const p4 = mkOrder({ id: 'ord10', seller_id: 's1' })
projectDirectPayTargetForViewer(db, p4, 'third_party')
ok('7d. projector/third-party (logistics/仲裁员/任何非当事方): BOTH snapshots removed', !('direct_pay_instruction_snapshot' in p4) && !('direct_pay_account_snapshot' in p4))

if (fail > 0) { console.error(`\n❌ direct-pay order redaction FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
else console.log(`✅ direct-pay order redaction: primitives (redact/strip) + viewer-projector matrix (buyer-unacked/buyer-acked/seller/third-party)\n  ✅ pass ${pass}`)
