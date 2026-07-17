/**
 * 跨境交易条款快照(S0 骨架)—— 下单时冻结「以什么条款成交」,商家事后改设置不影响旧订单。
 *
 * 为什么存在:争议/清关/仲裁需要「下单那一刻的条款」作书面依据 —— 运费从哪来(模板命中/人工报价)、
 *   时效/退货承诺、清关字段、税责声明。此前各要素散落(shipping_fee/accept_mode_snapshot/…)且
 *   退货/清关/税责完全无快照;此模块聚合为 orders.trade_terms_snapshot 单一 JSON(v 版本化,只增不改)。
 *
 * 层级(平台 > 店铺 > 商品[=单链接] > 订单快照):本模块读「商品 ?? 店铺」生效值;平台 overlay(合规区域)
 *   由各 gate 在建单时另行裁决,本模块只记录结果。S0 刻意不消费 sale_regions/tax_lines(列已建、API 未开
 *   —— 不上假开关);S1/S3 开放后快照槽位自动填充。
 *
 * 铁律:钱路零参与 —— 快照是证据,不是计价输入;写入失败不阻断建单(fail-soft,缺快照=pre-S0 订单同待遇)。
 */
import type Database from 'better-sqlite3'

export interface TradeTermsSnapshot {
  v: 1
  captured_at: string
  shipping: {
    source: 'template' | 'quote_pending' | 'quote' | 'none'
    region: string | null
    fee: number | null
    est_days: string | null
    free_threshold_applied?: boolean   // S2 满额免邮命中(争议对账:0 运费是免出来的不是没设)
  }
  fulfilment: {
    handling_hours: number | null
    estimated_days: string | null
    return_days: number | null
    return_condition: string | null
    warranty_days: number | null
    source_read?: boolean   // RFC-026:true=商品行确实被读到(null 字段=权威 SQL NULL);缺失=历史快照/降级采集,null 不可信
  }
  logistics: {
    weight_kg: number | null
    package_size: string | null
    origin_country: string | null
    country_of_origin: string | null
    customs_description: string | null
    hs_code: string | null
  }
  declarations: {
    ship_regions_text: string | null          // 既有自由文本声明(展示用;机器规则见 sale_regions_rule)
    sale_regions_rule: unknown | null          // S1 起填充(生效规则快照)
    tax_lines: unknown | null                  // S3 起填充
    import_duty_terms: 'ddu' | 'ddp' | null    // S3 起填充(跨境进口税责)
  }
  accept_mode: string | null
}

/** 组装快照(读商品行 + 店铺兜底;shipping 由建单 gate 结果传入 —— 不重算,记录裁决结果)。 */
export function buildTradeTermsSnapshot(db: Database.Database, args: {
  productId: string
  sellerId: string
  shipping: { source: TradeTermsSnapshot['shipping']['source']; region: string | null; fee: number | null; estDays: string | null; freeThresholdApplied?: boolean }
  acceptModeEffective: string | null
}): TradeTermsSnapshot {
  // fail-soft 读:缺列(裸测试库/schema 漂移)→ 降级为空槽快照,绝不让证据采集炸掉建单
  let p: Record<string, unknown> | undefined; let u: Record<string, unknown> | undefined
  try {
    p = db.prepare(`SELECT handling_hours, estimated_days, return_days, return_condition, warranty_days,
      weight_kg, package_size, origin_country, country_of_origin, customs_description, hs_code,
      ship_regions, sale_regions, tax_lines, import_duty_terms FROM products WHERE id = ?`).get(args.productId) as Record<string, unknown> | undefined
    u = db.prepare('SELECT store_sale_regions, store_tax_lines, store_import_duty_terms FROM users WHERE id = ?')
      .get(args.sellerId) as Record<string, unknown> | undefined
  } catch { /* 空槽降级 */ }
  const parse = (x: unknown): unknown | null => { if (typeof x !== 'string' || !x) return null; try { return JSON.parse(x) } catch { return null } }
  const numOrNull = (x: unknown): number | null => (x === null || x === undefined || x === '' ? null : Number(x))
  const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
  const duty = strOrNull(p?.import_duty_terms) ?? strOrNull(u?.store_import_duty_terms)
  return {
    v: 1,
    captured_at: new Date().toISOString(),
    shipping: { source: args.shipping.source, region: args.shipping.region, fee: args.shipping.fee, est_days: args.shipping.estDays, ...(args.shipping.freeThresholdApplied ? { free_threshold_applied: true } : {}) },
    fulfilment: {
      handling_hours: numOrNull(p?.handling_hours), estimated_days: strOrNull(p?.estimated_days),
      return_days: numOrNull(p?.return_days), return_condition: strOrNull(p?.return_condition), warranty_days: numOrNull(p?.warranty_days),
      ...(p !== undefined ? { source_read: true } : {}),   // 降级采集(catch/缺行)不打标 → null 不当权威用
    },
    logistics: {
      weight_kg: numOrNull(p?.weight_kg), package_size: strOrNull(p?.package_size),
      origin_country: strOrNull(p?.origin_country), country_of_origin: strOrNull(p?.country_of_origin),
      customs_description: strOrNull(p?.customs_description), hs_code: strOrNull(p?.hs_code),
    },
    declarations: {
      ship_regions_text: strOrNull(p?.ship_regions),
      sale_regions_rule: parse(p?.sale_regions) ?? parse(u?.store_sale_regions),
      tax_lines: parse(p?.tax_lines) ?? parse(u?.store_tax_lines),
      import_duty_terms: duty === 'ddu' || duty === 'ddp' ? duty : null,
    },
    accept_mode: args.acceptModeEffective,
  }
}

/** 写快照(fail-soft:任何异常吞掉不阻断建单 —— 快照缺失=pre-S0 订单同待遇,消费方须容错)。 */
export function writeTradeTermsSnapshot(db: Database.Database, orderId: string, snap: TradeTermsSnapshot): void {
  try { db.prepare('UPDATE orders SET trade_terms_snapshot = ? WHERE id = ?').run(JSON.stringify(snap), orderId) } catch { /* fail-soft */ }
}

/** 询价确认后补记运费裁决(quote_pending → quote;只动 shipping 槽,其余条款保持下单时冻结值)。 */
export function updateSnapshotShippingQuote(db: Database.Database, orderId: string, fee: number, estDays: string | null): void {
  try {
    const row = db.prepare('SELECT trade_terms_snapshot FROM orders WHERE id = ?').get(orderId) as { trade_terms_snapshot: string | null } | undefined
    if (!row?.trade_terms_snapshot) return
    const snap = JSON.parse(row.trade_terms_snapshot) as TradeTermsSnapshot
    snap.shipping = { ...snap.shipping, source: 'quote', fee, est_days: estDays }
    db.prepare('UPDATE orders SET trade_terms_snapshot = ? WHERE id = ?').run(JSON.stringify(snap), orderId)
  } catch { /* fail-soft */ }
}

/** parse-don't-validate 读取(DTO/争议消费方用;坏 JSON/缺失 → null)。 */
export function readTradeTermsSnapshot(raw: unknown): TradeTermsSnapshot | null {
  if (typeof raw !== 'string' || !raw) return null
  try { const s = JSON.parse(raw) as TradeTermsSnapshot; return s && s.v === 1 ? s : null } catch { return null }
}

/**
 * 生效退货天数(RFC-026 归一,S0 不变量的执行面):快照存在且结构可用 → 【精确按快照】
 * (terms-as-sold:商家事后改设置对旧订单既不收紧也不放宽);pre-S0/残缺快照 → 回退现商品行。
 * returns 路由与 agent 订单全量视图共用此函数 —— 单一真相源,防谓词漂移。
 */
export function effectiveReturnDays(snapshotRaw: unknown, liveProductReturnDays: unknown): { days: number; source: 'order_snapshot' | 'live_listing' } {
  const snap = readTradeTermsSnapshot(snapshotRaw)
  const f = snap && typeof snap.fulfilment === 'object' && snap.fulfilment !== null ? snap.fulfilment : null
  if (f && typeof f.return_days === 'number' && Number.isFinite(f.return_days)) {
    return { days: f.return_days, source: 'order_snapshot' }
  }
  // null 双义消解(Codex BLOCKER):source_read=true 的 null = 权威"成交时不可退"→ 0;
  // 历史快照/降级采集的 null 不可信 → 回退活行(宁可对真不可退的旧单放宽,绝不因采集故障剥夺真实窗口)。
  if (f && f.return_days === null && f.source_read === true) {
    return { days: 0, source: 'order_snapshot' }
  }
  const live = Number(liveProductReturnDays || 0)
  return { days: Number.isFinite(live) ? live : 0, source: 'live_listing' }
}
