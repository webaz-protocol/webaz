# RFC-023 v2 (DRAFT for review): OAuth for Remote MCP — replace pasted api_key, gradually

- Status: **Accepted (v2, decisions locked 2026-07-14).** Implementation plan: `docs/superpowers/plans/2026-07-14-oauth-remote-mcp.md`. Feature-flagged, built serially; api_key stays valid throughout.
- Supersedes: RFC-023 v1 (incorporates the Codex design review, 2026-07-14).
- Depends on: RFC-020 (agent delegation grants), RFC-021 (approve-to-execute), RFC-022 (Remote MCP)
- Normative refs: MCP Authorization spec · OAuth 2.1 · RFC 9728 (protected-resource metadata) · RFC 8414 (AS metadata) · RFC 8707 (resource indicators) · RFC 7636 (PKCE) · RFC 7591 (DCR) · Client ID Metadata Documents

## 1. Why (P0 Distribution)

A third-party agent today authenticates to `https://webaz.xyz/mcp` with a raw `Authorization: Bearer <api_key>` — a long-lived secret the user pastes into a connector. That is friction and a footgun (keys leak, never expire, carry full scope). OAuth 2.1 is what ChatGPT/Claude connectors already speak, so supporting it both **lowers the barrier** (click Connect → log in → approve; no key handling) and **hardens** it (short-lived, audience-bound, scoped, revocable tokens). The anonymous read-only tier is unchanged; this is only for the authenticated tier, and it is **additive** (api_key Bearer keeps working through the transition).

## 2. Invariants — MUST hold, not implementation details

These are hard design boundaries. Anything that violates one is out of scope by definition.

- **I-1 · Human gate is inviolable.** No OAuth access token, refresh token, client credential, DCR registration, or scope value may satisfy `requireHumanPresence` or execute an RFC-021 RISK action directly. RISK actions remain **request → approve → execute** with a per-action Passkey and parameter binding. OAuth changes who the agent *is*, never whether a human must approve a risky act.
- **I-2 · Anonymous read unchanged.** No token is required for the public read tier; adding OAuth must not gate any currently-anonymous surface.
- **I-3 · Audience-bound tokens (mandatory).** Every access token is issued for `resource = https://webaz.xyz/mcp` only, with `aud` bound to that resource. Clients MUST send RFC 8707 `resource` on authorize + token requests; the `/mcp` handler MUST reject any token whose audience is not this resource. This prevents token reuse / confused-deputy / mix-up attacks (per the MCP auth spec + RFC 9728).
- **I-4 · PKCE S256 required.** Authorization Code + PKCE `S256` is mandatory for all clients (public agents). Missing or `plain` PKCE is rejected; AS metadata advertises `code_challenge_methods_supported: ["S256"]` only.
- **I-5 · Token is a *credential for* an RFC-020 grant, not the grant.** An access token authenticates the caller as an existing RFC-020 grant principal (capability + constraints + expiry + agent binding + revocation + audit). OAuth scope strings never *replace* that model — they select within it. Revocation, live per-call checks, and audit stay at the RFC-020 layer (the isolation seam from RFC-022 is unchanged: the `/mcp` handler resolves the Bearer → grant principal exactly where it resolves api_key today, under the same AsyncLocalStorage isolation).
- **I-6 · Delegable scope is SAFE-only.** OAuth may only carry SAFE (read/draft) capabilities. RISK / never-delegable capabilities are structurally un-issuable as OAuth scope (they only ever run through the RFC-021 per-action Passkey flow).

## 3. Shape

- **WebAZ is an OAuth 2.1 Authorization Server** for its own resource (`/mcp`).
- **Discovery**: serve `/.well-known/oauth-protected-resource` (RFC 9728, pointing at the AS + naming the resource) and `/.well-known/oauth-authorization-server` (RFC 8414: `authorization_endpoint`, `token_endpoint`, `scopes_supported`, `code_challenge_methods_supported:["S256"]`, `resource_indicators_supported:true`). A `401` from `/mcp` carries `WWW-Authenticate` pointing at the protected-resource metadata so a compliant MCP client self-starts the flow.
- **Flow**: Authorization Code + PKCE(S256). User is redirected to `webaz.xyz`, authenticates with **Passkey** (accountability root, unchanged), sees a **consent screen** listing the requested SAFE scopes + the client identity, approves → client receives a short-lived, audience-bound access token (+ refresh per §6-D2). **Consent-to-grant lifecycle**: approving consent mints (or reactivates) an RFC-020 grant for `(user, client, SAFE-scope subset, expiry)`; the access token is a short-lived *credential for* that grant (I-5). Re-consent or token refresh re-issues a credential for the same grant — it does not widen the grant's capabilities. Revoking the grant (RFC-020) invalidates all its tokens.
- **Scopes**: a small named set mapped onto the capability-matrix SAFE actions (§6-D5).

## 4. Threat model (design decisions, not afterthoughts)

| # | Threat | Required mitigation |
|---|--------|---------------------|
| T1 | Token theft / replay | audience binding (I-3); short access-token TTL; TLS; optional DPoP (§6-D4) |
| T2 | Confused deputy / token mix-up | RFC 8707 `resource` + `aud` validation on every call (I-3) |
| T3 | Refresh-token abuse | rotation + reuse-detection (invalidate the whole token family on reuse) + revocation linked to the RFC-020 grant + client binding + short max offline lifetime; no refresh for higher-risk scope bundles (§6-D2) |
| T4 | Auth-code injection | PKCE S256 (I-4) + single-use codes + short code TTL + exact `redirect_uri` match |
| T5 | Open redirect / redirect_uri abuse | strict allowlist / exact-match validation of `redirect_uri` (§6-D6) |
| T6 | DCR spam / rogue clients | see client-onboarding decision (§6-D3); if DCR, rate-limit + review + no auto-trust |
| T7 | Consent phishing | show client identity + exact scopes + resource on the consent screen; anti-phishing rules (§6-D6) |
| T8 | Scope escalation | server-side scope validation against the grant's SAFE capability set; I-6; insufficient-scope → typed challenge (§6-D6) |
| T9 | Iron-rule bypass via any OAuth artifact | I-1 (mechanically enforced at the RFC-021 boundary) |

## 5. Data model — reuse vs dedicated

- **Reuse RFC-020** as the canonical **grant / principal / capability / revocation / audit** source. An OAuth token references a grant principal; it does not become the grant.
- **Dedicated OAuth tables** for protocol artifacts (do NOT overload `agent_delegation_grants`): `oauth_clients`, `oauth_auth_codes`, `oauth_access_tokens` (or introspection view), `oauth_refresh_tokens` (with family/rotation + reuse-detection columns), `oauth_redirect_uris`, and DCR/client-metadata records.
- Reuse: identity + Passkey ceremony (`src/pwa/routes/webauthn.ts`); the RFC-022 transport, isolation (ALS), and rate-limit are unchanged.

## 6. Decisions — RESOLVED (locked 2026-07-14)

- **D1 · Token format** → **opaque + server introspection** (DB lookup on every `/mcp` call). Online revocation + scope-downgrade are trivial; no JWT verifier/denylist.
- **D2 · Refresh tokens** → **none in v1.** Short-lived access token only; re-consent on expiry. (Revisit rotating-refresh-with-reuse-detection in a later version if offline-agent demand appears.)
- **D3 · Client onboarding** → staged: **v1 = allowlist** (Claude / ChatGPT / Cursor); **v2 = Client ID Metadata Documents**; **DCR (RFC 7591) deferred.**
- **D4 · Sender-constraint** → **bearer-only, SAFE-scope v1.** (DPoP is a later hardening if T1 pressure appears.)
- **D5 · Scope granularity** → **coarse named scopes** (`read`, `order:draft`, `list:draft`, …) mapped onto capability-matrix SAFE actions. Agent-legible.
- **D6 · Fixed values / rules** → canonical `aud` = `https://webaz.xyz/mcp`; `redirect_uri` = **exact-match allowlist**; consent screen shows client identity + exact scopes + resource; insufficient-scope = HTTP `403` + `WWW-Authenticate: error="insufficient_scope"` **and** a typed `error_code` in the MCP tool JSON result.
- **D7 · Sequencing** → after PyPI publish (done) + current adoption items; built serially, flag-gated (`WEBAZ_OAUTH=1`, fail-closed), api_key kept valid throughout. Not roadshow-critical.

## 7. Non-goals (v1)

Not an identity provider for third-party sites (no "log in with WebAZ" elsewhere); no client secrets for public agents (PKCE only); no change to the anonymous read tier; no removal of api_key (kept for compatibility); RISK-scope delegation is permanently out (I-6).

## 8. Rollback / compat

Feature-flagged like RFC-022. api_key Bearer stays valid throughout. Disabling the flag removes the AS endpoints + the protected-resource metadata; the endpoint reverts to api_key-only with zero residual state.

---
**Decisions locked (2026-07-14).** Implementation proceeds serially per `docs/superpowers/plans/2026-07-14-oauth-remote-mcp.md`, flag-gated, each PR Codex-reviewed. api_key Bearer stays valid throughout; anonymous read unchanged.
