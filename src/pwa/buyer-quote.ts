/**
 * RFC-025 PR-3 — Buyer Quote Service(server 权威 · OAuth-native · 零 PII · 零经济执行)。
 *
 * 职责:验证商品/数量/库存/配送资格 → 服务端解析默认地址 → 整数分项计价 → 落 order_quotes 快照
 *   → 返回 quote_token(明文只出一次,DB 存 hash)。不建单、不扣款、不锁资金、不动库存、不 Passkey。
 *
 * 纪律:
 *   - G-QTY-1:validateQuantity 产出唯一 validated_quantity,小计/库存/限购/捐赠/快照全部用它。
 *   - 金额:INTEGER base-units(money.ts,1 WAZ = 1e6);donation 用与 orders-create 同一个 mulRate
 *     (报价必须等于将来创建订单实际收取的值 —— 一致性优先于"纯整数乘法"洁癖,helper 即 RFC-014 口径)。
 *   - 不静默改变条件:任何不满足 → 结构化错误 + next_steps,绝不换轨/换量/换地址。
 *   - direct_p2p 资格:复用 direct-pay-controls 的【同一批导出评估函数】(单一真相源,零 drift);
 *     PR-4/5a 创建订单时全部门再跑一遍 —— quote 不担保资格,响应里如实声明。
 *   - PII:完整地址只在本进程内部用于配送计算;出口只有 region 标签/摘要句/sha256。
 *   - auth 适配:本模块不做鉴权 —— OAuth route(requireAgentGrantScope('price_quote'))或未来
 *     api_key adapter 解析出 humanId 后调用(共享 Quote Service 形态)。
 */
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { toUnits, mulRate, type Units } from '../money.js'
import { MAX_PER_ORDER } from '../order-limits.js'
import { effectiveShippingTemplate, resolveShipping } from '../shipping-templates.js'
import { freeShippingWaives } from '../free-shipping.js'
import { effectiveSaleRegionsRule, regionAllowedByRule } from '../sale-regions.js'
import {
  readDirectPayControlsConfig, evaluateDirectPayLaunchControls, coarsenBuyerFacingDirectPayCode,
  sellerDirectPayBreakerTripped, sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear,
} from '../direct-pay-controls.js'
import { sellerBaseBondEntrySatisfied } from '../direct-pay-base-bond-entry.js'
import { productStoreVerified } from '../product-verification.js'
import { sellerExemptFromPerProduct } from '../store-verification.js'
import { getAccount } from '../direct-receive-accounts.js'

export const QUOTE_TTL_MS = 10 * 60_000        // 与 price_sessions 同 TTL(现行规范 10 分钟)
export const VALID_DONATION_BPS = new Set([0, 50, 100, 200, 500])   // ↔ orders-create 的 0/0.005/0.01/0.02/0.05

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export interface QuoteError {
  ok: false
  status: number
  body: {
    error_code: string
    reason: string
    retryable: boolean
    missing_requirements: string[]
    next_steps: string[]
    [k: string]: unknown
  }
}
const qerr = (status: number, error_code: string, reason: string, extra: Partial<QuoteError['body']> = {}): QuoteError =>
  ({ ok: false, status, body: { error_code, reason, retryable: false, missing_requirements: [], next_steps: [], ...extra } })

/**
 * G-QTY-1 — 唯一规范化数量。硬约束:必须是 number 类型的安全正整数(字符串/小数/NaN/Infinity 一律拒,
 * 不做隐式转换);≤ 库存;≤ MAX_PER_ORDER(与 orders-create 同一常量)。所有下游只允许用返回的 qty。
 */
export function validateQuantity(raw: unknown, availableStock: number):
  { ok: true; qty: number } | QuoteError {
  const q = raw === undefined ? 1 : raw
  if (typeof q !== 'number' || !Number.isSafeInteger(q) || q <= 0) {
    return qerr(400, 'INVALID_QUANTITY', 'quantity must be a positive safe integer (number type; no strings/decimals/NaN/Infinity)', { retryable: true, next_steps: ['resend with an integer quantity >= 1'] })
  }
  if (q > MAX_PER_ORDER) {
    return qerr(409, 'PURCHASE_LIMIT_EXCEEDED', `single-order limit is ${MAX_PER_ORDER}`, { max_per_order: MAX_PER_ORDER, next_steps: ['reduce quantity', 'split into multiple orders'] })
  }
  if (q > availableStock) {
    return qerr(409, 'INSUFFICIENT_STOCK', `requested ${q}, available ${availableStock}`, { available_stock: availableStock, retryable: true, next_steps: ['reduce quantity', 'choose_another_offer'] })
  }
  return { ok: true, qty: q }
}

export interface QuoteInput {
  product_id?: unknown
  variant_id?: unknown
  quantity?: unknown
  payment_rail?: unknown
  address_source?: unknown
  direct_receive_account_id?: unknown
  anonymous_recipient?: unknown
  donation_bps?: unknown
  idempotency_key?: unknown
}

interface QuoteDeps {
  generateId: (prefix: string) => string
  getProtocolParam: <T>(key: string, fallback: T) => T
}

/** PR-4 消费基础:校验 token → 行(hash/subject/未过期/未消费)。消费(置 consumed_at)在 PR-4。 */
export function verifyQuoteToken(db: Database.Database, token: unknown, humanId: string):
  { ok: true; quote: Record<string, unknown> } | { ok: false; error_code: 'QUOTE_TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'QUOTE_ALREADY_CONSUMED' } {
  if (typeof token !== 'string' || !token.startsWith('qtk_')) return { ok: false, error_code: 'QUOTE_TOKEN_INVALID' }
  const row = db.prepare('SELECT * FROM order_quotes WHERE token_hash = ?').get(sha(token)) as Record<string, unknown> | undefined
  if (!row || row.human_id !== humanId) return { ok: false, error_code: 'QUOTE_TOKEN_INVALID' }   // 跨 subject = 同 invalid(不给存在性 oracle)
  if (row.consumed_at) return { ok: false, error_code: 'QUOTE_ALREADY_CONSUMED' }
  if (String(row.expires_at) <= new Date().toISOString()) return { ok: false, error_code: 'TOKEN_EXPIRED' }
  return { ok: true, quote: row }
}

const maskId = (id: string): string => !id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `${id.slice(0, 2)}…`

/** 由 order_quotes 行重建响应(幂等命中时复用;单一构造器防两处 drift)。 */
function buildResponse(db: Database.Database, row: Record<string, unknown>, quoteToken: string | null): Record<string, unknown> {
  const buyer = db.prepare('SELECT handle FROM users WHERE id = ?').get(String(row.human_id)) as { handle: string | null } | undefined
  const prod = db.prepare('SELECT title, stock, has_variants, handling_hours, estimated_days, return_days, warranty_days, import_duty_terms FROM products WHERE id = ?').get(String(row.product_id)) as Record<string, unknown> | undefined
  const rail = String(row.payment_rail)
  const itemU = Number(row.item_units), shipU = Number(row.shipping_units), donU = Number(row.donation_units)
  const totalU = Number(row.total_units), payableU = Number(row.payable_units)
  const line = (code: string, amount: number, included: boolean, estimated: boolean, refundable: boolean, note?: string) =>
    ({ code, amount_minor: amount, currency: 'WAZ', currency_exponent: 6, included_in_total: included, estimated, refundable, ...(note ? { note } : {}) })
  const lineItems = [
    line('item_subtotal', itemU, true, false, true),
    line('shipping', shipU, true, false, true),
    line('protocol_fee', 0, true, false, true, 'no buyer-side protocol fee at order time (escrow commission settles seller-side; direct_p2p platform fee is seller-prepaid)'),
    line('discount', 0, true, false, true, 'no coupon/flash input in quote v1'),
    line('donation', donU, false, false, false, 'charged IN ADDITION to total (goes to charity_fund; same mulRate as order creation)'),
    line('estimated_tax', 0, false, true, false, 'import duty/tax is seller-declared disclosure (S0-S6); WebAZ does not compute or collect tax — see trade_terms'),
  ]
  // 总额一致性(服务器断言,agent 永不自行求和)
  const sumIncluded = lineItems.filter(l => l.included_in_total).reduce((a, l) => a + l.amount_minor, 0)
  if (sumIncluded !== totalU || totalU + donU !== payableU) throw new Error('QUOTE_CALCULATION_FAILED: line-item/total invariant broke')
  const acc = row.direct_receive_account_id ? getAccount(db, String(row.direct_receive_account_id)) : null
  return {
    quote_id: String(row.id),
    acting_as: buyer?.handle ? `@${buyer.handle}` : null,
    account_id_hint: maskId(String(row.human_id)),
    product: {
      product_id: String(row.product_id),
      title: prod ? String(prod.title) : null,
      variant_id: row.variant_id == null ? null : String(row.variant_id),
      seller_id_hint: maskId(String(row.seller_id)),
    },
    quantity: { requested: Number(row.quantity), quoted: Number(row.quantity), available_stock: prod ? Number(prod.stock) : null },
    destination: {
      address_source: 'default',
      address_summary: `Default address · ${row.dest_region ? String(row.dest_region) : 'region unset'}`,
      region: row.dest_region == null ? null : String(row.dest_region),
      address_resolved: true,
    },
    payment: rail === 'direct_p2p' ? {
      rail, custodied_by_webaz: false,
      note: 'You pay the seller DIRECTLY off-protocol; WebAZ holds no funds and cannot auto-refund from the seller. Post-sale rulings affect reputation/liability records. Final eligibility gates re-run at order creation.',
      seller_receiving_account: acc ? { account_id: acc.id, method: acc.method, currency: acc.currency, label: acc.label } : { note: "seller's receiving instructions are revealed at order time (after disclosure acks)" },
      payable_currency: acc ? acc.currency : 'per seller receiving account',
      conversion_authoritative: false,
      conversion_note: 'WebAZ has NO authoritative FX; the WAZ amounts below are the protocol-recorded amounts, actual payment follows the seller account currency/instructions.',
    } : {
      rail: 'escrow', custodied_by_webaz: true, payable_currency: 'WAZ',
      note: 'Funds move ONLY at order creation (wallet→escrow, needs sufficient balance) — this quote charges nothing. Refund/release/partial-refund via the existing dispute/return flows.',
    },
    line_items: lineItems,
    total: { amount_minor: totalU, currency: 'WAZ', currency_exponent: 6 },
    payable_total: { amount_minor: payableU, currency: 'WAZ', currency_exponent: 6, note: 'total + donation (what an escrow order will debit at creation)' },
    trade_terms: prod ? { return_days: prod.return_days ?? null, warranty_days: prod.warranty_days ?? null, import_duty_terms: prod.import_duty_terms ?? null, note: 'seller-declared disclosure; WebAZ does not compute/collect tax' } : null,
    shipping: { supported: true, handling_hours: prod?.handling_hours ?? null, estimated_days: prod?.estimated_days ?? null },
    ...(quoteToken ? { quote_token: quoteToken } : { quote_token_note: 'idempotent replay — the token was issued once with the original response and is not re-shown' }),
    issued_at: String(row.issued_at),
    expires_at: String(row.expires_at),
    stock_reserved: false,
    economic_action_executed: false,
    stock_note: 'quote does NOT reserve stock or guarantee availability at confirmation — stock is re-checked and decremented only at real order creation',
    next_action: 'order draft (RFC-025 PR-4, not yet available). Until then a human orders at webaz.xyz, or an api_key agent uses webaz_place_order.',
  }
}

export function computeBuyerQuote(db: Database.Database, deps: QuoteDeps, humanId: string, input: QuoteInput):
  { ok: true; response: Record<string, unknown> } | QuoteError {
  // ── 1. 商品 ──
  const productId = typeof input.product_id === 'string' && input.product_id ? input.product_id : null
  if (!productId) return qerr(400, 'PRODUCT_NOT_FOUND', 'product_id is required', { retryable: true, missing_requirements: ['product_id'] })
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown> | undefined
  if (!product) return qerr(404, 'PRODUCT_NOT_FOUND', 'no such product', { next_steps: ['choose_another_offer', 'webaz_discover'] })
  if (String(product.status) !== 'active') return qerr(409, 'PRODUCT_NOT_ACTIVE', `product status is ${String(product.status)}`, { next_steps: ['choose_another_offer'] })
  const sellerId = String(product.seller_id)

  // ── 2. 变体(可选;有规格商品必须选) ──
  let variant: Record<string, unknown> | null = null
  const variantId = typeof input.variant_id === 'string' && input.variant_id ? input.variant_id : null
  if (Number(product.has_variants) === 1) {
    if (!variantId) return qerr(409, 'VARIANT_REQUIRED', 'this product has variants — pass variant_id', { retryable: true, missing_requirements: ['variant_id'] })
    variant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1').get(variantId, productId) as Record<string, unknown> | null
    if (!variant) return qerr(409, 'VARIANT_REQUIRED', 'variant not found / inactive for this product', { retryable: true })
  } else if (variantId) {
    return qerr(400, 'VARIANT_REQUIRED', 'this product has no variants — do not pass variant_id', { retryable: true })
  }

  // ── 3. G-QTY-1 唯一规范化数量(库存 = 变体库存优先) ──
  const availableStock = Number((variant ? variant.stock : product.stock) ?? 0)
  const vq = validateQuantity(input.quantity, availableStock)
  if (!('ok' in vq) || vq.ok !== true) return vq as QuoteError
  const qty = vq.qty   // ↓ 此后一切只允许用 qty

  // ── 4. 支付轨道(只允许真实启用;绝不静默换轨) ──
  const rail = input.payment_rail === undefined ? 'escrow' : input.payment_rail
  if (rail !== 'escrow' && rail !== 'direct_p2p') {
    return qerr(409, 'PAYMENT_RAIL_DISABLED', `rail "${String(rail)}" is not enabled — only escrow and direct_p2p exist`, { next_steps: ['use payment_rail=escrow', 'use payment_rail=direct_p2p'] })
  }

  // ── 5. donation(整数基点枚举;direct_p2p v1 不支持 donation/anonymous —— 如实拒绝,不静默清零) ──
  const donationBps = input.donation_bps === undefined ? 0 : input.donation_bps
  if (typeof donationBps !== 'number' || !VALID_DONATION_BPS.has(donationBps)) {
    return qerr(400, 'INVALID_QUANTITY', 'donation_bps must be one of 0/50/100/200/500 (integer basis points)', { error_code_note: 'validation', retryable: true })
  }
  const anonymous = input.anonymous_recipient === true

  // ── 6. 服务端解析默认地址(#377 同源:users.default_address_*;全文永不出模块) ──
  const src = typeof input.address_source === 'string' ? input.address_source : 'default'
  if (src !== 'default') return qerr(400, 'ADDRESS_NOT_RESOLVABLE', "address_source only supports 'default' in quote v1 (address_ref lands with its consumer in PR-4+)", { next_steps: ['use address_source=default'] })
  const u = db.prepare('SELECT default_address_text, default_address_region FROM users WHERE id = ?').get(humanId) as { default_address_text: string | null; default_address_region: string | null } | undefined
  const addrText = (u?.default_address_text || '').trim()
  if (!addrText) return qerr(409, 'DEFAULT_ADDRESS_REQUIRED', 'no default address on file — set one at webaz.xyz (PWA profile) or via webaz_default_address action=set; never paste a full address into chat', { missing_requirements: ['default_address'], next_steps: ['change_address_in_pwa'] })
  const regionTag = (u?.default_address_region || '').trim() || null

  // ── 7. 可售地区 + 运费(与下单同一批纯谓词/模板解析;有模板必须有 region 标签) ──
  const rule = effectiveSaleRegionsRule(db, product as { sale_regions?: string | null }, sellerId)
  if (rule && (!regionTag || !regionAllowedByRule(rule, regionTag))) {
    return qerr(409, 'SHIPPING_NOT_SUPPORTED', regionTag ? `seller does not sell to region "${regionTag}"` : 'product restricts sale regions and your default address has no region tag', { next_steps: ['choose_another_offer', 'change_address_in_pwa'] })
  }
  const tpl = effectiveShippingTemplate(db, product as { shipping_template?: string | null }, sellerId)
  let shipU: Units = 0
  if (tpl) {
    if (!regionTag) return qerr(409, 'ADDRESS_NOT_RESOLVABLE', 'this product uses a shipping template — your default address needs a region tag (set it via webaz_default_address action=set region=...)', { missing_requirements: ['default_address_region'], next_steps: ['change_address_in_pwa'] })
    const r = resolveShipping(tpl, regionTag)
    if (!r.covered) return qerr(409, 'SHIPPING_NOT_SUPPORTED', `shipping template does not cover region "${regionTag}" (quote v1 does not support the direct_p2p quote-on-request path)`, { next_steps: ['choose_another_offer', 'change_address_in_pwa'] })
    shipU = toUnits(r.fee)   // 模板存 decimal 费额;边界一次性整数化(与 gateShippingForCreate 同口径)
  }

  // ── 8. 整数分项(单价快照 = 变体覆盖后;donation 用 orders-create 同一 mulRate) ──
  const unitPriceU = toUnits(Number((variant?.price_override ?? product.price) as number))
  const itemU = unitPriceU * qty
  if (tpl && shipU > 0 && freeShippingWaives(db, product as { free_shipping_threshold?: number | null }, sellerId, itemU)) shipU = 0
  const totalU = itemU + shipU
  const donationU = donationBps > 0 ? mulRate(totalU, donationBps / 10000) : 0
  const payableU = totalU + donationU

  // ── 9. direct_p2p 资格(镜像 direct-pay-create 的同一批评估函数;quote 不担保,创建时全部重跑) ──
  let receiveAccountId: string | null = null
  if (rail === 'direct_p2p') {
    if (Number(product.has_variants) === 1 || variantId) return qerr(409, 'DIRECT_PAY_NOT_ELIGIBLE', 'direct_p2p v1 supports simple products only (no variants). escrow is available as an alternative — NOT auto-switched.', { next_steps: ['use payment_rail=escrow'] })
    if (donationBps > 0 || anonymous) return qerr(409, 'DIRECT_PAY_NOT_ELIGIBLE', `direct_p2p v1 does not support ${donationBps > 0 ? 'donation' : 'anonymous_recipient'}. escrow supports it — NOT auto-switched.`, { next_steps: ['use payment_rail=escrow', 'drop the unsupported option'] })
    const cfg = readDirectPayControlsConfig(deps.getProtocolParam)
    const ctrl = evaluateDirectPayLaunchControls(cfg, {
      amountUnits: totalU,
      sellerBreakerTripped: sellerDirectPayBreakerTripped(db, sellerId),
      baseBondSatisfied: sellerBaseBondEntrySatisfied(db, sellerId, new Date().toISOString()),
      kycSanctionsPassed: sellerDirectPayKybPassed(db, sellerId) && sellerDirectPaySanctionsClear(db, sellerId),
      amlClear: sellerDirectPayAmlClear(db, sellerId),
    })
    if (!ctrl.ok) {
      const rawCode = String(ctrl.error_code ?? 'DIRECT_PAY_NOT_ELIGIBLE')
      const code = coarsenBuyerFacingDirectPayCode(rawCode)
      const isCap = rawCode === 'DIRECT_PAY_CAP_EXCEEDED'
      return qerr(409, isCap ? 'PURCHASE_LIMIT_EXCEEDED' : (code === rawCode ? code : 'SELLER_NOT_ELIGIBLE'),
        isCap ? 'direct pay per-transaction cap exceeded (or unconfigured)' : (code === rawCode ? String(ctrl.reason ?? 'direct pay not available') : 'seller is not currently eligible for direct pay'),
        { next_steps: ['use payment_rail=escrow', 'choose_another_offer'] })
    }
    if (!(productStoreVerified(db, productId) || sellerExemptFromPerProduct(db, sellerId))) {
      return qerr(409, 'DIRECT_PAY_NOT_ELIGIBLE', 'this product is not yet platform-verified for direct pay. escrow is available — NOT auto-switched.', { next_steps: ['use payment_rail=escrow'] })
    }
    if (input.direct_receive_account_id != null) {
      if (typeof input.direct_receive_account_id !== 'string' || !input.direct_receive_account_id) return qerr(400, 'DIRECT_RECEIVE_ACCOUNT_INVALID', 'direct_receive_account_id must be a non-empty string id', { retryable: true })
      const acc = getAccount(db, input.direct_receive_account_id)
      if (!acc || acc.seller_id !== sellerId || acc.status !== 'active') return qerr(409, 'DIRECT_RECEIVE_ACCOUNT_INVALID', 'receiving account unknown, not this seller, or inactive', { next_steps: ['omit direct_receive_account_id to use the seller default at order time'] })
      receiveAccountId = acc.id
    }
  } else if (input.direct_receive_account_id != null) {
    return qerr(400, 'DIRECT_RECEIVE_ACCOUNT_INVALID', 'direct_receive_account_id only applies to payment_rail=direct_p2p', { retryable: true })
  }

  // ── 10. 幂等 + 落库(先查同键) ──
  const idemKey = typeof input.idempotency_key === 'string' && input.idempotency_key ? input.idempotency_key.slice(0, 80) : null
  const intentHash = sha(JSON.stringify({ productId, variantId, qty, rail, donationBps, anonymous, receiveAccountId, src: 'default' }))
  const nowIso = new Date().toISOString()
  if (idemKey) {
    const prev = db.prepare('SELECT * FROM order_quotes WHERE human_id = ? AND idempotency_key = ?').get(humanId, idemKey) as Record<string, unknown> | undefined
    if (prev) {
      if (String(prev.intent_hash) !== intentHash) return qerr(409, 'IDEMPOTENCY_CONFLICT', 'this idempotency_key was used with a DIFFERENT payload — pick a new key', { retryable: true })
      if (String(prev.expires_at) > nowIso && !prev.consumed_at) return { ok: true, response: buildResponse(db, prev, null) }
      db.prepare('DELETE FROM order_quotes WHERE id = ?').run(String(prev.id ?? ''))   // 过期/已消费的同键行让位于新报价
    }
  }
  const quoteId = deps.generateId('qte')
  const token = `qtk_${randomBytes(32).toString('hex')}`
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString()
  try {
    db.prepare(`INSERT INTO order_quotes (id, token_hash, human_id, product_id, variant_id, seller_id, quantity, unit_price_units,
        item_units, shipping_units, donation_bps, donation_units, total_units, payable_units, currency, payment_rail,
        direct_receive_account_id, dest_region, address_summary_hash, anonymous_recipient, intent_hash, idempotency_key, issued_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(quoteId, sha(token), humanId, productId, variantId, sellerId, qty, unitPriceU,
        itemU, shipU, donationBps, donationU, totalU, payableU, 'WAZ', rail,
        receiveAccountId, regionTag, sha(addrText), anonymous ? 1 : 0, intentHash, idemKey, nowIso, expiresAt)
  } catch (e) {
    return qerr(503, 'QUOTE_TOKEN_GENERATION_FAILED', 'quote ledger unavailable — retry shortly', { retryable: true })
  }
  const row = db.prepare('SELECT * FROM order_quotes WHERE id = ?').get(quoteId) as Record<string, unknown>
  try {
    return { ok: true, response: buildResponse(db, row, token) }
  } catch {
    db.prepare('DELETE FROM order_quotes WHERE id = ?').run(quoteId)   // 断言失败 → 撤快照,绝不发出不一致报价
    return qerr(500, 'QUOTE_CALCULATION_FAILED', 'internal line-item/total invariant failed — no quote was issued', { retryable: true })
  }
}
