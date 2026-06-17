# RFC-012: External Risk Underwriter — collateralized order cover as a value-participant role / 外部风险承保方(抵押式订单兜底)

**Status**: draft (**DESIGN ONLY — implementation gated on real demand**, per the enters-core test) — 2026-06-07
**Author**: @seasonkoh + agent
**Track**: normal-but-sensitive — adds an external **value-participant** role to RFC-011 §⑧. Touches fund flows + collateral (RFC-008) + accountability (iron-rule) + a **regulatory surface** (the word "insurance" is regulated — see §Compliance). Does NOT change merge authority, and **must not** break fund conservation (settleFault/settleOrder never mint).
**Related**: RFC-011 §⑧ (economic participation; insurer marked `scaffolded`) · `src/pwa/economic-participation.ts` · RFC-008 (merchant collateral / fault_penalty_rate / stake_backing) · RFC-010 (fee-cap constitutional) · `order_insurance_rate` + `insurance_premium` (buyer opt-in premium) · `insurance_cap` (dispute-engine party-liability backstop) · `engine.settleFault` (conservation) · `commission_reserve` / `global_fund` (protocol pools) · META-RULES-FULL.md (#3 data, iron-rule) · the fairness principle

---

## Summary / 摘要

Today WebAZ is the **implicit self-underwriter** of order risk: a buyer can opt into a premium (`order_insurance_rate`, default 1%) that accrues to the protocol, and a liable party can cap exposure (`insurance_cap`) with the **protocol fund covering the excess** ("协议垫付"). There is **no external underwriter market** — the role exists only as a `scaffolded` entry in the §⑧ economic-participation index.

This RFC specifies how an **external party becomes a collateralized risk underwriter** — a value-participant who posts collateral, prices/accepts order risk, earns premium, and **pays claims out of premium + its own collateral** (never minted). It is the one genuinely-new piece of RFC-011 §⑧.

It is deliberately **design-only**: per the enters-core test (≥N independent integrators × cross-party trust × not reconstructable from exposed data), we do **not** build the interface until a real underwriter appears. Building it now would be a decorative interface nobody uses.

WebAZ 今天是订单风险的【隐式自保人】(买家可选保费进协议、`insurance_cap` 超额由协议金库垫付)。本 RFC 规定【外部方如何成为抵押式承保方】:押抵押、定价/承接风险、收保费、用【保费 + 自身抵押】赔付(绝不增发)。**设计先行、实现门控**——无真实承保方就不造接口。

---

## Motivation / 动机

- **Why open it up:** a single protocol-funded pool concentrates tail risk and caps the cover it can offer. Independent underwriters (specialists per category/route/region) price risk better and absorb shocks the protocol pool should not.
- **Why it belongs to the protocol (enters-core):** an underwriter needs **cross-party trust** (the buyer/seller must trust the payout will happen) + **verifiable, conserved settlement** + **accountability** — exactly the three things the protocol provides and a bespoke integration cannot reconstruct from exposed data. So the *contract* is core; the underwriter's pricing/ops are the integrator's own glue (agent-native).
- **Why not now:** 0 real underwriters today. Per enters-core, the interface stays unbuilt until demand is real; this RFC is the spec that makes building it a small, well-bounded step when that happens.

---

## Current state (honest baseline) / 现状

| Mechanism | What it does today | Where |
|---|---|---|
| `order_insurance_rate` (1%) | buyer opt-in premium, added to total, stored `insurance_premium`; accrues to protocol | `routes/orders-create.ts` |
| `insurance_cap` | a liable party (e.g. logistics) caps its payout; **protocol fund covers the excess** | `L3-1-dispute-engine` |
| `settleFault` conservation | any forfeit is redistributed (protocol ≤ fee / promoters ≤ original commission / harmed buyer gets ≥50% of the post-fee remainder and absorbs the residual → can exceed 50%), **never minted** | `L0-2 engine` |
| RFC-008 collateral | `stake_backing` per order, `fault_penalty_rate` (30%), `require_seller_stake` gate | RFC-008 |

**Gap:** all of the above is **protocol-internal self-insurance**. No external party can post collateral and underwrite. The §⑧ index lists `insurer` as `scaffolded` with `why_not_live` pointing here.

---

## Design / 设计

### Role: external risk underwriter (a value-participant)

An underwriter is the highest liability tier (RFC-011 liability_tiers `value_participant`): in the accountability net via `api_key → passport`, **collateral-bound**, conserved.

### Lifecycle

```
onboard (post collateral)
  → offer cover (price + scope: category/route/region, max per-order, book cap)
    → buyer/seller binds a policy on an order (premium → escrow)
      → order completes  → premium released to underwriter (minus protocol fee)
      → covered loss     → claim → adjudication → payout from {premium escrow, then underwriter collateral}
        → underwriter collateral insufficient → underwriter fault (collateral seized + strikes + book frozen); protocol fund is the LAST resort backstop, not the first
```

### Collateral model (bound to RFC-008)

- Underwriter posts **collateral** that backs its open book. **Book exposure cap = f(collateral)** — total outstanding cover ≤ a multiple of posted collateral (multiple is a governance param, starts conservative, e.g. 1×).
- A claim pays from the **bound premium escrow first, then the underwriter's collateral**. The underwriter can never owe more than its collateral on a given policy (the policy's `max_payout` is set at bind time and collateral is reserved against it — no naked underwriting).
- Failure to pay a valid claim = **underwriter fault**: collateral seized to satisfy the claim, strikes issued, book frozen (no new offers). Same fault/forfeit discipline as RFC-008 sellers.

### Conservation invariant (hard)

Payouts come from **premiums + the underwriter's own collateral**. The protocol **never mints** to pay a claim. The protocol fund remains only the *bounded last-resort backstop* it is today (via `insurance_cap`-style caps), explicitly capped and governance-controlled — opening external underwriters should **reduce** protocol-fund exposure, not increase it.

### Accountability & iron-rule

- Onboarding, large payouts, and collateral withdrawal require a **live WebAuthn ceremony** (iron-rule) — an underwriter moves real value, so it must be an accountable real human / custodian, not a bare agent.
- Misconduct (refusing valid claims, over-booking beyond collateral, mispricing to churn) → strikes → 3-strike block, per the §② negative-space consequence ladder.

### Verifiability & claim adjudication

- A bound **policy** is a signed artifact (reuse the AP2-style signed-mandate / dual-output pattern → joins the §⑤ verifiability index as a new artifact with an honest level).
- Claims are adjudicated through the **existing dispute/arbitration** machinery (L3) — no parallel court. The arbitrator's ruling drives the payout. This reuses iron-rule human arbitration; no new trust root.

### Fairness (3 principles) alignment

- **Public & transparent:** policy terms, premium, max_payout, and the underwriter's collateral-backing ratio are disclosed before bind.
- **Liability follows the responsible party:** the underwriter that accepted the premium bears the claim, up to its collateral.
- **Zero cost to the faultless:** a buyer/seller who bound a valid policy is made whole from premium+collateral regardless of the underwriter's solvency games (collateral was reserved at bind).

---

## Compliance / 合规(关键,launch 前法律复核)

⚠️ **"Insurance" is a regulated term in most jurisdictions.** This design is **collateralized peer risk-cover / a guarantee pool**, NOT licensed insurance, and must be **named and disclosed** accordingly. Before any implementation:
- Legal review of whether collateralized cover triggers insurance/financial-services licensing (per-jurisdiction) is pending. Only the public mechanism (params / consensus / arbitration) is specified here, not operational strategy.
- Public-facing copy avoids the bare word "insurance"; prefer "risk cover" / "guarantee" / "collateralized cover" with a pre-launch disclaimer (consistent with the existing `network_state` pre-launch banner).
- This RFC does **not** authorize launch of the feature; it specifies the mechanism so the compliance + build work is a bounded, reviewable step.

---

## What changes vs today / 与现状的差异

- `order_insurance_rate` + the protocol self-cover **stay** as the default fallback (so nothing regresses if no underwriter exists). External offers **layer on top** — a buyer/seller may choose a protocol-default cover or an external underwriter's policy.
- New: underwriter onboarding + collateral accounting + policy bind/escrow + claim→payout-from-collateral. All gated.

## Non-goals / 非目标

- Not licensed insurance; not a regulated product (see §Compliance).
- No naked/uncollateralized underwriting — every policy's max_payout is collateral-reserved at bind.
- No new arbitration court — claims reuse L3 dispute/arbitration.
- No protocol minting to cover claims, ever.

---

## Implementation phases (all gated on the trigger below) / 实施分期(全部门控)

1. **P1 — collateral + onboarding:** underwriter role + collateral post/withdraw (iron-rule) + book-exposure cap param.
2. **P2 — policy bind + premium escrow:** signed policy artifact (§⑤) + premium escrow + release-on-complete.
3. **P3 — claim → payout:** claim via L3 arbitration → payout from premium-then-collateral → underwriter-fault path (seize/freeze/strike).
4. **P4 — flip §⑧ `insurer` scaffolded → live** + add the policy artifact to the §⑤ verifiability index.

## Trigger to un-gate / 解除门控的触发条件

Build P1 when **either**: (a) ≥1 credible external party formally wants to underwrite on WebAZ, **or** (b) protocol-fund cover exposure crosses a governance-set threshold (self-insurance no longer prudent). Until then this RFC stays `draft`, and the §⑧ index keeps `insurer: scaffolded` pointing here.

---

## Open questions / 待决

- Collateral-to-book multiple: start 1× (fully collateralized) and let governance raise it with track record, or keep 1× permanently for safety?
- Premium pricing: free (underwriter sets) vs protocol min/max band (consistent with fee-cap §RFC-010 philosophy)?
- Multi-underwriter on one order (syndication) — defer to a later RFC; P1–P4 assume single underwriter per policy.
- Does the protocol-fund last-resort backstop survive at all once external cover exists, or is it sunset on a schedule?
