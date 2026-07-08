/**
 * RFC-021 §6a — 最小化订单读投影(seller_orders_read_minimal)。
 *
 * ALLOWLIST 投影:输出对象由【字面六键】构造,绝不 spread order 行。因此 PII(shipping_address / notes /
 * gift_recipient_name / gift_recipient_phone / recipient_code / 买家名)在【任何输入行下】都不可能出现在输出 ——
 * 这是 I6 的最强保证(不靠 denylist 剥离,靠 allowlist 构造)。调用方另只 SELECT 非 PII 列,PII 连取都不取。
 *
 * next_actor / deadline 复用既有状态机计算(与人类订单视图同源,不 drift):
 *   next_actor = CURRENT_RESPONSIBLE[status](self-fulfill 用 CURRENT_RESPONSIBLE_SELF_FULFILL)
 *   deadline   = getActiveDeadline(order).deadline
 *
 * PR-B(dest_country,第 7 键):粗粒度目的地【国家级】,让 agent 在 accept 前判断货源能否发到买家所在国。
 *   来源【只用结构化列 ship_to_region】(schema 注明"结构化,非自由文本地址"),且【白名单归一为 2 字母国家码 shape
 *   (ISO 3166-1 alpha-2)】—— '*'/次国家级分区(如 SG-CHANGI)/城市名/脏值/多字母平台区名一律 null,绝不过度
 *   声称"国家"、绝不透出比国家更细的信息(dim3 粒度红线 + dim2 脏值白名单校验)。
 *   【绝不解析 shipping_address 自由文本】—— 保持 allowlist 构造(不碰 detail/门牌/邮编),I6 不退化。
 *   一级行政区(dest_region)/邮编前缀(dest_postal_prefix)【故意不做】:数据模型无结构化省/邮编列,只在自由文本
 *   detail 里,解析=违 allowlist 原则 + 稀疏区反推风险 → 需先上游结构化改造,不在本 PR。
 * 无任何执行/写入;完整地址揭示(after_accept)仍未实现,本 PR 不引入。
 */
import type Database from 'better-sqlite3'
import { getActiveDeadline } from '../layer0-foundation/L0-2-state-machine/engine.js'
import { CURRENT_RESPONSIBLE, CURRENT_RESPONSIBLE_SELF_FULFILL } from '../layer0-foundation/L0-2-state-machine/transitions.js'

export interface MinimalSellerOrderView {
  order_id: string
  status: string
  next_actor: string | null   // 当前责任方(currentResponsible)
  deadline: string | null     // 当前活跃截止(getActiveDeadline().deadline)
  amount: number | null       // total_amount
  item_ref: string | null     // product_id
  dest_country: string | null // 目的地国家码(结构化 ship_to_region 归一为 ISO 3166-1 alpha-2 shape;非 2 字母国家码 → null)。绝不含街道/门牌/邮编/次国家级
}

/** 调用方须只 SELECT 非 PII 列:id, status, total_amount, product_id, logistics_id, 及各 *_deadline 列。 */
export function minimalSellerOrderView(order: Record<string, unknown>, db?: Database.Database): MinimalSellerOrderView {
  const status = String(order.status ?? '')
  const isSelfFulfill = !order.logistics_id
  const table = (isSelfFulfill ? CURRENT_RESPONSIBLE_SELF_FULFILL : CURRENT_RESPONSIBLE) as Record<string, string>
  let deadline: string | null = null
  try { deadline = getActiveDeadline(order as never, db)?.deadline ?? null } catch { deadline = null }
  return {
    order_id: String(order.id ?? ''),
    status,
    next_actor: table[status] ?? null,
    deadline,
    amount: order.total_amount == null ? null : Number(order.total_amount),
    item_ref: order.product_id == null ? null : String(order.product_id),
    // 只取结构化 ship_to_region,且【必须是 2 字母国家码 shape(ISO 3166-1 alpha-2)】:'*'/次国家级分区(SG-CHANGI)/
    //   城市名/脏值/多字母平台区名一律 null。不解析 shipping_address 自由文本(守 allowlist)。2 字母 shape 足以挡住
    //   一切"比国家更细"的值(次国家级必然更长/带分隔符);不引入 ~250 条 ISO 全表(2 字母非国家码非粒度泄漏,过度工程)。
    dest_country: (() => { const r = order.ship_to_region == null ? '' : String(order.ship_to_region).trim().toUpperCase(); return /^[A-Z]{2}$/.test(r) ? r : null })(),
  }
}

/** 最小化读只取这些【非 PII】列(供路由 SELECT + 测试断言 SELECT 不含 PII)。 */
export const MINIMAL_ORDER_COLUMNS = [
  'id', 'status', 'total_amount', 'product_id', 'logistics_id',
  'pending_accept_deadline', 'pay_deadline', 'accept_deadline', 'ship_deadline',
  'pickup_deadline', 'delivery_deadline', 'confirm_deadline',
  'ship_to_region',   // PR-B 粗粒度目的地(结构化列,schema 注明"非自由文本地址")→ dest_country
] as const
