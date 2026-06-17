// Codex #104 P3 — build_reputation_events dedup is DB-enforced:
//   same (source, ref_id) credited twice → one event, points added once (INSERT OR IGNORE on the
//   partial UNIQUE index). Distinct ref_id → counted separately; null ref_id → not deduped.
import Database from 'better-sqlite3'
import { initBuildReputationSchema, creditBuildReputation } from '../src/layer2-business/L2-9-contribution/build-reputation-engine.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
initBuildReputationSchema(db)
const events = (uid: string) => (db.prepare("SELECT COUNT(*) AS n FROM build_reputation_events WHERE user_id=?").get(uid) as { n: number }).n
const points = (uid: string) => (db.prepare("SELECT build_points AS p FROM build_reputation WHERE user_id=?").get(uid) as { p: number } | undefined)?.p ?? 0

// ── same (source, ref_id) twice → one event, points once ──
{
  const r1 = creditBuildReputation(db, 'u1', 'task_done', 10, 'task_42')
  const r2 = creditBuildReputation(db, 'u1', 'task_done', 10, 'task_42')   // dup (double-click / retry)
  expect('first credit → credited 10', r1.credited === 10, r1)
  expect('second (dup) → credited 0, already', r2.credited === 0 && r2.already === true, r2)
  expect('only 1 event row', events('u1') === 1, events('u1'))
  expect('build_points added once (10)', points('u1') === 10, points('u1'))
}

// ── distinct ref_id → separate credits ──
{
  creditBuildReputation(db, 'u1', 'task_done', 10, 'task_99')
  expect('distinct ref → 2 events, 20 points', events('u1') === 2 && points('u1') === 20, { e: events('u1'), p: points('u1') })
}

// ── same ref_id but different source → not a dup (unique is on the pair) ──
{
  creditBuildReputation(db, 'u1', 'feedback_accepted', 5, 'task_42')
  expect('different source same ref → counted (25 points / 3 events)', events('u1') === 3 && points('u1') === 25, { e: events('u1'), p: points('u1') })
}

// ── null ref_id → not deduped (partial index excludes NULL) ──
{
  creditBuildReputation(db, 'u2', 'manual', 3)
  creditBuildReputation(db, 'u2', 'manual', 3)
  expect('null ref_id not deduped → 2 events, 6 points', events('u2') === 2 && points('u2') === 6, { e: events('u2'), p: points('u2') })
}

// ── direct double INSERT OR IGNORE proof: the UNIQUE index actually rejects the 2nd row ──
{
  const before = events('u1')
  const ins = db.prepare(`INSERT OR IGNORE INTO build_reputation_events (id, user_id, source, points, ref_id, note) VALUES (?,?,?,?,?,?)`)
    .run('brev_manual_dup', 'u1', 'task_done', 10, 'task_42', null)
  expect('raw INSERT OR IGNORE of existing (source,ref) → changes 0', ins.changes === 0)
  expect('no new event row', events('u1') === before)
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
