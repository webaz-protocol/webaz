/**
 * Orders 下单端点 — POST /api/orders 巨型事务
 *
 * 由 #1013 Phase 85 从 src/pwa/server.ts 抽出（单端点 338 行）。
 *
 * 1 endpoint:
 *   POST /api/orders  完整下单流程，原子事务，包含 ~10 个跨域 hook
 *
 * 关键路径（全部在一个 db.transaction 内原子化）：
 *   1. 受信角色门 + buyer 角色门
 *   2. agent_attestations spend_cap 单笔/24h 累计校验
 *   3. 礼物订单 + 配送窗 + 数量限购 + 主动捐赠 pct 白名单
 *   4. 商品 + variant 校验 + 库存预扣
 *   5. flash sale 自动覆盖 sale_price（不可叠加 coupon）
 *   6. expected_price 价格保护（409 price_changed）
 *   7. coupon 应用（applyCouponToOrder 双签名 helper）
 *   8. session_token 验证（10min 一次性）
 *   9. 计算 subtotal/insurance/donation/total
 *   10. 钱包余额检查
 *   11. 事务：INSERT order + 写 genesis chain event + 扣 wallet/escrow + 扣 charity_fund
 *       + variant/product stock 条件 UPDATE（防超卖竞态）+ flash sale sold_count +1
 *       + coupon usage + transition→paid + auditSponsorChainCross + shouldAutoAccept Skill
 *   12. broadcastSystemEvent 'order_created'
 *
 * 失败模式：VARIANT_STOCK_RACE / PRODUCT_STOCK_RACE → 409；FLASH_SALE_EXHAUSTED → 409
 *
 * 跨域注入：auth + isTrustedRole + generateId + 大量 helper（getActiveFlashSale 等）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { buildCartMandate, buildPaymentMandate, signMandate } from './ap2-mandate.js'
// RFC-014 PR3 — 金额走整数 base-units;钱包写绝对值(防 REAL 浮点加法 dust)。
import { toUnits, toDecimal, mulQty, mulRate } from '../../money.js'
import { createDirectPayResponse } from '../../direct-pay-create.js'                    // PR-4c: direct_p2p 建单分叉(生产门+收款指令门+原子建单;本金不入协议)
import { applyWalletDelta } from '../../ledger.js'; import { gateShippingForCreate } from '../../shipping-templates.js'  // PR-2 运费模板:建单守门(两轨共用,任何写之前)
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam(仅下单事务外的预检查;事务内 escrow/INSERT 保持同步)

// 店铺推荐 → 商品三级归因的【懒升级】(sync,跑在下单事务内、getProductShareChain 之前)。
// 严格门槛(任一不满足则不升级,绝不覆盖已有有效直接归因):
//   ① 无未过期的现有商品归因(direct share 优先,不被店铺推荐覆盖)
//   ② 该 seller 下有未过期的 shop_referral_attribution(recipient=buyer)
//   ③ referrer ≠ buyer、referrer ≠ seller、referrer 非 sys/internal
//   ④ referrer rewards_opted_in=1 且通过 isAllowedSponsor(经济边界)
//   ⑤ referrer 自己 completed 买过【同一个】商品,且该订单的【完成时间 ≤ 店铺推荐锚定时间】——
//      必须"先真实成交同款、后分享店铺",不允许先 touch 旧店铺锚点、事后补购同款再反向升级。
//      完成时间取 order_state_history 中 to_status='completed' 的 MIN(created_at);无 history 行时
//      兼容回退 orders.updated_at(绝不用 orders.created_at 当完成时间)。
// 通过后写 product_share_attribution(shareable_id=NULL,带 shop_referral_verified_purchase provenance);
// 已有但过期的行可被刷新。不改任何结算数学,只新增一条归因来源。模块级导出供测试直测。
export function maybePromoteShopReferralToProductAttribution(
  db: Database.Database,
  opts: { internalAuditorId: string; isAllowedSponsor: (id: string) => boolean },
  productId: string, sellerId: string, buyerId: string,
): void {
  const liveDirect = db.prepare("SELECT 1 FROM product_share_attribution WHERE product_id = ? AND recipient_id = ? AND expires_at > datetime('now')").get(productId, buyerId)
  if (liveDirect) return   // ① 已有有效归因(含直接分享)→ 绝不覆盖
  const referral = db.prepare("SELECT referrer_id, ref_code, created_at FROM shop_referral_attribution WHERE seller_id = ? AND recipient_id = ? AND expires_at > datetime('now')").get(sellerId, buyerId) as { referrer_id: string; ref_code: string; created_at: string } | undefined
  if (!referral) return   // ②
  const r = referral.referrer_id
  if (r === buyerId || r === sellerId || r === 'sys_protocol' || r === opts.internalAuditorId) return   // ③ (referrer===seller → 记录关系但不升级分润)
  const optedIn = (db.prepare("SELECT rewards_opted_in FROM users WHERE id = ?").get(r) as { rewards_opted_in: number } | undefined)?.rewards_opted_in === 1
  if (!optedIn || !opts.isAllowedSponsor(r)) return   // ④
  const qual = db.prepare(`
    SELECT o.id FROM orders o
    WHERE o.buyer_id = ? AND o.product_id = ? AND o.status = 'completed'
      AND COALESCE(
            (SELECT MIN(h.created_at) FROM order_state_history h WHERE h.order_id = o.id AND h.to_status = 'completed'),
            o.updated_at
          ) <= ?
    ORDER BY o.created_at ASC LIMIT 1
  `).get(r, productId, referral.created_at) as { id: string } | undefined
  if (!qual) return   // ⑤ 推荐人没在【锚定店铺之前】真实成交过同款 → 不升级
  const hadRow = db.prepare("SELECT 1 FROM product_share_attribution WHERE product_id = ? AND recipient_id = ?").get(productId, buyerId)
  if (hadRow) {
    db.prepare("UPDATE product_share_attribution SET sharer_id = ?, shareable_id = NULL, created_at = datetime('now'), expires_at = datetime('now','+30 days'), source_type = 'shop_referral_verified_purchase', source_ref = ?, source_shop_seller_id = ?, source_qualified_order_id = ? WHERE product_id = ? AND recipient_id = ?")
      .run(r, referral.ref_code, sellerId, qual.id, productId, buyerId)
  } else {
    db.prepare("INSERT INTO product_share_attribution (product_id, recipient_id, sharer_id, shareable_id, expires_at, source_type, source_ref, source_shop_seller_id, source_qualified_order_id) VALUES (?,?,?,NULL,datetime('now','+30 days'),'shop_referral_verified_purchase',?,?,?)")
      .run(productId, buyerId, r, referral.ref_code, sellerId, qual.id)
  }
}

export interface OrdersCreateDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  generateId: (prefix: string) => string
  generateRecipientCode: () => string
  DONATION_VALID_PCTS: Set<number>
  INTERNAL_AUDITOR_ID: string
  addHours: (date: Date, hours: number) => string | Date
  // 真实签名带 Record<string,unknown> 与 nullable variant；用 any 接口对齐
  getActiveFlashSale: any
  applyCouponToOrder: any
  getProtocolParam: <T>(key: string, fallback: T) => T
  getProductShareChain: (productId: string, buyerId: string, depth?: number) => (string | null)[]
  isAllowedSponsor: (userId: string) => boolean
  // invite-code-ONLY resolver — sponsor_hint from the client is now a permanent_code [+ -L/-R], not a user_id
  resolveInviteCodeRef: (raw: string) => { userId: string; code: string; side: 'left' | 'right' | null } | null
  checkStockAndMaybeDelist: (productId: string) => void
  auditSponsorChainCross: (orderId: string, buyerId: string, sellerId: string, buyerSponsorPath: string | null) => void
  appendOrderEvent: any
  transition: any
  notifyTransition: any
  shouldAutoAccept: (db: Database.Database, orderId: string) => boolean
  ensureCharityRep: (db: Database.Database, userId: string) => void
  broadcastSystemEvent: (type: string, icon: string, msg: string, refId?: string | null) => void
  signPassport: (message: string) => Promise<string>
  issuerAddress: () => string
}

export function registerOrdersCreateRoutes(app: Application, deps: OrdersCreateDeps): void {
  const { db, auth, isTrustedRole, generateId, generateRecipientCode, DONATION_VALID_PCTS,
          INTERNAL_AUDITOR_ID, addHours, getActiveFlashSale, applyCouponToOrder, getProtocolParam,
          getProductShareChain, isAllowedSponsor, resolveInviteCodeRef, checkStockAndMaybeDelist, auditSponsorChainCross,
          appendOrderEvent, transition, notifyTransition, shouldAutoAccept, ensureCharityRep,
          broadcastSystemEvent, signPassport, issuerAddress } = deps

  app.post('/api/orders', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // P0 fix: 受信角色不可下单（铁律）
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色不可参与交易', error_code: 'TRUSTED_ROLE_NO_TRADE' })
    if (user.role !== 'buyer') return void res.json({ error: '仅买家可下单' })

    // 2026-05-23 P0 audit fix 2.1：agent_attestations spend_cap 强制
    const apiKey = req.headers.authorization?.replace('Bearer ', '')
    if (apiKey) {
      const cap = await dbOne<{ spend_cap_per_order: number | null; spend_cap_daily: number | null }>(`SELECT spend_cap_per_order, spend_cap_daily FROM agent_attestations
        WHERE api_key = ? AND user_id = ? AND revoked_at IS NULL`, [apiKey, user.id])
      if (cap) {
        const estQty = Math.max(1, Math.floor(Number(req.body?.quantity ?? 1)))
        const estPrice = Number(req.body?.expected_price ?? 0)
        const estTotal = estPrice * estQty
        if (cap.spend_cap_per_order != null && estTotal > 0 && estTotal > cap.spend_cap_per_order) {
          return void res.status(403).json({
            error: `本笔订单 ${estTotal} WAZ 超过 agent 单笔上限 ${cap.spend_cap_per_order} WAZ（用户设定）`,
            error_code: 'AGENT_SPEND_CAP_PER_ORDER',
            spend_cap: cap.spend_cap_per_order,
          })
        }
        if (cap.spend_cap_daily != null) {
          const todaySpent = (await dbOne<{ t: number }>(`SELECT COALESCE(SUM(total_amount), 0) as t
            FROM orders WHERE buyer_id = ? AND created_at > datetime('now', '-24 hours') AND status != 'cancelled'`,
            [user.id]))!.t
          if (todaySpent + estTotal > cap.spend_cap_daily) {
            return void res.status(403).json({
              error: `24h 累计 ${todaySpent}+${estTotal} 超 agent 日上限 ${cap.spend_cap_daily} WAZ（用户设定）`,
              error_code: 'AGENT_SPEND_CAP_DAILY',
              spend_cap: cap.spend_cap_daily, today_spent: todaySpent,
            })
          }
        }
      }
    }

    const { product_id, shipping_address, notes, session_token, coupon_code, delivery_window, variant_id, expected_price,
      // C-2: 礼物订单字段
      is_gift, gift_recipient_name, gift_recipient_phone, gift_message,
      // C-3: 订单保险
      buy_insurance,
      // B2 隐私购物：买家选匿名 → 生成 PR-XXXX 代号，shipping_address 应是中介点
      anonymous_recipient,
      // B5 主动捐赠
      donation_pct } = req.body
    if (!product_id || !shipping_address) return void res.json({ error: '请提供商品ID和收货地址' })
    const anonymousFlag = anonymous_recipient ? 1 : 0
    const recipientCode = anonymousFlag === 1 ? generateRecipientCode() : null
    const donationPctNum = Number(donation_pct || 0)
    if (!DONATION_VALID_PCTS.has(donationPctNum)) {
      return void res.json({ error: 'donation_pct 必须是 0 / 0.005 / 0.01 / 0.02 / 0.05 之一', error_code: 'DONATION_PCT_INVALID' })
    }
    // 数量校验 + 限购
    const MAX_PER_ORDER = 10
    const reqQty = Math.floor(Number(req.body?.quantity ?? 1))
    if (!Number.isFinite(reqQty) || reqQty < 1) return void res.json({ error: '数量需 ≥ 1', error_code: 'QTY_INVALID' })
    if (reqQty > MAX_PER_ORDER) return void res.json({ error: `单笔订单最多 ${MAX_PER_ORDER} 件（限购）`, error_code: 'QTY_EXCEEDS_LIMIT', max_per_order: MAX_PER_ORDER })

    // C-2: 礼物订单参数校验
    let giftRecipientName: string | null = null
    let giftRecipientPhone: string | null = null
    let giftMessage: string | null = null
    if (is_gift) {
      if (!gift_recipient_name || String(gift_recipient_name).trim().length < 1) return void res.json({ error: '礼物订单需填收件人姓名' })
      giftRecipientName = String(gift_recipient_name).slice(0, 60)
      giftRecipientPhone = gift_recipient_phone ? String(gift_recipient_phone).slice(0, 30) : null
      giftMessage = gift_message ? String(gift_message).slice(0, 300) : null
    }

    // Wave B-5: 校验配送时间窗（可选）
    const VALID_DAY = new Set(['weekday', 'weekend', 'any'])
    const VALID_TIME = new Set(['morning', 'afternoon', 'evening', 'any'])
    let deliveryWindowJson: string | null = null
    if (delivery_window && typeof delivery_window === 'object') {
      const dt = String(delivery_window.day_type || 'any')
      const tr = String(delivery_window.time_range || 'any')
      const fl = delivery_window.flexible !== false
      if (!VALID_DAY.has(dt) || !VALID_TIME.has(tr)) {
        return void res.json({ error: '配送窗口参数无效' })
      }
      if (dt !== 'any' || tr !== 'any') {
        deliveryWindowJson = JSON.stringify({ day_type: dt, time_range: tr, flexible: fl })
      }
    }

    const product = await dbOne<Record<string, unknown>>(`SELECT p.*, u.id as seller_uid FROM products p
      JOIN users u ON p.seller_id = u.id WHERE p.id = ? AND p.status = 'active'`,
      [product_id])
    if (!product) return void res.json({ error: '商品不存在或已下架' })

    // Wave C-1: variants Phase 2 — 校验规格
    type VariantRow = { id: string; price_override: number | null; stock: number; options_json: string }
    let variant: VariantRow | null = null
    if (Number(product.has_variants) === 1) {
      if (!variant_id) return void res.json({ error: '该商品需选择规格', error_code: 'VARIANT_REQUIRED' })
      const v = await dbOne<VariantRow>(`SELECT id, price_override, stock, options_json
        FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1`,
        [variant_id, product_id])
      if (!v) return void res.json({ error: '规格不存在或已下架' })
      if (Number(v.stock) < reqQty) return void res.json({ error: `该规格库存不足（剩 ${v.stock}，需 ${reqQty}）`, error_code: 'STOCK_INSUFFICIENT', stock: v.stock })
      variant = v
      if (v.price_override != null) product.price = Number(v.price_override)
    } else if (variant_id) {
      return void res.json({ error: '该商品无规格选项，请勿传 variant_id' })
    } else {
      if ((product.stock as number) < reqQty) return void res.json({ error: `库存不足（剩 ${product.stock}，需 ${reqQty}）`, error_code: 'STOCK_INSUFFICIENT', stock: product.stock })
    }

    // Wave D-4: 限时促销 — 命中则覆盖 product.price 为 sale_price
    const flashSale = getActiveFlashSale(product.id as string, variant ? variant.id : null)
    if (flashSale) {
      product.price = Number(flashSale.sale_price)
    }

    // Wave D-4 P0-1: 价格保护（expected_price 不一致 → 409）
    if (expected_price != null) {
      const expected = Number(expected_price)
      if (Number.isFinite(expected) && Math.abs(expected - Number(product.price)) > 0.001) {
        return void res.status(409).json({
          error: 'price_changed',
          error_code: 'PRICE_CHANGED',
          message: '价格已变动（限时促销可能已结束或商品调价）',
          new_price: Number(product.price),
          old_price: expected,
        })
      }
    }

    // Wave A-3: 优惠券应用 — P1-1: flash sale 不可叠加 coupon
    let couponId: string | null = null
    let couponDiscount = 0
    if (coupon_code && typeof coupon_code === 'string' && coupon_code.trim()) {
      if (flashSale) {
        return void res.json({ error: '限时促销不可与优惠券叠加，请去掉优惠码', error_code: 'FLASH_NO_COUPON' })
      }
      const result = applyCouponToOrder(coupon_code, product.seller_uid as string, product_id, Number(product.price) * reqQty)
      if (!result.ok) return void res.json({ error: result.error, error_code: 'COUPON_INVALID' })
      couponId = result.coupon!.id
      couponDiscount = result.discount || 0
    }

    // 验证 session_token（如果提供）
    // RFC-016: 价格锁是【一次性】消费 — SELECT 校验 → mark used 之间【不能有 await】,
    //   否则两个并发下单会都读到 used_at=NULL 再各自 mark,复用同一 token(Codex #224)。
    //   故整块保持同步 better-sqlite3 调用(Node 单线程内原子,无让步);Phase 3 随订单路径迁 pg 行锁。
    if (session_token) {
      const session = db.prepare(`
        SELECT * FROM price_sessions WHERE token = ? AND product_id = ? AND user_id = ?
      `).get(session_token, product_id, user.id) as Record<string, unknown> | undefined
      if (!session) return void res.json({ error: 'session_token 无效，请重新调用 verify-price' })
      if (session.used_at) return void res.json({ error: 'session_token 已使用，请重新调用 verify-price' })
      if (new Date(session.expires_at as string) < new Date()) {
        return void res.json({ error: 'session_token 已过期（10分钟有效），请重新调用 verify-price' })
      }
      if ((session.price as number) !== (product.price as number)) {
        return void res.json({
          error: 'price_changed',
          message: `商品价格已变动：验证时 ${session.price} WAZ，当前 ${product.price} WAZ`,
          new_price: product.price,
          hint: '请重新调用 verify-price 获取新价格',
        })
      }
      db.prepare(`UPDATE price_sessions SET used_at = datetime('now') WHERE token = ?`).run(session_token)
    }

    const basePrice = product.price as number
    // RFC-014:全部金额在整数 base-units 上算(精确),再 toDecimal 落库/响应。
    //   多件：subtotal = basePrice × qty，减 coupon，再加保险（按 subtotal 计费）
    const basePriceU = toUnits(basePrice)
    const subtotalU = mulQty(basePriceU, reqQty)
    const priceAfterCouponU = Math.max(0, subtotalU - toUnits(couponDiscount))
    const insuranceRate = getProtocolParam<number>('order_insurance_rate', 0.01)
    const insurancePremiumU = buy_insurance ? mulRate(priceAfterCouponU, insuranceRate) : 0; const _ship = gateShippingForCreate(db, res, product as { shipping_template?: string | null }, String(product.seller_uid), req.body?.ship_to_region); if (!_ship) return  // PR-2 运费模板:有模板必选地区且须命中(400/409 已写);无模板=原行为
    const totalAmountU = Math.max(0, priceAfterCouponU + insurancePremiumU + _ship.feeU)   // 运费并入总额(与保险费同惯例;快照 orders.shipping_fee)
    // B5 主动捐赠 — 按订单总额 × 比例算（额外扣款，进 charity_fund）
    const donationAmountU = donationPctNum > 0 ? mulRate(totalAmountU, donationPctNum) : 0
    // decimal 视图(落库 / 下游 AP2 / 响应,均为 base-unit 干净值)
    const subtotal = toDecimal(subtotalU)
    const insurancePremium = toDecimal(insurancePremiumU)
    const totalAmount = toDecimal(totalAmountU)
    const donationAmount = toDecimal(donationAmountU); const shippingFee = toDecimal(_ship.feeU)
    // PR-4c:direct_p2p 分叉 —— 本金不入协议,跳过下方 escrow 预检/事务,改走直付建单(生产门+收款指令门+原子建单,仅锁卖家 fee-stake)。
    if (String(req.body?.payment_rail || '') === 'direct_p2p') return void createDirectPayResponse(res, db, { generateId, transition, appendOrderEvent, getProtocolParam }, { product, buyerId: user.id as string, reqQty, basePrice, totalAmount, totalAmountU, shippingAddress: String(shipping_address), directReceiveAccountId: (typeof req.body?.direct_receive_account_id === 'string' && req.body.direct_receive_account_id) ? String(req.body.direct_receive_account_id) : undefined, opts: { variantId: variant_id, hasVariants: Number(product.has_variants) === 1, flashActive: !!flashSale, couponCode: coupon_code, buyInsurance: !!buy_insurance, donationPct: donationPctNum, isGift: !!is_gift, anonymous: anonymousFlag === 1, deliveryWindow: !!delivery_window }, shipping: { region: _ship.region, fee: _ship.fee, estDays: _ship.estDays } })
    // 友好预检查(读):真正的守恒在下面的同步事务内(applyWalletDelta 绝对值落库)。
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet) return void res.status(500).json({ error: '钱包记录缺失', error_code: 'WALLET_MISSING' })
    if (toUnits(wallet.balance) < totalAmountU + donationAmountU) return void res.json({ error: `余额不足：需 ${(totalAmount + donationAmount).toFixed(2)} WAZ（含 ${donationAmount} WAZ 捐赠），当前 ${wallet.balance} WAZ` })
    const now = new Date()
    const orderId = generateId('ord')
    let autoAccepted = false; const _acceptModeAuto = (((product as { accept_mode?: string | null }).accept_mode ?? (await dbOne<{ store_accept_mode: string | null }>('SELECT store_accept_mode FROM users WHERE id = ?', [product.seller_uid]))?.store_accept_mode) === 'auto')  // 接单模式 v16:单品??店铺默认;'auto'→paid 后系统自动接单;escrow manual/未设=原流程(托管中间态+24h 超时退款)零钱路改动;tx 外 seam 读
    // P0: 整个下单流程原子化 — INSERT order + UPDATE wallet + UPDATE products + transition 任一步抛错全部回滚
    try {
      db.transaction(() => {
        // 推土机分享快照：从 buyer.sponsor_path 解析 L1/L2/L3，应用 region 限制
        const buyer = db.prepare("SELECT sponsor_id, sponsor_path, region FROM users WHERE id = ?").get(user.id) as { sponsor_id: string | null; sponsor_path: string | null; region: string | null }
        // 孤儿用户首次绑 sponsor：buyer 无 sponsor + 客户端传 sponsor_hint
        // 校验：① 非自己 ② 防环路 ③ hint 必须是 verified buyer
        // sponsor_hint from the client is now an invite code (permanent_code [+ -L/-R]) — resolve it to a
        // user id first; usr_xxx / @handle / handle no longer bind a sponsor (matches the narrowed surface).
        const sponsorHintRaw = (typeof req.body.sponsor_hint === 'string' && req.body.sponsor_hint) ? String(req.body.sponsor_hint) : null
        const sponsorHintRef = sponsorHintRaw ? resolveInviteCodeRef(sponsorHintRaw) : null
        if (!buyer.sponsor_id && sponsorHintRef && sponsorHintRef.userId !== user.id) {
          const hint = db.prepare("SELECT id, sponsor_path FROM users WHERE id = ? AND id NOT IN ('sys_protocol', ?)")
            .get(sponsorHintRef.userId, INTERNAL_AUDITOR_ID) as { id: string; sponsor_path: string | null } | undefined
          if (hint && isAllowedSponsor(hint.id)) {
            const hintPath = hint.sponsor_path || ''
            if (!hintPath.split('>').includes(user.id as string)) {
              const newPath = hint.sponsor_path ? `${hint.sponsor_path}>${hint.id}` : hint.id
              db.prepare("UPDATE users SET sponsor_id = ?, sponsor_path = ?, updated_at = datetime('now') WHERE id = ?")
                .run(hint.id, newPath, user.id as string)
              buyer.sponsor_id = hint.id
              buyer.sponsor_path = newPath
            }
          }
        }
        const maxLevels = (() => {
          const r = db.prepare("SELECT max_levels FROM region_config WHERE region = ? AND active = 1").get(buyer?.region || 'global') as { max_levels: number } | undefined
          return r?.max_levels ?? 3
        })()
        // 店铺推荐懒升级:在反推商品链【之前】尝试把"店铺推荐 + 推荐人真实成交过同款"升级为本商品归因,
        // 这样本订单快照就能拿到 L1/L2/L3(不覆盖已有有效直接归因)。
        maybePromoteShopReferralToProductAttribution(db, { internalAuditorId: INTERNAL_AUDITOR_ID, isAllowedSponsor }, product.id as string, product.seller_uid as string, user.id as string)
        // 商品分享奖励链（per-product），与 PV 系统 sponsor_path 完全解耦
        // 反推方向：谁分享了 product 给 buyer? → 该 sharer 是 L1
        const productChain = getProductShareChain(product.id as string, user.id as string, 3)
        const l1 = productChain[0]
        const l2 = productChain[1]
        const l3 = (maxLevels >= 3) ? productChain[2] : null
        const snapshotRate = Number(product.commission_rate ?? 0.10)

        // H-2 fix：buyer_region 在下单时快照写入，settleCommission/depositToFund 读快照不读活值
        const buyerRegionSnapshot = buyer?.region || 'global'
        // P2P：若为 P2P 商品，下单时快照 content_hash（争议时凭买家所见 hash 判定）
        const contentHashSnapshot = (Number(product.p2p_mode) === 1 && product.content_hash) ? String(product.content_hash) : null
        // RFC-008 stage 1：赔付背书快照恒为 0 → 违约只退款不没收、不印钱、零门槛(起步免赔付)。
        //   stake-required 模式(require_seller_stake=1)【尚未实现】且该 param 已被 governance 锁在 0(max=0,
        //   见 server.ts DEFAULT_PARAMS + 迁移,Codex #111)—— 故不读它(读了也只会是 0),避免"假开关"误导。
        //   Phase 3 钱路径迁移时在此按信誉算 backing = total×stake_rate 并原子锁 balance→staked、放开该 param。
        const stakeBacking = 0
        db.prepare(`INSERT INTO orders (
          id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
          status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
          pickup_deadline, delivery_deadline, confirm_deadline,
          l1_uid, l2_uid, l3_uid, snapshot_commission_rate, buyer_region, content_hash_at_order,
          delivery_window, variant_id, variant_options_snapshot,
          gift_recipient_name, gift_recipient_phone, gift_message, insurance_premium,
          anonymous_recipient, recipient_code, donation_amount, stake_backing, ship_to_region, shipping_fee, shipping_est_days
        ) VALUES (?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderId, product.id, user.id, product.seller_uid, reqQty, basePrice, totalAmount, totalAmount,
          shipping_address, notes || null,
          addHours(now, 24), addHours(now, 48), addHours(now, 120),
          addHours(now, 168), addHours(now, 336), addHours(now, 408),
          l1, l2, l3, snapshotRate, buyerRegionSnapshot, contentHashSnapshot,
          deliveryWindowJson,
          variant ? variant.id : null,
          variant ? variant.options_json : null,
          giftRecipientName, giftRecipientPhone, giftMessage, insurancePremium,
          anonymousFlag, recipientCode, donationAmount, stakeBacking, _ship.region, _ship.feeU > 0 || _ship.region ? shippingFee : null, _ship.estDays,
        )
        // 协议层：写 genesis 事件 — order 创建（必然是 buyer 自己）
        try {
          appendOrderEvent(db, {
            orderId,
            eventType: 'open',
            fromStatus: null,
            toStatus: 'created',
            actorId: user.id as string,
            actorRole: 'buyer',
            extra: {
              product_id:   product.id,
              seller_id:    product.seller_uid,
              quantity:     reqQty,
              unit_price:   basePrice,
              total_amount: totalAmount,
              variant_id:   variant ? variant.id : null,
            },
          })
        } catch (e) { console.warn('[order-chain] genesis event failed:', (e as Error).message) }
        // RFC-014:钱包托管锁定走绝对值落库(整数 base-units)
        applyWalletDelta(db, user.id as string, { balance: -totalAmountU, escrowed: totalAmountU })
        // B5：捐赠 — 从 balance 扣 + 进 charity_fund + 记一笔 donation txn（事务内原子）
        if (donationAmountU > 0) {
          applyWalletDelta(db, user.id as string, { balance: -donationAmountU })
          const cf = db.prepare("SELECT COALESCE(balance,0) balance, COALESCE(total_donated,0) total_donated FROM charity_fund WHERE id = 'main'").get() as { balance: number; total_donated: number } | undefined
          db.prepare(`UPDATE charity_fund SET balance = ?, total_donated = ?, updated_at = datetime('now') WHERE id = 'main'`)
            .run(toDecimal(toUnits(cf?.balance ?? 0) + donationAmountU), toDecimal(toUnits(cf?.total_donated ?? 0) + donationAmountU))
          db.prepare(`INSERT INTO charity_fund_txns (id, kind, from_user_id, to_user_id, amount, related_order_id, note)
                      VALUES (?, 'donation', ?, NULL, ?, ?, ?)`).run(
            generateId('cft'), user.id, donationAmount, orderId,
            `下单时捐赠 ${(donationPctNum * 100).toFixed(1)}%`)
          // 同步 charity_reputation（捐款荣誉）
          try { ensureCharityRep(db, user.id as string) } catch {}
          try {
            db.prepare(`UPDATE charity_reputation SET donation_total = donation_total + ?, last_active = datetime('now') WHERE user_id = ?`)
              .run(donationAmount, user.id)
          } catch {}
        }
        // Wave C-1: 有 variant → 同时 -qty variant.stock 和 product.stock（aggregate 保持一致）
        // P1-3: 条件 UPDATE + changes() 防多 worker 竞态超卖
        if (variant) {
          const upd = db.prepare('UPDATE product_variants SET stock = stock - ?, updated_at = datetime(\'now\') WHERE id = ? AND stock >= ?').run(reqQty, variant.id, reqQty)
          if (upd.changes !== 1) throw new Error('VARIANT_STOCK_RACE')
        }
        const updP = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(reqQty, product.id, reqQty)
        if (updP.changes !== 1) throw new Error('PRODUCT_STOCK_RACE')
        checkStockAndMaybeDelist(String(product.id))
        // Wave D-4: flash sale sold_count 原子递增（max_qty 校验）
        if (flashSale) {
          const updF = db.prepare(`UPDATE flash_sales SET sold_count = sold_count + ?
            WHERE id = ? AND (max_qty = 0 OR sold_count + ? <= max_qty) AND ends_at > datetime('now')`).run(reqQty, flashSale.id, reqQty)
          if (updF.changes !== 1) throw new Error('FLASH_SALE_EXHAUSTED')
        }
        // Wave A-3: 记录 coupon 使用 + 增加 uses_count
        if (couponId) {
          db.prepare('UPDATE orders SET coupon_id = ?, coupon_discount = ? WHERE id = ?')
            .run(couponId, couponDiscount, orderId)
          db.prepare('UPDATE coupons SET uses_count = uses_count + 1 WHERE id = ?').run(couponId)
        }
        transition(db, orderId, 'paid', user.id as string, [], '模拟支付完成')
        notifyTransition(db, orderId, 'created', 'paid')

        // 里程碑 3-C：放置同支检测（监测+审计；不阻断）
        try {
          auditSponsorChainCross(orderId, user.id as string, String(product.seller_uid), buyer.sponsor_path)
        } catch (e) { console.error('[M3-C audit]', e) }

        // 自动接单:卖家接单模式 'auto'(v16)或 auto_accept Skill。
        if (_acceptModeAuto || shouldAutoAccept(db, orderId)) {
          const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
          if (sysUser) {
            const ar = transition(db, orderId, 'accepted', sysUser.id, [], _acceptModeAuto ? '⚡ 自动接单(卖家接单模式设置)' : '⚡ auto_accept Skill 自动接单')
            if (ar.success) { notifyTransition(db, orderId, 'paid', 'accepted'); autoAccepted = true }
          }
        }
      })()
    } catch (e) {
      const msg = (e as Error).message
      console.error('[POST /api/orders tx]', msg)
      if (msg === 'VARIANT_STOCK_RACE' || msg === 'PRODUCT_STOCK_RACE') {
        return void res.status(409).json({ error: '库存已被抢光，请重试', error_code: 'STOCK_DEPLETED' })
      }
      if (msg === 'FLASH_SALE_EXHAUSTED') {
        return void res.status(409).json({ error: '限时促销名额已售罄', error_code: 'FLASH_EXHAUSTED' })
      }
      return void res.status(500).json({ error: '下单失败，请重试', error_code: 'ORDER_TXN_FAILED' })
    }

    try { broadcastSystemEvent('order_created', '📦', `订单创建 ${orderId} · ${totalAmount} WAZ`, orderId) } catch {}

    // AP2 (B.4 b) — Cart + Payment Mandate 双输出;签名失败不阻断主流程
    let ap2_cart_mandate: Record<string, unknown> | null = null
    let ap2_payment_mandate: Record<string, unknown> | null = null
    try {
      const productName = typeof product.title === 'string' ? product.title : String(product.id)
      const cartOut = buildCartMandate({
        issuerDid: 'did:web:webaz.xyz',
        issuerAddress: issuerAddress(),
        principal: { role: 'user', id: user.id as string },
        orderId,
        items: [{ sku: String(product.id), name: productName, quantity: reqQty, unit_price: basePrice, line_total: subtotal }],
        subtotal,
        fees: {
          ...(couponDiscount > 0 ? { coupon_discount: -couponDiscount } as Record<string, number> : {}),
          ...(insurancePremium > 0 ? { insurance: insurancePremium } : {}),
          ...(donationAmount > 0 ? { donation: donationAmount } : {}),
        },
        total: totalAmount,
        currency: 'WAZ',
      })
      ap2_cart_mandate = await signMandate(cartOut, signPassport)

      const payOut = buildPaymentMandate({
        issuerDid: 'did:web:webaz.xyz',
        issuerAddress: issuerAddress(),
        payer: { role: 'user', id: user.id as string },
        payee: { role: 'merchant', id: String(product.seller_uid) },
        amount: totalAmount,
        currency: 'WAZ',
        paymentMethod: 'webaz_escrow',
        orderId,
        escrowReleaseCondition: 'buyer_confirms_receipt_or_auto_after_window',
      })
      ap2_payment_mandate = await signMandate(payOut, signPassport)
    } catch { /* AP2 mandate 失败仅影响 AP2-aware agent,主流程已成功 */ }

    res.json({
      success: true,
      order_id: orderId,
      total_amount: totalAmount,
      auto_accepted: autoAccepted || undefined,
      ap2_cart_mandate,
      ap2_payment_mandate,
    })
  })
}
