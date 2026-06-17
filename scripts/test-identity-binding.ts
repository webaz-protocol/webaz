#!/usr/bin/env tsx
/**
 * PR 4a — GitHub identity → WebAZ account binding: schema + engine + overlay tests.
 *   用法:npm run test:identity-binding
 *
 * Fresh in-memory SQLite (`PRAGMA foreign_keys = ON` + minimal users + binding schema + setSeamDb).
 * The engine takes an ALREADY-VERIFIED githubActorId (4a); the proof flow + Passkey gate are 4b.
 *
 * Counter-examples first: DB-enforced constraints (CHECK/PK/FK/immutable) · the bind/revoke/rebind
 * state machine · double-bind refused · PG fail-closed · append-only EVENT LOG (only INSERT) ·
 * the accountable read-overlay (current binding; null after revoke; non-github → null).
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb, setSeamBackend } from '../src/layer0-foundation/L0-1-database/db.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { bindGithubIdentity, revokeGithubIdentityBinding, resolveAccountable } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) }
}
function rejects(name: string, fn: () => void): void { let t = false; try { fn() } catch { t = true } ok(`DB rejects: ${name}`, t) }
function accepts(name: string, fn: () => void): void { let t = false, e = ''; try { fn() } catch (err) { t = true; e = (err as Error).message } ok(`DB accepts: ${name}`, !t, e) }
const threwOn = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','contributor','k_alice'),('usr_bob','Bob','contributor','k_bob')`).run()
  initIdentityBindingSchema(db)
  setSeamDb(db)
  return db
}
const nEvents = (db: any): number => (db.prepare('SELECT COUNT(*) c FROM identity_binding_events').get() as any).c
const nActive = (db: any): number => (db.prepare('SELECT COUNT(*) c FROM identity_bindings_active').get() as any).c
const insEvent = (db: any, o: any = {}) => db.prepare(`INSERT INTO identity_binding_events (event_id,event_type,github_actor_id,account_id,visibility,proof_method,proof_ref,supersedes_event_id,immutable) VALUES (@event_id,@event_type,@github_actor_id,@account_id,@visibility,@proof_method,@proof_ref,@supersedes_event_id,@immutable)`).run({ event_id: 'ibe_1', event_type: 'bound', github_actor_id: 'U_x', account_id: 'usr_alice', visibility: 'private', proof_method: 'github_publication_challenge', proof_ref: null, supersedes_event_id: null, immutable: 1, ...o })

async function main(): Promise<void> {
  // ── SCHEMA: DB-enforced constraints (fresh in-memory, foreign_keys=ON) ──
  { const db = freshDb()
    ok('PRAGMA foreign_keys = ON', db.pragma('foreign_keys', { simple: true }) === 1)
    accepts('valid bound event', () => insEvent(db))
    rejects('bad event_type', () => { const d = freshDb(); insEvent(d, { event_type: 'deleted' }) })
    rejects('bad visibility', () => { const d = freshDb(); insEvent(d, { visibility: 'world' }) })
    rejects('bad proof_method', () => { const d = freshDb(); insEvent(d, { proof_method: 'trust_me' }) })
    rejects('immutable != 1 on event', () => { const d = freshDb(); insEvent(d, { immutable: 0 }) })
    rejects('UPDATE flipping immutable=0 on event', () => { const d = freshDb(); insEvent(d); d.prepare(`UPDATE identity_binding_events SET immutable=0 WHERE event_id='ibe_1'`).run() })
    rejects('event account_id orphan FK', () => { const d = freshDb(); insEvent(d, { account_id: 'usr_ghost' }) })
    rejects('event supersedes_event_id orphan FK', () => { const d = freshDb(); insEvent(d, { event_id: 'ibe_2', supersedes_event_id: 'ibe_nope' }) }) }

  // visibility defaults to 'private' (never public by default)
  { const db = freshDb()
    db.prepare(`INSERT INTO identity_binding_events (event_id,event_type,github_actor_id,account_id,proof_method) VALUES ('ibe_d','bound','U_x','usr_alice','github_publication_challenge')`).run()
    const row = db.prepare(`SELECT visibility FROM identity_binding_events WHERE event_id='ibe_d'`).get() as any
    ok("visibility defaults to 'private' (never public)", row.visibility === 'private') }

  // active projection PK ⇒ at most one active binding per github id (threat T3)
  { const db = freshDb()
    insEvent(db); insEvent(db, { event_id: 'ibe_2', account_id: 'usr_bob' })   // ibe_2 matches the 2nd active row, so ONLY the PK is violated
    db.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_alice','private','ibe_1','t')`).run()
    rejects('second ACTIVE binding for same github id (PK)', () => db.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_bob','private','ibe_2','t')`).run())
    rejects('active bound_event_id orphan FK', () => { const d = freshDb(); d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_y','usr_alice','private','ibe_nope','t')`).run() })
    rejects('active account_id orphan FK', () => { const d = freshDb(); insEvent(d); d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_y','usr_ghost','private','ibe_1','t')`).run() }) }

  // ── #300 DB-integrity: req1 immutable event log + req2 projection↔event consistency (DB-rejected) ──
  // req1: the event log is immutable — even a non-CHECK column UPDATE, and any DELETE, are blocked by
  // the BEFORE UPDATE/DELETE triggers (not merely the immutable=1 CHECK).
  rejects('req1: UPDATE an event row (non-CHECK column) → trigger ABORT', () => { const d = freshDb(); insEvent(d); d.prepare(`UPDATE identity_binding_events SET proof_ref='x' WHERE event_id='ibe_1'`).run() })
  rejects('req1: DELETE an event row → trigger ABORT', () => { const d = freshDb(); insEvent(d); d.prepare(`DELETE FROM identity_binding_events WHERE event_id='ibe_1'`).run() })
  // req2: a projection row whose actor/account/visibility disagree with the referenced event → composite FK reject.
  rejects('req2: active.account_id != bound event account → composite FK reject', () => {
    const d = freshDb(); insEvent(d)   // ibe_1 = (U_x, usr_alice, private, bound)
    d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_bob','private','ibe_1','t')`).run()
  })
  rejects('req2: active.visibility != bound event visibility → composite FK reject', () => {
    const d = freshDb(); insEvent(d)
    d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_alice','public','ibe_1','t')`).run()
  })
  // req2: the projection may only reference a `bound` event, never a `revoked` one (event_type pinned).
  rejects('req2: active referencing a REVOKED event → rejected', () => {
    const d = freshDb(); insEvent(d, { event_id: 'ibe_rev', event_type: 'revoked' })   // (U_x, usr_alice, private, revoked)
    d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_alice','private','ibe_rev','t')`).run()
  })
  // positive control: a projection row fully matching its bound event is accepted.
  accepts('req2: projection matching its bound event is accepted', () => {
    const d = freshDb(); insEvent(d)
    d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_alice','private','ibe_1','t')`).run()
  })
  // req3: ref_event_type is CHECK-pinned to 'bound' (a 'revoked' value rejected by the DB).
  rejects("req2: active.ref_event_type='revoked' rejected by CHECK", () => {
    const d = freshDb(); insEvent(d)
    d.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,ref_event_type,bound_at) VALUES ('U_x','usr_alice','private','ibe_1','revoked','t')`).run()
  })

  // ── #300 structure-detection gap (Codex): a HALF-migrated active (ref_event_type column present but
  //    composite FK MISSING) must NOT be mistaken for current — init must rebuild (empty) / fail-closed,
  //    never silently keep the broken structure that lets mismatched projections through. ──
  { const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
    db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','contributor','ka'),('usr_bob','Bob','contributor','kb')`).run()
    db.exec(`CREATE TABLE identity_binding_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL CHECK(event_type IN ('bound','revoked')), github_actor_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES users(id), visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')), proof_method TEXT NOT NULL CHECK(proof_method IN ('github_publication_challenge','admin_manual')), proof_ref TEXT, supersedes_event_id TEXT REFERENCES identity_binding_events(event_id), created_at TEXT NOT NULL DEFAULT (datetime('now')), immutable INTEGER NOT NULL DEFAULT 1 CHECK(immutable=1), UNIQUE(event_id,event_type,github_actor_id,account_id,visibility))`)
    // active HAS ref_event_type column + CHECK, but NO composite FK (the half-migrated gap)
    db.exec(`CREATE TABLE identity_bindings_active (github_actor_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES users(id), visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')), bound_event_id TEXT NOT NULL, ref_event_type TEXT NOT NULL DEFAULT 'bound' CHECK(ref_event_type='bound'), bound_at TEXT NOT NULL)`)
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_ibe_no_update BEFORE UPDATE ON identity_binding_events BEGIN SELECT RAISE(ABORT,'no'); END`)
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_ibe_no_delete BEFORE DELETE ON identity_binding_events BEGIN SELECT RAISE(ABORT,'no'); END`)
    setSeamDb(db)
    ok('half-structure: detected as NOT current (composite FK missing) and rebuilt (empty, no throw)', !threwOn(() => initIdentityBindingSchema(db)))
    // after rebuild the composite FK exists → a mismatched projection is now DB-rejected
    insEvent(db)   // ibe_1 = (U_x, usr_alice, private, bound)
    ok('half-structure: rebuilt shape rejects a mismatched projection', threwOn(() => db.prepare(`INSERT INTO identity_bindings_active (github_actor_id,account_id,visibility,bound_event_id,bound_at) VALUES ('U_x','usr_bob','private','ibe_1','t')`).run())) }

  // ── ENGINE: bind / already_bound / already_bound_to_other ──
  { const db = freshDb()
    const r = await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge', proofRef: 'gist_1' })
    ok('bind → bound', r.ok && r.status === 'bound', JSON.stringify(r))
    ok('bind: one event + one active row', nEvents(db) === 1 && nActive(db) === 1)
    const act = db.prepare(`SELECT * FROM identity_bindings_active WHERE github_actor_id='U_alice'`).get() as any
    ok('bind: active maps to account, visibility default private', act.account_id === 'usr_alice' && act.visibility === 'private')
    const r2 = await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    ok('bind same (github, same account) → already_bound, no new writes', r2.ok && r2.status === 'already_bound' && nEvents(db) === 1 && nActive(db) === 1, JSON.stringify(r2))
    const r3 = await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_bob', proofMethod: 'github_publication_challenge' })
    ok('bind same github → DIFFERENT account → refused already_bound_to_other', !r3.ok && r3.reason === 'already_bound_to_other', JSON.stringify(r3))
    ok('bind to other: no writes', nEvents(db) === 1 && nActive(db) === 1) }

  // ── ENGINE: revoke / not_owner / not_bound / rebind ──
  { const db = freshDb()
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    const wrong = await revokeGithubIdentityBinding({ githubActorId: 'U_alice', accountId: 'usr_bob', proofMethod: 'github_publication_challenge' })
    ok('revoke by non-owner → refused not_owner', !wrong.ok && wrong.reason === 'not_owner', JSON.stringify(wrong))
    ok('revoke by non-owner: no writes (still bound)', nActive(db) === 1)
    const rv = await revokeGithubIdentityBinding({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    ok('revoke by owner → revoked', rv.ok && rv.status === 'revoked', JSON.stringify(rv))
    ok('revoke: event appended (2), active row removed (0)', nEvents(db) === 2 && nActive(db) === 0)
    const supersedes = db.prepare(`SELECT supersedes_event_id FROM identity_binding_events WHERE event_type='revoked'`).get() as any
    ok('revoke: revoked event supersedes the bound event', !!supersedes.supersedes_event_id)
    const again = await revokeGithubIdentityBinding({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    ok('revoke when not bound → refused not_bound', !again.ok && again.reason === 'not_bound')
    // rebind: now bob can bind the same github id
    const rb = await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_bob', proofMethod: 'github_publication_challenge' })
    ok('rebind to a new account after revoke → bound', rb.ok && rb.status === 'bound', JSON.stringify(rb))
    ok('rebind: 3 events total (bound, revoked, bound), 1 active', nEvents(db) === 3 && nActive(db) === 1)
    const act = db.prepare(`SELECT account_id FROM identity_bindings_active WHERE github_actor_id='U_alice'`).get() as any
    ok('rebind: active now points to the new account', act.account_id === 'usr_bob') }

  // ── ENGINE: admin_manual lets governance override the owner check ──
  { const db = freshDb()
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    const adm = await revokeGithubIdentityBinding({ githubActorId: 'U_alice', accountId: 'usr_bob', proofMethod: 'admin_manual', proofRef: 'gov-case-1' })
    ok('admin_manual revoke overrides owner check', adm.ok && adm.status === 'revoked', JSON.stringify(adm))
    ok('admin_manual revoke: active removed', nActive(db) === 0) }

  // ── OVERLAY: resolveAccountable ──
  { const db = freshDb()
    await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    const acc = await resolveAccountable('github:U_alice')
    ok('overlay: bound github executor → webaz:<account> + private', !!acc && acc.accountable_ref === 'webaz:usr_alice' && acc.visibility === 'private', JSON.stringify(acc))
    ok('overlay: unbound github executor → null', (await resolveAccountable('github:U_unbound')) === null)
    ok('overlay: non-github executor → null', (await resolveAccountable('webaz:usr_alice')) === null)
    await revokeGithubIdentityBinding({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    ok('overlay: after revoke → null', (await resolveAccountable('github:U_alice')) === null) }

  // ── PG backend → fail-closed (no sqlite handle) ──
  { setSeamBackend({ kind: 'pg', one: async () => undefined, all: async () => [], run: async () => ({ changes: 0, lastInsertRowid: 0 }) })
    const r = await bindGithubIdentity({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    ok('PG backend → bind refused backend_unsupported', !r.ok && r.reason === 'backend_unsupported', JSON.stringify(r))
    const rv = await revokeGithubIdentityBinding({ githubActorId: 'U_alice', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    ok('PG backend → revoke refused backend_unsupported', !rv.ok && rv.reason === 'backend_unsupported') }

  // ── APPEND-ONLY EVENT LOG: engine never UPDATE/DELETEs identity_binding_events ──
  { const db = freshDb()
    const prepared: string[] = []
    const origPrepare = db.prepare.bind(db)
    ;(db as any).prepare = (sql: string) => { prepared.push(sql); return origPrepare(sql) }
    await bindGithubIdentity({ githubActorId: 'U_a', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    await revokeGithubIdentityBinding({ githubActorId: 'U_a', accountId: 'usr_alice', proofMethod: 'github_publication_challenge' })
    await bindGithubIdentity({ githubActorId: 'U_a', accountId: 'usr_bob', proofMethod: 'github_publication_challenge' })
    ;(db as any).prepare = origPrepare
    const eventLogWrites = prepared.filter(s => /identity_binding_events/.test(s))
    ok('append-only: every event-log statement is SELECT or INSERT (no UPDATE/DELETE)',
      eventLogWrites.length > 0 && eventLogWrites.every(s => /^\s*(SELECT|INSERT)\b/i.test(s)), eventLogWrites.filter(s => !/^\s*(SELECT|INSERT)\b/i.test(s)).join(' | '))
    // static backstop on the engine source
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'layer2-business', 'L2-9-contribution', 'identity-binding-engine.ts'), 'utf8')
    const prepareCalls = src.match(/db\.prepare\(`?[^`)]*`?\)/g) ?? []
    ok('append-only: no UPDATE/DELETE on identity_binding_events in engine source',
      !prepareCalls.some(p => /identity_binding_events/.test(p) && /\b(UPDATE|DELETE)\b/i.test(p))) }

  console.log('\ntest:identity-binding')
  console.log('─────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ all PR 4a identity-binding cases pass (DB-enforced invariants; append-only event log; PG fail-closed)\n')
}

main().catch(e => { console.error(e); process.exit(1) })
