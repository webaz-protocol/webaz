/**
 * MCP Token PR-1 — 版本化 output schema(structuredContent 的形状契约)。
 *
 * 只覆盖三条核心购物读链路(search / buyer_orders / quote)。刻意保持【紧凑 + 宽松】:
 *   - 描述顶层决策形状与 schema_version,不逐字段穷举(outputSchema 会随 tools/list 全量下发,
 *     每一字节所有客户端都要付 —— schema 本身也在 Token 预算内);
 *   - 不设 additionalProperties:false(错误响应 error/error_code/recovery 字段与后续 v1.x 增量
 *     字段不应导致客户端校验硬失败;版本演进靠 schema_version,不靠封死属性)。
 * 每个 schema 同时容纳成功形状与结构化错误形状(error/error_code)—— 工具声明 outputSchema 后,
 * 成功与失败路径都返回 structuredContent(MCP 规范:声明了 outputSchema 的工具必须返回结构化结果)。
 */
import { SCHEMA_PRODUCT_SEARCH, SCHEMA_PRODUCT_DETAIL, SCHEMA_ORDER_STATUS, SCHEMA_ORDER_QUOTE, SCHEMA_ORDER_DRAFT, SCHEMA_ORDER_APPROVAL, SCHEMA_ORDER_TIMELINE } from '../../agent-model-projection.js'

const productMoney = { type: 'object', description: 'product price: amount_minor / currency USDC / display (display line only; fx table gives display-only local conversions)' }
const protocolMoney = { type: 'object', description: 'protocol-recorded integer money: amount_minor / currency / currency_exponent / display' }
// BUG-06 v2 shared fragments — status is ALWAYS an object {code,label,label_en}; quantity is a positive integer.
const statusObject = { type: 'object', description: 'BUG-06 v2 unified status: {code (canonical machine code — never inferred from label), label (zh), label_en}' }
// BUG-06 quantity safety: a positive integer when valid; null when the machine data is invalid (never faked to 1).
const posIntQty = { type: ['integer', 'null'], minimum: 1, description: 'positive integer when valid, null when invalid (see quantity_valid/quantity_error); display-only — the charged amount is price.amount_minor, never derived from quantity' }
const qtyValid = { type: 'boolean', description: 'BUG-06: present and false ONLY when quantity is invalid machine data — the card shows 数量数据异常 and disables quantity-dependent transaction buttons (absent = valid)' }
const qtyError = { type: 'string', description: 'BUG-06 machine-readable invalid-quantity code (zero-PII): missing|empty|zero|negative|not_integer|overflow|non_numeric' }
const err = {
  error: { type: 'string', description: 'present ONLY on failure (with error_code + structured recovery fields)' },
  error_code: { type: 'string' },
}

export const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  webaz_search: {
    type: 'object',
    description: `${SCHEMA_PRODUCT_SEARCH} (search/browse) OR ${SCHEMA_PRODUCT_DETAIL} (detail-fetch via result_handle) — model projection: decision fields only (no raw DB rows, no internal hashes/scores, no images)`,
    properties: {
      schema_version: { type: 'string', enum: [SCHEMA_PRODUCT_SEARCH, SCHEMA_PRODUCT_DETAIL] },
      count: { type: 'number', description: 'products returned in this page' },
      next_cursor: { type: 'string', description: 'present when more results exist — pass back as cursor' },
      sellers: { type: 'object', description: 'deduped seller summaries keyed by seller id (products[].seller_ref)' },
      fx: { type: 'object', description: 'USD-base display-only conversion rates ({rates, as_of}) for "≈ local currency" hints — NEVER a settlement path' },
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            price: productMoney,
            stock_status: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
            handling_hours: { type: 'number' }, return_days: { type: 'number' }, warranty_days: { type: 'number' },
            seller_ref: { type: 'string' }, sales_count: { type: 'number' },
            decision_flags: { type: 'array', description: 'server-asserted risk/advantage FACTS: {code, severity, label}' },
            summary: { type: 'string', description: 'one-line decision hint' },
          },
        },
      },
      recovery: { type: 'object', description: 'on 0 hits: labeled catalog sample (NOT query matches) + actionable next_step' },
      result_handle: { type: 'string', description: 'selection handle (10-min TTL) — pass back with selected_ids (≤5) for live detail projections (webaz.product_detail.model.v1: description/specs/terms)' },
      detail_required_for_card: { type: 'boolean', description: 'fetch detail (result_handle + selected_ids from selectable_ids) before a full card; selection_required + detail_fetch_template also ride the response' },
      ...err,
    },
  },
  webaz_buyer_orders: {
    type: 'object',
    description: `${SCHEMA_ORDER_STATUS} (list/minimal/up_to_date) OR ${SCHEMA_ORDER_TIMELINE} (full single-order timeline: status labels, USDC price + display-only fiat estimate, rail-honest refund state, server-authoritative actions) — zero PII`,
    properties: {
      schema_version: { type: 'string', enum: [SCHEMA_ORDER_STATUS, SCHEMA_ORDER_TIMELINE] },
      type: { type: 'string', description: 'BUG-06 v2 discriminator on the full timeline form: "order_timeline" (absent on the minimal order_status list)' },
      quantity: posIntQty, quantity_valid: qtyValid, quantity_error: qtyError,
      timeline: { type: 'array', description: 'full form: {from, to_status{code,label}, actor, at} events' },
      refund: { type: 'object', description: 'rail-honest refund state; ABSENT when the order has no return requests (direct_p2p: WebAZ holds no principal — protocol records outcomes only)' },
      rail_badge: { type: 'string' }, status: { description: 'timeline (v2) form: {code, label, label_en} object; up_to_date (order_status v1) form: raw status code string' },
      summary: { type: 'object', description: 'whole-account counts: total / active / awaiting_you / disputed / completed / cancelled / other_terminal' },
      count: { type: 'number' }, total_count: { type: 'number' },
      next_cursor: { type: 'string', description: 'present when older orders exist — pass back as cursor' },
      orders: { type: 'array', description: 'minimal 7-key projection: order_id / status / next_actor / deadline / amount / item_ref / payment_rail' },
      order: { type: 'object', description: 'single-order form (order_id arg): same 7-key projection' },
      up_to_date: { type: 'boolean', description: 'full+updated_since: true = nothing changed, full view omitted (tiny response)' },
      incremental: { type: 'object', description: 'full+updated_since with changes: {since, timeline_new} — timeline holds ONLY newer entries' },
      ...err,
    },
  },
  webaz_quote_order: {
    type: 'object',
    description: `${SCHEMA_ORDER_QUOTE} — consumer quote projection: USDC price + display-only fiat estimate, region-only destination, rail-honesty note. Quote only — nothing charged, no stock held`,
    properties: {
      schema_version: { type: 'string', const: SCHEMA_ORDER_QUOTE },
      type: { type: 'string', const: 'order_quote' }, status: statusObject,
      quote_id: { type: 'string' }, quote_token: { type: 'string', description: 'single-use, 10-min TTL — pass to webaz_order_draft' },
      product: { type: 'object', description: '{id, title}' }, quantity: posIntQty, quantity_valid: qtyValid, quantity_error: qtyError,
      price: productMoney,
      fiat_estimate: { type: 'object', description: 'display-only local-fiat estimate {currency, display ≈…, rate, as_of, stale, estimated:true} — NEVER a locked settlement amount; omitted when unavailable (USDC still shown)' },
      amounts: { type: 'object', description: 'integer minor breakdown {item, shipping, other}' },
      destination: { type: 'object', description: 'region tag + masked summary only — full address never returned' },
      shipping: { type: 'object' }, return_days: { type: 'number' }, warranty_days: { type: 'number' },
      payment_rail: { type: 'string' }, rail_note: { type: 'string', description: 'honesty note: simulated escrow ≠ real USDC custody; direct_p2p = WebAZ holds no principal' },
      expires_at: { type: 'string' },
      stock_reserved: { type: 'boolean', const: false },
      economic_action_executed: { type: 'boolean', const: false },
      available_actions: { type: 'array' }, disclosures: { type: 'array' },
      ...err,
    },
  },
  webaz_order_draft: {
    type: 'object',
    description: `${SCHEMA_ORDER_DRAFT} — consumer draft projection (single or {count,drafts[]}): frozen snapshot, nothing charged, no stock held, 24h expiry`,
    properties: {
      schema_version: { type: 'string', const: SCHEMA_ORDER_DRAFT },
      type: { type: 'string', const: 'order_draft' }, status: statusObject,
      draft_id: { type: 'string' },
      product: { type: 'object' }, quantity: posIntQty, quantity_valid: qtyValid, quantity_error: qtyError,
      price: productMoney,
      fiat_estimate: { type: 'object', description: 'display-only ≈ local fiat (see quote schema)' },
      destination: { type: 'object' }, payment_rail: { type: 'string' }, rail_note: { type: 'string' },
      expires_at: { type: 'string' },
      drafts: { type: 'array', description: 'list form: compact draft projections' }, count: { type: 'number' },
      available_actions: { type: 'array' }, disclosures: { type: 'array' },
      ...err,
    },
  },
  webaz_submit_order_request: {
    type: 'object',
    description: `${SCHEMA_ORDER_APPROVAL} — approval submit projection: pending human Passkey; submit NEVER executes; duplicate-purchase protection surfaces an explicit warning`,
    properties: {
      schema_version: { type: 'string', const: SCHEMA_ORDER_APPROVAL },
      type: { type: 'string', const: 'order_approval' },
      request_id: { type: 'string' }, draft_id: { type: 'string' },
      action_type: { type: 'string', const: 'order_create' }, status: statusObject,   // BUG-06 v2: {code:'pending',label,label_en} object (was the bare string 'pending'); quantity n/a (references draft_id)
      passkey_required: { type: 'boolean', const: true },
      on_approval: { type: 'string', description: 'rail-aware neutral wording: approval creates the single order; payment behavior follows the disclosed rail (direct_p2p: WebAZ holds no principal)' },
      approval_url: { type: 'string' },
      duplicate: { type: 'boolean' }, duplicate_warning: { type: 'object', description: 'similar-purchase protection: existing request REUSED, no second approval/order' },
      available_actions: { type: 'array' }, disclosures: { type: 'array' },
      ...err,
    },
  },
}

/** 把 outputSchema 合并进工具描述符(与 annotateTools / withSecuritySchemes 同一条组装链)。 */
export function withOutputSchemas<T extends { name: string }>(tools: T[]): Array<T & { outputSchema?: Record<string, unknown> }> {
  return tools.map(t => (OUTPUT_SCHEMAS[t.name] ? { ...t, outputSchema: OUTPUT_SCHEMAS[t.name] } : t))
}
