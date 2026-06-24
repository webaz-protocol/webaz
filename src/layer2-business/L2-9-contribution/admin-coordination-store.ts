/**
 * Admin / Agent coordination-contribution — SCHEMA + action allowlist (Phase 1).
 * Design + threat model: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md.
 *
 * Three APPEND-ONLY / additive tables (no change to any existing table):
 *   - `admin_operator_claim_events`     — who a non-root admin SEAT is attributed to (append-only log).
 *   - `agent_execution_mandate_events`  — an agent's authorization/accountability grant (append-only).
 *   - `admin_coordination_fact_sources` — evidence link: a contribution_fact ← the admin_audit_log row
 *                                         it was ingested from (carries visibility + redaction).
 *
 * NB: coordination facts themselves live in the EXISTING RFC-017 `contribution_facts` table (single
 * ledger — see github-credential-store.ts). This module adds NO second fact ledger.
 *
 * The two event logs are made IMMUTABLE BY THE DB (BEFORE UPDATE/DELETE → RAISE(ABORT)); attribution
 * and fraud handling are append-only by design. Migration mirrors the sibling stores: detect + empty
 * check + DROP + rebuild inside ONE .immediate() transaction; an old/partial shape is recreated ONLY
 * if empty (else fail closed, never drop data).
 *
 * NB: the SQL strings carry NO inline `--` comments (gen-pg-schema strips them → trailing whitespace).
 * FK enforcement relies on the connection's `PRAGMA foreign_keys = ON` (set in schema.ts). This init
 * REFERENCES three pre-existing tables — `users`, `contribution_facts` (github credential store) and
 * `admin_audit_log` — so it MUST run AFTER all three exist (wired late in server.ts, after the
 * admin_audit_log block).
 *
 * Integrity the DB enforces (not just the engine): real-user FKs on every account column; an `approved`
 * operator claim MUST carry approval_kind + approved_by + an honest conflict_disclosure, and a SELF-LINK
 * (admin == contributor) MUST be root_approval / founder_bootstrap_override + self_or_related (a
 * self-link can NEVER be labelled independent_governance); a `granted` mandate MUST name a cost bearer +
 * approver and a non-empty allowed_actions; both event logs and the evidence link are append-only
 * (BEFORE UPDATE/DELETE → RAISE(ABORT)).
 */
import type Database from 'better-sqlite3'

const COORD_TABLES = ['admin_coordination_fact_sources', 'admin_operator_claim_confirmations', 'admin_operator_claim_events', 'agent_execution_mandate_events'] as const

const CREATE_OPERATOR_CLAIM_EVENTS = `
  CREATE TABLE IF NOT EXISTS admin_operator_claim_events (
    event_id                TEXT PRIMARY KEY,
    event_type              TEXT NOT NULL CHECK (event_type IN ('claimed','approved','revoked','superseded')),
    admin_account_id        TEXT NOT NULL REFERENCES users(id),
    contributor_account_id  TEXT NOT NULL REFERENCES users(id),
    approval_kind           TEXT CHECK (approval_kind IS NULL OR approval_kind IN ('independent_governance','root_approval','founder_bootstrap_override')),
    approved_by             TEXT REFERENCES users(id),
    conflict_disclosure     TEXT NOT NULL DEFAULT 'unknown' CHECK (conflict_disclosure IN ('none','self_or_related','unknown')),
    effective_from          TEXT,
    effective_to            TEXT,
    rationale               TEXT,
    supersedes_event_id     TEXT REFERENCES admin_operator_claim_events(event_id),
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    immutable               INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
    CHECK (event_type <> 'approved' OR (approval_kind IS NOT NULL AND approved_by IS NOT NULL AND conflict_disclosure IN ('none','self_or_related') AND (admin_account_id <> contributor_account_id OR (approval_kind IN ('root_approval','founder_bootstrap_override') AND conflict_disclosure = 'self_or_related'))))
  )
`
const CREATE_MANDATE_EVENTS = `
  CREATE TABLE IF NOT EXISTS agent_execution_mandate_events (
    event_id                      TEXT PRIMARY KEY,
    event_type                    TEXT NOT NULL CHECK (event_type IN ('granted','revoked','superseded')),
    mandate_id                    TEXT NOT NULL,
    owner_contributor_account_id  TEXT NOT NULL REFERENCES users(id),
    agent_ref                     TEXT NOT NULL,
    passport_ref                  TEXT,
    scope                         TEXT,
    allowed_actions               TEXT NOT NULL DEFAULT '[]',
    risk_limit                    TEXT,
    cost_bearer_account_id        TEXT REFERENCES users(id),
    human_confirmation_points     TEXT NOT NULL DEFAULT '[]',
    effective_from                TEXT,
    expires_at                    TEXT,
    revoked_at                    TEXT,
    value_state                   TEXT NOT NULL DEFAULT 'uncommitted' CHECK (value_state = 'uncommitted'),
    created_by                    TEXT REFERENCES users(id),
    approved_by                   TEXT REFERENCES users(id),
    rationale                     TEXT,
    supersedes_event_id           TEXT REFERENCES agent_execution_mandate_events(event_id),
    created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
    immutable                     INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
    CHECK (event_type <> 'granted' OR (cost_bearer_account_id IS NOT NULL AND approved_by IS NOT NULL AND allowed_actions <> '[]' AND allowed_actions <> ''))
  )
`
const CREATE_CLAIM_CONFIRMATIONS = `
  CREATE TABLE IF NOT EXISTS admin_operator_claim_confirmations (
    confirmation_id         TEXT PRIMARY KEY,
    claimed_event_id        TEXT NOT NULL REFERENCES admin_operator_claim_events(event_id),
    admin_account_id        TEXT NOT NULL REFERENCES users(id),
    contributor_account_id  TEXT NOT NULL REFERENCES users(id),
    decision                TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
    decided_by              TEXT NOT NULL REFERENCES users(id),
    rationale               TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    immutable               INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
    CHECK (decided_by = contributor_account_id),
    UNIQUE (claimed_event_id)
  )
`
const CREATE_FACT_SOURCES = `
  CREATE TABLE IF NOT EXISTS admin_coordination_fact_sources (
    fact_id              TEXT PRIMARY KEY REFERENCES contribution_facts(fact_id),
    admin_audit_log_id   TEXT NOT NULL UNIQUE REFERENCES admin_audit_log(id),
    source_type          TEXT NOT NULL,
    source_id            TEXT,
    visibility           TEXT NOT NULL DEFAULT 'governance_only' CHECK (visibility IN ('private','governance_only','public')),
    redaction_summary    TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  )
`
const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_aoce_admin ON admin_operator_claim_events(admin_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aoce_supersedes ON admin_operator_claim_events(supersedes_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aeme_agent ON agent_execution_mandate_events(agent_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_aocc_claimed ON admin_operator_claim_confirmations(claimed_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aocc_contributor ON admin_operator_claim_confirmations(contributor_account_id)`,
]
const TRIGGER_AOCE_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_aoce_no_update BEFORE UPDATE ON admin_operator_claim_events BEGIN SELECT RAISE(ABORT, 'admin_operator_claim_events is append-only (UPDATE forbidden)'); END`
const TRIGGER_AOCE_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_aoce_no_delete BEFORE DELETE ON admin_operator_claim_events BEGIN SELECT RAISE(ABORT, 'admin_operator_claim_events is append-only (DELETE forbidden)'); END`
const TRIGGER_AEME_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_aeme_no_update BEFORE UPDATE ON agent_execution_mandate_events BEGIN SELECT RAISE(ABORT, 'agent_execution_mandate_events is append-only (UPDATE forbidden)'); END`
const TRIGGER_AEME_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_aeme_no_delete BEFORE DELETE ON agent_execution_mandate_events BEGIN SELECT RAISE(ABORT, 'agent_execution_mandate_events is append-only (DELETE forbidden)'); END`
const TRIGGER_ACFS_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_acfs_no_update BEFORE UPDATE ON admin_coordination_fact_sources BEGIN SELECT RAISE(ABORT, 'admin_coordination_fact_sources is append-only (UPDATE forbidden)'); END`
const TRIGGER_ACFS_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_acfs_no_delete BEFORE DELETE ON admin_coordination_fact_sources BEGIN SELECT RAISE(ABORT, 'admin_coordination_fact_sources is append-only (DELETE forbidden)'); END`
// Once an admin_audit_log row is referenced as contribution evidence, it IS evidence truth — freeze it.
// The FK already blocks DELETE of a referenced row; these scoped triggers additionally block UPDATE (and
// re-block DELETE defensively). Non-referenced audit rows stay fully mutable. (gen-pg-schema emits the
// equivalent conditional plpgsql guard.)
const TRIGGER_AAL_FREEZE_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_aal_freeze_evidence_update BEFORE UPDATE ON admin_audit_log WHEN EXISTS (SELECT 1 FROM admin_coordination_fact_sources WHERE admin_audit_log_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'admin_audit_log row is referenced as contribution evidence — immutable (UPDATE forbidden)'); END`
const TRIGGER_AAL_FREEZE_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_aal_freeze_evidence_delete BEFORE DELETE ON admin_audit_log WHEN EXISTS (SELECT 1 FROM admin_coordination_fact_sources WHERE admin_audit_log_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'admin_audit_log row is referenced as contribution evidence — immutable (DELETE forbidden)'); END`
const TRIGGER_AOCC_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_aocc_no_update BEFORE UPDATE ON admin_operator_claim_confirmations BEGIN SELECT RAISE(ABORT, 'admin_operator_claim_confirmations is append-only (UPDATE forbidden)'); END`
const TRIGGER_AOCC_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_aocc_no_delete BEFORE DELETE ON admin_operator_claim_confirmations BEGIN SELECT RAISE(ABORT, 'admin_operator_claim_confirmations is append-only (DELETE forbidden)'); END`
// A confirmation MUST reference a real 'claimed' event whose admin+contributor match this row — a
// confirmation can never be attached to a mismatched/forged (admin,contributor) pair. (gen-pg-schema
// emits the equivalent conditional plpgsql BEFORE INSERT guard.)
const TRIGGER_AOCC_MATCH = `CREATE TRIGGER IF NOT EXISTS trg_aocc_match_claim BEFORE INSERT ON admin_operator_claim_confirmations WHEN NOT EXISTS (SELECT 1 FROM admin_operator_claim_events e WHERE e.event_id = NEW.claimed_event_id AND e.event_type = 'claimed' AND e.admin_account_id = NEW.admin_account_id AND e.contributor_account_id = NEW.contributor_account_id) BEGIN SELECT RAISE(ABORT, 'confirmation admin/contributor must match its claimed event'); END`

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined
}

export function initAdminCoordinationSchema(db: Database.Database): void {
  const apply = db.transaction(() => {
    db.exec(CREATE_OPERATOR_CLAIM_EVENTS)
    db.exec(CREATE_MANDATE_EVENTS)
    db.exec(CREATE_CLAIM_CONFIRMATIONS)
    db.exec(CREATE_FACT_SOURCES)
    for (const idx of CREATE_INDEXES) db.exec(idx)
    db.exec(TRIGGER_AOCE_NO_UPDATE)
    db.exec(TRIGGER_AOCE_NO_DELETE)
    db.exec(TRIGGER_AEME_NO_UPDATE)
    db.exec(TRIGGER_AEME_NO_DELETE)
    db.exec(TRIGGER_ACFS_NO_UPDATE)
    db.exec(TRIGGER_ACFS_NO_DELETE)
    db.exec(TRIGGER_AAL_FREEZE_UPDATE)
    db.exec(TRIGGER_AAL_FREEZE_DELETE)
    db.exec(TRIGGER_AOCC_NO_UPDATE)
    db.exec(TRIGGER_AOCC_NO_DELETE)
    db.exec(TRIGGER_AOCC_MATCH)
  })
  apply.immediate()
  void tableExists
  void COORD_TABLES
}

/**
 * ALLOWLIST-ONLY action catalog. Only actions listed here may be ingested as a coordination
 * contribution candidate. Each maps to the RFC-017 `contribution_facts` (source, type). ANY action not
 * present here fails closed (audit only, no fact). Login / viewing / permission-config / `root creates
 * admin` / routine risk-control are deliberately absent.
 */
export const ADMIN_COORDINATION_ACTIONS = {
  proposal_review:      { factSource: 'governance',  factType: 'governance' },
  task_review:          { factSource: 'in_protocol', factType: 'audit' },
  dispute_coordination: { factSource: 'governance',  factType: 'governance' },
  release_coordination: { factSource: 'in_protocol', factType: 'maintenance' },
  maintenance_action:   { factSource: 'in_protocol', factType: 'maintenance' },
  governance_review:    { factSource: 'governance',  factType: 'governance' },
} as const

export type CoordinationAction = keyof typeof ADMIN_COORDINATION_ACTIONS

export function coordinationActionSpec(action: string): { factSource: string; factType: string } | null {
  return Object.prototype.hasOwnProperty.call(ADMIN_COORDINATION_ACTIONS, action)
    ? ADMIN_COORDINATION_ACTIONS[action as CoordinationAction]
    : null
}
