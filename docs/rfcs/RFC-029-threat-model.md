# RFC-029 Threat Model — Order–Payment Decoupling / 订单-支付解耦威胁模型

**Status**: draft v1 (2026-07-21) · precedes ANY schema/code per security-artifact-first discipline
**Scope**: the four-phase flow of RFC-029 (pending order → payment options → payment_quote_token →
Passkey approves the economic action) with today's two REAL rails: escrow (simulated custody ledger)
and direct_p2p (non-custodial, seller receiving account). PSP adapters (dtcpay/card/bank) inherit
this model when they land.
**Driver (Holden, live 2026-07-21 ×3)**: payment choice MUST happen at payment time, chosen by the
user — never frozen at quote/order creation.

## Assets
A1 buyer wallet balance (sim ledger) · A2 order truth (orders/state machine) · A3 approval-gate
integrity (RFC-021: nothing economic without a human Passkey) · A4 seller receiving instructions
(direct_p2p) · A5 buyer PII (address) · A6 stock truth · A7 fee/AML invariants (Rail-1 platform fee,
AML=INVARIANT) · A8 idempotency ledgers (intent_hash, BUG-08 identity).

## Trust boundaries
B1 agent/model (untrusted narrator; can call tools with buyer's OAuth grant) · B2 widget iframe
(untrusted host, capability-probed) · B3 WebAZ server (trust root) · B4 seller (semi-trusted:
controls listings/receiving accounts, NOT order state) · B5 payment adapters (future: external PSP
callbacks/webhooks = untrusted input).

## Threats & mitigations (STRIDE-organized, numbered for the design doc to reference)

**T1 — Pay-then-no-goods (stock)**: order created without payment → stock gone at pay time.
→ M1: soft-reserve ≤15min (`reservation_expires_at`), re-check at execution, HARD invariant
"never accept funds then report out-of-stock"; expiry transition auto-releases (server cron, no
agent involvement).

**T2 — Amount/rail swap between display and approval**: user sees option A's payable, approves,
but B executes (agent confusion or race between quote and approve).
→ M2: `payment_quote_token` binds {order_id, method, payable, fees, FX, recipient, protection,
refund_terms, expiry}; the Passkey approval object binds the SAME tuple via params_hash; server
re-derives and rejects on ANY drift (same pattern as today's submit re-validation). Approval UI
displays from the server-bound tuple only.

**T3 — Token replay / cross-order / cross-user**: pqt reused, or bound to another order/user.
→ M3: pqt single-use CAS (consumed_at), scoped {order_id, human_id}, short expiry (FX-sensitive
options shorter, `fx_expires_in`), server-side ownership check on every read/consume (own-subject
only, same as approval_requests).

**T4 — Approval-gate bypass via new tools**: webaz_create_order creating orders without Passkey
could become an economic primitive if any rail later treats "order exists" as payable-by-default.
→ M4: `awaiting_payment_method` orders are economically inert BY STATE-MACHINE definition: no
wallet movement, no receiving instruction issued, no seller notification of payable, auto-expire.
Every fund-moving transition requires an approved payment request (Passkey) — state machine enforces,
not tool discipline.

**T5 — Options-surface dishonesty**: showing rails that can't actually execute (simulated PSP,
ineligible direct_p2p) → user approves an impossible payment.
→ M5: `webaz_payment_options` lists ONLY gate-passing rails (server-evaluated eligibility:
direct_receive account active + seller gates; ACP honesty rule: no simulated rails, ever); each
option carries the honest settlement note (escrow=sim ledger disclosure; direct_p2p=non-custodial
disclosure — reuse existing economic_effect copy).

**T6 — Fee/AML erosion (Rail-1)**: decoupling lets a path skip the Rail-1 platform-fee ledger or
AML posture checks.
→ M6: fee accrual + AML checks move INTO the payment-execution transition (adapter-agnostic core
step), not per-adapter code; invariant test: every executed payment row has a fee ledger entry
(or explicit zero-fee rule) regardless of rail.

**T7 — Poisoned adapter callbacks (future PSP)**: forged webhook flips order to paid.
→ M7: adapter SPI's `reconcile(webhook)` verifies signatures adapter-side but state transition
requires server-side match against the pqt tuple (amount/currency/reference) + idempotent
transition; unverifiable callbacks park in `needs_reconcile` (existing pattern), never auto-paid.

**T8 — Widget/agent-layer spoofing**: card or model claims "paid/executed" without server truth.
→ M8: unchanged discipline — status only from server reads (structured envelope per A3-5),
display_status server-authored, widget textContent-only; payment page is webaz.xyz (Passkey
domain), never in-card.

**T9 — Unpaid-order griefing**: mass pending orders lock stock / spam sellers.
→ M9: per-buyer concurrent pending-order cap; sellers see orders only after payment (or as
non-actionable "reserved" counts); expiry cleanup; existing rate limits apply to create_order.

**T10 — Migration-window confusion**: old quote→draft→submit chain coexists with new flow.
→ M10: feature-flagged cutover; old chain keeps working until flip; idempotency ledgers must
recognize BOTH identities during the window (intent_hash unchanged for legacy; pqt for new);
no double-order across the two paths for the same intent (cross-check on product+buyer+window).

## Out of scope (unchanged invariants)
Real-money custody (USDC stays display-alias; sim ledger disclosure), Passkey mechanics, arbitration
rails, RFC-018 clearing. 人工铁律节点不变。

## Test obligations derived here
Each Tn→Mn becomes a named test family in the implementation PRs (fail-closed on drift); T2/T3/T4
get adversarial fixtures (tampered tuple, replayed pqt, direct state-transition attempts).
