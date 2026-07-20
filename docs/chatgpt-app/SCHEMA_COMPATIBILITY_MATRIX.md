# SCHEMA_COMPATIBILITY_MATRIX — every card the shared components must render (BUG-06)

> Companion to `SCHEMA_V2_CONTRACT.md`. One row per card kind. Records: schema_version, `type`,
> required / optional fields, `status` structure, `quantity` structure, timestamp structure,
> `promised_eta`, old-input compatibility, new-output, the rendering component, and the
> safe-fail behavior. Local protocol tests only — not live-host verified.

Legend — **status structure**: `string` = bare status code string · `object` = `{code,label,label_en}` · `n/a` = card has no status.
**quantity structure**: `int` = positive integer · `n/a` = card has no quantity · `raw` = untyped passthrough (legacy).

---

## 1. Product results — `webaz.product_search.model.v1` / `webaz.product_detail.model.v1`
- **type:** *(none — product cards predate the `type` discriminator; routed by schema_version)*
- **required:** `schema_version`, `products[]` (search) / `id,title,price` (detail)
- **optional:** `count`, `next_cursor`, `sellers`, `fx`, `recovery`, `result_handle`, `decision_flags`
- **status structure:** `n/a` (products use `stock_status` enum `in_stock|low_stock|out_of_stock`, not order status)
- **quantity structure:** `n/a`
- **timestamp structure:** `fx.as_of` ISO-8601 UTC; no order timestamps
- **promised_eta:** `n/a` (a listing carries `estimated_days`, not a frozen promise)
- **old-input compat:** unchanged — **not bumped by BUG-06**
- **new-output:** unchanged (v1)
- **component:** `PRODUCT_RESULTS_BODY_JS`
- **safe-fail:** unknown schema_version in this component → safe "no structured payload" text

## 2. Quote — `webaz.order_quote.model.v2`  *(was v1)*
- **type:** `order_quote`
- **required:** `schema_version`, `type`, `quote_id`, `product{id,title}`, `quantity`, `price`, `status`, `available_actions`, `disclosures`
- **optional:** `quote_token` (single-use) **or** `quote_token_note`+`replay`, `fiat_estimate`, `amounts`, `destination`, `shipping` (incl. frozen `estimated_days`), `return_days`, `warranty_days`
- **status structure:** `object` — `{code:"quoted", label:"报价", label_en:"quoted"}` (uniform; a quote has no order status)
- **quantity structure:** `int` (positive integer)
- **timestamp structure:** `expires_at` ISO-8601 UTC
- **promised_eta:** the frozen ETA surfaces via `shipping.estimated_days` (BUG-02); the quote **consumer** projection carries no separate `promised_eta` object. **BUG-06 leaves this unchanged.**
- **old-input compat:** v1 quote (no `type`, no `status`, quantity number) still renders — component accepts v1+v2 in the quote branch; header shows `报价 · <title> ×<qty>`
- **new-output:** v2 (adds `type`+`status`, quantity guaranteed positive int)
- **component:** `QUOTE_APPROVAL_BODY_JS` (quote branch)
- **safe-fail:** `quote_token_note` path (replay) → `available_actions:[]`, no executable button

## 3. Draft — `webaz.order_draft.model.v2`  *(was v1)*
- **type:** `order_draft`
- **required:** `schema_version`, `type`, `draft_id`, `status`, `product{id,title}`, `quantity`, `price`, `available_actions`, `disclosures`
- **optional:** `fiat_estimate`, `destination`, `payment_rail`, `rail_note`, `expires_at`, `idempotent_replay`, `already_cancelled`; **list form** `{count, drafts[]}`
- **status structure:** `object` — `{code, label, label_en}`, code ∈ `draft|submitted|cancelled|expired` (`DRAFT_STATE_MEANINGS`)
- **quantity structure:** `int`
- **timestamp structure:** `expires_at` ISO-8601 UTC
- **promised_eta:** the frozen snapshot lives on the raw draft/order row (BUG-02); the draft **consumer** projection surfaces no `promised_eta` object. **BUG-06 leaves this unchanged.**
- **old-input compat:** v1 draft had `status` as a **string** → component's `stLabel`/`stCode` normalize a string OR object once at entry; `submit_request` button still gates on `stCode==='draft'`
- **new-output:** v2 (status object, quantity positive int, `type`)
- **component:** `QUOTE_APPROVAL_BODY_JS` (draft branch, incl. list form)
- **safe-fail:** non-`draft` status → `available_actions:[]`, no submit button

## 4. Approval pending — `webaz.order_approval.model.v2`  *(was v1)*
- **type:** `order_approval`
- **required:** `schema_version`, `type`, `request_id`, `draft_id`, `action_type:"order_create"`, `status`, `passkey_required:true`, `approval_url`, `available_actions`, `disclosures`
- **optional:** `duplicate:true`, `duplicate_warning{…}`, `on_approval`
- **status structure:** `object` — `{code:"pending", label:"待批准", label_en:"pending"}`, code ∈ `pending|executed|rejected|expired|failed|needs_reconcile` (`APPROVAL_STATE_MEANINGS`, matches `webaz_approval_requests` read-back)
- **quantity structure:** **`n/a` (references `draft_id`)** — documented omission (§5 of the contract); fabricating one needs a money-path DB read, disallowed this phase
- **timestamp structure:** none in this projection
- **promised_eta:** `n/a` (not part of the approval projection)
- **old-input compat:** v1 approval had `status:"pending"` **string** → normalized by `stLabel`/`stCode`; the duplicate-warning path is unchanged (no BUG-08 change)
- **new-output:** v2 (status object, `type`)
- **component:** `QUOTE_APPROVAL_BODY_JS` (approval branch)
- **safe-fail:** duplicate → explicit reuse warning; submit NEVER executes (Passkey-only)

## 5. Approval executed — `webaz.order_approval.model.v2` (status `executed`) / then Order timeline
- **type:** `order_approval` at submit; after Passkey approval the executed order is read back as **order_timeline** (row 6)
- **required:** as row 4, with `status.code:"executed"` on read-back via `webaz_approval_requests`
- **status structure:** `object` — `{code:"executed", label:"已执行", label_en:"executed"}`
- **quantity structure:** `n/a` on the approval read; the executed **order** (timeline) carries the `int` quantity
- **promised_eta:** on the executed order (timeline), inherited snapshot; **preserved**
- **old-input compat:** v1 read-back `status:"executed"` string → normalized
- **new-output:** v2
- **component:** `QUOTE_APPROVAL_BODY_JS` (approval branch) → user navigates to `ORDER_TIMELINE_BODY_JS`
- **safe-fail:** `needs_reconcile`/`failed` codes render honestly via the meanings map; no button mis-fire

## 6. Order timeline — `webaz.order_timeline.model.v2`  *(was v1)*
- **type:** `order_timeline`
- **required:** `schema_version`, `type`, `order_id`, `status`, `product{id,title}`, `quantity`, `price`, `payment_rail`, `rail_badge`, `timeline[]`, `logistics`
- **optional:** `fiat_estimate`, `next_actor`, `deadline{iso,note}`, `incremental`, `refund{requests[]}`
- **status structure:** `object` — `{code,label,label_en}` via `ORDER_STATE_MEANINGS` (already an object in v1; unchanged shape)
- **quantity structure:** `int` (v1 allowed `null`; v2 coerces to a positive integer)
- **timestamp structure:** `deadline.iso`, `timeline[].at`, `refund[].created_at/resolved_at` all ISO-8601 UTC (BUG-07)
- **promised_eta:** `logistics.promised_eta` = `webaz.promised_eta.v1` (下单承诺) vs `logistics.shipping_est_days` (物流估计) — two ETAs kept separate; **preserved unchanged**
- **old-input compat:** v1 timeline already had status object → component accepts v1+v2 in one branch
- **new-output:** v2 (adds `type`, quantity guaranteed positive int)
- **component:** `ORDER_TIMELINE_BODY_JS` (timeline branch)
- **safe-fail:** unknown order-status code → `{code,label,label_en}` all = raw code, rendered, never dropped

## 7. Order list / minimal / up-to-date — `webaz.order_status.model.v1`  *(NOT bumped)*
- **type:** *(none — minimal projection)*
- **required:** `schema_version`, and one of `orders[]` (list) / `order` (single minimal) / `up_to_date:true`+`order_id`+`status`
- **status structure:** `string` (bare code) — **kept v1**; this is a minimal projection, not a shared full card, and never mixes with an object within its own version
- **quantity structure:** `n/a` (7-key minimal projection has no quantity)
- **timestamp structure:** `deadline` per the minimal projection
- **promised_eta:** `n/a`
- **old-input compat:** unchanged
- **new-output:** unchanged (v1)
- **component:** `ORDER_TIMELINE_BODY_JS` (`order_status` branch, reads the string as-is)
- **safe-fail:** unchanged — the list branch reads `String(status||'')`

## 8. Error result — any tool, structured error shape
- **type:** *(none)* — carries `error` + `error_code` (+ recovery fields) instead of a card body
- **required:** `error` (string), `error_code` (string)
- **optional:** `recovery{…}`, `schema_version` (may be absent on a pure error)
- **status structure:** `n/a`
- **quantity structure:** `n/a`
- **timestamp structure:** `n/a`
- **promised_eta:** `n/a`
- **old-input compat:** unchanged — outputSchemas keep `error`/`error_code` and do **not** set `additionalProperties:false`, so a structured error never fails host validation
- **new-output:** unchanged; **no implicit JS coercion** — an error result is detected by the presence of `error`/`error_code`, never by coercing a card field
- **component:** whichever component is targeted → if no recognizable `schema_version` card branch matches, safe fallback text (no crash)
- **safe-fail:** missing schema_version + present error → "no structured payload"/error text, never a mis-rendered card

## 9. Empty result — list/search with zero items
- **type:** the enclosing card's type (e.g. `order_draft` list with `count:0`)
- **required:** `schema_version`, the empty collection (`drafts:[]` / `orders:[]` / `products:[]`, `count:0`)
- **optional:** `recovery` (search 0-hit: labeled catalog sample + next_step)
- **status structure:** `n/a` at the container level
- **quantity structure:** `n/a` at the container level
- **timestamp structure:** `n/a`
- **promised_eta:** `n/a`
- **old-input compat:** unchanged
- **new-output:** unchanged shape; the list wrapper carries the (now v2) `schema_version`
- **component:** the matching list branch renders an empty list header
- **safe-fail:** empty array → header + no rows; never an undefined-deref

---

## Cross-cutting invariants (all rows)

| Invariant | Rule |
|---|---|
| status source | v2 status is an **object**; `code` is authoritative, never inferred from `label` |
| quantity → amount | the card's `quantity` is display-only; the charged amount is `price.amount_minor` (server) |
| timestamps | all v2 timestamps are ISO-8601 **UTC** (`…Z`) via `toIsoUtc` |
| promised_eta | `webaz.promised_eta.v1` preserved unchanged; missing → BUG-02 `legacy_missing` |
| unknown schema_version | consumer shows "unsupported old card version", never crashes / mis-renders |
| missing schema_version | safe "no structured payload" fallback; server always stamps a version |
| no forced migration | v2 produced in the projection layer only; no DB business-data migration; no v1 field deleted |
| BUG-08 untouched | duplicate-purchase / approval-idempotency fields & hashes unchanged |
