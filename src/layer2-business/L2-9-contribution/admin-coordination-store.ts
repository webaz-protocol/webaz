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

const COORD_TABLES = ['admin_coordination_fact_sources', 'admin_operator_claim_confirmations', 'admin_operator_unlink_requests', 'admin_operator_claim_marking_corrections', 'admin_operator_claim_events', 'agent_execution_mandate_events'] as const

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
// Unlink (解除) requests — admin-seat owner OR contributor asks to sever an ACTIVE approved claim;
// only ROOT may approve, which then revokes the claim. Append-only event log: 'requested' → 'approved'
// | 'rejected' (decision supersedes the request via supersedes_request_id). NEVER touches
// contribution_facts. requester_role distinguishes who asked; human_auth_ref records the passkey gate.
const CREATE_UNLINK_REQUESTS = `
  CREATE TABLE IF NOT EXISTS admin_operator_unlink_requests (
    request_event_id        TEXT PRIMARY KEY,
    event_type              TEXT NOT NULL CHECK (event_type IN ('requested','approved','rejected')),
    approved_event_id       TEXT NOT NULL REFERENCES admin_operator_claim_events(event_id),
    claimed_event_id        TEXT NOT NULL,
    admin_account_id        TEXT NOT NULL REFERENCES users(id),
    contributor_account_id  TEXT NOT NULL REFERENCES users(id),
    requested_by            TEXT REFERENCES users(id),
    requester_role          TEXT CHECK (requester_role IS NULL OR requester_role IN ('admin_seat','contributor')),
    decided_by              TEXT REFERENCES users(id),
    approval_kind           TEXT CHECK (approval_kind IS NULL OR approval_kind IN ('independent_governance','root_approval','founder_bootstrap_override')),
    conflict_disclosure     TEXT CHECK (conflict_disclosure IS NULL OR conflict_disclosure IN ('none','self_or_related','unknown')),
    reason                  TEXT,
    human_auth_ref          TEXT,
    supersedes_request_id   TEXT REFERENCES admin_operator_unlink_requests(request_event_id),
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    immutable               INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
    CHECK (event_type <> 'requested' OR (requested_by IS NOT NULL AND requester_role IN ('admin_seat','contributor'))),
    CHECK (event_type = 'requested' OR decided_by IS NOT NULL)
  )
`
// Additive migration: add the decision-marking columns to an EXISTING unlink table (it may already
// exist from the lifecycle deploy; CREATE IF NOT EXISTS won't add columns). Guarded → idempotent.
const ALTER_UNLINK_MARKING = [
  `ALTER TABLE admin_operator_unlink_requests ADD COLUMN approval_kind TEXT`,
  `ALTER TABLE admin_operator_unlink_requests ADD COLUMN conflict_disclosure TEXT`,
]
// Append-only GOVERNANCE-MARKING CORRECTION overlay. An already-approved claim's disclosure label can be
// wrong (e.g. a founder/root self/related bootstrap recorded as 'independent_governance' / 'none'). We do
// NOT UPDATE/backdate the original approved event (that would corrupt the as-of interval); instead a root
// admin appends a correction that REFERENCES the approved event and supplies the honest marking. The
// resolver overlays the latest correction at read time. Only honest markings are storable: approval_kind
// must be root_approval|founder_bootstrap_override (NEVER independent_governance) and conflict_disclosure
// must be self_or_related; correction_reason is required. Append-only (BEFORE UPDATE/DELETE → ABORT).
const CREATE_MARKING_CORRECTIONS = `
  CREATE TABLE IF NOT EXISTS admin_operator_claim_marking_corrections (
    correction_event_id        TEXT PRIMARY KEY,
    approved_event_id          TEXT NOT NULL REFERENCES admin_operator_claim_events(event_id),
    approval_kind              TEXT NOT NULL CHECK (approval_kind IN ('root_approval','founder_bootstrap_override')),
    conflict_disclosure        TEXT NOT NULL CHECK (conflict_disclosure IN ('self_or_related')),
    correction_reason          TEXT NOT NULL CHECK (length(trim(correction_reason)) > 0),
    corrected_by_root_admin_id TEXT NOT NULL REFERENCES users(id),
    corrected_at               TEXT NOT NULL DEFAULT (datetime('now')),
    immutable                  INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1)
  )
`
const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_aoce_admin ON admin_operator_claim_events(admin_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aoce_supersedes ON admin_operator_claim_events(supersedes_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aeme_agent ON agent_execution_mandate_events(agent_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_aocc_claimed ON admin_operator_claim_confirmations(claimed_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aocc_contributor ON admin_operator_claim_confirmations(contributor_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aour_approved ON admin_operator_unlink_requests(approved_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aour_supersedes ON admin_operator_unlink_requests(supersedes_request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_aocmc_approved ON admin_operator_claim_marking_corrections(approved_event_id)`,
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
const TRIGGER_AOUR_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_aour_no_update BEFORE UPDATE ON admin_operator_unlink_requests BEGIN SELECT RAISE(ABORT, 'admin_operator_unlink_requests is append-only (UPDATE forbidden)'); END`
const TRIGGER_AOUR_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_aour_no_delete BEFORE DELETE ON admin_operator_unlink_requests BEGIN SELECT RAISE(ABORT, 'admin_operator_unlink_requests is append-only (DELETE forbidden)'); END`
const TRIGGER_AOCMC_NO_UPDATE = `CREATE TRIGGER IF NOT EXISTS trg_aocmc_no_update BEFORE UPDATE ON admin_operator_claim_marking_corrections BEGIN SELECT RAISE(ABORT, 'admin_operator_claim_marking_corrections is append-only (UPDATE forbidden)'); END`
const TRIGGER_AOCMC_NO_DELETE = `CREATE TRIGGER IF NOT EXISTS trg_aocmc_no_delete BEFORE DELETE ON admin_operator_claim_marking_corrections BEGIN SELECT RAISE(ABORT, 'admin_operator_claim_marking_corrections is append-only (DELETE forbidden)'); END`

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined
}

export function initAdminCoordinationSchema(db: Database.Database): void {
  const apply = db.transaction(() => {
    db.exec(CREATE_OPERATOR_CLAIM_EVENTS)
    db.exec(CREATE_MANDATE_EVENTS)
    db.exec(CREATE_CLAIM_CONFIRMATIONS)
    db.exec(CREATE_FACT_SOURCES)
    db.exec(CREATE_UNLINK_REQUESTS)
    db.exec(CREATE_MARKING_CORRECTIONS)
    // Additive: backfill marking columns onto an unlink table created by an earlier deploy.
    const aourCols = new Set(
      (db.prepare(`PRAGMA table_info(admin_operator_unlink_requests)`).all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!aourCols.has('approval_kind') || !aourCols.has('conflict_disclosure')) {
      for (const stmt of ALTER_UNLINK_MARKING) {
        const col = stmt.includes('approval_kind') ? 'approval_kind' : 'conflict_disclosure'
        if (!aourCols.has(col)) db.exec(stmt)
      }
    }
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
    db.exec(TRIGGER_AOUR_NO_UPDATE)
    db.exec(TRIGGER_AOUR_NO_DELETE)
    db.exec(TRIGGER_AOCMC_NO_UPDATE)
    db.exec(TRIGGER_AOCMC_NO_DELETE)
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
  // ── REAL production audit actions (the FIRST live pipeline). These are the exact `action` strings that
  // logAdminAction writes from the operator-claim workflow routes (admin-operator-claims.ts) — the only
  // coordination/governance admin actions currently audited with a stable, explicit action name. All map
  // to (governance, governance): operating the contribution-attribution machinery IS governance work.
  // (factType ∈ RFC-017 taxonomy: code|tests|audit|maintenance|governance|usage|transaction|referral.) ──
  'operator_claim.propose':        { factSource: 'governance', factType: 'governance' },
  'operator_claim.confirm':        { factSource: 'governance', factType: 'governance' },
  'operator_claim.approve':        { factSource: 'governance', factType: 'governance' },
  'operator_claim.reject':         { factSource: 'governance', factType: 'governance' },
  'operator_claim.revoke':         { factSource: 'governance', factType: 'governance' },
  'operator_claim.unlink_request': { factSource: 'governance', factType: 'governance' },
  'operator_claim.unlink_approve': { factSource: 'governance', factType: 'governance' },
  'operator_claim.unlink_reject':  { factSource: 'governance', factType: 'governance' },
  // ── Reserved CONCEPT names (no route emits these yet → no production effect). Kept as the representative
  // catalog for build-task-quota / task-proposal / dispute / release work, to be mapped to their real
  // audited action strings (and added above) ONLY once those routes log a stable, explicit action name.
  // Until then they stay fail-closed in practice (nothing produces them). ──
  proposal_review:      { factSource: 'governance',  factType: 'governance' },
  task_review:          { factSource: 'in_protocol', factType: 'audit' },
  dispute_coordination: { factSource: 'governance',  factType: 'governance' },
  release_coordination: { factSource: 'in_protocol', factType: 'maintenance' },
  maintenance_action:   { factSource: 'in_protocol', factType: 'maintenance' },
  governance_review:    { factSource: 'governance',  factType: 'governance' },
} as const

export type CoordinationAction = keyof typeof ADMIN_COORDINATION_ACTIONS

/**
 * The LIVE production set — the only actions the bounded batch / operator CLI selects from. These are
 * the real `operator_claim.*` audit action strings emitted by routes today. The reserved CONCEPT names
 * in ADMIN_COORDINATION_ACTIONS stay ingestible by the SINGLE-row engine (an operator can target a
 * specific auditId), but they are deliberately EXCLUDED from batch live selection so the first pipeline
 * only ever scans/auto-ingests real operator-claim work. Add a concept name here only when a real route
 * begins emitting it as a stable action string.
 */
export const LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS = [
  'operator_claim.propose', 'operator_claim.confirm', 'operator_claim.approve', 'operator_claim.reject',
  'operator_claim.revoke', 'operator_claim.unlink_request', 'operator_claim.unlink_approve', 'operator_claim.unlink_reject',
] as const
// invariant: every live action MUST have a spec in the allowlist (else the batch would select a row the
// single-row engine then refuses as unknown_action). Fail LOUD at module load if they ever drift apart.
for (const a of LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS) {
  if (!Object.prototype.hasOwnProperty.call(ADMIN_COORDINATION_ACTIONS, a)) {
    throw new Error(`LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS contains '${a}' with no ADMIN_COORDINATION_ACTIONS spec`)
  }
}

export function coordinationActionSpec(action: string): { factSource: string; factType: string } | null {
  return Object.prototype.hasOwnProperty.call(ADMIN_COORDINATION_ACTIONS, action)
    ? ADMIN_COORDINATION_ACTIONS[action as CoordinationAction]
    : null
}
