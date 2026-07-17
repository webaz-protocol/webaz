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
import { SCHEMA_PRODUCT_SEARCH, SCHEMA_ORDER_STATUS, SCHEMA_ORDER_QUOTE } from '../../agent-model-projection.js'

const money = { type: 'object', description: 'integer money: amount_minor / currency / currency_exponent / display' }
const err = {
  error: { type: 'string', description: 'present ONLY on failure (with error_code + structured recovery fields)' },
  error_code: { type: 'string' },
}

export const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  webaz_search: {
    type: 'object',
    description: `${SCHEMA_PRODUCT_SEARCH} — model projection: decision fields only (no raw DB rows, no internal hashes/scores, no images)`,
    properties: {
      schema_version: { type: 'string', const: SCHEMA_PRODUCT_SEARCH },
      count: { type: 'number', description: 'products returned in this page' },
      next_cursor: { type: 'string', description: 'present when more results exist — pass back as cursor' },
      sellers: { type: 'object', description: 'deduped seller summaries keyed by seller id (products[].seller_ref)' },
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            price: money,
            stock_status: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
            handling_hours: { type: 'number' }, return_days: { type: 'number' }, warranty_days: { type: 'number' },
            seller_ref: { type: 'string' }, sales_count: { type: 'number' },
            decision_flags: { type: 'array', description: 'server-asserted risk/advantage FACTS: {code, severity, label}' },
            summary: { type: 'string', description: 'one-line decision hint' },
          },
        },
      },
      recovery: { type: 'object', description: 'on 0 hits: labeled catalog sample (NOT query matches) + actionable next_step' },
      ...err,
    },
  },
  webaz_buyer_orders: {
    type: 'object',
    description: `${SCHEMA_ORDER_STATUS} — buyer orders: account summary + active-first page of 7-key minimal orders (zero PII)`,
    properties: {
      schema_version: { type: 'string', const: SCHEMA_ORDER_STATUS },
      summary: { type: 'object', description: 'whole-account counts: total / active / awaiting_you / disputed / completed / cancelled / other_terminal' },
      count: { type: 'number' }, total_count: { type: 'number' },
      next_cursor: { type: 'string', description: 'present when older orders exist — pass back as cursor' },
      orders: { type: 'array', description: 'minimal 7-key projection: order_id / status / next_actor / deadline / amount / item_ref / payment_rail' },
      order: { type: 'object', description: 'single-order form (order_id arg): same 7-key projection' },
      ...err,
    },
  },
  webaz_quote_order: {
    type: 'object',
    description: `${SCHEMA_ORDER_QUOTE} — server-authoritative quote: integer line items, masked ids, region-only destination. Quote only — nothing charged, no stock held`,
    properties: {
      schema_version: { type: 'string', const: SCHEMA_ORDER_QUOTE },
      quote_id: { type: 'string' }, quote_token: { type: 'string', description: 'single-use, 10-min TTL — pass to webaz_order_draft' },
      line_items: { type: 'array', description: 'integer money lines: item_subtotal / shipping / protocol_fee / discount / donation / estimated_tax' },
      total: money, payable_total: money,
      payment: { type: 'object', description: 'rail semantics (escrow custodied vs direct_p2p off-protocol)' },
      destination: { type: 'object', description: 'region tag + summary only — full address never returned' },
      expires_at: { type: 'string' },
      stock_reserved: { type: 'boolean', const: false },
      economic_action_executed: { type: 'boolean', const: false },
      ...err,
    },
  },
}

/** 把 outputSchema 合并进工具描述符(与 annotateTools / withSecuritySchemes 同一条组装链)。 */
export function withOutputSchemas<T extends { name: string }>(tools: T[]): Array<T & { outputSchema?: Record<string, unknown> }> {
  return tools.map(t => (OUTPUT_SCHEMAS[t.name] ? { ...t, outputSchema: OUTPUT_SCHEMAS[t.name] } : t))
}
