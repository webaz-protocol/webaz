#!/usr/bin/env tsx
/**
 * PR-F1 — identity_claim_challenges schema DB-integrity test (fresh in-memory DB, foreign_keys=ON).
 *   用法:npm run test:identity-claim-challenge
 *
 * Proves every FK / UNIQUE / CHECK / NOT NULL **and the state machine** are enforced BY THE DATABASE
 * (not just by a future engine): a row may only be INSERTed as status='issued' with consumed_at NULL;
 * consumed_at IS NOT NULL iff status='consumed'; nonce_hash is a 64-char sha256 hex (no plaintext);
 * the sanctioned issued→consumed CAS still works. No engine/issuance logic (none in F1).
 */
import Database from 'better-sqlite3'
import { initIdentityClaimChallengeSchema } from '../src/layer2-business/L2-9-contribution/identity-claim-challenge-store.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const rejects = (name: string, fn: () => void): void => { let t = false; try { fn() } catch { t = true } ok(`DB rejects: ${name}`, t) }
const accepts = (name: string, fn: () => void): void => { let t = false, e = ''; try { fn() } catch (err) { t = true; e = (err as Error).message } ok(`DB accepts: ${name}`, !t, e) }

const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64)   // 64-char sha256-hex-shaped nonce hashes
/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','contributor','ka')`).run()
  initIdentityClaimChallengeSchema(db)
  return db
}
const base = { challenge_id: 'icc_1', account_id: 'usr_alice', github_actor_id: 'U_alice', source_event_key: 'github:R:P:merged', nonce_hash: H1, status: 'issued', expires_at: 't+', consumed_at: null as string | null }
const ins = (db: any, o: any = {}) => db.prepare(`INSERT INTO identity_claim_challenges (challenge_id,account_id,github_actor_id,source_event_key,nonce_hash,status,expires_at,consumed_at) VALUES (@challenge_id,@account_id,@github_actor_id,@source_event_key,@nonce_hash,@status,@expires_at,@consumed_at)`).run({ ...base, ...o })

// foreign_keys ON + happy path (issued + consumed_at NULL + 64-char nonce)
{ const db = freshDb()
  ok('PRAGMA foreign_keys = ON', db.pragma('foreign_keys', { simple: true }) === 1)
  accepts('valid challenge (issued, consumed_at NULL, 64-char nonce)', () => ins(db))
  const row = db.prepare(`SELECT immutable, created_at FROM identity_claim_challenges WHERE challenge_id='icc_1'`).get() as any
  ok('immutable defaults to 1', row.immutable === 1)
  ok('created_at auto-filled', typeof row.created_at === 'string' && row.created_at.length > 0) }

// FK + UNIQUE + NOT NULL
rejects('orphan account_id (FK)', () => { const d = freshDb(); ins(d, { account_id: 'usr_ghost' }) })
rejects('duplicate nonce_hash', () => { const d = freshDb(); ins(d); ins(d, { challenge_id: 'icc_2' }) })
accepts('distinct nonce_hash second row', () => { const d = freshDb(); ins(d); ins(d, { challenge_id: 'icc_2', nonce_hash: H2 }) })
for (const col of ['account_id', 'github_actor_id', 'source_event_key', 'nonce_hash', 'status', 'expires_at']) {
  rejects(`${col} NOT NULL`, () => { const d = freshDb(); ins(d, { [col]: null }) })
}

// status enum (only meaningful for the 'issued' INSERT — the trigger blocks other initial states below)
rejects('bad status (not in enum)', () => { const d = freshDb(); ins(d, { status: 'pending' }) })

// ── P1: state machine DB-enforced ──
// INSERT must be status='issued' (BEFORE INSERT trigger) — illegal initial states rejected.
rejects('initial status=consumed rejected (insert trigger)', () => { const d = freshDb(); ins(d, { status: 'consumed', consumed_at: 't' }) })
rejects('initial status=expired rejected (insert trigger)', () => { const d = freshDb(); ins(d, { status: 'expired' }) })
rejects('initial status=revoked rejected (insert trigger)', () => { const d = freshDb(); ins(d, { status: 'revoked' }) })
// consumed_at consistency CHECK (testable on INSERT for the issued case).
rejects("issued with consumed_at set rejected (consistency CHECK)", () => { const d = freshDb(); ins(d, { status: 'issued', consumed_at: 't' }) })
// sanctioned CAS issued→consumed (sets status + consumed_at together) works.
accepts('CAS issued→consumed (status+consumed_at together) works', () => {
  const d = freshDb(); ins(d)
  const r = d.prepare(`UPDATE identity_claim_challenges SET status='consumed', consumed_at=datetime('now') WHERE challenge_id='icc_1' AND status='issued'`).run()
  if (r.changes !== 1) throw new Error('CAS did not update exactly one row')
})
// CAS to consumed WITHOUT setting consumed_at violates the consistency CHECK.
rejects('UPDATE to consumed without consumed_at rejected (consistency CHECK)', () => { const d = freshDb(); ins(d); d.prepare(`UPDATE identity_claim_challenges SET status='consumed' WHERE challenge_id='icc_1'`).run() })
// issued→expired (consumed_at stays NULL) is consistent → allowed.
accepts('UPDATE issued→expired (consumed_at NULL) works', () => { const d = freshDb(); ins(d); d.prepare(`UPDATE identity_claim_challenges SET status='expired' WHERE challenge_id='icc_1'`).run() })

// ── P2: nonce_hash must be a 64-char LOWERCASE sha256 hex (no plaintext / short / non-hex / upper) ──
rejects('plaintext nonce (too short) rejected', () => { const d = freshDb(); ins(d, { nonce_hash: 'plaintext-nonce' }) })
rejects('63-char nonce rejected', () => { const d = freshDb(); ins(d, { nonce_hash: 'a'.repeat(63) }) })
rejects("64-char NON-hex nonce ('g'×64) rejected", () => { const d = freshDb(); ins(d, { nonce_hash: 'g'.repeat(64) }) })
rejects("64-char UPPERCASE hex ('A'×64) rejected (lowercase enforced)", () => { const d = freshDb(); ins(d, { nonce_hash: 'A'.repeat(64) }) })
accepts("64-char lowercase hex ('a'×64) accepted", () => { const d = freshDb(); ins(d, { nonce_hash: 'a'.repeat(64) }) })
accepts('mixed-digit lowercase hex (real-shaped) accepted', () => { const d = freshDb(); ins(d, { nonce_hash: '0123456789abcdef'.repeat(4) }) })

// immutable CHECK (insert + UPDATE flip), isolated with valid 64-char nonce + issued
rejects('immutable != 1 on insert', () => { const d = freshDb(); d.prepare(`INSERT INTO identity_claim_challenges (challenge_id,account_id,github_actor_id,source_event_key,nonce_hash,status,expires_at,immutable) VALUES ('icc_z','usr_alice','U','k',?, 'issued','t',0)`).run('d'.repeat(64)) })
rejects('UPDATE flipping immutable=0', () => { const d = freshDb(); ins(d); d.prepare(`UPDATE identity_claim_challenges SET immutable=0 WHERE challenge_id='icc_1'`).run() })

console.log('\ntest:identity-claim-challenge (schema, fresh in-memory DB)')
console.log('─────────────────────────────────────────────────────────')
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
console.log('✅ identity_claim_challenges: FK/UNIQUE/CHECK/NOT NULL + state machine (insert=issued, consumed_at⟺consumed) + 64-char nonce all DB-enforced\n')
