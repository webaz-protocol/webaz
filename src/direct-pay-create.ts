/**
 * Direct Pay (Rail 1) — direct_p2p 订单【原子创建】helper (PR-4c)。
 *
 * 边界(铁律):
 *  - 本金(货款)【不入协议】:escrow_amount=0,【不写 buyer wallet / 不写 escrow / 不动 principal】。
 *  - 平台费【不在建单时收/锁】(设计稿 DIRECT-PAY-FEE-RECEIVABLE-DESIGN.INTERNAL.md):
 *    建单只过【首单宽限 + 预充值续用门】(首单宽限放行;否则 available_prepay ≥ 在途预估费 + 本单费,fail-closed),【无任何建单资金写】。
 *    平台费在【完成结算时】记一笔应收(accrueFeeReceivable,见 settleOrder direct_p2p 分支)。
 *  - 原子:INSERT order → genesis 事件 → created→direct_pay_window → 扣库存,全在一个 db.transaction;任一步失败【整体回滚】。
 *  - 不碰 refund/settlement/commission/fund/tokenomics;direct_p2p 排除佣金/PV(l1/l2/l3 留空)。
 *  - 收款指令是【调用方已读取并快照】的卖家自填文本(WebAZ 不验证/不路由/不托管/不判断币种)。
 *  - direct_p2p v1:不支持 variant/flash/coupon/donation(escrow-only);仅简单商品库存。
 */
import type Database from 'better-sqlite3'
import type { Response } from 'express'
import { type Units } from './money.js'
import { feeUnitsForOrder, estimateOpenDirectPayFeeUnits, readAvailableFeePrepayUnits, sellerDirectPayGraceEligible, feePrepayGateOk } from './direct-pay-fee-ar.js'
import { sellerBaseBondEntrySatisfied } from './direct-pay-base-bond-entry.js'
import { getActivePaymentInstruction } from './direct-receive-payment-instruction.js'
import { getAccount } from './direct-receive-accounts.js'  // Rail1 D2:买家所选多收款账号(dual-read;缺省回落 legacy 单条 instruction)
import { evaluateDirectPayLaunchControls, readDirectPayControlsConfig, sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear, sellerDirectPayBreakerTripped, coarsenBuyerFacingDirectPayCode, type DirectPayControlsConfig } from './direct-pay-controls.js'
import { checkDeferralQuota, readDeferralQuotaConfig } from './direct-pay-deferral-quota.js'
import { enforceCollateralExposureGate } from './merchant-bond-exposure.js'  // §6.5 抵押背书开放敞口上限(休眠安全:collateral=0 时 N/A)
import { productStoreVerified } from './product-verification.js'
import { sellerExemptFromPerProduct } from './store-verification.js'
import { safeRunDirectPayAmlMonitor } from './direct-pay-aml-monitor.js'
import { getUsdRatesSync, convertUsdcToLocal, SUPPORTED_CURRENCIES, type Currency } from './fx-rates.js'  // 审计项 E:建单冻结应付参考换算(display-only,同步缓存)
import { createNotification } from './layer2-business/L2-6-notifications/notification-engine.js'  // 审计项 B:直付转移此前通知黑洞(卖家不知有单/已付款)
import { buildTradeTermsSnapshot, writeTradeTermsSnapshot } from './trade-terms.js'  // S0 交易条款快照(证据,fail-soft 零钱路)

export interface DirectPayCreateDeps {
  generateId: (prefix: string) => string
  transition: (db: Database.Database, orderId: string, toStatus: string, actorId: string, evidenceIds: string[], notes: string) => { success: boolean; error?: string }
  appendOrderEvent: (db: Database.Database, args: Record<string, unknown>) => void
}
/** 建单时冻结的入口控制 policy 快照(PR-5b;frozen-at-create,后续 protocol_params 改不影响已建单)。 */
export interface DirectPayPolicySnapshot {
  enabled: boolean; railBreakerTripped: boolean; region: string; regionAllowlist: string[]
  perTxCapUnits: Units; sellerBreakerTripped: boolean; decisionCode: string
}
/** 买家所选收款账号快照(非敏感元数据 + qr_ref)。legacy 单条 instruction 路径 = null。
 *  payable_*(审计项 E,contract v13 additive):下单时刻冻结的【应付参考换算】—— 买家 UI/时间线/卖家对账
 *  引用同一稳定数字,不再随实时汇率漂移。display-only 参考价(rate 可 stale,以卖家收款说明为准),绝非结算承诺;
 *  账户币种为 USD/USDC 或不支持换算时只有 payable_usdc,payable_approx 缺省 → 前端回落仅 USDC 展示,零阻断。 */
export interface DirectPayAccountSnapshot {
  account_id: string; method: string | null; currency: string | null; label: string | null; qr_ref: string | null
  payable_usdc?: number; payable_approx?: number; payable_currency?: string; payable_rate?: number; payable_asof?: string; payable_stale?: boolean
}
/** 应付参考换算快照(审计项 E):同步缓存 FX(display-only,fallback 亦可,永不抛/永不阻塞建单)。
 *  USD/USDC/未知币种 → 只记 payable_usdc(前端回落仅 USDC);换算失败同样只记 usdc,建单照常。 */
export function buildPayableSnapshot(totalUsdc: number, accountCurrency: string | null): Partial<DirectPayAccountSnapshot> {
  const base: Partial<DirectPayAccountSnapshot> = { payable_usdc: totalUsdc }
  const cur = String(accountCurrency || '').toUpperCase()
  if (!cur || cur === 'USD' || cur === 'USDC' || !(SUPPORTED_CURRENCIES as readonly string[]).includes(cur)) return base
  try {
    const snap = getUsdRatesSync()
    const approx = convertUsdcToLocal(totalUsdc, cur as Currency, snap.rates)
    if (!Number.isFinite(approx)) return base
    return { ...base, payable_approx: Math.round(approx * 100) / 100, payable_currency: cur, payable_rate: snap.rates[cur as Currency], payable_asof: snap.as_of, payable_stale: snap.stale }
  } catch { return base }
}

export interface DirectPayCreateArgs {
  productId: string; sellerId: string; buyerId: string; quantity: number
  unitPrice: number; totalAmount: number
  instructionSnapshot: string; windowDeadlineIso: string; shippingAddress: string
  accountSnapshot: DirectPayAccountSnapshot | null
  snapshot: DirectPayPolicySnapshot
  /** 手动接单(v16):'manual' → 先进 pending_accept(不开付款窗口),卖家确认接单才进 direct_pay_window。 */
  acceptMode: 'auto' | 'manual'
  /** manual 时的接单截止(ISO;超时无责取消+回补库存,专属 cron)。 */
  pendingAcceptDeadlineIso?: string
  /** 运费快照(PR-2):运费已并入 totalAmount,此处只是快照三列(region/fee/est_days;无模板=null)。
   *  quoteRequired(PR-3):模板外地区询价 —— 强制走 pending_accept,卖家报价+买家确认后才进付款窗。 */
  shipping?: { region: string | null; fee: number; estDays: string | null; quoteRequired?: boolean; freeThresholdApplied?: boolean }
}

/** 原子创建 direct_p2p 订单。成功返回 { orderId };任一步失败抛错(调用方回 409,事务已回滚)。 */
export function createDirectPayOrder(db: Database.Database, deps: DirectPayCreateDeps, args: DirectPayCreateArgs): { orderId: string } {
  const { generateId, transition, appendOrderEvent } = deps
  const orderId = generateId('ord')
  db.transaction(() => {
    // 本金不入协议:escrow_amount=0,不写 buyer wallet。同一 INSERT 写入【入口控制 policy 快照】(frozen-at-create)。
    const s = args.snapshot
    const quoteRequired = !!args.shipping?.quoteRequired
    const manual = args.acceptMode === 'manual' || quoteRequired   // 询价单必须先接单报价(无论接单模式)
    // manual:不设 window deadline(接单时才起表),记 accept_mode 快照 + 接单截止。
    db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
      status, payment_rail, shipping_address, direct_pay_instruction_snapshot, direct_pay_account_snapshot, direct_pay_window_deadline,
      accept_mode_snapshot, pending_accept_deadline, ship_to_region, shipping_fee, shipping_est_days, shipping_quote_required,
      direct_pay_enabled_snapshot, direct_pay_rail_breaker_snapshot, direct_pay_region_snapshot,
      direct_pay_region_allowlist_snapshot, direct_pay_per_tx_cap_units_snapshot, direct_pay_seller_breaker_snapshot, direct_pay_decision_code)
      VALUES (?,?,?,?,?,?,?,0,'created','direct_p2p',?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`)
      .run(orderId, args.productId, args.buyerId, args.sellerId, args.quantity, args.unitPrice, args.totalAmount,
        args.shippingAddress, args.instructionSnapshot, args.accountSnapshot ? JSON.stringify(args.accountSnapshot) : null,
        manual ? null : args.windowDeadlineIso, args.acceptMode, manual ? (args.pendingAcceptDeadlineIso ?? null) : null,
        args.shipping?.region ?? null, (args.shipping && (args.shipping.fee > 0 || args.shipping.region)) ? args.shipping.fee : null, args.shipping?.estDays ?? null, quoteRequired ? 1 : null,
        s.enabled ? 1 : 0, s.railBreakerTripped ? 1 : 0, s.region,
        JSON.stringify(s.regionAllowlist), s.perTxCapUnits, s.sellerBreakerTripped ? 1 : 0, s.decisionCode)
    appendOrderEvent(db, {
      orderId, eventType: 'open', fromStatus: null, toStatus: 'created', actorId: args.buyerId, actorRole: 'buyer',
      extra: { product_id: args.productId, seller_id: args.sellerId, quantity: args.quantity, total_amount: args.totalAmount, payment_rail: 'direct_p2p' },
    })
    // created → direct_pay_window(auto)| pending_accept(manual,v16:卖家确认接单前不开付款窗口)。失败回滚。
    const rc = manual
      ? transition(db, orderId, 'pending_accept', 'sys_protocol', [], '手动接单:等待卖家确认接单(付款前,不展示收款信息)')
      : transition(db, orderId, 'direct_pay_window', 'sys_protocol', [], 'Rail1 直付:进入付款窗口(平台费完成时记应收,建单不收费)')
    if (!rc.success) throw new Error(rc.error || `transition→${manual ? 'pending_accept' : 'direct_pay_window'} failed`)
    // 【无建单资金写】平台费完成时 accrue;建单门是【首单宽限 + 预充值续用】只读门(在 createDirectPayResponse 内,建单前)。
    // 扣库存(原子;售罄即抛回滚)。变体/flash 直付 v1 不支持。
    const upd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(args.quantity, args.productId, args.quantity)
    if (upd.changes !== 1) throw new Error('stock depleted')
  })()
  // S0 条款快照:冻结下单时的时效/退货/清关/税责声明(事务外 fail-soft —— 快照是证据非计价输入,缺失=pre-S0 同待遇)
  writeTradeTermsSnapshot(db, orderId, buildTradeTermsSnapshot(db, {
    productId: args.productId, sellerId: args.sellerId,
    shipping: { source: args.shipping?.quoteRequired ? 'quote_pending' : (args.shipping?.region ? 'template' : 'none'), region: args.shipping?.region ?? null, fee: args.shipping?.quoteRequired ? null : ((args.shipping && (args.shipping.fee > 0 || args.shipping.region)) ? args.shipping.fee : null), estDays: args.shipping?.estDays ?? null, freeThresholdApplied: args.shipping?.freeThresholdApplied },
    acceptModeEffective: args.acceptMode,
  }))
  return { orderId }
}

/** direct_p2p v1 不支持的 escrow-only 修饰快照(调用方从 req.body / 计算结果收集)。任一为真 → fail-closed。 */
export interface DirectPayUnsupportedOpts {
  variantId?: unknown; hasVariants?: boolean; flashActive?: boolean; couponCode?: unknown
  buyInsurance?: boolean; donationPct?: number; isGift?: boolean; anonymous?: boolean; deliveryWindow?: boolean
}

/**
 * direct_p2p 建单【完整分叉处理】(供 orders-create.ts 单行调用,保持该 route 文件不臌胀)。
 * 顺序:① v1 only-simple-product 门(任一 escrow-only 修饰 → fail-closed)→ ② 生产 base-bond 门(production receipt,
 *   非仅 privilege active)→ ③ 收款指令门(只读+快照)→ ④ 原子建单。任一门未过 → 直接写 res 并 return,
 *   【绝不】建单 / 锁质押 / 扣库存。不碰 buyer wallet/escrow/principal/refund/settlement。
 */
export function createDirectPayResponse(
  res: Response, db: Database.Database, deps: DirectPayCreateDeps & { getProtocolParam: <T>(k: string, fb: T) => T },
  ctx: { product: Record<string, unknown>; buyerId: string; reqQty: number; basePrice: number; totalAmount: number; totalAmountU: Units; shippingAddress: string; directReceiveAccountId?: string; opts?: DirectPayUnsupportedOpts; shipping?: { region: string | null; fee: number; estDays: string | null; quoteRequired?: boolean; freeThresholdApplied?: boolean } },
): void {
  // ① direct_p2p v1 = simple product only。escrow-only 修饰一律 fail-closed(本片不支持,不半支持)。
  const o = ctx.opts ?? {}
  if (o.hasVariants || o.variantId != null) { res.status(409).json({ error: '直付 v1 仅支持简单商品(无规格);该商品有规格或传了 variant_id', error_code: 'DIRECT_PAY_SIMPLE_PRODUCT_ONLY' }); return }
  const unsupported = o.flashActive ? 'flash_sale' : o.couponCode ? 'coupon' : o.buyInsurance ? 'insurance' : (Number(o.donationPct) > 0) ? 'donation' : o.isGift ? 'gift' : o.anonymous ? 'anonymous_recipient' : o.deliveryWindow ? 'delivery_window' : null
  if (unsupported) { res.status(409).json({ error: `直付 v1 不支持该选项:${unsupported}`, error_code: 'DIRECT_PAY_UNSUPPORTED_OPTION', option: unsupported }); return }
  const sellerId = ctx.product.seller_uid as string
  // ② Phase 4a 入口控制(SSOT,默认 fail-closed):全局开关/熔断 → 地区白名单 → 单笔上限 → production base-bond → KYC/制裁 → AML 断路器。
  //    任一不过即拒(不建单/不锁质押/不扣库存)。base-bond 已折进控制面(DIRECT_PAY_NOT_AVAILABLE),不再单独判。
  const cfg: DirectPayControlsConfig = readDirectPayControlsConfig(deps.getProtocolParam)
  const sellerBreakerTripped = sellerDirectPayBreakerTripped(db, sellerId)
  const ctrl = evaluateDirectPayLaunchControls(cfg, {
    amountUnits: ctx.totalAmountU,
    sellerBreakerTripped,
    baseBondSatisfied: sellerBaseBondEntrySatisfied(db, sellerId, new Date().toISOString()),
    kycSanctionsPassed: sellerDirectPayKybPassed(db, sellerId) && sellerDirectPaySanctionsClear(db, sellerId),
    amlClear: sellerDirectPayAmlClear(db, sellerId),
  })
  // control deny 发生在【任何 DB write / order insert / fee-stake lock / stock decrement 之前】(fail-closed)。
  //   买家面脱敏:卖家私密拒因(暂停/保证金/KYC·制裁/AML)收敛为通用 SELLER_NOT_ELIGIBLE,与 availability 同源,
  //   不向买家泄露卖家具体合规状态;全局/运营类(DISABLED/REGION/CAP)原样透出。精确 code 由 controls 单测覆盖。
  if (!ctrl.ok) { const code = coarsenBuyerFacingDirectPayCode(ctrl.error_code); res.status(ctrl.status).json({ error_code: code, error: code === ctrl.error_code ? ctrl.reason : '该卖家暂不支持直付' }); return }
  // 硬门:该产品必须【单独】通过验证 —— 防"验证一个店再上架一堆假货"。豁免路径:卖家店铺已 verified 且被 admin 勾选
  //   per_product_exempt(申请一次店铺即可),则其所有商品免逐品。combiner = productVerified OR sellerExempt。
  //   都不满足 → direct-pay 不可用(产品级、非敏感,买家退回托管轨)。fail-closed,在任何 DB write 前。
  if (!(productStoreVerified(db, ctx.product.id as string) || sellerExemptFromPerProduct(db, sellerId))) { res.status(409).json({ error_code: 'DIRECT_PAY_PRODUCT_NOT_VERIFIED', error: '该商品暂不支持直付(待平台验证),请使用托管交易' }); return }
  // 收款目标解析(dual-read):买家选了具体收款账号 → 用该账号(须属本卖家且 active,否则 fail-closed,【绝不】静默回落);
  //   没选 → 回落 legacy 单条 instruction(向后兼容:只有旧单条说明的卖家照旧可下单)。快照冻结买家所见,卖家事后改/停用不影响。
  let instructionSnapshot: string
  let accountSnapshot: DirectPayAccountSnapshot | null = null
  const chosenAccountId = ctx.directReceiveAccountId
  if (chosenAccountId) {
    const acc = getAccount(db, chosenAccountId)
    if (!acc || acc.seller_id !== sellerId || acc.status !== 'active') { res.status(409).json({ error: '所选收款账号无效或已停用', error_code: 'DIRECT_RECEIVE_ACCOUNT_INVALID' }); return }
    instructionSnapshot = acc.instruction
    accountSnapshot = { account_id: acc.id, method: acc.method, currency: acc.currency, label: acc.label, qr_ref: acc.qr_image_ref, ...buildPayableSnapshot(ctx.totalAmount, acc.currency) }
  } else {
    const instr = getActivePaymentInstruction(db, sellerId)
    if (!instr) { res.status(409).json({ error: '卖家未设置收款说明,无法创建直付订单', error_code: 'NO_PAYMENT_INSTRUCTION' }); return }
    instructionSnapshot = instr.instruction
  }
  // ③ 缓交期额度门(launch blocker):靠 active deferral 入场(无生产 bond)的卖家,缓交期内笔数/累计金额压低。
  //   控制面全过后、任何 DB write 之前判(fail-closed);非缓交卖家 = no-op。超额 → 409,绝不建单。
  const quota = checkDeferralQuota(db, sellerId, ctx.totalAmountU, new Date().toISOString(), readDeferralQuotaConfig(deps.getProtocolParam))
  // 买家面脱敏:缓交额度拒因(笔数/金额)也收敛为通用 SELLER_NOT_ELIGIBLE,不向买家泄露卖家处于缓交/超额。
  //   精确 code(quota.code)留在 checkDeferralQuota 返回值 + 其单测,供运营/调试。
  if (!quota.ok) { res.status(409).json({ error_code: coarsenBuyerFacingDirectPayCode(quota.code), error: '该卖家暂不支持直付' }); return }
  // 审计项 G:单买家·单卖家在途直付单上限(param direct_pay.max_open_per_buyer_seller,默认 5)——
  //   防单个买家刷单锁库存(建单即扣库存,窗口+宽限可占 ~52h)+ 耗尽卖家缓交额度的 griefing。只读门,任何写之前;
  //   买家自身行为所致 → 精确 code 直接透出(非卖家隐私,无需脱敏)。
  const openCap = Math.max(1, Number(deps.getProtocolParam<number>('direct_pay.max_open_per_buyer_seller', 5)) || 5)
  const openN = (db.prepare(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND seller_id = ? AND payment_rail = 'direct_p2p' AND status IN ('pending_accept','direct_pay_window','direct_expired_unconfirmed','accepted','payment_query')`).get(ctx.buyerId, sellerId) as { n: number }).n
  if (openN >= openCap) { res.status(429).json({ error_code: 'DIRECT_PAY_TOO_MANY_OPEN', error: `你在该卖家已有 ${openN} 笔进行中的直付订单(上限 ${openCap}),请先完成或取消后再下单` }); return }
  // §6.5 抵押背书开放敞口上限(backend create-gate)。休眠安全:无真实链上抵押(collateral=0)→ N/A;
  //   有抵押才读 exposure_factor_bps(fail-closed)+ 比较 open_exposure+new ≤ collateral×bps/10000。
  //   当前 merchant_bond 关闭、无 active 存款 → 对缓交卖家零影响(返回 ok)。买家面脱敏。
  const expGate = enforceCollateralExposureGate(db, sellerId, ctx.totalAmountU, deps.getProtocolParam)
  if (!expGate.ok) { res.status(409).json({ error_code: coarsenBuyerFacingDirectPayCode(expGate.error_code), error: '该卖家暂不支持直付' }); return }
  const feeU = feeUnitsForOrder(ctx.totalAmountU, ctx.product.source as string)
  // 平台服务费【首单宽限 + 预充值续用门】(替代旧 fee-stake 预付,非赊账):
  //   ① 首单宽限:商家从无 direct_p2p 成交且无在途单 → 放行第一笔(降低首次使用摩擦;其余资格门照旧已判)。
  //   ② 非首单:available_prepay(Σ预充值 + Σ调整 − Σ已计提费)≥ 在途单预估费 + 本单预估费,否则拒。
  //   纯只读门(无任何资金写),在任何 DB write 前。买家面脱敏(FEE_PREPAY_INSUFFICIENT → SELLER_NOT_ELIGIBLE);
  //   fail-closed:grace 查询异常→不给宽限;available 读不到→0→拒非首单。预付款=商家平台服务费,非买家货款/escrow/保证金。
  if (!feePrepayGateOk({
    graceEligible: sellerDirectPayGraceEligible(db, sellerId),
    availablePrepayUnits: readAvailableFeePrepayUnits(db, sellerId),
    openOrdersEstFeeUnits: estimateOpenDirectPayFeeUnits(db, sellerId),
    newOrderFeeUnits: feeU,
  })) { res.status(409).json({ error_code: coarsenBuyerFacingDirectPayCode('FEE_PREPAY_INSUFFICIENT'), error: '该卖家暂不支持直付' }); return }
  const windowHours = deps.getProtocolParam<number>('direct_pay.payment_window_hours', 4)
  // 手动接单模式(v16):单品覆盖 ?? 店铺默认 ?? 'auto'。快照进订单(卖家事后改不影响在途单)。
  //   'manual' → 先进 pending_accept:不开付款窗口、不展示收款信息(时序门=非托管唯一正确的付款风控)。
  const storeMode = (db.prepare('SELECT store_accept_mode FROM users WHERE id = ?').get(sellerId) as { store_accept_mode: string | null } | undefined)?.store_accept_mode
  const rawMode = (ctx.product as { accept_mode?: string | null }).accept_mode ?? storeMode
  const acceptMode: 'auto' | 'manual' = rawMode === 'manual' ? 'manual' : 'auto'
  const acceptWindowHours = Math.max(1, Number(deps.getProtocolParam<number>('direct_pay.accept_window_hours', 24)) || 24)
  try {
    const { orderId } = createDirectPayOrder(db, deps, {
      productId: ctx.product.id as string, sellerId, buyerId: ctx.buyerId, quantity: ctx.reqQty,
      unitPrice: ctx.basePrice, totalAmount: ctx.totalAmount,
      instructionSnapshot, accountSnapshot, windowDeadlineIso: new Date(Date.now() + windowHours * 3600_000).toISOString(),
      shippingAddress: ctx.shippingAddress, acceptMode, shipping: ctx.shipping,
      pendingAcceptDeadlineIso: (acceptMode === 'manual' || ctx.shipping?.quoteRequired) ? new Date(Date.now() + acceptWindowHours * 3600_000).toISOString() : undefined,
      // frozen-at-create policy 快照:control 全过(ctrl.ok)才到此,decisionCode='OK'。
      snapshot: { enabled: cfg.enabled, railBreakerTripped: cfg.railBreakerTripped, region: cfg.region, regionAllowlist: cfg.regionAllowlist, perTxCapUnits: cfg.perTxCapUnits, sellerBreakerTripped, decisionCode: 'OK' },
    })
    // PR-6C: 建单事务已提交后,运行【append-only AML 监控】(fail-soft;命中治理阈值即 append aml_flags,仅影响【后续】
    //   create/availability 的 #107 breaker)。safe 包装吞异常 → 监控失败【绝不】回流成建单失败,也不碰当前订单。
    safeRunDirectPayAmlMonitor(db, { sellerId, orderId, nowIso: new Date().toISOString(), getProtocolParam: deps.getProtocolParam })
    // 审计项 B(N2):通知卖家。manual → 待接单提醒(带截止);auto → 原"等买家付款"。fail-soft 不阻断建单响应。
    try {
      if (ctx.shipping?.quoteRequired) {
        createNotification(db, sellerId, orderId, 'direct_pay_quote_needed', '🛎️ 新直付订单(模板外地区),待你报价运费', `商品「${String(ctx.product.title || '').slice(0, 40)}」× ${ctx.reqQty},货款 ${ctx.totalAmount} USDC,收货地区 ${ctx.shipping.region ?? '-'} 不在你的运费模板内。请在 ${acceptWindowHours} 小时内核实可达并报价(运费+预计时效),买家确认后才进入付款;超时订单自动取消。`, { templateKey: 'dp_quote_needed', params: { product: String(ctx.product.title || '').slice(0, 40), qty: ctx.reqQty, amount: ctx.totalAmount, region: ctx.shipping.region ?? '-', hours: acceptWindowHours } })
      } else if (acceptMode === 'manual') {
        createNotification(db, sellerId, orderId, 'direct_pay_pending_accept', '🛎️ 新直付订单,待你确认接单', `商品「${String(ctx.product.title || '').slice(0, 40)}」× ${ctx.reqQty},应付 ${ctx.totalAmount} USDC。请在 ${acceptWindowHours} 小时内确认接单(核实可发货/物流),超时订单自动取消;接单后买家才会看到收款方式。`, { templateKey: 'dp_pending_accept_new', params: { product: String(ctx.product.title || '').slice(0, 40), qty: ctx.reqQty, amount: ctx.totalAmount, hours: acceptWindowHours } })
      } else {
        createNotification(db, sellerId, orderId, 'direct_pay_order_created', '🛒 新直付订单,等买家付款', `商品「${String(ctx.product.title || '').slice(0, 40)}」× ${ctx.reqQty},应付 ${ctx.totalAmount} USDC。买家完成场外付款并标记后你会收到发货提醒。`, { templateKey: 'dp_new_order', params: { product: String(ctx.product.title || '').slice(0, 40), qty: ctx.reqQty, amount: ctx.totalAmount } })
      }
    } catch { /* 通知失败不阻断 */ }
    // ⚠️ 不在 create 响应里下发卖家收款说明(payment_instruction/label)——D1/D2 both-acked 前不得泄露(响应契约门,
    //   非仅 UI 软门)。买家先完成披露 ack,再经 GET /orders/:id 读取 redaction-gated 的 direct_pay_instruction_snapshot。
    //   manual 单更进一步:pending_accept 阶段【状态门】也挡收款信息(orders-read),卖家接单后才可见。
    const _pending = acceptMode === 'manual' || !!ctx.shipping?.quoteRequired
    res.json({
      success: true, order_id: orderId, status: _pending ? 'pending_accept' : 'direct_pay_window', payment_rail: 'direct_p2p',
      shipping_quote_required: ctx.shipping?.quoteRequired || undefined,
      note: ctx.shipping?.quoteRequired
        ? '收货地区在卖家运费模板之外:卖家将核实可达性并报价运费/时效,你确认新总额后才进入付款环节;超时未报价将自动取消,你无需任何操作。'
        : _pending
          ? '本单为手动接单:卖家确认可发货并接单后,你才会看到收款方式并进入付款环节;超时未接单将自动取消,你无需任何操作。'
          : '本金不经 WebAZ;完成 D1/D2 风险确认(Passkey)后即可在订单页查看卖家收款说明,请【场外】付款后点"我已付款"。本档无经济保障、不退款,仅对卖家信誉处罚。',
    })
  } catch (e) {
    res.status(409).json({ error: '直付订单创建失败:' + (e as Error).message, error_code: 'DIRECT_PAY_CREATE_FAILED' })
  }
}
