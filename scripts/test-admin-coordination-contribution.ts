#!/usr/bin/env tsx
/**
 * Admin / Agent coordination contribution — Phase 1 schema + ingestion + resolver tests.
 *   用法:npm run test:admin-coordination-contribution
 *
 * Fresh in-memory SQLite (foreign_keys=ON) + users + admin_audit_log + contribution_facts (github
 * credential store) + identity_bindings_active + the admin-coordination schema. Pure/offline.
 *
 * Asserts the Phase-1 invariants: ingestion is ANCHORED on a real admin_audit_log row (nonexistent
 * auditId and legacy/no-_ctx rows fail closed) · allowlist fail-closed · no-claim/no-mandate → audit
 * only · founder bootstrap self-approval allowed but explicitly marked, and a self-link can NEVER be
 * labelled independent_governance (DB-rejected) · approved claims require approval_kind+approver+honest
 * conflict · agent needs an in-scope mandate (real owner+cost-bearer+approver) → owner contributor ·
 * accountable_ref never written · as-of rotation · append-only event logs AND evidence link · user FKs ·
 * idempotent · NO reward/payout/eligibility columns.
 */
import Database from 'better-sqlite3'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initAdminCoordinationSchema } from '../src/layer2-business/L2-9-contribution/admin-coordination-store.js'
import { ingestAdminCoordinationFact } from '../src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.js'
import { resolveCoordinationContributor, resolveOperatorClaimAsOf } from '../src/layer2-business/L2-9-contribution/admin-coordination-resolver.js'
import { logAdminAction, readAdminActionContext } from '../src/pwa/admin-audit.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const threw = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','contributor','k_a'),('usr_bob','Bob','contributor','k_b'),('usr_admin','Adm','admin','k_adm'),('usr_root','Root','admin','k_root')`).run()
  db.exec(`CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  initGithubCredentialStoreSchema(db)   // contribution_facts (the single ledger)
  initIdentityBindingSchema(db)         // identity_bindings_active (github resolver path)
  initAdminCoordinationSchema(db)       // FKs users + contribution_facts + admin_audit_log
  return db
}
const nFacts = (db: any) => (db.prepare('SELECT COUNT(*) c FROM contribution_facts').get() as any).c
const insApproval = (db: any, o: any) => db.prepare(
  `INSERT INTO admin_operator_claim_events (event_id,event_type,admin_account_id,contributor_account_id,approval_kind,approved_by,conflict_disclosure,effective_from,rationale,immutable)
   VALUES (@event_id,@event_type,@admin_account_id,@contributor_account_id,@approval_kind,@approved_by,@conflict_disclosure,@effective_from,@rationale,1)`,
).run({ approval_kind: null, approved_by: null, conflict_disclosure: 'unknown', effective_from: null, rationale: null, ...o })
const insMandate = (db: any, o: any) => db.prepare(
  `INSERT INTO agent_execution_mandate_events (event_id,event_type,mandate_id,owner_contributor_account_id,agent_ref,allowed_actions,cost_bearer_account_id,approved_by,effective_from,expires_at,revoked_at,value_state,immutable)
   VALUES (@event_id,@event_type,@mandate_id,@owner_contributor_account_id,@agent_ref,@allowed_actions,@cost_bearer_account_id,@approved_by,@effective_from,@expires_at,@revoked_at,'uncommitted',1)`,
).run({ allowed_actions: '[]', cost_bearer_account_id: null, approved_by: null, effective_from: null, expires_at: null, revoked_at: null, ...o })

const T0 = '2026-06-01T00:00:00Z', T1 = '2026-06-10T00:00:00Z', T2 = '2026-06-20T00:00:00Z', T3 = '2026-06-30T00:00:00Z'
const adminCtx = (o: any = {}) => ({ actorType: 'admin_account', agentMode: 'human_direct', provenance: 'human', ...o })
const grantedClaim = (db: any, ev: string, admin: string, contrib: string, o: any = {}) =>
  insApproval(db, { event_id: ev, event_type: 'approved', admin_account_id: admin, contributor_account_id: contrib, approval_kind: 'root_approval', approved_by: 'usr_root', conflict_disclosure: admin === contrib ? 'self_or_related' : 'none', effective_from: T0, ...o })

function noBannedColumns(db: any, table: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => String(c.name).toLowerCase())
  return !cols.some(c => /reward|payout|eligib|redeem|amount|currency|price|yield|payable|settle/.test(c))
}

async function main(): Promise<void> {
  // ── P1: ingestion is ANCHORED on a real audit row ──
  { const db = freshDb()
    grantedClaim(db, 'a0', 'usr_admin', 'usr_alice')
    const r = ingestAdminCoordinationFact(db, { auditId: 'does_not_exist' })
    ok('nonexistent auditId → audit_row_not_found, NO fact', r.ok === false && (r as any).reason === 'audit_row_not_found' && nFacts(db) === 0) }
  { const db = freshDb()
    grantedClaim(db, 'a0', 'usr_admin', 'usr_alice')   // a claim DOES exist…
    db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, detail) VALUES ('legacy_1','usr_admin','task_review','{"foo":1}')`).run()  // …but row has no _ctx
    const r = ingestAdminCoordinationFact(db, { auditId: 'legacy_1' })
    ok('legacy / no-_ctx audit row → not_eligible_context, NO fact (even with a claim present)', r.ok === false && (r as any).reason === 'not_eligible_context' && nFacts(db) === 0) }

  // ── allowlist fail-closed: unknown action → refused ──
  { const db = freshDb()
    grantedClaim(db, 'a0', 'usr_admin', 'usr_alice')
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'login', context: adminCtx() })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('unknown action → unknown_action, NO fact', r.ok === false && (r as any).reason === 'unknown_action' && nFacts(db) === 0) }

  // ── admin op WITHOUT an operator claim → audit only ──
  { const db = freshDb()
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', context: adminCtx() })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('admin without operator claim → no_attribution, NO fact', r.ok === false && (r as any).reason === 'no_attribution' && nFacts(db) === 0) }

  // ── founder bootstrap self-approval: ALLOWED but explicitly marked; DB rejects dishonest labelling ──
  { const db = freshDb()
    insApproval(db, { event_id: 'b', event_type: 'approved', admin_account_id: 'usr_root', contributor_account_id: 'usr_root', approval_kind: 'founder_bootstrap_override', approved_by: 'usr_root', conflict_disclosure: 'self_or_related', effective_from: T0 })
    const res = resolveOperatorClaimAsOf(db, 'usr_root', T1)
    ok('founder bootstrap self-approval resolves', res?.contributor_account_id === 'usr_root')
    ok('founder bootstrap marked founder_bootstrap_override (NOT independent_governance)', res!.approval_kind === 'founder_bootstrap_override')
    ok('founder bootstrap discloses self_or_related', res!.conflict_disclosure === 'self_or_related')
    ok('DB REJECTS self-link approved as independent_governance/none (P2b)', threw(() =>
      insApproval(db, { event_id: 'b_bad', event_type: 'approved', admin_account_id: 'usr_root', contributor_account_id: 'usr_root', approval_kind: 'independent_governance', approved_by: 'usr_root', conflict_disclosure: 'none', effective_from: T0 })))
    const audit = logAdminAction(db, { adminId: 'usr_root', action: 'proposal_review', targetType: 'task_proposal', targetId: 'tp_1', context: adminCtx({ approvalKind: 'founder_bootstrap_override', conflictDisclosure: 'self_or_related' }) })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('bootstrap admin coordination ingests one fact', r.ok === true && (r as any).status === 'ingested' && nFacts(db) === 1) }

  // ── DB rejects approved claims that are not honest, and FK violations ──
  { const db = freshDb()
    ok('DB rejects approved claim missing approval_kind', threw(() =>
      insApproval(db, { event_id: 'x1', event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', approved_by: 'usr_root', conflict_disclosure: 'none', effective_from: T0 })))
    ok('DB rejects approved claim missing approved_by', threw(() =>
      insApproval(db, { event_id: 'x2', event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', approval_kind: 'root_approval', conflict_disclosure: 'none', effective_from: T0 })))
    ok('DB rejects approved claim with conflict_disclosure=unknown', threw(() =>
      insApproval(db, { event_id: 'x3', event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', approval_kind: 'root_approval', approved_by: 'usr_root', conflict_disclosure: 'unknown', effective_from: T0 })))
    ok('DB rejects claim referencing a non-existent user (FK)', threw(() =>
      insApproval(db, { event_id: 'x4', event_type: 'approved', admin_account_id: 'usr_ghost', contributor_account_id: 'usr_alice', approval_kind: 'root_approval', approved_by: 'usr_root', conflict_disclosure: 'none', effective_from: T0 }))) }

  // ── agent context WITHOUT a mandate_id → not eligible; with an unknown mandate_id → no attribution ──
  { const db = freshDb()
    const a1 = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', context: { actorType: 'agent', agentMode: 'agent_delegated', actorRef: 'ag_x' } })
    const r1 = ingestAdminCoordinationFact(db, { auditId: a1 })
    ok('agent action missing _ctx.mandate_id → not_eligible_context, NO fact', r1.ok === false && (r1 as any).reason === 'not_eligible_context' && nFacts(db) === 0)
    const a2 = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', context: { actorType: 'agent', actorRef: 'ag_x', mandateId: 'mnd_ghost' } })
    const r2 = ingestAdminCoordinationFact(db, { auditId: a2 })
    ok('agent with unknown mandate_id → no_attribution, NO fact', r2.ok === false && (r2 as any).reason === 'no_attribution' && nFacts(db) === 0) }

  // ── P1 regression: two ACTIVE mandates share one agent_ref → the audit row's mandate_id decides ──
  { const db = freshDb()
    insMandate(db, { event_id: 'sh_bob', event_type: 'granted', mandate_id: 'mnd_bob', owner_contributor_account_id: 'usr_bob', agent_ref: 'ag_shared', allowed_actions: JSON.stringify(['task_review']), cost_bearer_account_id: 'usr_bob', approved_by: 'usr_root', effective_from: T0, expires_at: T3 })
    insMandate(db, { event_id: 'sh_alice', event_type: 'granted', mandate_id: 'mnd_alice', owner_contributor_account_id: 'usr_alice', agent_ref: 'ag_shared', allowed_actions: JSON.stringify(['task_review']), cost_bearer_account_id: 'usr_alice', approved_by: 'usr_root', effective_from: T1, expires_at: T3 })   // LATER, also active at T2
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', context: { actorType: 'agent', actorRef: 'ag_shared', mandateId: 'mnd_bob' } })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('shared agent_ref: audit row mandate_id=mnd_bob → credited to Bob (NOT latest mandate Alice)', r.ok === true && (r as any).contributorAccountId === 'usr_bob')
    const factRow = db.prepare('SELECT executor_ref, occurred_at FROM contribution_facts WHERE fact_id = ?').get((r as any).factId) as any
    ok('executor_ref encodes the mandate (agent:<ref>#<mandate_id>)', factRow.executor_ref === 'agent:ag_shared#mnd_bob')
    const resolved = resolveCoordinationContributor(db, factRow.executor_ref, factRow.occurred_at)
    ok('read-time resolution is ALSO deterministic → Bob', resolved?.contributor_account_id === 'usr_bob' && resolved?.via === 'agent_mandate') }

  // ── agent WITH mandate → OWNER contributor; action must be in scope; mandate needs cost-bearer+approver ──
  { const db = freshDb()
    ok('DB rejects granted mandate without cost_bearer/approver', threw(() =>
      insMandate(db, { event_id: 'm_bad', event_type: 'granted', mandate_id: 'mb', owner_contributor_account_id: 'usr_bob', agent_ref: 'ag_x', allowed_actions: JSON.stringify(['task_review']), effective_from: T0 })))
    insMandate(db, { event_id: 'aeme_1', event_type: 'granted', mandate_id: 'mnd_1', owner_contributor_account_id: 'usr_bob', agent_ref: 'ag_x', allowed_actions: JSON.stringify(['task_review']), cost_bearer_account_id: 'usr_bob', approved_by: 'usr_root', effective_from: T0, expires_at: T3 })
    const a1 = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', context: { actorType: 'agent', agentMode: 'agent_delegated', actorRef: 'ag_x', mandateId: 'mnd_1' } })
    const r1 = ingestAdminCoordinationFact(db, { auditId: a1 })
    ok('agent WITH mandate → ingested, attributed to OWNER contributor', r1.ok === true && (r1 as any).contributorAccountId === 'usr_bob' && (r1 as any).via === 'agent_mandate')
    const a2 = logAdminAction(db, { adminId: 'usr_admin', action: 'dispute_coordination', context: { actorType: 'agent', actorRef: 'ag_x', mandateId: 'mnd_1' } })
    const r2 = ingestAdminCoordinationFact(db, { auditId: a2 })
    ok('agent action NOT in mandate scope → refused', r2.ok === false && (r2 as any).reason === 'agent_action_not_in_mandate') }

  // ── accountable_ref never written + artifact derived FROM the audit row (P2a) ──
  { const db = freshDb()
    grantedClaim(db, 'aoce_2', 'usr_admin', 'usr_alice')
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', targetType: 'build_task', targetId: 'bt_9', context: adminCtx() })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    const factRow = db.prepare('SELECT accountable_ref, executor_ref, occurred_at, artifact_ref FROM contribution_facts WHERE fact_id = ?').get((r as any).factId) as any
    const linkRow = db.prepare('SELECT source_id, source_type FROM admin_coordination_fact_sources WHERE fact_id = ?').get((r as any).factId) as any
    ok('fact written with executor_ref=admin:<id>', factRow.executor_ref === 'admin:usr_admin')
    ok('accountable_ref is NULL on the fact (read-time resolution)', factRow.accountable_ref === null)
    ok('artifact_ref derives from the audit row target_id (P2a — not caller-supplied)', factRow.artifact_ref === 'bt_9')
    ok('evidence link source_id == audit row target_id', linkRow.source_id === 'bt_9')
    ok('fact occurred_at comes from the audit row created_at', typeof factRow.occurred_at === 'string' && factRow.occurred_at.length > 0)
    const resolved = resolveCoordinationContributor(db, factRow.executor_ref, factRow.occurred_at)
    ok('read-time resolver → contributor usr_alice via operator_claim', resolved?.contributor_account_id === 'usr_alice' && resolved?.via === 'operator_claim') }

  // ── P2b: a referenced admin_audit_log row is FROZEN; a non-referenced one stays mutable ──
  { const db = freshDb()
    grantedClaim(db, 'frz_a', 'usr_admin', 'usr_alice')
    const refd = logAdminAction(db, { adminId: 'usr_admin', action: 'task_review', targetId: 'bt_1', context: adminCtx() })
    ingestAdminCoordinationFact(db, { auditId: refd })
    ok('referenced audit row: UPDATE rejected (evidence frozen)', threw(() => db.prepare(`UPDATE admin_audit_log SET action='login', detail='{}' WHERE id=?`).run(refd)))
    ok('referenced audit row: DELETE rejected (evidence frozen)', threw(() => db.prepare(`DELETE FROM admin_audit_log WHERE id=?`).run(refd)))
    const free = logAdminAction(db, { adminId: 'usr_admin', action: 'login', context: adminCtx() })   // never ingested → not evidence
    let mutated = true; try { db.prepare(`UPDATE admin_audit_log SET detail='{}' WHERE id=?`).run(free) } catch { mutated = false }
    ok('non-referenced audit row stays mutable', mutated === true) }

  // ── as-of attribution + rotation: normal rotation does NOT rewrite history ──
  { const db = freshDb()
    grantedClaim(db, 'r_a', 'usr_admin', 'usr_alice', { effective_from: T0 })
    insApproval(db, { event_id: 'r_rev', event_type: 'revoked', admin_account_id: 'usr_admin', contributor_account_id: 'usr_alice', effective_from: T2 })
    grantedClaim(db, 'r_b', 'usr_admin', 'usr_bob', { effective_from: T2 })
    ok('as-of T1 (before rotation) → Alice', resolveOperatorClaimAsOf(db, 'usr_admin', T1)?.contributor_account_id === 'usr_alice')
    ok('as-of T3 (after rotation) → Bob', resolveOperatorClaimAsOf(db, 'usr_admin', T3)?.contributor_account_id === 'usr_bob') }

  // ── append-only: event logs AND the evidence link are DB-immutable ──
  { const db = freshDb()
    grantedClaim(db, 'imm_1', 'usr_admin', 'usr_alice')
    ok('claim events: UPDATE rejected', threw(() => db.prepare(`UPDATE admin_operator_claim_events SET contributor_account_id='usr_bob' WHERE event_id='imm_1'`).run()))
    ok('claim events: DELETE rejected', threw(() => db.prepare(`DELETE FROM admin_operator_claim_events WHERE event_id='imm_1'`).run()))
    insMandate(db, { event_id: 'imm_m', event_type: 'granted', mandate_id: 'm', owner_contributor_account_id: 'usr_bob', agent_ref: 'ag', allowed_actions: JSON.stringify(['task_review']), cost_bearer_account_id: 'usr_bob', approved_by: 'usr_root', effective_from: T0 })
    ok('mandate events: UPDATE rejected', threw(() => db.prepare(`UPDATE agent_execution_mandate_events SET owner_contributor_account_id='usr_alice' WHERE event_id='imm_m'`).run()))
    ok('mandate events: DELETE rejected', threw(() => db.prepare(`DELETE FROM agent_execution_mandate_events WHERE event_id='imm_m'`).run()))
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'maintenance_action', context: adminCtx() })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('evidence link: UPDATE rejected (append-only)', threw(() => db.prepare(`UPDATE admin_coordination_fact_sources SET source_type='x' WHERE fact_id=?`).run((r as any).factId)))
    ok('evidence link: DELETE rejected (append-only)', threw(() => db.prepare(`DELETE FROM admin_coordination_fact_sources WHERE fact_id=?`).run((r as any).factId))) }

  // ── idempotent ingest ──
  { const db = freshDb()
    grantedClaim(db, 'idem_a', 'usr_admin', 'usr_alice')
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'maintenance_action', context: adminCtx() })
    const r1 = ingestAdminCoordinationFact(db, { auditId: audit })
    const r2 = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('1st ingest → ingested', r1.ok === true && (r1 as any).status === 'ingested')
    ok('2nd ingest → already_present, still ONE fact', r2.ok === true && (r2 as any).status === 'already_present' && nFacts(db) === 1) }

  // ── legacy context reads back as unknown / not eligible ──
  { const db = freshDb()
    const ctx = readAdminActionContext('{"foo":1}')
    ok('context without _ctx → unknown_agent / unknown', ctx.actor_type === 'unknown_agent' && ctx.agent_mode === 'unknown_agent' && ctx.conflict_disclosure === 'unknown') }

  // ── evidence visibility defaults to governance_only; fact carries no admin detail ──
  { const db = freshDb()
    grantedClaim(db, 'vis_a', 'usr_admin', 'usr_alice')
    const audit = logAdminAction(db, { adminId: 'usr_admin', action: 'governance_review', context: adminCtx() })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    const link = db.prepare('SELECT visibility FROM admin_coordination_fact_sources WHERE fact_id = ?').get((r as any).factId) as any
    ok('evidence link defaults to governance_only', link.visibility === 'governance_only')
    const factCols = (db.prepare(`PRAGMA table_info(contribution_facts)`).all() as any[]).map(c => c.name)
    ok('contribution_facts carries NO admin detail column', !factCols.includes('detail')) }

  // ── NO reward/payout/eligibility/redeemable columns anywhere in this layer ──
  { const db = freshDb()
    ok('contribution_facts: no economic columns', noBannedColumns(db, 'contribution_facts'))
    ok('admin_operator_claim_events: no economic columns', noBannedColumns(db, 'admin_operator_claim_events'))
    ok('agent_execution_mandate_events: no economic columns', noBannedColumns(db, 'agent_execution_mandate_events'))
    ok('admin_coordination_fact_sources: no economic columns', noBannedColumns(db, 'admin_coordination_fact_sources')) }

  if (fail === 0) {
    console.log(`\n✅ admin coordination contribution (Phase 1): audit-anchored ingest (nonexistent/legacy rows fail closed) · allowlist fail-closed · no-claim/no-mandate → audit only · founder override marked + dishonest self-link DB-rejected · honest-approval + user FK CHECKs · agent in-scope mandate → owner · accountable_ref never written · as-of rotation · append-only logs + evidence link · idempotent · no economic columns\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin coordination contribution FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
