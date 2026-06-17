/**
 * PR-F1 — GitHub identity-claim publication-challenge state (SCHEMA ONLY).
 *
 * Holds the server-side state of a publication challenge: the issued nonce (as a sha256 HASH — never
 * plaintext), bound to {account_id, github_actor_id, source_event_key}, with a single-use `status`
 * lifecycle. This is EPHEMERAL transactional state (issue → consume once), NOT an append-only audit
 * log — modeled on `webauthn_gate_tokens` (mutable, single-use via CAS). The future F2 engine performs
 * the single-use consume with a CAS UPDATE (`... WHERE status='issued' AND expires_at>now` → changes=1);
 * this PR only lays the fields + constraints that support that. No insert/update/delete helper is
 * exposed here, no engine, no endpoint.
 *
 * Constraints: nonce_hash UNIQUE (no nonce reuse); account_id FK→users; status enum CHECK; every
 * identity-determining field NOT NULL. `immutable=1` marks the row's identity fields as write-once and
 * blocks flipping `immutable` itself (consistent with the contribution table family) — it does NOT make
 * the row append-only; the sanctioned status CAS still migrates status/consumed_at.
 *
 * The initial status MUST be 'issued' — this IS enforced by the BEFORE INSERT trigger below (a plain
 * CHECK cannot be INSERT-scoped); consumed/expired/revoked are reachable only via the status CAS UPDATE.
 *
 * NB: SQL strings carry NO inline `--` comments (gen-pg-schema strips them → trailing whitespace).
 * FK enforcement relies on the connection's `PRAGMA foreign_keys = ON` (set in schema.ts).
 */
import type Database from 'better-sqlite3'

export function initIdentityClaimChallengeSchema(db: Database.Database): void {
  // DB-enforced state machine (Codex F1 P1) — illegal states must be rejected by the DB, not merely by
  // a future engine:
  //   - nonce_hash CHECK: a 64-char LOWERCASE sha256 hex digest, never a short/plaintext/upper value (P2).
  //     `length=64 AND NOT GLOB '*[^0-9a-f]*'` (no char outside lowercase hex). gen-pg-schema translates
  //     the GLOB to the PG regex `!~ '[^0-9a-f]'`.
  //   - consumed_at NOT NULL IFF status='consumed' (the row-level consistency CHECK below).
  //   - INSERT must be status='issued' (the BEFORE INSERT trigger below; a CHECK can't be INSERT-scoped).
  //     consumed/expired/revoked are only reachable FROM 'issued' via the sanctioned status CAS (UPDATE).
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_claim_challenges (
      challenge_id         TEXT PRIMARY KEY,
      account_id           TEXT NOT NULL REFERENCES users(id),
      github_actor_id      TEXT NOT NULL,
      source_event_key     TEXT NOT NULL,
      nonce_hash           TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
      status               TEXT NOT NULL CHECK (status IN ('issued','consumed','expired','revoked')),
      expires_at           TEXT NOT NULL,
      consumed_at          TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      immutable            INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
      CHECK ((status = 'consumed' AND consumed_at IS NOT NULL) OR (status <> 'consumed' AND consumed_at IS NULL))
    )
  `)
  // Supports the future CAS lookup "find the issued challenge for this account+github+source event".
  db.exec(`CREATE INDEX IF NOT EXISTS idx_icc_lookup ON identity_claim_challenges(account_id, github_actor_id, source_event_key)`)
  // INSERT-status guard: a row may only be created in 'issued' (the gen-pg-schema PG generator emits the
  // equivalent BEFORE INSERT trigger). Status then migrates issued→{consumed,expired,revoked} via UPDATE.
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_icc_insert_issued BEFORE INSERT ON identity_claim_challenges WHEN NEW.status <> 'issued' BEGIN SELECT RAISE(ABORT, 'identity_claim_challenges must be inserted with status=issued'); END`)
}
