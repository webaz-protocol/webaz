/**
 * A1 — strict ACP 商品 feed 导出(RFC-015;口径 = Holden 2026-07-23 拍板)。
 *
 * 与 /.well-known/webaz-acp-feed.json(发现投影,全商品+WAZ 标价+逐条非合规声明)不同,本模块产出
 * 【严格按 OpenAI ACP file-upload products spec】的导出物,供批准后经 SFTP 提交。诚实三门:
 *
 *   1. 【只含可真实成交的商品】:卖家必须通过 Rail 1 全套门禁(readDirectPayLaunchReadiness
 *      ready=true:全局开放 + KYB + 制裁 + AML + 保证金/缓交 + 收款说明 + 未暂停)。
 *      不可真实购买的商品绝不进 strict feed —— 宁可少投,不投「点进来买不了」的坑。
 *   2. 【价格 = USD 表示的 USDC 结算值】:ACP 强制 ISO 4217,USDC 非 ISO 币种;USDC 1:1 锚定 USD,
 *      USD 表示零汇率漂移(商品真值计价即 USDC)。WAZ 标价经 live waz_usdc_rate 换算,绝不写死 1:1。
 *      目标地区法币(如 SGD)是换算参考价,在商品落地页展示,不进 price 字段。
 *   3. 【必填字段缺失 = 整条剔除】:image_url(公网可加载)与 target_countries(可如实推导)是 spec
 *      必填;推导不出就剔除该商品并计数,绝不用假值凑合规。
 *
 * is_eligible_checkout 恒 false(ACP checkout = 卡+PSP,未接;RFC-015 P2 门控不变)。
 * 本模块【纯读】:不写任何表,不碰钱路。
 */
import type Database from 'better-sqlite3'
import { readDirectPayLaunchReadiness } from '../direct-pay-launch-readiness.js'
import { resolveImageUrl, targetCountries } from './acp-feed.js'
import { effectiveSaleRegionsRule } from '../sale-regions.js'

const BASE = 'https://webaz.xyz'

function plainText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

interface StrictRow {
  id: string; title: string; description: string; price: number; stock: number
  category: string | null; images: string | null; brand: string | null; model: string | null
  product_type: string | null; seller_id: string; seller_name: string | null; sale_regions: string | null
}

export interface StrictAcpExport {
  ok: boolean
  reason?: string                       // ok=false 时:全局门未开(fail-closed,绝不带病导出)
  items: Array<Record<string, unknown>>
  stats: {
    products_scanned: number
    sellers_scanned: number
    sellers_ready: number
    excluded_seller_not_ready: number   // 卖家未过 Rail 1 门禁 → 整店剔除
    excluded_no_image: number           // 无公网可加载图片(spec 必填)
    excluded_no_target_countries: number // 推导不出 ISO 目标国(spec 必填)
    waz_usdc_rate: number
  }
}

export function buildStrictAcpExport(
  db: Database.Database,
  args: { getProtocolParam: <T>(key: string, fallback: T) => T; limit?: number },
): StrictAcpExport {
  const { getProtocolParam } = args
  const limit = Math.min(Math.max(args.limit ?? 5000, 1), 100_000)

  // waz_usdc_rate = 「1 USDC 兑多少 WAZ」(server.ts wazToUsdc 同语义):usd = waz / rate。
  const rate = Number(getProtocolParam<number>('waz_usdc_rate', 1.0))
  const emptyStats = (n = 0): StrictAcpExport['stats'] => ({
    products_scanned: n, sellers_scanned: 0, sellers_ready: 0,
    excluded_seller_not_ready: 0, excluded_no_image: 0, excluded_no_target_countries: 0, waz_usdc_rate: rate,
  })
  if (!(Number.isFinite(rate) && rate > 0)) return { ok: false, reason: 'waz_usdc_rate 非法(<=0)——拒绝导出错误价格', items: [], stats: emptyStats() }

  // 全局门:平台侧 Rail 1 未开放 → 整体 fail-closed(空导出 + 原因),绝不投「无法成交」的 feed。
  const globalReadiness = readDirectPayLaunchReadiness(db, { getProtocolParam })
  if (!globalReadiness.ready) {
    return { ok: false, reason: `Direct Pay 全局未就绪:${globalReadiness.blockers.join(',')}`, items: [], stats: emptyStats() }
  }

  const rows = db.prepare(`
    SELECT p.id, p.title, p.description, p.price, p.stock, p.category, p.images, p.brand, p.model,
           p.product_type, p.seller_id, u.name AS seller_name, p.sale_regions
    FROM products p
    LEFT JOIN users u ON u.id = p.seller_id
    WHERE p.status = 'active'
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(limit) as StrictRow[]

  const stats = emptyStats(rows.length)

  // 卖家门禁按 seller 记忆化(逐商品重算是纯浪费,门禁是账号级事实)。
  const sellerReady = new Map<string, boolean>()
  const isSellerReady = (sellerId: string): boolean => {
    if (!sellerReady.has(sellerId)) {
      sellerReady.set(sellerId, readDirectPayLaunchReadiness(db, { getProtocolParam, sellerId }).ready)
    }
    return sellerReady.get(sellerId) as boolean
  }

  const storeRuleCache = new Map<string, ReturnType<typeof effectiveSaleRegionsRule>>()
  const items: Array<Record<string, unknown>> = []

  for (const p of rows) {
    if (!isSellerReady(p.seller_id)) { stats.excluded_seller_not_ready++; continue }

    let imgs: string[] = []
    try { const arr = JSON.parse(p.images || '[]'); if (Array.isArray(arr)) imgs = arr.map(resolveImageUrl).filter((x): x is string => !!x) } catch { /* malformed → no images */ }
    if (!imgs.length) { stats.excluded_no_image++; continue }

    const tc = targetCountries(db, p.sale_regions, p.seller_id, storeRuleCache)
    if (!tc) { stats.excluded_no_target_countries++; continue }

    const usd = Math.round((Number(p.price) / rate) * 100) / 100

    const item: Record<string, unknown> = {
      item_id: p.id,
      title: (p.title || '').slice(0, 150),
      description: plainText(p.description, 5000),
      url: `${BASE}/#order-product/${p.id}`,
      brand: (p.brand ? String(p.brand) : 'Unbranded').slice(0, 70),
      image_url: imgs[0],
      price: `${usd.toFixed(2)} USD`,        // spec 形状:数字 + ISO 4217 代码;USD = USDC 结算值 1:1 表示
      availability: Number(p.stock) > 0 ? 'in_stock' : 'out_of_stock',
      seller_name: (p.seller_name || p.seller_id).slice(0, 70),
      seller_url: `${BASE}/#u/${p.seller_id}`,
      is_eligible_search: true,
      is_eligible_checkout: false,           // ACP checkout(卡+PSP)未接 —— RFC-015 P2 门控不变
      store_country: 'SG',
      target_countries: tc,
    }
    if (imgs.length > 1) item.additional_image_urls = imgs.slice(1).join(',')
    if (p.model) item.mpn = String(p.model).slice(0, 70)
    if (p.category) item.product_category = String(p.category)
    items.push(item)
  }

  stats.sellers_scanned = sellerReady.size
  stats.sellers_ready = [...sellerReady.values()].filter(Boolean).length
  return { ok: true, items, stats }
}
