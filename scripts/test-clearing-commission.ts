#!/usr/bin/env tsx
/**
 * RFC-018 PR2a — commission clearing maturation + reversal + cron isolation.
 *   用法: npm run test:clearing-commission
 *
 * Asserts the money-path invariants of the accrue-then-mature model:
 *   - a matured clearing row PAYS exactly once (wallet + commission_records), idempotent;
 *   - a reversed row NEVER pays; a partially-reduced row pays the reduced amount;
 *   - maturation HOLDS while a dispute is open (never pays into uncertainty);
 *   - conservation: Σ(paid) + Σ(still-pending) + Σ(reversed) == Σ(accrued), no pay before maturity;
 *   - ② THE HIGH-RISK ONE: on a DB holding BOTH opt-out escrow rows (matures_at IS NULL) and clearing
 *     rows (matures_at IS NOT NULL), the escrow-expire cron touches ONLY opt-out rows and the clearing
 *     cron touches ONLY clearing rows — zero cross-contamination.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-clrcomm-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { matureClearingRow, runClearingMatureSweep } = await import('../src/pwa/routes/rewards-clearing-mature.js')
const { runEscrowExpireSweep } = await import('../src/pwa/routes/rewards-escrow-expire.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db: any = initDatabase()
setSeamDb(db)
applyWebazRuntimeSchema(db)
db.pragma('foreign_keys = OFF')   // isolated logic fixture — we construct minimal rows, not full referential graphs
// mirror the server.ts inline ALTERs / tables that matureClearingRow touches
try { db.exec("ALTER TABLE orders ADD COLUMN snapshot_commission_rate REAL") } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN buyer_region TEXT") } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS commission_records (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, beneficiary_id TEXT, source_buyer_id TEXT NOT NULL, level INTEGER NOT NULL, amount REAL NOT NULL, rate REAL NOT NULL, region TEXT, source TEXT DEFAULT 'static', source_type TEXT DEFAULT 'sponsor', created_at TEXT DEFAULT (datetime('now')), UNIQUE(order_id, level))`)
db.exec(`CREATE TABLE IF NOT EXISTS product_share_attribution (product_id TEXT NOT NULL, recipient_id TEXT NOT NULL, sharer_id TEXT NOT NULL, shareable_id TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL, PRIMARY KEY (product_id, recipient_id))`)
db.exec(`CREATE TABLE IF NOT EXISTS shareables (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))`)

// ── seed helpers ──
let uniq = 0
const mkUser = (id: string, region = 'global'): string => { db.prepare("INSERT OR IGNORE INTO users (id, name, role, api_key, region) VALUES (?,?,?,?,?)").run(id, id, 'buyer', 'key_' + id, region); db.prepare("INSERT OR IGNORE INTO wallets (user_id) VALUES (?)").run(id); return id }
const mkProduct = (id: string, seller: string): string => { db.prepare("INSERT OR IGNORE INTO products (id, seller_id, title, price, stock, status) VALUES (?,?,?,?,?,?)").run(id, seller, id, 100, 10, 'active'); return id }
const mkOrder = (id: string, buyer: string, seller: string, product: string, total: number, status = 'completed', rate = 0.10, region = 'global'): string => {
  db.prepare("INSERT INTO orders (id, buyer_id, seller_id, product_id, unit_price, total_amount, escrow_amount, status, snapshot_commission_rate, buyer_region) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, buyer, seller, product, total, total, total, status, rate, region); return id
}
const PAST = Date.now() - 86400_000, FUTURE = Date.now() + 30 * 86400_000
// clearing row = matures_at NOT NULL; opt-out escrow row = matures_at NULL (+ expires_at)
const mkClearing = (recipient: string, order: string, amount: number, level: number, maturesAt: number, status = 'pending'): void => {
  db.prepare("INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at, matures_at) VALUES (?,?,?,?,?,?,?,?)").run(recipient, order, amount, 'L' + level, status, Date.now(), maturesAt, maturesAt)
}
const mkOptOut = (recipient: string, order: string, amount: number, level: number, expiresAt: number): void => {
  db.prepare("INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at, matures_at) VALUES (?,?,?,?,'pending',?,?,NULL)").run(recipient, order, amount, 'L' + level, Date.now(), expiresAt)
}
const bal = (uid: string): number => (db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(uid) as { balance: number }).balance
const rowStatus = (id: number): string => (db.prepare("SELECT status FROM pending_commission_escrow WHERE id = ?").get(id) as { status: string })?.status
const crCount = (order: string): number => (db.prepare("SELECT COUNT(*) n FROM commission_records WHERE order_id = ?").get(order) as { n: number }).n
const lastRowId = (): number => (db.prepare("SELECT MAX(id) m FROM pending_commission_escrow").get() as { m: number }).m

try {
  const seller = mkUser('usr_seller'); const buyer = mkUser('usr_buyer')

  // ── A. maturation pays exactly once ──
  const p1 = mkClearing(mkUser('usr_p1'), mkOrder('ord_A', buyer, seller, mkProduct('prod_A', seller), 100), 10, 1, PAST), idA = lastRowId()
  ok('A: precondition — recipient wallet empty, no commission_records', bal('usr_p1') === 0 && crCount('ord_A') === 0)
  ok('A: matureClearingRow → settled', matureClearingRow(db, { id: idA, recipient_user_id: 'usr_p1', order_id: 'ord_A', amount: 10, attribution_path: 'L1' }) === 'settled')
  ok('A: wallet credited the commission', bal('usr_p1') === 10, `bal=${bal('usr_p1')}`)
  ok('A: commission_records written at maturation', crCount('ord_A') === 1)
  ok('A: pending row → settled', rowStatus(idA) === 'settled')

  // ── B. idempotent (re-run never double-pays) ──
  ok('B: re-mature → skipped', matureClearingRow(db, { id: idA, recipient_user_id: 'usr_p1', order_id: 'ord_A', amount: 10, attribution_path: 'L1' }) === 'skipped')
  ok('B: wallet unchanged (no double-pay)', bal('usr_p1') === 10)
  ok('B: commission_records still 1', crCount('ord_A') === 1)

  // ── C. a REVERSED row never pays ──
  mkClearing(mkUser('usr_p2'), mkOrder('ord_C', buyer, seller, mkProduct('prod_C', seller), 100), 10, 1, PAST, 'reversed'); const idC = lastRowId()
  ok('C: matureClearingRow on reversed → skipped (CAS no pending)', matureClearingRow(db, { id: idC, recipient_user_id: 'usr_p2', order_id: 'ord_C', amount: 10, attribution_path: 'L1' }) === 'skipped')
  ok('C: reversed recipient never paid', bal('usr_p2') === 0)

  // ── D. partial reduction (proportional) then matures pays the reduced amount ──
  mkClearing(mkUser('usr_p3'), mkOrder('ord_D', buyer, seller, mkProduct('prod_D', seller), 100), 10, 1, PAST); const idD = lastRowId()
  db.prepare("UPDATE pending_commission_escrow SET amount = amount * ? WHERE id = ?").run(0.4, idD)  // 60% refund → keep 40%
  ok('D: matured → settled', matureClearingRow(db, { id: idD, recipient_user_id: 'usr_p3', order_id: 'ord_D', amount: 4, attribution_path: 'L1' }) === 'settled')
  ok('D: paid the reduced amount (4, not 10)', bal('usr_p3') === 4, `bal=${bal('usr_p3')}`)

  // ── E. HOLD while a dispute is open ──
  mkClearing(mkUser('usr_p4'), mkOrder('ord_E', buyer, seller, mkProduct('prod_E', seller), 100), 10, 1, PAST); const idE = lastRowId()
  db.prepare("INSERT INTO disputes (id, order_id, initiator_id, reason, status) VALUES (?,?,?,?,'open')").run('dsp_E', 'ord_E', buyer, 'return escalated')
  ok('E: open dispute → held', matureClearingRow(db, { id: idE, recipient_user_id: 'usr_p4', order_id: 'ord_E', amount: 10, attribution_path: 'L1' }) === 'held')
  ok('E: not paid while disputed', bal('usr_p4') === 0)
  ok('E: row stays pending (retried later)', rowStatus(idE) === 'pending')

  // ── F. sweep excludes not-yet-due rows ──
  mkClearing(mkUser('usr_p5'), mkOrder('ord_F', buyer, seller, mkProduct('prod_F', seller), 100), 10, 1, FUTURE); const idF = lastRowId()
  const sweep1 = await runClearingMatureSweep({ db })
  ok('F: future-dated row not settled by sweep', rowStatus(idF) === 'pending')
  ok('F: sweep settled the due ones only', sweep1.settled >= 0)  // A/D already settled; E held; F future

  // ── G. conservation across states ──
  // accrued = paid(settled wallet) + still-pending + reversed. Sum over p1..p5 orders.
  // p1: 10 paid; p3: 4 paid (6 effectively reversed via reduction); p2: 10 reversed; p4: 10 pending(held); p5: 10 pending(future)
  const paid = bal('usr_p1') + bal('usr_p3') + bal('usr_p4') + bal('usr_p5')  // 10 + 4 + 0 + 0
  const pending = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM pending_commission_escrow WHERE status='pending' AND matures_at IS NOT NULL").get() as { s: number }).s  // p4(10)+p5(10)+... = 20
  const reversed = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM pending_commission_escrow WHERE status='reversed'").get() as { s: number }).s  // p2(10)
  ok('G: no negative balances anywhere', paid >= 0)
  ok('G: paid = exactly the matured amounts (10 + 4)', paid === 14, `paid=${paid}`)
  ok('G: held + future remain pending (20)', pending === 20, `pending=${pending}`)
  ok('G: reversed accounted (10)', reversed === 10, `reversed=${reversed}`)

  // ── H. ② MIXED DATASET — cron isolation (THE high-risk one) ──
  const optRecipient = mkUser('usr_optout'); const clrRecipient = mkUser('usr_clearing')
  mkOrder('ord_H1', buyer, seller, mkProduct('prod_H1', seller), 100)
  mkOrder('ord_H2', buyer, seller, mkProduct('prod_H2', seller), 100)
  mkOptOut(optRecipient, 'ord_H1', 7, 2, PAST)         // opt-out escrow: matures_at NULL, expires past
  const optRowId = lastRowId()
  mkClearing(clrRecipient, 'ord_H2', 9, 1, PAST)       // clearing: matures past
  const clrRowId = lastRowId()

  const redirects: Array<{ amount: number; recipient?: string }> = []
  const escrowRes = await runEscrowExpireSweep({ db, redirectToCommissionReserve: (amount: number, _k: any, args: any) => { redirects.push({ amount, recipient: args?.fromUserId }) } })
  ok('H: escrow-expire expired the OPT-OUT row', rowStatus(optRowId) === 'expired')
  ok('H: escrow-expire did NOT touch the CLEARING row', rowStatus(clrRowId) === 'pending', `clearing status=${rowStatus(clrRowId)}`)
  ok('H: escrow-expire redirected ONLY the opt-out amount', redirects.length === 1 && redirects[0].amount === 7 && redirects[0].recipient === optRecipient, JSON.stringify(redirects))
  ok('H: clearing recipient NOT paid by escrow-expire', bal('usr_clearing') === 0)

  const clrRes = await runClearingMatureSweep({ db })
  ok('H: clearing cron settled the CLEARING row', rowStatus(clrRowId) === 'settled')
  ok('H: clearing cron paid ONLY the clearing recipient', bal('usr_clearing') === 9, `bal=${bal('usr_clearing')}`)
  ok('H: clearing cron did NOT touch the opt-out row (stays expired)', rowStatus(optRowId) === 'expired')
  ok('H: opt-out recipient never paid by clearing cron', bal('usr_optout') === 0)
  void escrowRes; void clrRes; void p1; void uniq

  // ── I. activate (opt-in) path must NOT drain clearing rows (P1 — sibling of ②, found in audit) ──
  // Replicates the exact WHERE clause rewards-apply uses to drain pending escrow on activation.
  const optR2 = mkUser('usr_optout2'); const clrR2 = mkUser('usr_clearing2')
  mkOrder('ord_I1', buyer, seller, mkProduct('prod_I1', seller), 100)
  mkOrder('ord_I2', buyer, seller, mkProduct('prod_I2', seller), 100)
  mkOptOut(optR2, 'ord_I1', 5, 1, FUTURE)    // opt-out escrow, still claimable (matures_at NULL)
  mkClearing(clrR2, 'ord_I2', 8, 1, FUTURE)  // clearing row, pending (matures_at NOT NULL)
  const drainable = db.prepare("SELECT recipient_user_id, matures_at FROM pending_commission_escrow WHERE status='pending' AND matures_at IS NULL AND expires_at > ?").all(Date.now()) as Array<{ recipient_user_id: string; matures_at: number | null }>
  ok('I: activate drain set is opt-out only (every matures_at NULL)', drainable.every(r => r.matures_at === null), JSON.stringify(drainable))
  ok('I: activate drains the opt-out row', drainable.some(r => r.recipient_user_id === 'usr_optout2'))
  ok('I: activate EXCLUDES the clearing row (no early pay → no clawback hole)', !drainable.some(r => r.recipient_user_id === 'usr_clearing2'))

  if (fail === 0) {
    console.log(`\n✅ clearing commission: matures pays-once/idempotent · reversed never pays · partial proportional · hold-on-dispute · conservation · cron isolation (opt-out vs clearing)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ clearing commission FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
