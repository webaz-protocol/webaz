# Agent Gateway — shadow-limiter activation runbook (RFC-028 S2b)

Turns on the multi-dimensional rate limiter (`docs/audits/AGENT-API-GATEWAY-THREAT-MODEL.md` §8) in
**shadow mode**: it evaluates every `POST /mcp` request against the authoritative distributed counter and
**logs what it WOULD deny** — it never blocks, never mutates the response, never denies. The purpose is to
collect real traffic rates so the enforce thresholds (S2b-3) are calibrated from data, not guesses.

## Safety posture (why this is low-risk)

- **Default-off.** With no env set, the store is `undefined` and the observer is a pure no-op — `/mcp` is
  byte-identical. Merged code already runs this way in production today.
- **Fire-and-forget.** The evaluation is never awaited in the response path, so a slow or down limiter DB
  cannot add latency to `/mcp`.
- **Fail-soft activation.** If the limits DB is misconfigured, unmigrated, or unreachable at boot, activation
  DEGRADES to off (logged `[agent-gateway-limits] limit store disabled …`) — it never crashes `/mcp`.
- **Instant rollback.** Unset `WEBAZ_AGENT_GATEWAY_LIMITS_MODE` (or the backend var) and redeploy/restart →
  back to no-op in one deploy.

## What you (operator) must do — needs DB admin creds + infra/cost decisions

### Prereq: a PostgreSQL reachable from the Railway service

Dedicated is cleanest, but it may share a cluster (its own database/schema is enough). It is **separate from
the business SQLite DB** and holds only ephemeral rate-counter buckets. In production the app pins the
server's CA (`rejectUnauthorized: true`), so use a Postgres whose **CA certificate you can obtain** (most
managed providers let you download it). If your only option is a Railway private-network Postgres with no
pinnable CA, tell me — that needs a small vetted code option to allow the internal-network case; do not
disable TLS by hand.

### Step A — provision the schema (as a migration OWNER, once)

```sql
-- run db/agent-gateway-limits.pg.sql with an owner/admin role:
\i db/agent-gateway-limits.pg.sql
```

It creates schema `agent_gateway_limits`, table `counters_v1` (PK `limiter_key,window_sec,window_start`),
the `expires_at` index, and REVOKEs PUBLIC. Idempotent (`IF NOT EXISTS`).

### Step B — create the least-privilege application role (as owner)

The app role needs SELECT/INSERT/UPDATE/DELETE only — **no CREATE, no TRUNCATE** (startup asserts this and
refuses an over- or under-privileged role):

```sql
CREATE ROLE webaz_limits_app LOGIN PASSWORD '<generate-a-strong-password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA agent_gateway_limits TO webaz_limits_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON agent_gateway_limits.counters_v1 TO webaz_limits_app;
```

### Step C — set the Railway environment variables

Set these on the PWA service (you set the secret values; I never handle them):

| Variable | Value |
|---|---|
| `WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND` | `postgres` |
| `WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL` | `postgresql://webaz_limits_app:<pw>@<host>:5432/<db>` — **no query params or fragments** (validation rejects `?sslmode=…` etc.; TLS/CA is pinned by the app, not the URL) |
| `WEBAZ_AGENT_GATEWAY_LIMITS_TLS_CA_B64` | base64 of the Postgres server's CA PEM (`base64 -w0 ca.pem`). Required when `NODE_ENV=production`. |
| `WEBAZ_AGENT_GATEWAY_LIMITS_MODE` | `shadow` |

`WEBAZ_REMOTE_MCP=1` must already be set (it is, for `/mcp` to be mounted).

### Step D — deploy / restart

`railway up --detach` (or restart the service so it re-reads env). Watch boot logs.

### Step E — verify

1. **Boot healthy**: the `✅ WebAZ 已启动` sentinel appears; **no** `limit store disabled` line (that line
   means activation failed and shadow degraded to off — check the URL/CA/migration).
2. **`/mcp` unaffected**: a normal `tools/list` still returns the full tool set.
3. **Shadow data flowing**: as real agent traffic hits `/mcp`, watch for
   `[agent-gateway-limits] shadow would-deny class=… dim=… retry_after=…s` lines. Early on you expect **few
   or none** — a flood of them means a budget is too tight for real traffic (that's the signal to tune before
   enforcing).
4. **Counters landing** (optional, as the app role): rows accumulate and self-expire:
   ```sql
   SELECT window_sec, count(*) AS buckets, max(hit_count) AS peak
     FROM agent_gateway_limits.counters_v1 GROUP BY window_sec ORDER BY window_sec;
   ```

## Rollback

Unset `WEBAZ_AGENT_GATEWAY_LIMITS_MODE` (keeps the store warm but silent) or `…_BACKEND` (closes the store),
then redeploy/restart. Effect is immediate: the observer returns to a no-op.

## After the window → enforce (S2b-3, not yet built)

Once the shadow logs show the real distribution of `would-deny` per class/dimension:
1. Tune `GATEWAY_LIMIT_POLICY` from the observed rates — especially the deferred item: `economic` is looser
   than `high` and has no global/client ceiling (audit #3). Set these from data.
2. Build S2b-3: inline enforcement behind `MODE=enforce` with a **per-hit timeout** on the async evaluator
   (a slow DB must not stall an enforced request) and an explicit fail-open/closed choice per cost class.
3. Roll enforce out the same way: one class at a time, watching for false denials, instant rollback via the
   mode flag.
