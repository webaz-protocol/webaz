# RFC-023 (DRAFT for review): OAuth for Remote MCP — gradually replace pasted api_key

- Status: **Draft — design only, NOT approved, NOT implemented.** Awaiting Holden's review.
- Depends on: RFC-020 (agent delegation grants), RFC-021 (approve-to-execute), RFC-022 (Remote MCP)
- Author: Claude (for Holden's review)

## 1. Why (P0 Distribution)

Today a third-party agent authenticates to the Remote MCP endpoint with a raw `Authorization: Bearer <api_key>` — a long-lived secret the user must paste into a connector. That is friction and a security footgun (keys leak, never expire, full scope). OAuth 2.1 is what ChatGPT/Claude connectors already speak for auth, so supporting it both **lowers the barrier** (click "Connect", log in, approve — no key handling) and **hardens** it (short-lived, scoped, revocable tokens). Anonymous read-only stays exactly as-is; this is only for the authenticated tier.

## 2. Shape (aligns with the MCP auth spec + RFC 9728)

- **WebAZ becomes an OAuth 2.1 Authorization Server** for its own resource (`https://webaz.xyz/mcp`).
- **Discovery**: serve `/.well-known/oauth-protected-resource` (RFC 9728) pointing at the AS, and `/.well-known/oauth-authorization-server` (RFC 8414) with endpoints + supported scopes. An MCP client that gets a `401` from `/mcp` follows these to start the flow.
- **Flow**: Authorization Code + **PKCE** (public clients). User is redirected to `webaz.xyz`, authenticates with **Passkey** (the accountability root — unchanged), sees a consent screen listing the requested **scopes**, approves → client receives a short-lived access token (+ refresh token).
- **Token = a grant.** Reuse the RFC-020 grant infrastructure: an OAuth access token maps to an agent grant bound to `(user, declared_scope, expiry)`. The `/mcp` handler resolves the Bearer token → grant exactly where it resolves api_key today (the isolation seam is unchanged). **Risk actions still return `approve_url`** for a per-action Passkey — OAuth scope never buys a bypass of the human gate.
- **Scopes**: map to the existing capability matrix (e.g. `read`, `order`, `list`, `fulfil`). SAFE scopes only for delegated tokens; RISK/never-delegable stay Passkey-per-action (RFC-021).
- **Backwards compatible**: raw `api_key` Bearer keeps working during the transition (gradual replacement, not a cutover).

## 3. Reuse, don't rebuild

- Identity + Passkey ceremony: existing `src/pwa/routes/webauthn.ts`.
- Grant binding, scope validation, per-call live checks, revocation: existing RFC-020 tables + `resolveGrantCredential` seam.
- The remote transport, isolation (AsyncLocalStorage), rate-limit: unchanged (RFC-022).

So the net-new surface is: two well-known documents, an `/authorize` + `/token` endpoint pair, a consent screen, and token↔grant plumbing.

## 4. Open questions (need Holden's call before a plan)

1. **Token lifetime + refresh policy** — access-token TTL (e.g. 1h) and whether to issue refresh tokens (long-lived → more like today's api_key; or short + re-consent).
2. **Dynamic Client Registration** (RFC 7591) — support it so ChatGPT/Claude can self-register clients, or pre-register a small allowlist? DCR is what makes "just paste the URL" work with no manual client setup, but widens the surface.
3. **Reuse RFC-020 grant tables** for token storage vs a dedicated `oauth_tokens` table.
4. **Scope granularity** — reuse the capability-matrix action tokens 1:1, or a coarser OAuth scope set mapped onto them.
5. **Sequencing** — this is a larger build (AS endpoints + consent UI + security audit). It is NOT roadshow-critical and should follow the SDK/compat/Connect-page P0 items. Does it come before or after the P3 ecosystem work?

## 5. Non-goals (v1)

Not an identity provider for third parties (no "log in with WebAZ" for other sites); no client secrets for public agents (PKCE only); no change to the anonymous read tier; no removal of api_key (kept for compatibility).

---
**Decision requested**: approve this direction (then a full RFC + implementation plan), revise the shape, or defer. No code will be written against this until Holden signs off.
