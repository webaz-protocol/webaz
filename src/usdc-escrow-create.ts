/**
 * USDC 合约担保 PR-B3 — 'usdc_escrow' 轨建单(对应合约 contracts/WebazEscrow.sol,#518)。
 *
 * 与两条旧轨的本质区别:
 *   - WAZ escrow:本金锁 wallets.escrowed(模拟)—— 本轨【零 wallets 写】,本金只进链上合约;
 *   - direct_p2p:本金场外、无保障 —— 本轨本金有合约托管,无需收款指令披露门(收款地址是公开链上标识)。
 *
 * v1 建单门(全部在任何 DB write 之前,fail-closed):
 *   ① 渠道开关 payment_rail_usdc_escrow_enabled(默认关)② USDC_ESCROW_CONTRACT env 已配
 *   ③ 简单商品 + 不支持选项拒(镜像 direct_p2p v1 清单)④ 卖家有 active 收款地址(即卖家 opt-in)
 *   ⑤ 卖家 KYB approved + 制裁清白(AML=INVARIANT,与 Rail 1 同一谓词)⑥ 单笔 ≤ per-tx cap(镜像合约)
 *   ⑦ 单买家·单卖家在途上限。Rail 1 的 bond/缓交/fee-prepay 门不适用(平台费在链上 pull,无 AR 坏账)。
 *
 * 状态:建单落 'created' + pay_deadline(等链上 Deposited;watcher PR-B4 确认后才 → paid,绝不假 success)。
 * voucher 签发在付款时(B6:买家连钱包后才知道 buyer 地址,EIP-712 digest 含 buyer)—— 本文件不签不存 intents。
 */
import type { Response } from 'express'
import type Database from 'better-sqlite3'
import { toUnits, type Units } from './money.js'
import { wazEscrowChannelOn } from './waz-escrow-channel.js'
import { listActivePayoutAddresses } from './usdc-escrow-store.js'
import { sellerDirectPayKybPassed, sellerDirectPaySanctionsClear } from './direct-pay-controls.js'
import { AgentSpendCapExceeded, getAgentSpendCapViolation } from './agent-spend-cap.js'

export function usdcEscrowRailEnabled(getProtocolParam: <T>(k: string, fb: T) => T): boolean {
  return Number(getProtocolParam('payment_rail_usdc_escrow_enabled', 0)) === 1
}

/** 单笔上限(USDC 整数 units;默认 50 USDC,与合约 perTxCap 初值一致 —— 合约侧仍是权威上限)。 */
export function usdcEscrowPerTxCapUnits(getProtocolParam: <T>(k: string, fb: T) => T): Units {
  const cap = Number(getProtocolParam('usdc_escrow.per_tx_cap', 50))
  return toUnits(Number.isFinite(cap) && cap > 0 ? cap : 50)
}

export interface UsdcEscrowUnsupportedOpts {
  variantId?: unknown; hasVariants?: boolean; flashActive?: boolean; couponCode?: unknown
  buyInsurance?: boolean; donationPct?: number; isGift?: boolean; anonymous?: boolean; deliveryWindow?: boolean
}

export interface UsdcEscrowCreateDeps {
  generateId: (prefix: string) => string
  appendOrderEvent: (db: Database.Database, e: Record<string, unknown>) => void
  getProtocolParam: <T>(k: string, fb: T) => T
}

/** 卖家是否对本轨可用(菜单与建单同真值):渠道开 + 合约已配 + active 收款地址 + KYB/制裁。只读。 */
export function usdcEscrowSellerAvailable(db: Database.Database, sellerId: string, getProtocolParam: <T>(k: string, fb: T) => T): boolean {
  if (!usdcEscrowRailEnabled(getProtocolParam)) return false
  if (!process.env.USDC_ESCROW_CONTRACT) return false
  if (listActivePayoutAddresses(db, sellerId).length === 0) return false
  try { return sellerDirectPayKybPassed(db, sellerId) && sellerDirectPaySanctionsClear(db, sellerId) } catch { return false }
}

export function createUsdcEscrowResponse(
  res: Response, db: Database.Database, deps: UsdcEscrowCreateDeps,
  ctx: {
    product: Record<string, unknown>; buyerId: string; reqQty: number; basePrice: number
    totalAmount: number; totalAmountU: Units; shippingAddress: string
    agentApiKey?: string; draftId?: string; consumePriceSession?: () => void
    opts?: UsdcEscrowUnsupportedOpts
    shipping?: { region: string | null; fee: number; estDays: string | null; quoteRequired?: boolean }
  },
): void {
  const gp = deps.getProtocolParam
  // ① 渠道 + ② 合约配置(fail-closed;顺序先于一切读写)
  if (!usdcEscrowRailEnabled(gp)) { res.status(409).json({ error: 'USDC 合约担保轨未开放', error_code: 'RAIL_DISABLED' }); return }
  if (!process.env.USDC_ESCROW_CONTRACT) { res.status(409).json({ error: 'USDC 合约担保轨未配置(合约地址缺失)', error_code: 'USDC_ESCROW_NOT_CONFIGURED' }); return }
  // ③ v1 简单商品 + 选项白名单(镜像 direct_p2p v1;绝不半支持)
  const o = ctx.opts ?? {}
  if (o.hasVariants || o.variantId != null) { res.status(409).json({ error: 'USDC 担保 v1 仅支持简单商品(无规格)', error_code: 'USDC_ESCROW_SIMPLE_PRODUCT_ONLY' }); return }
  const unsupported = o.flashActive ? 'flash_sale' : o.couponCode ? 'coupon' : o.buyInsurance ? 'insurance' : (Number(o.donationPct) > 0) ? 'donation' : o.isGift ? 'gift' : o.anonymous ? 'anonymous_recipient' : o.deliveryWindow ? 'delivery_window' : null
  if (unsupported) { res.status(409).json({ error: `USDC 担保 v1 不支持该选项:${unsupported}`, error_code: 'USDC_ESCROW_UNSUPPORTED_OPTION', option: unsupported }); return }
  // ④ 卖家 opt-in(active 收款地址)+ ⑤ KYB/制裁(买家面脱敏为通用码,不泄露卖家合规细节)
  const sellerId = String(ctx.product.seller_uid)
  const payout = listActivePayoutAddresses(db, sellerId)
  if (payout.length === 0) { res.status(409).json({ error: '该卖家未开通 USDC 担保收款', error_code: 'USDC_ESCROW_SELLER_NOT_READY' }); return }
  let compliant = false
  try { compliant = sellerDirectPayKybPassed(db, sellerId) && sellerDirectPaySanctionsClear(db, sellerId) } catch { compliant = false }
  if (!compliant) { res.status(409).json({ error: '该卖家暂不支持 USDC 担保', error_code: 'USDC_ESCROW_SELLER_NOT_READY' }); return }
  // ⑥ 单笔上限(合约 perTxCap 的后端镜像;链上仍会硬校验)
  if (ctx.totalAmountU > usdcEscrowPerTxCapUnits(gp)) { res.status(409).json({ error: '超出 USDC 担保单笔上限', error_code: 'USDC_ESCROW_CAP_EXCEEDED' }); return }
  // ⑦ 在途上限(防锁库存 griefing;镜像 direct_p2p 同款只读门)
  const openCap = Math.max(1, Number(gp<number>('usdc_escrow.max_open_per_buyer_seller', 5)) || 5)
  const openN = (db.prepare(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND seller_id = ? AND payment_rail = 'usdc_escrow' AND status IN ('created','paid','accepted','shipped','picked_up','in_transit')`).get(ctx.buyerId, sellerId) as { n: number }).n
  if (openN >= openCap) { res.status(429).json({ error_code: 'USDC_ESCROW_TOO_MANY_OPEN', error: `你在该卖家已有 ${openN} 笔进行中的 USDC 担保订单(上限 ${openCap})` }); return }

  const now = new Date()
  const orderId = deps.generateId('ord')
  const addHours = (h: number): string => new Date(now.getTime() + h * 3600_000).toISOString()
  const payWindowHours = Math.max(1, Number(gp<number>('usdc_escrow.pay_window_hours', 24)) || 24)
  try {
    db.transaction(() => {
      const spend = getAgentSpendCapViolation(db, ctx.agentApiKey, ctx.buyerId, [ctx.totalAmount])
      if (spend) throw new AgentSpendCapExceeded(spend)
      ctx.consumePriceSession?.()
      // 库存 CAS(防超卖竞态;失败整体回滚)
      const stockUpd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(ctx.reqQty, ctx.product.id, ctx.reqQty)
      if (stockUpd.changes !== 1) throw new Error('PRODUCT_STOCK_RACE')
      // 订单:本金零入协议(escrow_amount=0);佣金快照 v1 不结算(l1/l2/l3 NULL);资金态等链上 Deposited
      db.prepare(`INSERT INTO orders (
        id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
        status, shipping_address, pay_deadline, accept_deadline, ship_deadline,
        pickup_deadline, delivery_deadline, confirm_deadline,
        snapshot_commission_rate, buyer_region, payment_rail, draft_id, ship_to_region, shipping_fee, shipping_est_days
      ) VALUES (?,?,?,?,?,?,?,0,'created',?,?,?,?,?,?,?,0,?, 'usdc_escrow', ?, ?, ?, ?)`).run(
        orderId, ctx.product.id, ctx.buyerId, sellerId, ctx.reqQty, ctx.basePrice, ctx.totalAmount,
        ctx.shippingAddress,
        addHours(payWindowHours), addHours(48), addHours(120), addHours(168), addHours(336), addHours(408),
        (db.prepare('SELECT region FROM users WHERE id = ?').get(ctx.buyerId) as { region: string | null } | undefined)?.region || 'global',
        ctx.draftId ?? null, ctx.shipping?.region ?? null, ctx.shipping?.fee ?? null, ctx.shipping?.estDays ?? null,
      )
      try {
        deps.appendOrderEvent(db, {
          orderId, eventType: 'open', fromStatus: null, toStatus: 'created', actorId: ctx.buyerId, actorRole: 'buyer',
          extra: { product_id: ctx.product.id, seller_id: sellerId, quantity: ctx.reqQty, unit_price: ctx.basePrice, total_amount: ctx.totalAmount, payment_rail: 'usdc_escrow' },
        })
      } catch (e) { console.warn('[usdc-escrow-create] genesis event failed:', (e as Error).message) }
    })()
  } catch (e) {
    if (e instanceof AgentSpendCapExceeded) { res.status(403).json(e.violation); return }
    if ((e as Error).message === 'PRODUCT_STOCK_RACE') { res.status(409).json({ error: '库存已被抢光,请重试', error_code: 'PRODUCT_STOCK_RACE' }); return }
    res.status(409).json({ error: 'USDC 担保订单创建失败:' + (e as Error).message, error_code: 'USDC_ESCROW_CREATE_FAILED' }); return
  }
  res.json({
    success: true, order_id: orderId, status: 'created', payment_rail: 'usdc_escrow',
    pay_deadline_hours: payWindowHours,
    note: `请在 ${payWindowHours} 小时内用你的链上钱包将 ${ctx.totalAmount} USDC 存入 WebAZ 担保合约(订单页引导连钱包+签名存入);链上确认后订单自动进入已付款。超时未存入订单自动取消,你无需任何操作。本金由链上合约托管,平台不经手。`,
  })
}
