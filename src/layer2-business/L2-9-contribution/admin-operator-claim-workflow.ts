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

// ── UNLINK (解除) requests: admin-seat owner OR contributor asks to sever an active approved claim;
// only ROOT may approve (→ revoke). Append-only; never touches contribution_facts. ──
export type UnlinkRole = 'admin_seat' | 'contributor'
export interface UnlinkView { request_event_id: string; approved_event_id: string; claimed_event_id: string; admin_account_id: string; contributor_account_id: string; requested_by: string; requester_role: string; reason: string | null; created_at: string }

/** An approved claim is active iff nothing supersedes it (no revoke/superseded chained on it). */
function approvedIsActive(db: Database.Database, approvedEventId: string): boolean {
  const a = db.prepare("SELECT 1 FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'approved'").get(approvedEventId)
  return !!a && !supersederOf(db, approvedEventId)
}
/** The still-pending unlink 'requested' event for an approved claim (no decision yet), or null. */
export function pendingUnlinkForApproved(db: Database.Database, approvedEventId: string): any {
  const reqs = db.prepare("SELECT * FROM admin_operator_unlink_requests WHERE approved_event_id = ? AND event_type = 'requested' ORDER BY created_at DESC, rowid DESC").all(approvedEventId) as any[]
  for (const r of reqs) {
    const decided = db.prepare('SELECT 1 FROM admin_operator_unlink_requests WHERE supersedes_request_id = ?').get(r.request_event_id)
    if (!decided) return r
  }
  return null
}

/** Either party (admin-seat owner OR contributor) requests unlink of an ACTIVE approved claim. The
 *  caller MUST have already passed the passkey gate; humanAuthRef records which token was consumed. */
export function requestUnlink(db: Database.Database, input: { approvedEventId: string; requesterId: string; reason?: string; humanAuthRef?: string }):
  { ok: true; requestEventId: string; requesterRole: UnlinkRole; adminAccountId: string; contributorAccountId: string } | WorkflowError {
  const { approvedEventId, requesterId, reason, humanAuthRef } = input
  const ap = db.prepare("SELECT event_id, admin_account_id, contributor_account_id, supersedes_event_id FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'approved'").get(approvedEventId) as any
  if (!ap) return err('approved_not_found', 'no such approved claim')
  if (!approvedIsActive(db, approvedEventId)) return err('bad_state', 'claim is not active (already revoked/superseded)')
  let role: UnlinkRole
  if (requesterId === ap.admin_account_id) role = 'admin_seat'
  else if (requesterId === ap.contributor_account_id) role = 'contributor'
  else return err('not_party', 'only the admin-seat owner or the contributor may request unlink')
  if (pendingUnlinkForApproved(db, approvedEventId)) return err('already_pending', 'an unlink request is already pending for this claim')
  const id = generateId('aour')
  db.prepare(
    `INSERT INTO admin_operator_unlink_requests (request_event_id, event_type, approved_event_id, claimed_event_id, admin_account_id, contributor_account_id, requested_by, requester_role, reason, human_auth_ref, immutable)
     VALUES (?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, approvedEventId, ap.supersedes_event_id, ap.admin_account_id, ap.contributor_account_id, requesterId, role, reason ?? null, humanAuthRef ?? null)
  return { ok: true, requestEventId: id, requesterRole: role, adminAccountId: ap.admin_account_id, contributorAccountId: ap.contributor_account_id }
}

/** A root deciding an unlink is "self-or-related" when they are themselves the admin-seat owner, the
 *  contributor, or the party who filed the request. The same posture as approveClaim's self-link: a
 *  root MAY decide it, but MUST mark the conflict honestly (never label a related decision as
 *  independent_governance). Returns the marking to persist, or a WorkflowError on dishonest/missing marking. */
function resolveUnlinkMarking(
  req: any,
  approverId: string,
  approvalKind: string | undefined,
  conflictDisclosure: string | undefined,
): { approvalKind: string; conflictDisclosure: string } | WorkflowError {
  const selfOrRelated = approverId === req.admin_account_id || approverId === req.contributor_account_id || approverId === req.requested_by
  let kind = approvalKind
  let disc = conflictDisclosure
  if (selfOrRelated) {
    if (kind !== 'founder_bootstrap_override' && kind !== 'root_approval') {
      return err('self_related_requires_marking', 'a self-or-related unlink decision must be marked founder_bootstrap_override or root_approval')
    }
    if (disc !== 'self_or_related') {
      return err('self_related_requires_disclosure', 'a self-or-related unlink decision must disclose conflict_disclosure=self_or_related')
    }
  } else {
    // independent decision: default to the honest baseline when caller omits the marking
    kind = kind ?? 'root_approval'
    disc = disc ?? 'none'
  }
  if (kind === 'independent_governance' && disc === 'self_or_related') {
    return err('dishonest_marking', 'self_or_related conflict cannot be labelled independent_governance')
  }
  return { approvalKind: kind!, conflictDisclosure: disc! }
}

/** ROOT approves an unlink request → atomically records the decision AND revokes the claim.
 *  When root is self-or-related to the relationship/request, approvalKind + conflictDisclosure are
 *  required and recorded on the decision event (governance honesty, mirrors approveClaim). */
export function approveUnlink(db: Database.Database, input: { requestEventId: string; approverId: string; approvalKind?: string; conflictDisclosure?: string }):
  { ok: true; decisionEventId: string; approvedEventId: string; claimedEventId: string; adminAccountId: string; contributorAccountId: string; approvalKind: string; conflictDisclosure: string } | WorkflowError {
  const { requestEventId, approverId } = input
  if (!isRoot(db, approverId)) return err('not_root', 'only a root admin may approve an unlink request')
  const req = db.prepare("SELECT * FROM admin_operator_unlink_requests WHERE request_event_id = ? AND event_type = 'requested'").get(requestEventId) as any
  if (!req) return err('request_not_found', 'no such unlink request')
  if (db.prepare('SELECT 1 FROM admin_operator_unlink_requests WHERE supersedes_request_id = ?').get(requestEventId)) return err('bad_state', 'this unlink request is already decided')
  if (!approvedIsActive(db, req.approved_event_id)) return err('bad_state', 'the claim is no longer active')
  const marking = resolveUnlinkMarking(req, approverId, input.approvalKind, input.conflictDisclosure)
  if (!(marking as any).approvalKind) return marking as WorkflowError
  const { approvalKind, conflictDisclosure } = marking as { approvalKind: string; conflictDisclosure: string }
  const run = db.transaction(() => {
    const decId = generateId('aour')
    db.prepare(
      `INSERT INTO admin_operator_unlink_requests (request_event_id, event_type, approved_event_id, claimed_event_id, admin_account_id, contributor_account_id, decided_by, approval_kind, conflict_disclosure, supersedes_request_id, immutable)
       VALUES (?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(decId, req.approved_event_id, req.claimed_event_id, req.admin_account_id, req.contributor_account_id, approverId, approvalKind, conflictDisclosure, requestEventId)
    const rev = revokeApprovedClaim(db, { approvedEventId: req.approved_event_id, revokerId: approverId, rationale: 'unlink request approved by root' })
    if (!(rev as any).ok) throw new Error('revoke failed: ' + (rev as any).code)
    return decId
  })
  return { ok: true, decisionEventId: run(), approvedEventId: req.approved_event_id, claimedEventId: req.claimed_event_id, adminAccountId: req.admin_account_id, contributorAccountId: req.contributor_account_id, approvalKind, conflictDisclosure }
}

/** ROOT rejects an unlink request → records the decision; the claim stays active. Same self-or-related
 *  marking discipline as approveUnlink. */
export function rejectUnlink(db: Database.Database, input: { requestEventId: string; approverId: string; approvalKind?: string; conflictDisclosure?: string }):
  { ok: true; decisionEventId: string; claimedEventId: string; adminAccountId: string; contributorAccountId: string; approvalKind: string; conflictDisclosure: string } | WorkflowError {
  const { requestEventId, approverId } = input
  if (!isRoot(db, approverId)) return err('not_root', 'only a root admin may reject an unlink request')
  const req = db.prepare("SELECT * FROM admin_operator_unlink_requests WHERE request_event_id = ? AND event_type = 'requested'").get(requestEventId) as any
  if (!req) return err('request_not_found', 'no such unlink request')
  if (db.prepare('SELECT 1 FROM admin_operator_unlink_requests WHERE supersedes_request_id = ?').get(requestEventId)) return err('bad_state', 'this unlink request is already decided')
  const marking = resolveUnlinkMarking(req, approverId, input.approvalKind, input.conflictDisclosure)
  if (!(marking as any).approvalKind) return marking as WorkflowError
  const { approvalKind, conflictDisclosure } = marking as { approvalKind: string; conflictDisclosure: string }
  const decId = generateId('aour')
  db.prepare(
    `INSERT INTO admin_operator_unlink_requests (request_event_id, event_type, approved_event_id, claimed_event_id, admin_account_id, contributor_account_id, decided_by, approval_kind, conflict_disclosure, supersedes_request_id, immutable)
     VALUES (?, 'rejected', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(decId, req.approved_event_id, req.claimed_event_id, req.admin_account_id, req.contributor_account_id, approverId, approvalKind, conflictDisclosure, requestEventId)
  return { ok: true, decisionEventId: decId, claimedEventId: req.claimed_event_id, adminAccountId: req.admin_account_id, contributorAccountId: req.contributor_account_id, approvalKind, conflictDisclosure }
}

// ── GOVERNANCE-MARKING CORRECTION (append-only): fix a mis-marked self/related approval's disclosure
// WITHOUT touching the original approved event (no UPDATE, no backdate, no change to effective interval).
// A root appends a correction referencing the approved event; the resolver overlays it at read time. ──
export function correctClaimMarking(db: Database.Database, input: { approvedEventId: string; correctorId: string; approvalKind: string; conflictDisclosure: string; correctionReason: string }):
  { ok: true; correctionEventId: string; approvedEventId: string } | WorkflowError {
  const { approvedEventId, correctorId, approvalKind, conflictDisclosure, correctionReason } = input
  if (!isRoot(db, correctorId)) return err('not_root', 'only a root admin may correct a claim marking')
  const ap = db.prepare("SELECT event_id, admin_account_id, contributor_account_id, approved_by, approval_kind, conflict_disclosure FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'approved'").get(approvedEventId) as any
  if (!ap) return err('approved_not_found', 'no such approved claim event')
  // ONLY a self/related approval (approver was itself a party) may be corrected — a genuinely
  // independent claim has no self_or_related disclosure to make, and appending one would falsify its
  // provenance (and is append-only/irreversible). Guards a typo'd approvedEventId.
  const selfRelated = !!ap.approved_by && (ap.approved_by === ap.admin_account_id || ap.approved_by === ap.contributor_account_id)
  if (!selfRelated) return err('not_self_related', 'only self/related approvals may receive a marking correction')
  // honest marking only — a correction can NEVER (re)assert independent_governance or drop disclosure.
  if (approvalKind !== 'root_approval' && approvalKind !== 'founder_bootstrap_override') {
    return err('dishonest_marking', 'correction approval_kind must be root_approval or founder_bootstrap_override')
  }
  if (conflictDisclosure !== 'self_or_related') {
    return err('dishonest_marking', 'correction conflict_disclosure must be self_or_related')
  }
  if (!correctionReason || !correctionReason.trim()) return err('reason_required', 'correction_reason is required')
  const id = generateId('aocmc')
  db.prepare(
    `INSERT INTO admin_operator_claim_marking_corrections (correction_event_id, approved_event_id, approval_kind, conflict_disclosure, correction_reason, corrected_by_root_admin_id, immutable)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, approvedEventId, approvalKind, conflictDisclosure, correctionReason.trim(), correctorId)
  return { ok: true, correctionEventId: id, approvedEventId }
}

/** Latest append-only marking correction for an approved claim event (or null). */
export function latestMarkingCorrection(db: Database.Database, approvedEventId: string): any {
  return db.prepare(
    "SELECT * FROM admin_operator_claim_marking_corrections WHERE approved_event_id = ? ORDER BY corrected_at DESC, rowid DESC LIMIT 1",
  ).get(approvedEventId) ?? null
}

/** All claims whose CONTRIBUTOR is this user (any status) — the contributor self-view. */
export function listContributorRelationships(db: Database.Database, contributorId: string): ClaimView[] {
  const ids = db.prepare("SELECT event_id FROM admin_operator_claim_events WHERE contributor_account_id = ? AND event_type = 'claimed' ORDER BY created_at DESC").all(contributorId) as any[]
  return ids.map(r => deriveClaimState(db, r.event_id)!).filter(Boolean)
}
/** Pending unlink requests across all claims — the ROOT review queue. */
export function listPendingUnlinkRequests(db: Database.Database): UnlinkView[] {
  const reqs = db.prepare("SELECT * FROM admin_operator_unlink_requests WHERE event_type = 'requested' ORDER BY created_at DESC").all() as any[]
  return reqs.filter(r => !db.prepare('SELECT 1 FROM admin_operator_unlink_requests WHERE supersedes_request_id = ?').get(r.request_event_id))
}

// ── notifications: remind the party who must act next at every transition (clickable deep-link) ──
export type ClaimTransition = 'proposed' | 'accepted' | 'rejected_by_contributor' | 'approved' | 'rejected_by_root' | 'revoked' | 'unlink_requested' | 'unlink_approved' | 'unlink_rejected'
export interface NotifSpec { userId: string; title: string; body: string; href: string; label: string }

/** Pure: who to notify + what, for a claim transition. Self-link (admin==contributor) → deduped. */
export function claimNotificationSpecs(kind: ClaimTransition, claim: { admin_account_id: string; contributor_account_id: string }, rootIds: string[]): NotifSpec[] {
  const admin = claim.admin_account_id, contrib = claim.contributor_account_id
  const ME = '#me/operator-claims', ADMIN = '#admin/operator-claims'
  const uniq = (xs: NotifSpec[]) => { const seen = new Set<string>(); return xs.filter(s => s.userId && !seen.has(s.userId) && seen.add(s.userId)) }
  switch (kind) {
    case 'proposed':
      return [{ userId: contrib, title: '🔗 待确认的贡献归属关联', body: `管理席位 ${admin} 请求把协调贡献归属到你的账号,请确认或拒绝。`, href: ME, label: '去确认' }]
    case 'accepted':
      return uniq(rootIds.map(r => ({ userId: r, title: '🪪 操作席位关联待审批', body: `贡献人已确认来自管理席位 ${admin} 的关联,待你审批。`, href: ADMIN, label: '去审批' })))
    case 'rejected_by_contributor':
      return [{ userId: admin, title: '🔗 关联被贡献人拒绝', body: '贡献人拒绝了你发起的归属关联。', href: ME, label: '查看' }]
    case 'approved':
      return uniq([contrib, admin].map(u => ({ userId: u, title: '✅ 贡献归属关联已生效', body: `管理席位 ${admin} 的协调贡献现归属到该贡献人账号。`, href: ME, label: '查看' })))
    case 'rejected_by_root':
      return [{ userId: admin, title: '🔗 关联未通过审批', body: 'root 未通过你发起的归属关联。', href: ME, label: '查看' }]
    case 'revoked':
      return uniq([contrib, admin].map(u => ({ userId: u, title: '🪪 贡献归属关联已撤销', body: '此前的归属关联已被撤销。', href: ME, label: '查看' })))
    case 'unlink_requested':
      return uniq(rootIds.map(r => ({ userId: r, title: '🔓 贡献归属解除申请待审批', body: `有人申请解除管理席位 ${admin} 与贡献人的关联,待你审批。`, href: ADMIN, label: '去审批' })))
    case 'unlink_approved':
      return uniq([contrib, admin].map(u => ({ userId: u, title: '🔓 解除申请已通过,关联已撤销', body: `管理席位 ${admin} 与该贡献人账号的归属关联已解除。`, href: ME, label: '查看' })))
    case 'unlink_rejected':
      return uniq([contrib, admin].map(u => ({ userId: u, title: '🔒 解除申请被驳回,关联仍有效', body: `root 未通过解除申请,管理席位 ${admin} 的归属关联仍然有效。`, href: ME, label: '查看' })))
    default: return []
  }
}

/**
 * Insert the transition's notifications (best-effort; caller should try/catch so a notify failure never
 * rolls back the claim). Returns the specs emitted. Uses the existing notifications table + its `actions`
 * deep-link column so the notification is clickable straight to the right page.
 */
export function emitClaimNotifications(db: Database.Database, kind: ClaimTransition, claimedEventId: string): NotifSpec[] {
  const claim = db.prepare("SELECT admin_account_id, contributor_account_id FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'claimed'").get(claimedEventId) as any
  if (!claim) return []
  const rootIds = (db.prepare("SELECT id FROM users WHERE role = 'admin' AND admin_type = 'root'").all() as any[]).map(r => r.id as string)
  const specs = claimNotificationSpecs(kind, claim, rootIds)
  const ins = db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, actions, created_at) VALUES (?,?,?,?,?,?,datetime('now'))`)
  for (const s of specs) {
    ins.run(generateId('ntf'), s.userId, 'operator_claim', s.title, s.body, JSON.stringify([{ kind: 'navigate', href: s.href, label: s.label, style: 'primary' }]))
  }
  return specs
}

/** Resolve the claim (claimed) event id behind an approved event (for revoke notifications). */
export function claimedEventIdOfApproved(db: Database.Database, approvedEventId: string): string | null {
  const r = db.prepare("SELECT supersedes_event_id FROM admin_operator_claim_events WHERE event_id = ? AND event_type = 'approved'").get(approvedEventId) as any
  return r?.supersedes_event_id ?? null
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
