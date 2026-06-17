# RFC-010: Fee Cap as Constitutional Invariant — CHARTER §4 I-7 / 费帽入宪 — CHARTER §4 I-7

**Status**: draft (proposal — awaiting ratification via CHARTER §6 / §4 I-4) — 2026-06-06
**Author**: @seasonkoh
**Track**: meta-rule (constitutional level — adds a CHARTER §4 Invariant)
**Related**: [RFC-008](RFC-008-merchant-cost-collateral.md) (fees — capped, ratchet-down-only) · [`CHARTER §4`](../CHARTER.md) (I-1..I-6 invariants) · [`CHARTER §4 I-3`](../CHARTER.md) (anti-MLM red line — closest precedent) · [`CHARTER §4 I-4`](../CHARTER.md) (amendment protection + "only-increase" ratchet precedent) · ECONOMIC-MODEL · open-protocol moat · param-driven-fee debt

---

## Summary / 摘要

Enshrine WebAZ's protocol-take ceilings as a **constitutional invariant** (new CHARTER §4 **I-7**): **platform fee ≤ 2%**, **community-fund base ≤ 1%**, **combined protocol take ≤ 3%** of GMV — **ratchet-down-only** (the cap can be *lowered* by governance, never *raised*; raising it is a constitutional violation). RFC-008 already enforces these at the param level (`max_value` 0.02 / 0.01, shipped PR #112); this RFC moves the **ceiling itself** from governance-mutable param config to a CHARTER invariant, so "we don't rent-extract" is **structurally guaranteed, not merely promised**.

把 WebAZ 的**协议抽成上限**入宪(新增 CHARTER §4 **I-7**):**平台费 ≤ 2%**、**社区基金基础费 ≤ 1%**、**协议总抽成 ≤ 3%**(占 GMV)—— **只减不增**(治理可下调,永不可上调;上调 = 违宪)。RFC-008 已在参数层强制(`max_value` 0.02 / 0.01,PR #112 上线);本 RFC 把**上限本身**从"治理可改的参数配置"提升为 CHARTER 不变条款,让"我们不抽租"**由结构保证,而非仅靠承诺**。

---

## Motivation / 动机

WebAZ is **infrastructure, not a marketplace** — escrow / state-machine / dispute / identity, priced like infra (low), not a 15% marketplace rake (RFC-008 benchmarks). The strategic moat is the **network, not the code**: an open / forkable protocol *cannot* rent-extract — a fee whose *direction is up* breaks the no-rent property and invites forks.

A param-level cap (`max_value`) is enforced by code today, but a `max_value` is itself **governance-mutable** — a future governance action could raise it. That makes "no rent" a *promise backed by current config*, not a *credible structural commitment*. Hardcoding the ceiling as a CHARTER invariant (changeable only by the high-threshold amendment process, and only **downward**) makes the commitment **credible**: a participant or fork-evaluator can verify the protocol *cannot* turn into a rent-extractor without a visible 60-day constitutional amendment that the community would reject (raising = violating the invariant).

This mirrors the existing **I-2 License Evolution Lock** (Change Date can only move *earlier*, never later) and **I-4's ratchet** (`constitutional_supermajority_ratio` only-increase) — same pattern, applied to fees.

---

## Scope — what is capped, what is NOT / 范围 — 帽什么、不帽什么

**Capped (the protocol's own take):**
- `protocol_fee_rate_shop` ≤ **2%**, `protocol_fee_rate_secondhand` ≤ **2%** (current preset 2% / 1%).
- `fund_base_rate` ≤ **1%** (community-fund contribution).
- Combined platform + fund take ≤ **3%** of GMV.

**NOT capped by I-7 (deliberately):**
- The **commission → promoter layer** (`default_commission_rate`, l1/l2/l3 distribution). This is value flowing to *participants who drove the sale*, **not protocol rent** — capping it would wrongly constrain the community-incentive layer. (Its own constraints live in I-3 anti-MLM + the per-jurisdiction `max_levels` compliance, not here.)
- **Temporary downward waivers**: governance may waive *below* the cap (e.g. `fund_base_rate = 0` pre-launch). I-7 caps the *ceiling*; waiving below it is always allowed and is the launch-waiver mechanism (disclosed standard + temporary promo, **never** a stealth increase — see RFC-008 §A).

> The invariant guards the **ceiling and its direction**, not the operating value. Governance keeps full freedom to set/lower the live rate; it loses only the ability to raise the ceiling.

---

## Proposed CHARTER text / 拟新增宪章条文

> Insert as **CHARTER §4 I-7**, after I-6. (This RFC does **not** edit CHARTER's binding text; on ratification the maintainer adds this section per §6.)

```
### I-7 协议抽成费帽(只减不增)/ Protocol-Take Fee Cap (ratchet-down-only)

协议对每笔 GMV 的总抽成存在【宪法级硬上限】,只能由治理【下调】,永不可上调:
The protocol's total take per unit of GMV has a constitutional hard ceiling,
which governance may only LOWER, never raise:

- 平台费 / Platform fee（protocol_fee_rate_shop / _secondhand）≤ 2%
- 社区基金基础费 / Community-fund base（fund_base_rate）≤ 1%
- 平台费 + 基金费 合计 / Combined platform + fund take ≤ 3% of GMV

**不帽 / NOT capped**:分享佣金层（commission → 推广人;价值流向真实促成交易的参与者,
非协议租金;其约束见 I-3 反 MLM + 辖区 max_levels)。临时【下调减免】始终允许
(费帽守的是上限与方向,不锁运营值)。
The commission→promoter layer is NOT protocol rent and is not capped here
(its constraints live in I-3 + per-jurisdiction max_levels). Temporary downward
waivers are always allowed (the cap guards the ceiling + direction, not the live value).

**禁止"先低后高" / No bait-and-switch**:标准费率须事前公开;只允许透明的临时减免,
不得以"减免到期"形式实质涨价超过本帽。
The standard rate must be disclosed upfront; only transparent temporary waivers
are allowed — no stealth increase beyond this cap via "waiver expiry".

**修改 / Amendment**:本帽数值【上调】或删除 = 违反本 Invariant,须走 §6 + I-4 完整修宪流程
(phase A: user 单签 + 60 天公示;phase B+: ≥2/3 多签 + 60 天)。【下调】走普通宪法参数流程。
Raising or removing this cap = violating this Invariant; requires the full §6 + I-4
amendment process. Lowering follows the normal constitutional-param process.
```

---

## Enforcement / 强制(I-6 加密学保证延伸)

1. **Param `max_value` (live, shipped).** `protocol_fee_rate_*` `max_value = 0.02`, `fund_base_rate` `max_value = 0.01` — the admin param API rejects any `value > max_value` (PR #112). This enforces the *operating* values stay under the cap.
2. **Baseline check (to add at ratification).** A CI check asserting these `max_value`s **never increase** across commits (mirror of I-4's `only-increase` hook, inverted to `only-decrease` for the fee ceiling) — so the *ceiling* can't be quietly raised in config either. Listed under §4 I-6's invariant-guarantee table alongside I-1..I-5.
3. **Combined-take guard.** A startup/CI assertion that `protocol_fee_rate_shop + fund_base_rate ≤ 0.03` (and the secondhand equivalent), so the 3% combined ceiling holds even if the per-component maxima were individually touched.

(Pre-launch, only the param `max_value` enforcement is live; the CI baseline + combined-take guard land with ratification, mirroring how I-1/I-2/I-3 checkpoints were phased into CI in W4–W7.)

---

## Ratification / 批准流程

Per CHARTER §6 + §4 I-4 (constitutional amendment):
- **Phase A (now):** user 1-of-1 single-sign + **60-day constitutional public notice** (§4 I-4 — constitutional clauses are 60d, not the 14d for normal constitutional params).
- This RFC is the **proposal artifact**; ratification is the user's governance action (it is *not* enacted by merging this RFC). On ratification: add CHARTER §4 I-7, add the I-6 enforcement rows, flip this RFC to `ratified`.

> Drafted now so the artifact is ready; **ratification timing is the user's call** (reasonable to bundle with the W8 launch constitutional lock, when the fee posture goes public).

## Open questions / 待议
- Bundle ratification with the W7 meta-rule v1.0 lock / W8 launch, or ratify standalone now? (lean: bundle — fewer constitutional events, and the cap goes public exactly when fees do.)
- Whether to also constitutionalize the **disclosed-standard-rate** values (2% / 1%) vs only the ceilings (lean: ceilings only — the *standard* operating rate stays governable below the cap; only the ceiling+direction are constitutional).
