#!/usr/bin/env tsx
/**
 * Matching-rewards engine EXCISED — stub contract test (src/pwa/internal/pv-settlement.ts).
 *   用法:npm run test:pv-settlement-engine
 *
 * The binary matching + safe-valve payout path was removed from the public codebase and replaced with a
 * permanent no-op stub. This test proves the safety contract that is STRONGER than the kill-switch:
 * even with BOTH gate flags forced ON (`matching_rewards_active='1'` + `matching_rewards_activation_cleared='1'`)
 * and a fully-paired dirty user present, the stub:
 *   - runBinarySettlement() → 0, mints NO binary_score_records, does NOT touch PV legs;
 *   - executeSafeSettlementCron() → { status: 'disabled' }, credits no wallet, debits no pool.
 * i.e. the public code cannot pay matching rewards because the engine is gone, not merely gated.
 *
 * (Neutral participation recording — joinPowerLeg / processPvLedger / calculatePv — lives in server.ts,
 * default ON, and is intentionally NOT exercised here.)
 */
import Database from 'better-sqlite3'
import { createPvSettlementEngine } from '../src/pwa/internal/pv-settlement.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`
  CREATE TABLE protocol_params (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE users (id TEXT PRIMARY KEY, total_left_pv REAL DEFAULT 0, total_right_pv REAL DEFAULT 0, pv_dirty_at TEXT, rewards_opted_in INTEGER DEFAULT 0);
  CREATE TABLE binary_score_records (id TEXT PRIMARY KEY, user_id TEXT, tier INTEGER, score REAL, settled_at TEXT, waz_amount REAL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE global_fund (id INTEGER PRIMARY KEY, pool_balance REAL DEFAULT 0, total_scores_pending REAL DEFAULT 0);
  CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, earned REAL DEFAULT 0);
  INSERT INTO global_fund (id, pool_balance) VALUES (1, 10000);
`)
let idc = 0
const generateId = (p: string) => `${p}_${++idc}`
const regionPvEnabled = (_r: string) => true

const engine = createPvSettlementEngine({ db, generateId, regionPvEnabled })
const scoreCount = () => (db.prepare('SELECT COUNT(*) c FROM binary_score_records').get() as any).c

// a fully-paired, opted-in, dirty user that the OLD engine would have matched + paid
db.prepare("INSERT INTO users (id, total_left_pv, total_right_pv, pv_dirty_at, rewards_opted_in) VALUES ('u', 800, 800, datetime('now'), 1)").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('u', 0)").run()

// FORCE both kill-switch flags ON — the stub must still no-op (excised > gated)
db.prepare("INSERT OR REPLACE INTO protocol_params (key,value) VALUES ('matching_rewards_active','1')").run()
db.prepare("INSERT OR REPLACE INTO protocol_params (key,value) VALUES ('matching_rewards_activation_cleared','1')").run()

const settled = engine.runBinarySettlement()
ok('excised: runBinarySettlement → 0 even with both flags ON', settled === 0, `got ${settled}`)
ok('excised: no binary_score_records minted', scoreCount() === 0)
const u = db.prepare("SELECT total_left_pv, total_right_pv FROM users WHERE id='u'").get() as any
ok('excised: PV legs untouched (no matching / no leg-reset)', u.total_left_pv === 800 && u.total_right_pv === 800)

const payout = engine.executeSafeSettlementCron()
ok('excised: executeSafeSettlementCron → status disabled', payout.status === 'disabled', `got ${payout.status}`)
ok('excised: no wallet credited', (db.prepare("SELECT balance b FROM wallets WHERE user_id='u'").get() as any).b === 0)
ok('excised: pool untouched (10000)', (db.prepare('SELECT pool_balance p FROM global_fund WHERE id=1').get() as any).p === 10000)
ok('excised: total_scores_pending still 0', (db.prepare('SELECT total_scores_pending t FROM global_fund WHERE id=1').get() as any).t === 0)

if (fail === 0) {
  console.log(`\n✅ matching-rewards engine EXCISED: stub no-ops even with both kill-switch flags forced ON — runBinarySettlement → 0, no Score minted, PV legs untouched, safe-valve disabled, no wallet/pool movement. Public code cannot pay matching rewards (engine removed, not merely gated).\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ pv-settlement excise contract FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
