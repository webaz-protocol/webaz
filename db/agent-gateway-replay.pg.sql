-- RFC-028 S1c2 operational PostgreSQL replay authority.
-- Run with a migration owner before enabling DPoP. The application role needs
-- SELECT, INSERT, UPDATE and DELETE only; it does not need CREATE privileges.
BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_gateway_replay;

CREATE TABLE IF NOT EXISTS agent_gateway_replay.claims_v1 (
  proof_kind TEXT NOT NULL
    CHECK (proof_kind IN ('dpop','request_signature','private_key_jwt','server_nonce')),
  replay_scope_hash TEXT NOT NULL
    CHECK (replay_scope_hash ~ '^[0-9a-f]{64}$'),
  replay_key_hash TEXT NOT NULL
    CHECK (replay_key_hash ~ '^[0-9a-f]{64}$'),
  gateway_client_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (proof_kind,replay_scope_hash,replay_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_gateway_replay_expiry_v1
  ON agent_gateway_replay.claims_v1(expires_at);

COMMIT;
