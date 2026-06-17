/**
 * Participation recording vs. matching-rewards gates (Category C — pre-public).
 *
 * Two SEPARATE concepts (WebAZ principle: meaningful participation stays visible/recorded; rewards are gated):
 *
 *  1. participationRecordingActive(db) — DEFAULT ON. Allows neutral participation/contribution recording:
 *     PV generation (pv_ledger) + aggregation into total_left/right_pv. Pure record, NOT income / ownership /
 *     redeemable / entitlement. Only an explicit `participation_recording_active='0'` disables it; absent → ON;
 *     on query error → ON (recording is neutral + safe; never silently stop recording participation).
 *
 *  2. matchingRewardsActive(db) — DEFAULT OFF. Gates the matching-rewards settlement (writes binary_score_records),
 *     reward payout, settlement, and any reward distribution. Requires BOTH
 *     `matching_rewards_active='1'` AND `matching_rewards_activation_cleared='1'` (operational on-switch + a
 *     legal/governance-clearance marker — a single param edit cannot turn rewards on). FAIL-CLOSED: absent /
 *     query error → false (never pay out on uncertainty; never break order settlement).
 *
 * related: server.ts calculatePv + processPvLedger gate on (1); runBinarySettlement + executeSafeSettlementCron
 *          gate on (2). Per-region `region_config.pv_enabled` remains an additional payout-side filter.
 */
import type Database from 'better-sqlite3'

/** Participation recording switch (default ON — only an explicit '0' disables). */
export const PARTICIPATION_RECORDING_KEY = 'participation_recording_active'
/** Matching-rewards operational on-switch + legal/governance clearance marker (both required, default OFF). */
export const MATCHING_REWARDS_ACTIVE_KEY = 'matching_rewards_active'
export const MATCHING_REWARDS_CLEARED_KEY = 'matching_rewards_activation_cleared'

const readParam = (db: Database.Database, k: string): string | undefined =>
  (db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(k) as { value: string } | undefined)?.value

/**
 * DEFAULT ON. Neutral participation/contribution recording (PV ledger + PV aggregation) is allowed unless
 * explicitly turned off. Absent param / query error → ON (recording is safe + neutral; not a payout).
 */
export function participationRecordingActive(db: Database.Database): boolean {
  try {
    return readParam(db, PARTICIPATION_RECORDING_KEY) !== '0'   // default ON; only an explicit '0' disables
  } catch {
    return true   // recording is neutral/no-payout — failing to ON preserves the visible-participation principle
  }
}

/**
 * DEFAULT OFF. Matching-rewards settlement + payout + any reward distribution. True ONLY when the
 * operational on-switch AND the legal/governance-clearance marker are BOTH '1'. FAIL-CLOSED on any
 * missing param / query error → false (never pay on uncertainty; never break the order-settlement hot path).
 */
export function matchingRewardsActive(db: Database.Database): boolean {
  try {
    return readParam(db, MATCHING_REWARDS_ACTIVE_KEY) === '1' && readParam(db, MATCHING_REWARDS_CLEARED_KEY) === '1'
  } catch {
    return false
  }
}
