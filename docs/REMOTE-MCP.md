# Connect any AI agent to WebAZ — Remote MCP

**One endpoint, every compatible agent.** WebAZ speaks the [Model Context Protocol](https://modelcontextprotocol.io) over a plain HTTPS endpoint, so ChatGPT web custom apps, compatible Claude clients, and cloud agents can reach it directly. No `npx` or local runtime is required.

```
https://webaz.xyz/mcp
```

- **Transport:** MCP Streamable HTTP (stateless, `POST` only).
- **Anonymous** = public reads (search / leaderboard / price history / open build tasks / browse). No account needed.
- **OAuth 2.1** (when enabled with `WEBAZ_OAUTH=1`) = click **Connect** in a compliant MCP client — no key handling. You log in with your Passkey, approve SAFE scopes on a consent screen, and the client receives a short-lived, audience-bound access token. See [Connect via OAuth](#connect-via-oauth-21--no-pasted-key).
- **`Authorization: Bearer <api_key>`** = act as your account (order, list, fulfil…). Most account actions execute directly with the key (e.g. placing an order). A few high-risk actions can only be **completed by the human in the browser / PWA** — the mechanism varies: seller accept/ship returns an `approval_url` the human approves with a Passkey (then the server executes), while wallet withdrawal, key changes, and arbitration are done in the PWA with a Passkey/WebAuthn. OAuth never removes the api_key path; both stay valid. (Per-tool detail: [permission matrix](#permission-matrix--how-each-tool-authenticates).)

> Reachability first: the goal is that an agent meeting WebAZ for the first time connects and completes a real product search in its first conversation, unaided.

## Connect it

### Claude (desktop / mobile — Connectors)
Add a custom connector pointing at `https://webaz.xyz/mcp`. Leave auth empty to browse anonymously, or set a Bearer token (your WebAZ `api_key`) to transact.

### ChatGPT (developer mode / connectors)
On ChatGPT web, an eligible user or workspace admin can enable Developer mode, create a **custom MCP app** (formerly called a custom connector), and set its server URL to `https://webaz.xyz/mcp`. Anonymous access works for public search/browse; OAuth or an account credential enables only the authenticated actions allowed by that credential. Plan/workspace availability and write-action support follow ChatGPT's current policy. This manual custom-app path is not an official App Directory listing, and ChatGPT mobile does not currently support MCP apps.

### Any MCP client / SDK
Point the client's Streamable HTTP transport at `https://webaz.xyz/mcp`. Example JSON-RPC:

```bash
curl -sS https://webaz.xyz/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Add `-H 'authorization: Bearer <api_key>'` to authenticate.

## Connect via OAuth 2.1 — no pasted key

When the OAuth surface is enabled (`WEBAZ_OAUTH=1`), a compliant MCP client (Claude / ChatGPT / Cursor connectors) can connect without you ever handling an api_key:

1. **Discovery.** The client reads [`/.well-known/oauth-protected-resource/mcp`](https://webaz.xyz/.well-known/oauth-protected-resource/mcp) (RFC 9728) and [`/.well-known/oauth-authorization-server`](https://webaz.xyz/.well-known/oauth-authorization-server) (RFC 8414). Calling an account-bound tool without adequate authorization returns the auth challenge inline: an `HTTP 200` tool result with `isError: true` and `result._meta["mcp/www_authenticate"]` carrying an RFC 6750 `Bearer resource_metadata="…"` challenge (with `error` + `error_description`; mirrored to a `WWW-Authenticate` header for RFC 9728-aware clients). ChatGPT reads that `_meta` challenge to pop the **Connect via OAuth** UI, so a client self-starts the flow mid-session — no re-login for a scope step-up.
2. **Authorize.** Authorization Code + PKCE (`S256` only). You're redirected to webaz.xyz, log in with your **Passkey**, and see a consent screen naming the client, the exact SAFE scopes (`read`, `order:draft`, `list:draft`), and the resource (`https://webaz.xyz/mcp`).
3. **Token.** The client exchanges the code for a **short-lived, audience-bound, opaque** access token — a credential for the delegation grant your approval minted (revocable anytime from your account; no refresh tokens in v1, the client re-consents on expiry).

Boundaries (identical to every other path): OAuth tokens carry **SAFE scopes only** — read (public + your own catalog + minimal orders with no buyer PII — seller-side via `webaz_get_agent_order`, buyer-side via `webaz_buyer_orders` with no address/contact — + your own connection identity via `webaz_connection_status`), draft creation, and *submitting* accept/ship requests to your approval queue. Anything beyond that — executing an order action, publishing, paying, arbitrating, buyer-side ordering (`webaz_verify_price` / `webaz_place_order`), or any api_key-only operation — is **not performed by an OAuth token**; it needs your `api_key` or a per-action Passkey approval. No token ever bypasses the human gate. Anonymous browsing needs no OAuth and is unchanged. See the [permission matrix](#permission-matrix--how-each-tool-authenticates) for the per-tool breakdown.

> **`webaz_pair` is stdio-only.** It performs a one-time **local** pairing (a credential handle stored on your own machine), so over the remote endpoint it could only ever dead-end — it is therefore **not listed on the remote `tools/list`** (a remote agent authenticates via OAuth, not pairing). On the stdio server (`npx -y @seasonkoh/webaz`) it appears normally. If a remote client calls it by name anyway, it returns `PAIRING_LOCAL_ONLY`.

## Get an api_key

Registration currently uses invitations for Sybil resistance. A key requires a **real human** to register with a Passkey — agents cannot self-register; this is the accountability root. Request an invite at [webaz.xyz/#welcome](https://webaz.xyz/#welcome). Browsing and reading need no key.

## What you can do

`tools/list` is surface-scoped (buyer 21 by default; `?surface=full` → all 54 remote tools; `webaz_pair` is stdio-only — see Tool surfaces below) — `webaz_info` (protocol status), `webaz_search`, `webaz_connection_status`, `webaz_list_product`, `webaz_get_agent_order`, `webaz_verify_price`, `webaz_place_order`, and more. Start with `webaz_info` for the live network state, then `webaz_search` or `webaz_contribute action=list_open`.

### Tool surfaces — smaller tools/list by default (PR-3)

`tools/list` is now **surface-scoped** (definition payload: full ≈100KB → buyer ≈38KB):

| Surface | Tools | How you get it |
|---|---|---|
| `buyer` (21) | the core shopping chain: info/register/connection_status · search/discover/price_history · verify_price/place_order/get_status · quote→draft→submit · buyer_orders/buyer_action/approvals/prepare_case · order_chat/wallet_view/address/default_address/notifications | **default** for anonymous and OAuth/delegation connections |
| `seller` (23) | listing/fulfilment/account ops (list_product, upload_product_image, p2p_product, get_agent_order, order_action_request, update_order, wallet, mykey/profile/keys, trial, shareables, share_link …) | `/mcp?surface=seller` |
| `full` (54) | everything (adds RFQ/secondhand/auction, dispute/claim_verify, contribute/charity/leaderboard, skills …) | `/mcp?surface=full`, or automatically when connecting with an api_key bearer |

**Surface affects tools/list visibility ONLY — never authorization.** Any known tool called by name still dispatches, and every call-time gate (OAuth scope, api_key, Passkey) is unchanged. **Migration:** clients that relied on the old full anonymous list should add `?surface=full` to their connector URL (existing connectors with a cached manifest keep working — calls by name are unaffected). stdio (`npx -y @seasonkoh/webaz`) always exposes the full local set.

`webaz_info` now returns a **compact overview** by default (production was ~35KB); the long-form guides live in MCP resource `webaz://guide/info` or `webaz_info {"full":true}` — content moved, nothing deleted.

### Structured results — Token-lean model projection (v1)

Three core buyer tools return **`structuredContent`** (MCP structured tool results) with a versioned model projection, and advertise a matching **`outputSchema`** on `tools/list`:

| Tool | `structuredContent` schema |
|---|---|
| `webaz_search` | `webaz.product_search.model.v1` — per-product decision fields (price / stock_status / logistics / after-sales / seller_ref / sales_count / `decision_flags` / one-line summary), deduped `sellers` map, `next_cursor` paging (default page = 5) |
| `webaz_buyer_orders` | `webaz.order_status.model.v1` — whole-account `summary`, active-orders-first page (default 10, max 50), `next_cursor`, 7-key minimal orders (zero PII, unchanged contract) |
| `webaz_quote_order` | `webaz.order_quote.model.v1` — integer line items, masked ids, region-only destination |

Two incremental surfaces (PR-2): `webaz_search` issues a **`result_handle`** (10-min TTL) — pass it back with `selected_ids` (≤5) to get live detail projections (`webaz.product_detail.model.v1`: description/specs/terms). Handles store only the id selection set; details are always re-read live re-running the SAME public visibility predicates as search (`active` + in-stock + seller-not-paused + external-link governance) — items failing any predicate come back as `unavailable_ids` (never cached data, never a permission bypass; the blocklist is a per-authenticated-viewer filter and does not apply to this anonymous public surface). `webaz_buyer_orders` with `full` accepts **`updated_since`** — unchanged orders return a tiny `up_to_date` response; changed orders return timeline entries at-or-after the timestamp (`incremental` marker; duplicates possible, loss forbidden). `up_to_date` covers every stored ORDER-SCOPED mutable source (order row, state history, returns, agent tracking, mutual-cancel proposals, disputes) plus — for pre-snapshot orders whose return terms read the live listing — the product row (`products.updated_at`); purely time-derived eligibility (e.g. a return window closing by clock) is re-evaluated only on full reads — fetch without `updated_since` before acting.

Semantics: **`content[0].text` is a 1–2 sentence degradation summary** for hosts that do not read `structuredContent`; the full decision data lives in `structuredContent` only (no JSON-in-text duplication). Null / empty fields are stripped before serialization. **Error results keep the complete structured error JSON in `content[0].text`** (so text-only clients retain `error_code` + recovery fields), and mirror it in `structuredContent`. Internal DB fields (content hashes, migration/backfill columns, commission rates, sourcing data, ranking internals) never enter the model surface. All other tools currently keep their existing JSON-in-text form.

### Permission matrix — how each tool authenticates

Each tool declares a per-tool `securitySchemes` (`oauth2` or `noauth`) so a client knows whether to offer an OAuth **Connect** prompt. That declaration is honest: an `oauth2` tool is genuinely reachable through an OAuth grant; a `noauth` tool is **not** OAuth-delegatable (advertising OAuth there would be a false recovery promise). What an agent can actually do:

| Tier | `securitySchemes` | How the agent authenticates | Tools (examples) |
|------|-------------------|-----------------------------|------------------|
| **Public** | `noauth` | nothing — anonymous, read-only | `webaz_info`, `webaz_search`, `webaz_secondhand` (browse), `webaz_leaderboard`, `webaz_price_history`, `webaz_contribute` (`list_open`) |
| **OAuth — SAFE grant** | `oauth2` | **Connect via OAuth** → Passkey consent → short-lived, audience-bound token. No api_key. | `webaz_connection_status` (`read`), `webaz_list_product` (`mine`/`create`/`draft`), `webaz_get_agent_order` (`read`), `webaz_buyer_orders` (`read` — minimal buyer order read, no address/PII; `full=true` adds timeline / order-time frozen terms / logistics / deadlines+next-actor / refund status / server-authoritative available_actions), `webaz_buyer_action_request` (`aftersales:request` — submit-only confirm-receipt / Direct-Pay-unpaid cancel / return requests with a server-computed economic effect; the Passkey approval re-validates and executes through the REAL order routes), `webaz_address` (`address` — masked status only (region + presence, never substrings) + Passkey-gated change REQUESTS: the human reviews the full new address in the PWA before anything is written; agents can never read it back), `webaz_order_chat` (`chat:context` — participant-bound order chat: read + send through the production anti-scam/rate-limit path, agent-sent messages marked; NO free-form DM surface), `webaz_wallet_view` (`read` — wallet balances + refund landings; the OAuth wallet surface is READ-ONLY forever), `webaz_discover` (`read` — honest discovery candidates; queries recorded as disclosed demand signals), `webaz_quote_order` (`order:draft` — server-authoritative integer quote; no order/funds/stock, default address resolved server-side, never shown), `webaz_order_draft` (`order:draft` — converts one quote into a frozen draft snapshot; single-use, cancellable, still no order/funds/stock), `webaz_submit_order_request` (`order:draft` — submit a draft into your Passkey approval queue; approval re-validates against current state and creates the REAL order server-side, escrow debits at creation; ANY drift hard-fails), `webaz_approval_requests` (`read` — status of YOUR approval requests: pending / needs_reconcile / executed(+order id) / failed, with deep-link approval_url; never re-submit just to check status), `webaz_prepare_case` (`read` — after-sales case-draft assembly: structural timeline + order-time terms snapshot + current listing anchors + normalized evidence refs; no buyer personal data, no domain writes; submitting stays human), `webaz_order_action_request` (submit accept/ship → approval queue) |
| **Account — api_key** | `noauth` | your own **api_key** — **not** OAuth-delegatable; the action **executes directly** | `webaz_profile` (`view`), `webaz_verify_price`, `webaz_place_order` (places & charges the order immediately), `webaz_wallet` (reads: view / deposits / withdrawals / income), `webaz_update_order`, `webaz_get_status`, `webaz_notifications`, `webaz_default_address` |
| **Human-completed (browser / PWA)** | not a whole tool — a specific high-risk action | the agent only receives a **URL to hand to the human**; the human finishes it with a Passkey in the browser — the agent never executes it | seller **accept / ship** (`webaz_order_action_request` → `approval_url` → Passkey → server executes, RFC-021), wallet **withdrawal** (PWA-only, inline WebAuthn), **key rotate / revoke** and `webaz_dispute` **arbitrate** (return a PWA link, `next_step.url`) |

Two honest points about the boundary:

1. **OAuth carries SAFE read/draft/submit scopes only.** An OAuth token can never do `webaz_place_order`, `webaz_wallet`, pay, or any api_key-only action — it is limited to the seller catalog + minimal orders (no buyer PII), draft creation, submitting accept/ship requests, and reading your own connection identity. `webaz_verify_price` / `webaz_place_order` are **not** OAuth-delegatable today; a buyer-side SAFE "prepare draft → human approves → execute" flow is a **separate, future RFC**.
2. **An api_key executes account actions directly.** `webaz_place_order` places and charges the order immediately — it does **not** return an approval URL and is **not** Passkey-gated at the tool layer today. Only the specific actions in the last row require a human step, and the **mechanism varies** — an `approval_url` for seller accept/ship, an inline WebAuthn confirm for a wallet withdrawal, a PWA link for key changes / arbitration. There is **no single uniform `approve_url`** covering every money action, and no blanket "every money action is Passkey-gated" rule.

## Boundaries (honest)

- **Publicly launched.** Direct Pay is a conditions-gated, non-custodial real-payment rail: payment happens off-platform between buyer and seller, and WebAZ never holds principal, does not guarantee payment, and cannot refund on the seller's behalf. Escrow remains simulated while additional payment methods are added. Registration currently uses invitations for Sybil resistance.
- **Isolated by construction.** The remote endpoint never uses the server host's credentials; an anonymous caller is strictly read-only. Your Bearer key acts only as your own account.
- **Rate-limited.** Per-client throttling — keyed on the Cloudflare-attributed client IP for traffic arriving through Cloudflare (the normal path via `webaz.xyz`) — is a defense-in-depth layer atop Cloudflare's edge DDoS protection; back off on `429`. It is not the primary access control (isolation, the Passkey human-gate, and 128-bit keys are). Direct-to-origin traffic that bypasses Cloudflare could rotate the client-IP header to evade this limiter; that residual DoS vector is closed by enabling the Cloudflare-only origin guard (`CF_ORIGIN_GUARD_MODE=enforce`).
- The machine-readable entry point for agents is [`/.well-known/webaz-integration.json`](https://webaz.xyz/.well-known/webaz-integration.json) (it lists `remote_mcp` when the endpoint is live).

## Compatibility & the North Star (P1)

Two live harnesses measure whether a stranger agent can actually use WebAZ (run against the live endpoint):

- **`npm run agent:first-success`** — the North Star: fresh anonymous MCP client, canonical first task (connect → tools/list → natural-language search recovery → browse → act on a product), reports the **Agent First Task Success Rate**.
- **`npm run agent:compat-matrix`** — runs that same task through the distinct request shapes real clients use (MCP SDK = Claude Desktop/Code, Cursor; ChatGPT-connector init order; older/newer protocol-version negotiation; stateless no-initialize clients like OpenClaw/Hermes; bare JSON-RPC). All profiles must pass.

These verify the server-side compatibility surface (protocol-version negotiation, Accept handling, stateless call ordering) that determines whether each client can connect. Driving the hosted ChatGPT / Claude / Cursor UIs themselves is manual (steps above).
