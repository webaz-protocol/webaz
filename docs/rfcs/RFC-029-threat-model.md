# RFC-029 Threat Model — Order–Payment Decoupling / 订单-支付解耦威胁模型

**Status**: draft v2 (2026-07-22; v1 2026-07-21) · precedes ANY schema/code per
security-artifact-first discipline
**Scope**: RFC-029's TWO tiers. **v1 (below, T1–T10)** models **Design B** — the order-first
four-phase flow (pending order → payment options → payment_quote_token → Passkey approves the economic
action). **v2 delta (this revision, TA1–TA5)** models **Design A** — choose-at-confirm, where the rail
is picked by the human on the confirm page *before* order creation and bound into `params_hash`. Both
cover today's two REAL rails: escrow (simulated custody ledger) and direct_p2p (non-custodial, seller
receiving account). PSP adapters (dtcpay/card/bank) inherit Design B when they land.
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

## v2 delta — Design A (choose-at-confirm) threat mapping

Design A creates **no unpaid order** and mints **no payment_quote_token**, so several v1 threats do
not apply to it; a few new ones arise from moving rail-choice to the confirm step.

**Not applicable to Design A** (order-first only): **T1** (pay-then-no-goods — no order exists until
after the rail is chosen and Passkey-approved), **T3** (pqt replay — no pqt), **T9** (unpaid-order
griefing — no pending orders). **Still apply**: T2 (amount/rail swap), T5 (options-surface honesty),
T6 (fee/AML), T8 (widget/agent spoofing), T10 (migration window).

**TA1 — Rail swap between confirm-display and Passkey mint**: buyer sees/selects rail A, but the gate
token or create executes rail B (agent race, or a tampered confirm request).
→ MA1: the chosen rail is folded into `params_hash` at the mint step; the WebAuthn gate token binds
`{request_id, draft_id, action, params_hash(chosen rail)}`; create re-derives the rail from the
draft+choice and **hard-fails on any drift** (`order-submit-exec.ts:122` pattern extended to cover the
now-late-bound rail). The human approves exactly the rail the server bound.

**TA2 — Ineligible / simulated rail offered or selected**: the confirm page lists a rail whose gates
don't pass (ineligible direct_p2p, or a not-real rail presented as real).
→ MA2: the eligible-rails surface lists **only** rails whose server-side gates pass at render time
(`evaluateDirectPayLaunchControls` + account resolution for direct_p2p; buyer WAZ-balance for escrow);
gates are **re-evaluated at create** (render does not guarantee); ACP honesty — never a simulated rail
shown as real; buyer-facing reasons coarsened (`coarsenBuyerFacingDirectPayCode`), never leaking which
seller gate failed.

**TA3 — Forced option, bypassing the human** — two sub-cases: (a) the untrusted **agent** passes
`payment_rail`/account and expects it honored; (b) a **seller** "recommendation" collapses to a hard
lock that removes other supported options from the buyer.
→ MA3: the option that binds `params_hash` is set **only** at the human confirm step; the agent cannot
mint the gate token (Passkey is human-only) — an agent-supplied option may pre-select UI but never
commits. The seller `recommended` flag is a **soft default only**: the options surface always returns
**every** supported+gate-passing option (server-computed union), and there is no server path by which a
seller recommendation removes a supported option from the buyer's set ("既然支持就都可以选"). Invariant
test: options(seller with a recommendation) ⊇ options(same seller without) — recommendation never
shrinks the menu.

**TA4 — "托管 = real custody" confusion (honesty/UX)**: presenting `escrow` (sim) beside `direct_p2p`
lets a buyer believe escrow gives real buyer protection.
→ MA4: stark per-option disclosure bound server-side to each option (escrow = 模拟测试·非真实结算;
direct_p2p = 非托管·你直接付卖家), reusing the existing `economic_effect` copy; near-term framing
treats the choice as "opt into real direct-pay vs the sim default" (RFC §Design-A honesty). No option
label may imply custody the rail doesn't provide.

**TA5 — Re-choice double-spend / stale gate token**: buyer changes rail after a gate token was minted
for the prior rail, yielding two live tokens → two orders for one draft.
→ MA5: a rail change **invalidates the prior gate token** (new `params_hash` ⇒ new single-use token);
the draft is **consumed exactly once at create** (existing draft-consume CAS); at most one order per
draft regardless of how many times the rail was re-picked.

## Out of scope (unchanged invariants)
Real-money custody (USDC stays display-alias; sim ledger disclosure), Passkey mechanics, arbitration
rails, RFC-018 clearing. 人工铁律节点不变。

## Test obligations derived here
Each Tn→Mn / TAn→MAn becomes a named test family in the implementation PRs (fail-closed on drift).
Design B: T2/T3/T4 get adversarial fixtures (tampered tuple, replayed pqt, direct state-transition
attempts). Design A: TA1/TA3/TA5 get adversarial fixtures (rail swap between display and mint,
agent-forced rail vs human choice, re-choice double-token) — each asserting the `params_hash` drift
hard-fail and single-order-per-draft invariants.
