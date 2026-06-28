/**
 * Direct Pay (Rail 1) — direct_p2p 订单【原子创建】helper (PR-4c)。
 *
 * 边界(铁律):
 *  - 本金(货款)【不入协议】:escrow_amount=0,【不写 buyer wallet / 不写 escrow / 不动 principal】。
 *  - 唯一资金写 = 卖家逐单 fee-stake(平台费),且【只走既有 lockFeeStake helper】。无其它 wallet/ledger 写入。
 *  - 原子:INSERT order → genesis 事件 → created→direct_pay_window → lockFeeStake → 扣库存,全在一个 db.transaction;
 *    任一步失败【整体回滚】—— 绝不出现「有订单无 stake」或「有 stake 无订单」。
 *  - 不碰 refund/settlement/commission/fund/tokenomics;direct_p2p 排除佣金/PV(l1/l2/l3 留空)。
 *  - 收款指令是【调用方已读取并快照】的卖家自填文本(WebAZ 不验证/不路由/不托管/不判断币种)。
 *  - direct_p2p v1:不支持 variant/flash/coupon/donation(escrow-only);仅简单商品库存。
 */
import type Database from 'better-sqlite3'
import type { Response } from 'express'
import { lockFeeStake } from './direct-pay-ledger.js'
import { mulRate, type Units } from './money.js'
import { sellerHasProductionBaseBondLocked } from './direct-receive-deposits.js'
import { getActivePaymentInstruction } from './direct-receive-payment-instruction.js'

export interface DirectPayCreateDeps {
  generateId: (prefix: string) => string
  transition: (db: Database.Database, orderId: string, toStatus: string, actorId: string, evidenceIds: string[], notes: string) => { success: boolean; error?: string }
  appendOrderEvent: (db: Database.Database, args: Record<string, unknown>) => void
}
export interface DirectPayCreateArgs {
  productId: string; sellerId: string; buyerId: string; quantity: number
  unitPrice: number; totalAmount: number; feeUnits: Units
  instructionSnapshot: string; windowDeadlineIso: string; shippingAddress: string
}

/** 原子创建 direct_p2p 订单。成功返回 { orderId };任一步失败抛错(调用方回 409,事务已回滚)。 */
export function createDirectPayOrder(db: Database.Database, deps: DirectPayCreateDeps, args: DirectPayCreateArgs): { orderId: string } {
  const { generateId, transition, appendOrderEvent } = deps
  const orderId = generateId('ord')
  db.transaction(() => {
    // 本金不入协议:escrow_amount=0,不写 buyer wallet。
    db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
      status, payment_rail, shipping_address, direct_pay_instruction_snapshot, direct_pay_window_deadline)
      VALUES (?,?,?,?,?,?,?,0,'created','direct_p2p',?,?,?)`)
      .run(orderId, args.productId, args.buyerId, args.sellerId, args.quantity, args.unitPrice, args.totalAmount,
        args.shippingAddress, args.instructionSnapshot, args.windowDeadlineIso)
    appendOrderEvent(db, {
      orderId, eventType: 'open', fromStatus: null, toStatus: 'created', actorId: args.buyerId, actorRole: 'buyer',
      extra: { product_id: args.productId, seller_id: args.sellerId, quantity: args.quantity, total_amount: args.totalAmount, payment_rail: 'direct_p2p' },
    })
    // created → direct_pay_window(system-only edge);失败回滚。
    const rc = transition(db, orderId, 'direct_pay_window', 'sys_protocol', [], 'Rail1 直付:卖家费用质押锁定,进入付款窗口')
    if (!rc.success) throw new Error(rc.error || 'transition→direct_pay_window failed')
    // 唯一资金写:卖家逐单 fee-stake(= 平台费),只走 lockFeeStake;余额不足/重复即抛 → 回滚整单。
    const fs = lockFeeStake(db, { orderId, sellerId: args.sellerId, feeUnits: args.feeUnits, stakeId: generateId('dpfs') })
    if (!fs.ok) throw new Error(fs.reason || 'lockFeeStake failed')
    // 扣库存(原子;售罄即抛回滚)。变体/flash 直付 v1 不支持。
    const upd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(args.quantity, args.productId, args.quantity)
    if (upd.changes !== 1) throw new Error('stock depleted')
  })()
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
  ctx: { product: Record<string, unknown>; buyerId: string; reqQty: number; basePrice: number; totalAmount: number; totalAmountU: Units; shippingAddress: string; opts?: DirectPayUnsupportedOpts },
): void {
  // ① direct_p2p v1 = simple product only。escrow-only 修饰一律 fail-closed(本片不支持,不半支持)。
  const o = ctx.opts ?? {}
  if (o.hasVariants || o.variantId != null) { res.status(409).json({ error: '直付 v1 仅支持简单商品(无规格);该商品有规格或传了 variant_id', error_code: 'DIRECT_PAY_SIMPLE_PRODUCT_ONLY' }); return }
  const unsupported = o.flashActive ? 'flash_sale' : o.couponCode ? 'coupon' : o.buyInsurance ? 'insurance' : (Number(o.donationPct) > 0) ? 'donation' : o.isGift ? 'gift' : o.anonymous ? 'anonymous_recipient' : o.deliveryWindow ? 'delivery_window' : null
  if (unsupported) { res.status(409).json({ error: `直付 v1 不支持该选项:${unsupported}`, error_code: 'DIRECT_PAY_UNSUPPORTED_OPTION', option: unsupported }); return }
  const sellerId = ctx.product.seller_uid as string
  if (!sellerHasProductionBaseBondLocked(db, sellerId)) { res.status(409).json({ error: '直付暂不可用:卖家未完成生产级履约担保(production base-bond)', error_code: 'DIRECT_PAY_NOT_AVAILABLE' }); return }
  const instr = getActivePaymentInstruction(db, sellerId)
  if (!instr) { res.status(409).json({ error: '卖家未设置收款说明,无法创建直付订单', error_code: 'NO_PAYMENT_INSTRUCTION' }); return }
  const feeU = mulRate(ctx.totalAmountU, (ctx.product.source as string) === 'secondhand' ? 0.01 : 0.02)
  const windowHours = deps.getProtocolParam<number>('direct_pay.payment_window_hours', 4)
  try {
    const { orderId } = createDirectPayOrder(db, deps, {
      productId: ctx.product.id as string, sellerId, buyerId: ctx.buyerId, quantity: ctx.reqQty,
      unitPrice: ctx.basePrice, totalAmount: ctx.totalAmount, feeUnits: feeU,
      instructionSnapshot: instr.instruction, windowDeadlineIso: new Date(Date.now() + windowHours * 3600_000).toISOString(),
      shippingAddress: ctx.shippingAddress,
    })
    // ⚠️ 不在 create 响应里下发卖家收款说明(payment_instruction/label)——D1/D2 both-acked 前不得泄露(响应契约门,
    //   非仅 UI 软门)。买家先完成披露 ack,再经 GET /orders/:id 读取 redaction-gated 的 direct_pay_instruction_snapshot。
    res.json({
      success: true, order_id: orderId, status: 'direct_pay_window', payment_rail: 'direct_p2p',
      note: '本金不经 WebAZ;完成 D1/D2 风险确认(Passkey)后即可在订单页查看卖家收款说明,请【场外】付款后点"我已付款"。本档无经济保障、不退款,仅对卖家信誉处罚。',
    })
  } catch (e) {
    res.status(409).json({ error: '直付订单创建失败:' + (e as Error).message, error_code: 'DIRECT_PAY_CREATE_FAILED' })
  }
}
