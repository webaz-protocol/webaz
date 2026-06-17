# RFC-013: Arbitrator compensation without compromising independence / 仲裁报酬与司法独立性解耦

**Status**: draft (**DESIGN ONLY — implementation gated**: pre-launch, 0 real arbitrators; build on a real signal) — 2026-06-07
**Author**: @seasonkoh + agent
**Track**: normal-but-sensitive — changes the **judicial money-flow** (who funds the arbitrator) + reputation→assignment. Touches conservation, the faultless-zero-cost principle, the human-only iron-rule, and de-MLM. Does NOT change merge authority.
**Related**: RFC-007 (non-acceptance fault) · RFC-008 (collateral / fault penalty) · RFC-011 §⑧ (economic participation — arbitrator role) · `src/layer3-trust/L3-1-dispute-engine/dispute-engine.ts` (current fee) · governance-onboarding (arbitrator_min_reputation) · #1080 (leaderboard "最活跃 ≠ 最好") · the fairness principle · human-only-ops · reputation as a modifier (not an income source)

---

## Summary / 摘要

Today an arbitrator is paid **50% of a 1% fee deducted from the dispute loser**. That couples the arbitrator's income to the *direction* of their own ruling, which creates two latent biases: **rule against whoever can pay** (the fee is capped at the loser's balance → favor finding the solvent party at fault), and **always produce a billable loser** (avoid no-fault/dismissed). Scaling this with "more reputation → more cases → more income" would amplify both and re-introduce the volume-driven incentive #1080 deliberately rejected.

This RFC keeps arbitrators **fairly compensated** but makes pay **independent of the ruling**: a neutral source funds the arbitrator (same pay whichever way they rule, including dismissed); the **loser still ultimately bears the cost** (reimburses the pool), so the faultless party pays nothing — but the arbitrator never "bills the loser directly." Reputation governs **eligibility + capped assignment priority**, not income.

今天仲裁员拿"从输家扣的 1% 费的 50%",报酬与自己裁决方向挂钩 → 潜伏两种偏差:**判给付得起的一方**、**总得制造一个输家**。本 RFC 让报酬**与裁决方向无关**(中立池付、无论怎么判都一样),**责任方仍最终承担成本**(补偿池),无责方零成本不变;信誉只管准入+派单优先级、不当收入乘数。

---

## Current state / 现状 (`dispute-engine.ts`)

- `fee = max(1, orderAmount × 1%)` — **hardcoded 1%**, not a governance param, not arbitrator-set.
- Deducted from the **loser** (`staked` → `balance`); `actualFee = min(fee, loser's available)` → **if the loser can't pay, the arbitrator gets 0**.
- Split: human arbitrator **50%**, protocol 50%; auto-ruling (system) → 100% protocol.
- Reputation (`arbitrator_min_reputation` = 300 in code) is an **eligibility gate**, not an assignment weight. `recordDisputeReputation` tracks win/loss outcome; appeals can overturn.
- Ruling types: `refund_buyer` / `release_seller` / `partial_refund` / `liability_split`.

**The flaw is structural, not a bug:** pay is a function of *who loses* and *whether they're solvent*. Low-stakes today (no real arbitrators), but it must be fixed before this role carries real money.

---

## Design / 设计

### 1. Decouple pay from ruling direction (the core fix)

```
dispute opens
  → a dispute-handling fee is ESCROWED from both parties (or drawn from a protocol dispute pool)   ← neutral source
  → arbitrator rules (buyer / seller / split / dismissed)
  → arbitrator is paid a FLAT amount from the escrow/pool — SAME regardless of the ruling           ← independence
  → at settlement, the LOSER reimburses the pool for the fee (the faultless party's escrow is refunded)
        → faultless party: net zero (零成本)   · loser: bears the cost   · arbitrator: pay ⊥ ruling
  → dismissed / no-fault: arbitrator still paid (from pool); cost shared per a no-fault rule (e.g. split, or protocol absorbs a small dismissed-case cost) — never "0 because nobody lost"
```

Invariant: **the arbitrator's payment must not be a function of which party loses or whether they are solvent.** Solvency risk moves to the pool (with the protocol as the bounded backstop it already is), not to the arbitrator's incentive.

### 2. Reputation = eligibility + capped priority, NOT an income multiplier

- Reputation is **accuracy-based** (overturned-on-appeal lowers it), not volume-based — consistent with #1080 ("最活跃 ≠ 最好") and the position-as-modifier principle (a *modifier*, not a source of entitlement).
- May raise **assignment priority modestly**, bounded by: a **per-period case cap** (no case hoarding), **rotation** (spread cases), and **conflict-of-interest exclusion** (never arbitrate a party you have ties to).
- "More reputation → more cases" is allowed; "more cases → more reputation → more cases" (the flywheel) is **broken** by making reputation track accuracy, not throughput.

### 3. Fee = governance param, never arbitrator-set

- Extract the hardcoded 1% to a `protocol_param` (e.g. `arbitration_fee_rate`), optionally bucketed by dispute amount. Arbitrators **cannot price themselves** (avoids collusion / a fee cartel). Consistent with the fee-cap philosophy (RFC-010).

### 4. Unchanged guards

- **Iron-rule:** arbitration stays a live-WebAuthn human act.
- **Appeal:** overturn → reputation down + **fee clawback** from the arbitrator (so being wrong has a cost symmetric to being paid).

---

## Invariants (locked) / 不变量

1. **Judicial independence:** arbitrator pay ⊥ ruling direction ⊥ loser solvency.
2. **Faultless zero cost:** the party not at fault pays nothing net.
3. **Liability follows fault:** the loser ultimately bears the fee (reimburses the pool).
4. **Conservation:** fees move between escrow/pool/parties/arbitrator; the protocol never mints. The protocol pool is a bounded backstop, not a first payer.
5. **Human-only:** live WebAuthn per ruling.
6. **De-MLM:** income is fair compensation for correct work, never a function of volume or position; reputation is a modifier, not an entitlement.

---

## What changes vs today / 与现状差异

- Money-flow: "loser → arbitrator (50%)" becomes "pool → arbitrator (flat); loser → pool (reimburse)". The loser's net cost is similar; the arbitrator's **incentive** is fixed.
- 1% becomes a governance param.
- Reputation gains a (capped, accuracy-gated) assignment-priority role it doesn't have today.

## Non-goals / 非目标

- Not arbitrator-set fees; not fee bidding.
- Not volume-ranked reputation or leaderboards (keeps #1080).
- No protocol minting to pay arbitrators.
- No change to who *may* be an arbitrator (eligibility gate unchanged); this is about *how they're paid + assigned*.

---

## Implementation phases (gated on a real signal) / 实施分期(门控)

1. **P1 — param + independence:** extract `arbitration_fee_rate`; change pay source to pool/escrow with a flat arbitrator payment ⊥ ruling; loser reimburses pool.
2. **P2 — dismissed/no-fault funding rule:** define who bears a dismissed-case cost (split / protocol-absorb) so "dismissed" is never financially punished for the arbitrator.
3. **P3 — reputation→assignment:** accuracy-gated priority + per-period cap + rotation + conflict exclusion.
4. **P4 — appeal clawback:** overturn → reputation down + fee clawback.

## Trigger to un-gate / 解除门控

Build when there is a **real arbitrator economy** (≥N active human arbitrators handling real-money disputes) — pre-launch with fixture arbitrators, the current model is harmless. Until then this stays `draft` and the §⑧ economic index keeps describing the arbitrator as "compensated, not fee-maximizing," pointing here.

## Open questions / 待议

- Dismissed-case cost: split between parties, or protocol-absorbed (encourages honest "dismissed" rulings but a tiny protocol cost)? Lean: small protocol-absorbed cost, capped.
- Flat arbitrator pay vs amount-scaled (bigger disputes = more work)? A bounded scale (by amount bucket) is fine **as long as it's independent of the ruling**.
- Should reputation-priority exist at all pre-scale, or start pure-rotation and add priority only once accuracy data is meaningful?
