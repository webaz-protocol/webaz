#!/usr/bin/env tsx
/**
 * Category C — participation-recording (default ON) vs matching-rewards (default OFF). 用法:npm run test:pv-kill-switch
 *
 * Proves the two-gate split:
 *  A) gate logic (real helpers):
 *     · participationRecordingActive — DEFAULT ON (absent → on); only an explicit '0' disables; missing table → ON (safe).
 *     · matchingRewardsActive — DEFAULT OFF; needs BOTH matching_rewards_active + matching_rewards_activation_cleared;
 *       one flag alone insufficient; missing table → OFF (fail-closed).
 *  B) behavior (real helpers + the exact server.ts guard patterns):
 *     · DEFAULT state → participation RECORDED (genPv>0, pv_ledger row) but matching settlement does NOT run
 *       (no binary_score_records settled, no WAZ).
 *     · recording explicitly '0' → no PV / no rows.
 *     · rewards need both flags (clearance required) → only then settlement runs.
 *  C) static guard: calculatePv + processPvLedger gate on participationRecordingActive; runBinarySettlement +
 *     executeSafeSettlementCron gate on matchingRewardsActive; DEFAULT_PARAMS seeds recording '1', rewards '0'/'0'.
 *
 * Points are participation records only — NOT income, NOT ownership, NOT redeemable, NO entitlement.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { participationRecordingActive, matchingRewardsActive,
  PARTICIPATION_RECORDING_KEY, MATCHING_REWARDS_ACTIVE_KEY, MATCHING_REWARDS_CLEARED_KEY } from '../src/pwa/pv-kill-switch.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE protocol_params (key TEXT PRIMARY KEY, value TEXT)`)
db.exec(`CREATE TABLE pv_ledger (id TEXT PRIMARY KEY, order_id TEXT, buyer_id TEXT, pv REAL, processed INTEGER DEFAULT 0)`)
db.exec(`CREATE TABLE binary_score_records (id TEXT PRIMARY KEY, user_id TEXT, score REAL, settled_at TEXT)`)
const setFlag = (k: string, v: string) => db.prepare('INSERT OR REPLACE INTO protocol_params (key,value) VALUES (?,?)').run(k, v)
const clearFlags = () => db.prepare('DELETE FROM protocol_params').run()

// mirrors server.ts calculatePv's RECORDING guard + caller's `if (pv>0)` pv_ledger insert
const genPvAndStore = (orderId: string, amount: number): number => {
  const pv = !participationRecordingActive(db) ? 0 : Math.round(amount * 10 * 100) / 100
  if (pv > 0) db.prepare('INSERT INTO pv_ledger (id, order_id, buyer_id, pv) VALUES (?,?,?,?)').run('pvl_' + orderId, orderId, 'usr_b', pv)
  return pv
}
// mirrors executeSafeSettlementCron's REWARD guard (payout = this fn; redeems matching score)
const runSettlement = (): { status: string } => {
  if (!matchingRewardsActive(db)) return { status: 'disabled' }
  db.prepare("UPDATE binary_score_records SET settled_at = datetime('now') WHERE settled_at IS NULL").run()
  return { status: 'completed' }
}
const pvRows = () => (db.prepare('SELECT COUNT(*) c FROM pv_ledger').get() as any).c
const unsettled = () => (db.prepare('SELECT COUNT(*) c FROM binary_score_records WHERE settled_at IS NULL').get() as any).c

// ── A) gate logic (real helpers) ──
clearFlags()
ok('A recording: default (absent) → ON', participationRecordingActive(db) === true)
ok('A rewards: default (absent) → OFF', matchingRewardsActive(db) === false)
setFlag(PARTICIPATION_RECORDING_KEY, '0')
ok('A recording: explicit 0 → OFF', participationRecordingActive(db) === false)
setFlag(PARTICIPATION_RECORDING_KEY, '1')
ok('A recording: explicit 1 → ON', participationRecordingActive(db) === true)
clearFlags(); setFlag(MATCHING_REWARDS_ACTIVE_KEY, '1')
ok('A rewards: only active=1 (no clearance) → OFF', matchingRewardsActive(db) === false)
clearFlags(); setFlag(MATCHING_REWARDS_CLEARED_KEY, '1')
ok('A rewards: only cleared=1 (no on-switch) → OFF', matchingRewardsActive(db) === false)
setFlag(MATCHING_REWARDS_ACTIVE_KEY, '1')
ok('A rewards: both flags = 1 → ON (legal/governance clearance + on-switch)', matchingRewardsActive(db) === true)
// fail-closed / fail-safe on missing table
{ const noTbl: any = new Database(':memory:')
  let recErr = false, rewErr = false, recVal: boolean | null = null, rewVal: boolean | null = null
  try { recVal = participationRecordingActive(noTbl) } catch { recErr = true }
  try { rewVal = matchingRewardsActive(noTbl) } catch { rewErr = true }
  ok('A missing table: recording → ON, no throw (safe default-on)', recErr === false && recVal === true)
  ok('A missing table: rewards → OFF, no throw (fail-closed)', rewErr === false && rewVal === false)
  noTbl.close() }

// ── B) behavior ──
clearFlags()   // DEFAULT state: recording on, rewards off
db.prepare('INSERT INTO binary_score_records (id,user_id,score,settled_at) VALUES (?,?,?,NULL)').run('bsr1', 'usr_e', 100)
ok('B DEFAULT: participation RECORDED — genPv > 0', genPvAndStore('o1', 50) > 0)
ok('B DEFAULT: pv_ledger row written (participation visible)', pvRows() === 1)
ok('B DEFAULT: matching settlement does NOT run (disabled)', runSettlement().status === 'disabled')
ok('B DEFAULT: no binary_score_records settled / no WAZ paid', unsettled() === 1)
// recording explicitly off → stop recording
setFlag(PARTICIPATION_RECORDING_KEY, '0')
ok('B recording=0: genPv 0, no new pv_ledger rows', genPvAndStore('o2', 50) === 0 && pvRows() === 1)
setFlag(PARTICIPATION_RECORDING_KEY, '1')
// rewards need BOTH flags
setFlag(MATCHING_REWARDS_ACTIVE_KEY, '1')
ok('B rewards one-flag: settlement still disabled (no scores settled)', runSettlement().status === 'disabled' && unsettled() === 1)
setFlag(MATCHING_REWARDS_CLEARED_KEY, '1')
ok('B rewards both-on: settlement runs (proves gate, not hardcode)', runSettlement().status === 'completed')
ok('B rewards both-on: score now settled', unsettled() === 0)

// ── C) static source guard ──
const server = readFileSync('src/pwa/server.ts', 'utf8')
// matching-reward settlement (excised #401) — internal/pv-settlement.ts is now a no-op stub.
const settleMod = readFileSync('src/pwa/internal/pv-settlement.ts', 'utf8')
const gatedIn = (src: string, fn: string, gate: string): boolean => { const s = src.indexOf(fn); return s > 0 && src.slice(s, s + 600).includes(gate) }
const gatedOn = (fn: string, gate: string): boolean => gatedIn(server, fn, gate)
// recording (default ON) stays in server.ts
ok('C calculatePv gates on participationRecordingActive(db)', gatedOn('function calculatePv', 'participationRecordingActive(db)'))
ok('C processPvLedger gates on participationRecordingActive(db) (recording/aggregation)', gatedOn('function processPvLedger', 'participationRecordingActive(db)'))
// rewards path (matching + payout) EXCISED — internal/pv-settlement.ts is now a permanent no-op stub
// (stronger than the gate: cannot pay even if matchingRewardsActive is forced ON, because the engine is gone)
ok('C matching engine EXCISED: runBinarySettlement is a no-op returning 0', /runBinarySettlement: \(\) => 0/.test(settleMod))
ok('C matching engine EXCISED: executeSafeSettlementCron returns { status: disabled }', /executeSafeSettlementCron/.test(settleMod) && /status: 'disabled'/.test(settleMod))
ok('C matching engine EXCISED: no comp-plan logic remains (no Score mint / matching math)', !settleMod.includes('calculate7LevelTaperingScore') && !settleMod.includes('INSERT INTO binary_score_records'))
ok('C server.ts wires the quarantined engine (db, generateId, regionPvEnabled)', /createPvSettlementEngine\(\{ db, generateId, regionPvEnabled \}\)/.test(server))
ok('C imports the split gates', /participationRecordingActive, matchingRewardsActive.*from '\.\/pv-kill-switch\.js'/.test(server))
ok("C DEFAULT_PARAMS seeds participation_recording_active='1' (default ON)", /key: 'participation_recording_active', value: '1'/.test(server))
ok("C DEFAULT_PARAMS seeds matching_rewards_active='0'", /key: 'matching_rewards_active', value: '0'/.test(server))
ok("C DEFAULT_PARAMS seeds matching_rewards_activation_cleared='0'", /key: 'matching_rewards_activation_cleared', value: '0'/.test(server))

if (fail === 0) {
  console.log(`\n✅ participation recording (default ON) vs matching rewards (default OFF): default → PV/ledger RECORDED but matching settlement + reward payout DISABLED & unreachable; rewards need on-switch + legal/governance clearance (one flag insufficient); recording fail-safe ON / rewards fail-closed OFF; points = participation records only (no income/ownership/redemption/entitlement)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ PV gates FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
