# RFC-018: Settlement Clearing Period — accrue in real time, pay after the order is fully closed

**Status**: accepted — open decisions resolved 2026-06-26 (benchmarked against affiliate-network "locking period" practice); implementing in staged PRs on simulated currency. The model (accrue-then-mature) matches the industry norm for referral/affiliate commission. Real-money cutover (when matured balances back real funds) remains gated on external review (Category C).
**Author**: @holden
**Created**: 2026-06-16
**Track**: normal-but-sensitive (money path — payout timing)
**Related issue**: (n/a — design discussion)
**Supersedes**: (n/a)
**Superseded by**: (n/a)

---

## Summary / 摘要

Commission and reputation score should **accrue in real time** when an order genuinely completes, but should **not be paid out (credited to a spendable balance / finalized) until the order is fully closed** — i.e. a clearing period (e.g. 15 days) has elapsed with no reversal (return / late dispute / refund). This RFC proposes an **accrue-then-mature** model: the gate lives at the **settlement (payout) phase**, not the calculation phase. Accrued-but-unpaid amounts sit in a **pending** ledger (generalizing the existing `pending_commission_escrow`); a maturation job promotes `pending → settled` only after `matures_at` *and* a re-check that the order is still genuinely closed, otherwise `pending → reversed`. Because nothing is paid before maturity, **there is never a clawback**.

本提案:佣金 / 信誉分**实时累计、延迟结算**。订单真实完成时即时计算并记入 **pending**(待结算)账,展示为"清算中";只有清算期(如 15 天)结束且订单彻底关闭、无逆转(退货 / 迟到争议 / 退款)时,才 `pending → settled` 真正到账;期间发生逆转则 `pending → reversed`,从不入账。关卡设在**结算阶段**而非计算阶段 —— 因为从不预付,所以**永远不用追回(clawback)**。

## Motivation / 动机

Today `settleCommission` (src/pwa/server.ts) credits direct-sponsor commission **immediately to the wallet** (`UPDATE wallets SET balance = balance + …`) the moment an order reaches `completed`. Reputation events fire on completion too. But `completed` is the settlement state machine's terminal — an order can still be reversed around that point (returns, late disputes, fault dispositions). Paying at completion creates two problems:

1. **Clawback risk.** If a reversal happens after payout, the protocol must reclaim money already credited (and possibly spent / withdrawn). Clawback is operationally messy, a fraud vector ("order → get commission → trigger refund → keep commission → withdraw before reclaim"), and violates the money-path rule *钱路绝不假设成功* (never assume success on the money path).
2. **Honesty.** Showing a balance as *paid* and later reducing it reads as the protocol taking money back (meta-rule #4 不撒谎 / #1 当一切可见).

This is the natural complement to the genuine-sale work (#395 / #396): *genuine completion* (`order_state_history` reached `confirmed`) is the **entry** condition for accrual; *matured + still-closed* is the **payout** condition. The primitive already exists — `pending_commission_escrow` (status `pending → settled → expired`, with `created_at` / `expires_at` / `settled_at`) is used today for `pv_pair` and some L1–L3 paths. The gap is that **direct commission bypasses it and pays the wallet immediately**, and there is **no maturation gate tied to order closure**. PV / matching rewards are already deferred (settled in `settlement_periods` batches, and gated OFF as Category C), so this RFC is mainly about **direct commission + reputation score**.

## Design / 设计

### Two phases

**Phase 1 — Accrual (real-time, on genuine completion):**
- Trigger: order reaches genuine completion (`confirmed→completed`; uses `genuineSalePredicate` semantics — fault / refund / dispute terminals never accrue).
- Compute commission + score exactly as today, but write to the **pending ledger** instead of the spendable balance:
  - commission → `pending_commission_escrow` with a new `matures_at` column,
  - score → a pending / "clearing" reputation balance (separate from the finalized `lifetime_score`).
- UI shows it live: *清算中 · N 天后到账 / clearing · matures in N days*. This satisfies "累计可以实时".

**Phase 2 — Maturation (gated payout, after the order is fully closed):**
- A periodic **maturation job** (mirrors the existing `rewards-escrow-expire` / `checkTimeouts` cron pattern) scans pending rows where `matures_at ≤ now`.
- For each, it **re-validates the order at settle time** (the authoritative guard — never trust only the elapsed timer or the stale pending row): the order must still be in a final, non-reversible genuine state (no open / adverse dispute, not refunded / returned / faulted).
  - Pass → `pending → settled`, credit wallet / finalize score, **in one transaction, idempotent, with a balance/conservation guard**.
  - Fail (reversed during the window) → `pending → reversed`, never paid. No clawback needed because it was never in the wallet.

### Key mechanics

- **Clock anchor**: `matures_at = completed_at + clearing_period`. Set once at accrual time. (Per the clock-anchor discipline: every absolute-timestamp field that gates payout must be set consistently and re-derived from the order's genuine-close event, not from wall-clock at settle time.)
- **Param-driven**: `clearing_period` is a protocol parameter (e.g. `settlement.clearing_days = 15`), governance-adjustable (CHARTER), not hard-coded.
- **Single authority**: maturation is the *only* writer that moves `pending → settled`; accrual is the *only* writer that creates `pending`. Reversal is driven by the order state machine. No path credits the spendable balance directly for commission anymore.
- **Idempotency**: maturation keyed on `pending_commission_escrow.id` + `status='pending'` CAS, so re-runs / crashes don't double-pay (same discipline as the existing escrow-expire job).
- **Cron, not lazy-on-read**: money becoming spendable must not depend on the user opening a page.

### Affected modules
- `src/pwa/server.ts` — `settleCommission`: route to pending instead of immediate wallet credit.
- `pending_commission_escrow` — add `matures_at`; generalize beyond `pv_pair`.
- Reputation engine (L4-3) — split pending vs finalized score; finalize on maturation.
- New maturation cron (alongside `rewards-escrow-expire` / `checkTimeouts`).
- Order state machine (L0-2) — reversal events (return / late dispute) must mark the linked pending rows `reversed`.

## Open decisions / 待决策 (must be resolved before implementation)

These are **policy levers**, deliberately not pre-decided here (avoid a fait-accompli RFC):

1. **Scope** — ~~(a) commission + reputation score only [recommended] vs (b) also the seller's escrow payout~~ **RESOLVED 2026-06-26 → (a) commission + reputation score.** Affiliate "locking period" governs the *referral commission*, not the merchant's own funds; seller escrow continues to release on `completed`. Seller-payout timing (and using the existing RFC-008 stake as a return-reserve) is a **separate, later decision**, explicitly out of scope here. Eligibility / `sales_count` / `completion_count` are live `COUNT(status='completed')` subqueries that returns don't currently exclude; making them returned-aware is a **separate follow-up PR** (not gated by this clearing model).
2. **~~What reverses an order *after* completion?~~ — RESOLVED (2026-06-16 investigation).** The order state machine makes `completed` immutable (only exit is `confirmed→completed`; no `completed→*`; disputes open only pre-completion, so fault/refund/resolved are all pre-completion and already handled — commission never accrues or is clawed back by `settleFault`). **But a separate post-completion reversal path exists: the returns flow (`src/pwa/routes/returns.ts`).** It operates **only on `completed` orders** within the per-product `return_days` window, refunds the buyer (full or partial, seller wallet → buyer wallet), restores stock, and records a seller fault rep event — but it **leaves `orders.status='completed'` and never touches commission / PV / score.** So today a fully-returned order keeps the promoter's commission paid and still counts as a genuine sale. This makes the clearing window **load-bearing**, and pins:
   - `clearing_days` **≥ the product's `return_days`**, anchored at `completed_at`;
   - a return during the window **reverses the pending commission/score**, **proportionally** for partial refunds (`refund_amount / total_amount`);
   - returns become a first-class **reversal trigger** for the maturation gate (alongside any future late-dispute path).

   (Independent current gap, noted under Risks: returns already inflate commission + eligibility/sales counts; the deferred clearing model is the holistic fix.)
3. **Clearing length + anchor** — ~~proposed flat 15 days~~ **RESOLVED 2026-06-26 → per-product, self-adapting to the return window.** `matures_at = completed_at + product.return_days + settlement.clearing_buffer_days`. Anchor = `completed_at`. The buffer (`settlement.clearing_buffer_days`, governance param, default **2** days) covers late-dispute / processing slack beyond the product's own return window. Rationale: on crypto rails there is no chargeback, so the return window is the dominant (only) reversal clock — tying the hold to each product's `return_days` (default 7 → matures ≈ day 9) is the *minimum-intervention* correct hold (#8), not a one-size 15-day over-hold. Products with `return_days = 0` (no returns) mature after just the buffer. Both `return_days` (per product) and `clearing_buffer_days` (global) are governance-tunable.

## Meta-rule impact / 元规则影响

(Cross-checked against `docs/META-RULES-FULL.md` #1–#10.)

- #1 当一切可见: **enhanced** — pending vs settled is explicit; users see "clearing · matures in N days" rather than a balance that silently shrinks.
- #2 代码即规则: maturation rule is code + a governance param; no discretionary holds.
- #3 不偷数据: no new data collected.
- #4 不撒谎: **enhanced** — never shows money as *paid* then reclaims it; "pending" is honestly labeled.
- #5 不偏袒: same clearing rule for everyone; param is global.
- #6 不滥用: **closes** the refund-farm / pay-then-reverse abuse vector.
- #7 不操纵: payout no longer gameable by inducing a post-payout reversal.
- #8 最小介入: deferring payout is *more* intervention than instant pay — justified only by the abuse/clawback risk; keep the window as short as the real return/dispute window requires, not longer.
- #9 算法即协议: maturation is algorithmic (cron + state re-check), not manual approval.
- #10 参与者即 webazer: n/a.
- Iron-Rule 技术边界: maturation is an automatic system settlement (not one of the 7 human-Passkey paths), so it does **not** bypass the iron rule. Large *withdrawals* of matured balance remain under the existing human-presence withdrawal gate.

## Alternatives / 替代方案

### Alt 1: Pay immediately, claw back on reversal (status quo + reversal handler)
Keep instant payout; if a reversal happens, deduct from the recipient's wallet.
**Rejected**: clawback can fail (balance spent / withdrawn → negative balance or bad debt), is a fraud vector, and violates *钱路绝不假设成功*. The whole point of the pending model is to never owe a clawback.

### Alt 2: Gate at the calculation phase (don't even compute until closed)
Compute nothing until the order is fully closed, then both calculate and pay.
**Rejected**: loses the real-time accrual / feedback the design explicitly wants ("累计可以实时"). Users would see nothing for 15 days.

### Alt 3: No clearing window (rely solely on genuine-sale entry gate)
Argue that #395/#396 (only genuine `confirmed` orders accrue) already excludes fault/refund, so no window is needed.
**Rejected (conditionally)**: that gate excludes orders that *failed before completion*, but does not cover reversals that can occur *after* completion (open decision #2). If such post-completion reversals exist, the window is needed; if they provably cannot, this RFC reduces to belt-and-suspenders and may be deferred.

## Migration & compatibility / 迁移与兼容

- **Build on the existing primitive**: generalize `pending_commission_escrow` (add `matures_at`) rather than introduce a new table; reuse the `pending → settled / expired` lifecycle and the escrow-expire cron pattern. Add a `reversed` status.
- **PV / matching** already settles via `settlement_periods` batches and is Category-C-gated OFF — unchanged by this RFC.
- **Existing pending rows** (pv_pair) get a `matures_at` backfill (pre-launch ≈ 0 real rows, so trivial).
- **API**: surfaces that read a user's commission/score should distinguish `pending` (clearing) vs `settled` (spendable). Existing `pending_commission_escrow` reads already expose pending/expired totals (rewards-apply.ts, MCP) — extend to show `matures_at`.

## Risks / 风险

- **Money-path correctness**: maturation must be tx-atomic + idempotent + balance-guarded; a bug could double-pay or pay a reversed order. Mitigation: CAS on `status='pending'`, re-validate order state in the same tx, conservation check. (Same discipline as the RFC-014 integer-money + escrow-expire paths.)
- **Stuck pending**: if the maturation cron stalls, balances never mature. Mitigation: monitoring + the job is the single authority; lazy fallback on read for *display* only (never for crediting).
- **Window too long / too short**: too long frustrates legitimate earners; too short pays before the return window closes. Tie the param to the actual return/dispute window (decision #3).
- **Score semantics**: pending vs finalized score must not leak into reputation-gated privileges (search boost / stake discount) until settled — otherwise the clearing period is bypassed via score.
- **Real funds**: this changes when real money becomes spendable → **must not ship to real-money phase without external review** (Category C).

## Test plan / 测试计划

- Unit: accrual writes pending (not wallet); maturation promotes only after `matures_at` AND order still closed; reversal marks `reversed` and never credits; idempotent re-run doesn't double-pay; conservation holds.
- State-machine: an order reversed during the window (per decision #2's transitions) flips its pending rows to `reversed`.
- Property: sum(settled) + sum(pending) + sum(reversed) == sum(accrued); no wallet credit precedes maturation.
- Reuse the `order_state_history` fixtures from `test-share-genuine-receipt.ts` (genuine vs fault) to assert only genuine orders accrue.

## Pre-flight checklist / 提交前自查

- [x] 我已读 [`CHARTER.md §6`](../CHARTER.md) 和 [`§3.2`](../CHARTER.md)
- [x] 我已对照 [`META-RULES-FULL.md`](../META-RULES-FULL.md) 全部 10 条
- [x] 我理解【绕过 ≠ 修改】 Iron-Rule — 本提案的成熟结算是自动系统路径,不绕过 7 条真人 Passkey 路径;大额提现仍走真人门
- [x] 本提案不修改 Iron-Rule 边界或元规则 #1–#10 文字 → normal track(但属 money-path 敏感,gated on real-money phase + 外审)
- [x] 已列 3 个替代方案并说明为什么不选

## Implementation tracking / 实现追踪

Staged (money-path → each its own Draft PR → Codex audit → merge):
- **PR1 (schema + RFC, additive, no behavior change)**: this PR — resolve decisions #1/#3, status → accepted; add `pending_commission_escrow.matures_at` (fresh via inline CREATE, existing via the generalized rebuild — no new server.ts DDL occurrence per the complexity ratchet); `reversed` is a new TEXT status value (no schema change); seed `settlement.clearing_buffer_days` param (default 2).
- **PR2 (core mechanism)**: `settleCommission` accrues to pending (not the wallet) with `matures_at`; reputation engine splits pending vs finalized score (adds pending-score column via runtime helper, not server.ts); maturation cron (re-validate order still genuinely closed → CAS `pending→settled`, tx-atomic + conservation + idempotent); `returns.ts` marks linked pending rows `reversed` proportionally.
- **PR3 (surfaces)**: API / UI / MCP distinguish `清算中 · matures in N days` vs settled.
- **PR4 (follow-up, separate)**: make eligibility / `sales_count` / `completion_count` returned-aware.

- PR: (PR1) feat/rfc018-clearing-schema
- Commit:
- Closes issue:

---

**Status history / 状态变更**:

- 2026-06-16: draft created by @holden (design-only; gated on resolving open decisions #1/#2/#3 + real-money phase + external review)
- 2026-06-16: open decision #2 RESOLVED — post-completion reversal path identified = the returns flow (`returns.ts`); clearing window confirmed load-bearing; constraints pinned (`clearing_days ≥ return_days`, proportional reversal, returns as a reversal trigger).
- 2026-06-16: **deferred / parked** by @holden — design + investigation recorded; to be refined later against mature e-commerce platforms' established return-window / settlement-hold / clearing-period practices before implementation. Decisions #1 (scope) and #3 (length/anchor) remain open and should be informed by that benchmarking.
- 2026-06-26: **un-parked / accepted** by @holden after benchmarking against affiliate-network "locking period" practice (the accrue-then-mature model is the industry norm for referral commission). Open decisions resolved: **#1 → (a) commission + reputation score** (seller escrow payout out of scope; eligibility-count fix = separate follow-up); **#3 → per-product** `matures_at = completed_at + return_days + settlement.clearing_buffer_days` (buffer default 2d, governance-tunable). Implementation begins as staged PRs (PR1 = schema + this RFC). Real-money cutover still gated on external review (Category C).
