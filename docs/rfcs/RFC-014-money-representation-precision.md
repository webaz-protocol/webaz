# RFC-014: Money representation & precision — float ledger → exact units before real settlement / 资金表示与精度

**Status**: in progress (**P2 arithmetic port DONE — zero dust across all fund paths, conservation exact; P3 storage `REAL→INTEGER` flip gated on pre-real-settlement**) — 2026-06-07
**Author**: @seasonkoh + agent
**Track**: normal-but-sensitive — touches the fund ledger representation (every balance/escrow/commission). Does NOT change merge authority; must preserve the conservation invariant.
**Related**: from the "are we reinventing wheels?" open-standards audit (2026-06-07) §3 red-line #2 · `engine.settleFault` (conservation) · `tests/test-money-precision-adversarial.ts` (the diagnostic) · RFC-008 (collateral) · RFC-012 (underwriter) · x402 / USDC on Base (future real settlement)

---

## Summary / 摘要

A read-only audit against open standards found one genuine "wheel rolled wrong": **money is represented as floating-point** — SQLite `REAL` columns (`balance` / `staked` / `escrowed` / `total_amount` / `unit_price` / …) computed in JS `number` with `Math.round(x*100)/100` (~24 sites in the fund paths), with **no decimal/integer-cents library**.

An adversarial diagnostic (`tests/test-money-precision-adversarial.ts`) running the **real** `settleFault` on indivisible amounts (33.33 @ 7%, 1234.56 @ 7.25%, …) quantified the actual impact:

- **Aggregate conservation holds EXACTLY (residual 0)** — `settleFault` uses residual-absorption (the last bucket = F − Σ others), so float **never mints or loses** money at the aggregate. The conservation invariant is safe. ✅
- **BUT individual wallets accumulate float dust** — 2 of 5 adversarial cases left a wallet at e.g. `staked = 3.3299999999999983` (should be 3.33), `balance = 1407.3999999999999` (should be 1407.40). 🟡

**Severity (honest):** not a minting/conservation bug. It is a **representation-dust** issue that is **cosmetic/comparison-risk today** (simulated WAZ, 0 real funds) and becomes a **real reconciliation crack when settling against integer on-chain USDC base-units** (x402 / Base). The other red line (Passkey) passed: `@simplewebauthn/server`, no hand-rolled crypto.

---

## Why now is the cheapest fix window / 为何现在最便宜

Pre-launch = **0 real users, 0 stored balances**. Changing the representation now is a code refactor. After real WAZ balances (or real USDC) exist, the same change needs a **data migration of live fund balances** — far riskier/costlier. So: decide the representation now, schedule the refactor before real settlement (x402).

This is NOT urgent on simulated currency (no live loss), so it is **gated**, not immediate — but it must land **before** any real-money path (x402/USDC) goes live.

---

## Options / 方案

### A. Integer minor-units (recommended) / 整数最小单位
Store and compute money as **integers in the smallest unit** (e.g. 1 WAZ = 1,000,000 base units, matching USDC's 6 decimals). All arithmetic is integer (exact); format to decimals only at display.
- **Pros:** exact (no float dust ever); **structurally identical to on-chain USDC base-units** → reconciliation is 1:1; no library needed (BigInt / integer math).
- **Cons:** largest change surface — schema `REAL → INTEGER`, every read/write, every calc site, display formatting layer; a one-time conversion of existing (test) data.

### B. decimal.js / dinero.js / decimal-string
Keep decimal semantics via a library; store as decimal strings or scaled integers under the hood.
- **Pros:** smaller mental shift (still "decimals"); handles arbitrary precision.
- **Cons:** still needs an integer/base-unit conversion layer when reconciling against on-chain USDC; a dependency in the fund hot path; every calc site still must be ported.

**Lean: A** — because the protocol's real settlement target is on-chain USDC (integer base-units), so integer minor-units makes off-chain ledger and on-chain settlement the same representation (the whole point of not rolling a divergent wheel).

---

## Invariants to preserve (locked) / 不变量
1. **Conservation** — every settlement still conserves exactly (already true; must stay true under the new representation; the residual-absorption pattern carries over trivially to integers, which makes it *more* exact).
2. **No negative balances** (existing cap-at-real-balance behavior).
3. **Bootstrap no-forfeit** (stake_backing=0) and all RFC-007/008 fault semantics unchanged — this RFC changes *representation*, not *policy*.
4. **Display unchanged** to users (format integer units → the same 2-decimal WAZ they see today).

## Implementation phases (gated) / 实施分期(门控)
1. **P0 (done):** the adversarial diagnostic (`test-money-precision-adversarial.ts`) — quantifies drift + becomes the regression guard (dust→0 proves a fix).
2. **P1 (DECIDED: option A):** integer minor-units, scale = 1e6 (1 WAZ = 1,000,000 base-units, USDC-aligned). number-typed integers (safe to ~9e9 WAZ); on-chain USDC boundary stays BigInt (viem). ACP's integer-minor-unit money corroborated A.
3. **P2 (DONE — all fund paths ported):** the single arithmetic surface = `src/money.ts` (`toUnits`/`toDecimal`/`format`/`add`/`sub`/`mulQty`/`mulRate`/`clamp`/`allocate`) + `src/ledger.ts` (`walletUnits`/`applyWalletDelta` absolute-value writes / `creditColumns` pool credits / `debitStakeThenBalance`) + `src/settlement-math.ts` (`computeSettlementSplit`). `allocate()` (largest-remainder) makes "split a total into integer buckets summing EXACTLY to total" the conservation primitive; absolute-value writes (`col = ?` not `col = col + ?`) kill the REAL float-addition dust. Ported via serial PRs:
   - PR1 #152 — money.ts module + tests
   - PR2 #153 — engine `settleFault`/`settleDeclinedNoFault`
   - PR3 #154 — orders-create + shared ledger.ts
   - PR4 #155 — `settleOrder`/`settleCommission`/`depositToFund` + settlement-math.ts (also fixed latent commission-split non-conservation)
   - (#157 — dispute conservation bugfix: 4 "computed-but-not-credited" leaks in `executeSettlement`)
   - PR5 #158 — dispute (`executeLiabilitySplit`/`chargeArbitrationFee`/`executeSettlement` + disputes-write clawback)
   - PR6 #159 — skill market + auction stake

   **Result: zero dust across every fund path; conservation now exact (residual 0 in integer units), proven by `test-money-precision-adversarial`, `test-settlement-math`, `test-dispute-settlement-conservation`, `test-fault-forfeit-conservation`, `test-pv-escrow-conservation`.**
4. **P3 (GATED — storage flip):** schema `REAL → INTEGER` (minor units) + one-time conversion of stored values; flip the diagnostic's clean-value check to a hard storage-level gate. **Not yet needed:** all *arithmetic* is now base-unit-exact and writes are absolute, so the remaining `REAL` storage no longer produces dust. P3 is the final 1:1-with-USDC storage representation, do it when real settlement (x402) approaches.
5. **P4:** x402 / USDC settlement reconciles 1:1 against the integer ledger.

## Trigger to un-gate / 解除门控
**P2 is complete (done now, pre-launch — cheapest window).** Only **P3 (storage `REAL→INTEGER`)** remains gated: do it when **real settlement is on the roadmap** (x402 / real USDC integration starts) OR before any real WAZ balances accrue at launch. Until then the float *storage* is harmless — every arithmetic path is base-unit-exact + absolute-write, so no new dust accrues and the diagnostics stand guard.

## Non-goals / 非目标
- Not changing any fee/penalty/commission **policy** (representation only).
- Not adding a decimal dependency unless option B is chosen.
- Not touching the on-chain layer (viem/Base already uses integer base-units correctly).

---

## Appendix — the broader wheel audit (2026-06-07) / 附:轮子审计结论
The open-standards audit confirmed WebAZ is **already** mostly "core self-built + outward standards" (路 B), correcting the no-repo assumptions:
- **Already standard:** MCP (`@modelcontextprotocol/sdk`) · WebAuthn (`@simplewebauthn/server`) · chain via `viem` + Base · AP2 signed mandates (`routes/ap2-mandate.ts`) · W3C VC + `did:web` (verifiability index) · checkout helpers · DCO + SPDX.
- **Correctly self-built (no standard exists):** meta-rules · iron-rule logic · state machine · dispute/arbitration · governance/CHARTER · use→build (feedback/contribute) · commission attribution.
- **Deferred standard adapters (post-launch):** x402 (real settlement) · ACP/UCP feed+checkout · EIP-8004 agent identity.
- **The one real fix:** this RFC (money float → exact units).
