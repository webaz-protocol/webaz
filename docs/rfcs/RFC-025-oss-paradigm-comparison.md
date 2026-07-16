# RFC-025 Appendix A — OSS Paradigm Comparison: Agent-native Buyer Experience

> Pre-work report #1 for RFC-025 (Agent-native Buyer Experience). Per the standing
> discipline, every major WebAZ block is compared against Medusa / Saleor / Sylius /
> Spree BEFORE construction, in the fixed 5-part format below. This report informs
> schema and seam design only — WebAZ borrows data-model boundaries and state-machine
> paradigms, never runtimes, large dependencies, or anything that bypasses the
> Passkey/disclosure trust layer.
>
> 开工前对照报告(固定 5 部分:类型/借鉴点/不能搬/最小 PR 切法/风险)。只借数据模型
> 边界与状态机范式,不借 runtime,不借任何绕过 Passkey/披露层的实现。

Status: report (non-normative) · Date: 2026-07-16 · Companion: RFC-025 audit & gap analysis

---

## 1. 类型 / Block type

**Buyer checkout & order lifecycle over an agent channel** — a hybrid block:

- **Generic e-commerce infrastructure** (quote computation, order staging/draft,
  order state visibility, after-sales intake): mature paradigms exist in all four
  reference projects → *borrow the shapes*.
- **WebAZ trust layer** (OAuth grant subject binding, Passkey approve-to-execute,
  human-gate on irreversible actions, disclosure honesty, demand-signal privacy):
  *no OSS analogue — self-built*, extending RFC-020/021/023 machinery.

The agent-facing surface (MCP tools + intent-shaped inputSchema) has **no analogue
in any of the four** — they all assume a human driving a web checkout. That part is
designed from our own RFC-021/022/023 precedents, not from OSS.

## 2. 借鉴点 / What we borrow

### Medusa (TypeScript, headless)

| Paradigm | What it is | How WebAZ uses it |
|---|---|---|
| **Cart as server-computed staging object** | Cart holds line items; totals are recomputed server-side on every mutation; client never assembles the final amount | Our `quote` is exactly this, minus long-lived statefulness: server computes item price + shipping snapshot + total; the agent **never** sums money (matches RFC-014 money-integer discipline) |
| **Draft Order** | Admin-created order that exists before payment; converts to a real order via an explicit completion step | Our `order draft`: exists, reserves nothing irreversibly, converts only via human Passkey approval. Medusa's "convert" step maps to our `submit_order_request → approve_url → Passkey` |
| **Payment Sessions (provider seam)** | Rail-agnostic provider interface; authorize vs capture split | Validates our `payment_rail` selection seam (escrow / direct_p2p) living on the quote/draft, chosen before commitment, executed by existing rails untouched |
| **Idempotent completion** | Completing a cart twice yields the same order | Our draft→submit must carry an idempotency key; duplicate submits return the same `request_id` |

### Saleor (Python, GraphQL)

| Paradigm | What it is | How WebAZ uses it |
|---|---|---|
| **Checkout token + revalidation at complete** | Checkout is a TTL'd token; on `checkoutComplete` the server re-validates price/stock/shipping and errors on drift | Direct blueprint for `quote_token` + `expires_at` + **hard-fail on drift** at approval time (with one crucial inversion — see §5 risk R3) |
| **Product / Variant carries price+stock** | Variants are the sellable unit; each carries its own price and stock | We already have `has_variants`; the buyer chain must treat **variant as the quotable unit**, not the product. We deliberately do NOT borrow the canonical-Product/ChannelListing catalog layer (premature at current catalog depth — see RFC-025 audit) |
| **Machine-readable field-level error codes** | Every mutation returns typed `{field, code}` errors | Blueprint for RFC-025 §error-recovery: `error_code + missing_requirements + next_steps + retryable` on every buyer endpoint |

### Sylius (PHP, Symfony)

| Paradigm | What it is | How WebAZ uses it |
|---|---|---|
| **Separated state machines** | Order, payment, and shipment run distinct state machines instead of one overloaded status | Confirms our existing order-status machine should NOT absorb quote/draft states — quote and draft get their own tiny lifecycles (`active/expired/consumed`, `draft/submitted/approved/cancelled/expired`), orders stay untouched |
| **Order processors pipeline** | Total = ordered pipeline of processors (items → promotions → shipping → taxes), each a pure step | Blueprint for quote computation as a small pure pipeline (base price → variant delta → shipping template → fees), unit-testable per step, single writer of the total |

### Spree (Ruby)

| Paradigm | What it is | How WebAZ uses it |
|---|---|---|
| **Guarded checkout progression** | cart → address → delivery → payment → confirm; `advance` refuses until the current step's requirements are met | Blueprint for readiness gating: quote requires resolved variant + region; draft requires live quote; submit requires draft + address ref. Each step returns *what's missing* instead of guessing (= certainty-over-coverage) |
| **Adjustments as auditable line entries** | Fees/discounts are discrete, labeled adjustments summing to the total | Matches RFC-014: quote returns labeled integer components (`item_units + shipping_units + fee_units = total_units`), never an opaque total |

## 3. 不能搬 / What we must NOT port

1. **Any silent re-pricing.** Saleor/Spree recalculate the cart when prices change.
   WebAZ rule (RFC-025 invariant): terms shown to the human are the terms executed —
   drift ⇒ hard-fail + fresh quote, never silent update.
2. **Payment capture flows.** All four capture money inside the checkout. WebAZ money
   moves only through existing rails (escrow settlement / direct_p2p handshake) behind
   Passkey; the buyer chain stops at *approved order*, it never touches funds.
3. **Tax engines.** Saleor/Spree compute taxes. WebAZ tax posture is seller-declared
   disclosure (S0–S6 series; S6 real tax rail deferred). Quotes display seller-declared
   values with provenance labels — the server does not compute tax.
4. **Canonical product catalogs / channels.** Saleor's Product↔ChannelListing and any
   cross-seller canonical-product layer are premature: today 1 listing = 1 seller offer.
   Comparison happens at listing+variant level with honest `variant_differences` labels.
5. **Long-lived carts.** Medusa/Sylius carts persist indefinitely. Agent conversations
   are ephemeral; we use TTL-bound quotes and short-lived drafts, no cart GC problem.
6. **Their runtimes/dependency trees.** No Medusa modules, no GraphQL layer, no Symfony
   workflow, no Rails engine. SQLite + existing seam files only.
7. **Anything that weakens the human gate.** No OSS project has an approve-to-execute
   human gate; nothing they do may dilute RFC-021 semantics (agent submits, human
   Passkey executes, execute unreachable to agents).
8. **Guest checkout / anonymous carts.** All four support it; WebAZ buyer chain is
   grant-bound to one accountable human (one grant = one subject) by design.

## 4. 最小 PR 切法 / Minimal PR slicing (paradigm-informed)

Order confirmed with Holden (2026-07-16), paradigm mapping per PR:

| # | PR | Borrowed paradigm |
|---|---|---|
| 0 | Reports (this doc + audit/gap) | — |
| 1 | `webaz_buyer_orders` / `webaz_buyer_order_detail` (OAuth read) | none new — RFC-021 grant-read precedent; Sylius "separate machines" says: read projection only, no state change |
| 2 | `webaz_discover` + `demand_signals` (internal, append-only) | no OSS analogue (they don't capture unmet demand); Saleor field-error codes for honest `no_candidates`. 语义:有结果输出结果,没结果记录,形成商机 |
| 3 | Quote (`webaz_quote_order`, extends existing price-session) | Sylius processor pipeline + Spree labeled adjustments + Saleor TTL token |
| 4 | Draft (activates dead `draft_order` capability) | Medusa Draft Order semantics (exists-before-commitment, idempotent, cancellable) |
| 5 | Submit + Passkey approval page | Medusa "complete" + Saleor revalidate-at-complete, executed through RFC-021 approve-to-execute (self-built) |
| 6 | Buyer after-sales action requests + case prep | Spree guarded progression for evidence readiness; reuses unified action-request model |
| 7+ | Demand-signal public aggregation (gated), watchlist, RFQ hooks | deferred until mechanism + privacy thresholds mature |

Each PR: single responsibility, schema + scope + audit + idempotency + tests, never
falls back OAuth→api_key, never touches "one grant = one subject".

## 5. 风险 / Risks

- **R1 — Cart-statefulness creep.** Borrowing Medusa/Sylius shapes tempts a persistent
  cart. Mitigation: quote TTL ≤ existing price-session TTL; drafts expire; no "resume
  my cart" surface.
- **R2 — Money-shape drift.** OSS models use floats/decimals. Every borrowed schema
  field carrying money must be `*_units` integers via money.ts/ledger.ts (RFC-014);
  reviewer checklist item on PRs 3–5.
- **R3 — Silent-reprice habit (inverted borrow).** Saleor's revalidation *updates* the
  checkout; ours must *reject*. Test must assert drift ⇒ `quote_expired`/`price_changed`
  hard error, never a mutated total.
- **R4 — Catalog over-modeling.** Someone "completes" the canonical-product layer
  because Saleor has it. Gate: no canonical table until real multi-seller-same-product
  exists in production.
- **R5 — demand_signals privacy.** New PII-adjacent surface with no OSS precedent.
  Internal/admin-only first; public aggregation is a separate gated PR with
  aggregation-threshold ≥N + no per-buyer exposure (leaderboard-anon discipline applies).
- **R6 — Tool-surface bloat.** Four frameworks' breadth invites 20 endpoints. Cap:
  the 6 PRs above; anything else is demand-triggered.
