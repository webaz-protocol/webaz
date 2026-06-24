#!/usr/bin/env tsx
/**
 * Admin operator-claim GOVERNANCE-MARKING CORRECTION (append-only overlay).
 *   用法:node --import tsx scripts/test-admin-claim-marking-correction.ts
 *
 * A self/related (root/founder bootstrap) approval recorded as independent_governance / none is
 * DISHONESTLY marked. This PR lets a root append a correction (NOT update/backdate) that the resolver
 * overlays at read time. Covers: before-correction ingestion fail-closed · after-correction resolver +
 * ingestion pass · original approved event time UNCHANGED · correction append-only · non-root rejected ·
 * reason required · dishonest correction marking rejected · non-self/related claims unaffected. Writes no
 * reward/amount; the correction never changes contributor or effective interval.
 */
import Database from 'better-sqlite3'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initAdminCoordinationSchema } from '../src/layer2-business/L2-9-contribution/admin-coordination-store.js'
import { ingestAdminCoordinationFact } from '../src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.js'
import { resolveOperatorClaimAsOf } from '../src/layer2-business/L2-9-contribution/admin-coordination-resolver.js'
import { correctClaimMarking, latestMarkingCorrection } from '../src/layer2-business/L2-9-contribution/admin-operator-claim-workflow.js'
import { logAdminAction } from '../src/pwa/admin-audit.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const threw = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, admin_type TEXT, roles TEXT, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,admin_type,roles,api_key) VALUES
    ('usr_root','Root','admin','root','["admin"]','k_root'),
    ('usr_admin','Adm','admin','regional','["admin"]','k_adm'),
    ('usr_alice','Alice','buyer',NULL,'["buyer"]','k_a'),
    ('usr_bob','Bob','buyer',NULL,'["buyer"]','k_b')`).run()
  db.exec(`CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  initAdminCoordinationSchema(db)
  return db
}
const nFacts = (db: any) => (db.prepare('SELECT COUNT(*) c FROM contribution_facts').get() as any).c
const insApproval = (db: any, o: any) => db.prepare(
  `INSERT INTO admin_operator_claim_events (event_id,event_type,admin_account_id,contributor_account_id,approval_kind,approved_by,conflict_disclosure,effective_from,supersedes_event_id,rationale,immutable)
   VALUES (@event_id,@event_type,@admin_account_id,@contributor_account_id,@approval_kind,@approved_by,@conflict_disclosure,@effective_from,@supersedes_event_id,@rationale,1)`,
).run({ approval_kind: null, approved_by: null, conflict_disclosure: 'unknown', effective_from: null, supersedes_event_id: null, rationale: null, ...o })
const T0 = '2026-06-01T00:00:00Z', T1 = '2026-06-10T00:00:00Z'
const adminCtx = (o: any = {}) => ({ actorType: 'admin_account', agentMode: 'human_direct', provenance: 'human', ...o })
function auditAt(db: any, action: string, createdAt: string, o: any = {}): string {
  const id = logAdminAction(db, { adminId: o.adminId ?? 'usr_admin', action, targetType: o.targetType, targetId: o.targetId, context: o.context ?? adminCtx() })
  db.prepare('UPDATE admin_audit_log SET created_at=? WHERE id=?').run(createdAt, id)
  return id
}
// the prod-shaped mis-marked claim: seat self-approves (approved_by == admin), cross-account, marked
// independent_governance / none. DB allows it (cross-account, not a self-LINK).
function misMarkedSelfRelated(db: any, ev = 'ap_self'): string {
  insApproval(db, { event_id: ev, event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', approval_kind: 'independent_governance', approved_by: 'usr_admin', conflict_disclosure: 'none', effective_from: T0 })
  return ev
}

function main(): void {
  // ── resolver: self/related signal detected; honestly_disclosed=false before correction ──
  { const db = freshDb(); misMarkedSelfRelated(db)
    const r = resolveOperatorClaimAsOf(db, 'usr_admin', T1)
    ok('resolver flags self_related (approved_by == admin seat)', r?.self_related === true)
    ok('resolver: honestly_disclosed=false for mis-marked self/related', r?.honestly_disclosed === false && r?.corrected === false)
    ok('resolver still resolves contributor (attribution undisputed)', r?.contributor_account_id === 'usr_alice') }

  // ── ingestion FAIL-CLOSED before correction ──
  { const db = freshDb(); misMarkedSelfRelated(db)
    const audit = auditAt(db, 'operator_claim.approve', T1)
    const res = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('ingestion refuses mis-marked self/related claim → self_related_not_disclosed', res.ok === false && (res as any).reason === 'self_related_not_disclosed')
    ok('no fact written before correction', nFacts(db) === 0)
    // dry-run is ALSO blocked (gate is before the dryRun branch)
    const dry = ingestAdminCoordinationFact(db, { auditId: audit, dryRun: true })
    ok('dry-run also blocked before correction', dry.ok === false && (dry as any).reason === 'self_related_not_disclosed') }

  // ── correction (root) → resolver overlays honest marking; ingestion passes; original event UNCHANGED ──
  { const db = freshDb(); const ev = misMarkedSelfRelated(db)
    const before = db.prepare('SELECT approval_kind, conflict_disclosure, effective_from, created_at FROM admin_operator_claim_events WHERE event_id=?').get(ev) as any
    const audit = auditAt(db, 'operator_claim.approve', T1)
    const c = correctClaimMarking(db, { approvedEventId: ev, correctorId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related', correctionReason: 'founder/root bootstrap self-attribution; honest disclosure' })
    ok('root correction → ok', (c as any).ok === true && typeof (c as any).correctionEventId === 'string')
    const after = db.prepare('SELECT approval_kind, conflict_disclosure, effective_from, created_at FROM admin_operator_claim_events WHERE event_id=?').get(ev) as any
    ok('original approved event UNCHANGED (no UPDATE/backdate)', JSON.stringify(before) === JSON.stringify(after))
    const r = resolveOperatorClaimAsOf(db, 'usr_admin', T1)
    ok('resolver overlays corrected marking', r?.approval_kind === 'founder_bootstrap_override' && r?.conflict_disclosure === 'self_or_related' && r?.corrected === true)
    ok('resolver: honestly_disclosed=true after correction', r?.honestly_disclosed === true)
    ok('as-of still resolves to the same contributor (Holden-equivalent)', r?.contributor_account_id === 'usr_alice')
    const res = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('ingestion passes after correction → fact attributed to contributor', res.ok === true && (res as any).contributorAccountId === 'usr_alice' && nFacts(db) === 1)
    ok('fact occurred_at is the ORIGINAL audit time (as-of preserved)', (db.prepare('SELECT occurred_at FROM contribution_facts').get() as any).occurred_at === T1) }

  // ── correction is APPEND-ONLY ──
  { const db = freshDb(); const ev = misMarkedSelfRelated(db)
    correctClaimMarking(db, { approvedEventId: ev, correctorId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related', correctionReason: 'fix' })
    const cid = latestMarkingCorrection(db, ev).correction_event_id
    ok('correction UPDATE rejected (append-only)', threw(() => db.prepare("UPDATE admin_operator_claim_marking_corrections SET approval_kind='root_approval' WHERE correction_event_id=?").run(cid)))
    ok('correction DELETE rejected (append-only)', threw(() => db.prepare('DELETE FROM admin_operator_claim_marking_corrections WHERE correction_event_id=?').run(cid))) }

  // ── non-root CANNOT correct ──
  { const db = freshDb(); const ev = misMarkedSelfRelated(db)
    const c = correctClaimMarking(db, { approvedEventId: ev, correctorId: 'usr_admin', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related', correctionReason: 'x' })
    ok('non-root correction → not_root', (c as any).ok === false && (c as any).code === 'not_root')
    ok('non-root attempt wrote no correction', latestMarkingCorrection(db, ev) === null) }

  // ── correction_reason REQUIRED (engine + DB CHECK) ──
  { const db = freshDb(); const ev = misMarkedSelfRelated(db)
    ok('empty reason → reason_required', (correctClaimMarking(db, { approvedEventId: ev, correctorId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related', correctionReason: '   ' }) as any).code === 'reason_required')
    ok('DB CHECK rejects empty correction_reason', threw(() => db.prepare(
      "INSERT INTO admin_operator_claim_marking_corrections (correction_event_id,approved_event_id,approval_kind,conflict_disclosure,correction_reason,corrected_by_root_admin_id,immutable) VALUES ('x',?,'root_approval','self_or_related','',?,1)",
    ).run(ev, 'usr_root'))) }

  // ── dishonest correction marking STILL rejected ──
  { const db = freshDb(); const ev = misMarkedSelfRelated(db)
    ok('correction marked independent_governance → dishonest_marking', (correctClaimMarking(db, { approvedEventId: ev, correctorId: 'usr_root', approvalKind: 'independent_governance', conflictDisclosure: 'self_or_related', correctionReason: 'x' }) as any).code === 'dishonest_marking')
    ok('correction with conflict_disclosure=none → dishonest_marking', (correctClaimMarking(db, { approvedEventId: ev, correctorId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'none', correctionReason: 'x' }) as any).code === 'dishonest_marking')
    ok('DB CHECK rejects independent_governance correction row', threw(() => db.prepare(
      "INSERT INTO admin_operator_claim_marking_corrections (correction_event_id,approved_event_id,approval_kind,conflict_disclosure,correction_reason,corrected_by_root_admin_id,immutable) VALUES ('y',?,'independent_governance','self_or_related','r',?,1)",
    ).run(ev, 'usr_root')))
    ok('correction referencing a non-existent approved event → approved_not_found', (correctClaimMarking(db, { approvedEventId: 'nope', correctorId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related', correctionReason: 'x' }) as any).code === 'approved_not_found') }

  // ── REGRESSION: a genuinely INDEPENDENT cross-party claim is NOT gated (approved_by not a party) ──
  { const db = freshDb()
    insApproval(db, { event_id: 'ap_indep', event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', approval_kind: 'independent_governance', approved_by: 'usr_root', conflict_disclosure: 'none', effective_from: T0 })
    const r = resolveOperatorClaimAsOf(db, 'usr_admin', T1)
    ok('independent approval (approved_by not a party) → self_related=false', r?.self_related === false && r?.honestly_disclosed === true)
    const res = ingestAdminCoordinationFact(db, { auditId: auditAt(db, 'operator_claim.approve', T1) })
    ok('independent claim ingests normally (gate does NOT fire)', res.ok === true && nFacts(db) === 1) }

  // ── P2 fix: a genuinely INDEPENDENT approved claim CANNOT receive a marking correction ──
  { const db = freshDb()
    // approved_by = usr_root, a non-party root → NOT self/related; honest independent_governance/none.
    insApproval(db, { event_id: 'ap_indep', event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', approval_kind: 'independent_governance', approved_by: 'usr_root', conflict_disclosure: 'none', effective_from: T0 })
    const c = correctClaimMarking(db, { approvedEventId: 'ap_indep', correctorId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related', correctionReason: 'typo / wrong target' })
    ok('correcting an INDEPENDENT claim → not_self_related', (c as any).ok === false && (c as any).code === 'not_self_related')
    ok('no correction written for an independent claim', latestMarkingCorrection(db, 'ap_indep') === null)
    // and the independent claim keeps resolving + ingesting normally (gate never fired)
    const r = resolveOperatorClaimAsOf(db, 'usr_admin', T1)
    ok('independent claim still resolves honestly (untouched by failed correction)', r?.self_related === false && r?.honestly_disclosed === true && r?.approval_kind === 'independent_governance' && r?.corrected === false)
    const res = ingestAdminCoordinationFact(db, { auditId: auditAt(db, 'operator_claim.approve', T1) })
    ok('independent claim still ingests normally after a rejected correction', res.ok === true && nFacts(db) === 1) }

  if (fail === 0) {
    console.log(`\n✅ admin operator-claim marking correction: resolver flags self/related + honesty · ingestion fail-closed before correction (dry-run too) · root correction overlays honest marking, original event UNCHANGED, as-of preserved · append-only · non-root rejected · reason required · dishonest correction rejected (engine + DB) · independent claims unaffected\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin operator-claim marking correction FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
