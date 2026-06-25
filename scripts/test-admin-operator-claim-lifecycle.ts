#!/usr/bin/env tsx
/**
 * Operator-claim relationship lifecycle — contributor self-view + unlink (解除) request workflow.
 *   用法:npm run test:admin-operator-claim-lifecycle
 *
 * Fresh in-memory SQLite + users + contribution_facts (github store, must stay EMPTY) + admin_audit_log
 * + admin-coordination schema (incl. the Phase-3 unlink-requests table). Pure engine-level (no listen).
 *
 * Covers: contributor self-view returns only own relationships; either party (admin-seat OR contributor)
 * can request unlink of an ACTIVE approved claim; an unrelated user cannot; non-root cannot approve/reject;
 * one pending request at a time; root approve → claim revoked (resolver null); root reject → claim stays
 * active; append-only unlink log; and NO contribution_facts produced.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initAdminCoordinationSchema } from '../src/layer2-business/L2-9-contribution/admin-coordination-store.js'
import { proposeClaim, confirmClaim, approveClaim, deriveClaimState, requestUnlink, approveUnlink, rejectUnlink, pendingUnlinkForApproved, listContributorRelationships, listPendingUnlinkRequests } from '../src/layer2-business/L2-9-contribution/admin-operator-claim-workflow.js'
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
    ('usr_admin','Adm','admin','regional','["admin"]','k_adm'),
    ('usr_holden','Holden','buyer',NULL,'["buyer"]','k_h'),
    ('usr_eve','Eve','buyer',NULL,'["buyer"]','k_e')`).run()
  db.exec(`CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  initGithubCredentialStoreSchema(db)
  initAdminCoordinationSchema(db)
  return db
}
const nFacts = (db: any) => (db.prepare('SELECT COUNT(*) c FROM contribution_facts').get() as any).c
// helper: build an ACTIVE approved claim admin→contributor; return {claimedEventId, approvedEventId}
function makeApproved(db: any, admin = 'usr_admin', contributor = 'usr_holden'): { claimedEventId: string; approvedEventId: string } {
  const c = proposeClaim(db, { actorAdminId: admin, contributorAccountId: contributor }) as any
  confirmClaim(db, { claimedEventId: c.claimedEventId, deciderId: contributor, decision: 'accepted' })
  const a = approveClaim(db, { claimedEventId: c.claimedEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' }) as any
  return { claimedEventId: c.claimedEventId, approvedEventId: a.approvedEventId }
}

async function main(): Promise<void> {
  // ── contributor self-view returns only own relationships ──
  { const db = freshDb(); makeApproved(db, 'usr_admin', 'usr_holden')
    ok('contributor self-view → own relationship present', listContributorRelationships(db, 'usr_holden').length === 1)
    ok('contributor self-view → unrelated user sees nothing', listContributorRelationships(db, 'usr_eve').length === 0) }

  // ── either party can request unlink of an active approved claim ──
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    const r = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' })
    ok('admin-seat owner can request unlink', (r as any).ok === true && (r as any).requesterRole === 'admin_seat') }
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    const r = requestUnlink(db, { approvedEventId, requesterId: 'usr_holden' })
    ok('contributor can request unlink', (r as any).ok === true && (r as any).requesterRole === 'contributor') }
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    ok('unrelated user CANNOT request unlink', (requestUnlink(db, { approvedEventId, requesterId: 'usr_eve' }) as any).code === 'not_party') }

  // ── one pending request at a time ──
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' })
    ok('second unlink request while one pending → already_pending', (requestUnlink(db, { approvedEventId, requesterId: 'usr_holden' }) as any).code === 'already_pending')
    ok('pendingUnlinkForApproved surfaces the pending request', !!pendingUnlinkForApproved(db, approvedEventId))
    ok('root review queue lists it', listPendingUnlinkRequests(db).length === 1) }

  // ── non-root cannot approve/reject ──
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    ok('non-root CANNOT approve unlink', (approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_admin' }) as any).code === 'not_root')
    ok('non-root CANNOT reject unlink', (rejectUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_admin' }) as any).code === 'not_root') }

  // ── root approve → claim revoked (resolver null) ──
  { const db = freshDb(); const { approvedEventId, claimedEventId } = makeApproved(db)
    ok('before unlink: resolver → contributor', resolveOperatorClaimAsOf(db, 'usr_admin', '2999-01-01T00:00:00Z')?.contributor_account_id === 'usr_holden')
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_holden' }) as any
    const ap = approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root' })
    ok('root approve unlink → ok', (ap as any).ok === true)
    ok('claim now revoked', deriveClaimState(db, claimedEventId)!.status === 'revoked')
    ok('resolver now null (relationship severed)', resolveOperatorClaimAsOf(db, 'usr_admin', '2999-01-01T00:00:00Z') === null)
    ok('NO contribution_facts produced by unlink', nFacts(db) === 0) }

  // ── root reject → claim stays active ──
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    const rj = rejectUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root' })
    ok('root reject unlink → ok', (rj as any).ok === true)
    ok('claim still active after reject', resolveOperatorClaimAsOf(db, 'usr_admin', '2999-01-01T00:00:00Z')?.contributor_account_id === 'usr_holden')
    ok('no pending request after reject', !pendingUnlinkForApproved(db, approvedEventId))
    // can re-request after a reject (append-only, not blocked)
    ok('can re-request unlink after a reject', (requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any).ok === true) }

  // ── cannot request unlink on a non-active (already revoked) claim ──
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root' })   // → revoked
    ok('request unlink on a revoked claim → bad_state', (requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any).code === 'bad_state') }

  // ── append-only unlink log ──
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    ok('unlink requests: UPDATE rejected', threw(() => db.prepare("UPDATE admin_operator_unlink_requests SET event_type='approved' WHERE request_event_id=?").run(req.requestEventId)))
    ok('unlink requests: DELETE rejected', threw(() => db.prepare('DELETE FROM admin_operator_unlink_requests WHERE request_event_id=?').run(req.requestEventId))) }

  // ── P2-2: self-or-related unlink decisions REQUIRE honest marking; independent decisions default ──
  // build an approved claim whose CONTRIBUTOR is root → root is self-or-related when deciding the unlink.
  const makeApprovedToRoot = (db: any) => makeApproved(db, 'usr_admin', 'usr_root')
  { const db = freshDb(); const { approvedEventId } = makeApprovedToRoot(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    ok('self-or-related approve WITHOUT marking → self_related_requires_marking',
      (approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root' }) as any).code === 'self_related_requires_marking') }
  { const db = freshDb(); const { approvedEventId } = makeApprovedToRoot(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    // self-or-related path rejects independent_governance at the marking gate (never reaches the claim revoke)
    ok('self-or-related approve marked independent_governance → rejected',
      (approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root', approvalKind: 'independent_governance', conflictDisclosure: 'self_or_related' }) as any).code === 'self_related_requires_marking') }
  // dishonest_marking backstop: an INDEPENDENT root who explicitly mislabels independent_governance + self_or_related
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)   // admin→holden; root is neither
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    ok('independent root labelling independent_governance + self_or_related → dishonest_marking',
      (approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root', approvalKind: 'independent_governance', conflictDisclosure: 'self_or_related' }) as any).code === 'dishonest_marking') }
  { const db = freshDb(); const { approvedEventId } = makeApprovedToRoot(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    ok('self-or-related approve marked root_approval but conflict_disclosure=none → self_related_requires_disclosure',
      (approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'none' }) as any).code === 'self_related_requires_disclosure') }
  { const db = freshDb(); const { approvedEventId } = makeApprovedToRoot(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    const ap = approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root', approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related' }) as any
    ok('self-or-related approve with honest marking → ok', ap.ok === true && ap.approvalKind === 'founder_bootstrap_override' && ap.conflictDisclosure === 'self_or_related')
    const dec = db.prepare("SELECT approval_kind, conflict_disclosure FROM admin_operator_unlink_requests WHERE request_event_id = ?").get(ap.decisionEventId) as any
    ok('decision event PERSISTS the marking', dec?.approval_kind === 'founder_bootstrap_override' && dec?.conflict_disclosure === 'self_or_related') }
  { const db = freshDb(); const { approvedEventId } = makeApprovedToRoot(db)
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    const rj = rejectUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root', approvalKind: 'root_approval', conflictDisclosure: 'self_or_related' }) as any
    ok('self-or-related reject with honest marking → ok', rj.ok === true && rj.conflictDisclosure === 'self_or_related')
    ok('self-or-related reject WITHOUT marking → self_related_requires_marking',
      (rejectUnlink(db, { requestEventId: (requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any).requestEventId, approverId: 'usr_root' }) as any).code === 'self_related_requires_marking') }
  // independent (root NOT a party) → marking optional, defaults recorded honestly
  { const db = freshDb(); const { approvedEventId } = makeApproved(db)   // admin→holden; root is neither
    const req = requestUnlink(db, { approvedEventId, requesterId: 'usr_admin' }) as any
    const ap = approveUnlink(db, { requestEventId: req.requestEventId, approverId: 'usr_root' }) as any
    ok('independent approve WITHOUT marking → ok (defaults)', ap.ok === true && ap.approvalKind === 'root_approval' && ap.conflictDisclosure === 'none')
    const dec = db.prepare("SELECT approval_kind, conflict_disclosure FROM admin_operator_unlink_requests WHERE request_event_id = ?").get(ap.decisionEventId) as any
    ok('independent decision records default marking', dec?.approval_kind === 'root_approval' && dec?.conflict_disclosure === 'none') }

  // ── P2-1 route contract: admin-seat self-view returns unlink_pending (uses shapeClaim, not shape) ──
  { const routeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/pwa/routes/admin-operator-claims.ts'), 'utf8')
    const meRouteLine = routeSrc.split('\n').find(l => l.includes("'/api/admin/operator-claims/me'") || l.includes('listClaimsForSeat'))
    const meMapsShapeClaim = /listClaimsForSeat\(db, admin\.id as string\)\.map\(shapeClaim\)/.test(routeSrc)
    ok('/admin/operator-claims/me maps with shapeClaim (carries unlink_pending)', meMapsShapeClaim, meRouteLine || '(not found)')
    // unlink/requests route flags self_or_related for the viewing root
    ok('unlink/requests route computes self_or_related for the viewing root', /self_or_related:\s*rid === r\.admin_account_id/.test(routeSrc))
    // approve/reject unlink routes forward approval_kind / conflict_disclosure
    ok('unlink approve route forwards marking to engine', /approveUnlink\(db, \{ requestEventId: id, approverId: root\.id as string, approvalKind, conflictDisclosure \}\)/.test(routeSrc))
    ok('unlink reject route forwards marking to engine', /rejectUnlink\(db, \{ requestEventId: id, approverId: root\.id as string, approvalKind, conflictDisclosure \}\)/.test(routeSrc)) }

  // ── P2-1 static UI contract: admin's OWN approved claims expose an unlink control (claimRow shares unlinkAreaFor) ──
  // The operator-claim render surface (unlinkAreaFor / claimRow / relCard / markingForm)
  // was moved out of app.js into app-contribution.js by the classic-script split
  // (PR D / #57), so this contract reads BOTH files. (The me-menu block below stays
  // app.js-only — its negative assertions need the tight app.js source span.)
  { const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/pwa/public/app.js'), 'utf8')
      + '\n' + readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/pwa/public/app-contribution.js'), 'utf8')
    ok('shared unlinkAreaFor helper exists', /const unlinkAreaFor = \(c\) =>/.test(appSrc))
    ok('admin claimRow renders the unlink area', /claimRow = \(c\) => `[\s\S]*?\$\{unlinkAreaFor\(c\)\}[\s\S]*?<\/div>`/.test(appSrc))
    ok('contributor relCard renders the unlink area', /relCard = \(c\) => \{[\s\S]*?\$\{unlinkAreaFor\(c\)\}/.test(appSrc))
    // unlink review card shows marking selectors when root is self-or-related
    ok('unlink review card shows marking selectors when self_or_related', /u\.self_or_related \? `[\s\S]*?uak-\$\{rid\}/.test(appSrc))
    ok('self-or-related unlink marking omits independent_governance OPTION', (() => {
      const m = appSrc.match(/const markingForm = u\.self_or_related \? `([\s\S]*?)` : ''/)
      return !!m && !/<option value="independent_governance"/.test(m[1]) && /<option value="founder_bootstrap_override"/.test(m[1])
    })()) }

  // ── static UI contract: 我的→高级 「贡献归属」entry is shown when the user has relationships ──
  { const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/pwa/public/app.js'), 'utf8')
    const meMenuCardLines = appSrc.split('\n').filter(l => /\bcard\(/.test(l) && !/adminLinkCard/.test(l) && l.includes('#me/operator-claims'))
    ok('me-menu 贡献归属 card exists', meMenuCardLines.length === 1, JSON.stringify(meMenuCardLines))
    ok('me-menu 贡献归属 card is NOT shown unconditionally to all users', meMenuCardLines.every(l => /\?/.test(l)))
    ok('me-menu 贡献归属 card is gated on admin OR having a relationship (not GitHub)', meMenuCardLines.every(l => /role === 'admin'/.test(l) && /hasOperatorClaim|operatorClaim|relationship/i.test(l) && !/github|identity_binding/i.test(l)), JSON.stringify(meMenuCardLines)) }

  if (fail === 0) {
    console.log(`\n✅ operator-claim relationship lifecycle: contributor self-view (own only) · either party requests unlink of active claim (unrelated blocked) · one pending at a time · non-root cannot approve/reject · root approve→revoked (resolver null) · root reject→stays active · re-request after reject · append-only unlink log · zero contribution_facts · me→高级 entry gated on admin-or-has-relationship\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ operator-claim relationship lifecycle FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
