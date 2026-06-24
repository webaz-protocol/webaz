/**
 * Admin operator-claim workflow (Phase 2). Design: docs/ADMIN-COORDINATION-CONTRIBUTION-DESIGN.md.
 *
 * The claim lifecycle that links an ADMIN SEAT (e.g. 管理员A / usr_admin_a_001) to a real CONTRIBUTOR
 * account (e.g. Holden's normal WebAZ account):
 *   propose (admin)  →  confirm/reject (contributor)  →  approve/reject (root)  →  revoke / supersede.
 *
 * This is a CLAIM workflow, NOT a reward system. It writes ONLY append-only event/confirmation rows:
 *   - admin_operator_claim_events       (Phase 1 table; reused — claimed/approved/revoked/superseded)
 *   - admin_operator_claim_confirmations (Phase 2 additive table; contributor accept/reject)
 * It NEVER writes contribution_facts, never calls the ingestion engine, and adds no economic field.
 * Events chain via Phase 1's `supersedes_event_id` (the 'claimed' event id IS the claim's identity).
 *
 * Sync (better-sqlite3) by design; routes wrap each call + logAdminAction in one db.transaction.
 *
 * Self-link honesty (admin_account_id == contributor_account_id): approval MUST be
 * founder_bootstrap_override / root_approval + self_or_related (also DB-CHECK'd), and such a self-link
 * does not require a separate contributor confirmation (you cannot meaningfully self-confirm). A
 * cross-account claim ALWAYS requires an accepted contributor confirmation before approval.
 */
import type Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'

export type ClaimStatus = 'proposed' | 'confirmed' | 'rejected_by_contributor' | 'approved' | 'rejected_by_root' | 'revoked' | 'superseded'
export interface WorkflowError { ok: false; code: string; message: string }
const err = (code: string, message: string): WorkflowError => ({ ok: false, code, message })

/* eslint-disable @typescript-eslint/no-explicit-any */
const isAdminUser = (db: Database.Database, id: string): boolean => {
  const u = db.prepare('SELECT role, roles FROM users WHERE id = ?').get(id) as any
  if (!u) return false
  if (u.role === 'admin') return true
  try { return (JSON.parse(u.roles || '[]') as string[]).includes('admin') } catch { return false }
}
const userExists = (db: Database.Database, id: string): boolean => !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)
const isRoot = (db: Database.Database, id: string): boolean => {
  const u = db.prepare('SELECT role, admin_type FROM users WHERE id = ?').get(id) as any
  return !!u && u.role === 'admin' && u.admin_type === 'root'
}

/**
 * Latest VALID contributor confirmation for a claim (or null). Defense-in-depth read-side validation:
 * a confirmation only counts if its admin/contributor match the claimed event AND decided_by is the
 * contributor — so a mismatched/forged row (however it got into the table) is IGNORED, never read as
 * 'confirmed'. (The DB also CHECK/UNIQUE/trigger-enforces this on write.)
 */
function latestConfirmation(db: Database.Database, claimed: any): any {
  return db.prepare(
    `SELECT decision, decided_by, created_at FROM admin_operator_claim_confirmations
     WHERE claimed_event_id = ? AND admin_account_id = ? AND contributor_account_id = ? AND decided_by = contributor_account_id
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(claimed.event_id, claimed.admin_account_id, claimed.contributor_account_id)
}
/** Any event that supersedes the given event id (approved/revoked/superseded chained onto it). */
function supersederOf(db: Database.Database, eventId: string): any {
  return db.prepare(
    "SELECT event_id, event_type, created_at FROM admin_operator_claim_events WHERE supersedes_event_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(eventId)
}

export interface ClaimView { status: ClaimStatus; claimed: any; confirmation: any; approved: any; terminal: any }

/** Derive the workflow status of a claim from its append-only events + confirmations. */
export function deriveClaimState(db: Database.Database, claimedEventId: string): ClaimView | null {
  const claimed = db.prepare("SELECT * FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'claimed'").get(claimedEventId) as any
  if (!claimed) return null
  const confirmation = latestConfirmation(db, claimed)
  const onClaim = supersederOf(db, claimedEventId)   // approved | revoked directly on the proposal
  if (onClaim && onClaim.event_type === 'revoked') return { status: 'rejected_by_root', claimed, confirmation, approved: null, terminal: onClaim }
  if (onClaim && onClaim.event_type === 'approved') {
    const onApproved = supersederOf(db, onClaim.event_id)   // revoked | superseded on the approval
    if (onApproved && onApproved.event_type === 'revoked') return { status: 'revoked', claimed, confirmation, approved: onClaim, terminal: onApproved }
    if (onApproved && onApproved.event_type === 'superseded') return { status: 'superseded', claimed, confirmation, approved: onClaim, terminal: onApproved }
    return { status: 'approved', claimed, confirmation, approved: onClaim, terminal: null }
  }
  if (confirmation?.decision === 'rejected') return { status: 'rejected_by_contributor', claimed, confirmation, approved: null, terminal: null }
  if (confirmation?.decision === 'accepted') return { status: 'confirmed', claimed, confirmation, approved: null, terminal: null }
  return { status: 'proposed', claimed, confirmation: null, approved: null, terminal: null }
}

/**
 * Step 1 — an admin proposes linking THEIR OWN seat to a contributor account (append-only 'claimed').
 * The seat is ALWAYS the actor (admin_account_id = actorAdminId) — a caller can NOT propose for someone
 * else's seat. (Root-delegated proposals are out of scope for Phase 2; they would need an explicit
 * targetAdminAccountId + its own approval/audit path.)
 */
export function proposeClaim(db: Database.Database, input: { actorAdminId: string; contributorAccountId: string; rationale?: string }):
  { ok: true; claimedEventId: string } | WorkflowError {
  const { actorAdminId, contributorAccountId, rationale } = input
  if (!actorAdminId || !contributorAccountId) return err('invalid_input', 'actorAdminId + contributorAccountId required')
  if (!isAdminUser(db, actorAdminId)) return err('not_admin', 'only an admin may propose a claim for their own seat')
  if (!userExists(db, contributorAccountId)) return err('contributor_not_found', 'contributor account does not exist')
  const eventId = generateId('aoce')
  db.prepare(
    `INSERT INTO admin_operator_claim_events (event_id, event_type, admin_account_id, contributor_account_id, conflict_disclosure, rationale, immutable)
     VALUES (?, 'claimed', ?, ?, ?, ?, 1)`,
  ).run(eventId, actorAdminId, contributorAccountId, actorAdminId === contributorAccountId ? 'self_or_related' : 'unknown', rationale ?? null)
  return { ok: true, claimedEventId: eventId }
}

/** Step 2 — the contributor (and only the contributor) accepts/rejects a claim pointing at them. */
export function confirmClaim(db: Database.Database, input: { claimedEventId: string; deciderId: string; decision: 'accepted' | 'rejected'; rationale?: string }):
  { ok: true; confirmationId: string } | WorkflowError {
  const { claimedEventId, deciderId, decision, rationale } = input
  if (decision !== 'accepted' && decision !== 'rejected') return err('invalid_input', "decision must be 'accepted' or 'rejected'")
  const view = deriveClaimState(db, claimedEventId)
  if (!view) return err('claim_not_found', 'no such proposed claim')
  if (view.claimed.contributor_account_id !== deciderId) return err('not_contributor', 'only the named contributor may confirm this claim')
  if (view.status !== 'proposed') return err('bad_state', `claim is '${view.status}', not awaiting contributor confirmation`)
  const confirmationId = generateId('aocc')
  db.prepare(
    `INSERT INTO admin_operator_claim_confirmations (confirmation_id, claimed_event_id, admin_account_id, contributor_account_id, decision, decided_by, rationale, immutable)
     VALUES (?,?,?,?,?,?,?,1)`,
  ).run(confirmationId, claimedEventId, view.claimed.admin_account_id, view.claimed.contributor_account_id, decision, deciderId, rationale ?? null)
  return { ok: true, confirmationId }
}

/** Step 3 — root approves a claim (append-only 'approved' superseding the proposal). Auto-supersedes any
 *  currently-approved claim on the same seat so a seat has at most one active contributor. */
export function approveClaim(db: Database.Database, input: { claimedEventId: string; approverId: string; approvalKind: string; conflictDisclosure: string; rationale?: string }):
  { ok: true; approvedEventId: string } | WorkflowError {
  const { claimedEventId, approverId, approvalKind, conflictDisclosure, rationale } = input
  if (!isRoot(db, approverId)) return err('not_root', 'only a root admin may approve operator claims')
  const view = deriveClaimState(db, claimedEventId)
  if (!view) return err('claim_not_found', 'no such proposed claim')
  if (view.status !== 'proposed' && view.status !== 'confirmed') return err('bad_state', `claim is '${view.status}', not approvable`)
  if (view.confirmation?.decision === 'rejected') return err('contributor_rejected', 'contributor rejected this claim')

  const selfLink = view.claimed.admin_account_id === view.claimed.contributor_account_id
  if (selfLink) {
    if (approvalKind !== 'founder_bootstrap_override' && approvalKind !== 'root_approval') return err('self_link_requires_marking', 'a self-link must be founder_bootstrap_override or root_approval')
    if (conflictDisclosure !== 'self_or_related') return err('self_link_requires_disclosure', 'a self-link must disclose conflict_disclosure=self_or_related')
  } else {
    // cross-account claim: contributor MUST have accepted before root can approve
    if (view.status !== 'confirmed') return err('not_confirmed', 'contributor has not accepted this claim yet')
  }
  if (approvalKind === 'independent_governance' && conflictDisclosure === 'self_or_related') {
    return err('dishonest_marking', 'self_or_related conflict cannot be labelled independent_governance')
  }

  const tx = db.transaction(() => {
    // supersede any active approved claim on this seat (append-only 'superseded' marker)
    const activeApproved = db.prepare(
      `SELECT e.event_id, e.contributor_account_id FROM admin_operator_claim_events e
       WHERE e.admin_account_id = ? AND e.event_type = 'approved'
         AND NOT EXISTS (SELECT 1 FROM admin_operator_claim_events s WHERE s.supersedes_event_id = e.event_id)`,
    ).all(view.claimed.admin_account_id) as any[]
    for (const a of activeApproved) {
      // the 'superseded' marker records the OLD approval's contributor (history must not be rewritten)
      db.prepare(
        `INSERT INTO admin_operator_claim_events (event_id, event_type, admin_account_id, contributor_account_id, conflict_disclosure, effective_from, supersedes_event_id, rationale, immutable)
         VALUES (?, 'superseded', ?, ?, 'unknown', datetime('now'), ?, 'superseded by a newer approved claim', 1)`,
      ).run(generateId('aoce'), view.claimed.admin_account_id, a.contributor_account_id, a.event_id)
    }
    const approvedEventId = generateId('aoce')
    db.prepare(
      `INSERT INTO admin_operator_claim_events (event_id, event_type, admin_account_id, contributor_account_id, approval_kind, approved_by, conflict_disclosure, effective_from, supersedes_event_id, rationale, immutable)
       VALUES (?, 'approved', ?, ?, ?, ?, ?, datetime('now'), ?, ?, 1)`,
    ).run(approvedEventId, view.claimed.admin_account_id, view.claimed.contributor_account_id, approvalKind, approverId, conflictDisclosure, claimedEventId, rationale ?? null)
    return approvedEventId
  })
  return { ok: true, approvedEventId: tx() }
}

/** Root rejects a still-proposed/confirmed claim (terminal 'revoked' on the proposal). */
export function rejectClaim(db: Database.Database, input: { claimedEventId: string; approverId: string; rationale?: string }):
  { ok: true; revokedEventId: string } | WorkflowError {
  const { claimedEventId, approverId, rationale } = input
  if (!isRoot(db, approverId)) return err('not_root', 'only a root admin may reject operator claims')
  const view = deriveClaimState(db, claimedEventId)
  if (!view) return err('claim_not_found', 'no such proposed claim')
  if (view.status !== 'proposed' && view.status !== 'confirmed' && view.status !== 'rejected_by_contributor') return err('bad_state', `claim is '${view.status}', not rejectable`)
  const revokedEventId = generateId('aoce')
  db.prepare(
    `INSERT INTO admin_operator_claim_events (event_id, event_type, admin_account_id, contributor_account_id, approved_by, conflict_disclosure, effective_from, supersedes_event_id, rationale, immutable)
     VALUES (?, 'revoked', ?, ?, ?, 'unknown', datetime('now'), ?, ?, 1)`,
  ).run(revokedEventId, view.claimed.admin_account_id, view.claimed.contributor_account_id, approverId, claimedEventId, rationale ?? 'rejected by root')
  return { ok: true, revokedEventId }
}

/** Root revokes an APPROVED (active) claim (append-only 'revoked' on the approved event). */
export function revokeApprovedClaim(db: Database.Database, input: { approvedEventId: string; revokerId: string; rationale?: string }):
  { ok: true; revokedEventId: string } | WorkflowError {
  const { approvedEventId, revokerId, rationale } = input
  if (!isRoot(db, revokerId)) return err('not_root', 'only a root admin may revoke operator claims')
  const approved = db.prepare("SELECT * FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'approved'").get(approvedEventId) as any
  if (!approved) return err('approved_not_found', 'no such approved claim')
  if (supersederOf(db, approvedEventId)) return err('bad_state', 'this approved claim is already revoked/superseded')
  const revokedEventId = generateId('aoce')
  db.prepare(
    `INSERT INTO admin_operator_claim_events (event_id, event_type, admin_account_id, contributor_account_id, approved_by, conflict_disclosure, effective_from, supersedes_event_id, rationale, immutable)
     VALUES (?, 'revoked', ?, ?, ?, 'unknown', datetime('now'), ?, ?, 1)`,
  ).run(revokedEventId, approved.admin_account_id, approved.contributor_account_id, revokerId, approvedEventId, rationale ?? 'revoked by root')
  return { ok: true, revokedEventId }
}

// ── read helpers (route surfaces) ──
export function listClaimsForSeat(db: Database.Database, adminAccountId: string): ClaimView[] {
  const ids = db.prepare("SELECT event_id FROM admin_operator_claim_events WHERE admin_account_id = ? AND event_type = 'claimed' ORDER BY created_at DESC").all(adminAccountId) as any[]
  return ids.map(r => deriveClaimState(db, r.event_id)!).filter(Boolean)
}
export function listPendingConfirmationsForContributor(db: Database.Database, contributorId: string): ClaimView[] {
  const ids = db.prepare("SELECT event_id FROM admin_operator_claim_events WHERE contributor_account_id = ? AND event_type = 'claimed' ORDER BY created_at DESC").all(contributorId) as any[]
  return ids.map(r => deriveClaimState(db, r.event_id)!).filter(v => v && v.status === 'proposed')
}
export function listAllClaims(db: Database.Database, statusFilter?: ClaimStatus): ClaimView[] {
  const ids = db.prepare("SELECT event_id FROM admin_operator_claim_events WHERE event_type = 'claimed' ORDER BY created_at DESC").all() as any[]
  const all = ids.map(r => deriveClaimState(db, r.event_id)!).filter(Boolean)
  return statusFilter ? all.filter(v => v.status === statusFilter) : all
}
