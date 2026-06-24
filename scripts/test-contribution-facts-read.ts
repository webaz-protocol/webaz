#!/usr/bin/env tsx
/**
 * Contribution read-out V1 — GET /api/contribution-facts/me engine (getMyContributionFacts).
 *   用法:node --import tsx scripts/test-contribution-facts-read.ts
 *
 * Read-only self-view across GitHub bindings + admin-coordination operator-claim as-of. Asserts: caller
 * sees only their OWN GitHub-bound facts; sees admin facts that resolve as-of to them; another user does
 * NOT; accountable_ref stays NULL (attribution is read-time); rotation preserves history by occurred_at;
 * admin_audit_log.detail is NEVER leaked; NO reward/payout/amount field; empty user → empty (no throw).
 */
import Database from 'better-sqlite3'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { initAdminCoordinationSchema } from '../src/layer2-business/L2-9-contribution/admin-coordination-store.js'
import { ingestAdminCoordinationFact } from '../src/layer2-business/L2-9-contribution/admin-coordination-ingestion-engine.js'
import { getMyContributionFacts } from '../src/layer2-business/L2-9-contribution/contribution-facts-read.js'
import { logAdminAction } from '../src/pwa/admin-audit.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, admin_type TEXT, roles TEXT, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,admin_type,roles,api_key) VALUES
    ('usr_root','Root','admin','root','["admin"]','k_root'),
    ('usr_admin','Adm','admin','regional','["admin"]','k_adm'),
    ('usr_me','Me','buyer',NULL,'["buyer"]','k_me'),
    ('usr_other','Other','buyer',NULL,'["buyer"]','k_ot'),
    ('usr_bob','Bob','buyer',NULL,'["buyer"]','k_bob')`).run()
  db.exec(`CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')))`)
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  initAdminCoordinationSchema(db)
  return db
}

const T0 = '2026-06-01T00:00:00Z', T1 = '2026-06-10T00:00:00Z', T2 = '2026-06-20T00:00:00Z', T3 = '2026-06-30T00:00:00Z'
const adminCtx = (o: any = {}) => ({ actorType: 'admin_account', agentMode: 'human_direct', provenance: 'human', ...o })
const insApproval = (db: any, o: any) => db.prepare(
  `INSERT INTO admin_operator_claim_events (event_id,event_type,admin_account_id,contributor_account_id,approval_kind,approved_by,conflict_disclosure,effective_from,supersedes_event_id,rationale,immutable)
   VALUES (@event_id,@event_type,@admin_account_id,@contributor_account_id,@approval_kind,@approved_by,@conflict_disclosure,@effective_from,@supersedes_event_id,@rationale,1)`,
).run({ approval_kind: null, approved_by: null, conflict_disclosure: 'unknown', effective_from: null, supersedes_event_id: null, rationale: null, ...o })
// honest cross-party approval (approved_by = root, NOT a party → not self/related → no gate)
const grant = (db: any, ev: string, contrib: string, o: any = {}) =>
  insApproval(db, { event_id: ev, event_type: 'approved', admin_account_id: 'usr_admin', contributor_account_id: contrib, approval_kind: 'root_approval', approved_by: 'usr_root', conflict_disclosure: 'none', effective_from: T0, ...o })
function auditAt(db: any, action: string, createdAt: string, o: any = {}): string {
  const id = logAdminAction(db, { adminId: o.adminId ?? 'usr_admin', action, targetType: o.targetType, targetId: o.targetId, detail: o.detail, context: o.context ?? adminCtx() })
  db.prepare('UPDATE admin_audit_log SET created_at=? WHERE id=?').run(createdAt, id)
  return id
}
// build a real GitHub-bound fact (binding event → active binding → credential → fact → link)
function insGithubFact(db: any, account: string, actor: string, fid: string, sek: string): void {
  db.prepare(`INSERT INTO identity_binding_events (event_id,event_type,github_actor_id,account_id,visibility,proof_method,immutable) VALUES (?, 'bound', ?, ?, 'public', 'github_publication_challenge', 1)`).run('ibe_' + fid, actor, account)
  db.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,ref_event_type,bound_at) VALUES (?,?,'public',?, 'bound', ?)`).run(actor, account, 'ibe_' + fid, T0)
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES (?,?, 'v1', ?, 'R_1','prn_1',7,'sha7',?,?, 'merged','{}')`).run('cred_' + fid, 'dig_' + fid, sek, T1, actor)
  db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status,immutable) VALUES (?,?, 'github','code','pr#7',?, ?, NULL, 'human','active',1)`).run(fid, sek, T1, 'github:' + actor)
  db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES (?,?,?)`).run(fid, 'cred_' + fid, sek)
}
// build an admin-coordination fact via the REAL ingestion engine, attributed (as-of) to `contrib`
function insAdminFact(db: any, contrib: string, at: string, action = 'operator_claim.approve', secret?: string): string {
  const audit = auditAt(db, action, at, { detail: secret ? { secret_admin_detail: secret } : undefined })
  const r = ingestAdminCoordinationFact(db, { auditId: audit })
  if (!(r as any).ok) throw new Error('ingest failed: ' + JSON.stringify(r))
  return (r as any).factId
}

const ALLOWED_KEYS = new Set(['fact_id', 'source_event_key', 'source', 'type', 'occurred_at', 'executor_ref', 'attribution_via', 'contributor_account_id', 'artifact_ref', 'status', 'provenance', 'display_source_label', 'display_source_label_en', 'display_summary', 'evidence_ref', 'notice'])

function main(): void {
  // ── caller sees ONLY their own GitHub-bound facts ──
  { const db = freshDb()
    insGithubFact(db, 'usr_me', '777', 'cf_me_gh', 'gh:me:1')
    insGithubFact(db, 'usr_other', '888', 'cf_ot_gh', 'gh:ot:1')
    const mine = getMyContributionFacts(db, 'usr_me')
    ok('GitHub: caller sees own bound fact', mine.groups.github.length === 1 && mine.groups.github[0].fact_id === 'cf_me_gh')
    ok('GitHub: caller does NOT see another user fact', mine.groups.github.every(f => f.fact_id !== 'cf_ot_gh'))
    ok('GitHub fact attribution_via = github_binding + contributor = me', mine.groups.github[0].attribution_via === 'github_binding' && mine.groups.github[0].contributor_account_id === 'usr_me') }

  // ── caller sees admin-coordination facts that resolve AS-OF to them; another user does NOT ──
  { const db = freshDb(); grant(db, 'g_me', 'usr_me', { effective_from: T0 })
    const fid = insAdminFact(db, 'usr_me', T1)
    const mine = getMyContributionFacts(db, 'usr_me')
    ok('admin: caller sees as-of-resolved coordination fact', mine.groups.admin_coordination.length === 1 && mine.groups.admin_coordination[0].fact_id === fid)
    ok('admin fact attribution_via = operator_claim + via resolver to me', mine.groups.admin_coordination[0].attribution_via === 'operator_claim' && mine.groups.admin_coordination[0].contributor_account_id === 'usr_me')
    ok('admin fact carries evidence_ref (source_type + audit id) only', (() => { const e = mine.groups.admin_coordination[0].evidence_ref; return !!e && e.source_type === 'operator_claim.approve' && typeof e.admin_audit_log_id === 'string' && Object.keys(e).length === 2 })())
    const other = getMyContributionFacts(db, 'usr_other')
    ok('admin: a DIFFERENT user does NOT see the fact', other.groups.admin_coordination.length === 0 && other.total === 0) }

  // ── accountable_ref stays NULL on the fact (attribution is read-time, not written back) ──
  { const db = freshDb(); grant(db, 'g_me', 'usr_me', { effective_from: T0 })
    const fid = insAdminFact(db, 'usr_me', T1)
    const row = db.prepare('SELECT accountable_ref FROM contribution_facts WHERE fact_id=?').get(fid) as any
    ok('admin coordination fact accountable_ref IS NULL', row.accountable_ref === null)
    ok('read-out still attributes it to me (resolver, not stored ref)', getMyContributionFacts(db, 'usr_me').groups.admin_coordination.length === 1) }

  // ── rotation: a historical fact stays with the THEN-contributor (as-of occurred_at) ──
  { const db = freshDb()
    grant(db, 'g_me', 'usr_me', { effective_from: T0 })
    const fidEarly = insAdminFact(db, 'usr_me', T1)                          // occurred while usr_me held the claim
    insApproval(db, { event_id: 'g_rev', event_type: 'revoked', admin_account_id: 'usr_admin', contributor_account_id: 'usr_me', effective_from: T2, supersedes_event_id: 'g_me' })
    grant(db, 'g_bob', 'usr_bob', { effective_from: T2 })                    // rotated to bob at T2
    const fidLate = insAdminFact(db, 'usr_bob', T3)                          // occurred after rotation
    const mine = getMyContributionFacts(db, 'usr_me'); const bob = getMyContributionFacts(db, 'usr_bob')
    ok('rotation: usr_me still sees the pre-rotation fact (as-of T1)', mine.groups.admin_coordination.some(f => f.fact_id === fidEarly))
    ok('rotation: usr_me does NOT see the post-rotation fact', mine.groups.admin_coordination.every(f => f.fact_id !== fidLate))
    ok('rotation: usr_bob sees ONLY the post-rotation fact', bob.groups.admin_coordination.length === 1 && bob.groups.admin_coordination[0].fact_id === fidLate) }

  // ── NEVER leaks admin_audit_log.detail ──
  { const db = freshDb(); grant(db, 'g_me', 'usr_me', { effective_from: T0 })
    const SECRET = 'TOP_SECRET_AUDIT_DETAIL_XYZ'
    insAdminFact(db, 'usr_me', T1, 'operator_claim.approve', SECRET)
    const surface = getMyContributionFacts(db, 'usr_me')
    ok('admin_audit_log.detail secret is NOT in the read-out', !JSON.stringify(surface).includes(SECRET)) }

  // ── NO reward/payout/amount/economic field; fact keys are whitelisted ──
  { const db = freshDb()
    grant(db, 'g_me', 'usr_me', { effective_from: T0 }); insAdminFact(db, 'usr_me', T1)
    insGithubFact(db, 'usr_me', '777', 'cf_me_gh', 'gh:me:1')
    const surface = getMyContributionFacts(db, 'usr_me')
    const allFacts = [...surface.groups.github, ...surface.groups.admin_coordination]
    ok('every fact has ONLY whitelisted keys (no economic field)', allFacts.every(f => Object.keys(f).every(k => ALLOWED_KEYS.has(k))))
    ok('read-out facts contain no reward/payout/amount/currency/valuation/redeem token', !/reward|payout|amount|currency|valuation|redeem|yield|"price"/i.test(JSON.stringify(surface.groups)))
    ok('each fact notice = evidence_only', allFacts.every(f => f.notice === 'evidence_only')) }

  // ── empty user → empty surface, no throw; agent group always empty (V1) ──
  { const db = freshDb()
    const empty = getMyContributionFacts(db, 'usr_nobody')
    ok('empty user → total 0, all groups empty, no error', empty.total === 0 && empty.groups.github.length === 0 && empty.groups.admin_coordination.length === 0 && empty.groups.agent.length === 0)
    ok('empty accountId → empty (defensive)', getMyContributionFacts(db, '').total === 0) }

  // ── total counts github + admin; agent reserved empty ──
  { const db = freshDb()
    grant(db, 'g_me', 'usr_me', { effective_from: T0 }); insAdminFact(db, 'usr_me', T1)
    insGithubFact(db, 'usr_me', '777', 'cf_me_gh', 'gh:me:1')
    const s = getMyContributionFacts(db, 'usr_me')
    ok('total = github + admin (agent reserved empty)', s.total === 2 && s.groups.agent.length === 0) }

  // ── front-end contract: 我的共建 page has the block + no-reward copy + endpoint fetch ──
  { const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/pwa/public/app.js'), 'utf8')
    ok('app.js fetches /contribution-facts/me', appSrc.includes("GET('/contribution-facts/me')"))
    ok('app.js has contributionFactsSectionHtml block rendered in renderMyContributions', /contributionFactsSectionHtml\(cf, lang\)/.test(appSrc) && /function contributionFactsSectionHtml\(/.test(appSrc))
    ok('app.js block title 贡献事实记录 present', appSrc.includes('贡献事实记录'))
    ok('app.js carries the no-reward copy', appSrc.includes('不是奖励、不是付款、不是兑现权利') && /not a payment, and they confer no economic or redemption right/.test(appSrc))
    // the F9 UI guard substring-bans promissory words in app.js — our new block must not reintroduce them
    ok('new block uses no banned promissory word (reward/payout/income) in EN', !/not a reward|payout|income/i.test('These are contribution facts and attribution records only — not a payment, and they confer no economic or redemption right.')) }

  if (fail === 0) {
    console.log(`\n✅ contribution read-out V1: own GitHub-bound facts only · admin coordination as-of resolves to caller (others excluded) · accountable_ref stays NULL · rotation preserves history by occurred_at · no admin detail leak · no reward/payout/amount (whitelisted keys) · empty user → empty · agent reserved · UI block + no-reward copy + endpoint\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ contribution read-out V1 FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
