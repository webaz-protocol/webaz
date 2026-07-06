/**
 * 可售区域(跨境系列 S1)—— 商家「卖不卖到那里」的机器可判定规则 + 建单硬门。
 *
 * 与运费模板的语义分界(目的地能力四类原因):
 *   - REGION_NOT_FOR_SALE:商家意愿硬拒(本模块)。不提示询价 —— 不卖就是不卖(法规品类/售后成本/授权地域)。
 *   - PRODUCT_RESTRICTED:平台合规 overlay(本模块;protocol_params trade.platform_region_blocklist)。商家不可放宽。
 *   - SHIP_REGION_NOT_COVERED / quote:物流层(shipping-templates.ts,可询价)。
 *   本 gate 跑在运费 gate 之前:意愿/合规先裁,物流后算。
 *
 * 规则形状(products.sale_regions ?? users.store_sale_regions,JSON):
 *   { mode:'list',  include:['SG','MY'] }        → 只卖这些地区
 *   { mode:'all',   exclude:['US'] }             → 全球可卖但排除
 *   NULL / 无规则                                 → 不限(原行为)
 * 层级:平台 overlay > 商品规则 ?? 店铺规则 > 订单快照(S0 的 declarations.sale_regions_rule 槽自动填充)。
 * 既有自由文本 products.ship_regions 仅展示,不进本判定(真相源=结构化列)。
 */
import type Database from 'better-sqlite3'
import type { Response } from 'express'

export interface SaleRegionsRule { mode: 'all' | 'list'; include?: string[]; exclude?: string[] }

const REGION_RE = /^[A-Z0-9-]{2,8}$/

/** parse-don't-validate:坏 JSON/坏形状 → null(= 不限,fail-open 到原行为;写入侧另有严校验)。 */
export function parseSaleRegionsRule(raw: unknown): SaleRegionsRule | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const r = JSON.parse(raw) as SaleRegionsRule
    if (!r || (r.mode !== 'all' && r.mode !== 'list')) return null
    const norm = (a: unknown): string[] | undefined => Array.isArray(a) ? a.map(x => String(x).toUpperCase()).filter(x => REGION_RE.test(x)) : undefined
    return { mode: r.mode, include: norm(r.include), exclude: norm(r.exclude) }
  } catch { return null }
}

/** 写入侧严校验:返回规范化 JSON 串,或 {error}。null/空 = 清除(继承上层)。 */
export function validateSaleRegionsInput(raw: unknown): { json: string | null } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { json: null }
  const r = raw as Record<string, unknown>
  if (typeof r !== 'object' || (r.mode !== 'all' && r.mode !== 'list')) return { error: "sale_regions.mode 必须是 'all' 或 'list'" }
  const norm = (a: unknown, name: string): string[] | { error: string } | undefined => {
    if (a === undefined || a === null) return undefined
    if (!Array.isArray(a) || a.length > 64) return { error: `sale_regions.${name} 须为 ≤64 项数组` }
    const out: string[] = []
    for (const x of a) {
      const code = String(x).trim().toUpperCase()
      if (!REGION_RE.test(code)) return { error: `sale_regions.${name} 含非法地区码:${String(x).slice(0, 12)}(2-8 位大写字母/数字/-)` }
      out.push(code)
    }
    return [...new Set(out)]
  }
  const inc = norm(r.include, 'include'); if (inc && 'error' in (inc as object)) return inc as { error: string }
  const exc = norm(r.exclude, 'exclude'); if (exc && 'error' in (exc as object)) return exc as { error: string }
  if (r.mode === 'list' && (!inc || (inc as string[]).length === 0)) return { error: "mode='list' 时 include 不能为空(否则等于全不可卖 —— 想全不可卖请直接下架)" }
  return { json: JSON.stringify({ mode: r.mode, ...(inc ? { include: inc } : {}), ...(exc ? { exclude: exc } : {}) }) }
}

/** 生效规则:商品 ?? 店铺(与 accept_mode/运费模板同层级约定)。 */
export function effectiveSaleRegionsRule(db: Database.Database, product: { sale_regions?: string | null }, sellerId: string): SaleRegionsRule | null {
  const own = parseSaleRegionsRule(product.sale_regions)
  if (own) return own
  try {
    const row = db.prepare('SELECT store_sale_regions FROM users WHERE id = ?').get(sellerId) as { store_sale_regions: string | null } | undefined
    return parseSaleRegionsRule(row?.store_sale_regions)
  } catch { return null }
}

/**
 * 平台合规名单解析(单一真相源:建单门 gateSaleRegionForCreate + S5 预检 shipping-options 共用)。
 *   坏配置(非 JSON / 非数组)→ { ok:false },由调用方 fail-closed(建单 503;预检 sellable=platform_policy_invalid)。
 *   缺省 '[]' → { ok:true, list:[] }。区码统一大写。
 */
export function parsePlatformBlocklist(raw: unknown): { ok: true; list: string[] } | { ok: false } {
  try {
    const p = JSON.parse(String(raw ?? '[]'))
    if (!Array.isArray(p)) return { ok: false }
    return { ok: true, list: p.map(x => String(x).toUpperCase()) }
  } catch { return { ok: false } }
}

export function regionAllowedByRule(rule: SaleRegionsRule, region: string): boolean {
  const r = region.toUpperCase()
  if (rule.exclude?.includes(r)) return false
  if (rule.mode === 'list') return !!rule.include?.includes(r)
  return true
}

/**
 * 建单可售门(orders-create 单行调用,两轨共用,运费 gate 之前、任何写之前)。
 * 返回 false = 已写错误响应。平台 overlay 先裁(商家规则不可放宽合规);规则存在但买家没给地区 → fail-closed 要求补选。
 */
export function gateSaleRegionForCreate(
  db: Database.Database, res: Response,
  product: { sale_regions?: string | null }, sellerId: string, rawRegion: unknown,
  getProtocolParam: <T>(key: string, fallback: T) => T,
): boolean {
  const region = (typeof rawRegion === 'string' && rawRegion.trim()) ? rawRegion.trim().toUpperCase() : null
  // ① 平台合规 overlay(protocol param,DEFAULT_PARAMS 已 seed '[]';admin PATCH 有 JSON+区码校验)。
  //   坏配置【fail-closed】:合规名单读不懂时放行 = 静默解除平台禁售(审计 P2) —— 宁可挡单也不裸奔;
  //   admin 写入侧已强校验,坏值只可能来自手改 DB,错误信息直接指路。
  const parsedBlock = parsePlatformBlocklist(getProtocolParam<string>('trade.platform_region_blocklist', '[]'))
  if (!parsedBlock.ok) {
    res.status(503).json({ error: '平台合规配置异常,暂无法下单(运营侧需修复 trade.platform_region_blocklist 参数)', error_code: 'PLATFORM_REGION_POLICY_INVALID' })
    return false
  }
  const platformBlock = parsedBlock.list
  const rule = effectiveSaleRegionsRule(db, product, sellerId)
  if (platformBlock.length === 0 && !rule) return true   // 无任何限制 = 原行为(地区可选)
  if (!region) { res.status(400).json({ error: '该商品设有可售地区限制,请选择收货国家/地区', error_code: 'SHIP_REGION_REQUIRED' }); return false }
  if (platformBlock.includes(region)) {
    res.status(409).json({ error: '平台合规限制:该商品暂不支持销售到该地区', error_code: 'PRODUCT_RESTRICTED', region })
    return false
  }
  if (rule && !regionAllowedByRule(rule, region)) {
    res.status(409).json({ error: '卖家未将该地区设为可售范围(与运费无关,不适用询价)', error_code: 'REGION_NOT_FOR_SALE', region })
    return false
  }
  return true
}
