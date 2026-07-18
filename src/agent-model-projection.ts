/**
 * MCP Token 优化 PR-1 — Model Projection(模型可见最小决策数据,webaz.*.model.v1)。
 *
 * 三层数据模型的第一层:模型只看到做购买决策所需的字段。本模块是 search / buyer_orders / quote 三条
 * 链路的【投影单一真相源】,被两端复用:
 *   - src/pwa/routes/products-list.ts(mode=agent 分支)—— 网络路径(生产 /api/products?mode=agent)
 *   - src/layer1-agent/L1-1-mcp-server/server.ts(handleSearch 本地路径 + 三工具 structuredContent 包装)
 *
 * 纪律(与 agent-order-minimal-view.ts 同强度):输出对象【字面键构造】,绝不 spread 数据行 ——
 * 因此 commitment_hash / price_hash / metrics_backfilled_at / commission_rate / source_url 等内部字段
 * 在任何输入行下都不可能进入模型上下文(allowlist 构造,非 denylist 剥离)。
 * decision_flags 只给【可验证的事实性标签】(新卖家/无成交/有败诉),绝不产出"最值得买"式营销结论。
 */
import { toUnits } from './money.js'

export const SCHEMA_PRODUCT_SEARCH = 'webaz.product_search.model.v1'
export const SCHEMA_ORDER_STATUS = 'webaz.order_status.model.v1'
export const SCHEMA_ORDER_QUOTE = 'webaz.order_quote.model.v1'

/** 递归剥离 null / undefined / 空数组 / 空对象(0 与 false 与 '' 保留 —— 语义值不动)。 */
export function stripEmpty(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(stripEmpty).filter(x => x !== undefined)
    return arr
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = stripEmpty(val)
      if (s === undefined || s === null) continue
      if (Array.isArray(s) && s.length === 0) continue
      if (typeof s === 'object' && !Array.isArray(s) && Object.keys(s as object).length === 0) continue
      out[k] = s
    }
    return out
  }
  return v === null ? undefined : v
}

export interface DecisionFlag { code: string; severity: 'info' | 'warning'; label: string }

/** 服务端事实性决策标签(§15:风险事实由服务器给,推荐判断留给模型)。 */
export function productDecisionFlags(p: Record<string, unknown>): DecisionFlag[] {
  const flags: DecisionFlag[] = []
  const sellerCreated = p.seller_created_at ? new Date(String(p.seller_created_at).replace(' ', 'T') + 'Z').getTime() : NaN
  if (Number.isFinite(sellerCreated) && Date.now() - sellerCreated <= 90 * 86400_000) {
    flags.push({ code: 'NEW_SELLER', severity: 'info', label: '新卖家(≤90 天)' })
  }
  const sales = Number(p.sales_count ?? p.completion_count) || 0
  if (sales === 0) flags.push({ code: 'NO_SALES_HISTORY', severity: 'warning', label: '暂无成交记录' })
  const disputeLosses = Number(p.dispute_loss_count) || 0
  if (disputeLosses > 0) flags.push({ code: 'DISPUTE_LOSSES', severity: 'warning', label: `卖家有 ${disputeLosses} 次争议败诉` })
  const stock = Number(p.stock)
  if (Number.isFinite(stock) && stock > 0 && stock <= 3) flags.push({ code: 'LOW_STOCK', severity: 'info', label: '库存少' })
  if (p.fragile) flags.push({ code: 'FRAGILE', severity: 'info', label: '易碎品' })
  if (Number(p.trial_quota_remaining) > 0) flags.push({ code: 'TRIAL_AVAILABLE', severity: 'info', label: '有测评免单名额' })
  return flags.slice(0, 4)
}

/**
 * 单商品 Model Projection(目标 ≤ ~350B/件)。输入是已 enrich 的行(含 seller_name / sales_count /
 * agent_summary / estimated_days 已解析等);输出【字面键】,与输入行解耦。
 */
export function projectProductModel(p: Record<string, unknown>): Record<string, unknown> {
  const price = Number(p.price) || 0
  const stock = Number(p.stock) || 0
  let amountMinor: number | null = null
  try { amountMinor = toUnits(price) } catch { amountMinor = null }
  const summaryRaw = typeof p.agent_summary === 'string' ? p.agent_summary : ''
  return {
    id: String(p.id ?? ''),
    title: String(p.title ?? '').slice(0, 90),
    // 显示线 = USDC(与 PWA priceCurrency 一致,1:1 对齐,display-only —— 绝非结算/托管承诺;协议记账仍 WAZ)
    price: { amount_minor: amountMinor, currency: 'USDC', currency_exponent: 6, display: `${price} USDC` },
    stock_status: stock <= 0 ? 'out_of_stock' : stock <= 3 ? 'low_stock' : 'in_stock',
    category: p.category == null ? null : String(p.category),
    handling_hours: p.handling_hours == null ? null : Number(p.handling_hours),
    estimated_days: p.estimated_days ?? null,
    return_days: p.return_days == null ? null : Number(p.return_days),
    warranty_days: p.warranty_days == null ? null : Number(p.warranty_days),
    seller_ref: p.seller_id == null ? null : String(p.seller_id),
    sales_count: Number(p.sales_count ?? p.completion_count) || 0,
    decision_flags: productDecisionFlags(p),
    summary: summaryRaw ? summaryRaw.slice(0, 140) : null,
  }
}

/** 卖家去重表:同批商品同卖家时,卖家摘要只出现一次(products[].seller_ref 引用)。 */
export function sellersIndex(rows: Array<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const r of rows) {
    const id = r.seller_id == null ? '' : String(r.seller_id)
    if (!id || out[id]) continue
    out[id] = {
      name: r.seller_name == null ? null : String(r.seller_name),
      level: String(r.rep_level ?? r._rep_level ?? 'new'),
      rep_points: Number(r.rep_points ?? r._rep_points) || 0,
    }
  }
  return out
}

// ─── content 降级摘要(§4:一两句话;不支持 structuredContent 的客户端看这个 + PWA 链接)───────────

const displayRange = (products: Array<Record<string, unknown>>): string => {
  const nums = products.map(p => Number((p.price as Record<string, unknown> | undefined)?.display ? String((p.price as Record<string, unknown>).display).split(' ')[0] : NaN)).filter(Number.isFinite)
  if (!nums.length) return ''
  const lo = Math.min(...nums), hi = Math.max(...nums)
  return lo === hi ? ` (${lo} USDC)` : ` (${lo}–${hi} USDC)`
}

// 降级摘要契约(Codex round-1 BLOCKER-1):text 必须携带【可行动最小集】—— 只读 content 的纯文本
// 客户端要能继续走 search→verify/place 与 quote→draft→submit,所以 id / next_cursor / quote_token
// 必须出现在摘要里;其余细节仍只在 structuredContent(不复制整个 JSON)。

export function summarizeSearchResult(r: Record<string, unknown>): string {
  const products = Array.isArray(r.products) ? r.products as Array<Record<string, unknown>> : []
  if (!products.length) {
    return 'No exact match (strict match by full title/SKU — by design). See structuredContent.recovery for a labeled catalog sample + next step. / 精确匹配 0 命中,详见 recovery。'
  }
  const items = products.map(p => `${String(p.id)} ${String((p.price as Record<string, unknown> | undefined)?.display ?? '')}`.trim()).join(' | ')
  const more = r.next_cursor ? ` next_cursor=${String(r.next_cursor)}` : ''
  return `Found ${products.length}${displayRange(products)}: ${items}.${more} Details in structuredContent. / 明细见结构化结果。`
}

export function summarizeBuyerOrders(r: Record<string, unknown>): string {
  if (r.up_to_date) {
    return `Order ${String(r.order_id)} unchanged (status ${String(r.status)}) since your updated_since — nothing new. / 无新变化。`
  }
  if (r.order) {
    const o = r.order as Record<string, unknown>
    return `Order ${o.order_id}: ${o.status}${o.next_actor ? `, next actor ${o.next_actor}` : ''}. / 订单状态 ${o.status}。`
  }
  const s = (r.summary ?? {}) as Record<string, unknown>
  const orders = Array.isArray(r.orders) ? r.orders as Array<Record<string, unknown>> : []
  const total = Number(s.total ?? r.count) || 0
  const parts = [`${Number(s.active) || 0} active`]
  if (Number(s.awaiting_you)) parts.push(`${Number(s.awaiting_you)} awaiting you`)
  if (Number(s.disputed)) parts.push(`${Number(s.disputed)} disputed`)
  const list = orders.map(o => `${String(o.order_id)}=${String(o.status)}`).join(', ')
  const more = r.next_cursor ? ` next_cursor=${String(r.next_cursor)}` : ''
  return `${total} buyer order(s) (${parts.join(', ')}): ${list}.${more} Details in structuredContent. / 明细见结构化结果。`
}

export function summarizeQuoteResult(r: Record<string, unknown>): string {
  const payable = (r.payable_total ?? {}) as Record<string, unknown>
  const amt = Number(payable.amount_minor)
  const disp = Number.isFinite(amt) ? `${amt / 1_000_000} WAZ` : 'n/a'
  const rail = ((r.payment ?? {}) as Record<string, unknown>).rail ?? 'escrow'
  const tok = typeof r.quote_token === 'string' ? ` quote_token=${r.quote_token} (single-use → webaz_order_draft).` : ''
  return `Quote ${String(r.quote_id ?? '')}: payable ${disp} (${String(rail)} rail), expires ${String(r.expires_at ?? '')}.${tok} Quote only — nothing charged, no stock held. / 仅报价:不扣款、不锁库存。`
}

// ─── MCP Token PR-2 — 按需商品详情投影(webaz.product_detail.model.v1)───────────────────────
// 只经 result_handle 选择集到达(≤5 件/次):比搜索页多 description 摘要/specs/条款,仍是字面键
// allowlist —— 内部字段(hash/回填/commission/source_*)在任何输入行下都构造性不可达。

export const SCHEMA_PRODUCT_DETAIL = 'webaz.product_detail.model.v1'

export const DETAIL_SPECS_MAX_BYTES = 800
export const DETAIL_DESC_MAX_BYTES = 900

/** 按 UTF-8 字节封顶(Codex round-2 M-3:预算承诺以字节计,CJK 一字三字节 —— 字符截断守不住)。 */
function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return { text: s, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, ''), truncated: true }
}

export function projectProductDetail(p: Record<string, unknown>): Record<string, unknown> {
  const base = projectProductModel(p)
  const desc = typeof p.description === 'string' ? p.description : ''
  let specs: unknown = null
  if (typeof p.specs === 'string' && p.specs) { try { specs = JSON.parse(p.specs) } catch { specs = null } }
  else if (p.specs && typeof p.specs === 'object') specs = p.specs
  // 卖家可控字段全部按【字节】封顶:超大/深嵌套 specs 整体省略(键都不出现)+ specs_truncated 标记
  //   (完整规格在 PWA 商品页;后续 UI Projection 层承接)。
  let specsTruncated = false
  if (specs != null) {
    try { if (Buffer.byteLength(JSON.stringify(specs), 'utf8') > DETAIL_SPECS_MAX_BYTES) { specs = null; specsTruncated = true } } catch { specs = null; specsTruncated = true }
  }
  const descCap = desc ? capBytes(desc, DETAIL_DESC_MAX_BYTES) : { text: '', truncated: false }
  return {
    ...base,
    description: descCap.text || null,
    description_truncated: descCap.truncated,
    ...(specs != null ? { specs } : {}),
    ...(specsTruncated ? { specs_truncated: true } : {}),
    ship_regions: p.ship_regions == null ? null : capBytes(String(p.ship_regions), 200).text,
    return_condition: p.return_condition == null ? null : capBytes(String(p.return_condition), 200).text,
    fragile: p.fragile == null ? null : !!p.fragile,
  }
}
