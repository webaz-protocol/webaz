# RFC-008: Merchant cost & collateral model — fees, stake, fault penalty / 商家成本与抵押模型:费率、押金、违约罚没

**Status**: draft — 2026-06-06
**Author**: @seasonkoh
**Track**: protocol economics + funds + state-machine settlement. Touches a proposed **constitutional fee cap** (→ CHARTER amendment) and **amends RFC-007** (forfeit `F`). RFC + public comment.
**Related**: RFC-007 (non-acceptance fault) · `settleOrder` / `settleFault` · `getStakeDiscount` (L4-3 reputation) · open-protocol moat (open protocol = no rent) · the fairness principle · param-driven-fee debt (decorative params) · ECONOMIC-MODEL

---

## Why / 动机

Three coupled questions surfaced while reviewing the order economics:
1. **Are the fees right?** protocol_fee 2% + fund_base 1% — reasonable vs the market? And does "phasing" risk a 先低后高 (bait-and-switch) backlash on an *open* protocol?
2. **Is the 15% stake too heavy?** It's the real working-capital burden on honest sellers.
3. **Should the fault penalty equal the stake?** Today forfeit = the order's stake; deterrence and collateral-friction are bolted together.

A code audit also found the reputation-tiered stake is **decorative**: `getStakeDiscount` computes a rep-based rate with a **5% floor** (`max(0.05, 0.15 − discount)`), but it is only shown in MCP `list_product`; the **actual** lock (MCP place_order) and forfeit (`settleFault`) **hardcode 0.15** (`// TODO: protocol_params 化`), and `settleOrder` uses yet another notion (`product.stake_amount`). Three divergent stake figures + an advertised-but-unenforced discount = a 元规则 #4 (don't lie) + decorative-param problem, possibly with a missing lock on the PWA order path.

---

## Benchmarks (researched) / 市场基准

| Platform | Seller take (on GMV) | Type |
|---|---|---|
| Amazon | ~15% (8–45%) + $39.99/mo + FBA | marketplace rake |
| eBay | ~13.25% + $0.30 | marketplace |
| Etsy | ~10–11% all-in | marketplace |
| **Shopify** | **0% commission** + $39/mo + 2.9%+30¢ payment (≈card cost) | **infrastructure** |
| OpenSea (web3) | **0.5%→1.0%** + 5–10% creator royalty | web3 (phased) |
| **WebAZ** | protocol 2% + fund_base 1% = **3%** (+ 5% commission → promoters) | infrastructure |

Two facts shape the conclusion: (a) WebAZ is **infra, not a marketplace** — the protocol provides escrow/state-machine/dispute/identity; *demand* is unbundled into the commission→promoter layer (the network = the moat). So protocol_fee should be priced like infra (low), not a 15% rake. (b) **USDC settlement ≈ zero payment cost** (on-chain gas <$0.01 vs card 2.9%), so WebAZ's 2% is *pure protocol margin*, not payment passthrough — it can sit low and stay sustainable. **3% all-in is already low/competitive.**

---

## Decisions / 决策

### A. Fees — low, capped, no bait-and-switch
- **No 先低后高.** On an open/forkable protocol you cannot rent-extract — a fee whose *direction is up* breaks the no-rent moat and invites forks, regardless of the absolute number. So we do **not** "start low then raise."
- **Standard rate disclosed upfront + a clearly-temporary launch waiver** (waived until a date / GMV milestone). Same early cash flow (≈0) as a ramp, but it is a disclosed promo, not a stealth increase → no betrayal when it ends.
- **Hard caps, ratchet-down only (locked).** Per-component caps enforced at the param `max_value`: **platform fee ≤ 2%** (`protocol_fee_rate_*` max 0.20→**0.02** = the current steady-state, so governance can only *waive down* 0–2%, never raise) and **fund_base ≤ 1%** (max→0.01) → **combined platform take ≤ 3%**. These are preset standards; early values may be waived below the caps per project need (disclosed-standard + temporary-waiver model, not 先低后高). Neither param is meta-rule-locked, so the param-level cap is enforced by migration now; **constitutional ratification of the 2%/1%/3% caps into CHARTER is a separate governance step** (legitimacy layer). *(implemented: PR #112)*
- **fund_base = 0 pre-launch.** It seeds the community PV pool from *real GMV*; with ~0 GMV it's a tax without return. Turn it on (≤1%) when the community-fund features deliver visible value.
- protocol_fee steady-state stays ~2% (governable under the cap).

### B. Stake (collateral) — per-order backing snapshot, bootstrap grace, then reputation-tiered
**Confirmed bug (investigation):** production orders **never lock seller stake at placement** (`orders-create.ts` writes no `staked`); stake is only locked at *first-success settlement* (`settleOrder`, per-product, non-trusted, `product.stake_amount`). Yet `settleFault` **assumes** it's locked and unconditionally does `staked -= 0.15×total` with no guard → on a pre-success or trusted-seller fault, `staked` goes **negative and money is minted** to buyer/protocol. Three divergent stake notions (0.15×total / product.stake_amount / MCP 0.15×price) compound it. Latent only because pre-launch (0 real users, sim WAZ).

**Fix = per-order backing snapshot (also the bootstrap mechanism).** At order creation, snapshot **`stake_backing`** = the seller stake actually allocated to *this* order (like commission/region/content_hash snapshots). Settlement reads this number — never an assumed one — so it can never deduct unbacked stake. This single field fixes the minting bug **and** enables the low-barrier bootstrap below.

- **Bootstrap grace (low entry barrier).** New merchants post **no upfront stake** (`stake_backing = 0`) — zero capital barrier to start. On fault for a `stake_backing = 0` order: **buyer gets a full refund** (escrow always returns → buyer loses nothing), **no forfeit / no compensation paid (nothing to forfeit → no minting)**, and the seller takes a **reputation hit / fault strike** (existing machinery). "Skin in the game" at bootstrap = reputation + buyer-always-made-whole, *not* capital. This is **not** a free-ride-with-payout: the buyer never loses money, the seller bears a real reputation consequence, and nothing is minted.
- **Buyer transparency**: the product/order surfaces its backing — "新商家·无赔付保障 / new merchant, no payout backing" vs "已质押保障 / stake-backed" — so a buyer chooses knowingly (escrow refund is guaranteed either way; only the *extra* fault compensation differs).
- **Tighten on the way up (起步低门槛,上轨道收紧).** A governance/reputation threshold (param) moves a merchant from bootstrap (0 stake) into the **stake-required** tier: `stake_backing = order_total × stake_rate(reputation)`, **reputation-tiered**, with a **floor > 0** (never 0 *once required*). Reads **trade** reputation (`reputation_scores` via `getStakeDiscount`), not build_reputation (RFC-006 invariant 1). Proposed curve (param-driven): required-new ≈ 10–15% → trusted floor ≈ 5%.
- All thresholds + rates + floor → `protocol_params` (no hardcoding; remove the 0.15 + TODO; unify the three notions to the single `stake_backing` snapshot).

### C. Fault penalty — DECOUPLED from stake
- A separate **`fault_penalty_rate`** (default **30%**), independent of `stake_rate`. Low stake (e.g. 10–15%, friction) + high penalty (30%, deterrence) — both goals met, which a single rate cannot do.
- **Collection** (stake-backed orders): `penalty = fault_penalty_rate × order_total`; realized = drawn from the seller's **`staked` pool first, then free `balance`** — `realized = min(penalty, stake_backing + balance)`. Never mints, never goes negative. The at-fault seller's own funds (incl. free balance) are reachable — **责任自负**; the penalty is genuinely enforceable, not architecturally capped at a thin per-order stake.
- **Bootstrap orders (`stake_backing = 0`) are 免赔付**: no forfeit, **no reach into the new merchant's free balance** (that would re-introduce the barrier we removed) — buyer full refund + seller reputation hit only. The balance-fallback above applies **only** to stake-required (established) orders.
- **Distribution** = exactly RFC-007's rule applied to this realized `F`: protocol recovers `min(F, protocol_fee)` (no profit, fund_base excluded) → remainder R: buyer 50%, promoters 50% (l1/l2/l3 by original proportions, capped at original commission) → promoter-half residual (overflow / no-promoter) → **the harmed buyer** (decision A, 2026-06-07; NOT `commission_reserve` — the residual is the at-fault seller's penalty on an order that never completed, so it compensates the harmed party, per RFC-007 §3 step 5 + Invariant #2 and the engine `settleFault`). Conservation holds.
- **Margin-maintenance gate**: a seller whose `staked + balance` cannot cover active-order exposure is flagged high-risk and **blocked from accepting new orders** until topped up (prevents piling fresh exposure on a depleted seller). Pre-launch this rarely bites; the rule is set now.

### Amends RFC-007 / 修正 RFC-007
RFC-007 defined the forfeit `F` as "the order's 15% stake". **Superseded**: `F` = the realized fault penalty (`fault_penalty_rate`=30%, decoupled from stake, drawn from staked pool + free balance, no mint). RFC-007's *distribution* of `F` is unchanged.

---

## Invariants (locked) / 不变量
1. **Stake floor > 0 — once stake is required** (established tier). At bootstrap, capital stake = 0 (low barrier); "skin in the game" is reputation + the buyer-always-refunded + no-minting guarantee, never a free-ride-with-payout.
2. **Fee cap ratchets only down** — never raised above the launch rate / CHARTER cap (open-protocol no-rent, made credible not just promised).
3. **No bait-and-switch** — standard rate disclosed upfront; only transparent, temporary waivers.
4. **Conservation + no mint** — distributed = realized collected; collected ≤ seller's total funds (staked + balance); never negative.
5. **Penalty ⟂ stake** — independent rates; the at-fault seller's funds (incl. free balance) bear the penalty (责任自负).
6. **Trade-rep only** for stake tiering — build_reputation never affects collateral (RFC-006 invariant 1).

## Staged delivery / 分阶段
1. **Stake unify + minting fix + bootstrap grace** (P0-class): add the per-order **`stake_backing`** snapshot; make `settleFault` settle against it (`min(penalty, stake_backing[+balance if backed])`, never negative, never mint) — this **confirms-and-fixes** the minting bug (verified: production never locks stake at placement, `settleFault` mints). Bootstrap merchants → `stake_backing = 0` → 免赔付 (full refund, reputation hit, no mint). Remove hardcoded 0.15 + TODO; unify the three notions. Conservation tests + a regression test asserting `staked` never goes negative.
2. **Decouple penalty** *(implemented, except margin gate)*: `fault_penalty_rate` param (default 30%, decoupled from stake_rate) drives `settleFault`'s penalty base; collection takes the staked pool first (capped at `stake_backing`) then the seller's free `balance` (capped at the real balance → never negative, never mint); bootstrap `stake_backing = 0` stays 免赔付 (no reach into the new merchant's balance); RFC-007 stage-4 distribution applies to the realized `F`. Tests extended in `tests/test-fault-forfeit-conservation.ts` (F1 balance-fallback, F2 bootstrap no-reach, F3 thin-balance cap). **Margin-maintenance gate deferred to stage 2b** (order-accept-path guard; pre-launch rarely bites).
3. **Fees**: fund_base→0 pre-launch; tighten param max; launch-waiver mechanism; **CHARTER amendment for the constitutional cap** (separate meta-rule process).

## Open questions / 待议
- **Bootstrap→stake-required threshold**: what moves a merchant out of 0-stake grace (e.g. N completed orders / reputation level / GMV)? param-driven; pick a default.
- Exact stake curve (required-new% → floor%) and `fault_penalty_rate` final number (30% locked as default; tier it by reputation too?).
- Constitutional cap value (≤5% proposed) — ratified via CHARTER amendment.
- Whether the margin-maintenance gate also retroactively flags existing thin-pool sellers or only gates *new* orders (lean: gate new only, pre-launch).
- Should there be a per-order cap on how many *open* bootstrap (0-stake) orders a brand-new merchant can have at once, to bound buyer-side inconvenience risk from a bad-faith new seller (the buyer never loses money, but their time)? Lean: a small concurrent-open cap for 0-stake merchants.
