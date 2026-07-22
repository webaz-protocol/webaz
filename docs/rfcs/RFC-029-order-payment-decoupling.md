# RFC-029: Buyer-Chosen Payment Rail — Choose-at-Confirm & Order–Payment Decoupling / 买家在支付阶段选择支付轨道

**Status**: draft (design-only — implementation gated, see §Gating)
**Author**: @holden (drafted with Claude from a live ChatGPT buyer-canary session, 2026-07-21; revised
2026-07-22 to a two-tier design after mapping the current rail-selection code path)
**Created**: 2026-07-21
**Track**: exploratory
**Related issue**: (n/a — seeded by Phase-3B live findings)
**Threat model**: `RFC-029-threat-model.md` (v1 merged #488; v2 delta in this revision covers Design A)

---

## Summary / 摘要

Today an order's payment rail is chosen by the **agent** at quote time (optional input, default
`escrow`), frozen, inherited unchanged through draft → submit, and bound into the human Passkey's
`params_hash`. **The buyer never chooses.** The user's requirement (Holden, live ×3): payment choice
MUST happen at the **payment stage, chosen by the buyer** — never frozen at quote time by the agent.

This RFC specifies the change in **two tiers**, because the right shape depends on how many rails are
concurrently real:

- **Design A — Choose-at-Confirm (near-term, recommended)** for today's two rails (`escrow` sim,
  `direct_p2p` off-platform). The rail is **deferred** (not chosen at quote); the **human picks it on
  the webaz.xyz confirm page, before the order is created**, and that choice is bound into
  `params_hash` at that moment. Minimal state-machine impact: **no new order state, no unpaid orders,
  no soft stock-reservation, no payment_quote_token.**
- **Design B — Order-First Decoupling (PSP-era)** for when a real async PSP rail (e.g. dtcpay/card)
  exists. Creates a pending order (`awaiting_payment_method`), lists options, mints a
  `payment_quote_token`, and Passkey approves the **payment execution** (not order creation). Design A
  is a strict precursor — B extends it, does not rewrite it.

今天支付轨道由 **agent** 在报价期选定(缺省 `escrow`)并冻结、绑进 Passkey。目标=改由**买家在支付
阶段选**。分两档:**Design A(近期,推荐)**——轨道**延迟**到 webaz.xyz 确认页、**建单之前**由真人选,
选择当场绑进 `params_hash`;**无新订单态、无未付订单、无软占库存、无 pqt**。**Design B(PSP 时代)**——
订单先建(`awaiting_payment_method`)、列选项、pqt、Passkey 批准**支付执行**;A 是 B 的严格前身。

## Motivation / 动机

- **Fact-checked current coupling** (2026-07-21/22 code audit): `payment_rail` freezes at quote
  (`buyer-quote.ts:203`, default `escrow`), draft inherits verbatim (`order-draft.ts:111`), it rides
  in `params_hash`/`intent_hash` (`order-submit-request.ts:35,98`), and the Passkey approval both
  **creates the order and executes the rail's economic effect** in one act (escrow debits
  wallet→escrow at approval; `order-submit-exec.ts`). `direct_p2p` is seller/product eligibility-gated
  and creates `status=created` then the buyer pays off-platform.
- **The concrete harm today**: because the agent defaults to `escrow` (a *simulated* ledger), a real
  buyer's order silently lands on the sim rail unless the agent happens to pass `direct_p2p`. Moving
  the choice to the human at confirm fixes "orders silently on the wrong/sim rail" — even before any
  PSP exists.
- **Why A before B**: order creation *forks* on the rail (escrow debits synchronously; direct_p2p
  creates-then-off-platform). So the rail must be known **before** create. For the current two rails
  there is no legitimate "rail-agnostic order that later becomes escrow-or-direct" — therefore the
  choice belongs at the last human touchpoint *before* creation (the confirm/Passkey page), and the
  order-first machinery (pending state, soft-reservation, pqt) is unnecessary weight. It becomes
  necessary only when a rail's payment is a genuinely async phase (PSP redirect) → Design B.

---

## Design A — Choose-at-Confirm (near-term, recommended)

**Invariant preserved:** the human still Passkey-approves the exact economic snapshot; we only move
*who* picks the rail and *when* — from agent@quote to human@confirm — keeping it **before** order
creation so `params_hash` still binds the rail the human approved.

### Flow (contrast with today)

| Stage | Today | Design A |
|---|---|---|
| Quote (`buyer-quote.ts:203`) | agent passes `payment_rail`, default `escrow`, **frozen** | rail **deferred**: quote/draft carry `payment_rail = null`; rail excluded from the pre-choice `intent_hash` |
| Draft / submit | inherits frozen rail | rail absent until chosen; `submit` produces a rail-agnostic pending approval request |
| **Confirm page (webaz.xyz, human present)** | rail shown **read-only** | **rail selector**: server lists only *eligible* rails; human picks → **`params_hash` minted with the chosen rail** |
| Passkey (`agent-grants.ts:966`) | binds `params_hash` (frozen rail) | binds `params_hash` (**chosen** rail) — same crypto guarantee, same drift-hard-fail (`order-submit-exec.ts:122`) |
| Create | forks on frozen rail | forks on chosen rail (existing escrow / `direct-pay-create.ts` paths unchanged) |
| ChatGPT card (quote-approval widget) | shows rail read-only | no rail pre-fix; "支付方式将在你确认时选择", hands off to confirm page |

### Components to build (Design A)
1. **Rail-deferred quote/draft/submit** — permit `payment_rail = null` end-to-end; keep it out of the
   pre-choice `intent_hash`; the rail joins `params_hash` only at the confirm/choice step.
2. **Eligible-rails read surface** for the confirm page — reuse `evaluateDirectPayLaunchControls` +
   `direct-pay-availability.ts` (direct_p2p) and a buyer WAZ-balance check (escrow). Returns **only
   gate-passing rails**, each with its honest settlement note; never leaks *why* a seller failed
   (`coarsenBuyerFacingDirectPayCode`).
3. **Confirm-page rail selector** (webaz.xyz) that sets the rail → mints the WebAuthn gate token bound
   to `{request_id, draft_id, action, params_hash(with chosen rail)}`.
4. **Widget copy change** (quote-approval widget) — remove rail pre-fix; point to the confirm page.

### Honesty framing (Design A) — decision needed, see §Menu-boundary
`escrow` is a **simulated** ledger; `direct_p2p` is **off-platform, non-custodial**. Presenting both
as a "payment method" risks "托管" reading as real buyer protection. Recommended near-term framing
(b): treat the choice as **"opt into real direct-pay vs the sim default,"** with stark labels
(托管 = 模拟测试·非真实结算 / 直付 = 你直接付卖家·平台不托管). The menu becomes genuinely multi-option
when a PSP (Design B) lands.

---

## §Menu-boundary — WHO decides the menu vs. WHO picks (OPEN — pending Holden's supplement)

Two layers, deliberately separated:
- **Layer 1 — which rails are *possible* (the menu):** decided **upfront** at deployment/config +
  per-seller (`DIRECT_PAY_*` switches, region allowlist, seller KYC/bond/receiving-account, breaker).
- **Layer 2 — which rail *this buyer* uses:** picked by the buyer at the confirm screen, **only from
  the Layer-1 menu**.

These are complementary ("部署先定好" = Layer 1; "买家支付界面才选" = Layer 2). The **open decisions**
Holden will supplement (recommendation in *italics*, easy to change — no code depends on this yet):

1. **Menu scope** — is the menu **deployment-global** (same eligible rails for every order) or
   **per-seller / per-product** (each seller enables their own set)? *Rec: per-seller eligibility is
   already how `direct_p2p` gating works; keep menu = per-seller-and-product eligible set.*
2. **Always prompt vs. auto** — when the eligible menu has exactly **one** rail, does the buyer still
   see a prompt, or auto-proceed? *Rec: single-eligible → auto (no prompt); prompt only when ≥2.*
3. **Seller/operator override** — may a seller **pre-pin** a default or a single allowed rail for
   their store (removing buyer choice)? *Rec: allow a seller default (pre-selected) but not a hard
   lock in Design A; revisit if a store needs escrow-only or direct-only.*

*(This section is intentionally unresolved; the rest of Design A does not depend on the answer beyond
"the confirm page renders whatever the Layer-1 evaluator returns.")*

---

## Design B — Order-First Decoupling (PSP-era)

When a real **async** payment phase exists (PSP redirect/webhook), the order legitimately exists
before payment, and the four-phase decoupling becomes correct:

1. **Create pending order** — freeze goods/qty/seller/price/region/shipping/tax/return/expiry;
   `status = awaiting_payment_method`; no fund movement, no Passkey. Emits `order_id`
   (or `checkout_id` pre-order variant).
2. **List payment options** — `webaz_payment_options(order_id)` → server-computed eligible methods
   with FINAL payable per method `{method, payable, buyer_fee, currency, fx_expires_in,
   buyer_protection, refund_terms, settlement_note}`. Only gate-passing rails (ACP honesty:
   `is_eligible_checkout=false` stays honest; never a simulated rail as real).
3. **Payment quote** — `webaz_quote_payment(order_id, payment_method)` → short-lived
   `payment_quote_token` binding order_id + method + final amount + fees + FX + recipient +
   protection/refund + expiry. (PAYMENT quoting becomes its own object; goods quoting stays
   product-side.)
4. **Passkey approves the economic action** — binds `{order_id, payment_method, payable, currency,
   fees, recipient, buyer_protection, refund_terms, params_hash}`. Post-approval per adapter:
   escrow → custody transfer; direct_p2p → receiving instruction + awaiting-payment; PSP → payment
   session/redirect; bank → instruction; onchain → network+address.

### Payment Adapter SPI (Design B)
`is_available(order)` · `quote(order)` · `create_payment(order, pqt)` · `get_status(payment)` ·
`cancel(payment)` · `refund(payment)` · `reconcile(webhook)` — core owns order truth + the approval
gate; adapters (Escrow / DirectPay / DtcPay / Stripe / BankTransfer) own channel mechanics. Core never
learns channel internals; adapters never touch order state directly.

### Stock handling (Design B only)
Order-first means possibly-unpaid orders: `payment_deadline` / `reservation_expires_at`; soft-reserve
stock ~15 min on creation, auto-release on expiry; re-check at execution; **NEVER accept funds then
report out-of-stock** (hard invariant). *(Design A has none of this — no order exists until after the
rail is chosen and Passkey-approved.)*

---

## Impact / 影响面

**Design A (near-term):**
1. **Order state machine**: **no new state.** The pending approval request becomes rail-agnostic until
   the confirm step; the order is still created at Passkey as today.
2. **Money path**: approval still == economic execution at create; the only change is the rail is
   chosen by the human at confirm rather than the agent at quote. `params_hash` binding + drift-hard-
   fail preserved.
3. **Idempotency**: the pre-choice `intent_hash` (quote/draft) omits the rail; the rail joins
   `params_hash` at the choice step. Each `(draft, chosen-rail)` is one intent; re-choosing a
   different rail = a fresh `params_hash` (fresh gate token), never a silent swap.
4. **Widget/UX**: card stops threading the rail; confirm page gains the selector.

**Design B (PSP-era):** as in the original RFC — new `awaiting_payment_method` state + expiry +
soft-reservation lifecycle; RFC-021's approve-to-execute object re-points from "order creation" to
"payment execution"; payment-phase idempotency (`payment_quote_token`) with its own replay/expiry;
unpaid-order cancellation/timeout faults are new fairness territory (无责方零成本).

## Gating / 实施门槛

- **Design A** may proceed once: (a) this revision's threat-model **v2 delta** is written & reviewed,
  (b) Codex adversarial review of the rail-defer + params_hash-binding diffs, (c) Holden's explicit
  go, (d) the §Menu-boundary decisions are settled. It does **not** require a second real rail — its
  value is human-chosen rail + honest disclosure on the current two.
- **Design B** stays gated additionally on a real concurrently-eligible PSP rail (dtcpay/card
  approved and gated). Until then Design A is the correct, smaller shape.

## Non-goals now / 当前非目标
- No custody expansion (USDC display-alias discipline unchanged; 铁律不动).
- No simulated multi-rail UI before real gates pass (ACP honesty rule).
- Design A does not touch the escrow / direct-pay *create* mechanics — only *when/who* selects the
  rail feeding them.

## Alternatives considered / 备选
- **Keep coupling, agent still picks but exposes a comparison**: cheaper, but leaves the choice with
  the untrusted narrator (agent), not the human — rejected (violates the driver).
- **Jump straight to Design B (order-first) for the two current rails**: over-weight — introduces
  unpaid orders + soft-reservation + pqt with no async payment phase to justify them — rejected as
  near-term shape; adopted only when PSP lands.
- **`checkout_id` (pre-order) instead of a real order in Design B Phase 1**: viable variant; decide at
  B-implementation time on stock-reservation economics.
