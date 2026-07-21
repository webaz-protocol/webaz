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
export const SCHEMA_ORDER_STATUS = 'webaz.order_status.model.v1'   // list/minimal — NOT bumped by BUG-06 (status stays a bare code string, never mixed within its own version)
// BUG-06 — the four shared order-lifecycle cards move to a unified v2 contract (type + status{code,label,label_en} + positive-int quantity).
// Legacy v1 values are retained so the compatibility matrix + tests can reference the shape old chat messages still carry.
export const SCHEMA_ORDER_QUOTE_V1 = 'webaz.order_quote.model.v1'
export const SCHEMA_ORDER_QUOTE = 'webaz.order_quote.model.v2'

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
  const price = (r.price ?? r.payable_total ?? {}) as Record<string, unknown>
  const disp = typeof price.display === 'string' ? price.display : fmtUsdcMinor(price.amount_minor) || 'n/a'
  const rail = r.payment_rail ?? ((r.payment ?? {}) as Record<string, unknown>).rail ?? 'escrow'
  const tok = typeof r.quote_token === 'string' ? ` quote_token=${r.quote_token} (single-use → webaz_order_draft).` : ''
  return `Quote ${String(r.quote_id ?? '')}: payable ${disp} (${String(rail)} rail), expires ${String(r.expires_at ?? '')}.${tok} Quote only — nothing charged, no stock held. / 仅报价:不扣款、不锁库存。`
}

// ─── MCP Token PR-2 — 按需商品详情投影(webaz.product_detail.model.v1)───────────────────────
// 只经 result_handle 选择集到达(≤5 件/次):比搜索页多 description 摘要/specs/条款,仍是字面键
// allowlist —— 内部字段(hash/回填/commission/source_*)在任何输入行下都构造性不可达。

export const SCHEMA_PRODUCT_DETAIL = 'webaz.product_detail.model.v1'

export const DETAIL_SPECS_MAX_BYTES = 800
export const DETAIL_DESC_MAX_BYTES = 900
export const DETAIL_TERMS_MAX_BYTES = 400   // BUG-01: return_condition / ship_regions 关键交易条款 —— 截断即带 *_truncated 标志 + 全文入口,绝不静默

// B-3(Round1b P0 内部字段隔离):specs 是卖家自由键值,历史上 agent 建品把内部【采购/成本/货源】证据(source_url/
//   source_seller/purchase_unit_price/purchase_total_cost/… 包在 agent_source_evidence / agent_package_evidence)写进了 specs
//   → 买家详情投影原样透传 = 泄露成本与货源。修法在序列化层直接【剔除】这些内部键(不是前端隐藏、不是 [object Object] 兜底):
//   买家可见 specs 永不含内部采购/成本/货源字段名或值。deny 按前缀 + 已知键,合法 specs(多为中文键)不受影响。
const INTERNAL_SPEC_KEY_RE = /^(agent_source|agent_package|agent_sourcing|source_|purchase_|package_unit_spec|package_quantity|package_total_spec|listing_pricing_note|pre_acceptance_checklist|cost_|internal_)/i
/** 从买家可见 specs 剔除内部采购/成本/货源字段。输入可为对象/JSON 字符串/其它;非对象原样返回(下游再处理)。 */
export function sanitizeBuyerSpecs(specs: unknown): unknown {
  if (specs == null) return specs
  let obj: Record<string, unknown> | null = null
  if (typeof specs === 'string') { try { obj = JSON.parse(specs) as Record<string, unknown> } catch { return specs } }
  else if (typeof specs === 'object' && !Array.isArray(specs)) obj = specs as Record<string, unknown>
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return specs
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) { if (INTERNAL_SPEC_KEY_RE.test(k)) continue; out[k] = v }
  return out
}

/** 按 UTF-8 字节封顶(Codex round-2 M-3:预算承诺以字节计,CJK 一字三字节 —— 字符截断守不住)。 */
function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return { text: s, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, ''), truncated: true }
}

/** 边界感知截断(BUG-01 §II.7/§II.8):在 capBytes 之上尽量收在句子/子句边界,既不破坏多字节字符也不半句硬切。 */
function capAtBoundary(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const c = capBytes(s, maxBytes)
  if (!c.truncated) return c
  let cut = c.text
  const BOUND = ['。', '！', '？', '\n', '；', ';', '. ', '! ', '? ', '，', ',']
  let best = -1
  for (const b of BOUND) { const i = cut.lastIndexOf(b); if (i >= 0 && i + b.length > best) best = i + b.length }
  if (best >= Math.floor(cut.length * 0.6)) cut = cut.slice(0, best)   // 只在边界落在后 40% 时收尾,避免过度截短
  return { text: cut, truncated: true }
}

export interface ProductDetailOpts { full?: boolean; resultHandle?: string }

/**
 * BUG-01 — 商品详情投影。两种形态:
 *   full=true  : 关键交易条款(specs / return_condition / ship_regions / 变体)【完整、零截断】,terms_complete=true。
 *   summary(默认): 按字节封顶,但每个被截断的关键字段都显式带 *_truncated 标志,并给出可直接重放的【完整读取入口】
 *                 full_terms_fetch(卡片/模型皆可据此取全)。绝不静默截断关键条款,绝不半句破句。
 */
export function projectProductDetail(p: Record<string, unknown>, opts: ProductDetailOpts = {}): Record<string, unknown> {
  const base = projectProductModel(p)
  const pid = String(p.id ?? (base as { id?: unknown }).id ?? '')
  const desc = typeof p.description === 'string' ? p.description : ''
  let specs: unknown = null
  if (typeof p.specs === 'string' && p.specs) { try { specs = JSON.parse(p.specs) } catch { specs = null } }
  else if (p.specs && typeof p.specs === 'object') specs = p.specs
  specs = sanitizeBuyerSpecs(specs)   // B-3(P0):买家可见 specs 剔除内部采购/成本/货源字段(full + summary 两模式共用此点)
  const rc = p.return_condition == null ? null : String(p.return_condition)
  const sr = p.ship_regions == null ? null : String(p.ship_regions)
  const hasVariants = p.has_variants == null ? null : !!Number(p.has_variants)
  const productType = p.product_type == null ? null : String(p.product_type)
  const fragile = p.fragile == null ? null : !!p.fragile

  // full 模式:完整关键条款(§II.4/§II.6)—— 卡片「查看完整条款」与下单确认据此拿到无损全文。
  if (opts.full === true) {
    return {
      ...base,
      description: desc || null,
      ...(specs != null ? { specs } : {}),
      return_condition: rc,
      ship_regions: sr,
      has_variants: hasVariants,
      product_type: productType,
      fragile,
      terms_complete: true,
    }
  }

  // summary 模式:字节封顶 + 显式截断标志 + 全文入口。
  let specsTruncated = false
  if (specs != null) {
    try { if (Buffer.byteLength(JSON.stringify(specs), 'utf8') > DETAIL_SPECS_MAX_BYTES) { specs = null; specsTruncated = true } } catch { specs = null; specsTruncated = true }
  }
  const descCap = desc ? capBytes(desc, DETAIL_DESC_MAX_BYTES) : { text: '', truncated: false }
  const rcCap = rc == null ? { text: null as string | null, truncated: false } : capAtBoundary(rc, DETAIL_TERMS_MAX_BYTES)
  const srCap = sr == null ? { text: null as string | null, truncated: false } : capAtBoundary(sr, DETAIL_TERMS_MAX_BYTES)
  const anyTrunc = descCap.truncated || specsTruncated || rcCap.truncated || srCap.truncated
  const out: Record<string, unknown> = {
    ...base,
    description: descCap.text || null,
    description_truncated: descCap.truncated,
    ...(specs != null ? { specs } : {}),
    ...(specsTruncated ? { specs_truncated: true } : {}),
    ship_regions: srCap.text,
    ...(srCap.truncated ? { ship_regions_truncated: true } : {}),
    return_condition: rcCap.text,
    ...(rcCap.truncated ? { return_condition_truncated: true } : {}),
    has_variants: hasVariants,
    product_type: productType,
    fragile,
    terms_complete: !anyTrunc,
  }
  if (anyTrunc) {
    // §II.2/§II.3:任一关键字段被截断 → 声明「全文存在」+ 可直接重放的取全动作(卡片 onceGuard 调 webaz_search 即得完整条款)。
    out.full_terms_available = true
    out.full_terms_fetch = pid
      ? { tool: 'webaz_search', description: 'fetch complete, untruncated terms for this product', args: { result_handle: opts.resultHandle ?? null, selected_ids: [pid], full_terms: true } }
      : { note: 'call webaz_search with the originating result_handle + selected_ids=[this id] + full_terms:true' }
  }
  return out
}

// ─── MCP UI PR-5 — QuoteAndApproval 消费者投影(WAZ is never a consumer-facing currency)────────
// quote/draft/approval 三形态的紧凑消费者面(≤350/300/250 tok):USDC 主价 + dest_region 推导的
// 法币估算(带 ≈/estimated/stale,绝不表述为已锁定结算金额)+ 支付轨道诚信文案。协议记账
// (line_items/units/WAZ)保留在路由响应与审批执行层 —— 投影只重塑消费者可见面,不动经济语义。

export const SCHEMA_ORDER_DRAFT_V1 = 'webaz.order_draft.model.v1'
export const SCHEMA_ORDER_DRAFT = 'webaz.order_draft.model.v2'
export const SCHEMA_ORDER_APPROVAL_V1 = 'webaz.order_approval.model.v1'
export const SCHEMA_ORDER_APPROVAL = 'webaz.order_approval.model.v2'

// BUG-06 — status meanings maps (single source per card family). statusView(code, meanings) turns a
// canonical machine code into {code,label,label_en}; an unknown code renders honestly as label=code.
export const DRAFT_STATE_MEANINGS: Record<string, { zh: string; en: string }> = {
  draft: { zh: '草稿', en: 'draft' }, submitted: { zh: '已提交', en: 'submitted' },
  cancelled: { zh: '已取消', en: 'cancelled' }, expired: { zh: '已过期', en: 'expired' },
}
export const APPROVAL_STATE_MEANINGS: Record<string, { zh: string; en: string }> = {
  pending: { zh: '待批准', en: 'pending' }, executed: { zh: '已执行', en: 'executed' },
  rejected: { zh: '已拒绝', en: 'rejected' }, expired: { zh: '已过期', en: 'expired' },
  failed: { zh: '执行失败', en: 'failed' }, needs_reconcile: { zh: '需对账', en: 'needs_reconcile' },
}
const QUOTE_STATE_MEANINGS: Record<string, { zh: string; en: string }> = { quoted: { zh: '报价', en: 'quoted' } }

/** BUG-06 quantity-safety — do NOT silently fake invalid machine data as "quantity 1".
 * A trusted positive safe integer (or a positive-integer legacy string) passes through; anything else
 * (negative / zero / decimal / overflow / empty / null / non-numeric) is projected as an EXPLICIT
 * invalid result: `{ quantity: null, quantity_valid: false, quantity_error: <machine code> }`. The card
 * then shows "数量数据异常" (never ×1) and disables every quantity-dependent transaction button, so no
 * quote/draft/order call is initiated on corrupt data. Valid data is byte-unchanged (no extra field).
 * The charged amount remains `price.amount_minor` (server) — never derived from this field. */
export function projectQuantity(v: unknown): Record<string, unknown> {
  const inv = (code: string): Record<string, unknown> => ({ quantity: null, quantity_valid: false, quantity_error: code })
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return inv('empty')
    if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return inv('non_numeric')
    n = Number(t)
  } else return inv(v == null ? 'missing' : 'non_numeric')
  if (!Number.isFinite(n)) return inv('non_numeric')
  if (!Number.isInteger(n)) return inv('not_integer')
  if (n === 0) return inv('zero')
  if (n < 0) return inv('negative')
  if (n > Number.MAX_SAFE_INTEGER) return inv('overflow')
  return { quantity: n }   // valid → no diagnostic field (valid-path behavior unchanged)
}

const FIAT_SYMBOL: Record<string, string> = { USD: '$', SGD: 'S$', CNY: '¥', EUR: '€', INR: '₹', IDR: 'Rp', MYR: 'RM', PHP: '₱', VND: '₫', THB: '฿' }

export function fmtUsdcMinor(minor: unknown): string {
  const n = Number(minor)
  if (!Number.isFinite(n)) return ''
  const v = n / 1_000_000
  if (v > 0 && v < 0.01) return `${v.toFixed(6).replace(/0+$/, '')} USDC`   // 亚分金额不得显示成 0.00(Codex LOW)
  return `${Number.isInteger(v) ? v : v.toFixed(2)} USDC`
}

/**
 * BUG-07 — normalize a machine timestamp to ISO 8601 UTC (`…Z`). WebAZ SQLite timestamps are stored in UTC
 * (SQLite `datetime('now')`/`CURRENT_TIMESTAMP` = UTC; the seller-age check already appends `Z` to bare
 * values), so a bare `YYYY-MM-DD HH:MM:SS` (or `T`-separated, no offset) is treated as UTC — this is a
 * documented conversion, not a guess. Already-zoned values pass through (re-emitted as canonical `…Z`).
 * A truly unparseable value is returned verbatim (never silently reinterpreted as local time). Display
 * localization stays in the card (`localTime()`); wire values are always UTC-qualified.
 */
export function toIsoUtc(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toISOString() }   // already zoned
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s)                                          // bare SQLite UTC
  if (m) { const d = new Date(`${m[1]}T${m[2]}Z`); return Number.isNaN(d.getTime()) ? s : d.toISOString() }
  const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toISOString()                                            // last resort (still no silent local reinterpret of bare values)
}

export interface FxView { rates?: Record<string, number>; as_of?: string; stale?: boolean }

/** 法币估算(display-only):region → 币种;USD 区或无汇率 → 省略(仍显示 USDC,绝不伪造法币)。 */
export function fiatEstimate(payableMinor: unknown, region: unknown, fx: FxView | null | undefined, regionToCcy: (r: string | null | undefined) => string): Record<string, unknown> | null {
  const n = Number(payableMinor)
  if (!Number.isFinite(n) || !fx?.rates) return null
  const ccy = regionToCcy(region == null ? null : String(region))
  const rate = Number(fx.rates[ccy])
  if (ccy === 'USD' || !Number.isFinite(rate) || rate <= 0) return null
  return {
    currency: ccy,
    display: `≈ ${FIAT_SYMBOL[ccy] ?? ccy}${((n / 1_000_000) * rate).toFixed(2)}`,
    rate, as_of: toIsoUtc(fx.as_of), stale: fx.stale === true, estimated: true,
    note: fx.stale === true ? '按近似(非实时)参考汇率估算,非结算金额' : '按当前参考汇率估算,非结算金额',
  }
}

/** 支付轨道诚信文案(消费者面必须诚实:模拟托管≠真实 USDC 托管;直付=WebAZ 不托管本金)。 */
export function railHonesty(rail: unknown): string {
  return String(rail) === 'direct_p2p'
    ? '买家直接向卖家付款;WebAZ 不托管本金;实际付款方式和币种以确认页面为准'
    : '支付轨道:模拟托管测试 —— 本流程不代表真实 USDC 或法币结算'
}

const lineAmt = (r: Record<string, unknown>, code: string): number => {
  const li = Array.isArray(r.line_items) ? r.line_items as Array<Record<string, unknown>> : []
  return Number(li.find(l => l.code === code)?.amount_minor) || 0
}

/** quote 路由响应 → 消费者投影(目标 ≤350 tok)。 */
export function projectQuoteConsumer(r: Record<string, unknown>, fx: FxView | null, regionToCcy: (x: string | null | undefined) => string): Record<string, unknown> {
  const prod = (r.product ?? {}) as Record<string, unknown>
  const dest = (r.destination ?? {}) as Record<string, unknown>
  const pay = (r.payment ?? {}) as Record<string, unknown>
  const ship = (r.shipping ?? {}) as Record<string, unknown>
  const terms = (r.trade_terms ?? {}) as Record<string, unknown>
  const quotedRaw = ((r.quantity ?? {}) as Record<string, unknown>).quoted   // raw (NOT ||1'd) so a corrupt quote quantity surfaces as invalid, not a faked 1
  const payable = Number(((r.payable_total ?? {}) as Record<string, unknown>).amount_minor)
  const item = lineAmt(r, 'item_subtotal'), shipping = lineAmt(r, 'shipping')
  const other = Math.max(0, payable - item - shipping)
  return {
    schema_version: SCHEMA_ORDER_QUOTE,   // BUG-06 v2: type + unified status object + positive-int quantity
    type: 'order_quote',
    quote_id: r.quote_id,
    status: statusView('quoted', QUOTE_STATE_MEANINGS),   // a quote has no order status; v2 emits a uniform `quoted` for family shape consistency
    ...(typeof r.quote_token === 'string' ? { quote_token: r.quote_token } : { quote_token_note: 'idempotent replay — the single-use token was issued ONLY with the original response: reuse that original quote_token, or wait for expiry (~10 min) and quote again', replay: true }),
    product: { id: prod.product_id, title: prod.title },
    ...projectQuantity(quotedRaw),
    price: { amount_minor: payable, currency: 'USDC', currency_exponent: 6, display: fmtUsdcMinor(payable) },
    ...(fiatEstimate(payable, dest.region, fx, regionToCcy) ? { fiat_estimate: fiatEstimate(payable, dest.region, fx, regionToCcy) } : {}),
    amounts: { item, shipping, other },
    destination: { region: dest.region ?? null, summary: dest.address_summary ?? null },
    shipping: { supported: ship.supported !== false, handling_hours: ship.handling_hours ?? null, estimated_days: ship.estimated_days ?? null },
    return_days: terms.return_days ?? null, warranty_days: terms.warranty_days ?? null,
    payment_rail: pay.rail ?? 'escrow', rail_note: railHonesty(pay.rail),
    stock_reserved: false, economic_action_executed: false,
    expires_at: toIsoUtc(r.expires_at),
    available_actions: typeof r.quote_token === 'string' ? ['create_draft'] : [],   // replay 无 token → 无可执行动作(诚实动作面,Codex H-2)
    disclosures: ['此报价不会扣款', '此报价不会锁定库存', '只有通过 Passkey 批准后才会创建正式订单'],
  }
}

/** draftView → 消费者投影(目标 ≤300 tok)。 */
export function projectDraftConsumer(d: Record<string, unknown>, fx: FxView | null, regionToCcy: (x: string | null | undefined) => string): Record<string, unknown> {
  const prod = (d.product ?? {}) as Record<string, unknown>
  const dest = (d.destination ?? {}) as Record<string, unknown>
  const payable = Number(((d.payable_total ?? d.total ?? {}) as Record<string, unknown>).amount_minor)
  const statusCode = String(d.status ?? '')
  return {
    schema_version: SCHEMA_ORDER_DRAFT,   // BUG-06 v2: type + status object (was a bare string) + positive-int quantity
    type: 'order_draft',
    draft_id: d.draft_id, status: statusView(statusCode, DRAFT_STATE_MEANINGS),
    ...(d.idempotent_replay ? { idempotent_replay: true } : {}), ...(d.already_cancelled ? { already_cancelled: true } : {}),
    product: { id: prod.product_id, title: prod.title },
    ...projectQuantity(d.quantity),
    price: { amount_minor: payable, currency: 'USDC', currency_exponent: 6, display: fmtUsdcMinor(payable) },
    ...(fiatEstimate(payable, dest.region, fx, regionToCcy) ? { fiat_estimate: fiatEstimate(payable, dest.region, fx, regionToCcy) } : {}),
    destination: { region: dest.region ?? null, summary: dest.address_summary ?? null },
    payment_rail: d.payment_rail ?? 'escrow', rail_note: railHonesty(d.payment_rail),
    stock_reserved: false, economic_action_executed: false,
    expires_at: toIsoUtc(d.expires_at),
    available_actions: statusCode === 'draft' ? ['submit_request'] : [],
    disclosures: ['草稿不会扣款、不锁库存,24 小时过期', '提交后需真人 Passkey 批准才创建正式订单'],
  }
}

// BUG-08 §八 —— 每个 duplicate_reason 的精确文案(绝不统一显示"检测到重复")+ available_actions。
const DUPLICATE_REASON_TEXT: Record<string, string> = {
  SAME_DRAFT_REPLAY: '同一草稿重复提交 —— 已复用原审批请求,未创建第二个',
  SAME_IDEMPOTENCY_KEY: '重试命中相同操作键 —— 返回同一结果,未创建第二个',
  ACTIVE_INTENT_REUSED: '你已有一个等价的待审批购买 —— 可打开它,或明确「再买一份」创建独立购买',
  DATABASE_UNIQUE_RACE: '并发提交竞争 —— 已复用先创建的审批,未创建第二个',
  RESPONSE_LOSS_RECONCILED: '上次响应可能丢失 —— 已恢复原审批请求,未重复创建',
}
const DUPLICATE_REASON_ACTIONS: Record<string, string[]> = {
  // 活跃意图复用是唯一给"再买一份"的场景(§四C/§五);其余重复只给打开/查状态。
  ACTIVE_INTENT_REUSED: ['open_existing_approval', 'cancel_current_attempt', 'create_second_purchase'],
  SAME_DRAFT_REPLAY: ['open_existing_approval', 'check_status'],
  SAME_IDEMPOTENCY_KEY: ['open_existing_approval', 'check_status'],
  DATABASE_UNIQUE_RACE: ['open_existing_approval', 'check_status'],
  RESPONSE_LOSS_RECONCILED: ['open_existing_approval', 'check_status'],
}

/** submit 路由响应 → 审批消费者投影(目标 ≤250 tok;BUG-08:机器可读 duplicate_reason + 精确动作面)。 */
export function projectSubmitConsumer(r: Record<string, unknown>): Record<string, unknown> {
  const idem = (r.idempotency ?? {}) as Record<string, unknown>
  const dup = idem.duplicate === true
  const reason = typeof idem.duplicate_reason === 'string' ? idem.duplicate_reason : null
  const dupOf = idem.duplicate_of != null ? String(idem.duplicate_of) : (dup ? String(r.request_id) : null)
  const actions = dup ? (reason && DUPLICATE_REASON_ACTIONS[reason] ? DUPLICATE_REASON_ACTIONS[reason] : ['open_existing_approval', 'check_status']) : ['open_approval', 'check_status_via_webaz_approval_requests']
  return {
    schema_version: SCHEMA_ORDER_APPROVAL,   // BUG-06 v2: type + status object (was the bare string 'pending'); quantity is n/a (references draft_id — documented in SCHEMA_V2_CONTRACT §5)
    type: 'order_approval',
    request_id: r.request_id, draft_id: r.draft_id,
    action_type: 'order_create', status: statusView('pending', APPROVAL_STATE_MEANINGS),   // P0-C canonical status 统一:与 webaz_approval_requests 读回一致(pending/executed/rejected/expired/failed/needs_reconcile);"待批准"语义由 passkey_required:true 表达,不再用独有的 pending_approval
    passkey_required: true,
    // rail-aware 中性措辞(Codex H-3):submit 响应不携轨道,绝不硬编码"资金会移动"——直付下 WebAZ 不托管本金
    on_approval: 'creates the single real order; payment behavior follows the disclosed rail (escrow: wallet→escrow debit at creation; direct_p2p: WebAZ holds no principal — buyer pays the seller directly)',
    approval_url: r.approval_url,
    ...(idem.purchase_intent_instance != null ? { purchase_intent_instance: String(idem.purchase_intent_instance) } : {}),
    // BUG-08 §一:重购目标 —— 组件"再买一份"用它重新报价(product_id + quantity;地址/价格由服务器重校验)。
    ...((r.reorder as Record<string, unknown>)?.product_id ? { reorder: { product_id: String((r.reorder as Record<string, unknown>).product_id), quantity: Number((r.reorder as Record<string, unknown>).quantity) } } : {}),
    // BUG-08 §八:机器可读重复合同(旧客户端只读 duplicate 布尔仍工作)。duplicate_warning 保留为向后兼容展示。
    ...(dup ? {
      duplicate: true,
      duplicate_reason: reason ?? 'ACTIVE_INTENT_REUSED',
      duplicate_of: dupOf,
      existing_request_id: dupOf,
      duplicate_warning: { note: (reason && DUPLICATE_REASON_TEXT[reason]) || '检测到相似购买请求 —— 已复用现有待审批请求,未创建第二个审批/订单', existing_request_id: dupOf, reason: reason ?? null },
    } : {}),
    available_actions: actions,
    disclosures: ['提交不会执行 —— 只有真人 Passkey 批准才创建唯一正式订单(重试/重复批准返回同一订单)'],
  }
}

/** BUG-06: summaries run on the PROJECTED result, whose status is now a v2 object {code,label,label_en}
 * (was a bare string). Read the code from either shape so the text summary never renders "[object Object]". */
export function statusText(s: unknown): string { return (s && typeof s === 'object') ? String((s as Record<string, unknown>).code ?? (s as Record<string, unknown>).label ?? '') : String(s ?? '') }

/** BUG-06 quantity-safety in the text summary — `content` can enter the model context AND is the
 * card-less-host fallback text. A valid projected quantity renders `×N`; an invalid one (quantity_valid
 * === false / null) renders `数量数据异常`, NEVER `×null` — so a corrupt quantity is never handed to the
 * model to misread or summarize as a real number. */
export function quantityText(r: Record<string, unknown>): string {
  return (r.quantity_valid === false || typeof r.quantity !== 'number') ? '数量数据异常' : '×' + r.quantity
}

export function summarizeDraftResult(r: Record<string, unknown>): string {
  if (Array.isArray(r.drafts)) return `${Number(r.count) || (r.drafts as unknown[]).length} draft(s): ${(r.drafts as Array<Record<string, unknown>>).map(d => `${d.draft_id}=${statusText(d.status)}`).join(', ')}. Details in structuredContent.`
  const p = (r.price ?? {}) as Record<string, unknown>
  return `Draft ${r.draft_id} (${statusText(r.status)}): ${(r.product as Record<string, unknown>)?.title ?? ''} ${quantityText(r)} ${p.display ?? ''}. Not charged, no stock held; expires ${r.expires_at}. Next: webaz_submit_order_request(draft_id). / 草稿不扣款不锁库存。`
}

export function summarizeSubmitResult(r: Record<string, unknown>): string {
  const dup = r.duplicate === true ? ' REUSED an existing pending request (similar-purchase protection — no second approval/order created).' : ''
  return `Approval request ${r.request_id} pending human Passkey.${dup} Open: ${r.approval_url} — submit does NOT execute; only the Passkey approval creates the single real order. / 提交不执行,Passkey 批准才建单。`
}

// ─── MCP UI PR-6 — OrderTimeline 消费者投影(webaz.order_timeline.model.v1)─────────────────────
// full 视图 → 履约时间线消费者面:状态标签走 ORDER_STATE_MEANINGS 单源;USDC 主价 + fiat_estimate
// (诚实标注:无下单时法币快照,估算按当前参考汇率);退款 rail-aware(直付=协议记录责任结果,
// 本金未由 WebAZ 托管,实际退款需买卖双方完成);deadline 只给 iso,本地时区显示由组件端完成。
import { ORDER_STATE_MEANINGS } from './layer0-foundation/L0-2-state-machine/transitions.js'

export const SCHEMA_ORDER_TIMELINE_V1 = 'webaz.order_timeline.model.v1'
export const SCHEMA_ORDER_TIMELINE = 'webaz.order_timeline.model.v2'   // BUG-06: type + positive-int quantity (status already an object)

export function statusView(code: unknown, meanings: Record<string, { zh: string; en: string }> = ORDER_STATE_MEANINGS as Record<string, { zh: string; en: string }>): Record<string, unknown> {
  const c = String(code ?? '')
  const m = meanings[c]
  return { code: c, label: m?.zh ?? c, label_en: m?.en ?? c }
}

export function projectOrderTimelineConsumer(r: Record<string, unknown>, fx: FxView | null, regionToCcy: (x: string | null | undefined) => string): Record<string, unknown> {
  const o = (r.order ?? {}) as Record<string, unknown>
  const logi = (r.logistics ?? {}) as Record<string, unknown>
  const refund = (r.refund_status ?? {}) as Record<string, unknown>
  const rail = String(o.payment_rail ?? 'escrow')
  const amountMinor = Number(o.amount) ? Math.round(Number(o.amount) * 1_000_000) : null
  const returns = Array.isArray(refund.return_requests) ? refund.return_requests as Array<Record<string, unknown>> : []
  const railBadge = rail === 'direct_p2p' ? '直付(WebAZ 不托管本金)' : '模拟托管测试订单 — 不代表真实 USDC 或法币托管'
  return {
    schema_version: SCHEMA_ORDER_TIMELINE,   // BUG-06 v2: add type; quantity coerced to a positive integer (was `?? null`); status already an object
    type: 'order_timeline',
    order_id: o.order_id,
    // 卖家可控字符串必封顶:防超预算 + 防超长文本注入模型可见面
    product: { id: o.item_ref, title: typeof (o as Record<string, unknown>).product_title === 'string' ? capBytes(String((o as Record<string, unknown>).product_title), 200).text : null },
    ...projectQuantity(o.quantity),
    price: { amount_minor: amountMinor, currency: 'USDC', currency_exponent: 6, display: fmtUsdcMinor(amountMinor) },
    ...(fiatEstimate(amountMinor, logi.dest_region, fx, regionToCcy) ? { fiat_estimate: fiatEstimate(amountMinor, logi.dest_region, fx, regionToCcy) } : {}),
    status: statusView(o.status),
    next_actor: o.next_actor ?? null,
    deadline: o.deadline ? { iso: toIsoUtc(o.deadline), note: 'render in the viewer local timezone' } : null,
    payment_rail: rail, rail_badge: railBadge,
    ...(r.incremental ? { incremental: r.incremental } : {}),
    timeline: (Array.isArray(r.timeline) ? r.timeline as Array<Record<string, unknown>> : []).map(t => ({
      from: t.from ?? null, to_status: statusView(t.to), actor: t.actor_role ?? null, at: toIsoUtc(t.at),
    })),
    logistics: { dest_region: logi.dest_region ?? null, tracking: logi.tracking ?? null, shipping_est_days: logi.shipping_est_days ?? null, promised_eta: logi.promised_eta ?? null },   // BUG-02:promised(下单承诺)+ shipping_est_days(logistics)分列
    // 无退货时字段缺席(非 null):buyer_orders 豁免 stripEmpty,null 会被 schema 校验型宿主拒收
    ...(returns.length ? { refund: {
      requests: returns.map(x => ({ status: x.status, amount: { display: fmtUsdcMinor(Number(x.refund_amount) ? Math.round(Number(x.refund_amount) * 1_000_000) : null) }, created_at: toIsoUtc(x.created_at), resolved_at: toIsoUtc(x.resolved_at) })),
      is_real_funds_flow: false,
      note: rail === 'direct_p2p'
        ? '协议已记录责任结果;本金未由 WebAZ 托管;实际退款需由买卖双方完成'
        : '模拟托管轨:退款按争议/退货结果从模拟托管释放,不代表真实 USDC 或法币资金流',
    } } : {}),
    available_actions: Array.isArray(r.available_actions) ? (r.available_actions as Array<Record<string, unknown>>).map(a => ({ action: a.action, executor: a.executor })) : [],
    actions_note: '服务器权威动作面 — 人类动作在 webaz.xyz 订单页完成(高风险动作需 Passkey)',
  }
}

export function summarizeOrderTimeline(r: Record<string, unknown>): string {
  const st = (r.status ?? {}) as Record<string, unknown>
  const p = (r.price ?? {}) as Record<string, unknown>
  return `Order ${r.order_id}: ${st.label ?? st.code} (${p.display ?? ''}${r.next_actor ? `, next: ${r.next_actor}` : ''}). Timeline ${Array.isArray(r.timeline) ? (r.timeline as unknown[]).length : 0} event(s). Details in structuredContent. / 订单 ${st.label ?? ''}。`
}
