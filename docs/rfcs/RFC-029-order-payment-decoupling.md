# RFC-029: Order–Payment Decoupling & Payment Adapter SPI / 订单-支付解耦与支付适配器接口

**Status**: draft (design-only — implementation explicitly gated, see §Gating)
**Author**: @holden (drafted with Claude from a live ChatGPT buyer-canary session, 2026-07-21)
**Created**: 2026-07-21
**Track**: exploratory
**Related issue**: (n/a — seeded by Phase-3B live findings)
**Supersedes**: (n/a)
**Superseded by**: (n/a)

---

## Summary / 摘要

Today an order's payment rail is frozen at quote time, and the human Passkey approval is a single
composite act: it creates the order AND executes the economic effect (escrow rail debits
wallet→escrow at the approval instant). This RFC proposes decoupling three concerns — (1) confirming
the goods, (2) creating the order, (3) choosing and executing payment — introducing an
`awaiting_payment_method` order state, a `webaz_payment_options` surface, a short-lived
`payment_quote_token`, and a Payment Adapter SPI so rails/PSPs (escrow-sim, direct_p2p, dtcpay,
card, bank transfer, onchain) plug in as isolated modules. Passkey then approves the FINAL economic
action ("pay X via method M for order O"), not order creation.

今天支付轨道在报价期冻结,Passkey 批准=建单+资金动作一体。本 RFC 提议三段解耦:确认商品 → 创建
待支付订单(`awaiting_payment_method`)→ 用户选择支付方式(`webaz_payment_options` +
`payment_quote_token`)→ Passkey 只批准最终资金动作。支付渠道经统一 Adapter SPI 接入。

## Motivation / 动机

- **Fact-checked current coupling** (2026-07-21 code audit): `payment_rail` on the order-creation
  tool is OPTIONAL (default `escrow`; `direct_p2p` requires the seller's direct-receive account and
  server-side eligibility gates) — the buyer never "chooses a payment method" today. But the
  coupling is real: rail freezes at quote → draft inherits → Passkey approval creates the order and
  executes the rail's economic effect in one act. There is no `awaiting_payment_method` state.
- With a single effective rail per product this is fine. It stops scaling the moment a real PSP
  (e.g. dtcpay) or multiple concurrently-eligible rails exist: the buyer must see FINAL payable
  (fees, FX, buyer-protection differences) per method BEFORE committing funds, and that comparison
  point does not exist in the current flow.
- Weak-model hosts amplify the cost: every extra decision the model must thread (rail, token,
  draft) is a failure surface. Decoupling moves payment choice to a human-facing page.

## Design / 设计 (four phases)

1. **Create pending order** — freeze goods/qty/seller/price/address-region/shipping/tax/return
   terms/expiry. `status = awaiting_payment_method`. No fund movement, no payment instruction, no
   Passkey. Emits `order_id` (or `checkout_id` pre-order variant).
2. **List payment options** — `webaz_payment_options(order_id)` → server-computed eligible methods
   with FINAL payable per method: `{method, payable, buyer_fee, currency, fx_expires_in,
   buyer_protection, refund_terms, settlement_note}`. Honesty invariant: only rails whose gates
   pass are listed (ACP discipline: `is_eligible_checkout=false` stays honest; never a simulated
   rail presented as real).
3. **Payment quote** — `webaz_quote_payment(order_id, payment_method)` → short-lived
   `payment_quote_token` binding order_id + method + final amount + fees + FX + recipient +
   protection/refund terms + expiry. (Renames today's overloaded quote_token semantics: goods
   quoting stays product-side; PAYMENT quoting becomes its own object.)
4. **Passkey approves the economic action** — approval object binds
   `{order_id, payment_method, payable_amount, currency, fees, recipient, buyer_protection,
   refund_terms, params_hash}`. Post-approval per adapter: escrow → custody transfer; direct_p2p →
   seller receiving instruction + awaiting-payment; PSP → payment session/redirect; bank → payment
   instruction; onchain → network+address.

### Payment Adapter SPI

`is_available(order)` · `quote(order)` · `create_payment(order, pqt)` · `get_status(payment)` ·
`cancel(payment)` · `refund(payment)` · `reconcile(webhook)` — WebAZ core owns order truth and the
approval gate; adapters (EscrowAdapter / DirectPayAdapter / DtcPayAdapter / StripeAdapter /
BankTransferAdapter) own channel mechanics. Core never learns channel internals; adapters never
touch order state directly (they return standardized results).

### Stock handling

Order-first means possibly-unpaid orders: add `payment_deadline` / `reservation_expires_at`.
Recommended: soft-reserve stock ~15 min on order creation, auto-release on expiry; re-check stock
at payment execution; NEVER accept funds then report out-of-stock (hard invariant).

### Widget/UX consequence

Card button becomes 「创建订单」;after creation the page (webaz.xyz, human-facing) shows
「请选择支付方式」. Agents stop threading rail decisions entirely — aligned with the Phase-3B
weak-model discipline (widget does the work; the model only ferries).

## Impact / 影响面(为什么必须整 RFC 而不是顺手改)

1. **Order state machine** (iron-rule zone): new `awaiting_payment_method` state + expiry
   transitions + soft-reservation lifecycle.
2. **Money path**: today approval == economic execution (escrow debit at approval). Splitting
   changes RFC-021's approve-to-execute object from "order creation" to "payment execution".
3. **Idempotency**: BUG-08 intent identity currently spans quote→draft→submit; payment-phase
   identity (`payment_quote_token`) needs its own replay/expiry semantics.
4. **Arbitration/fault flows** read rail from the order; unpaid-order cancellation/timeout faults
   are new territory (fairness §fault principles apply: 无责方零成本).

## Gating / 实施门槛

Design-only until ALL of: (a) a second concurrently-eligible rail actually exists for real buyers
(e.g. dtcpay PSP integration approved and gated), (b) threat model written FIRST (per
security-artifact discipline), (c) Codex adversarial review of the state-machine + money-path
diffs, (d) Holden's explicit go. Until then the single-rail coupled flow remains correct and
simpler — this RFC exists so the PSP-era refactor starts from a settled design, not from scratch.

## Non-goals now / 当前非目标

- No change to current quote/draft/submit tools or their semantics.
- No simulated multi-rail UI before real gates pass (ACP honesty rule).
- No custody expansion (USDC display-alias discipline unchanged; 铁律不动).

## Alternatives considered / 备选

- **Keep coupling, add per-rail quote comparison pre-draft**: cheaper, but still forces rail choice
  before an order exists and keeps Passkey's composite semantics — rejected as the long-term shape.
- **checkout_id (pre-order) instead of real order**: viable variant of Phase 1; decide at
  implementation time based on stock-reservation economics.
