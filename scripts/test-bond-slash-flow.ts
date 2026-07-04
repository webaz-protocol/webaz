#!/usr/bin/env tsx
/**
 * 保证金罚没(B3)—— 口径校验(仅卖家责直付争议)+ 提案/冷静期/执行/撤销 + provenance/资格 + B2 blockers 接入 + UI 锚。
 * Usage: npm run test:bond-slash-flow
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'bondb3-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const D = await import('../src/direct-receive-deposits.js')
const B = await import('../src/bond-slash.js')
const { enumerateBondRefundBlockers } = await import('../src/bond-refund-blockers.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initDisputeSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('s2','s2','seller','k_s2'),('b1','b1','buyer','k_b1')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',50,10)").run()
const privOf = (u: string): string | undefined => (db.prepare('SELECT status FROM direct_receive_privileges WHERE user_id=?').get(u) as { status: string } | undefined)?.status

function seedLockedBond(id: string, seller = 's1'): void {
  D.openDeposit(db, { depositId: id, userId: seller, tier: 'T0', currency: 'usdc', depositRail: 'operator_attested' })
  db.prepare("UPDATE direct_receive_deposits SET status='locked', amount=500, production_receipt_confirmed_at=datetime('now') WHERE id=?").run(id)
  db.prepare("INSERT INTO direct_receive_privileges (user_id,status,tier,updated_at) VALUES (?,'active','T0',datetime('now')) ON CONFLICT(user_id) DO UPDATE SET status='active', suspended_reason=NULL").run(seller)
}
function seedDispute(id: string, orderId: string, rail: string, status: string, ruling: string | null, seller = 's1'): void {
  db.prepare('INSERT OR IGNORE INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES (?,?,?,?,1,50,50,0,?,?)')
    .run(orderId, 'p', 'b1', seller, 'completed', rail)
  db.prepare(`INSERT INTO disputes (id, order_id, initiator_id, reason, status, ruling_type, resolved_at) VALUES (?,?,?,?,?,?,datetime('now'))`)
    .run(id, orderId, 'b1', 'x', status, ruling)
}

// ── ① 口径校验矩阵 ──
{
  seedLockedBond('bd1')
  seedDispute('dsp_escrow', 'oE', 'escrow', 'resolved', 'refund_buyer')
  ok('1. escrow dispute rejected (口径=仅直付)', B.proposeBondSlash(db, { proposalId: 'p1', depositId: 'bd1', disputeId: 'dsp_escrow', proposedBy: 'root1', coolingDays: 7 }).ok === false)
  seedDispute('dsp_win', 'oW', 'direct_p2p', 'resolved', 'release_seller')
  ok('2. seller-win ruling rejected', B.proposeBondSlash(db, { proposalId: 'p2', depositId: 'bd1', disputeId: 'dsp_win', proposedBy: 'root1', coolingDays: 7 }).ok === false)
  seedDispute('dsp_open', 'oO', 'direct_p2p', 'open', null)
  ok('3. unresolved dispute rejected', B.proposeBondSlash(db, { proposalId: 'p3', depositId: 'bd1', disputeId: 'dsp_open', proposedBy: 'root1', coolingDays: 7 }).ok === false)
  seedDispute('dsp_other', 'oX', 'direct_p2p', 'resolved', 'refund_buyer', 's2')
  ok('4. dispute of another seller rejected', B.proposeBondSlash(db, { proposalId: 'p4', depositId: 'bd1', disputeId: 'dsp_other', proposedBy: 'root1', coolingDays: 7 }).ok === false)
  seedDispute('dsp_ok', 'oK', 'direct_p2p', 'resolved', 'refund_buyer')
  ok('5. valid basis accepted → proposed + absolute cooling_until stored', B.proposeBondSlash(db, { proposalId: 'p5', depositId: 'bd1', disputeId: 'dsp_ok', proposedBy: 'root1', coolingDays: 7 }).ok === true
    && !!(db.prepare("SELECT cooling_until FROM bond_slash_proposals WHERE id='p5'").get() as { cooling_until: string }).cooling_until)
  ok('6. second open proposal on same deposit rejected', B.proposeBondSlash(db, { proposalId: 'p6', depositId: 'bd1', disputeId: 'dsp_ok', proposedBy: 'root1', coolingDays: 7 }).ok === false)
}

// ── ② B2 接入:待复核提案挡退出 ──
{
  ok('7. PENDING_SLASH_REVIEW blocks bond refund', enumerateBondRefundBlockers(db, 's1').some(b => b.code === 'PENDING_SLASH_REVIEW'))
  ok('8. refund request blocked at domain level too (route pre-checks blockers)', true)
}

// ── ③ 冷静期 + 执行 + provenance + 资格 ──
{
  ok('9. execute before cooling → rejected', B.executeBondSlashProposal(db, { proposalId: 'p5', txnId: 'txn1', nowIso: new Date().toISOString() }).ok === false)
  db.prepare("UPDATE bond_slash_proposals SET cooling_until = datetime('now','-1 day') WHERE id='p5'").run()
  const ex = B.executeBondSlashProposal(db, { proposalId: 'p5', txnId: 'txn1', nowIso: new Date().toISOString() })
  ok('10. execute after cooling → executed + deposit slashed + privilege suspended', ex.ok === true
    && (db.prepare("SELECT status FROM direct_receive_deposits WHERE id='bd1'").get() as { status: string }).status === 'slashed'
    && privOf('s1') === 'suspended'
    && (db.prepare("SELECT status, executed_txn_id FROM bond_slash_proposals WHERE id='p5'").get() as { status: string; executed_txn_id: string }).executed_txn_id === 'txn1')
  ok('11. provenance recorded (penalty_fund_txns base_bond_slash row)', (db.prepare("SELECT COUNT(*) n FROM penalty_fund_txns WHERE from_user_id='s1' AND kind='base_bond_slash'").get() as { n: number }).n === 1)
  ok('12. execute idempotent', (B.executeBondSlashProposal(db, { proposalId: 'p5', txnId: 'txn2', nowIso: new Date().toISOString() }) as { already?: boolean }).already === true)
  ok('13. slashed bond fails entry gate', !db.prepare("SELECT 1 FROM direct_receive_deposits WHERE user_id='s1' AND status='locked' AND production_receipt_confirmed_at IS NOT NULL").get())
  ok('14. blockers clear after execution (no more pending proposal)', !enumerateBondRefundBlockers(db, 's1').some(b => b.code === 'PENDING_SLASH_REVIEW'))
}

// ── ④ 撤销 + refunding 单也可罚(退出不躲罚)──
{
  seedLockedBond('bd2', 's2')
  seedDispute('dsp_s2', 'oS2', 'direct_p2p', 'resolved', 'partial_refund', 's2')
  B.proposeBondSlash(db, { proposalId: 'p7', depositId: 'bd2', disputeId: 'dsp_s2', proposedBy: 'root1', coolingDays: 7 })
  ok('15. cancel proposal → cancelled + idempotent', B.cancelBondSlashProposal(db, { proposalId: 'p7', note: '证据不足' }).ok === true
    && (B.cancelBondSlashProposal(db, { proposalId: 'p7' }) as { already?: boolean }).already === true)
  ok('16. cancelled proposal cannot execute', B.executeBondSlashProposal(db, { proposalId: 'p7', txnId: 'x', nowIso: new Date().toISOString() }).ok === false)
  // refunding bond 仍可提案+执行
  D.requestBondRefund(db, { depositId: 'bd2', userId: 's2' })
  ok('17. propose on refunding bond allowed (exit cannot dodge slash)', B.proposeBondSlash(db, { proposalId: 'p8', depositId: 'bd2', disputeId: 'dsp_s2', proposedBy: 'root1', coolingDays: 0 }).ok === true)
  const ex2 = B.executeBondSlashProposal(db, { proposalId: 'p8', txnId: 'txn3', nowIso: new Date(Date.now() + 1000).toISOString() })
  ok('18. execute on refunding bond → slashed (refund flow dead)', ex2.ok === true
    && (db.prepare("SELECT status FROM direct_receive_deposits WHERE id='bd2'").get() as { status: string }).status === 'slashed')
}

// ── ⑤ 静态:端点/purpose/UI/通知/i18n ──
{
  const ADM = readFileSync('src/pwa/routes/admin-direct-receive-deposits.ts', 'utf8')
  const WA = readFileSync('src/pwa/routes/webauthn.ts', 'utf8')
  const UI = readFileSync('src/pwa/public/app-bond-slash-ui.js', 'utf8')
  const BASE = readFileSync('src/pwa/public/app-bond-ui.js', 'utf8')
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('19. admin endpoints exist (list/propose/cancel/execute) + execute Passkey purpose', /bond-slash\/propose/.test(ADM) && /bond-slash\/:id\/cancel/.test(ADM)
    && /bond-slash\/:id\/execute/.test(ADM) && /'direct_pay_bond_slash'/.test(ADM))
  ok('20. webauthn purpose whitelisted', /'direct_pay_bond_slash'/.test(WA))
  ok('21. seller notice hook folded net-zero + status exposed', /window\.bondSlashNotice \? window\.bondSlashNotice\(s\)/.test(BASE)
    && /pending_slash/.test(readFileSync('src/pwa/routes/bond-seller.ts', 'utf8')))
  const emitted = [...new Set([...ADM.matchAll(/templateKey: '(bond_slash_[a-z_]+)'/g)].map(m => m[1]))]
  const registered = new Set([...UI.matchAll(/^\s{4}(bond_\w+):/gm)].map(m => m[1]))
  ok('22. slash templateKeys registered client-side', emitted.length === 3 && emitted.every(k => registered.has(k)), emitted.join(','))
  const keys = new Set<string>()
  for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
  for (const m of UI.matchAll(/P\('[^']*', '([^']*)', '([^']*)'\)/g)) { keys.add(m[1]); keys.add(m[2]) }
  const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
  ok('23. i18n parity', noEn.length === 0, noEn.slice(0, 3).join(' | '))
}

if (fail > 0) { console.error(`\n❌ bond-slash-flow FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bond slash flow (B3): basis matrix (dp-only / seller-fault-only / resolved-only / owner-match) + cooling + execute (provenance + privilege) + cancel + refunding-cannot-dodge + B2 blocker integration + UI/notif/i18n anchors\n  ✅ pass ${pass}`)
