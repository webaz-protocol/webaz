# SCHEMA_V2_CONTRACT — unified machine data contract for quote / draft / approval / order cards (BUG-06)

> **Status:** Phase-3A.2B (BUG-06). Local protocol tests only — not live-host verified.
> **Scope:** the four order-lifecycle cards that share the ChatGPT MCP-App components
> (`webaz_quote_order`, `webaz_order_draft`, `webaz_submit_order_request`, `webaz_buyer_orders` full form).
> **Not in scope:** product results, the minimal order list (`webaz.order_status.model.v1`),
> error results, empty results — these keep their existing contract and are documented in
> `SCHEMA_COMPATIBILITY_MATRIX.md`. Approval-idempotency / duplicate-purchase semantics (BUG-08) are **untouched**.

## 1. Why

Before BUG-06 the same shared component received cards whose machine fields drifted **across** the
family:

| field | quote v1 | draft v1 | approval v1 | timeline v1 |
|---|---|---|---|---|
| `status` | *(absent)* | **string** `"draft"` | **string** `"pending"` | **object** `{code,label,label_en}` |
| `quantity` | number | passthrough (could be string) | *(absent)* | `number \| null` |
| `type` discriminator | *(absent)* | *(absent)* | *(absent)* | *(absent)* |

A consumer (model or component) that read `status` could not know whether to expect a string or an
object, and a wrong guess routes the wrong render / the wrong buttons. BUG-06 removes the drift by
introducing a **v2** contract that is uniform across the family, while keeping every v1 card
renderable.

## 2. The v2 envelope (order-lifecycle cards)

Every **v2** order-lifecycle result carries:

- **`schema_version`** — `"webaz.<card>.model.v2"`. Explicit, always present.
- **`type`** — machine discriminator, one of `order_quote | order_draft | order_approval | order_timeline`.
  A consumer routes on `type` **and** `schema_version`; it must never infer the card kind from
  incidental fields.
- **`status`** — **always an object** `{ code, label, label_en }`. Never a bare string in v2.
  - `code` — canonical machine status code (see §4). **Never inferred from the Chinese label.**
  - `label` — human zh label, `label_en` — human en label. Both derived from a single source-of-truth
    meanings map; unknown code falls back to `label = label_en = code` (never crashes).
- **`quantity`** — **positive integer** (`Number.isInteger && > 0 && ≤ MAX_SAFE_INTEGER`) **when
  valid**. A legacy positive-integer string (e.g. `"3"`) is accepted; everything else — negative, zero,
  decimal, overflow, empty, `null`, non-numeric — is projected as an **explicit invalid result**, never
  silently faked to `1`:
  - valid → `{ quantity: <n> }` (no diagnostic field; valid-path bytes unchanged)
  - invalid → `{ quantity: null, quantity_valid: false, quantity_error: <machine code> }`, where
    `quantity_error ∈ missing | empty | zero | negative | not_integer | overflow | non_numeric`
    (zero-PII machine codes only).
  Present on cards that **intrinsically** carry a quantity: `order_quote`, `order_draft`,
  `order_timeline`. See §5 for the approval exception. Producer: `projectQuantity()` in
  `agent-model-projection.ts`.
- **invalid-quantity handling (safety)** — a card with `quantity_valid: false` renders **数量数据异常**
  (never `×1`) and the component **disables every quantity-dependent transaction button** (quote →
  create-draft, draft → submit-approval) so **no quote/draft/order tool call is initiated on corrupt
  data**. The server order-creation path independently validates quantity (G-QTY-1); this is the
  card-side guard. Old v1 cards (no diagnostic field) are validated locally by the component with the
  same rule, so a corrupt legacy quantity also shows 数量数据异常, not `×1`.
- **timestamps** — ISO-8601 **UTC** (`…Z`), via `toIsoUtc()` (BUG-07). No TZ-less strings in v2.
- **`promised_eta`** — preserved **unchanged** as the `webaz.promised_eta.v1` object (BUG-02). In the
  **consumer projection layer** it surfaces only on the order timeline (`logistics.promised_eta`); the
  quote consumer surfaces the frozen ETA via `shipping.estimated_days`, and the draft consumer keeps
  the snapshot on the raw draft/order row (not in the consumer projection). Missing → BUG-02
  `legacy_missing` behavior. BUG-06 does **not** re-version, re-shape, or drop `promised_eta` anywhere.

Everything else (price, amounts, destination region, rail, disclosures, available_actions, refund,
timeline events, promised_eta) is **unchanged** from v1 — v2 is strictly the `type` + `status` +
`quantity` normalization plus the version bump.

## 3. `status` is an object — authoritative amount is NOT the card's quantity

Two safety invariants a consumer relies on:

1. **`status.code` is authoritative; `status.label`/`label_en` are display only.** Button gating and
   state-machine decisions read `status.code`. A component must never re-derive the code by matching
   the Chinese label (labels are localized display text and can change).
2. **The purchase amount is `price.amount_minor` (server-computed), never the card's `quantity`.**
   `quantity` is a display field (`×N`). A malformed/absent quantity therefore cannot change the
   charged amount — the amount is projected independently on the server from the real order/draft
   row. Tests assert this explicitly.
3. **Invalid `quantity` is never silently faked to `1`.** Corrupt machine data surfaces as an explicit
   `quantity_valid: false` + `quantity_error` diagnostic; the card shows 数量数据异常 and disables the
   quantity-dependent transaction buttons — a consumer can neither be misled into thinking the quantity
   is `1` nor proceed to a quote/draft/order on corrupt data.

## 4. Canonical status vocabularies (single source of truth per card)

- **order_quote** — `quoted` (a quote has no order status; v2 emits a uniform `quoted` status for
  shape consistency). Meanings: `quoted → {zh:"报价", en:"quoted"}`.
- **order_draft** — `draft | submitted | cancelled | expired`. Meanings map `DRAFT_STATE_MEANINGS`.
- **order_approval** — `pending | executed | rejected | expired | failed | needs_reconcile`
  (matches `webaz_approval_requests` read-back — no card-private status). Meanings map
  `APPROVAL_STATE_MEANINGS`. The submit response is always `pending`; "待批准" semantics are also
  carried by `passkey_required:true` (P0-C canonical-status decision, unchanged).
- **order_timeline** — the order state-machine codes, via `ORDER_STATE_MEANINGS`
  (`src/layer0-foundation/L0-2-state-machine/transitions.ts`) — the SAME single source the timeline
  already used. No new status vocabulary is introduced for the timeline.

An **unknown** code (not in the card's meanings map) is emitted honestly as
`{code:"<raw>", label:"<raw>", label_en:"<raw>"}` — never dropped, never coerced to another code.

## 5. The approval-card quantity exception (documented, intentional)

`webaz_submit_order_request` projects `request_id / draft_id / status / passkey_required / approval_url`
plus duplicate-protection fields. It carries **no product and no quantity** — the quantity lives on
the referenced `draft_id`. v2 therefore **does not** add a `quantity` to the approval card:

- Fabricating a quantity would require a money-path-adjacent DB read inside the approval projection —
  disallowed this phase (no BUG-08 / no dedup / no money-path change).
- The rule "quantity is a positive integer" is a **presence-typed** rule: *where quantity appears it
  must be a positive integer.* The approval card omits it. This is not the forbidden "string vs
  number mixing" — the field is simply absent, consistently, on every approval card.

The compatibility matrix records approval `quantity` as **n/a (references draft_id)**.

## 6. Backward compatibility (no forced migration)

- **v1 cards remain renderable.** Components branch on `schema_version` and accept **both** the v1
  literal and the v2 value for each card type. A card from an old ChatGPT message (v1: `status`
  string on draft/approval, no `type`) renders exactly as before.
- **Old status strings are normalized once at component entry.** The component computes a status
  *label* and a status *code* one time (`stLabel(s)`, `stCode(s)`): if `s` is an object use
  `s.label` / `s.code`, else treat the string as the code. This normalization does **not** spread
  into the render/branch logic — the rest of the component reads the two locals.
- **Old quantity strings** are converted only in a display adapter with safe-integer validation; a
  decimal / negative / overflow / non-numeric quantity falls back to a safe display and never drives
  the amount.
- **Unknown `schema_version`** → the component shows a consumer-understandable message
  ("不支持此旧卡片版本…请在 WebAZ PWA 查看最新状态") and returns — it never crashes and never mis-renders
  as a different card.
- **Missing `schema_version`** → safe generic "no structured payload visible" fallback (unchanged).
  Server projections always stamp an explicit version; a payload with none is treated as legacy.
- **`promised_eta`** missing → BUG-02 `legacy_missing` (unchanged). Present → rendered as before.

No v1 field is deleted by BUG-06. No DB business data is migrated — v2 is produced entirely in the
output-projection layer (`agent-model-projection.ts`), the preferred compatibility surface.

## 7. Where v2 is produced / consumed

- **Produced** (server, projection layer): `projectQuoteConsumer` / `projectDraftConsumer` /
  `projectSubmitConsumer` / `projectOrderTimelineConsumer` in `src/agent-model-projection.ts`, plus
  the drafts-list wrapper in `server.ts`. The exported `SCHEMA_ORDER_QUOTE/DRAFT/APPROVAL/TIMELINE`
  constants now hold the **v2** value, so `tool-output-schemas.ts` (which imports them) declares v2
  automatically. Legacy `SCHEMA_ORDER_*_V1` constants are retained for reference/tests.
- **Consumed** (component, widget iframe): `QUOTE_APPROVAL_BODY_JS` (quote/draft/approval) and
  `ORDER_TIMELINE_BODY_JS` (timeline + minimal list) in `ui-widgets.ts`. Both accept v1 and v2.
- **`outputSchema`** (`tool-output-schemas.ts`) declares the v2 shape: `type` discriminator,
  `status` as `{code,label,label_en}` object, `quantity` positive integer. `structuredContent`
  emitted by the projections conforms to it (asserted by test).

## 8. Rollback

Pure projection-layer + component change; no schema migration, no money/status/deadline/dedup write.
Reverting the BUG-06 commits restores v1 emission; v2 cards already in chat history still render
because the components keep the v1 branches. See `ROLLBACK_PLAN.md`.
