# RFC-022: Payment Provider Seam — first-class payment entity + provider interface, no real money / 支付 provider 架构缝(payment 实体 + provider 接口,零真钱)

**Status**: draft (design; **no real money, no custody, no mainnet** — every real-money/on-chain/PSP leg stays GATED behind its existing hard gate) — 2026-07-08
**Author**: @seasonkoh + agent
**Track**: normal-but-sensitive — money-path-adjacent + schema + touches settlement/state-machine. Does NOT move real funds, does NOT change escrow/direct_p2p money behavior, does NOT un-gate any custody/PSP leg.
**Related**: RFC-014 (money integer units — reused, not changed) · RFC-015 (ACP compat; this builds its P1) · RFC-016 (tx atomicity) · RFC-018 (settlement clearing) · `src/payment-rails.ts` (the unwired rail interface this wires) · `src/deposit-rails.ts` / `contracts/MerchantBondVault.sol` / `src/pwa/internal/wallet-signer.ts` (gated custody seams left untouched)

---

## 0. Scope decision (user, 2026-07-08)
Build **Option A — the payment provider architecture seam**. Direct Pay Rail 1 (non-custodial) is live; this board makes PSP + on-chain USDC **pluggable** by introducing a first-class payment entity + a provider interface, **without** building the real-money/custody legs. Those stay gated on their existing prerequisites (see §7). This is the "底座" work that lets a real PSP / audited on-chain custody drop into a fixed interface later.

## 1. Paradigm comparison (summary — full 5-part in chat 2026-07-08)
- **Type**: Hybrid, trust-layer-weighted. The *provider interface + payment-session lifecycle + capability declaration + async/webhook + idempotency* shape is generic infra (Medusa v2 Payment Module / Saleor gateways / Sylius-Payum / Spree payments — all four share it). The *settlement/custody substance* (capture=escrow-not-payout, non-custodial direct_p2p, on-chain custody, conservation, iron-rule, disclosure gates) is self-built + audit-gated.
- **Key structural fact**: `src/payment-rails.ts` already declares a `PaymentRail` interface + the 4-rail enum (`escrow|direct_p2p|onchain_full_stake|psp`) but it is **unwired** (`getPaymentRail` has zero callers). Live paths bypass it: escrow → legacy `settleOrder` body + `computeSettlementSplit`; direct_p2p → `createDirectPayResponse` → `settleDirectPayFeeAtCompletion` → `accrueFeeReceivable`. **There is no first-class payment entity today** — rail is just a column on the order and settlement is inline.
- **Borrow**: (1) payment decoupled from order as its own entity; (2) provider interface with declared capabilities; (3) a payment state machine; (4) webhook→event→reconcile; (5) idempotency + reconciliation.
- **Cannot borrow**: capture=payout semantics (WebAZ capture=escrow-funded), non-custodial direct_p2p, on-chain collateral vault, iron-rule Passkey gates, RFC-014 conservation/money core, custody-key model, eligibility gating (KYB, sanctions screening, AML checks, and bond eligibility), disclosure-gated checkout.

## 2. Goals / non-goals
**Goals**
- A first-class `payment_session` entity decoupled from the order, with a **subordinate** payment state machine.
- A `PaymentProvider` interface + capability registry; wire the 2 LIVE rails (escrow, direct_p2p) as providers that **wrap existing money behavior unchanged**; register `onchain_full_stake`/`psp` as **disabled providers** (declare capabilities, throw on any money op).
- Wire the currently-dead `payment-rails.ts` seam.
- ACP RFC-015 **P1** ACP-compat / **notional-WAZ** checkout scaffold (create/update/complete/cancel), mapping `complete` to the existing notional WAZ/escrow-funding path (no PSP, no real money, **not** crypto payment).
- Make `is_eligible_checkout` and rail availability **data-driven from provider capabilities** instead of hardcoded.

**Non-goals (explicit)**
- No real money moves. No fiat PSP charge. No on-chain USDC custody/settlement. No mainnet contract. No change to money.ts/ledger.ts/settlement-math.ts arithmetic. No change to escrow or direct_p2p money behavior. No new competing settlement authority. No un-gating of deposit-rails/MerchantBondVault/wallet-signer.

## 3. Architecture

### 3.1 payment_session entity (PR-1)
A record per order (forward-only; created at order creation), decoupled so a future provider can hang state on it:
```
payment_session(
  id, order_id (FK, 1:1 for v1), provider_id (= payment_rail),
  amount_units INTEGER,            -- SNAPSHOT (P1-c locked): written ONCE at order-total lock; single authority.
                                   --   never a second editable amount source vs orders.total_amount (see §6.7)
  currency TEXT,                   -- 'WAZ' notional pre-launch (honest, not ISO-4217)
  status TEXT,                     -- payment state machine (§3.2)
  settlement_kind TEXT,            -- 'notional_ledger' (escrow) | 'off_platform' (direct_p2p) | 'gated'
  is_custodial INTEGER,            -- 0 for both live rails (honest: neither is real custody)
  funded_at, settled_at, refunded_units, provider_ref, idempotency_key,
  created_at, updated_at )
payment_event(                     -- append-only audit/projection log. BUILT IN PR-1 (P2-c), same batch as
                                   --   payment_session — every status projection from an order event writes one row.
                                   --   No webhook yet; internal events only until a real async provider arrives.
  id, payment_session_id, type, from_status, to_status, detail_json, created_at )
```

### 3.2 payment state machine — SUBORDINATE, not a competing authority
States: `initiated → escrow_funded|off_platform_committed → settled | refunded | voided | failed`.
**Hard rule (locked): the ORDER state machine + `settleOrder` remain the single settlement authority.** `payment_session.status` is a *projection derived from* order events, not a driver of them. Transitions are written **inside the same `db.transaction` as the order transition that causes them** (RFC-016 atomicity), e.g. order `paid` → payment `escrow_funded`; order `completed`+settle → payment `settled`. The payment SM never independently moves money, never releases escrow, never overrides an order transition. This is the memory invariant "不借冲突状态机".

### 3.3 PaymentProvider interface + capability registry (PR-2)
Minimal interface matching what the 2 live rails actually do (anti-YAGNI, matching `payment-rails.ts` header stance — do NOT model authorize/capture until a real PSP needs it):
**PR-2 wires ONLY `describe()` + `onOrderFunded()` (the observe hooks). `onSettle`/`onRefundOrVoid` are RESERVED for PR-2b — declared-but-inert in PR-2, never called (settleOrder stays sole authority).**
```ts
interface PaymentProvider {
  id: PaymentRailId
  describe(): ProviderCapabilities   // { is_custodial, settlement_kind, supports_refund,
                                      //   is_async, needs_external_receipt, checkout_eligible, enabled }
  onOrderFunded(ctx): void           // [WIRED IN PR-2] order paid → project payment_session + payment_event
                                      //   (observe only — moves no money; escrow: mark funded; direct_p2p: mark)
  onSettle(ctx): void                // [RESERVED FOR PR-2b — NOT CALLED IN PR-2] future adapter over the live
                                      //   settle path; settleOrder remains sole settlement authority until PR-2b
  onRefundOrVoid(ctx): void          // [RESERVED FOR PR-2b — NOT CALLED IN PR-2]
}
```
- **PR-2b (not PR-2) design target:** an escrow provider `onSettle` that wraps the **current live** `computeSettlementSplit` path (notional), and a direct_p2p `onSettle` wrapping the **current live** `settleDirectPayFeeAtCompletion` / `accrueFeeReceivable` + off-platform semantics — **neither changing a line of money math** (adapter over current calls). In **PR-2 these are declared-but-inert**; nothing dispatches through them, settleOrder is untouched.
- **P1-b (locked): PR-2 must REPLACE/deprecate the existing `payment-rails.ts` `PaymentRail` interface + its `RAIL_DIRECT_P2P` impl, which still points at deprecated WAZ fee-stake helpers (`takeFeeAtCompletion`/`releaseFeeStake`/`slashFeeStakeToPenalty`, `payment-rails.ts:33,49`). The direct_p2p provider MUST bind to the current live AR path, and MUST NOT call `RAIL_DIRECT_P2P.collectFeeAtCompletion` or any WAZ fee-stake helper.** Wiring out the dead seam ≠ resurrecting its old semantics.
- `RAIL_ONCHAIN_FULL_STAKE`, `RAIL_PSP` register as **disabled providers**: `describe().enabled=false`, every money method throws `PAYMENT_RAIL_DISABLED` (formalizes today's ad-hoc gate at MCP `server.ts:2654`).
- **P1-a (locked): PR-2 v1 does NOT touch `settleOrder`.** The registry is introduced and providers only **observe** — write/project `payment_session` + `payment_event` alongside the existing settle path. `settleOrder` keeps its own `if payment_rail==='direct_p2p'` branch as the sole settlement authority. Converting the settle dispatch to `getProvider(rail).onSettle(...)` is a **separate later PR-2b**, done only under a byte-identical behavioral test + `settlementConserves`, or not at all. `settleOrder` (`server.ts:6898`) is money-path core — the seam board never refactors it as a side effect.

### 3.4 ACP checkout compat — notional-WAZ checkout scaffold (PR-3)
**Naming (P2-b): this is an ACP-compatible / notional-WAZ checkout scaffold, NOT crypto payment.** It carries no real money and no crypto settlement — do not name it "crypto checkout" anywhere (titles + fields say "notional WAZ" / "ACP checkout compat") so external readers don't read it as live crypto support.
Implement RFC-015 P1: ACP checkout session shape (create/update/complete/cancel, REST + MCP) where `complete` maps to the EXISTING notional WAZ/escrow-funding path — reuse `checkout-helpers.ts` + `ap2-mandate.ts` + `verify_price` lock. `is_eligible_checkout` becomes true **only** for the escrow (notional WAZ) rail; PSP/USDC stay false (data-driven from `describe().checkout_eligible`). No real money, no PSP.

### 3.5 Capability-driven honest gating (PR-4, optional)
Replace hardcoded `is_eligible_checkout=false` (`acp-feed.ts:92`) and rail enum restrictions with values read from the provider registry `describe()`, so the honest-disabled constraint is one source of truth. (The `payment_event` table is built in PR-1, not here — see §3.1 / P2-c.)

## 4. Decisions to LOCK (recommendations — for Codex + user review)
- **D1 — payment_session authority**: **subordinate projection** (order SM stays authoritative), NOT a new source of truth. *Rec: subordinate.* Rationale: additive, non-breaking, respects the no-competing-state-machine rule; can be promoted to authoritative only at the real-money phase.
- **D2 — migration**: **forward-only** — payment_session created for new orders; historical orders get a read-time projection if a UI needs it, no rewrite of past settlements. *Rec: forward-only.*
- **D3 — escrow honest labeling**: keep the `escrow` provider id (enum/data back-comfort) but `describe()` declares `is_custodial=false, settlement_kind='notional_ledger'`; buyer copy stays honest (no "your funds are held in custody"). *Rec: keep id, honest capabilities.* (Guards the "非托管不得贴真托管标签" rule.)
- **D4 — interface shape**: **minimal** `describe/onOrderFunded/onSettle/onRefundOrVoid`, no authorize-vs-capture split until a real PSP needs it. *Rec: minimal.*
- **D5 — settleOrder ownership (P1-a, LOCKED)**: PR-2 providers **observe only** (write/project payment_session + payment_event); `settleOrder` keeps sole settlement authority. The settle-dispatch-through-registry refactor is a **separate PR-2b**, done only under a byte-identical test + `settlementConserves`, or not at all. The seam board never refactors `settleOrder` as a side effect.
- **D6 — amount snapshot (P1-c, LOCKED)**: `payment_session.amount_units` is written ONCE when the order total is finally locked, and is a snapshot — never a second editable authority. Any path that mutates `orders.total_amount` after funding is either forbidden or MUST update payment_session + write a payment_event in the same tx. No two live amount authorities.
- **D7 — deprecate old PaymentRail (P1-b, LOCKED)**: PR-2 replaces/deprecates the existing `payment-rails.ts` `RAIL_DIRECT_P2P` impl (deprecated WAZ fee-stake helpers); providers bind to the current live paths, never to the old `collectFeeAtCompletion`/fee-stake helpers.

## 5. PR split (serial, each a draft PR, no merge/auto-merge, self-check + STOP for review)
| PR | Scope | Real money? | Schema | Key guards |
|---|---|---|---|---|
| **PR-1** | `payment_session` **+ `payment_event`** tables (P2-c: both same batch) + pure payment state-machine module + **create session on BOTH build paths** (P2-a: normal escrow `orders-create.ts` AND direct_p2p `createDirectPayResponse` at `orders-create.ts:302`) + project status from existing order transitions, each projection writes a payment_event. `amount_units` snapshot at total-lock (P1-c/D6). Additive; **settleOrder untouched**. | none | +2 tables | **acceptance: both create paths create a session (no rail drift day 1)** · amount single-authority · ALTER-AFTER-CREATE · pg parity · fresh-DB bridge · MCP schema helpers · tx atomicity |
| **PR-2** | `PaymentProvider` interface + registry; wrap escrow + direct_p2p as providers over the **current live paths** (behavior unchanged); **replace/deprecate the old `payment-rails.ts` RAIL_DIRECT_P2P WAZ-fee-stake impl (P1-b/D7)**; register onchain/psp as disabled-throwing; providers **observe only — do NOT touch settleOrder (P1-a/D5)** | none | none | providers observe-only · no `settleOrder` edit · no WAZ fee-stake helper call · seam ratchet · `PAYMENT_RAIL_DISABLED` preserved |
| **PR-2b** (later, gated on need) | convert `settleOrder` settle-dispatch to `getProvider(rail).onSettle(...)` — **only** under a byte-identical behavioral test + `settlementConserves`; may be declined entirely | none | none | byte-identical settle test · settlementConserves · money-path Codex-gated |
| **PR-3** | ACP-compat **notional-WAZ** checkout scaffold (create/update/complete/cancel REST+MCP) → notional escrow-funding; reuse checkout-helpers/AP2/verify_price. **Not** named crypto (P2-b) | none (notional WAZ) | maybe +1 (acp_checkout_session) | is_eligible_checkout honest · PII party-gated · iron-rule preserved · api-docs regen |
| **PR-4 (opt)** | capability-driven feed/UI `is_eligible_checkout` gating (one source of truth). (payment_event already built in PR-1) | none | none | one-source-of-truth capabilities |

## 6. Invariants (LOCKED)
1. **No real money moves anywhere in this board.** Escrow = notional WAZ ledger; direct_p2p = off-platform + off-chain fee AR. Unchanged.
2. **Money core reused, never reimplemented** — money.ts / ledger.ts / settlement-math.ts are the only arithmetic; `settlementConserves` must hold.
3. **Order state machine + settleOrder remain the settlement authority**; payment SM is subordinate and writes inside the same tx (RFC-016).
4. **Gated stays gated** — onchain_full_stake / psp providers throw; deposit-rails, MerchantBondVault, wallet-signer untouched; `is_eligible_checkout=false` for PSP/USDC; no mainnet.
5. **Honest labeling** — non-custodial rails never labeled as real custody; disclosures D1/D2 unchanged; the ACP checkout scaffold is named "notional-WAZ / ACP-compat", never "crypto checkout" (P2-b).
6. **Iron-rule + disclosure gates preserved** — value-moving confirmations (mark_paid) keep their Passkey/disclosure gates; ACP authorization is buyer-input, not a bypass.
7. **amount_units is a snapshot, single authority** (P1-c/D6) — written once at total-lock; `orders.total_amount` and `payment_session.amount_units` never coexist as two editable authorities; post-funding total mutation is forbidden or same-tx-synced + evented.
8. **The seam never refactors settleOrder** (P1-a/D5) — PR-2 providers observe only; settle dispatch conversion is a separate gated PR-2b. And **no resurrecting WAZ fee-stake** (P1-b/D7) — providers bind current live paths, never the deprecated `RAIL_DIRECT_P2P` helpers.

## 7. Explicitly GATED — NOT this board (need a decision/prerequisite, not code)
- **Real PSP charge leg** (RFC-015 P2): choose PSP + merchant account + compliance (DTSP / real-money boundary) + RFC-014 real-settlement flip + re-verify ACP payment spec. Then a provider *implementation* plugs into PR-2's interface.
- **On-chain USDC custody/settlement**: legal opinion + **independent external contract audit** + Holden mainnet approval (MerchantBondVault §9 three-gate) + custody-key infra (KMS/Safe, not the in-process seed signer).
- **deposit-rails `usdc_onchain`/`fiat_psp` un-throwing**: same gates.

## 8. Risk register
- **Highest-category (money/settlement/schema/state-machine)** — mitigated by: additive (PR-1 and PR-2 do NOT refactor settleOrder at all; **only the separate PR-2b may do so, and only under a byte-identical behavioral test + `settlementConserves`, or be declined**), money core reuse, no real funds, gated legs stay throwing.
- **Competing-authority risk** — mitigated by D1 (subordinate) + same-tx writes.
- **Scope-creep-into-custody risk** — mitigated by §6.4 + §7 explicit gates + disabled-throwing providers + capability `enabled=false`.
- **Schema/pg parity** — new tables via fresh-DB bridge + `pg:verify` fresh-boot + MCP schema helpers.
- **api-docs drift** — PR-3 new endpoints → `gen:api-docs`.
- **Browser smoke** — ACP P1 notional-WAZ checkout partially headless-smokeable (mark_paid step needs Passkey → hand-off).

## 9. Open questions (remaining after Codex round 1)
- payment_session ↔ order cardinality: 1:1 for v1 (one rail per order); confirm no split-tender need pre-launch.
- ACP P1: reuse the existing MCP server surface vs a separate REST surface (RFC-015 open q); MCP reuse is cheaper.

*(Resolved in Codex round 1, 2026-07-08 → now LOCKED: settleOrder-dispatch refactor moved to a separate gated PR-2b, providers observe-only in PR-2 [P1-a/D5]; amount_units is a write-once snapshot, single authority [P1-c/D6]; old WAZ fee-stake PaymentRail impl deprecated, never re-used [P1-b/D7]; payment_event built in PR-1 [P2-c]; both build paths must create a session [P2-a]; ACP scaffold named notional-WAZ not crypto [P2-b].)*
