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
| **Confirm page (webaz.xyz, human present)** | rail shown **read-only** | **option selector**: server lists only *seller-supported + eligible* options (rail × method); 1 → auto, ≥2 → human picks → **`params_hash` minted with the chosen `{rail, account}`** |
| Passkey (`agent-grants.ts:966`) | binds `params_hash` (frozen rail) | binds `params_hash` (**chosen option**) — same crypto guarantee, same drift-hard-fail (`order-submit-exec.ts:122`) |
| Create | forks on frozen rail | forks on chosen rail; `direct_receive_account_id` from the chosen option (existing escrow / `direct-pay-create.ts` paths unchanged) |
| ChatGPT card (quote-approval widget) | shows rail read-only | no rail pre-fix; "支付方式将在你确认时选择", hands off to confirm page |

### Components to build (Design A)
1. **Option-deferred quote/draft/submit** — permit `payment_rail = null` (and no
   `direct_receive_account_id`) end-to-end; keep both out of the pre-choice `intent_hash`; they join
   `params_hash` only at the confirm/choice step.
2. **Seller-supported payment-options surface** for the confirm page — server-computes the flat option
   list `[{option_id, rail, method, recipient_label, payable, currency, settlement_note,
   recommended?}]` = escrow (if enabled + buyer WAZ balance) **plus** one option per the seller's
   active `direct-receive-accounts` when `direct_p2p` gates pass (`evaluateDirectPayLaunchControls` +
   account resolution). Returns **only supported + gate-passing options**; honest per-option
   settlement note; never leaks *why* a seller failed (`coarsenBuyerFacingDirectPayCode`). A seller
   `recommended` flag marks a soft default only.
3. **Confirm-page option selector** (webaz.xyz) — if 1 option, auto-select; if ≥2, the human picks
   (recommended pre-selected). The choice sets `{payment_rail, direct_receive_account_id}` → mints the
   WebAuthn gate token bound to `{request_id, draft_id, action, params_hash(with chosen option)}`.
4. **Widget copy change** (quote-approval widget) — remove rail pre-fix; point to the confirm page
   ("支付方式将在你确认时,从卖家支持的方式中选择").

### Design-A prerequisites & corrections (adversarial review, 2026-07-22)

Codex read-only design audit confirmed the core thesis (create forks on rail → choice must precede
create → no order-first machinery needed; Passkey binding + drift-hard-fail as described) and surfaced
six concrete implementation prerequisites the first draft under-stated. Folded in:

- **P1 — `payment_rail` is `NOT NULL` today** (`webaz-schema-helpers.ts:2115` quotes, `:2161` drafts;
  hashes stringify it at `order-submit-request.ts:35,98`). "Defer to null" therefore requires a schema
  migration to make quote/draft `payment_rail` (and `direct_receive_account_id`) **nullable**, plus
  excluding them from the pre-choice `intent_hash` — not a pure flow change.
- **P2 — default-to-escrow projections must learn "not yet chosen."** Sites that default a missing
  rail to `escrow` (all must render **pending/未选择** for a deferred rail, never silently escrow, else
  TA3/TA4 leak): `agent-model-projection.ts:449`, `:475`, and the **summary path `:196`**;
  `submitRowSummary` stringifies a null-like rail (`order-submit-request.ts:68`); the quote-approval
  widget shows `out.payment_rail || 'escrow'` (`quote-approval-body.ts:60`); approval `economic_effect`
  treats any non-direct rail as escrow (`approval-requests-read.ts:72`); **and the PWA approval page**
  renders non-direct summaries as escrow (`app-agent-approvals-submit.js:16`). (Round-2 expanded the
  site list.)
- **P3 — the chosen rail must land in the DRAFT (executor's source of truth), not just the request.**
  One active `order_submit` per draft is enforced (`webaz-schema-helpers.ts:1904,1965`; reuse-existing
  at `order-submit-request.ts:112,190`), so re-choice does **not** mint a second request. BUT round-2
  showed updating only `agent_permission_requests.params_hash` is insufficient: execution **recomputes
  the hash from `order_drafts` and creates from draft fields** (`order-submit-exec.ts:102,115,144`) —
  if the draft still holds the old/null rail, exec drift-hard-fails or creates the wrong rail. → The
  chosen `{payment_rail, direct_receive_account_id}` must become the **execution source of truth**:
  persist it into the pending draft (or a bound choice object the executor reads) AND update the
  request `params_hash`, atomically, before the gate token is minted. See §Choice/update contract.
- **P7 — the PWA approval page currently blocks a rail-deferred request.** `aaEconomicIncomplete`
  disables approval when `payment_rail` is missing (`app-agent-approvals-state.js:34`). Intended for
  Design A: a deferred-but-unchosen request stays **correctly non-approvable** until the choice sets
  the rail; the approval button enables only **after** the confirm-page choice writes the rail. The
  page's "missing rail = incomplete" logic must distinguish *deferred-awaiting-choice* from *broken*.
- **P4 — render eligibility ≠ create eligibility.** The options surface can evaluate launch controls +
  account resolution + open-order cap + exposure at render, but the FULL create gate stack
  (`direct-pay-create.ts:151-219`: product verification, deferral quota, fee-prepay, …) is only
  authoritative at create. Render is **best-effort**; create re-checks and may still reject with an
  honest failure. The RFC must not present render-eligibility as a guarantee.
- **P5 — options source must mirror `resolveDirectReceive`, not the launch-readiness helper.**
  Enumerate the seller's active accounts via `direct-receive-accounts.ts:89` **plus the legacy
  single-instruction fallback** — i.e. the same resolution `create` uses (`resolveDirectReceive`:
  chosen → legacy `getActivePaymentInstruction` → sole active account, `direct-receive-resolve.ts:43`;
  `direct-pay-create.ts:183`). Do NOT build the menu from `direct-pay-launch-readiness.ts:115` (only
  checks legacy) — it under-lists multi-account sellers; and enumerating *only* active accounts
  (round-2) under-lists **legacy-only** sellers. The menu = whatever `resolveDirectReceive` can yield.
- **P6 — no per-seller escrow opt-out exists yet** (escrow is the universal fallback:
  `orders-create.ts:261` defaults non-`direct_p2p` to escrow). See corrected §Menu-boundary note.

### §Choice/update contract (the server-side seam Design A hinges on — round-2 High)

The single endpoint that commits the buyer's confirm-page choice must be **atomic** and make the
choice the executor's source of truth. In one transaction:
1. **Validate** the chosen `option_id` against a freshly-recomputed eligible set (re-run the render
   gates; reject if no longer offered — TOCTOU guard, P4).
2. **Persist** `{payment_rail, direct_receive_account_id}` into the **pending draft** row (the field
   `order-submit-exec.ts:115,144` reads), so exec recomputes/creates from the chosen values.
3. **Recompute + update** the active request's `params_hash` from the now-updated draft
   (`order-submit-request.ts` hash inputs), keeping one-active-request-per-draft.
4. **Invalidate** any gate token bound to the prior `params_hash` (drift check at
   `agent-grants.ts:966` / `order-submit-exec.ts` fails it automatically once the hash changes).
5. Only then is the request approvable → Passkey mints against the new `params_hash` → create.

This closes the round-2 High (choice must feed the draft-based executor, not just the request row) and
keeps the whole flow inside the existing idempotency + drift-hard-fail invariants.

### Honesty framing (Design A) — settled by §Menu-boundary decision 3
Since every supported option stays selectable ("既然支持就都可以选"), each is shown with a **stark,
honest per-option settlement note** bound server-side: 托管 = 模拟测试·非真实结算 / 直付 = 你直接付
卖家·平台不托管. No label may imply custody a rail doesn't provide (threat MA4). **Correction (P6):**
today escrow is the **universal fallback** (`orders-create.ts:261`) — there is **no per-seller escrow
opt-out** in code, so escrow is in every seller's menu unless/until a per-seller "escrow disabled"
support flag is built (a small future addition, not assumed here). The menu becomes genuinely
multi-*rail* when a PSP (Design B) lands; today it is already multi-*option* whenever a seller exposes
>1 direct-receive method.

---

## §Menu-boundary — the menu is the seller-supported set; the buyer picks (RESOLVED 2026-07-22)

Two layers, deliberately separated, and the "menu item" is a **concrete payment option** — not a bare
rail. An option = `(rail, method)`, e.g. escrow-sim, or direct_p2p backed by a specific seller
receiving method (PayNow / bank / USDC account). This **subsumes** the earlier rail-vs-method framing:
the buyer sees a flat list of *what the seller actually supports and what currently passes gates*.

- **Layer 1 — the menu (which options are *possible*):** **per-seller (and per-product), from what the
  seller supports** — NOT a deployment-global fixed list. Sources: `DIRECT_PAY_*` switches +
  region/breaker (deployment) **intersected with** the seller's own support (KYC/bond +
  `direct-receive-accounts` the seller configured). "不同卖家支持的方式不一样 → 取卖家支持的集合。"
- **Layer 2 — the pick:** the buyer chooses one option from the Layer-1 set at the confirm screen.

**Resolved decisions (Holden, 2026-07-22):**
1. **Menu scope = per-seller, seller-supported options.** The confirm surface **fetches the seller's
   supported + gate-passing options** and offers them; different sellers → different menus.
2. **Single option → auto-default (no prompt).** When exactly one option is supported+eligible, the
   flow proceeds on it without asking; the selector appears only when ≥2.
3. **Seller may *recommend*, not *lock*.** A seller can mark one option as recommended (pre-selected /
   highlighted), but **every supported+eligible option stays buyer-selectable** — "既然支持就都可以
   选." No server path lets a seller's recommendation remove another supported option from the buyer's
   choice (see threat MA3: recommendation is a soft default, never a hard lock).

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

**Design A (near-term)** — smaller than B, but *not* zero-migration (see §Design-A prerequisites
P1–P6):
1. **Order state machine**: **no new order state.** But quote/draft need a **schema migration** to make
   `payment_rail`/`direct_receive_account_id` **nullable** (today `NOT NULL`, P1), and the pending
   submit request must permit a **`params_hash` update while pending** (P3). The order is still created
   at Passkey as today.
2. **Money path**: approval still == economic execution at create; the only change is the rail is
   chosen by the human at confirm rather than the agent at quote. `params_hash` binding + drift-hard-
   fail preserved. Default-to-escrow projections (P2) must be updated so a deferred rail reads as
   *pending*, never silently escrow.
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
