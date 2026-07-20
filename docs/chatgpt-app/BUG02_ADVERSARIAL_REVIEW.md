# BUG02_ADVERSARIAL_REVIEW

> Independent read-only adversarial review of the BUG-02 (promised delivery ETA snapshot) change, run by a fresh Claude session (review model = Claude, this session; Codex unavailable until 2026-07-25 — noted as the limitation: single-model adversarial pass, no external second model). The review session did **not** modify code; findings were processed by the main implementation session afterward and re-tested.
>
> Scope reviewed: commits `0976128` (migration), `2c65d8a` (freeze chain), `2a2fbba` (card UI), via `git diff 0976128~1..2a2fbba`.

## Verdict: no BLOCKER, no HIGH. Freeze→inherit chain, hash isolation, migration safety, and legacy handling are correct.

## Findings

### F1 — MEDIUM (region case-tier divergence: fee vs ETA) — **FIXED** (`e72b418`)
The promised-ETA path normalized the destination region (trim+UPPER via `normalizeRegion`) while the pre-existing shipping-**fee** path used the raw `regionTag` (`resolveShipping` is case-sensitive; template keys are stored UPPERCASE). A buyer whose `default_address_region` is stored mis-cased (e.g. `"china"`, `"sg"`) with a template that has both a case-differing exact entry and a `*` wildcard would be charged the **wildcard fee** but shown the **exact-region ETA** (optimistic divergence). Root cause: the pre-existing un-normalized fee path; BUG-02 exposed it because `shipping.estimated_days` is now region-resolved.
- **Resolution:** normalize `regionTag` once at derivation (`buyer-quote.ts` — `normalizeRegion(u?.default_address_region)`), so the fee tier, ETA tier, persisted `dest_region`, and the create path (`gateShippingForCreate`, already normalized) all agree. This is exactly what §IV.5/6 requires. Only affects mis-cased inputs (now correctly matching their exact tier); `SG`-cased quotes are byte-unchanged. Locked by `test-eta-snapshot-flow` F1a/F1b (lowercase `sg` → exact `SG` for BOTH fee and ETA).

### F2 — LOW (coverage gap: direct buy-now orders) — accepted, documented
Direct/buy-now (non-draft) orders insert `promised_eta_snapshot = null` (`orders-create.ts` writes it only when `_dl.kind === 'link'`), so a freshly-created buy-now order renders `legacy_missing` ("下单时未记录预计配送时间"). This is **honest** (the buy-now path never froze a quote), not a fabrication. The promised-ETA feature covers the quote→draft→order (agent card) path. If the PWA buy-now checkout shows an ETA at purchase time, snapshotting that is a separate follow-up. Documented in KNOWN_LIMITATIONS; NOT a BUG-02 defect.

## Checks that passed cleanly (reviewer-confirmed)
1. **Money/funds** — the orders INSERT adds only the ETA column/value; `total_amount`/`escrow_amount`/`shipping_fee`/`donation_amount`/`stake_backing` byte-identical. No amount/fee/total/escrow/wallet touched.
2. **Order status / deadlines** — status `'created'` + all `addHours(...)` deadlines unchanged; no transition/deadline write added.
3. **Approval dedup** — `orderSubmitParamsHash`/`orderSubmitIntentHash`/quote `intent_hash` all exclude `promised_eta_snapshot` (even though `draft = SELECT *` now carries it). No BUG-08 regression.
4. **Historical backfill** — null snapshot → `legacyMissingEta()`; never reads the live listing for a legacy order.
5. **Region selection** — `resolveShipping` is exact-first then wildcard, order-independent (no traversal bug); the only issue was F1 (now fixed).
6. **Listing drift** — `buildResponse`/`draftView`/`buildBuyerOrderFull` all read the frozen `promised_eta_snapshot`, never re-read products for the ETA. Flow test D2/O2 prove immunity.
7. **"Guarantee" wording** — labels 下单时预计配送 / 当前物流预计; `etaText` emits 约N天 / range / "未记录" / "无配送估计" — no guarantee language.
8. **Migration/rollback** — three additive nullable `ADD COLUMN` (no default, no backfill), idempotent try/catch, AFTER-CREATE; no money/status/deadline column touched.
9. **quote_token binding** — snapshot is written server-side into `order_quotes` and read back keyed by `token_hash`; client never supplies the ETA → not forgeable on replay.
10. **Old-message compatibility** — `etaText(e)` guards `if(!e) return null`; a card with no `promised_eta` renders safely.
11. **Concurrent orders** — each order copies its own draft's snapshot by `draftId`; no shared state.
12. **Sensitive fields** — fixed key-set (region code + day counts + reason); `buildPromisedEta` never receives address text. Tests Z1/Z2.
13. **SQL arity** — orders INSERT 39 cols (1 literal) → 38 `?` → 38 args; order_quotes 25=25=25; draft balanced. All verified.

## Limitation of this review
Single-model adversarial pass (Claude, this session). A second-model (Codex) pass is recommended when it returns (2026-07-25) before this branch is merged — standard for money/state/schema changes.
