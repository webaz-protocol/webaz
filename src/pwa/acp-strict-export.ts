/**
 * A1 — strict ACP 商品 feed 导出(RFC-015;口径 = Holden 2026-07-23 拍板)。
 *
 * 与 /.well-known/webaz-acp-feed.json(发现投影,全商品+WAZ 标价+逐条非合规声明)不同,本模块产出
 * 【严格按 OpenAI ACP file-upload products spec】的导出物,供批准后经 SFTP 提交。诚实三门:
 *
 *   1. 【只含可真实成交的商品】(Codex #513 R1 对齐到真实建单门):卖家过 Rail 1 全套门禁
 *      (readDirectPayLaunchReadiness ready=true:全局开放 + KYB + 制裁 + AML + 保证金/缓交 +
 *      收款说明 + 未暂停)之外,逐品还须过【与买家 availability 路由同源】的
 *      directPayProductAvailability(qty=1 基准额:单笔帽 + 逐品验证/店铺豁免 + 缓交额度),
 *      且 简单商品(无规格,镜像 create 的 SIMPLE_PRODUCT_ONLY)、有库存(stock>0)。
 *      不可真实购买的商品绝不进 strict feed —— 宁可少投,不投「点进来买不了」的坑。
 *      (price = 商品单价,ACP feed 语义;运费在下单时按地址结算,不进 price 字段。)
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
import { directPayProductAvailability } from '../direct-pay-availability-check.js'
import { resolveImageUrl, targetCountries } from './acp-feed.js'
import { effectiveSaleRegionsRule, parsePlatformBlocklist } from '../sale-regions.js'
import { effectiveShippingTemplate, resolveShipping, quoteOutsideTemplateOk } from '../shipping-templates.js'
import { getActiveFlashSale } from './routes/flash-sales.js'
import { toUnits } from '../money.js'

const BASE = 'https://webaz.xyz'

function plainText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

interface StrictRow {
  id: string; title: string; description: string; price: number; stock: number
  category: string | null; images: string | null; brand: string | null; model: string | null
  product_type: string | null; seller_id: string; seller_name: string | null; sale_regions: string | null
  has_variants: number | null; shipping_template: string | null; shipping_quote_ok: number | null
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
    excluded_out_of_stock: number       // 无库存 = 此刻不可成交(建单会拒)
    excluded_variant_product: number    // 有规格商品(direct_p2p v1 SIMPLE_PRODUCT_ONLY)
    excluded_direct_pay_unavailable: number // 逐品可用性谓词拒(单笔帽/逐品验证/缓交额度)
    excluded_flash_sale: number         // 生效中闪购(direct-pay create 对 flash_sale 硬拒 UNSUPPORTED_OPTION)
    excluded_no_image: number           // 无公网可加载图片(spec 必填)
    excluded_no_target_countries: number // 推导不出 ISO 目标国(spec 必填,已扣平台 blocklist + 运费不可达地区)
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
    excluded_seller_not_ready: 0, excluded_out_of_stock: 0, excluded_variant_product: 0,
    excluded_direct_pay_unavailable: 0, excluded_flash_sale: 0, excluded_no_image: 0, excluded_no_target_countries: 0, waz_usdc_rate: rate,
  })
  if (!(Number.isFinite(rate) && rate > 0)) return { ok: false, reason: 'waz_usdc_rate 非法(<=0)——拒绝导出错误价格', items: [], stats: emptyStats() }

  // 平台合规 blocklist(与建单门 gateSaleRegionForCreate 同一真相源);坏配置 → fail-closed(镜像建单 503)。
  const parsedBlock = parsePlatformBlocklist(getProtocolParam<string>('trade.platform_region_blocklist', '[]'))
  if (!parsedBlock.ok) return { ok: false, reason: 'trade.platform_region_blocklist 配置异常 —— 拒绝导出可能违反平台合规的目标国', items: [], stats: emptyStats() }
  const platformBlock = new Set(parsedBlock.list)

  // 全局门:平台侧 Rail 1 未开放 → 整体 fail-closed(空导出 + 原因),绝不投「无法成交」的 feed。
  const globalReadiness = readDirectPayLaunchReadiness(db, { getProtocolParam })
  if (!globalReadiness.ready) {
    return { ok: false, reason: `Direct Pay 全局未就绪:${globalReadiness.blockers.join(',')}`, items: [], stats: emptyStats() }
  }

  const rows = db.prepare(`
    SELECT p.id, p.title, p.description, p.price, p.stock, p.category, p.images, p.brand, p.model,
           p.product_type, p.seller_id, u.name AS seller_name, p.sale_regions, p.has_variants,
           p.shipping_template, p.shipping_quote_ok
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
    // 此刻不可成交 → 不进 strict feed(建单在 direct-pay 前就拒库存不足;Codex R1 HIGH)。
    if (!(Number(p.stock) > 0)) { stats.excluded_out_of_stock++; continue }
    // direct_p2p v1 仅简单商品(镜像 create 的 DIRECT_PAY_SIMPLE_PRODUCT_ONLY)。
    if (Number(p.has_variants) === 1) { stats.excluded_variant_product++; continue }
    // 逐品可用性:与买家 availability 路由同一谓词、同一 qty=1 基准额口径(单笔帽+逐品验证/豁免+缓交额度)。
    const avail = directPayProductAvailability(db, { productId: p.id, sellerId: p.seller_id, amountUnits: toUnits(Number(p.price) || 0), getProtocolParam })
    if (!avail.available) { stats.excluded_direct_pay_unavailable++; continue }
    // 生效中闪购:direct-pay create 对 flashActive 硬拒(DIRECT_PAY_UNSUPPORTED_OPTION)→ 不可经直付成交,剔除。
    if (getActiveFlashSale(db, p.id, null)) { stats.excluded_flash_sale++; continue }

    let imgs: string[] = []
    try { const arr = JSON.parse(p.images || '[]'); if (Array.isArray(arr)) imgs = arr.map(resolveImageUrl).filter((x): x is string => !!x) } catch { /* malformed → no images */ }
    if (!imgs.length) { stats.excluded_no_image++; continue }

    // 目标国 = 可如实推导的 ISO 列表 − 平台合规 blocklist − 运费不可达地区(建单门会拒的地区绝不对外声称可卖):
    //   有运费模板时,镜像 gateShippingForCreate 的 direct_p2p 分支:region 被模板覆盖 OR 卖家开了询价
    //   (quoteOutsideTemplateOk)才可达;无模板 = 原行为全可达(gate 返回 fee 0)。
    const tcRaw = targetCountries(db, p.sale_regions, p.seller_id, storeRuleCache)
    let tc = tcRaw ? tcRaw.filter((c) => !platformBlock.has(c)) : null
    if (tc && tc.length) {
      const tpl = effectiveShippingTemplate(db, { shipping_template: p.shipping_template }, p.seller_id)
      if (tpl) {
        const quoteOk = quoteOutsideTemplateOk(db, { shipping_quote_ok: p.shipping_quote_ok }, p.seller_id)
        tc = tc.filter((c) => resolveShipping(tpl, c).covered || quoteOk)
      }
    }
    if (!tc || !tc.length) { stats.excluded_no_target_countries++; continue }

    const usd = Math.round((Number(p.price) / rate) * 100) / 100

    const item: Record<string, unknown> = {
      item_id: p.id,
      title: (p.title || '').slice(0, 150),
      description: plainText(p.description, 5000),
      url: `${BASE}/#order-product/${p.id}`,
      brand: (p.brand ? String(p.brand) : 'Unbranded').slice(0, 70),
      image_url: imgs[0],
      price: `${usd.toFixed(2)} USD`,        // spec 形状:数字 + ISO 4217 代码;USD = USDC 结算值 1:1 表示(商品单价,不含运费)
      availability: 'in_stock',              // stock<=0 已整条剔除(strict feed 只含此刻可成交的)
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
