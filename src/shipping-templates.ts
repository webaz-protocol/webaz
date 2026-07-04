/**
 * 运费模板(PR-2,系列:手动接单/运费/询价)—— 域模块。
 *
 * 模型:卖家按【收货地区】预设运费与预计时效;下单时买家选 ship_to_region,模板命中 → 运费自动
 *   计入订单总额(两轨通用,不改支付时序:escrow 照旧下单锁款,dp 照旧建单进窗/待接单)。
 *   未命中 → 建单拒绝 SHIP_REGION_NOT_COVERED(诚实阻断;PR-3 询价握手将为"模板外地区"提供
 *   先报价后接单的路径)。无模板 = 原行为(不要求 ship_to_region,不加运费)。
 *
 * 结构(JSON 数组,店铺级默认 users.store_shipping_template + 单品覆盖 products.shipping_template):
 *   [{ region: 'CN', fee: 0, est_days: '2-4' }, { region: 'SG', fee: 5 }, { region: '*', fee: 25, est_days: '10-20' }]
 *   - region:大写 code(建议 ISO 3166-1 alpha-2 或平台地区名);'*' = 其余所有地区(通配)。
 *   - fee:与商品价格同单位(escrow=WAZ / direct_p2p=USDC 语境),≥0,整单一口价(v1 不按件数/重量阶梯)。
 *   - est_days:预计时效展示串(≤20 字,可选)。
 *   匹配顺序:精确 region → '*' → 未覆盖。
 *
 * 边界:
 *  - 运费是【下单时快照】进 orders(shipping_fee/ship_to_region/shipping_est_days),卖家改模板不影响在途单。
 *  - 运费并入 total_amount → 沿既有资金/费率/上限口径(escrow 托管额、dp 单笔上限与平台费均按含运费总额;
 *    与保险费同一处理惯例)。不产生独立结算科目 —— v1 刻意不做运费分账。
 *  - est_days 仅记录展示,不接判责钟(改 ship_deadline 语义须单独决策)。
 */
import type Database from 'better-sqlite3'
import type { Response } from 'express'
import { toUnits, type Units } from './money.js'

export interface ShippingTemplateEntry { region: string; fee: number; est_days?: string }
export interface ShippingResolution { covered: boolean; fee: number; est_days: string | null; matched: 'exact' | 'wildcard' | null }

const MAX_ENTRIES = 50
const MAX_REGION_LEN = 16
const MAX_EST_LEN = 20
const MAX_FEE = 1_000_000

/** 规范化地区 code:trim + 大写。空/非串 → null。 */
export function normalizeRegion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const r = raw.trim().toUpperCase()
  if (!r || r.length > MAX_REGION_LEN) return null
  return r
}

/** 校验并规范化模板。null/undefined = 清除模板(合法)。返回 {ok, entries} 或 {ok:false, error}。 */
export function parseShippingTemplate(raw: unknown): { ok: true; entries: ShippingTemplateEntry[] | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, entries: null }
  if (!Array.isArray(raw)) return { ok: false, error: '模板必须是数组' }
  if (raw.length === 0) return { ok: true, entries: null }   // 空数组视同清除
  if (raw.length > MAX_ENTRIES) return { ok: false, error: `模板最多 ${MAX_ENTRIES} 条` }
  const out: ShippingTemplateEntry[] = []
  const seen = new Set<string>()
  for (const e of raw) {
    const region = e && e.region === '*' ? '*' : normalizeRegion(e?.region)
    if (!region) return { ok: false, error: '每条须有合法 region(≤16 字大写 code 或 *)' }
    if (seen.has(region)) return { ok: false, error: `region 重复:${region}` }
    seen.add(region)
    const fee = Number(e?.fee)
    if (!Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) return { ok: false, error: `运费必须是 0~${MAX_FEE} 的数字(${region})` }
    const est = e?.est_days == null ? undefined : String(e.est_days).trim().slice(0, MAX_EST_LEN)
    out.push({ region, fee: Math.round(fee * 100) / 100, ...(est ? { est_days: est } : {}) })
  }
  return { ok: true, entries: out }
}

/** 解析已存 JSON(容错:坏 JSON/坏结构 → null=无模板,不阻断读路径)。 */
export function loadTemplateJson(json: string | null | undefined): ShippingTemplateEntry[] | null {
  if (!json) return null
  try {
    const p = parseShippingTemplate(JSON.parse(json))
    return p.ok ? p.entries : null
  } catch { return null }
}

/** 生效模板:单品覆盖 ?? 店铺默认 ?? null。product 传订单路径已取到的行(含 shipping_template 列)。 */
export function effectiveShippingTemplate(
  db: Database.Database,
  product: { shipping_template?: string | null },
  sellerId: string,
): ShippingTemplateEntry[] | null {
  const own = loadTemplateJson(product.shipping_template)
  if (own) return own
  try {
    const row = db.prepare('SELECT store_shipping_template FROM users WHERE id = ?').get(sellerId) as { store_shipping_template: string | null } | undefined
    return loadTemplateJson(row?.store_shipping_template)
  } catch { return null }
}

/** 按买家地区解析运费:精确 → '*' → 未覆盖。 */
export function resolveShipping(entries: ShippingTemplateEntry[], region: string): ShippingResolution {
  const exact = entries.find(e => e.region === region)
  if (exact) return { covered: true, fee: exact.fee, est_days: exact.est_days ?? null, matched: 'exact' }
  const wild = entries.find(e => e.region === '*')
  if (wild) return { covered: true, fee: wild.fee, est_days: wild.est_days ?? null, matched: 'wildcard' }
  return { covered: false, fee: 0, est_days: null, matched: null }
}

export interface ShippingGateResult { feeU: Units; fee: number; region: string | null; estDays: string | null; quoteRequired: boolean }

/** 询价 opt-in(PR-3):单品 shipping_quote_ok ?? 店铺 store_shipping_quote_ok ?? 关。 */
export function quoteOutsideTemplateOk(db: Database.Database, product: { shipping_quote_ok?: number | null }, sellerId: string): boolean {
  if (product.shipping_quote_ok != null) return Number(product.shipping_quote_ok) === 1
  try {
    const row = db.prepare('SELECT store_shipping_quote_ok FROM users WHERE id = ?').get(sellerId) as { store_shipping_quote_ok: number | null } | undefined
    return Number(row?.store_shipping_quote_ok) === 1
  } catch { return false }
}

/**
 * 建单运费守门(orders-create 单行调用,两轨共用,任何 DB write 之前):
 *  - 无模板:不要求地区(给了就规范化快照),运费 0 —— 原行为。
 *  - 有模板:必须给合法 ship_to_region(否则 400 SHIP_REGION_REQUIRED);命中 → 返回运费(调用方并入总额)。
 *  - 未命中(含无 '*'):卖家开了询价(quoteOutsideTemplateOk)且直付轨 → quoteRequired=true(建单落
 *    pending_accept,卖家先报运费/时效、买家确认新总额才进付款窗 —— PR-3);否则(未开询价 / escrow 轨,
 *    escrow 询价需付款后置钱路手术,PR-5)→ 409 SHIP_REGION_NOT_COVERED。
 * 返回 null = 已写错误响应,调用方直接 return。
 */
export function gateShippingForCreate(
  db: Database.Database, res: Response,
  product: { shipping_template?: string | null; shipping_quote_ok?: number | null }, sellerId: string, rawRegion: unknown,
  rail: 'escrow' | 'direct_p2p' = 'escrow',
): ShippingGateResult | null {
  const region = normalizeRegion(rawRegion)
  const tpl = effectiveShippingTemplate(db, product, sellerId)
  if (!tpl) return { feeU: 0, fee: 0, region, estDays: null, quoteRequired: false }
  if (!region) { res.status(400).json({ error: '该商品按地区计运费,请选择收货国家/地区', error_code: 'SHIP_REGION_REQUIRED' }); return null }
  const r = resolveShipping(tpl, region)
  if (r.covered) return { feeU: toUnits(r.fee), fee: r.fee, region, estDays: r.est_days, quoteRequired: false }
  if (rail === 'direct_p2p' && quoteOutsideTemplateOk(db, product, sellerId)) {
    return { feeU: 0, fee: 0, region, estDays: null, quoteRequired: true }   // 运费待卖家报价,先不入总额
  }
  res.status(409).json({ error: rail === 'direct_p2p' ? '卖家暂不配送到该地区' : '卖家暂不配送到该地区(该商品支持直付询价的话,可改用直付下单)', error_code: 'SHIP_REGION_NOT_COVERED', region })
  return null
}
