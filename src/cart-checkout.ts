import type Database from 'better-sqlite3'
import { transition } from './layer0-foundation/L0-2-state-machine/engine.js'
import { notifyTransition } from './layer2-business/L2-6-notifications/notification-engine.js'
import { getAgentSpendCapViolation } from './agent-spend-cap.js'
import { add, mulQty, toDecimal, toUnits, type Units } from './money.js'
import { applyWalletDelta } from './ledger.js'

type CartCheckoutItem = {
  product_id: string
  qty: number
  price: number
  stock: number
  seller_id: string
  has_variants: number
  status: string
}
type OrderableCartItem = CartCheckoutItem & { totalU: Units }

export interface CartCheckoutResult {
  created: Array<{ order_id: string; product_id: string; total: number }>
  skipped: Array<{ product_id: string; reason: string }>
  totalNeed: number
}

export class CartCheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly skipped?: CartCheckoutResult['skipped'],
    readonly details?: Record<string, unknown>,
  ) { super(message) }
}

interface CheckoutSelectedCartArgs {
  db: Database.Database
  buyerId: string
  selectedItems: unknown
  shippingAddress: string
  notes?: string
  generateId: (prefix: string) => string
  checkStockAndMaybeDelist: (productId: string) => void
  addHours: (date: Date, hours: number) => string
  agentApiKey?: string
}

export interface CartCheckoutIntent {
  product_id: string
  qty: number
  unit_price: number
}

export function normalizeCartSelection(input: unknown): CartCheckoutIntent[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CartCheckoutError('请选择要结账的商品', 400, 'CART_SELECTION_REQUIRED')
  }
  if (input.length > 500 || input.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    const candidate = item as Record<string, unknown>
    return typeof candidate.product_id !== 'string' || !candidate.product_id.trim()
      || typeof candidate.qty !== 'number' || !Number.isInteger(candidate.qty) || candidate.qty < 1 || candidate.qty > 99
      || typeof candidate.unit_price !== 'number' || !Number.isFinite(candidate.unit_price) || Number(candidate.unit_price) < 0
  })) {
    throw new CartCheckoutError('购物车选择无效', 400, 'CART_SELECTION_INVALID')
  }
  const selectedItems = (input as Array<Record<string, unknown>>).map(item => ({
    product_id: String(item.product_id).trim(),
    qty: Number(item.qty),
    unit_price: Number(item.unit_price),
  }))
  try { selectedItems.forEach(item => toUnits(item.unit_price)) } catch {
    throw new CartCheckoutError('购物车选择无效', 400, 'CART_SELECTION_INVALID')
  }
  const selectedIds = selectedItems.map(item => item.product_id)
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new CartCheckoutError('购物车选择无效', 400, 'CART_SELECTION_INVALID')
  }
  return selectedItems
}

export function checkoutSelectedCart(args: CheckoutSelectedCartArgs): CartCheckoutResult {
  const { db, buyerId, shippingAddress, notes, generateId, checkStockAndMaybeDelist, addHours, agentApiKey } = args
  const selectedItems = normalizeCartSelection(args.selectedItems)
  const selectedIds = selectedItems.map(item => item.product_id)
  const checkout = db.transaction((): CartCheckoutResult => {
    const items = db.prepare(`
      SELECT c.product_id, c.qty, p.price, p.stock, p.seller_id, p.has_variants, p.status
      FROM cart_items c JOIN products p ON p.id = c.product_id
      WHERE c.user_id = ?
    `).all(buyerId) as CartCheckoutItem[]
    const itemById = new Map(items.map(item => [item.product_id, item]))
    if (selectedIds.some(id => !itemById.has(id))) {
      throw new CartCheckoutError('购物车已变化，请刷新后重试', 409, 'CART_SELECTION_STALE')
    }
    if (selectedItems.some(intent => {
      const current = itemById.get(intent.product_id)!
      return current.qty !== intent.qty || toUnits(current.price) !== toUnits(intent.unit_price)
    })) {
      throw new CartCheckoutError('购物车已变化，请刷新后重试', 409, 'CART_SELECTION_STALE')
    }

    const skipped: CartCheckoutResult['skipped'] = []
    const created: CartCheckoutResult['created'] = []
    const orderable: OrderableCartItem[] = []
    let totalNeedU: Units = 0
    for (const item of selectedIds.map(id => itemById.get(id)!)) {
      if (item.status !== 'active') { skipped.push({ product_id: item.product_id, reason: '商品已下架' }); continue }
      if (item.has_variants) { skipped.push({ product_id: item.product_id, reason: '需在商品详情页选规格下单' }); continue }
      if (item.stock < item.qty) { skipped.push({ product_id: item.product_id, reason: `库存不足（${item.stock} < ${item.qty}）` }); continue }
      if (item.seller_id === buyerId) { skipped.push({ product_id: item.product_id, reason: '不可购买自己的商品' }); continue }
      const unitPrice = toDecimal(toUnits(item.price)); const totalU = mulQty(toUnits(unitPrice), item.qty)
      orderable.push({ ...item, price: unitPrice, totalU })
      totalNeedU = add(totalNeedU, totalU)
    }
    if (orderable.length === 0) throw new CartCheckoutError('购物车中无可下单商品', 400, undefined, skipped)

    const spendViolation = getAgentSpendCapViolation(
      db,
      agentApiKey,
      buyerId,
      orderable.map(item => toDecimal(item.totalU)),
    )
    if (spendViolation) {
      const { error, error_code, ...details } = spendViolation
      throw new CartCheckoutError(error, 403, error_code, undefined, details)
    }

    const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(buyerId) as { balance: number } | undefined
    if (!wallet) throw new CartCheckoutError('钱包记录缺失', 500)
    if (toUnits(wallet.balance) < totalNeedU) {
      throw new CartCheckoutError(`余额不足：需 ${toDecimal(totalNeedU).toFixed(2)} WAZ，当前 ${wallet.balance.toFixed(2)}`, 400)
    }
    applyWalletDelta(db, buyerId, { balance: -totalNeedU, escrowed: totalNeedU })

    const now = new Date()
    for (const item of orderable) {
      const total = toDecimal(item.totalU)
      const orderId = generateId('ord')
      db.prepare(`INSERT INTO orders (
        id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
        status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
        pickup_deadline, delivery_deadline, confirm_deadline, source
      ) VALUES (?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?, 'cart_batch')`).run(
        orderId, item.product_id, buyerId, item.seller_id, item.qty, item.price, total, total,
        shippingAddress, notes || '[批量下单]',
        addHours(now, 24), addHours(now, 48), addHours(now, 120),
        addHours(now, 168), addHours(now, 336), addHours(now, 408),
      )
      const stockUpdate = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
        .run(item.qty, item.product_id, item.qty)
      if (stockUpdate.changes !== 1) throw new CartCheckoutError('库存已被抢光，请重试', 409, 'STOCK_DEPLETED')
      checkStockAndMaybeDelist(item.product_id)
      transition(db, orderId, 'paid', buyerId, [], '购物车批量支付')
      notifyTransition(db, orderId, 'created', 'paid')
      created.push({ order_id: orderId, product_id: item.product_id, total })
    }

    const orderableIds = orderable.map(item => item.product_id)
    const placeholders = orderableIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM cart_items WHERE user_id = ? AND product_id IN (${placeholders})`)
      .run(buyerId, ...orderableIds)
    return { created, skipped, totalNeed: toDecimal(totalNeedU) }
  })
  return checkout.immediate()
}
