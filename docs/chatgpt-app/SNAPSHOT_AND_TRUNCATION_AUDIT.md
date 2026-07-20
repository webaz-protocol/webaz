# SNAPSHOT_AND_TRUNCATION_AUDIT

> Phase-2 §VI. Static code trace (no DB/network; reference IDs were NOT queried). Verified by hand in `agent-model-projection.ts`.
> Grades: **CONFIRMED** · **HIGH_CONFIDENCE** · **NOT_REPRODUCED**.

## Part 1 — Detail truncation (`specs_truncated`, `return_condition` cut mid-sentence)

**The truncation is a hard UTF-8 byte-cap in the MODEL-PROJECTION layer. The DB and SQL carry the full text; nothing downstream re-fetches it — it is a dead end for agents.** — CONFIRMED

### Where (all in `src/agent-model-projection.ts`, `projectProductDetail`)
- Caps: `DETAIL_DESC_MAX_BYTES = 900` (`:160`), `DETAIL_SPECS_MAX_BYTES = 800` (`:159`); `capBytes()` slices raw UTF-8 bytes then strips the broken trailing multibyte char (`:163-167`). CJK = 3 bytes/char, so ~300 Chinese chars → the "cut off mid-sentence" with no sentence boundary.
- `description`: capped to 900 B, **flagged** `description_truncated` (`:181,:184-185`).
- `specs`: if the JSON-stringified specs exceed 800 B the **entire object is dropped** (`specs = null`), **flagged** `specs_truncated:true` (`:178-179,:187`). The card then shows no spec keys at all.
- `return_condition`: capped to **200 B with NO flag** (`:189`) — silent mid-sentence cut, model/card cannot know it was truncated.
- `ship_regions`: capped to 200 B, no flag (`:188`). `title`(90)/`summary`(140) capped in `projectProductModel` (`:72,:84`).

### Upstream is NOT the limiter — CONFIRMED
- DB DDL: `description`/`return_condition` are plain `TEXT`, unlimited (`schema.ts:748`).
- SQL/API: the detail route `products-list.ts:492-515` selects `p.*` (full text) then calls `projectProductDetail`. So truncation is imposed **only** at projection.

### Second-fetch path for full text — DEAD END — CONFIRMED
No agent-reachable endpoint returns the untruncated description or the dropped specs. The card render (`ui-widgets.ts:193-208`, `webaz.product_detail.model.v1` branch) shows `…(截断,完整描述见商品页)` for `description_truncated`, and when `specs` was dropped the `if(p.specs)` block is simply skipped — **the human sees no specs and no "specs were truncated" notice on the card** (the flag exists in structuredContent for the model only). `return_condition` has no notice at all.

### Layer verdict
| layer | truncation? |
|---|---|
| DB field | no (TEXT unlimited) |
| SQL projection | no (`p.*`) |
| **model projection** | **YES — `projectProductDetail` byte-caps 900/800/200** |
| card render | only `description` shows a truncation notice; specs silent; return_condition silent |

## Part 2 — Delivery estimate present at quote, `null` on the order

**The quote card and the order card read the delivery estimate from two DIFFERENT source fields. The product-level ETA is never persisted into the quote/draft/order snapshot.** — HIGH_CONFIDENCE (the specific product's shipping-template state was not queried per the read-only constraint; the null arises structurally)

### What each snapshot freezes
- **Quote** (`order_quotes` DDL `webaz-schema-helpers.ts:2064-2091`): economic columns + `shipping_units` (fee) only. **No `estimated_days`/`handling_hours` column.** The quote *response* delivery estimate is a **live read of the product row**: `buyer-quote.ts:160` → `estimated_days: prod?.estimated_days`. So `quote.shipping.estimated_days = products.estimated_days`, not stored.
- **Draft** (`order_drafts` DDL `:2109-2135`; INSERT `order-draft.ts:108`): copies the same economic columns; **no delivery estimate at all** — `draftView` (`order-draft.ts:32-60`) emits none.
- **Order** (`orders-create.ts:348`): writes `shipping_est_days = _ship.estDays`, where `_ship` comes from `gateShippingForCreate` → the **shipping TEMPLATE** only (`shipping-templates.ts:124` no template → `estDays=null`; `:126-133` covered → template `est_days`; `:136` uncovered/quote-on-request → null). `products.estimated_days` is never consulted here.
- `trade_terms_snapshot.fulfilment.estimated_days` (`trade-terms.ts:76`) DOES freeze the product ETA — but the order-timeline projection/card does **not** read it for the delivery line.

### Where the cards read (the drift point)
- Quote card: `agent-model-projection.ts:262` `shipping.estimated_days` (product ETA, live) → rendered `ui-widgets.ts:419` "预计送达".
- Order/timeline: `agent-model-projection.ts:362` `logistics.shipping_est_days` ← `orders.shipping_est_days` (template-derived) via `buyer-order-full-view.ts:184`.

### Consequence — HIGH_CONFIDENCE
For any product with `products.estimated_days` set but **no shipping template covering the buyer's region** (or no template / quote-on-request), `orders.shipping_est_days` is null → `shipping_est_days=null` on the formal order even though search/quote showed the product ETA.

### Adjacent finding — CONFIRMED
The OrderTimeline **widget** (`ui-widgets.ts:544-573`) renders only `tracking` in its logistics block — it **never displays `shipping_est_days` at all**, even when non-null. The value survives into the model-projection JSON but has no visible render on the timeline card.

## Which fields freeze where (summary)
| field | quote snapshot | draft snapshot | order snapshot |
|---|---|---|---|
| economic (units, rail, region, addr-hash) | ✅ `order_quotes` | ✅ `order_drafts` | ✅ `orders` + `trade_terms_snapshot` |
| shipping **fee** (`shipping_units`) | ✅ | ✅ | ✅ |
| **delivery ETA** | ❌ (live product read only) | ❌ | ⚠️ `orders.shipping_est_days` from **template** only; product ETA only in `trade_terms_snapshot` (unread by card) |
| return/warranty days | live product read | — | `trade_terms_snapshot` |

**Key transaction-promise risk:** the delivery estimate a buyer saw at quote time is **not** the authority frozen onto the order; the order's delivery line comes from a different (often empty) source. This is a snapshot-drift/consistency gap, HIGH_CONFIDENCE, worth Phase-3 remediation (carry the quoted ETA into the snapshot, or read `trade_terms_snapshot.fulfilment.estimated_days` on the timeline card).
