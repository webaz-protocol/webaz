/**
 * GitHub Contribution Credential store + RFC-017 fact layer — SCHEMA (PR 3B-3a; P2-1/#297 follow-up).
 *
 * Creates the 4 append-only tables + all FK/UNIQUE/CHECK for credential persistence and the first
 * RFC-017 §10 Contribution Fact table. No ingestion logic here — that is 3B-3b.
 * Design: docs/GITHUB-CREDENTIAL-INGESTION-DESIGN.md.
 *
 * `contribution_facts` is the GENERIC, source-agnostic RFC-017 fact table; GitHub→credential
 * traceability lives in the separate `github_fact_credentials` link, which carries source_event_key +
 * two COMPOSITE FKs so the DB enforces that a credential and the fact it evidences share the SAME
 * source event (Codex #297 P2-1).
 *
 * Migration atomicity (Codex #297 follow-up): the WHOLE thing — full-structure detection, empty-table
 * check, DROP of the old/partial tables, and the rebuild — runs in ONE synchronous `.immediate()`
 * transaction. A pre-P2-1 (or half-migrated) shape is recreated ONLY if every present contribution
 * table is empty when the layer has no trigger surface; a NON-empty
 * old/partial shape FAILS CLOSED (never drops data), and any error rolls the whole step back, so the
 * schema is never left half-migrated/unwritable. This module does NOT touch the #300 identity tables.
 *
 * NB: the SQL strings carry NO inline `--` comments (gen-pg-schema strips them → trailing whitespace).
 * FK enforcement relies on the connection's `PRAGMA foreign_keys = ON` (set in schema.ts).
 */
import type Database from 'better-sqlite3'

// child-first order (safe for DROP under foreign_keys=ON).
const CONTRIB_TABLES = ['github_fact_credentials', 'github_credential_observations', 'contribution_facts', 'github_contribution_credentials'] as const

const CREATE_CREDENTIALS = `
  CREATE TABLE IF NOT EXISTS github_contribution_credentials (
    credential_id        TEXT PRIMARY KEY,
    core_digest          TEXT NOT NULL UNIQUE,
    credential_version   TEXT NOT NULL,
    source_event_key     TEXT NOT NULL,
    repository_id        TEXT NOT NULL,
    pr_node_id           TEXT NOT NULL,
    pr_number            INTEGER NOT NULL,
    merge_commit_sha     TEXT NOT NULL,
    merged_at            TEXT NOT NULL,
    github_actor_id      TEXT NOT NULL,
    lifecycle_event      TEXT NOT NULL CHECK (lifecycle_event = 'merged'),
    core_json            TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (credential_id, source_event_key)
  )
`
const CREATE_OBSERVATIONS = `
  CREATE TABLE IF NOT EXISTS github_credential_observations (
    id                   TEXT PRIMARY KEY,
    credential_id        TEXT NOT NULL REFERENCES github_contribution_credentials(credential_id),
    observation_digest   TEXT NOT NULL,
    observation_json     TEXT NOT NULL,
    observed_at          TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (credential_id, observation_digest)
  )
`
const CREATE_FACTS = `
  CREATE TABLE IF NOT EXISTS contribution_facts (
    fact_id              TEXT PRIMARY KEY,
    source_event_key     TEXT NOT NULL UNIQUE,
    source               TEXT NOT NULL CHECK (source IN ('github','in_protocol','governance','transaction')),
    type                 TEXT CHECK (type IS NULL OR type IN ('code','tests','audit','maintenance','governance','usage','transaction','referral')),
    artifact_ref         TEXT NOT NULL,
    occurred_at          TEXT,
    executor_ref         TEXT NOT NULL,
    accountable_ref      TEXT,
    provenance           TEXT NOT NULL DEFAULT 'unknown' CHECK (provenance IN ('human','ai_assisted','ai_authored','unknown')),
    status               TEXT NOT NULL CHECK (status IN ('active','superseded','reverted','void','forfeited')),
    immutable            INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (fact_id, source_event_key)
  )
`
const CREATE_LINK = `
  CREATE TABLE IF NOT EXISTS github_fact_credentials (
    fact_id              TEXT NOT NULL,
    credential_id        TEXT NOT NULL,
    source_event_key     TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (fact_id, credential_id),
    UNIQUE (credential_id),
    FOREIGN KEY (credential_id, source_event_key) REFERENCES github_contribution_credentials(credential_id, source_event_key),
    FOREIGN KEY (fact_id, source_event_key) REFERENCES contribution_facts(fact_id, source_event_key)
  )
`
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_ghc_source_event_key ON github_contribution_credentials(source_event_key)`

/* eslint-disable @typescript-eslint/no-explicit-any */
function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined
}
function hasColumn(db: Database.Database, table: string, col: string): boolean {
  return db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col) !== undefined
}
function hasUniqueOnCols(db: Database.Database, table: string, cols: string[]): boolean {
  const idxs = db.prepare(`SELECT * FROM pragma_index_list('${table}')`).all() as any[]
  for (const idx of idxs) {
    if (idx.unique !== 1) continue
    const onCols = (db.prepare(`SELECT name FROM pragma_index_info('${idx.name}') ORDER BY seqno`).all() as any[]).map(r => r.name)
    if (onCols.length === cols.length && onCols.every((c, i) => c === cols[i])) return true
  }
  return false
}
function linkHasCompositeFk(db: Database.Database): boolean {
  const fks = db.prepare(`SELECT * FROM pragma_foreign_key_list('github_fact_credentials')`).all() as any[]
  return fks.some(r => r.from === 'source_event_key')
}
/** Full-structure check (not just link existence): all 4 tables + the P2-1 composite UNIQUE/FK. */
function isCurrentShape(db: Database.Database): boolean {
  return CONTRIB_TABLES.every(t => tableExists(db, t))
    && hasColumn(db, 'github_fact_credentials', 'source_event_key')
    && hasUniqueOnCols(db, 'github_contribution_credentials', ['credential_id', 'source_event_key'])
    && hasUniqueOnCols(db, 'contribution_facts', ['fact_id', 'source_event_key'])
    && linkHasCompositeFk(db)
}

export function initGithubCredentialStoreSchema(db: Database.Database): void {
  // One synchronous .immediate() transaction wraps detect + empty-check + DROP + rebuild, so the
  // schema is never left half-migrated: any error (incl. mid-rebuild) rolls the whole step back.
  const apply = db.transaction(() => {
    const present = CONTRIB_TABLES.filter(t => tableExists(db, t))
    if (present.length > 0 && !isCurrentShape(db)) {
      // Old / partial / half-migrated shape. SQLite can't ALTER-ADD the composite UNIQUE/FK, so we
      // recreate — but ONLY if every present contribution table is empty (fail loud otherwise; never
      // drop data). This also auto-repairs a half-migrated state (e.g. link dropped, parents left).
      const total = present.reduce((n, t) => n + (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c, 0)
      if (total !== 0) throw new Error('github credential store is old/partial shape but NOT empty — manual migration required (refusing to drop data)')
      for (const t of CONTRIB_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
    }
    // fresh / post-drop rebuild / idempotent no-op (IF NOT EXISTS) when already current.
    db.exec(CREATE_CREDENTIALS)
    db.exec(CREATE_OBSERVATIONS)
    db.exec(CREATE_FACTS)
    db.exec(CREATE_LINK)
    db.exec(CREATE_INDEX)
  })
  apply.immediate()
}
