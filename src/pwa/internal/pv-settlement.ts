/**
 * MATCHING-REWARDS ENGINE — EXCISED (Category C, removed for public release).
 *
 * The matching-rewards settlement path (pairing → Score, safe-valve payout) has been
 * **excised** from the public codebase. This file is a permanent **no-op stub**: the factory preserves the
 * interface so call sites compile and behave exactly as "disabled", but there is **no matching logic and no
 * payout** — `runBinarySettlement()` always returns 0 and `executeSafeSettlementCron()` always returns
 * `{ status: 'disabled' }`, **regardless of the `matching_rewards_active` flags**. This is strictly stronger
 * than the gate: even if the kill-switch is flipped on, the public code cannot pay matching rewards because the
 * engine is gone.
 *
 * UNAFFECTED — neutral participation recording stays in server.ts (default ON):
 *   - joinPowerLeg     placement-tree write (who sits where)
 *   - processPvLedger  pv_ledger → total_left_pv / total_right_pv aggregation (per-leg participation record)
 *   - calculatePv      PV computation (participation record)
 *   (`binary_score_records` / `binary_tier_config` tables remain in schema but are never written here.)
 *
 * Re-enabling a reward feature is a deliberate, counsel/governance-cleared decision — restore the archived
 * engine or build a new compliant one; it is intentionally NOT a config flip. The full prior implementation is
 * preserved internally (`docs/modules/pv-settlement-engine.INTERNAL.md`, gitignored) and in git history.
 */
import type Database from 'better-sqlite3'

export type SettlementResult = {
  periodId: string
  status: 'completed' | 'no_pending' | 'empty_pool' | 'paused_low_water' | 'noop' | 'failed' | 'disabled'
  fund_balance_start?: number
  history_average?: number
  payout_rate?: number
  pool_to_distribute?: number
  total_scores?: number
  n_value_cash?: number
  effective_unit_cash?: number
  cash_distributed?: number
  cash_retained?: number
  settled_users?: number
  mgmt_bonus_paid?: number
  pause_reason?: string
}

export interface PvSettlementDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  regionPvEnabled: (region: string) => boolean
}

/**
 * Excised stub factory. Accepts the same deps as the original engine (so the call site is unchanged) but
 * returns no-op functions. Deps are intentionally unused.
 */
export function createPvSettlementEngine(_deps: PvSettlementDeps): {
  runBinarySettlement: () => number
  executeSafeSettlementCron: () => SettlementResult
} {
  return {
    // 匹配结算已切除:不匹配、不产生 Score、不动 PV 腿。永远返回 0。
    runBinarySettlement: () => 0,
    // 兑付已切除:永远 disabled,从不发放。
    executeSafeSettlementCron: (): SettlementResult => ({ periodId: '', status: 'disabled' }),
  }
}
