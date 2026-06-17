#!/usr/bin/env tsx
/**
 * PR 3B-3a — GitHub credential store + RFC-017 fact layer SCHEMA test (fresh in-memory DB).
 *   用法:npm run test:github-credential-store
 *
 * Proves every FK / UNIQUE / CHECK / NOT NULL is enforced BY THE DATABASE (not just by code),
 * on a fresh in-memory SQLite DB with `PRAGMA foreign_keys = ON`. No ingestion logic is tested
 * (there is none in 3B-3a) — schema only.
 */
import Database from 'better-sqlite3'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}
function rejects(name: string, fn: () => void): void {
  let threw = false; try { fn() } catch { threw = true }
  ok(`DB rejects: ${name}`, threw)
}
function accepts(name: string, fn: () => void): void {
  let threw = false; let err = ''
  try { fn() } catch (e) { threw = true; err = (e as Error).message }
  ok(`DB accepts: ${name}`, !threw, err)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initGithubCredentialStoreSchema(db)
  return db
}
const baseCred = { credential_id: 'ghc_x', core_digest: 'd1', credential_version: '2', source_event_key: 'github:R:P:merged', repository_id: 'R', pr_node_id: 'P', pr_number: 1, merge_commit_sha: 'm', merged_at: 't', github_actor_id: 'U', lifecycle_event: 'merged', core_json: '{}' }
const baseFact = { fact_id: 'cfact_1', source_event_key: 'github:R:P:merged', source: 'github', type: null as string | null, artifact_ref: 'm', occurred_at: 't', executor_ref: 'github:U', accountable_ref: null as string | null, provenance: 'unknown', status: 'active' }
const insCred = (db: any, o: any = {}) => db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES (@credential_id,@core_digest,@credential_version,@source_event_key,@repository_id,@pr_node_id,@pr_number,@merge_commit_sha,@merged_at,@github_actor_id,@lifecycle_event,@core_json)`).run({ ...baseCred, ...o })
const insObs = (db: any, o: any = {}) => db.prepare(`INSERT INTO github_credential_observations (id,credential_id,observation_digest,observation_json,observed_at) VALUES (@id,@credential_id,@observation_digest,@observation_json,@observed_at)`).run({ id: 'gco_1', credential_id: 'ghc_x', observation_digest: 'o1', observation_json: '{}', observed_at: 't', ...o })
const insFact = (db: any, o: any = {}) => db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status) VALUES (@fact_id,@source_event_key,@source,@type,@artifact_ref,@occurred_at,@executor_ref,@accountable_ref,@provenance,@status)`).run({ ...baseFact, ...o })
const insLink = (db: any, o: any = {}) => db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES (@fact_id,@credential_id,@source_event_key)`).run({ fact_id: 'cfact_1', credential_id: 'ghc_x', source_event_key: 'github:R:P:merged', ...o })

// ── foreign_keys actually ON ──
{ const db = freshDb(); ok('PRAGMA foreign_keys = ON', db.pragma('foreign_keys', { simple: true }) === 1) }

// ── happy path: all four insert cleanly ──
{ const db = freshDb()
  accepts('valid credential', () => insCred(db))
  accepts('valid observation', () => insObs(db))
  accepts('valid fact', () => insFact(db))
  accepts('valid link', () => insLink(db)) }

// ── NOT NULL (merged-only profile) ──
rejects('merge_commit_sha NULL', () => { const db = freshDb(); insCred(db, { merge_commit_sha: null }) })
rejects('merged_at NULL', () => { const db = freshDb(); insCred(db, { merged_at: null }) })

// ── CHECK lifecycle_event = 'merged' ──
rejects("lifecycle_event != 'merged'", () => { const db = freshDb(); insCred(db, { lifecycle_event: 'reverted' }) })

// ── UNIQUE ──
rejects('duplicate core_digest', () => { const db = freshDb(); insCred(db); insCred(db, { credential_id: 'ghc_y' }) })   // same core_digest 'd1'
rejects('duplicate (credential_id, observation_digest)', () => { const db = freshDb(); insCred(db); insObs(db); insObs(db, { id: 'gco_2' }) })
rejects('duplicate fact source_event_key', () => { const db = freshDb(); insFact(db); insFact(db, { fact_id: 'cfact_2' }) })

// ── CHECK enum sets on contribution_facts ──
rejects('bad source', () => { const db = freshDb(); insFact(db, { source: 'evil' }) })
rejects('bad status', () => { const db = freshDb(); insFact(db, { status: 'live' }) })
rejects('bad provenance', () => { const db = freshDb(); insFact(db, { provenance: 'robot' }) })
rejects('bad type (not in 8)', () => { const db = freshDb(); insFact(db, { type: 'docs' }) })
accepts('type NULL (unclassified)', () => { const db = freshDb(); insFact(db, { type: null }) })
rejects('immutable != 1', () => { const db = freshDb(); insFact(db, {}); db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,artifact_ref,executor_ref,status,immutable) VALUES ('cfact_z','k2','github','m','github:U','active',0)`).run() })
// CHECK(immutable=1) applies to UPDATE too — flipping immutable on an existing row is rejected.
// NB: the DB does NOT block UPDATE of OTHER columns / DELETE — row-level append-only is enforced in
// 3B-3b code (mandatory gate, see design §9). This test documents only what the DB itself enforces.
rejects('UPDATE flipping immutable=0 on existing row', () => { const db = freshDb(); insFact(db); db.prepare(`UPDATE contribution_facts SET immutable=0 WHERE fact_id='cfact_1'`).run() })

// ── provenance / type defaults & never-guess ──
{ const db = freshDb()
  db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,artifact_ref,executor_ref,status) VALUES ('cfact_d','kd','github','m','github:U','active')`).run()
  const row = db.prepare(`SELECT provenance, type FROM contribution_facts WHERE fact_id='cfact_d'`).get() as any
  ok("provenance defaults to 'unknown' (never 'human')", row.provenance === 'unknown')
  ok('type defaults to NULL (unclassified, never code)', row.type === null) }

// ── FK orphan rejection (proves foreign_keys=ON) ──
rejects('orphan observation (no parent credential)', () => { const db = freshDb(); insObs(db, { credential_id: 'ghc_nope' }) })
rejects('orphan link fact_id', () => { const db = freshDb(); insCred(db); insLink(db, { fact_id: 'cfact_nope' }) })
rejects('orphan link credential_id', () => { const db = freshDb(); insFact(db); insLink(db, { credential_id: 'ghc_nope' }) })

// ── UNIQUE(credential_id) on link: one credential evidences exactly ONE fact ──
rejects('same credential linked to a second fact', () => {
  const db = freshDb(); insCred(db)
  insFact(db, { fact_id: 'cfact_1', source_event_key: 'github:R:P:merged' })
  insFact(db, { fact_id: 'cfact_2', source_event_key: 'github:R:P2:merged' })
  insLink(db, { fact_id: 'cfact_1', credential_id: 'ghc_x' })
  insLink(db, { fact_id: 'cfact_2', credential_id: 'ghc_x' })   // same credential → 2nd fact → rejected
})
// but v2→v3 (different credential_ids) linking to the SAME fact is allowed
accepts('two credentials (v2,v3) → same fact', () => {
  const db = freshDb()
  insCred(db, { credential_id: 'ghc_v2', core_digest: 'dv2' })
  insCred(db, { credential_id: 'ghc_v3', core_digest: 'dv3' })
  insFact(db)
  insLink(db, { fact_id: 'cfact_1', credential_id: 'ghc_v2' })
  insLink(db, { fact_id: 'cfact_1', credential_id: 'ghc_v3' })
})

// ── Codex #297 P2-1: cross-event integrity — a credential for event X cannot be linked to a fact for
//    event Y. The link carries source_event_key + composite FKs to credentials(credential_id,sek) and
//    facts(fact_id,sek): whichever key the link names, it can't match BOTH a credential of event X and
//    a fact of event Y → one composite FK has no parent row → DB rejects. ──
rejects('cross-event mislink (link key matches credential, not fact)', () => {
  const db = freshDb()
  insCred(db, { credential_id: 'ghc_A', core_digest: 'dA', source_event_key: 'github:R:PA:merged' })
  insFact(db, { fact_id: 'cfact_B', source_event_key: 'github:R:PB:merged' })
  insLink(db, { fact_id: 'cfact_B', credential_id: 'ghc_A', source_event_key: 'github:R:PA:merged' })
})
rejects('cross-event mislink (link key matches fact, not credential)', () => {
  const db = freshDb()
  insCred(db, { credential_id: 'ghc_A', core_digest: 'dA', source_event_key: 'github:R:PA:merged' })
  insFact(db, { fact_id: 'cfact_B', source_event_key: 'github:R:PB:merged' })
  insLink(db, { fact_id: 'cfact_B', credential_id: 'ghc_A', source_event_key: 'github:R:PB:merged' })
})
accepts('co-membered link (credential, fact, link all same source_event_key)', () => {
  const db = freshDb()
  insCred(db, { credential_id: 'ghc_A', core_digest: 'dA', source_event_key: 'github:R:PA:merged' })
  insFact(db, { fact_id: 'cfact_A', source_event_key: 'github:R:PA:merged' })
  insLink(db, { fact_id: 'cfact_A', credential_id: 'ghc_A', source_event_key: 'github:R:PA:merged' })
})

// ── Codex #297 follow-up: migration atomicity + full-structure detection ──
// Build a PRE-P2-1 "old shape": link WITHOUT source_event_key/composite FK; credentials/facts WITHOUT
// the composite UNIQUE. initGithubCredentialStoreSchema must upgrade-if-empty / fail-closed-if-not /
// atomically roll back on error — all in one transaction.
function oldShapeDb(): any {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE github_contribution_credentials (credential_id TEXT PRIMARY KEY, core_digest TEXT NOT NULL UNIQUE, credential_version TEXT NOT NULL, source_event_key TEXT NOT NULL, repository_id TEXT NOT NULL, pr_node_id TEXT NOT NULL, pr_number INTEGER NOT NULL, merge_commit_sha TEXT NOT NULL, merged_at TEXT NOT NULL, github_actor_id TEXT NOT NULL, lifecycle_event TEXT NOT NULL CHECK (lifecycle_event='merged'), core_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  db.exec(`CREATE TABLE github_credential_observations (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES github_contribution_credentials(credential_id), observation_digest TEXT NOT NULL, observation_json TEXT NOT NULL, observed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(credential_id, observation_digest))`)
  db.exec(`CREATE TABLE contribution_facts (fact_id TEXT PRIMARY KEY, source_event_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL CHECK(source IN ('github','in_protocol','governance','transaction')), type TEXT, artifact_ref TEXT NOT NULL, occurred_at TEXT, executor_ref TEXT NOT NULL, accountable_ref TEXT, provenance TEXT NOT NULL DEFAULT 'unknown', status TEXT NOT NULL, immutable INTEGER NOT NULL DEFAULT 1 CHECK(immutable=1), created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  db.exec(`CREATE TABLE github_fact_credentials (fact_id TEXT NOT NULL REFERENCES contribution_facts(fact_id), credential_id TEXT NOT NULL REFERENCES github_contribution_credentials(credential_id), created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (fact_id, credential_id), UNIQUE (credential_id))`)
  return db
}
const hasSourceKeyCol = (db: any): boolean => db.prepare(`SELECT 1 FROM pragma_table_info('github_fact_credentials') WHERE name='source_event_key'`).get() !== undefined
const tableThere = (db: any, t: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t) !== undefined
const threwOn = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }
const upgradedRejectsCrossEvent = (db: any): boolean => {
  insCred(db, { credential_id: 'ghc_A', core_digest: 'dA', source_event_key: 'github:R:PA:merged' })
  insFact(db, { fact_id: 'cfact_B', source_event_key: 'github:R:PB:merged' })
  return threwOn(() => insLink(db, { fact_id: 'cfact_B', credential_id: 'ghc_A', source_event_key: 'github:R:PA:merged' }))
}

// 1) empty old-shape → upgraded to current shape (composite FK now enforces cross-event integrity)
{ const db = oldShapeDb()
  ok('migration: empty old-shape upgrades without error', !threwOn(() => initGithubCredentialStoreSchema(db)))
  ok('migration: link gained source_event_key column', hasSourceKeyCol(db))
  ok('migration: upgraded shape rejects a cross-event link (composite FK present)', upgradedRejectsCrossEvent(db)) }

// 2) NON-empty old-shape → refused (fail-closed), every table + row unchanged
{ const db = oldShapeDb()
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES ('ghc_keep','dk','2','github:R:P:merged','R','P',1,'m','t','U','merged','{}')`).run()
  ok('migration: non-empty old-shape → throws (refuses to drop data)', threwOn(() => initGithubCredentialStoreSchema(db)))
  ok('migration: data row preserved after refusal', (db.prepare(`SELECT COUNT(*) AS c FROM github_contribution_credentials`).get() as any).c === 1)
  ok('migration: link still old-shape after refusal (no source_event_key)', !hasSourceKeyCol(db)) }

// 3) half-migrated state (link missing, parent tables present + empty) → atomically repaired
{ const db = oldShapeDb(); db.exec(`DROP TABLE github_fact_credentials`)
  ok('migration: half-state (link missing, empty parents) repairs without error', !threwOn(() => initGithubCredentialStoreSchema(db)))
  ok('migration: all 4 tables present after repair', ['github_fact_credentials', 'github_credential_observations', 'contribution_facts', 'github_contribution_credentials'].every(t => tableThere(db, t)))
  ok('migration: repaired shape rejects a cross-event link', upgradedRejectsCrossEvent(db)) }

// 4) error mid-migration → whole step rolls back; the original (old) tables stay intact
{ const db = oldShapeDb()
  const origExec = db.exec.bind(db)
  ;(db as any).exec = (sql: string) => { if (/CREATE TABLE IF NOT EXISTS github_contribution_credentials/.test(sql)) throw new Error('injected mid-migration failure'); return origExec(sql) }
  ok('migration: injected mid-migration error throws', threwOn(() => initGithubCredentialStoreSchema(db)))
  ;(db as any).exec = origExec
  ok('migration: rollback restored the dropped tables', tableThere(db, 'github_fact_credentials') && tableThere(db, 'github_contribution_credentials'))
  ok('migration: rollback left original old shape intact (no half-migrated source_event_key)', !hasSourceKeyCol(db)) }

console.log('\ntest:github-credential-store (schema, fresh in-memory DB)')
console.log('───────────────────────────────────────────────────────')
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
console.log('✅ all 3B-3a schema constraints are enforced by the DB\n')
