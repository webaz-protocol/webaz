# RFC-025 Pre-work Report #2 — Current-State Audit, Gap Analysis & PR Plan

> Agent-native Buyer Experience. Companion to Appendix A (OSS paradigm comparison).
> All facts below verified against the codebase on 2026-07-16 (post-#372 main) with
> file:line references. Non-normative planning document — final schemas land per-PR.
>
> Guiding principle (Holden, 2026-07-16): **certainty over coverage** — 精准匹配链路
> 先行;discover 语义 = 「有结果输出结果,没结果记录,形成商机」。

Status: report · Date: 2026-07-16

---

## 1. Current state — verified facts

### 1.1 Tool surface & authorization (43 MCP tools)

- **OAuth/grant-reachable via Remote MCP: exactly 4 tools** — `webaz_list_product`
  (only `mine`/`create`/`draft` actions), `webaz_get_agent_order`,
  `webaz_order_action_request`, `webaz_connection_status`
  (`mcp-remote.ts:40-42`, `LIST_PRODUCT_GRANT_ACTIONS` :47).
- **There is no buyer OAuth path at all.** Every buyer-relevant tool is api_key-only:
  `verify_price`, `place_order`, `get_status`, `update_order`, `notifications`,
  `chat`, `dispute`, `claim_verify`, `default_address`. `webaz_search` is anonymous.
- Capability taxonomy (`agent-grant-scopes.ts`): 13 SAFE / 10 RISK / 15 NEVER.
  Every **executable** buyer order/status/money capability (`place_order`,
  `order_status`, `wallet`, …) sits in **RISK** (hard-rejected in grants); the sole
  SAFE buyer-shaped capability, `draft_order`, is dead (below). Note SAFE ≠ read-only —
  the taxonomy deliberately admits constrained draft/submit-only capabilities
  (`order_action_request` precedent). Coarse OAuth scopes: `read` / `order:draft` /
  `list:draft` → fine capabilities via `OAUTH_SCOPE_CAPABILITIES` (`oauth-approve.ts:41-45`).
- **`draft_order` is granted-but-dead — confirmed.** Exactly 3 references
  (`agent-grant-scopes.ts:32` definition, `oauth-approve.ts:43` OAuth mapping,
  `server.ts:600` description text). Zero `requireAgentGrantScope('draft_order')`
  mounts; no endpoint consumes it. Every OAuth grant minted with `order:draft`
  today carries a capability that can do nothing.
- Minor: remote manifest copy says "42/38 tools" (`mcp-remote.ts:5,137`) — stale;
  actual `TOOLS.length` = 43.

### 1.2 RFC-021 approve-to-execute — the reusable skeleton (seller-only today)

- Submit: grant-only tool → `POST /api/agent/orders/:id/action-request`
  (`agent-grants.ts:213`) → pending row in **`agent_permission_requests`**
  (`kind='order_action'`, 24h TTL, `params_hash = SHA-256({order_id, action, params})`,
  unique pending per (order,action)) — never executes (`src/pwa/order-action-request.ts`).
- Approve: human-authed + **live Passkey** (`agent_permission_approve` purpose)
  bound to `{request_id, order_id, action, params_hash}` (`agent-grants.ts:353-354`)
  → CAS pending→approved → execute → CAS `executed_at` (idempotent)
  (`order-action-exec.ts:107`). Executor unreachable from the agent-bearer path.
- **Seller-only**: ownership check is `order.seller_id !== humanId`
  (`order-action-request.ts:45`); actions limited to `accept`/`ship`; `decline`
  explicitly not delegable. The *pattern* (submit → params_hash → Passkey → CAS
  execute) is buyer-agnostic; the *implementation* is not.
- Read-projection precedent: `minimalSellerOrderView` (`agent-order-minimal-view.ts`)
  — allowlist-constructed 7 non-PII keys; PII columns never even SELECTed;
  `dest_country` coarsened from structured `ship_to_region`.

### 1.3 Commerce data model

- `products` (`schema.ts:41-55` + ALTERs): price REAL, stock, `shipping_template`
  JSON, `free_shipping_threshold`, S0–S6 seller-declared fields (`sale_regions`,
  `tax_lines` — not wired into totals, `import_duty_terms`, customs fields),
  `has_variants`, `return_days`, `warranty_days`, `handling_hours`.
- `product_variants` (`webaz-schema-helpers.ts:1138-1154`): sku, `options_json`,
  `price_override`, own `stock`, images. **Variant = the sellable/quotable unit**
  (orders-create overrides price at :191).
- `orders` (`schema.ts:60-110` + ALTERs): money columns are **REAL floats** —
  RFC-014 integer units used in arithmetic only; schema flip (P3/PR6) still pending.
  Status machine: created→paid→accepted→shipped→picked_up→in_transit→delivered→
  confirmed→completed (+disputed/cancelled + runtime `pending_accept`,
  `payment_query`, `delivery_failed`, fault states). Six deadline columns.
  `payment_rail` ∈ {escrow, direct_p2p}. `ship_to_region` structured;
  `shipping_fee` snapshot; `trade_terms_snapshot` frozen JSON at order time.
  `shipping_address` stored as **raw text**.
- Order timeline: `order_state_history` (+evidence enrichment) for humans, plus the
  `order_events` hash chain (`order-chain.ts`) with buyer-facing `/api/orders/:id/chain`
  and a party-scoped cursor stream `/api/agent/events` (`orders-read.ts:143-171`).

### 1.4 Price lock / quote precursor

- `price_sessions` (`pwa/server.ts:3114`): token, product, user, price, qty,
  **10-min TTL**, single-use. Created by `POST /api/verify-price`
  (`checkout-helpers.ts:70-130`). **Stores price+qty but locks/enforces PRICE only —
  quantity is recorded yet NOT bound at consumption** (the session lookup checks
  token+product+user only, `orders-create.ts:235`; a qty-1 session can be consumed
  by a qty-N order at the session's unit price). No stock hold (the verify-time
  stock check is observational). → gap **G-QTY-1**, hardening candidate for PR-3.
- Consume is atomic CAS (`price-session-consume.ts`) → 409 `PRICE_SESSION_USED`
  (nuance: an EXPIRED session also collapses into `PRICE_SESSION_USED` at the CAS —
  used vs expired are not distinguished at consumption); price drift →
  `price_changed` / 409 `PRICE_CHANGED` (separate `expected_price`
  guard, `orders-create.ts:205-215`). **Session token is optional** on order create.
- Shipping: `gateShippingForCreate` (`shipping-templates.ts:116-140`) resolves
  product→store template, region required when templated (400 `SHIP_REGION_REQUIRED`),
  free-threshold waiver, direct_p2p quote-outside-template path, 409
  `SHIP_REGION_NOT_COVERED`. Fee folded into `totalAmountU` (integer units) then
  stored. **A "quote" today = verify_price (price only); shipping is only computed
  inside order creation.** No surface returns the full landed total before commit.

### 1.5 Stock, idempotency, currency, tax

- Stock: **immediate CAS decrement inside the order tx** (409 `STOCK_DEPLETED`);
  no reservation/hold concept anywhere.
- **Idempotency on POST /api/orders: none.** No key, no dedup. Only accidental
  guards: optional one-time price session, spend caps, stock CAS.
- Currency: single settlement currency **WAZ** (1e6 base-units); FX is display-only
  (`fx-rates.ts` — "NEVER a settlement path").
- Tax: seller-declared only; `tax_lines` not summed into totals; informational
  `GET /api/checkout/tax-preview` with 协议不代收 disclaimer. Matches S0–S6 posture.

### 1.6 Existing conflicts & PII gaps (found, not designed-for)

- **G-PII-1**: `webaz_default_address` returns the **full raw address string**
  (free-form ≤200 chars — typically name/street/phone, whatever the user stored;
  zero masking/field filtering) to the calling agent (`server.ts:4353-4383`,
  `/api/me` → `default_address_text`). api_key-only today, but it normalizes
  "agent sees full PII" and `webaz_place_order`'s description even suggests falling
  back to it.
- **G-CONFLICT-1**: `POST /api/agent-buy` (`agent-buy.ts`) with `auto_buy=true`
  **charges immediately** (wallet→escrow debit + order INSERT in one tx, qty=1,
  skips coupons/insurance/spend-caps/sale-region gating). An agent-triggered
  immediate purchase with no human approval — predates the human-gate principle.
  Needs a decision (see §3 D-1).
- **G-PII-2**: buyer's own `GET /api/orders/:id` returns full `shipping_address` —
  correct for the authenticated human, but it is what `webaz_get_status` proxies to
  an agent holding the api_key. The buyer OAuth read must NOT reuse this projection.

### 1.7 After-sales, address, notifications, chat, RFQ — verified facts

- **Buyer after-sales is already rich, all api_key** (`orders-action.ts`,
  `returns.ts`): cancel, mark_paid, confirm receipt, dispute raise/escalate/withdraw,
  撤诉确认收货, return request/cancel/negotiate/escalate, claim-verification raise
  (10 WAZ stake), mutual-cancel. Passkey is layered only on **direct_p2p risk
  actions** (`directPayActionGate`, purpose `direct_pay_order_action`), verifier
  `vote`, and `arbitrate` — escrow-path buyer actions (incl. the terminal,
  settling confirm receipt) are api_key-only today.
- **★ LIVE DEFECT (found by this audit's Codex fact-check)**: the
  `/api/webauthn/auth/start` purpose whitelist (`webauthn.ts:119`) is missing
  `vote` AND `agent_revoke`, while `claim-verify.ts:454` and
  `agent-governance.ts:246,263` require gate tokens with exactly those purposes
  (param-enabled by default). Result: a non-`is_system` verifier cannot mint a
  vote token (voting ceremony unreachable), and agent_revoke's Passkey path is
  equally unreachable. Fail-closed (security intact, function broken). Fix is a
  dedicated small PR **outside this series** — another instance of the
  "webauthn purpose 白名单每新动作必查" lesson.
- **Two parallel address systems, not cross-synced**: ① `user_addresses` address
  book (`addresses.ts` full CRUD: id, label, recipient, phone, region, detail,
  is_default, max 20) — **an address_ref target already exists**; ② legacy
  `users.default_address_text/_region/_json` (written by `profile-prefs.ts:31`,
  read by `GET /api/profile`, RFQ fallback, and the MCP `webaz_default_address`
  full-PII path from §1.6).
- **Anonymous purchase precedent**: `PR-XXXXX` recipient codes with buyer-supplied
  intermediary address; masking enforced in `orders-read.ts` and the minimal view.
  No protocol-managed address-token abstraction exists yet.
- **Notifications**: 24-rule bilingual template engine (`notification-engine.ts:79-214`,
  `template_key`+`params`, client render via `app-notif-templates-orders.js` + t());
  list/SSE endpoints + MCP `webaz_notifications` — all api_key.
- **Chat**: context-bound (order/rfq/listing_qa), participants derived from real
  commercial relationship, idempotent conversation start (`INSERT OR IGNORE`),
  fraud-pattern detection on text. api_key.
- **RFQ**: buyer-create exists (`rfqs.ts:79`, deposit 1% clamp, region required,
  third-party masking). api_key, buyer-role only.
- **Wishlist already exists** (`wishlist-qa.ts`: add/remove/list with price_delta)
  — the plan's "watchlist" needs no new model, only (eventually) OAuth read.
- **Evidence**: text (+fraud detect) and blob upload (sha256 + MIME whitelist +
  HMAC + dedup), distributed via signed envelopes to counterparty + assigned
  arbitrators only. `evidence_ref`/`evidence_uri` reference patterns already in use.
- **RFC-021 approval page precedent**: `app-agent-approvals-order.js` renders
  pending order-action cards; Passkey purpose is the generic
  `agent_permission_approve` bound to `{request_id, order_id, action, params_hash}`;
  PII stripped at submission (`sanitizeOrderActionParams`). This is the exact
  template for the PR-5 order-submit card.

---

## 2. Gap analysis — plan §16 items vs reality

| # | Plan assumption | Reality | Gap |
|---|---|---|---|
| 1 | Buyer capabilities exposable via OAuth | Zero buyer OAuth path; buyer caps are RISK-tier | Need new SAFE buyer-read + prepare capabilities (read-only + submit-only are grant-compatible by the RFC-020 SAFE definition) |
| 2 | `draft_order` scope has server implementation | Granted-but-dead (3 refs, 0 consumers) | PR-4 activates it — first consumer |
| 3 | Canonical Product / Offer model | 1 listing = 1 seller offer; variants exist and carry price/stock | Compare at listing+variant level; canonical layer deferred (audit R4) |
| 4 | Quote returns landed total pre-commit | verify_price = price only; shipping computed only inside create | PR-3 extracts the shipping+total pipeline into a pre-commit quote |
| 5 | Idempotent order preparation | No idempotency on `POST /api/orders` (other creation surfaces have their own, e.g. chat's INSERT OR IGNORE) | New draft/submit path carries idempotency keys from day one; legacy POST /api/orders gap documented, fixed opportunistically |
| 6 | address_ref, PII never to agents | Full address text returned by default_address; raw text on orders | PR-2.5 masks the tool + introduces `address_ref` for the draft path |
| 7 | Passkey approval reusable | RFC-021 skeleton fully reusable but seller-only | PR-5 adds `kind='order_submit'` + buyer ownership check |
| 8 | Tax/multi-currency in quotes | Seller-declared tax; WAZ-only settlement | Quotes display seller-declared terms + trade_terms snapshot; no tax computation (S6 posture unchanged) |

## 3. Decisions needed from Holden (before or during the series)

- **D-1 (`agent-buy` auto_buy)**: conflicts with "human confirms all orders".
  Recommendation: keep the compare/recommend path, retire `auto_buy=true`
  (or redirect it into the new draft→submit→Passkey chain). **Own surgical PR
  (PR-5b)** — a distinct purchase entry path must not ride inside PR-5a.
- **D-2 (new fine capabilities)**: proposed SAFE additions —
  `buyer_orders_read_minimal`, `buyer_discover`, `price_quote`,
  `order_submit_request`. All read-only or submit-only, consistent with the SAFE
  definition. `buyer_discover` is deliberately NOT the existing `search` capability:
  discover persistently writes demand_signals tied to the grant subject, so the
  authorization must name that effect explicitly (disclosed in the tool description,
  audited, retention per D-4). Coarse OAuth scopes unchanged (`read` / `order:draft`).
- **D-4 (PR-5 money boundary — RESOLVED, mirrors Appendix A §3.2)**: Passkey
  approval executes the SAME order-creation path that exists today, and escrow
  creation already debits wallet→escrow inside the create tx
  (`orders-create.ts:369`). So the approval step both creates AND funds the order:
  the agent side never touches funds; the money move happens exactly once, behind
  the human's Passkey — a STRONGER gate than today's api_key `place_order`.
  PR-5a is therefore a money-path PR and is reviewed as one.
- **D-3 (demand_signals retention)**: append-only internal table; propose 180-day
  raw retention then aggregate-only. Public aggregation = separate gated PR.
  (Referenced as retention policy by D-2's `buyer_discover`.)

## 4. Proposed schemas (sketch — final per-PR)

```sql
-- PR-2: demand signals (internal; append-only; admin read only)
CREATE TABLE demand_signals (
  id TEXT PRIMARY KEY,              -- dms_xxx
  human_id TEXT,                    -- grant subject (nullable for future anon aggregation)
  source TEXT NOT NULL,             -- 'mcp_discover'
  intent_json TEXT NOT NULL,        -- minimal structured intent (no free chat text)
  category TEXT, region TEXT,
  budget_units INTEGER,             -- RFC-014 integer units from day one
  result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- PR-3: pre-commit quote (extends the price-session idea; labeled integer components)
CREATE TABLE order_quotes (
  token TEXT PRIMARY KEY,           -- qte_xxx
  product_id TEXT NOT NULL, variant_id TEXT,
  user_id TEXT NOT NULL, quantity INTEGER NOT NULL,
  item_units INTEGER NOT NULL, shipping_units INTEGER NOT NULL,
  total_units INTEGER NOT NULL,     -- = item + shipping (labeled, server-computed)
  ship_to_region TEXT NOT NULL, payment_rail TEXT NOT NULL,
  trade_terms_json TEXT NOT NULL,   -- seller-declared tax/return/warranty snapshot
  expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);

-- PR-4: order draft (activates draft_order; no money, no stock, cancellable)
CREATE TABLE order_drafts (
  id TEXT PRIMARY KEY,              -- odr_xxx
  buyer_id TEXT NOT NULL, quote_token TEXT NOT NULL,
  quote_snapshot_json TEXT NOT NULL,
  address_ref TEXT,                 -- reference only; never raw address
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|submitted|cancelled|expired
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- PR-5a reuses agent_permission_requests with kind='order_submit'. params_hash binds the FULL
-- server-authoritative economic snapshot: {draft_id, product_id, variant_id, quantity, item_units,
-- shipping_units, total_units, payment_rail, ship_to_region, address_ref} — never a subset (a
-- draft_id alone would only be safe if draft immutability were separately enforced; bind both:
-- drafts are immutable after create (cancel-only, no update endpoint) AND the hash carries the snapshot).
```

Schema rules baked in: new money columns are INTEGER units (no new RFC-014 debt);
ALTERs AFTER CREATE; boot new code before pg:schema regen.

## 5. PR sequence — scope, acceptance, tests

Standing checklist for EVERY PR in the series (lessons already paid for):
new tool → `NETWORK_TOOLS` + `AUTH_ONLY_TOOLS` + `OAUTH_TOOL_SCOPES` + regression
assertion; new webauthn action → purpose whitelist; new error_code →
`orderErrorLookup`; route change → `npm run gen:api-docs` on every commit; new UI
string → t() + `_EN`; new app-*.js → pwa-syntax + ceiling wiring; money via
money.ts/ledger.ts; guards: `routes:seam-check`, `check:api-docs-fresh`,
`test:i18n-parity`, complexity ratchet.

### PR-1 `webaz_buyer_orders` / `webaz_buyer_order_detail` (OAuth read)
- **Files**: `agent-grant-scopes.ts` (+`buyer_orders_read_minimal` SAFE),
  `oauth-approve.ts` (map into `read`), new `agent-order-minimal-view` buyer
  projection (allowlist ≤8 keys, PII columns never SELECTed, buyer_id ownership),
  `agent-grants.ts` routes, `server.ts` tool defs + handlers, `network-mode.ts`,
  `mcp-remote.ts`, `tool-security-schemes.ts`, tests.
- **Acceptance**: ChatGPT OAuth grant lists own buyer orders (status, next_actor,
  deadline, amount, item_ref — zero address/PII); seller orders NOT visible;
  api_key surfaces unchanged.
- **Tests**: new `scripts/test-buyer-orders-grant.ts` + extend
  `test-oauth-mcp-challenge.ts` (tool in NETWORK_TOOLS assertion); `routes:seam-check`.

### PR-2 `webaz_discover` + `demand_signals` (internal)
- **Files**: schema helper (+table), new route `/api/agent/discover`
  (new SAFE capability `buyer_discover` — see D-2; NOT `search`, because the
  persistent demand-signal write must be explicitly authorized), tool def
  (intent-shaped inputSchema, honest labels, collection disclosure in
  description), admin read view, tests.
- **Acceptance**: 有结果 → `discovery_candidate` 标注输出;没结果 → honest
  `no_candidates` + one `demand_signals` row;绝不相似冒充命中;admin 可见,
  非 admin 不可读 signals。
- **Tests**: new `scripts/test-discover-demand-signals.ts`; schema-verify; pg parity.

### PR-2.5 Address privacy: masked `webaz_default_address` + `address_ref`
- **No new table needed** — `user_addresses` (`addresses.ts`) is the natural ref
  target (`address_ref` = `user_addresses.id`; a virtual `default` ref resolves the
  legacy `users.default_address_*` until the two systems converge).
- **Files**: `server.ts` handleDefaultAddress (masked summary: label + region +
  city-level hint only), agent-facing ref list endpoint, draft-path plumbing, tests.
- **Acceptance**: agent read returns `{address_ref, label, region, masked_summary,
  is_default}` — never full detail/phone/recipient; PWA address-book management
  unchanged; order create via ref resolves the full address server-side only.
- **Tests**: source-guard asserting no `default_address_text`/`detail`/`phone`
  passthrough on any agent path.

### PR-3 `webaz_quote_order`
- **Files**: schema (+`order_quotes`), quote pipeline module (reuses
  `effectiveShippingTemplate`/`resolveShipping`/free-threshold; pure, unit-tested
  per step), route (grant `price_quote`), tool def, tests.
- **Acceptance**: server-computed labeled components (item/shipping/total integer
  units) + trade_terms + `expires_at`; variant required when `has_variants`;
  drift at consume ⇒ hard error, never silent reprice; agent never sums money.
- **Tests**: new quote pipeline unit tests + TTL/drift/variant cases.

### PR-4 `webaz_create_order_draft` (activates `draft_order`)
- **Files**: schema (+`order_drafts`), route (grant `draft_order` — first consumer),
  tool def, cancel path, idempotency, tests.
- **Acceptance**: draft from live quote_token; no money moved, no stock change,
  no real order row; idempotent create; cancellable; expires.
- **Tests**: idempotency-replay, expiry, no-side-effect assertions.

### PR-5a `webaz_submit_order_request` + Passkey approval page (MONEY-PATH PR)
- **Files**: `src/pwa/order-submit-request.ts` (mirror of
  `src/pwa/order-action-request.ts` with buyer ownership), `agent-grants.ts`
  approve wiring (`kind='order_submit'`), executor calling orders-create internals
  with server-side re-validation (price/stock/region/rail), PWA approval card
  (existing #agent-approvals page), webauthn purpose (**add to the
  `/api/webauthn/auth/start` whitelist — see §1.7 defect**), error codes, i18n, tests.
- **Money boundary (D-4)**: Passkey approval creates AND funds the order (escrow
  debit happens inside the existing create tx). Reviewed as a money-path PR:
  sync tx, balance guards, no fake success, authoritative guards in-tx.
- **Acceptance**: approval page shows @handle + masked id + item/variant + qty +
  labeled total + rail + address summary + return/warranty; Passkey binds the full
  snapshot params_hash (§4); drift at approve ⇒ hard fail + re-quote; execute
  unreachable to agents; no silent substitution of any term.
- **Tests**: full chain integration test (quote→draft→submit→approve→order) +
  drift/expiry/duplicate-submit; money-path review pass (no stub of the executor).

### PR-5b `agent-buy` auto_buy retirement (D-1, own surgical PR)
- Retire or redirect `auto_buy=true` (`agent-buy.ts:192-260`) into the
  draft→submit→Passkey chain; compare/recommend path unchanged. Separate from
  PR-5a because it alters a DIFFERENT existing purchase entry path.

### PR-6 Buyer after-sales action requests + `webaz_prepare_case`
- **Files**: buyer-side action-request module mirroring `order-action-request.ts`
  (buyer ownership check `order.buyer_id === humanId`; prepare-only actions:
  return_request draft, dispute-case draft, evidence_ref attach), `prepare_case`
  assembling order timeline (`order_state_history`) + original listing claims +
  evidence refs into a case draft, tests.
- **Boundary (unchanged semantics)**: terminal/money-moving steps stay PWA —
  confirm receipt (settles), dispute submission that freezes funds, accepting a
  refund plan, closing a dispute; direct_p2p risk actions keep their existing
  Passkey gate (`direct_pay_order_action`).
- **Acceptance**: agent can prepare and submit *requests* only; every irreversible
  step keeps its existing human execution path unchanged (NOTE: today that path is
  api_key-auth for escrow actions, Passkey only for direct_p2p — "human path" ≠
  "Passkey path"; upgrading escrow confirm-receipt to Passkey is a separate
  decision outside this series); case drafts contain refs, never raw PII/full
  addresses.
- **Tests**: ownership + prepare-only assertions; no executor import from the
  agent-bearer path (mirrors RFC-021 I1).

### PR-7+ (gated/deferred)
- demand_signals public aggregation (threshold ≥N, no per-buyer exposure),
  wishlist OAuth read (model already exists — `wishlist-qa.ts`), RFQ hooks
  (buyer-create exists api_key), buyer notifications OAuth read (24-rule engine
  exists api_key), compare_offers — all demand-triggered.

## 6. Non-goals (this series)

No canonical-product catalog · no tax computation · no multi-currency settlement ·
no cart · no `switch_account` tool · no api_key fallback for OAuth surfaces ·
no change to "one grant = one subject" · no touching escrow/direct_p2p rail
internals · no relaxation of strict `webaz_search`.
