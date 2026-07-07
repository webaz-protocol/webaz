# RFC-007: Seller non-acceptance — fault differentiation & forfeit distribution / 卖家不接单的责任区分与罚没分配

**Status**: implemented (stages 1-5; auto-verify reframed to provisional+arbitration) — 2026-06-06
**Author**: @seasonkoh
**Track**: normal — protocol economics + order state machine + settlement (funds). Touches arbitration (iron-rule §4). New order state + protocol params → RFC + public comment.
**Related**: state machine `L0-2` (transitions/engine) · `settleFault` · dispute/arbitration `L3-1` · the fairness principle (公开透明 / 谁责任谁承担 / 无责方零成本) · ECONOMIC-MODEL

---

## Problem / 问题

When a seller does not accept a `paid` order within the 24h window, the protocol today does **one** thing: `paid → fault_seller`, forfeiting 15% seller stake (split buyer 50% / protocol 50%). Two faults with that:

1. **No objective/subjective distinction.** A seller who *objectively cannot* accept through no current fault (the unit was genuinely consumed elsewhere; the buyer ordered on a stale price/content snapshot that had already changed) is penalised identically to a seller who *could* accept but chooses not to. This violates fairness **§3 无责方零成本** — a no-fault party must bear zero cost.
2. **Forfeit ignores promoters.** The l1/l2/l3 promoters (snapshotted on the order at order time) drove the sale and incurred real promotion cost, yet on a faulted non-acceptance they are not compensated — the forfeit goes buyer 50% / protocol 50%.

> Quick map to the three fairness principles: **transparent** (rules public, classification deterministic where possible) · **责任自负** (only the at-fault seller pays) · **无责零成本** (objective no-fault → seller pays nothing, buyer fully refunded).

---

## Cases / 客观 vs 主观(枚举)

| Objective · no fault · no charge / 客观·无责·不扣 | Subjective · at fault · forfeit / 主观·有责·罚没 |
|---|---|
| Unit consumed by **non-seller** factor (concurrent paid order / other channel synced) took the last unit | Online stock ≠ reality because the **seller's own bookkeeping** was wrong |
| Buyer ordered on a **stale snapshot** (price/content had already changed before the order) | Regret: committed price too low, now refuses |
| Force majeure: item destroyed/lost (evidence) | Cherry-picking: low margin / waiting for a higher bid |
| Protocol-verifiable concurrent occupation | Could fulfil, chooses not to |

---

## Design / 设计

### 1. Explicit `decline` action + new state `declined_nofault`
- Seller may **decline** a `paid` order with a `reason_code` (instead of only silent timeout).
- New order state **`declined_nofault`** = a no-fault settlement terminal (parallel to `fault_seller`, but zero penalty).
- Silent timeout (no decline within 24h) keeps mapping to `fault_seller` (worst case: no response at all).

### 2. Classification: **auto-verify + arbitration fallback** (decision 1)

> **⚠️ Reframed at implementation (see Staged delivery §3).** The protocol already prevents *both* on-protocol objective scenarios at order creation — stock decrements atomically under a `stock >= qty` guard (no internal oversell) and an `expected_price` mismatch returns `409 PRICE_CHANGED` (a stale-price order can't be placed). So the genuine objective cases are **off-chain facts with no deterministic on-protocol signal**; an auto-verify classifier would be decorative (always fault). **Shipped instead:** objective-claimed declines → a *provisional fault* + a contest window → **human arbitration** (stage 5) is the sole path to `declined_nofault`. The original auto-verify text below is retained for design history.

On a `decline`, the protocol **attempts deterministic auto-verification** of the two protocol-observable objective conditions:
- **stale-snapshot race**: `order.content_hash_at_order` ≠ the listing's content/price hash that was already effective at the order timestamp (the listing had changed *before* the order; buyer used a stale client snapshot). Verifiable from `content_hash_at_order` + listing content/price history.
- **concurrent stock depletion**: another `paid`/accepted order for the same product consumed the unit after this order such that stock is genuinely 0 through no current seller action. Verifiable from order timestamps + stock.

Outcome:
- **Auto-verified objective** → `declined_nofault` (no penalty). Immediate, deterministic, transparent.
- **Not auto-verifiable** (any other reason, or silent timeout) → `fault_seller` (penalty).
- **Seller recourse (兜底)**: a seller who declines claiming objective but cannot be auto-verified is faulted **provisionally** and may escalate to **arbitration** (human, iron-rule §4) to prove objective no-fault. If upheld → reverse to `declined_nofault` and refund the forfeited stake. AI/agents never decide this (RFC-005 + CHARTER §4).

> Why not trust the seller's declared reason? A subjective seller would simply pick an "objective" reason. Auto-verify the deterministically-checkable cases; everything else carries the burden of proof to the seller via human arbitration. 责任自负.

### 3. Settlement

**`declined_nofault` (no fault):**
- buyer escrow **fully refunded**; seller stake **fully returned** (无责零成本); stock / secondhand status restored.
- no commission / PV / fund inflow (no real sale). promoters: nothing (no sale, no penalty pool).
- **Neutral reputation mark (locked)**: record a `no_fault_decline` event on the seller — **no funds, not a violation**, does not lower trade reputation. Purpose: a transparent, rate-observable signal so habitual decliners (gaming "objective" to dodge orders) are visible (and can be rate-limited / reviewed) without penalising a genuinely no-fault seller. Zero-cost, consistent with 无责零成本.

**`fault_seller` (subjective decline or silent timeout):**
- > **Superseded by [RFC-008](RFC-008-merchant-cost-collateral.md)**: `F` is no longer "the order's 15% stake". It is the realized **fault penalty** (`fault_penalty_rate`=30%, **decoupled** from the stake rate, drawn from the seller's staked pool + free balance, no mint). The *distribution of F* below is unchanged.
- buyer escrow fully refunded; seller stake (15%) forfeited, distributed by the rule below — **no party profits beyond its real loss/cost**; strict conservation (实扣多少分多少, never mint). Decision 2 (refined): buyer + promoters + protocol, but each take is **bounded by what it would have gotten / cost on a normal sale**, not a free-floating ratio.

Let `F` = forfeited stake. Distribution:
1. **Protocol** recoups its **original platform fee only, not more**: `protocolTake = min(F, total × protocol_fee_rate)` (`protocol_fee_rate_shop`=2% / `_secondhand`=1%). The protocol must **not** profit from a fault — it only recovers the operating fee it would normally have collected. **`fund_base` (1%) is EXCLUDED**: it is a community-fund contribution seeded from *real GMV*; a fault has no sale → no GMV → that contribution simply doesn't exist (recouping it would let the community fund profit from a penalty with no underlying sale). Verified against `settleOrder`: protocol_fee → ops/mgmt; fund_base → global_fund (separate subject).
2. `R = F − protocolTake`.
3. **Buyer** = `R × 50%` **baseline**, AND absorbs the promoter-half residual (step 5) — the harmed counterparty's compensation. So the buyer gets **≥ 50% of R** and can exceed 50%.
4. **Promoters** = up to `R × 50%`, distributed across l1/l2/l3 **by their original commission proportions**, **capped at their original total commission** (`originalCommissionTotal`). They never receive more than the commission they actually lost.
5. **Promoter-half residual → the buyer** (decision A, 2026-06-07): any part of the `R × 50%` promoter half not earned by a real promoter — whether **overflow** (`R × 50% > originalCommissionTotal`) or **no promoters at all** (`originalCommissionTotal = 0`) — goes to the **harmed buyer**, not to `commission_reserve`. Rationale: this residual is the **at-fault seller's penalty on an order that never completed** — it is *not* the un-earned sales-margin commission of a normal *completed* sale (which still routes to `commission_reserve`). A wrongdoer's penalty most fairly compensates the party it harmed; the buyer's principal was already fully refunded via escrow, so handing them the leftover penalty is deterrence flowing to the victim — never minting. Aligns with Invariant #2 ("buyer absorbs the residual") and the public economic disclosure.

Conservation check: `protocolTake + buyer(0.5R + residual) + promotersActual = protocolTake + R = F` always (since `residual = 0.5R − promotersActual`). Protocol ≤ its fee, promoters ≤ their original commission, the buyer absorbs the remainder; nothing is minted, and nothing lands in a pool the transacting parties can't see.
- the per-order fee/commission figures come from the order snapshot (`snapshot_commission_rate`, `l1/l2/l3_uid`, protocol-fee param) captured at order time — transparent and reconstructible.
- existing reputation violation + agent-strike machinery applies (unchanged).

### 4. Invariants (locked) / 不变量
1. **无责零成本**: `declined_nofault` forfeits nothing from the seller; buyer made whole.
2. **责任自负 + 守恒**: only the at-fault seller's stake is touched; distributed amounts exactly equal the deducted amount (no minting). **Neither the protocol nor promoters profit from a fault** — protocol ≤ its normal fee, promoters ≤ their original commission. The **harmed buyer is the residual absorber**: it receives `R × 50%` plus whatever the promoter half doesn't earn, so it can exceed 50% — this is the wrongdoer's penalty flowing to the victim (whose principal was already fully refunded), not a windfall siphoned from the commons.
3. **Arbitration = human**: any provisional→no-fault reversal is decided by a real-person arbitrator (iron-rule §4); agents/AI cannot.
4. **Transparent**: classification of the auto-verified cases is deterministic and inspectable; the decline reason + outcome are recorded on the order event log.

---

## Staged delivery / 分阶段

Each a single-topic PR, human-reviewed/merged; schema ALTER-after-CREATE; `schema:verify` gates.

1. **This RFC** (design + decisions + invariants).
2. **State + action** *(implemented — the `decline` action)*: seller `decline` action on a `paid` order with a validated `reason_code` (`stock_consumed_concurrent` / `stale_price_snapshot` / `force_majeure` / `price_regret` / `cherry_pick` / `other`), recorded on `orders.decline_reason_code` + `declined_at` + the order event/history. `paid→fault_seller` now also allows the `seller` role (explicit decline vs silent timeout); the decline settles via the existing fault path (full buyer refund + RFC-007/008 forfeit). Surfaces: PWA `POST /api/orders/:id/action action=decline` + MCP `webaz_update_order action=decline`. Tests: `tests/test-decline-action.ts` (seller-can / buyer-cannot / reason logged / conservation). **The `declined_nofault` state itself is moved to stage 3** — it is only reachable through auto-verify, so adding it now would be an unreachable (decorative) state; stage 3 introduces it together with its classifier + no-fault settlement.
3. **Provisional hold for objective claims** *(implemented — reframed from "auto-verify")*. **Design finding:** the protocol already structurally prevents *both* on-protocol objective scenarios at order creation — stock decrements atomically with a `stock >= qty` guard (no internal oversell) and `expected_price` mismatch returns `409 PRICE_CHANGED` (a stale-price order can't be placed). So the real objective cases (an *external* channel sold the unit; force majeure destroyed it) are **off-chain facts with no deterministic on-protocol signal** — auto-verify would be decorative (always fault). Instead: an **objective-claimed** decline (`stock_consumed_concurrent` / `stale_price_snapshot` / `force_majeure`) becomes a **provisional fault** — transitions to `fault_seller` but is **NOT settled**; sets `decline_objective_pending=1` + a `decline_contest_deadline` (`decline_contest_window_hours`, default 24). The seller must open arbitration (stage 5) to be cleared; `checkTimeouts` **finalizes** an uncontested provisional past its deadline into a normal fault settlement. **Subjective** declines settle as fault immediately (stage 2 behaviour). Tests: `tests/test-decline-action.ts` (provisional not-settled / deadline-finalize conserves / in-window not finalized). The `declined_nofault` state + no-fault settlement land in **stage 5**, where the arbitrator overturn actually reaches them (building them earlier = an unreachable state).
4. **Forfeit redistribution** *(implemented)*: the conservation-checked split (protocol recoups ≤ original fee, `fund_base` excluded → R: buyer 50% + promoters l1/l2/l3 by original proportion **capped at original commission** → promoter-half residual / no-promoter → **the harmed buyer** (decision A, 2026-06-07; NOT `commission_reserve` — see §3 step 5 + Invariant #2)) replaces the old buyer-50/protocol-50 inside `settleFault`'s `forfeitBackedStake` (applies to both `fault_seller` and self-fulfill `fault_logistics`). Real-code conservation test: `tests/test-fault-forfeit-conservation.ts` (no-mint / cap / no-promoter / bootstrap-0 / secondhand / idempotent). `F` remains stage-1's stake-backed amount until RFC-008 stage 2 decouples it.
5. **Arbitration overturn** *(implemented)*: `declined_nofault` state + `settleDeclinedNoFault` (full buyer refund + seller stake fully returned + stock/secondhand restored + neutral zero-point `no_fault_decline` reputation event; no forfeit/commission/fund — conservation, no mint). Seller `contest_decline` action on a provisional fault sets `decline_contested=1` (checkTimeouts pauses auto-finalize). Since #279-#281 this is **unified into the disputes arbitration desk** (`dispute_type='decline_contest'`): `contest_decline` creates a `decline_contest` dispute row (not just order flags), surfaced in the same `#disputes` queue. A **real human arbitrator** (`isEligibleArbitrator` + WebAuthn `requireHumanPresence`, iron-rule §4) rules via `POST /api/disputes/:id/arbitrate` with `ruling ∈ {decline_no_fault_upheld, decline_fault_confirmed}` (admin fallback after the arbitrate window: `POST /api/admin/disputes/:id/decline-contest-resolve`); both go through the single `resolveDeclineContestDispute` domain resolver (dispute CAS + COI + assignment + terminal `completed` + settle + audit, one transaction, fail-all-rollback). **uphold** → `fault_seller→declined_nofault` + `settleDeclinedNoFault` (无责零成本) → `completed`; **reject/timeout** → `settleFault` → `completed`. The old order-level `POST /api/admin/decline-contests/:orderId/resolve` (+ its GET list) was **removed** in PR4. Transitions `fault_seller→declined_nofault` (arbitrator/system) + `declined_nofault→completed` (system). Tests: `tests/test-decline-action.ts` (overturn conserves + stake returned + neutral mark / contested not auto-finalized / idempotent). Agents/AI cannot rule (CHARTER §4 + RFC-005).

## Open questions / 待议
- ~~Which fee components count as "original protocol fee"~~ **Resolved**: `protocol_fee` (2%/1%) only; `fund_base` (1%) excluded (GMV-based community contribution, not owed on a non-sale). Verified against `settleOrder`.
- ~~Whether `declined_nofault` carries a reputation signal~~ **Resolved**: yes — a **neutral, zero-fund `no_fault_decline` mark** (visibility/rate-observability, not a violation).

> All design decisions are now locked; ready for staged implementation.
- Whether the stale-snapshot hash comparison needs a new content/price-history index (implementation will confirm; if a check isn't cheaply verifiable it simply falls through to the arbitration path — graceful degradation, never a wrong auto-penalty).
