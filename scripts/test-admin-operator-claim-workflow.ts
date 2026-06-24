#!/usr/bin/env tsx
/**
 * Admin operator-claim workflow (Phase 2) — propose → confirm → approve → revoke/supersede.
 *   用法:npm run test:admin-operator-claim-workflow
 *
 * Fresh in-memory SQLite (foreign_keys=ON) + users + contribution_facts (github store, to prove NONE are
 * written) + admin_audit_log + admin-coordination schema (incl. the Phase-2 confirmations table).
 *
 * Covers: admin proposes; non-admin cannot; only the named contributor confirms; others cannot; root
 * approves a confirmed claim; root cannot approve an unconfirmed cross-account claim; self-link needs
 * founder_bootstrap_override/root_approval + self_or_related; self-link as independent_governance is
 * rejected; revoke/supersede are append-only (no UPDATE/DELETE); resolveOperatorClaimAsOf resolves an
 * approved claim and returns null with none; and NO contribution_facts are produced.
 */
import Database from 'better-sqlite3'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initAdminCoordinationSchema } from '../src/layer2-business/L2-9-contribution/admin-coordination-store.js'
import { proposeClaim, confirmClaim, approveClaim, rejectClaim, revokeApprovedClaim, deriveClaimState } from '../src/layer2-business/L2-9-contribution/admin-operator-claim-workflow.js'
import { resolveOperatorClaimAsOf } from '../src/layer2-business/L2-9-contribution/admin-coordination-resolver.js'

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
    ('usr_regional','Reg','admin','regional','["admin"]','k_reg'),
    ('usr_holden','Holden','buyer',NULL,'["buyer"]','k_h'),
    ('usr_eve','Eve','buyer',NULL,'["buyer"]','k_e')`).run()
  db.exec(`CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  initGithubCredentialStoreSchema(db)   // contribution_facts — must stay empty
  initAdminCoordinationSchema(db)
  return db
}
const nFacts = (db: any) => (db.prepare('SELECT COUNT(*) c FROM contribution_facts').get() as any).c

async function main(): Promise<void> {
  // ── propose: admin yes, non-admin no, unknown contributor no ──
  { const db = freshDb()
    const r = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden', rationale: 'link seat' })
    ok('admin can propose a pending claim', (r as any).ok === true && deriveClaimState(db, (r as any).claimedEventId)!.status === 'proposed')
    ok('non-admin CANNOT propose', (proposeClaim(db, { actorAdminId: 'usr_holden', contributorAccountId: 'usr_eve' }) as any).code === 'not_admin')
    ok('propose to unknown contributor refused', (proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_ghost' }) as any).code === 'contributor_not_found') }

  // ── confirm: only the named contributor, others cannot ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    ok('a different user CANNOT confirm', (confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_eve', decision: 'accepted' }) as any).code === 'not_contributor')
    const ok1 = confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'accepted' })
    ok('the named contributor CAN accept', (ok1 as any).ok === true && deriveClaimState(db, c.claimedEventId)!.status === 'confirmed')
    ok('confirming again (already decided) refused', (confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'rejected' }) as any).code === 'bad_state') }

  // ── root approves a CONFIRMED cross-account claim; cannot approve an UNCONFIRMED one ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    ok('root CANNOT approve before contributor confirms (cross-account)',
      (approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' }) as any).code === 'not_confirmed')
    confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'accepted' })
    ok('non-root CANNOT approve', (approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_regional', approvalKind: 'root_approval', conflictDisclosure: 'none' }) as any).code === 'not_root')
    const a = approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' })
    ok('root approves a confirmed claim', (a as any).ok === true && deriveClaimState(db, c.claimedEventId)!.status === 'approved')
    // resolver: as-of now resolves to the contributor
    const res = resolveOperatorClaimAsOf(db, 'usr_regional', '2999-01-01T00:00:00Z')
    ok('resolveOperatorClaimAsOf resolves the approved claim → contributor', res?.contributor_account_id === 'usr_holden')
    ok('NO contribution_facts produced by the workflow', nFacts(db) === 0) }

  // ── contributor rejection blocks approval ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'rejected' })
    ok('contributor-rejected claim → status rejected_by_contributor', deriveClaimState(db, c.claimedEventId)!.status === 'rejected_by_contributor')
    ok('root cannot approve a contributor-rejected claim', (approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' }) as any).code !== undefined) }

  // ── self-link (root claims its OWN seat): founder bootstrap rules ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_root', contributorAccountId: 'usr_root' }) as any
    ok('self-link as independent_governance is REJECTED',
      (approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'independent_governance', conflictDisclosure: 'self_or_related' }) as any).code === 'self_link_requires_marking')
    ok('self-link without self_or_related disclosure is REJECTED',
      (approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'none' }) as any).code === 'self_link_requires_disclosure')
    const a = approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related' })
    ok('self-link approves WITHOUT a separate confirmation when founder_bootstrap_override + self_or_related', (a as any).ok === true && deriveClaimState(db, c.claimedEventId)!.status === 'approved')
    const res = resolveOperatorClaimAsOf(db, 'usr_root', '2999-01-01T00:00:00Z')
    ok('self-link resolver → marked founder_bootstrap_override', res?.approval_kind === 'founder_bootstrap_override' && res?.conflict_disclosure === 'self_or_related') }

  // ── revoke an approved claim (append-only); resolver then returns null ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'accepted' })
    const a = approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' }) as any
    ok('resolver resolves before revoke', resolveOperatorClaimAsOf(db, 'usr_regional', '2999-01-01T00:00:00Z')?.contributor_account_id === 'usr_holden')
    const rv = revokeApprovedClaim(db, { approvedEventId: a.approvedEventId, revokerId: 'usr_root' })
    ok('root revokes the approved claim', (rv as any).ok === true && deriveClaimState(db, c.claimedEventId)!.status === 'revoked')
    ok('after revoke, resolver returns null', resolveOperatorClaimAsOf(db, 'usr_regional', '2999-01-01T00:00:00Z') === null)
    ok('non-root cannot revoke', (revokeApprovedClaim(db, { approvedEventId: a.approvedEventId, revokerId: 'usr_regional' }) as any).code === 'not_root') }

  // ── supersede: approving a NEW contributor on the same seat supersedes the old (append-only) ──
  { const db = freshDb()
    const c1 = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    confirmClaim(db, { claimedEventId: c1.claimedEventId, deciderId: 'usr_holden', decision: 'accepted' })
    approveClaim(db, { claimedEventId: c1.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' })
    const c2 = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_eve' }) as any
    confirmClaim(db, { claimedEventId: c2.claimedEventId, deciderId: 'usr_eve', decision: 'accepted' })
    approveClaim(db, { claimedEventId: c2.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' })
    ok('old claim auto-superseded', deriveClaimState(db, c1.claimedEventId)!.status === 'superseded')
    ok('seat now resolves to the NEW contributor (Eve)', resolveOperatorClaimAsOf(db, 'usr_regional', '2999-01-01T00:00:00Z')?.contributor_account_id === 'usr_eve') }

  // ── append-only: UPDATE/DELETE on events AND confirmations are DB-rejected ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'accepted' })
    ok('claim events: UPDATE rejected', threw(() => db.prepare("UPDATE admin_operator_claim_events SET event_type='approved' WHERE event_id=?").run(c.claimedEventId)))
    ok('claim events: DELETE rejected', threw(() => db.prepare('DELETE FROM admin_operator_claim_events WHERE event_id=?').run(c.claimedEventId)))
    ok('confirmations: UPDATE rejected', threw(() => db.prepare("UPDATE admin_operator_claim_confirmations SET decision='rejected' WHERE claimed_event_id=?").run(c.claimedEventId)))
    ok('confirmations: DELETE rejected', threw(() => db.prepare('DELETE FROM admin_operator_claim_confirmations WHERE claimed_event_id=?').run(c.claimedEventId))) }

  // ── resolver returns null when there is no approved claim ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: 'usr_holden', decision: 'accepted' })
    ok('proposed+confirmed but NOT approved → resolver null', resolveOperatorClaimAsOf(db, 'usr_regional', '2999-01-01T00:00:00Z') === null) }

  // ── DB-level forgery resistance on confirmations (defense-in-depth beyond the route auth) ──
  { const db = freshDb()
    const c = proposeClaim(db, { actorAdminId: 'usr_regional', contributorAccountId: 'usr_holden' }) as any
    const ins = (o: any) => db.prepare(
      `INSERT INTO admin_operator_claim_confirmations (confirmation_id, claimed_event_id, admin_account_id, contributor_account_id, decision, decided_by, immutable)
       VALUES (@confirmation_id,@claimed_event_id,@admin_account_id,@contributor_account_id,@decision,@decided_by,1)`,
    ).run({ confirmation_id: 'aocc_x', claimed_event_id: c.claimedEventId, admin_account_id: 'usr_regional', contributor_account_id: 'usr_holden', decision: 'accepted', decided_by: 'usr_holden', ...o })
    ok('DB CHECK rejects decided_by != contributor (cannot record "X accepted for Y")', threw(() => ins({ confirmation_id: 'aocc_bad1', decided_by: 'usr_eve' })))
    ok('DB trigger rejects confirmation whose admin/contributor mismatch the claimed event', threw(() => ins({ confirmation_id: 'aocc_bad2', contributor_account_id: 'usr_eve', decided_by: 'usr_eve' })))
    ins({})   // one valid confirmation
    ok('DB UNIQUE rejects a second confirmation for the same claim', threw(() => ins({ confirmation_id: 'aocc_dup', decision: 'rejected' })))
    ok('valid confirmation is read as confirmed', deriveClaimState(db, c.claimedEventId)!.status === 'confirmed') }

  if (fail === 0) {
    console.log(`\n✅ admin operator-claim workflow (Phase 2): propose(admin-only) → confirm(contributor-only) → approve(root, confirmed-gated) → revoke/supersede · self-link founder_bootstrap_override/self_or_related (independent_governance rejected) · append-only events+confirmations · resolver as-of · zero contribution_facts\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin operator-claim workflow FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
