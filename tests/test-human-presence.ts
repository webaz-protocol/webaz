// PR-F0 — unit tests for the REAL human-presence gate (createHumanPresence), incl. the new
// `identity_claim` purpose. Exercises the actual extracted functions (not a copy): single-use,
// purpose-bound, expiry, param toggle, is_system bypass, cross-user/cross-purpose rejection.
import Database from 'better-sqlite3'
import { createHumanPresence } from '../src/pwa/human-presence.js'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, h?: unknown) => { if (c) { pass++ } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT);
    CREATE TABLE verifier_whitelist (user_id TEXT PRIMARY KEY, is_system INTEGER DEFAULT 0);
    CREATE TABLE arbitrator_whitelist (user_id TEXT PRIMARY KEY, is_system INTEGER DEFAULT 0);
  `)
  return db
}
// simulate routes/webauthn.ts finish step: insert a gate token row
function issue(db: Database.Database, o: { id: string; user?: string; purpose: string; purpose_data?: string | null; ttlSec?: number }): void {
  const ttl = o.ttlSec ?? 60
  db.prepare(`INSERT INTO webauthn_gate_tokens (id,user_id,purpose,purpose_data,expires_at) VALUES (?,?,?,?, datetime('now', ?))`)
    .run(o.id, o.user ?? 'u1', o.purpose, o.purpose_data ?? null, `${ttl >= 0 ? '+' : ''}${ttl} seconds`)
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const getParam = (overrides: Record<string, number> = {}) => <T,>(k: string, fb: T): T => (k in overrides ? (overrides[k] as unknown as T) : fb)
const CLAIM = 'require_human_presence_for_identity_claim'

// ── identity_claim: issue → verify → consume (enforced by default param fallback=1) ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  issue(db, { id: 't_ok', purpose: 'identity_claim' })
  ok('identity_claim: valid token → ok', requireHumanPresence('u1', 'identity_claim', 't_ok', CLAIM).ok) }

// ── missing token → refused ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  const r = requireHumanPresence('u1', 'identity_claim', undefined, CLAIM)
  ok('identity_claim: missing token → refused + HUMAN_PRESENCE_REQUIRED', !r.ok && r.error_code === 'HUMAN_PRESENCE_REQUIRED', r) }

// ── replay (same token twice) → 2nd refused ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  issue(db, { id: 't_replay', purpose: 'identity_claim' })
  ok('identity_claim: 1st consume ok', requireHumanPresence('u1', 'identity_claim', 't_replay', CLAIM).ok)
  ok('identity_claim: replay refused (single-use)', !requireHumanPresence('u1', 'identity_claim', 't_replay', CLAIM).ok) }

// ── expired token → refused ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  issue(db, { id: 't_exp', purpose: 'identity_claim', ttlSec: -10 })
  ok('identity_claim: expired token → refused', !requireHumanPresence('u1', 'identity_claim', 't_exp', CLAIM).ok) }

// ── wrong purpose: token minted for delete_passkey can't satisfy identity_claim (and vice-versa) ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  issue(db, { id: 't_dp', purpose: 'delete_passkey' })
  ok('cross-purpose: delete_passkey token rejected for identity_claim', !requireHumanPresence('u1', 'identity_claim', 't_dp', CLAIM).ok)
  issue(db, { id: 't_ic', purpose: 'identity_claim' })
  ok('cross-purpose: identity_claim token rejected for delete_passkey', !requireHumanPresence('u1', 'delete_passkey', 't_ic', 'require_human_presence_for_delete_passkey').ok) }

// ── cross-user: token minted for u1 can't be consumed by u2 ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  issue(db, { id: 't_u1', user: 'u1', purpose: 'identity_claim' })
  ok('cross-user: u2 cannot consume u1 token', !requireHumanPresence('u2', 'identity_claim', 't_u1', CLAIM).ok) }

// ── protocol param toggle: =0 disables enforcement (no token needed); default(1) enforces ──
{ const db = freshDb()
  const off = createHumanPresence(db, getParam({ [CLAIM]: 0 }))
  ok('param=0 → not enforced (ok without token)', off.requireHumanPresence('u1', 'identity_claim', undefined, CLAIM).ok)
  const on = createHumanPresence(db, getParam())   // fallback 1
  ok('param default(1) → enforced (refused without token)', !on.requireHumanPresence('u1', 'identity_claim', undefined, CLAIM).ok) }

// ── purpose_data validate hook still applies for identity_claim ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  issue(db, { id: 't_pd', purpose: 'identity_claim', purpose_data: JSON.stringify({ github_actor_id: 'U_alice' }) })
  ok('purpose_data validate false → refused', !requireHumanPresence('u1', 'identity_claim', 't_pd', CLAIM, (d: any) => d?.github_actor_id === 'U_bob').ok)
  issue(db, { id: 't_pd2', purpose: 'identity_claim', purpose_data: JSON.stringify({ github_actor_id: 'U_alice' }) })
  ok('purpose_data validate true → ok', requireHumanPresence('u1', 'identity_claim', 't_pd2', CLAIM, (d: any) => d?.github_actor_id === 'U_alice').ok) }

// ── NO REGRESSION: existing purposes still work ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  for (const [purpose, param] of [['agent_revoke', 'require_human_presence_for_agent_revoke'], ['delete_passkey', 'require_human_presence_for_delete_passkey'], ['vote', 'require_human_presence_for_vote'], ['arbitrate', 'require_human_presence_for_arbitrate']] as const) {
    issue(db, { id: `t_${purpose}`, purpose })
    ok(`no-regression: ${purpose} valid token → ok`, requireHumanPresence('u1', purpose as any, `t_${purpose}`, param).ok)
    ok(`no-regression: ${purpose} missing token → refused`, !requireHumanPresence('u1', purpose as any, undefined, param).ok)
  } }

// ── NO REGRESSION: is_system bypass still only for vote/arbitrate (no token needed); not for identity_claim ──
{ const db = freshDb(); const { requireHumanPresence } = createHumanPresence(db, getParam())
  db.prepare("INSERT INTO verifier_whitelist (user_id, is_system) VALUES ('sysv', 1)").run()
  db.prepare("INSERT INTO arbitrator_whitelist (user_id, is_system) VALUES ('sysa', 1)").run()
  ok('is_system bypass: vote sysv ok without token', requireHumanPresence('sysv', 'vote', undefined, 'require_human_presence_for_vote').ok)
  ok('is_system bypass: arbitrate sysa ok without token', requireHumanPresence('sysa', 'arbitrate', undefined, 'require_human_presence_for_arbitrate').ok)
  ok('is_system does NOT bypass identity_claim', !requireHumanPresence('sysv', 'identity_claim', undefined, CLAIM).ok) }

console.log(`\ntest:human-presence\n───────────────────\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n`)
if (fail > 0) process.exit(1)
console.log('✅ real human-presence gate verified: identity_claim issue/consume/replay/expiry/wrong-purpose/cross-user/param + no regression\n')
