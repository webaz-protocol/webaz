# RFC-024 (DRAFT for review): Dynamic Client Registration for OAuth — support many MCP clients

- Status: **Accepted (decisions locked 2026-07-15).** Implementation: one focused Codex-audited PR (§6.5).
- Depends on: RFC-023 (OAuth for Remote MCP — shipped). Extends its client-identity layer (D3: allowlist → **CIMD/DCR deferred** — this RFC lands DCR).
- Author: Claude (for Holden's review)

## 1. Why

RFC-023 shipped OAuth behind a **static, hardcoded, empty** `PROD_CLIENTS` allowlist. Adding a
connector means a code change + deploy, and — critically — many MCP clients (Claude Desktop, Cursor,
VS Code, Goose) use **localhost / ephemeral-port callbacks** (`http://localhost:53682/callback`, port
varies) that **cannot be pre-registered at all**. To "support as many clients as possible" (Holden's
goal), the AS must let clients register themselves. RFC 7591 Dynamic Client Registration is what the
modern MCP client ecosystem expects.

## 2. The safety thesis (why open registration is bounded)

Open registration is **not** open access. A registered client can do **nothing** until a **human
approves it on the Passkey consent screen**, and even then only within hard limits that RFC-023 already
enforces and this RFC does not touch:

- **Human gate** — every token requires a live Passkey consent (RFC-023 I-1). A registered client is an
  inert DB row until a human approves it.
- **SAFE scopes only** — no RISK/never-delegable capability is ever reachable (RFC-020 / RFC-023 I-6).
- **Short-lived, audience-bound, revocable** tokens (RFC-023 D1/D2/I-3).
- **PKCE S256 + exact redirect_uri match** (RFC-023 I-4/T5) — a registered redirect can't be widened
  or hijacked; PKCE binds the code to the client instance that holds the verifier.

So the **only new risk DCR introduces is client impersonation** — a malicious client registering as
"Claude" to trick a human into approving it. This RFC's controls target exactly that.

## 3. Shape (RFC 7591)

- **`POST /oauth/register`** (public, no auth — per RFC 7591 for public clients): body
  `{ client_name, redirect_uris[], token_endpoint_auth_method:"none", grant_types:["authorization_code"], response_types:["code"] }`
  → validates, mints a random `client_id`, stores it in the **existing `oauth_clients` table** (wired
  for the first time), returns `{ client_id, client_id_issued_at, redirect_uris, ... }`. **No client
  secret** (public clients, PKCE — consistent with RFC-023 D4).
- **Discovery**: add `registration_endpoint` to the RFC 8414 AS metadata so clients auto-find it.
- **Consent screen**: a DCR client is shown **`⚠ Unverified — self-declared`** with its raw
  `client_name` (escaped) and the exact redirect_uri, so a human can spot impersonation. (Optional
  future: a curated `verified` set that earns a badge — out of scope for v1, see §7.)

## 4. Threat model

| # | Threat | Control |
|---|--------|---------|
| T1 | **Impersonation** (client names itself "Claude") | Consent screen marks ALL DCR clients `unverified / self-declared`; shows the redirect_uri host prominently; `client_name` escaped, never rendered as trusted. Human is the gate. |
| T2 | **Registration spam / DB bloat** | Per-IP rate limit on `/oauth/register` (validated CF-Connecting-IP, same helper as /mcp & /token); cap `redirect_uris` count + length; registrations are **inert** until consented (no privilege to abuse); TTL-sweep clients with zero successful authorizations after N days. |
| T3 | **Open redirector via registered URI** | redirect_uri validation at registration: **https only, OR loopback (`http://localhost` / `http://127.0.0.1` / `http://[::1]`) with any port**; reject wildcards, fragments, userinfo, non-http(s) schemes. Exact-match still enforced at /authorize (RFC-023 T5). |
| T4 | **Code/redirect hijack** | Unchanged: PKCE S256 required; token audience-bound; short TTL. PKCE binds the code to the registering client instance. |
| T5 | **client_id forgery / tamper** | `client_id` is server-minted random (`oac_client_…`), opaque, no secret; lookups are exact. |
| T6 | **Registration when OAuth is off** | Fail-closed: `/oauth/register` mounts only under `WEBAZ_OAUTH=1`, refuses sandbox (same guard as every OAuth route). |
| T7 | **Scope escalation via registration** | Registration carries NO scopes; scopes are chosen at /authorize and gated by the consent screen + SAFE-only mapping. A DCR client can request only the same SAFE scopes as any client. |

## 5. Data model (wire the existing table)

`oauth_clients` already exists (RFC-023 PR-1): `client_id PK, name, redirect_uris JSON, status, created_at`.
This RFC starts reading/writing it. Proposed additive columns (ALTER-after-CREATE): `created_ip_hash`
(rate-audit, hashed), `last_authorized_at` (TTL-sweep + "unused" detection), `client_metadata` JSON
(raw RFC 7591 fields for audit). `oauthClients()` in `oauth-authorize.ts` changes from a const to a
table read (union: DEV client under flag + DB clients). Verified/curated clients (§7) would be a
`verified INTEGER` column, default 0.

## 6. Decisions (LOCKED 2026-07-15)

1. **Registration auth** → **Fully open** `POST /oauth/register` (RFC 7591 standard; required for
   localhost clients). The human consent gate is the real control; bounded by per-IP rate limit +
   inert-until-consented.
2. **Impersonation posture v1** → **All DCR clients `unverified`** on the consent screen (self-declared
   name, redirect host shown prominently). Verified-badge for a curated big-name set is a **fast
   follow** (separate small PR), not v1.
3. **Redirect_uri policy** → **https OR loopback** (`http://localhost` / `127.0.0.1` / `[::1]`,
   any port); reject wildcards, fragments, userinfo, non-http(s) schemes. Custom app schemes
   (`cursor://`) deferred to a reviewed allowlist if a target client needs it.
4. **Retention** → **TTL-sweep** DCR clients whose `last_authorized_at` is NULL after **30 days**;
   no hard cap (inert rows are cheap; rate-limit bounds growth). (Sweep cron = fast follow; not required
   for the first PR to be correct.)
5. **Sequencing** → **One focused PR**: register endpoint + `oauth_clients` table wiring +
   `registration_endpoint` discovery + consent "unverified" marking + tests. Codex-audited.

## 7. Non-goals (v1)

Verified-client badges/curation (fast follow); CIMD (`client_id` = URL) as an alternative onboarding
path (can co-exist later); client secret / confidential clients; changing anonymous read, SAFE-scope
limits, the human gate, or token lifetimes. DCR only widens **who can ask**; it changes nothing about
**what a human can grant**.

---
**Decision requested**: approve this direction + the §6 recommendations (then a full plan + serial
PRs, each Codex-audited), revise, or defer. No code will be written against this until sign-off.
