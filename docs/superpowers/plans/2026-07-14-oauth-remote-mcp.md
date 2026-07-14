# OAuth for Remote MCP — Implementation Plan (RFC-023 v2)

> Serial PRs, flag-gated (`WEBAZ_OAUTH=1`, fail-closed), each Codex-reviewed. api_key Bearer stays valid throughout; anonymous read unchanged. Decisions locked in RFC-023 §6 (opaque tokens + introspection · no refresh v1 · allowlist clients · bearer-only SAFE-scope · coarse scopes · aud-bound).

**Goal:** an MCP client can `Connect` to `https://webaz.xyz/mcp`, get redirected to log in with Passkey, approve SAFE scopes, and receive a short-lived audience-bound opaque access token that authenticates it as an RFC-020 grant principal — never bypassing the per-action Passkey for RISK actions.

**Invariants (RFC-023 §2, enforced every PR):** human-gate inviolable (I-1) · anonymous read unchanged (I-2) · aud-bound tokens (I-3) · PKCE S256 required (I-4) · token is a credential *for* an RFC-020 grant (I-5) · SAFE-scope only (I-6).

## Global constraints
- Schema: ALTER-after-CREATE in `webaz-schema-helpers.ts`; `schema:verify` + fresh-DB bridge; new `test:*` wired into ci.yml manually.
- Money/state/schema paths = single-topic PRs; `gen:api-docs` after any route change; `routes:seam-check`.
- Flag `WEBAZ_OAUTH=1` required to mount any OAuth surface; discovery advertises OAuth only when live (like RFC-022 `remoteMcpEnabled()`).
- Reuse: RFC-020 grant tables (canonical grant/principal/capability/revocation/audit); `webauthn.ts` Passkey ceremony; RFC-022 ALS isolation + rate-limit.

---

### PR-1 — Schema + discovery metadata (foundation, no token issuance)
**Files:** `src/runtime/webaz-schema-helpers.ts` (new tables), new `src/pwa/routes/oauth-discovery.ts`, `src/pwa/server.ts` (register), `scripts/test-oauth-discovery.ts`, ci.yml.
- Tables (ALTER-after-CREATE): `oauth_clients` (client_id, name, redirect_uris JSON, status, created_at), `oauth_auth_codes` (code_hash, client_id, user_id, scope, code_challenge, redirect_uri, expires_at, consumed_at), `oauth_access_tokens` (token_hash, grant_id, client_id, scope, aud, expires_at, revoked_at). All hashes, never plaintext.
- `GET /.well-known/oauth-protected-resource` (RFC 9728): `{ resource: "https://webaz.xyz/mcp", authorization_servers: [BASE], bearer_methods_supported: ["header"] }`.
- `GET /.well-known/oauth-authorization-server` (RFC 8414): `authorization_endpoint`, `token_endpoint`, `scopes_supported`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code"]`, `token_endpoint_auth_methods_supported: ["none"]`, `response_types_supported: ["code"]`.
- Both gated on `WEBAZ_OAUTH=1` (404 otherwise). No auth logic yet.
- **Test:** tables created (fresh DB); metadata shapes; S256-only advertised; flag off → 404.
- **Deliverable:** the AS is *discoverable* but issues nothing. Zero auth surface = zero risk.

### PR-2 — Authorize endpoint + consent (mint auth code)
**Files:** new `src/pwa/routes/oauth-authorize.ts`, consent UI (new `app-oauth-consent.js` or a server-rendered page), tests.
- `GET /oauth/authorize` — validate `client_id` (allowlist), `redirect_uri` (exact-match against `oauth_clients`), `response_type=code`, `scope` (SAFE-only subset), `code_challenge`+`code_challenge_method=S256` (reject missing/`plain`), `resource=https://webaz.xyz/mcp` (I-3).
- Require an authenticated Passkey session (reuse `webauthn.ts`); render consent = client identity + exact scopes + resource. On approve → **mint/reactivate an RFC-020 grant** for `(user, client, SAFE-scope subset, expiry)` (I-5) and an `oauth_auth_codes` row (single-use, short TTL, bound to PKCE + redirect_uri) → redirect back with `code`.
- **Threat coverage:** T4 (PKCE), T5 (redirect exact-match), T7 (consent shows identity/scope/resource), T8 (scope ⊆ grant SAFE set), I-6.
- **Test:** rejects plain/missing PKCE; rejects non-allowlisted client; rejects redirect mismatch; rejects RISK scope; approve mints a grant + single-use code.

### PR-3 — Token endpoint (exchange code → opaque access token)
**Files:** new `src/pwa/routes/oauth-token.ts`, tests.
- `POST /oauth/token` — `grant_type=authorization_code`, verify `code` (single-use, unexpired), PKCE `code_verifier` against stored challenge, exact `redirect_uri` match, `resource` → issue **opaque** access token (random, stored hashed in `oauth_access_tokens` with `aud`, `scope`, `grant_id`, short TTL). No refresh (D2). Consume the code (CAS).
- **Threat coverage:** T2 (aud stamped), T4 (PKCE verify + single-use), D1 (opaque).
- **Test:** valid exchange issues token; replayed code rejected; wrong verifier rejected; token row is hashed + aud-bound.

### PR-4 — `/mcp` accepts OAuth Bearer (introspect → grant principal) — THE security pivot
**Files:** `src/pwa/routes/mcp-remote.ts` + the L1 credential seam, tests.
- On `/mcp`, a Bearer that is an OAuth token → introspect (`oauth_access_tokens` by hash): check unexpired, unrevoked, **aud == https://webaz.xyz/mcp** (I-3, reject else), resolve `grant_id` → RFC-020 grant principal → same isolated resolution path as api_key today (RFC-022 ALS). api_key Bearer still works (precedence documented).
- **I-1 enforced:** the resolved principal is a grant with SAFE scope only; RISK actions still hit `requireHumanPresence` → `approve_url` (unchanged). Insufficient scope → 403 + `WWW-Authenticate: insufficient_scope` + typed `error_code` in the tool JSON (D6).
- **Test (security-critical, adversarial):** OAuth token → authenticated reads; wrong-aud token rejected; expired/revoked rejected; RISK action with OAuth token → still returns approve_url (NOT executed); scope beyond grant → 403; api_key path unchanged; anonymous unchanged.

### PR-5 — Discovery wiring + `401 WWW-Authenticate` + docs
**Files:** `mcp-remote.ts` (401 challenge → protected-resource metadata), `integration-contract.ts` + `public-utils.ts` (advertise `oauth` under remote_mcp when live), `docs/REMOTE-MCP.md` + `#connect` (OAuth path), tests.
- Unauthenticated write attempt → `401` + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"` so a compliant client self-starts the flow.
- **Deliverable:** end-to-end — a client discovers OAuth, runs the flow, and calls authenticated tools. Then flip `WEBAZ_OAUTH=1` in prod + external acceptance (Claude connector OAuth flow).

## Test strategy
Each PR: fresh-DB integration tests + adversarial security asserts on the invariants. PR-4 is the pivot — heaviest adversarial coverage (aud, revocation, RISK-gate, scope). Reuse the stranger harness (`agent:first-success`) with an OAuth profile once PR-5 lands.

## Rollout
Flag off through PR-1..5 merge+deploy (surfaces absent). Flip `WEBAZ_OAUTH=1` only after PR-5 + a full security re-audit. api_key never removed in this plan.
