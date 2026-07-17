# RFC-026 — Agent Shopping Authorization: fine-grained OAuth + purchase-intent idempotency

Status: **PR-1 implemented** (this document ships with it). PR-2..7 planned below.
Trigger: a real ChatGPT Remote MCP end-to-end run produced **two identical production orders** from one natural-language purchase intent (two quote→draft→submit chains, both approved).

## 1. Incident root cause (audited)

Per-request and per-draft idempotency already held (executed_at short-circuit, `pending→approved` CAS, `draft→ordering` CAS, `UNIQUE(quote_id)`, one active submit per draft). The gap was **intent-level**: a client retry re-quoted → a second, internally-consistent chain (quote₂→draft₂→request₂). `params_hash` includes `draft_id`, so the two economically-identical requests hashed differently and no uniqueness applied. The PWA showed both cards with no similarity warning; each approval executed its own fully-valid chain.

Secondary gaps: no DB-level draft→order constraint (`orders` had no `draft_id`); `DUPLICATE_SUBMIT_REQUEST` returned no existing request id (agents had to guess); a concurrent second approval read a stale `pending` row and got `SUBMIT_REQUEST_NOT_PENDING` instead of the created order id; clean-reject left requests as `approved` zombies.

## 2. PR-1 design (implemented)

### 2.1 One draft → at most one order (DB-unbypassable)
- `orders.draft_id TEXT` + `UNIQUE INDEX ux_orders_draft ON orders(draft_id) WHERE draft_id IS NOT NULL`.
- Only the Passkey-approve executor's loopback carries `draft_id`; `resolveDraftLink` (src/pwa/order-draft-link.ts) rejects any other caller (ownership + draft must be in `ordering`), and idempotently returns the already-linked order.
- Both insert paths (escrow `orders-create.ts`, direct_p2p `direct-pay-create.ts`) store the link.
- Migration: idempotent backfill from `order_drafts.order_id`; rollback = drop the index (column is inert).

### 2.2 One purchase intent → at most one ACTIVE approval
- `agent_permission_requests.intent_hash` = SHA-256 of the economic snapshot **without draft_id** + buyer (`orderSubmitIntentHash`).
- `UNIQUE INDEX ux_apr_intent_active ON (human_id, intent_hash) WHERE kind='order_submit' AND status IN ('pending','approved') AND executed_at IS NULL AND intent_hash IS NOT NULL`.
- Legacy rows (`intent_hash IS NULL`) are excluded — no backfill needed, they expire naturally (24h). Rollback = drop the index.
- Legit repeat purchase: the slot frees on execution (`executed_at`); different quantity/terms = different intent.

### 2.3 Request state machine (mapping to the spec's pending/processing/approved/declined/expired/failed)
`pending` →(atomic CAS, one winner)→ `approved` (≈processing; the draft `draft→ordering` CAS is the exactly-once execution gate) → terminal outcomes:
- success: `executed_at` + `execution_result{order_id}` (+ draft `ordered` + backlink) — repeat approvals return the same order id;
- clean reject (drift / address changed / draft dead / upstream 4xx): **`failed` (terminal)** — frees both uniqueness slots; retry = agent resubmits, human approves a fresh card;
- ambiguous (network/5xx): request stays `approved`, draft frozen at `ordering` — deliberately **keeps occupying the intent slot** so equivalent purchases stay blocked until a human reconciles. Crash-safe: a process crash mid-execution leaves this frozen state; retries never double-order.
- Concurrent double-approve: the loser re-reads the row and converges to `already_executed` + the same order id (or the ambiguous freeze), never a second order.

### 2.4 Duplicate submits return the existing request
Same draft or same intent → `{ success:true, request_id:<existing>, idempotency:{ duplicate:true, reused_existing_request:true }, approval_url }`. Slots held by dead drafts (cancelled/expired) or expired pending rows are released and the insert retried once.

### 2.5 PWA
Similar-purchase warning: pending `order_submit` cards sharing product+quantity+payable+rail are flagged per-card (count + seconds apart + "EACH approval creates a REAL order"). No bulk-approve exists for economic requests (kept that way).

### 2.6 Tests (scripts/test-order-submit-approve.ts, 40 asserts)
Intent reuse across fresh quote+draft; one pending per intent; different quantity = own request; **concurrent double approve → exactly one order + one debit**; draft_id backlink; direct-write second order blocked by UNIQUE; slot release after execution → legit re-buy; concurrent double submit converge to one row; terminal `failed` on clean reject; ambiguous keeps the slot; full chain over a **real `oat_` bearer** (post-#385 rule).

## 3. Risk levels & scope table (target end-state)

L1 public/low read → L2 full shopping read → L3 drafts/requests/context-bound chat → L4 Passkey-approved economic execution → L5 PWA-only. OAuth scopes only ever authorize **initiating** L4 requests; execution is always `submit request → server validates → snapshot frozen → Passkey → revalidate → canonical handler exactly-once → result bound to request`. L5 (withdraw, receive accounts, Passkey/API-key management, arbitration, large transfers, platform params) never enters `OAUTH_SCOPE_CAPABILITIES`.

New fine capabilities by PR (names follow existing conventions):
- PR-2: `approval_requests_read` (+ `webaz_approval_requests` list/get, deep link `/#agent-approvals/apr_x`)
- PR-3: `buyer_order_timeline_read`, `buyer_order_terms_read`, `buyer_logistics_read`, `buyer_refund_status_read`, `wallet_balance_read`, `wallet_escrow_read`, `wallet_tx_read_minimal`, `notification_read`; orders gain server-authoritative `available_actions`
- PR-4: `order_chat_read/send`, `listing_qa_read/send`, `rfq_chat_read/send` (context-bound, participants only, anti-scam kept, `sent_by_agent` marked, content-hash audited)
- PR-5: `address_read_masked` (has_default/country/area summary/hints only), `address_change_request` (encrypted pending payload → Passkey write; agent never reads the full address)
- PR-6: `buyer_cancel_request`, `buyer_return_request`, `buyer_refund_request`, `buyer_confirm_receipt_request`, `buyer_dispute_prepare/submit_request` via `webaz_buyer_action_request` on the existing `kind` framework (per-action state validation, economic consequence preview, params_hash, one active per subject+action+params)
- PR-7: seller reads/chat + `seller_accept/decline/ship/refund_request`, `seller_price_change_request`, `seller_inventory_draft`; buyer PII only via server-generated fulfilment flows after Passkey approval.

Bundles (consent-page layer over capabilities, no token-semantics change): `shopping_assistant` (L1), `shopping_companion` (L1+L2+chat+aftersales drafts), `purchase_request` (+order:draft+aftersales requests), `seller_assistant`. Consent page shows: bundle, plain-language summary, expanded scopes, PII readability, economic-request ability, "Passkey still required", expiry, revoke entry. Wallet OAuth is read-only forever; escrow rail remains simulated WAZ; Direct Pay funds never touch WebAZ.

## 4. Invariants this RFC must never break
No double debit; no PII to agents (server-side resolution only); no Passkey bypass (scope ≠ execution); no silent scope escalation (upgrades re-consent; downgrades immediate); everything audited (`agent_grant_auth_log` on every grant call + request rows + execution results); api_key paths unchanged; OAuth projections are minimal even where api_key returns full data.
