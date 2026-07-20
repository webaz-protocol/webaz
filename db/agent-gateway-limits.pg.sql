-- RFC-028 S2b operational PostgreSQL rate-limit authority (threat-model §8.1).
-- The AUTHORITATIVE, cross-replica counter store for the multi-dimensional limit
-- engine (src/runtime/gateway-limits.ts). Fixed-window buckets keyed by the
-- canonical limiter key + window start; a bucket dies at window_start+window_sec.
--
-- Run with a migration owner before enabling limits. The application role needs
-- SELECT, INSERT, UPDATE and DELETE only; it does not need CREATE privileges.
BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_gateway_limits;

CREATE TABLE IF NOT EXISTS agent_gateway_limits.counters_v1 (
  limiter_key  TEXT NOT NULL
    CHECK (char_length(limiter_key) BETWEEN 1 AND 128),
  window_start TIMESTAMPTZ NOT NULL,
  window_sec   INTEGER NOT NULL
    CHECK (window_sec BETWEEN 1 AND 86400),
  hit_count    BIGINT NOT NULL
    CHECK (hit_count >= 1),
  expires_at   TIMESTAMPTZ NOT NULL,
  -- A budget is identified by (key, window length, window start): the same key under two different window
  -- lengths is TWO independent budgets, so window_sec is part of the bucket identity — without it, two
  -- windows whose edges coincide (e.g. the top of the hour for 60s and 3600s) would merge into one row.
  PRIMARY KEY (limiter_key,window_sec,window_start)
);

-- Cleanup drives off expires_at; the limiter read path never scans this index.
CREATE INDEX IF NOT EXISTS idx_agent_gateway_limits_expiry_v1
  ON agent_gateway_limits.counters_v1(expires_at);

REVOKE ALL ON SCHEMA agent_gateway_limits FROM PUBLIC;
REVOKE ALL ON TABLE agent_gateway_limits.counters_v1 FROM PUBLIC;

COMMIT;

-- Provision the application role separately with no ownership/CREATE rights:
-- GRANT USAGE ON SCHEMA agent_gateway_limits TO <application_role>;
-- GRANT SELECT,INSERT,UPDATE,DELETE ON agent_gateway_limits.counters_v1 TO <application_role>;
