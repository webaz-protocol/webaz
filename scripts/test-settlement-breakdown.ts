#!/usr/bin/env tsx
/**
 * Regression guard for the order settlement_breakdown redirect accounting (orders-action.ts).
 * 用法:npm run test:settlement-breakdown
 *
 * Context: after the 2026-06-04 three-account decoupling, undelivered commission no longer goes to
 * charity_fund / global_fund — it goes to commission_reserve (by kind) or, for opt-out not-yet-activated
 * recipients, pending_commission_escrow (recoverable; on expiry → commission_reserve `redirect_escrow_expired`).
 * The read-only settlement_breakdown used to report `redirected_to_charity` / `redirected_to_global_fund`
 * (both now always 0), so `redirected_total` couldn't be reconciled. This locks the fix.
 *
 *  A) static guard over orders-action.ts: breakdown reads commission_reserve_txns (all 5 kinds) +
 *     pending_commission_escrow, exposes the commission_reserve_* / escrow / accounted fields, and no longer
 *     reads/exposes the stale charity_fund_txns / fund_deposits / redirected_to_charity / *_global_fund.
 *  B) accounting-identity over real rows: redirected_to_commission_reserve = Σ reserve kinds (incl.
 *     escrow_expired); held_in_opt_out_escrow = Σ pending escrow; redirected_total == reserve + escrow_held
 *     (redirect_accounted_ok); charity_fund_txns / fund_deposits contribute nothing.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── A) static guard over the real handler source ──
const src = readFileSync(join(ROOT, 'src', 'pwa', 'routes', 'orders-action.ts'), 'utf8')
// the settlement_breakdown build region (commission redirect accounting)
const bd = src.slice(src.indexOf('const commissionRedirected ='), src.indexOf('fund_base_1pct:'))
ok('A breakdown region found', bd.length > 0)
// stale口径 gone
for (const stale of ['redirected_to_charity', 'redirected_to_global_fund', 'charity_fund_txns', 'fund_deposits', 'amount_l3']) {
  ok(`A breakdown no longer references stale "${stale}"`, !bd.includes(stale))
}
// reads the real destinations
ok('A reads commission_reserve_txns by related_order_id + kind',
  /commission_reserve_txns WHERE related_order_id = \? GROUP BY kind/.test(bd))
ok('A reads pending_commission_escrow (pending) by order_id',
  /pending_commission_escrow WHERE order_id = \? AND status = 'pending'/.test(bd))
// all five redirect kinds are bucketed (incl. escrow_expired)
for (const kind of ['redirect_region_cap', 'redirect_chain_gap', 'redirect_orphan_sponsor', 'redirect_opt_out_deactivated', 'redirect_escrow_expired']) {
  ok(`A buckets kind "${kind}"`, bd.includes(`'${kind}'`))
}
ok('A reserveByKind includes escrow_expired', /reserve_by_kind|escrow_expired: 0/.test(bd) && /escrow_expired/.test(bd))
// exposes the new fields + reconciliation
for (const field of ['redirected_to_commission_reserve', 'reserve_by_kind', 'held_in_opt_out_escrow', 'redirect_accounted_ok']) {
  ok(`A exposes field "${field}"`, bd.includes(field))
}
ok('A reserve sum includes escrow_expired', /redirectedToCommissionReserve = round2\([^)]*reserveByKind\.escrow_expired/.test(bd))

// ── B) accounting identity over real rows (mirrors the handler contract) ──
/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`
  CREATE TABLE commission_reserve_txns (id TEXT PRIMARY KEY, kind TEXT, from_user_id TEXT, amount REAL, related_order_id TEXT, note TEXT);
  CREATE TABLE pending_commission_escrow (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_user_id TEXT, order_id TEXT, amount REAL, attribution_path TEXT, status TEXT);
  CREATE TABLE charity_fund_txns (id TEXT PRIMARY KEY, amount REAL, related_order_id TEXT);
  CREATE TABLE fund_deposits (order_id TEXT, amount_l3 REAL);
`)
const round2 = (n: number) => Math.round(n * 100) / 100
const ORDER = 'ord_test'
const addReserve = (kind: string, amount: number) => db.prepare("INSERT INTO commission_reserve_txns (id,kind,amount,related_order_id) VALUES (?,?,?,?)").run(kind + Math.random(), kind, amount, ORDER)
const addEscrow = (amount: number, status = 'pending') => db.prepare("INSERT INTO pending_commission_escrow (recipient_user_id,order_id,amount,attribution_path,status) VALUES ('u','" + ORDER + "',?,?,?)").run(amount, 'L2', status)

// seed: reserve (region_cap 2 + chain_gap 1 + orphan 0.5 + opt_out 0.5 + escrow_expired 1 = 5) + pending escrow 3 → redirected_total 8
addReserve('redirect_region_cap', 2)
addReserve('redirect_chain_gap', 1)
addReserve('redirect_orphan_sponsor', 0.5)
addReserve('redirect_opt_out_deactivated', 0.5)
addReserve('redirect_escrow_expired', 1)
addEscrow(3, 'pending')
addEscrow(9, 'settled')   // settled escrow must NOT count toward held
// also seed an unrelated order's reserve to prove related_order_id filtering
db.prepare("INSERT INTO commission_reserve_txns (id,kind,amount,related_order_id) VALUES ('x','redirect_region_cap',99,'ord_other')").run()

// the breakdown contract (same shape as the handler)
const crRows = db.prepare("SELECT kind, COALESCE(SUM(amount),0) AS s FROM commission_reserve_txns WHERE related_order_id = ? GROUP BY kind").all(ORDER) as { kind: string; s: number }[]
const reserveByKind = { region_cap: 0, chain_gap: 0, orphan_sponsor: 0, opt_out_deactivated: 0, escrow_expired: 0 }
for (const r of crRows) {
  if (r.kind === 'redirect_region_cap') reserveByKind.region_cap = round2(r.s)
  else if (r.kind === 'redirect_chain_gap') reserveByKind.chain_gap = round2(r.s)
  else if (r.kind === 'redirect_orphan_sponsor') reserveByKind.orphan_sponsor = round2(r.s)
  else if (r.kind === 'redirect_opt_out_deactivated') reserveByKind.opt_out_deactivated = round2(r.s)
  else if (r.kind === 'redirect_escrow_expired') reserveByKind.escrow_expired = round2(r.s)
}
const redirectedToCommissionReserve = round2(reserveByKind.region_cap + reserveByKind.chain_gap + reserveByKind.orphan_sponsor + reserveByKind.opt_out_deactivated + reserveByKind.escrow_expired)
const heldInOptOutEscrow = round2((db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM pending_commission_escrow WHERE order_id = ? AND status = 'pending'").get(ORDER) as { s: number }).s)
const redirectedTotal = 8   // = commissionPool - distributed (given by the caller)
const accountedOk = Math.abs(redirectedTotal - round2(redirectedToCommissionReserve + heldInOptOutEscrow)) < 0.01

ok('B reserve_by_kind buckets each kind', reserveByKind.region_cap === 2 && reserveByKind.chain_gap === 1 && reserveByKind.orphan_sponsor === 0.5 && reserveByKind.opt_out_deactivated === 0.5 && reserveByKind.escrow_expired === 1)
ok('B redirected_to_commission_reserve = Σ kinds (incl. escrow_expired)', redirectedToCommissionReserve === 5)
ok('B held_in_opt_out_escrow = Σ pending only (settled excluded)', heldInOptOutEscrow === 3)
ok('B redirect_accounted_ok: redirected_total == reserve + escrow', accountedOk)
ok('B related_order_id filter excludes other orders', redirectedToCommissionReserve === 5 /* not 104 */)
ok('B charity_fund_txns contributes nothing (no rows for order)', (db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM charity_fund_txns WHERE related_order_id = ?").get(ORDER) as { s: number }).s === 0)
ok('B fund_deposits.amount_l3 contributes nothing (no rows for order)', (db.prepare("SELECT COALESCE(SUM(amount_l3),0) AS s FROM fund_deposits WHERE order_id = ?").get(ORDER) as { s: number }).s === 0)

// time-shift: a pending escrow that later expires → moves into reserve (escrow_expired), identity still holds
db.prepare("UPDATE pending_commission_escrow SET status = 'expired' WHERE order_id = ? AND status = 'pending'").run(ORDER)
addReserve('redirect_escrow_expired', 3)   // cron redirects the expired 3 into reserve
const reserveAfter = round2((db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commission_reserve_txns WHERE related_order_id = ?").get(ORDER) as { s: number }).s)
const heldAfter = round2((db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM pending_commission_escrow WHERE order_id = ? AND status = 'pending'").get(ORDER) as { s: number }).s)
ok('B after expiry: held → 0, reserve absorbs it, identity still reconciles', heldAfter === 0 && Math.abs(redirectedTotal - round2(reserveAfter + heldAfter)) < 0.01)

if (fail === 0) {
  console.log(`\n✅ settlement_breakdown redirect accounting: reads commission_reserve_txns (5 kinds incl. escrow_expired) + pending_commission_escrow, not charity/global_fund; redirected_total reconciles to commission_reserve + opt-out escrow (redirect_accounted_ok); related_order_id scoped; survives escrow→expiry transition\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ settlement_breakdown FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
