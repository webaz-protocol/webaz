/**
 * RFC-018 PR2a — commission clearing maturation cron + per-row maturation logic.
 *
 * Opted-in commission accrues to pending_commission_escrow at order completion with a `matures_at`
 * (= completed_at + product.return_days + settlement.clearing_buffer_days) but is NOT paid yet. This
 * module sweeps rows past matures_at and matures each: re-validate the order is still genuinely closed
 * (completed + no open dispute) → write commission_records + credit the wallet, in one CAS-guarded tx.
 * A return inside the window already flipped the row to 'reversed' (executeReturnRefund), so this sweep
 * never sees it. Because nothing is paid before maturation, there is never a clawback.
 *
 * Discriminator: clearing rows have `matures_at IS NOT NULL`; opt-out escrow rows (RFC-002 §3.5b) have
 * `matures_at IS NULL` and are handled by the SEPARATE rewards-escrow-expire cron. The two never overlap
 * — this sweep filters matures_at IS NOT NULL; escrow-expire filters matures_at IS NULL.
 *
 * NOTE (documented follow-up): a return ESCALATED to a dispute and refunded via arbitration goes through
 * the dispute path (not executeReturnRefund), so it is not yet auto-reversed; maturation only HOLDS while
 * the dispute is open. Direct return refunds ARE reversed. Money never moves before maturation either way.
 *
 * Idempotency: matureClearingRow CASes on status='pending'; re-runs / crashes don't double-pay. Cron,
 * not lazy-on-read — money becoming spendable must not depend on a user opening a page.
 */
import type Database from 'better-sqlite3'
// RFC-016 Phase 1 — sweep read → async seam; the per-row pay tx stays sync (Phase 3 → pg).
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { applyWalletDelta } from '../../ledger.js'
import { toUnits, toDecimal } from '../../money.js'

export interface ClearingRow { id: number; recipient_user_id: string; order_id: string; amount: number; attribution_path: string }
export type ClearingMatureOutcome = 'settled' | 'held' | 'skipped'

export interface ClearingMatureDeps { db: Database.Database }
export interface ClearingMatureResult { scanned: number; settled: number; held: number; skipped: number }

// #7 Commission source_type (moved from settleCommission). Pure read — stamps commission_records.source_type.
function commissionSourceType(db: Database.Database, productId: string, uid: string | null): 'note' | 'link' | 'sponsor' {
  if (!uid) return 'sponsor'
  const attr = db.prepare(`SELECT shareable_id FROM product_share_attribution WHERE product_id = ? AND sharer_id = ? AND shareable_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(productId, uid) as { shareable_id: string } | undefined
  if (!attr) return 'sponsor'
  const sh = db.prepare(`SELECT type FROM shareables WHERE id = ?`).get(attr.shareable_id) as { type: string } | undefined
  if (!sh) return 'sponsor'
  return sh.type === 'note' ? 'note' : 'link'
}

/**
 * Mature ONE clearing commission row. Re-validates genuine closure (completed + no open dispute), then
 * writes commission_records + credits the wallet in one tx. CAS on status='pending' → idempotent; races
 * and re-runs lose. Holds (no write) while a dispute is open. Exported for direct unit testing.
 */
export function matureClearingRow(db: Database.Database, row: ClearingRow): ClearingMatureOutcome {
  let outcome: ClearingMatureOutcome = 'skipped'
  db.transaction(() => {
    const order = db.prepare("SELECT buyer_id, product_id, snapshot_commission_rate, buyer_region, status FROM orders WHERE id = ?").get(row.order_id) as { buyer_id: string; product_id: string; snapshot_commission_rate: number | null; buyer_region: string | null; status: string } | undefined
    if (!order || order.status !== 'completed') { outcome = 'held'; return }  // completed is terminal; defensive hold
    const openDispute = db.prepare("SELECT 1 FROM disputes WHERE order_id = ? AND status NOT IN ('resolved','dismissed','closed') LIMIT 1").get(row.order_id)
    if (openDispute) { outcome = 'held'; return }  // hold while unresolved (e.g. return escalated to dispute)
    const claimed = db.prepare("UPDATE pending_commission_escrow SET status='settled', settled_at=? WHERE id=? AND status='pending' AND matures_at IS NOT NULL").run(Date.now(), row.id)
    if (claimed.changes !== 1) { outcome = 'skipped'; return }  // race lost / already settled / reversed
    const amountU = toUnits(Number(row.amount))
    if (amountU > 0) {
      const level = Number(String(row.attribution_path).replace(/^L/, '')) || 0
      const rate = Number(order.snapshot_commission_rate ?? 0.10)
      let region = order.buyer_region || null
      if (!region) region = (db.prepare("SELECT region FROM users WHERE id = ?").get(order.buyer_id) as { region: string } | undefined)?.region ?? 'global'
      const srcType = commissionSourceType(db, order.product_id, row.recipient_user_id)
      try {
        db.prepare(`INSERT INTO commission_records (id, order_id, beneficiary_id, source_buyer_id, level, amount, rate, region, source, source_type) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(generateId('comm'), row.order_id, row.recipient_user_id, order.buyer_id, level, toDecimal(amountU), rate, region, 'static', srcType)
      } catch (e) { /* UNIQUE — already recorded on a prior partial run */ }
      applyWalletDelta(db, row.recipient_user_id, { balance: amountU, earned: amountU })
    }
    outcome = 'settled'
  })()
  return outcome
}

export async function runClearingMatureSweep(deps: ClearingMatureDeps): Promise<ClearingMatureResult> {
  const { db } = deps
  const now = Date.now()
  const rows = await dbAll<ClearingRow>(`
    SELECT id, recipient_user_id, order_id, amount, attribution_path
    FROM pending_commission_escrow
    WHERE status = 'pending' AND matures_at IS NOT NULL AND matures_at <= ?
    ORDER BY matures_at ASC
    LIMIT 1000
  `, [now])

  let settled = 0, held = 0, skipped = 0
  for (const r of rows) {
    const o = matureClearingRow(db, r)
    if (o === 'settled') settled++
    else if (o === 'held') held++
    else skipped++
  }
  return { scanned: rows.length, settled, held, skipped }
}

export function startClearingMatureCron(deps: ClearingMatureDeps): void {
  const ms = 60 * 60 * 1000  // 1h — clearing window granularity is days
  setInterval(async () => {
    try {
      const r = await runClearingMatureSweep(deps)
      if (r.settled > 0 || r.held > 0) {
        console.log(`[clearing-mature] scanned ${r.scanned}, settled ${r.settled}, held ${r.held}, skipped ${r.skipped}`)
      }
    } catch (e) {
      console.error('[clearing-mature-cron]', e)
    }
  }, ms)
  console.log('⏳ RFC-018 commission clearing maturation cron 已启动 (每 1h, anchor=matures_at)')
}
