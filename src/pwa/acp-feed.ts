/**
 * ACP-inspired product DISCOVERY feed — RFC-015 P0(唯一现在安全可做的一刀)。
 *
 * 把 WebAZ 现有商品投影成 OpenAI Agentic Commerce Protocol (ACP) product-feed 的【形状】,
 * 让 ACP/ChatGPT 风格的 agent 能【发现】WebAZ 商品 —— 和我们已 ship 的 schema.org JSON-LD
 * (SEO/网页 agent)+ /.well-known/webaz-*.json(RFC-011 集成契约)同一类:只读投影,无钱,无 PSP。
 *
 * ⚠️ 这【不是】一份严格可被 OpenAI 直接 ingest 的合规商家 feed(Codex #151):
 *   ACP 的严格 product feed 要求 price.currency = ISO 4217 法币。本 feed 价格是 escrow 轨的
 *   SIMULATED WAZ 展示单位(非 ISO 4217)—— 故定位为【ACP-inspired 发现投影】,非【strict ACP ingestion feed】。
 *   (merchant-level 必填字段 store_country/target_countries 自 A0 起已按辖区/跨境规则发出。)
 *   非合规点逐条列在 feed 级 `compatibility` 字段,ingester 不应把它当严格 feed 消费。
 *   真正的 strict/export 合规 feed 要等 RFC-015 后续阶段接入法币计价 + ACP checkout 后再建(届时非空才有意义)。
 *
 * 字段名取自真 spec(developers.openai.com/commerce/specs/feed, API-Version 2025-09-12,2026-06-07 读)。
 *
 * 两个【诚实】硬约束(不可悄悄改):
 *   1. is_eligible_checkout = false (全部) —— ACP /complete 是"卡 + PSP"(见 RFC-015),WebAZ 尚未接;
 *      商品【可经 ACP 发现】,但【不可经 ACP 购买】。真实购买走 WebAZ 自有 checkout + escrow。
 *   2. currency = WAZ —— escrow 轨【模拟】展示单位,非 ISO 4217 法币。feed 级 _disclosures 标明;真实交易走 WebAZ Direct Pay。
 *
 * 接线:src/pwa/routes/public-utils.ts → GET /.well-known/webaz-acp-feed.json (+ /api/agent/acp-feed)。
 */
import type Database from 'better-sqlite3'
import { displayCurrency } from '../currency.js'  // agent-facing 币种统一 WAZ,遗留 'DCP' 读时归一化(绝不外泄 DCP)
import { effectiveSaleRegionsRule } from '../sale-regions.js'

const BASE = 'https://webaz.xyz'

// ACP availability 枚举(spec):in_stock | out_of_stock | pre_order | backorder | unknown
function availability(stock: unknown): string {
  const n = Number(stock)
  if (!Number.isFinite(n)) return 'unknown'
  return n > 0 ? 'in_stock' : 'out_of_stock'
}

// 图片引用 → 公网可加载 URL。引用识别(64-hex hash / http(s) / 根相对)适配自前端 app-product-media.js
//   productThumbSrc;与前端的差异是【刻意】的,不是漂移(test-acp-feed-images 锁两侧映射关系):
//   - 仅解析 JSON 数组(feed SQL 源即 JSON 列;前端还兼容 legacy CSV 展示);
//   - data: URI 不发(前端可直接 <img>,feed 只发可公网 GET 的 URL);
//   - hash 归一小写(manifest_registry.hash 存小写,SQLite TEXT 等值大小写敏感);
//   - 加 ?format=jpeg(ACP 只收 JPEG/PNG,webp 存量由端点转码)。
// 旧实现对裸 hash 拼出 https://webaz.xyz/<hash>(SPA 壳 HTML,非图片)—— 生产 108/108 坏链的病根;
//   未知形状一律 null,绝不拼域名造坏链。
export function resolveImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const s = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return `${BASE}/api/manifests/${s.toLowerCase()}/thumb?format=jpeg`
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('/')) return BASE + s
  return null
}

// target_countries(ISO 3166-1 alpha-2):复用跨境 S1 的 effectiveSaleRegionsRule 语义(商品规则 ?? 店铺规则)。
//   诚实三则(Codex #510 R1 HIGH):
//   1. list 模式 → include 合法 2 位码 − exclude;过滤后为空 → 【省略字段】,不虚报;
//   2. all 模式 → 只能如实枚举平台辖区 SG,且 SG 被 exclude 时同样【省略】;
//   3. 无规则/解析失败 → 保守 ['SG'](平台辖区默认)。
//   自定义大区码(如 'SEA')非 ISO alpha-2,过滤 —— 宁可少报不虚报。店铺级规则按 seller 缓存(避免 5000 行 N+1)。
const ISO_ALPHA2 = /^[A-Z]{2}$/
type SaleRule = ReturnType<typeof effectiveSaleRegionsRule>
export function targetCountries(db: Database.Database, saleRegions: string | null, sellerId: string, storeRuleCache: Map<string, SaleRule>): string[] | null {
  let rule: SaleRule = null
  try {
    if (saleRegions) rule = effectiveSaleRegionsRule(db, { sale_regions: saleRegions }, sellerId)
    else {
      if (!storeRuleCache.has(sellerId)) storeRuleCache.set(sellerId, effectiveSaleRegionsRule(db, { sale_regions: null }, sellerId))
      rule = storeRuleCache.get(sellerId) ?? null
    }
  } catch { rule = null }
  if (!rule) return ['SG']
  const exclude = new Set((rule.exclude ?? []).map(String))
  if (rule.mode === 'all') return exclude.has('SG') ? null : ['SG']
  const out = (rule.include ?? []).filter((c) => ISO_ALPHA2.test(c) && !exclude.has(c))
  return out.length ? out : null
}

// description 必须 plain text(spec)→ 去 HTML 标签 + 折叠空白 + 截 5000
function plainText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

interface ProductRow {
  id: string; title: string; description: string; price: number; currency: string | null
  stock: number; category: string | null; images: string | null; brand: string | null
  model: string | null; return_days: number | null; product_type: string | null
  seller_id: string; seller_name: string | null; sale_regions: string | null
}

export function buildAcpProductFeed(db: Database.Database, opts: { limit?: number } = {}): Record<string, unknown> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 5000)
  let rows: ProductRow[] = []
  try {
    rows = db.prepare(`
      SELECT p.id, p.title, p.description, p.price, p.currency, p.stock, p.category,
             p.images, p.brand, p.model, p.return_days, p.product_type,
             p.seller_id, u.name AS seller_name, p.sale_regions
      FROM products p
      LEFT JOIN users u ON u.id = p.seller_id
      WHERE p.status = 'active'
      ORDER BY p.created_at DESC
      LIMIT ?
    `).all(limit) as ProductRow[]
  } catch { rows = [] }

  const storeRuleCache = new Map<string, SaleRule>()
  const products = rows.map((p) => {
    let imgs: string[] = []
    try { const arr = JSON.parse(p.images || '[]'); if (Array.isArray(arr)) imgs = arr.map(resolveImageUrl).filter((x): x is string => !!x) } catch { /* malformed → no images */ }
    const returnDays = Number(p.return_days)
    const hasReturn = Number.isFinite(returnDays) && returnDays > 0

    const item: Record<string, unknown> = {
      item_id: p.id,                                            // 稳定商品 ID(spec: max 100)
      title: (p.title || '').slice(0, 150),                     // spec: max 150
      description: plainText(p.description, 5000),              // spec: plain text, max 5000
      url: `${BASE}/#order-product/${p.id}`,                    // 商品详情页(SPA hash,200)
      // price: spec = Number + ISO 4217 code。WAZ 非 ISO 4217 → 见 feed 级 _disclosures.currency
      price: { amount: Number(p.price), currency: displayCurrency(p.currency) },
      availability: availability(p.stock),
      is_digital: p.product_type === 'digital',
      seller_name: (p.seller_name || p.seller_id).slice(0, 70),
      seller_url: `${BASE}/#u/${p.seller_id}`,
      // 诚实门控:可发现 ≠ 可经 ACP 购买(ACP /complete 是卡+PSP,WebAZ 未接 —— RFC-015)
      is_eligible_search: true,
      is_eligible_checkout: false,
      is_eligible_ads: false,
      // merchant-level required field(spec):store_country = 平台辖区(卖家级 store country 未建模)。
      store_country: 'SG',
    }
    // target_countries:能如实推导才发;推导不出(规则排除了一切 ISO 目标)→ 省略,绝不虚报。
    const tc = targetCountries(db, p.sale_regions, p.seller_id, storeRuleCache)
    if (tc) item.target_countries = tc
    if (imgs.length) { item.image_url = imgs[0]; if (imgs.length > 1) item.additional_image_urls = imgs.slice(1).join(',') }
    if (p.brand) item.brand = String(p.brand).slice(0, 70)
    if (p.model) item.mpn = String(p.model).slice(0, 70)
    if (p.category) item.product_category = String(p.category)
    if (hasReturn) { item.accepts_returns = true; item.return_deadline_in_days = Math.round(returnDays) }
    return item
  })

  return {
    feed_version: 1,
    generated_at: new Date().toISOString(),
    source: 'WebAZ',
    spec: {
      feed_kind: 'acp-inspired-discovery',
      based_on: 'OpenAI Agentic Commerce Protocol — product feed (SHAPE only; this is a discovery projection, not a strict ACP-ingestable merchant feed)',
      api_version_observed: '2025-09-12',
      reference: 'https://developers.openai.com/commerce/specs/feed',
      rfc: `${BASE}/docs/INTEGRATOR.md`,
    },
    // Explicit non-compliance so an ACP ingester does NOT treat this as a strict feed (Codex #151).
    compatibility: {
      is_strict_acp_ingestable: false,
      summary: 'Discovery projection that borrows the ACP product-feed shape. It is intentionally NOT a strict ACP-ingestable feed.',
      non_compliant_points: [
        'price.currency is the escrow rail\'s SIMULATED WAZ display unit, not an ISO 4217 fiat currency or the Direct Pay settlement currency.',
        'is_eligible_checkout is false for every item: ACP checkout (card + PSP) is not wired.',
      ],
      strict_export: 'A strict/export feed (ISO 4217 + merchant required fields, compliant items only) is deferred to a later RFC-015 phase, after fiat pricing + ACP checkout exist — it would be empty today.',
    },
    _disclosures: {
      phase: 'launched',
      currency: "Each item's price.currency is the escrow rail's SIMULATED display unit, always emitted as WAZ (legacy internal-code rows are normalized to WAZ on read), NOT an ISO 4217 fiat currency. Real purchases currently use WebAZ Direct Pay and the seller's selected off-platform payment method.",
      checkout: 'is_eligible_checkout is false for every item: ACP checkout is not yet wired. Products are DISCOVERABLE via ACP but ACP cannot complete the purchase. Native WebAZ Direct Pay supports real buyer-to-seller payment; the WebAZ state machine records the order and evidence (see RFC-015).',
      images: 'image_url points at the public LOW-RES thumbnail endpoint (JPEG via ?format=jpeg). Full-resolution images are served peer-to-peer by the seller\'s node and have no server-side URL (WebAZ P2P image model).',
      regions: 'target_countries is derived from seller/product sale-region rules (ISO alpha-2 codes only) and is OMITTED on items where no ISO target can be truthfully derived. The platform compliance blocklist still applies at order time regardless of this field.',
    },
    product_count: products.length,
    products,
  }
}
