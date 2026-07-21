# SCHEMA_MIGRATION — BUG-02 (ETA snapshot) + BUG-06 (status/quantity) (DESIGN — NOT YET IMPLEMENTED)

> Two money/state/schema changes, each its own commit with a backward-compatible migration, fresh-boot + `pg:schema` verification, and a real second-model adversarial pass (when Codex returns). No backfill of historical rows with current-listing values.

## §ETA — BUG-02: delivery estimate into the trade snapshot — **IMPLEMENTED** (Phase-3A.2A)

> Built as commits `0976128` (migration) · `2c65d8a` (freeze chain) · `2a2fbba` (card) · `e72b418` (F1 region-normalization). As-built differs slightly from the original plan below (kept for reference): the three delivery times are `listing_eta` (product), `promised_eta_snapshot` (frozen at quote, inherited), `logistics_eta` (existing `orders.shipping_est_days`, template). New nullable additive columns `promised_eta_snapshot TEXT` on `order_quotes` / `order_drafts` / `orders` (ALTER-after-CREATE, no backfill). Freeze at `computeBuyerQuote` → inherit at `createOrderDraft` → persist at the orders INSERT (draft-linked only; direct buy-now = NULL/legacy_missing). Region normalized once (F1). ETA is **not** in `params_hash`/`intent_hash` (no BUG-08 impact). Card shows 下单时预计配送 + 当前物流预计 + legacy-missing. Tests: `test-delivery-eta` (23), `test-eta-migration` (21, fresh+upgrade+idempotent), `test-eta-snapshot-flow` (13, freeze→inherit→drift-immune→legacy). Adversarial review: `BUG02_ADVERSARIAL_REVIEW.md` (no BLOCKER/HIGH; F1 fixed, F2 documented). **Not yet done (Phase 3B):** live-host confirmation the card renders both ETAs on real ChatGPT.

### Original plan (reference)
### Three distinct delivery times (name them explicitly)
- `listing_eta` — the seller's current `products.estimated_days` (mutable).
- `quoted_eta` — the ETA the buyer saw, **frozen** at quote time.
- `logistics_eta` — the current carrier estimate once shipped (dynamic).

### Migration (backward-compatible, additive)
- `order_quotes`: add `quoted_est_days INTEGER NULL` (+ `quoted_handling_hours INTEGER NULL`).
- `order_drafts`: add `quoted_est_days INTEGER NULL` (inherited from the quote).
- `orders`: reuse existing `shipping_est_days` for `logistics_eta`; add `ordered_est_days INTEGER NULL` for the frozen `quoted_eta` (distinct from the template-derived `shipping_est_days`). All `ADD COLUMN … NULL IF NOT EXISTS`, no NOT NULL, no default backfill.
### Write path
- `buyer-quote.ts`: persist `products.estimated_days` → `order_quotes.quoted_est_days` at quote creation (freeze what was shown).
- `order-draft.ts`: copy `quoted_est_days` from quote → draft.
- `orders-create.ts`: copy draft/quote `quoted_est_days` → `orders.ordered_est_days`; keep `shipping_est_days` from the template as `logistics_eta`.
### Read/card path
- `buyer-order-full-view.ts` / `projectOrderTimelineConsumer`: emit `ordered_eta` (frozen) + `logistics_eta` (dynamic) + tracking separately.
- OrderTimeline widget: render "下单时预计送达 X天" (from `ordered_eta`), "当前物流预计 Y天" (from `logistics_eta`), tracking. **Old orders** with `ordered_est_days` NULL render "下单时未记录" — NEVER read the current listing to fake a historical promise.
### Tests
listing→quote→draft→order inheritance; listing changed after order (order snapshot unchanged); no-ETA product; old order (NULL → "下单时未记录"); logistics ETA overlays display but never overwrites `ordered_eta`; SG vs all/default region selection. Fresh-boot migration test (fresh DB → columns present → `pg:schema` parity).

## §status — BUG-06: status + quantity data contract
### Problem (Phase-2 BUG-06/07-adjacent)
`status` is an object `{code,label,label_en}` in the timeline schema but a string in draft/submit/list; `quantity` shape varies (number/passthrough/nullable).
### Design (versioned, non-breaking)
- Bump the affected consumer schemas to `…​.model.v2` (e.g. `webaz.order_draft.model.v2`) that carry `status: {code,label,label_en}` uniformly + `quantity: <positive integer>` + a `type` discriminator. Keep v1 producers/consumers working.
- **Component dual-version:** each render body accepts BOTH v1 (string status / raw quantity) and v2 (object status / int quantity) by normalizing on read: `const st = typeof out.status==='object' ? out.status : {code:out.status,label:...}`. New handlers emit v2 only; old chat messages (v1) still render.
- No forced bulk migration of historical messages; version is per-response.
- Unknown status / wrong type / bad quantity → safe "未知投影版本 / 未知状态" fallback (already present), never inferred from display text.
### Tests
each schema_version renders; each status code; v1 message still renders under a v2-aware component; object-vs-string status input; non-integer/nested quantity → safe fail; unknown status; wrong `type` → wrong component safe-fails; quote/draft/approval still split by schema_version.
### Compatibility matrix
Ship a small table (component × schema_version → renders/ignores) in this doc when built.

## Ordering & guards
Build §ETA and §status as **separate** commits. Money/state/schema iron rules: sync `db.transaction` for any write touching funds/state; balance guards unchanged; `routes:seam-check` + `gen:api-docs` after route edits; fresh-boot then `pg:schema`→`pg:verify`; second-model adversarial review before merge.
