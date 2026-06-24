#!/usr/bin/env tsx
/**
 * Admin-coordination ingestion — FIRST production pipeline (allowlist wiring + batch/dry-run).
 *   用法:node --import tsx scripts/test-admin-coordination-ingest-pipeline.ts
 *
 * Phase 1 built the single-row engine + resolver + store; this PR wires the REAL audited
 * `operator_claim.*` actions into the allowlist and adds the bounded batch / dry-run operator entry.
 * These tests exercise the REAL action strings (not the abstract concept names) end-to-end, plus the
 * batch semantics (dry-run writes nothing · --commit writes · idempotent · limit · skip reasons).
 *
 * reward DEFERRED throughout — asserts no reward/payout/amount ends up on the fact.
 */
import Database from 'better-sqlite3'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initAdminCoordinationSchema, ADMIN_COORDINATION_ACTIONS, LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS } from '../src/layer2-business/L2-9-contribution/admin-coordination-store.js'
import { ingestAdminCoordinationFact, ingestAdminCoordinationSince, parseCommitSwitch } from '../src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.js'
import { resolveCoordinationContributor } from '../src/layer2-business/L2-9-contribution/admin-coordination-resolver.js'
import { logAdminAction } from '../src/pwa/admin-audit.js'

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

const T0 = '2026-06-01T00:00:00Z', T1 = '2026-06-10T00:00:00Z', T2 = '2026-06-20T00:00:00Z', T3 = '2026-06-30T00:00:00Z'
const adminCtx = (o: any = {}) => ({ actorType: 'admin_account', agentMode: 'human_direct', provenance: 'human', ...o })
const grant = (db: any, ev: string, admin: string, contrib: string, o: any = {}) =>
  insApproval(db, { event_id: ev, event_type: 'approved', admin_account_id: admin, contributor_account_id: contrib, approval_kind: 'root_approval', approved_by: 'usr_root', conflict_disclosure: admin === contrib ? 'self_or_related' : 'none', effective_from: T0, ...o })
// a revoke terminates the linked approval (resolver is link-based via supersedes_event_id).
const revoke = (db: any, ev: string, admin: string, contrib: string, at: string, approvedEventId: string) =>
  insApproval(db, { event_id: ev, event_type: 'revoked', admin_account_id: admin, contributor_account_id: contrib, effective_from: at, supersedes_event_id: approvedEventId })
// audit row with real _ctx (via logAdminAction) but a CONTROLLED created_at (mutable pre-ingest).
function auditAt(db: any, action: string, createdAt: string, o: any = {}): string {
  const id = logAdminAction(db, { adminId: o.adminId ?? 'usr_admin', action, targetType: o.targetType, targetId: o.targetId, context: o.context ?? adminCtx() })
  db.prepare('UPDATE admin_audit_log SET created_at=? WHERE id=?').run(createdAt, id)
  return id
}
function noBannedColumns(db: any, table: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => String(c.name).toLowerCase())
  return !cols.some(c => /reward|payout|eligib|redeem|amount|currency|price|yield|payable|settle/.test(c))
}

function main(): void {
  // ── allowlist contract: ALL 8 real operator_claim.* actions are wired (the production pipeline) ──
  const REAL = ['operator_claim.propose', 'operator_claim.confirm', 'operator_claim.approve', 'operator_claim.reject', 'operator_claim.revoke', 'operator_claim.unlink_request', 'operator_claim.unlink_approve', 'operator_claim.unlink_reject']
  for (const a of REAL) ok(`allowlist contains real action ${a}`, Object.prototype.hasOwnProperty.call(ADMIN_COORDINATION_ACTIONS, a))
  ok('real operator_claim.* map to governance/governance', REAL.every(a => {
    const s = (ADMIN_COORDINATION_ACTIONS as any)[a]; return s.factSource === 'governance' && s.factType === 'governance'
  }))

  // ── allowlist action + active operator claim at action time → ONE evidence fact, governance type ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice', { effective_from: T0 })
    const audit = auditAt(db, 'operator_claim.approve', T1, { targetId: 'aoce_x' })
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('real allowlist action + active claim → ingested', r.ok === true && (r as any).status === 'ingested' && nFacts(db) === 1)
    const factRow = db.prepare('SELECT source, type, executor_ref, accountable_ref, occurred_at FROM contribution_facts').get() as any
    ok('fact source=governance type=governance', factRow.source === 'governance' && factRow.type === 'governance')
    ok('fact executor_ref=admin:<seat>, accountable_ref NULL (read-time resolve)', factRow.executor_ref === 'admin:usr_admin' && factRow.accountable_ref === null)
    ok('fact occurred_at == audit created_at (as-of anchor)', factRow.occurred_at === T1)
    const link = db.prepare('SELECT admin_audit_log_id, source_type FROM admin_coordination_fact_sources').get() as any
    ok('evidence link is traceable to the audit row + action', link.admin_audit_log_id === audit && link.source_type === 'operator_claim.approve')
    const resolved = resolveCoordinationContributor(db, factRow.executor_ref, factRow.occurred_at)
    ok('resolver maps admin:<seat> as-of → contributor', resolved?.contributor_account_id === 'usr_alice' && resolved?.via === 'operator_claim') }

  // ── idempotent: re-ingesting the same audit row never duplicates ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice')
    const audit = auditAt(db, 'operator_claim.unlink_approve', T1)
    ingestAdminCoordinationFact(db, { auditId: audit })
    const r2 = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('2nd ingest → already_present, still ONE fact', r2.ok === true && (r2 as any).status === 'already_present' && nFacts(db) === 1) }

  // ── unknown / non-allowlist admin action → skipped, no fact ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice')
    const audit = auditAt(db, 'suspend', T1)   // a real admin action, NOT a coordination action
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('non-allowlist action → unknown_action, NO fact', r.ok === false && (r as any).reason === 'unknown_action' && nFacts(db) === 0) }

  // ── admin with NO operator claim → skipped ──
  { const db = freshDb()
    const audit = auditAt(db, 'operator_claim.approve', T1)
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('allowlist action but no claim → no_attribution, NO fact', r.ok === false && (r as any).reason === 'no_attribution' && nFacts(db) === 0) }

  // ── claim approved AFTER the action → NOT retro-credited (as-of) ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice', { effective_from: T2 })
    const audit = auditAt(db, 'operator_claim.approve', T1)   // action BEFORE the claim
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('claim effective AFTER action → no_attribution (no retro-credit)', r.ok === false && (r as any).reason === 'no_attribution' && nFacts(db) === 0) }

  // ── claim approved BEFORE the action → ingestible ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice', { effective_from: T0 })
    const audit = auditAt(db, 'operator_claim.approve', T2)
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('claim effective BEFORE action → ingested', r.ok === true && nFacts(db) === 1) }

  // ── claim REVOKED before the action → skipped ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice', { effective_from: T0 }); revoke(db, 'g1r', 'usr_admin', 'usr_alice', T1, 'g1')
    const audit = auditAt(db, 'operator_claim.approve', T2)   // action AFTER revoke
    const r = ingestAdminCoordinationFact(db, { auditId: audit })
    ok('action after claim revoked → no_attribution, NO fact', r.ok === false && (r as any).reason === 'no_attribution' && nFacts(db) === 0) }

  // ── fact carries NO economic field ──
  { const db = freshDb(); grant(db, 'g1', 'usr_admin', 'usr_alice')
    ingestAdminCoordinationFact(db, { auditId: auditAt(db, 'operator_claim.approve', T1) })
    ok('contribution_facts has no reward/payout/amount column', noBannedColumns(db, 'contribution_facts'))
    const cols = (db.prepare(`PRAGMA table_info(contribution_facts)`).all() as any[]).map(c => c.name)
    ok('fact has NO reward_amount/payout field present', !cols.includes('reward_amount') && !cols.includes('payout')) }

  // ── BATCH: dry-run writes NOTHING; --commit writes; repeat --commit is idempotent ──
  { const db = freshDb()
    grant(db, 'gA', 'usr_admin', 'usr_alice', { effective_from: T0 })
    auditAt(db, 'operator_claim.approve', T1, { targetId: 'o1' })
    auditAt(db, 'operator_claim.revoke', T2, { targetId: 'o2' })
    auditAt(db, 'login', T2)                                  // non-allowlist → never even scanned
    const dry = ingestAdminCoordinationSince(db, { commit: false })   // no-cursor dry-run is allowed (preview)
    ok('dry-run (no cursor) wouldIngest=2, writes NOTHING', dry.committed === false && dry.wouldIngest === 2 && nFacts(db) === 0)
    ok('dry-run only scans allowlisted rows (login excluded)', dry.scanned === 2)
    const com = ingestAdminCoordinationSince(db, { commit: true, sinceTime: T0 })   // commit MUST be cursor-bounded
    ok('commit (with cursor) ingests 2, facts persisted', com.committed === true && com.ingested === 2 && nFacts(db) === 2)
    const com2 = ingestAdminCoordinationSince(db, { commit: true, sinceTime: T0 })
    ok('re-commit → all already_present, still 2 facts', com2.alreadyPresent === 2 && com2.ingested === 0 && nFacts(db) === 2) }

  // ── P2 fix: a no-cursor --commit is refused (would backfill history); dry-run no-cursor is fine ──
  { const db = freshDb(); grant(db, 'gA', 'usr_admin', 'usr_alice', { effective_from: T0 })
    auditAt(db, 'operator_claim.approve', T1)
    ok('no-cursor commit → throws commit_requires_cursor', threw(() => ingestAdminCoordinationSince(db, { commit: true })))
    ok('refused no-cursor commit wrote nothing', nFacts(db) === 0)
    ok('no-cursor DRY-RUN is still allowed (writes nothing)', ingestAdminCoordinationSince(db, { commit: false }).wouldIngest === 1 && nFacts(db) === 0)
    ok('commit WITH sinceTime is allowed', ingestAdminCoordinationSince(db, { commit: true, sinceTime: T0 }).ingested === 1 && nFacts(db) === 1) }

  // ── BATCH: skip reasons surfaced; limit honored ──
  { const db = freshDb()
    // no claim for usr_admin → these allowlist rows must be skipped with no_attribution
    auditAt(db, 'operator_claim.approve', T1)
    auditAt(db, 'operator_claim.confirm', T2)
    const rep = ingestAdminCoordinationSince(db, { commit: false })
    ok('batch surfaces skipped rows with reason', rep.skipped === 2 && rep.wouldIngest === 0 && rep.rows.every(r => r.outcome === 'skipped' && /no_attribution/.test(r.reason || '')))
    ok('batch wrote nothing while skipping', nFacts(db) === 0) }
  { const db = freshDb(); grant(db, 'gA', 'usr_admin', 'usr_alice', { effective_from: T0 })
    auditAt(db, 'operator_claim.approve', T1); auditAt(db, 'operator_claim.reject', T2); auditAt(db, 'operator_claim.revoke', T3)
    const rep = ingestAdminCoordinationSince(db, { commit: false, limit: 2 })
    ok('--limit caps scanned candidates', rep.scanned === 2 && rep.limit === 2) }

  // ── BATCH: since-time cursor only ingests rows strictly after it ──
  { const db = freshDb(); grant(db, 'gA', 'usr_admin', 'usr_alice', { effective_from: T0 })
    auditAt(db, 'operator_claim.approve', T1); auditAt(db, 'operator_claim.revoke', T3)
    const rep = ingestAdminCoordinationSince(db, { commit: false, sinceTime: T2 })
    ok('since-time excludes earlier rows (only T3 row scanned)', rep.scanned === 1 && rep.rows[0].occurredAt === T3) }

  // ── P2 fix: a typo'd --since-id (unknown audit row) FAILS CLOSED, never a from-earliest scan ──
  { const db = freshDb(); grant(db, 'gA', 'usr_admin', 'usr_alice', { effective_from: T0 })
    auditAt(db, 'operator_claim.approve', T1)   // an early allowlisted row that a degraded scan WOULD ingest
    ok('unknown sinceId → throws invalid_cursor, NO scan/write', threw(() => ingestAdminCoordinationSince(db, { commit: true, sinceId: 'aud_typo_does_not_exist' })))
    ok('failed-cursor run wrote nothing', nFacts(db) === 0)
    // a VALID sinceId still works (resumes after that row)
    const realId = auditAt(db, 'operator_claim.revoke', T2)
    const rep = ingestAdminCoordinationSince(db, { commit: false, sinceId: realId })
    ok('valid sinceId resumes (excludes the cursor row itself)', rep.rows.every(r => r.auditId !== realId)) }

  // ── P2 fix: reserved CONCEPT actions are EXCLUDED from batch live selection (single-engine still works) ──
  { const db = freshDb(); grant(db, 'gA', 'usr_admin', 'usr_alice', { effective_from: T0 })
    const conceptAudit = auditAt(db, 'task_review', T1)   // a reserved concept name, allowlisted but NOT live
    const rep = ingestAdminCoordinationSince(db, { commit: true, sinceTime: T0 })
    ok('batch does NOT scan reserved concept rows (even when committing)', rep.scanned === 0 && nFacts(db) === 0)
    ok('LIVE set is exactly the 8 operator_claim.* (no concept names)', LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS.length === 8 && LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS.every(a => a.startsWith('operator_claim.')))
    ok('concept name task_review is NOT in the live set', !(LIVE_ADMIN_COORDINATION_AUDIT_ACTIONS as readonly string[]).includes('task_review'))
    // but the SINGLE-row engine can still ingest a concept row when targeted explicitly by auditId
    const single = ingestAdminCoordinationFact(db, { auditId: conceptAudit })
    ok('single-row engine STILL ingests a targeted concept row', single.ok === true && (single as any).status === 'ingested' && nFacts(db) === 1) }

  // ── P2 fix: --commit switch parsing (only bare/=true commits; anything else throws) ──
  ok('parseCommitSwitch(undefined) → dry-run (false)', parseCommitSwitch(undefined) === false)
  ok('parseCommitSwitch("") [bare --commit] → true', parseCommitSwitch('') === true)
  ok('parseCommitSwitch("true") → true', parseCommitSwitch('true') === true)
  ok('parseCommitSwitch("false") THROWS (not a silent write)', threw(() => parseCommitSwitch('false')))
  ok('parseCommitSwitch("0") THROWS', threw(() => parseCommitSwitch('0')))
  ok('parseCommitSwitch("no") THROWS', threw(() => parseCommitSwitch('no')))

  if (fail === 0) {
    console.log(`\n✅ admin-coordination ingestion pipeline: 8 real operator_claim.* actions wired (governance) · active-claim→fact (governance type, accountable_ref NULL, evidence traceable, resolver as-of) · idempotent · non-allowlist/no-claim/retro/revoked all fail-closed · no economic field · batch dry-run writes nothing / commit writes / re-commit idempotent · skip reasons surfaced · limit + since-time honored\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin-coordination ingestion pipeline FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
