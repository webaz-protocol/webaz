/**
 * PR 4a — GitHub identity → WebAZ account binding store (SCHEMA). #300 DB-integrity follow-up.
 *
 * Two tables (design + threat model: docs/IDENTITY-CLAIM-DESIGN.md):
 *   - `identity_binding_events`  — append-only, immutable audit log (the source of truth).
 *   - `identity_bindings_active` — the current-state projection (a derived cache; mutable BY DESIGN:
 *                                  `bound`→INSERT, `revoked`→DELETE). Its PK hard-enforces the
 *                                  single-active-binding invariant (threat T3 — no double-bind).
 *
 * #300 DB-integrity hardening (was code-only before):
 *   - req1 — the event log is made IMMUTABLE BY THE DB: BEFORE UPDATE/DELETE triggers RAISE(ABORT)
 *     (SQLite); the PG generator emits an equivalent RAISE EXCEPTION trigger guard. The `immutable=1`
 *     CHECK only blocked flipping that one column; the triggers block ALL row mutation/removal.
 *   - req2 — the projection can no longer disagree with the event it points at: a composite FK
 *     (bound_event_id, ref_event_type, github_actor_id, account_id, visibility) → events(event_id,
 *     event_type, github_actor_id, account_id, visibility), with `ref_event_type` pinned to 'bound'
 *     by CHECK, forces the referenced event to be a `bound` event whose actor/account/visibility match.
 *
 * Migration atomicity (mirrors github-credential-store): the WHOLE step — full-structure detection,
 * empty-table check, DROP and rebuild — runs in ONE synchronous `.immediate()` transaction; an
 * old/partial shape is recreated ONLY if empty (else fail-closed, never drop data); any error rolls
 * the whole step back. The contribution layer has no trigger surface yet → empty pre-launch.
 *
 * NB: the SQL strings carry NO inline `--` comments (gen-pg-schema strips them → trailing whitespace).
 * FK enforcement relies on the connection's `PRAGMA foreign_keys = ON` (set in schema.ts).
 */
import type Database from 'better-sqlite3'

const IDENTITY_TABLES = ['identity_bindings_active', 'identity_binding_events'] as const   // child-first for DROP

const CREATE_EVENTS = `
  CREATE TABLE IF NOT EXISTS identity_binding_events (
    event_id             TEXT PRIMARY KEY,
    event_type           TEXT NOT NULL CHECK (event_type IN ('bound','revoked')),
    github_actor_id      TEXT NOT NULL,
    account_id           TEXT NOT NULL REFERENCES users(id),
    visibility           TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    proof_method         TEXT NOT NULL CHECK (proof_method IN ('github_publication_challenge','admin_manual')),
    proof_ref            TEXT,
    supersedes_event_id  TEXT REFERENCES identity_binding_events(event_id),
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    immutable            INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
    UNIQUE (event_id, event_type, github_actor_id, account_id, visibility)
  )
`
const CREATE_ACTIVE = `
  CREATE TABLE IF NOT EXISTS identity_bindings_active (
    github_actor_id      TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL REFERENCES users(id),
    visibility           TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    bound_event_id       TEXT NOT NULL,
    ref_event_type       TEXT NOT NULL DEFAULT 'bound' CHECK (ref_event_type = 'bound'),
    bound_at             TEXT NOT NULL,
    FOREIGN KEY (bound_event_id, ref_event_type, github_actor_id, account_id, visibility)
      REFERENCES identity_binding_events(event_id, event_type, github_actor_id, account_id, visibility)
  )
`
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_ibe_github_actor_id ON identity_binding_events(github_actor_id)`
// req1: DB-level immutability of the event log (SQLite). The PG generator emits the equivalent guard.
const TRIGGER_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_ibe_no_update BEFORE UPDATE ON identity_binding_events BEGIN SELECT RAISE(ABORT, 'identity_binding_events is append-only (UPDATE forbidden)'); END`
const TRIGGER_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_ibe_no_delete BEFORE DELETE ON identity_binding_events BEGIN SELECT RAISE(ABORT, 'identity_binding_events is append-only (DELETE forbidden)'); END`

/* eslint-disable @typescript-eslint/no-explicit-any */
const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined
const triggerExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?`).get(name) !== undefined
const hasColumn = (db: Database.Database, table: string, col: string): boolean =>
  db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col) !== undefined
function hasUniqueOnCols(db: Database.Database, table: string, cols: string[]): boolean {
  for (const idx of db.prepare(`SELECT * FROM pragma_index_list('${table}')`).all() as any[]) {
    if (idx.unique !== 1) continue
    const onCols = (db.prepare(`SELECT name FROM pragma_index_info('${idx.name}') ORDER BY seqno`).all() as any[]).map(r => r.name)
    if (onCols.length === cols.length && onCols.every((c, i) => c === cols[i])) return true
  }
  return false
}
/**
 * The req2 composite FK must REALLY exist (not just the ref_event_type column): a half-migrated
 * `active` with the column but no FK would otherwise be misjudged as current and let mismatched
 * projections through (Codex). Verify a FK on identity_bindings_active maps EXACTLY
 * (bound_event_id, ref_event_type, github_actor_id, account_id, visibility) →
 * identity_binding_events(event_id, event_type, github_actor_id, account_id, visibility).
 */
function activeHasCompositeFk(db: Database.Database): boolean {
  const wantFrom = ['bound_event_id', 'ref_event_type', 'github_actor_id', 'account_id', 'visibility']
  const wantTo = ['event_id', 'event_type', 'github_actor_id', 'account_id', 'visibility']
  const byId = new Map<number, any[]>()
  for (const r of db.prepare(`SELECT * FROM pragma_foreign_key_list('identity_bindings_active')`).all() as any[]) {
    const g = byId.get(r.id); if (g) g.push(r); else byId.set(r.id, [r])
  }
  for (const rows of byId.values()) {
    if (rows[0].table !== 'identity_binding_events') continue
    const sorted = [...rows].sort((a, b) => a.seq - b.seq)
    const from = sorted.map(r => r.from), to = sorted.map(r => r.to)
    if (from.length === wantFrom.length && from.every((c, i) => c === wantFrom[i]) && to.every((c, i) => c === wantTo[i])) return true
  }
  return false
}
/** Full-structure check: both tables + req2 composite-UNIQUE + projection column + composite FK + req1 triggers. */
function isCurrentShape(db: Database.Database): boolean {
  return IDENTITY_TABLES.every(t => tableExists(db, t))
    && hasColumn(db, 'identity_bindings_active', 'ref_event_type')
    && hasUniqueOnCols(db, 'identity_binding_events', ['event_id', 'event_type', 'github_actor_id', 'account_id', 'visibility'])
    && activeHasCompositeFk(db)
    && triggerExists(db, 'trg_ibe_no_update')
    && triggerExists(db, 'trg_ibe_no_delete')
}

export function initIdentityBindingSchema(db: Database.Database): void {
  const apply = db.transaction(() => {
    const present = IDENTITY_TABLES.filter(t => tableExists(db, t))
    if (present.length > 0 && !isCurrentShape(db)) {
      const total = present.reduce((n, t) => n + (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c, 0)
      if (total !== 0) throw new Error('identity binding store is old/partial shape but NOT empty — manual migration required (refusing to drop data)')
      for (const t of IDENTITY_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)   // child-first; events' triggers drop with it
    }
    db.exec(CREATE_EVENTS)
    db.exec(CREATE_ACTIVE)
    db.exec(CREATE_INDEX)
    db.exec(TRIGGER_NO_UPDATE)
    db.exec(TRIGGER_NO_DELETE)
  })
  apply.immediate()
}
