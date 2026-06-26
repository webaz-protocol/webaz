/**
 * RFC-002 §3.5b — pending_commission_escrow expire cron (PR-1c-a)
 *
 * Scans pending escrow entries every hour; entries past expires_at are
 * marked status='expired'. Fund destination depends on attribution_path:
 *   - L1/L2/L3 (commission escrow): money was debited from seller at order
 *     settle → materialize into commission_reserve (三级公池) on expiry.
 *   - pv_pair (PV escrow): the WAZ was never removed from the PV fund pool
 *     (it stayed as cashRetained at binary settlement), so on expiry we do
 *     NOT move funds — the money simply remains in the PV 资金 pool. Moving
 *     it anywhere would double-count. (2026-06-04 三科目解耦 + 修双计 bug)
 *
 * Why a cron (not on-read settlement):
 *   - Activate batch settle (PR-2) only fires when user opts in. Without
 *     an expire sweep, entries from users who never activate would sit
 *     forever, holding protocol funds in limbo.
 *
 * Anchor: pending_commission_escrow.expires_at (ms epoch, set at INSERT
 * time by settleCommission to now + escrow_days * 86400 * 1000).
 *
 * Idempotency: WHERE status='pending' AND expires_at <= now; UPDATE flips
 * to 'expired' in the same transaction as the pool credit. Repeat runs find
 * no rows.
 */
import type Database from 'better-sqlite3'
// RFC-016 Phase 1 — cron 扫描读 → async seam;到期 materialize 的 db.transaction 写仍同步(Phase 3 迁 pg)。
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface EscrowExpireDeps {
  db: Database.Database
  redirectToCommissionReserve: (
    amount: number,
    kind: 'redirect_escrow_expired',
    args: { orderId?: string; fromUserId?: string; note?: string }
  ) => void
}

export interface EscrowExpireResult {
  scanned: number
  expired: Array<{ id: number; recipient_user_id: string; order_id: string; amount: number; attribution_path: string }>
}

export async function runEscrowExpireSweep(deps: EscrowExpireDeps): Promise<EscrowExpireResult> {
  const { db, redirectToCommissionReserve } = deps
  const now = Date.now()
  // RFC-018: pending_commission_escrow now holds TWO lifecycles, discriminated by matures_at:
  //   - matures_at IS NULL  → opt-out escrow (this cron: expire → commission_reserve / pool).
  //   - matures_at NOT NULL → clearing rows (the SEPARATE rewards-clearing-mature cron: pay/reverse).
  // We MUST exclude clearing rows here, or they'd be wrongly expired to the pool instead of paid.
  const rows = await dbAll<{ id: number; recipient_user_id: string; order_id: string; amount: number; attribution_path: string; expires_at: number }>(`
    SELECT id, recipient_user_id, order_id, amount, attribution_path, expires_at
    FROM pending_commission_escrow
    WHERE status = 'pending' AND matures_at IS NULL AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT 1000
  `, [now])

  const expired: EscrowExpireResult['expired'] = []
  for (const r of rows) {
    db.transaction(() => {
      const upd = db.prepare(`UPDATE pending_commission_escrow SET status='expired', expired_to_charity_at=? WHERE id=? AND status='pending' AND matures_at IS NULL`).run(now, r.id)
      if (upd.changes === 0) return  // race lost — another sweep already took it
      if (r.attribution_path === 'pv_pair') {
        // #1106：pv_pair escrow 的钱结算时已从 pool 移入 pv_escrow_reserve。到期未兑付 → 退回 pool。
        db.prepare(`UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve - ?, pool_balance = pool_balance + ? WHERE id = 1`).run(r.amount, r.amount)
      } else {
        // L1/L2/L3 commission escrow：seller 已被扣，到期 materialize 入 commission_reserve。
        redirectToCommissionReserve(r.amount, 'redirect_escrow_expired', {
          orderId: r.order_id,
          fromUserId: r.recipient_user_id,
          note: `escrow expired (${r.attribution_path}) — opted-out recipient never activated within grace window`,
        })
      }
      expired.push({ id: r.id, recipient_user_id: r.recipient_user_id, order_id: r.order_id, amount: r.amount, attribution_path: r.attribution_path })
    })()
  }
  return { scanned: rows.length, expired }
}

export function startEscrowExpireCron(deps: EscrowExpireDeps): void {
  const ms = 60 * 60 * 1000  // 1h fixed (escrow_days is in days; sub-day granularity unnecessary)
  setInterval(async () => {
    try {
      const r = await runEscrowExpireSweep(deps)
      if (r.expired.length > 0) {
        console.log(`[rewards-escrow-expire] swept ${r.scanned}, expired ${r.expired.length}: ${r.expired.map(e => `${e.recipient_user_id}/${e.attribution_path}/${e.amount}`).join(', ')}`)
      }
    } catch (e) {
      console.error('[rewards-escrow-expire-cron]', e)
    }
  }, ms)
  console.log('💸 RFC-002 escrow expire cron 已启动 (每 1h, anchor=expires_at per §3.5b)')
}
