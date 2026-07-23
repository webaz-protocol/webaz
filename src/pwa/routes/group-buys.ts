/**
 * 群组团购 (B-3 group_buys) 域
 *
 * 由 #1013 Phase 28 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST   /api/group-buys              卖家开团（target 2-50 / discount 0.05-0.50 / 1-168h）
 *   GET    /api/group-buys/live         公开 active + 未过期列表
 *   GET    /api/group-buys/:id          详情 + participants
 *   POST   /api/group-buys/:id/join     加入团（锁原价 escrow；达成目标自动结算）
 *   DELETE /api/group-buys/:id/leave    离开（仅 active + 未达成）
 *
 * 内部 helper：
 *   - settleGroupBuy(gbId) — 成团 / 失败 双路径
 *     成功：每位 participant 建 order + 退差价 + escrow 留 finalPrice + status='succeeded'
 *     失败：全员退款 + status='failed'
 *
 * Cron：
 *   - export sweepExpiredGroupBuys — 每 60s 扫描 ends_at <= now 的 active 团购
 *
 * Schema 留在 server.ts（migration 层）
 *
 * 跨域：
 *   - db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { wazEscrowChannelOn } from '../../waz-escrow-channel.js'   // WAZ 退役渠道开关单一真值

const VALID_GB_DISCOUNT_MIN = 0.05
const VALID_GB_DISCOUNT_MAX = 0.50

export interface GroupBuysDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}


/** 结算团购 — 成团创建订单 + 退差价；未达成全员退款。export 仅供 cron。 */
export function settleGroupBuy(
  db: Database.Database,
  generateId: (prefix: string) => string,
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void,
  gbId: string,
  getProtocolParam: <T>(key: string, fallback: T) => T,
): void {
  const gb = db.prepare('SELECT * FROM group_buys WHERE id = ? AND status = \'active\'').get(gbId) as Record<string, unknown> | undefined
  if (!gb) return
  const participants = db.prepare(`SELECT * FROM group_buy_participants WHERE group_buy_id = ? AND status = 'pending'`).all(gbId) as Array<Record<string, unknown>>
  const joined = participants.length
  // WAZ 退役硬闸(Codex #514 R1 BLOCKER-2):渠道关 → 即使成团也不建 escrow 单,强制全员退款收终局。
  const targetMet = joined >= Number(gb.target_count) && wazEscrowChannelOn(getProtocolParam)
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(gb.product_id as string) as Record<string, unknown> | undefined
  if (!product) return
  const originalPrice = Number(product.price)
  const finalPrice = Math.round(originalPrice * (1 - Number(gb.discount_pct)) * 100) / 100

  db.transaction(() => {
    if (targetMet) {
      // 为每位 participant 创建 order（简化：status=paid，escrow=finalPrice，差价退回 balance）
      for (const p of participants) {
        const orderId = generateId('ord')
        const refund = originalPrice - finalPrice
        const now = new Date()
        db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
          status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
          pickup_deadline, delivery_deadline, confirm_deadline, source, variant_id)
          VALUES (?,?,?,?,1,?,?,?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, 'group_buy', ?)`)
          .run(orderId, gb.product_id, p.buyer_id, gb.seller_id, finalPrice, finalPrice, finalPrice,
               p.shipping_address, `[团购 ${gbId}] -${(Number(gb.discount_pct)*100).toFixed(0)}%`,
               new Date(now).toISOString(), new Date(now.getTime() + 48*3600000).toISOString(),
               new Date(now.getTime() + 120*3600000).toISOString(), new Date(now.getTime() + 168*3600000).toISOString(),
               new Date(now.getTime() + 336*3600000).toISOString(), new Date(now.getTime() + 408*3600000).toISOString(),
               gb.variant_id || null)
        // escrow 调整：buyer 已锁原价 → 释放差价，留 finalPrice
        db.prepare('UPDATE wallets SET balance = balance + ?, escrowed = escrowed - ? WHERE user_id = ?').run(refund, refund, p.buyer_id)
        db.prepare(`UPDATE group_buy_participants SET status = 'fulfilled', order_id = ? WHERE id = ?`).run(orderId, p.id)
      }
      db.prepare(`UPDATE group_buys SET status = 'succeeded', settled_at = datetime('now') WHERE id = ?`).run(gbId)
      try { broadcastSystemEvent('group_buy_success', '🎉', `团购 ${gbId} 成团 ${joined} 人，-${(Number(gb.discount_pct)*100).toFixed(0)}%`, String(gb.product_id)) } catch {}
    } else {
      // 失败：全员退款
      for (const p of participants) {
        db.prepare('UPDATE wallets SET balance = balance + ?, escrowed = escrowed - ? WHERE user_id = ?').run(p.escrow_amount, p.escrow_amount, p.buyer_id)
        db.prepare(`UPDATE group_buy_participants SET status = 'refunded' WHERE id = ?`).run(p.id)
      }
      db.prepare(`UPDATE group_buys SET status = 'failed', settled_at = datetime('now') WHERE id = ?`).run(gbId)
      try { broadcastSystemEvent('group_buy_failed', '⏰', `团购 ${gbId} 未达成（${joined}/${gb.target_count}）`, String(gb.product_id)) } catch {}
    }
  })()
}

/** Cron 扫描：过期未成团 → 失败结算。server.ts setInterval 调用。 */
export function sweepExpiredGroupBuys(
  db: Database.Database,
  generateId: (prefix: string) => string,
  broadcastSystemEvent: (type: string, icon: string, summary: string, refId?: string | null) => void,
  getProtocolParam: <T>(key: string, fallback: T) => T,
): void {
  const expired = db.prepare(`SELECT id FROM group_buys WHERE status = 'active' AND ends_at <= datetime('now')`).all() as Array<{ id: string }>
  for (const e of expired) {
    try { settleGroupBuy(db, generateId, broadcastSystemEvent, e.id, getProtocolParam) } catch (err) { console.error('[gb sweep]', err) }
  }
}

export function registerGroupBuysRoutes(app: Application, deps: GroupBuysDeps): void {
  const { db, generateId, auth, isTrustedRole, errorRes, broadcastSystemEvent, getProtocolParam } = deps

  // 卖家开团
  app.post('/api/group-buys', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // WAZ 退役:渠道关时开团只会产生永不能成团的死团(join 已拒)→ 一并如实拒绝
    if (!wazEscrowChannelOn(getProtocolParam)) return void res.status(409).json({ error: 'WAZ 模拟托管轨已下架,团购暂不可创建', error_code: 'RAIL_DISABLED' })
    const { product_id, variant_id, target_count, discount_pct, duration_hours } = req.body || {}
    if (!product_id) return void res.status(400).json({ error: 'product_id 必填' })
    const p = await dbOne<{ id: string; seller_id: string; price: number; has_variants: number }>('SELECT id, seller_id, price, has_variants FROM products WHERE id = ? AND status = \'active\'', [product_id])
    if (!p) return void res.status(404).json({ error: '商品不存在或已下架' })
    if (p.seller_id !== user.id) return void res.status(403).json({ error: '仅自己商品可开团' })
    const target = Math.max(2, Math.min(50, Number(target_count) || 3))
    const disc = Number(discount_pct)
    if (!Number.isFinite(disc) || disc < VALID_GB_DISCOUNT_MIN || disc > VALID_GB_DISCOUNT_MAX) {
      return void res.status(400).json({ error: `discount_pct 必须在 ${VALID_GB_DISCOUNT_MIN} ~ ${VALID_GB_DISCOUNT_MAX} 之间` })
    }
    const hours = Math.max(1, Math.min(168, Number(duration_hours) || 24))
    const endsAt = new Date(Date.now() + hours * 3600 * 1000).toISOString()
    if (Number(p.has_variants) === 1 && !variant_id) return void res.status(400).json({ error: '该商品有规格，请指定 variant_id' })
    if (variant_id) {
      const v = await dbOne('SELECT id FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1', [variant_id, p.id])
      if (!v) return void res.status(400).json({ error: 'variant 不存在' })
    }
    const id = generateId('gb')
    await dbRun(`INSERT INTO group_buys (id, seller_id, product_id, variant_id, target_count, discount_pct, ends_at) VALUES (?,?,?,?,?,?,?)`,
      [id, user.id, p.id, variant_id || null, target, disc, endsAt])
    try { broadcastSystemEvent('group_buy_created', '👥', `团购创建 ${id} · 目标 ${target} 人 · ${(disc*100).toFixed(0)}% off`, p.id) } catch {}
    res.json({ success: true, id, ends_at: endsAt })
  })

  // 公开列表
  app.get('/api/group-buys/live', async (_req, res) => {
    const rows = await dbAll(`
      SELECT gb.*, p.title as product_title, p.price as original_price, p.images, p.category,
        u.handle as seller_handle, u.name as seller_name,
        (SELECT COUNT(*) FROM group_buy_participants WHERE group_buy_id = gb.id AND status != 'refunded') as joined_count
      FROM group_buys gb
      JOIN products p ON p.id = gb.product_id
      JOIN users u ON u.id = gb.seller_id
      WHERE gb.status = 'active' AND gb.ends_at > datetime('now')
      ORDER BY gb.ends_at ASC LIMIT 100
    `, [])
    res.json({ items: rows })
  })

  // 详情 + participants
  app.get('/api/group-buys/:id', async (req, res) => {
    const gb = await dbOne<Record<string, unknown>>(`
      SELECT gb.*, p.title as product_title, p.price as original_price, p.images, p.category,
        u.handle as seller_handle, u.name as seller_name
      FROM group_buys gb
      JOIN products p ON p.id = gb.product_id
      JOIN users u ON u.id = gb.seller_id
      WHERE gb.id = ?
    `, [req.params.id])
    if (!gb) return void res.status(404).json({ error: '团购不存在' })
    const participants = await dbAll(`
      SELECT p.id, p.buyer_id, p.status, p.created_at, u.handle as buyer_handle
      FROM group_buy_participants p JOIN users u ON u.id = p.buyer_id
      WHERE p.group_buy_id = ? AND p.status != 'refunded'
      ORDER BY p.created_at ASC
    `, [req.params.id])
    res.json({ ...gb, participants })
  })

  // 加入团购
  app.post('/api/group-buys/:id/join', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    // WAZ 退役硬闸(Codex #514 R1 BLOCKER-2):渠道关 → 拒收新本金(join 即锁 escrow)。fail-closed。
    if (!wazEscrowChannelOn(getProtocolParam)) return void res.status(409).json({ error: 'WAZ 模拟托管轨已下架,团购暂不可加入', error_code: 'RAIL_DISABLED' })
    const { shipping_address } = req.body || {}
    if (!shipping_address) return void res.status(400).json({ error: '请填写收货地址' })
    const gb = await dbOne<{ id: string; seller_id: string; product_id: string; status: string; target_count: number; ends_at: string; discount_pct: number }>('SELECT id, seller_id, product_id, status, target_count, ends_at, discount_pct FROM group_buys WHERE id = ?', [req.params.id])
    if (!gb) return void res.status(404).json({ error: '团购不存在' })
    if (gb.status !== 'active') return void res.status(400).json({ error: '团购非活跃状态' })
    if (new Date(gb.ends_at) <= new Date()) return void res.status(400).json({ error: '团购已结束' })
    if (gb.seller_id === user.id) return void res.status(400).json({ error: '不可加入自己的团购' })
    const existing = await dbOne<{ id: string }>('SELECT id FROM group_buy_participants WHERE group_buy_id = ? AND buyer_id = ? AND status != \'refunded\'', [gb.id, user.id])
    if (existing) return void res.status(400).json({ error: '已加入此团购' })
    const product = await dbOne<{ price: number }>('SELECT price FROM products WHERE id = ?', [gb.product_id])
    if (!product) return void res.status(500).json({ error: '商品记录缺失' })
    const escrow = Number(product.price)
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || wallet.balance < escrow) return void res.status(400).json({ error: `余额不足：需 ${escrow} WAZ` })
    const id = generateId('gbp')
    db.transaction(() => {
      db.prepare(`INSERT INTO group_buy_participants (id, group_buy_id, buyer_id, shipping_address, escrow_amount) VALUES (?,?,?,?,?)`)
        .run(id, gb.id, user.id, String(shipping_address).slice(0, 200), escrow)
      db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?').run(escrow, escrow, user.id)
    })()
    const joined = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM group_buy_participants WHERE group_buy_id = ? AND status != 'refunded'`, [gb.id]))!.n
    if (joined >= gb.target_count) {
      try { settleGroupBuy(db, generateId, broadcastSystemEvent, gb.id, getProtocolParam) } catch (e) { console.error('[gb settle]', e) }
    }
    try { broadcastSystemEvent('group_buy_join', '👥', `团购 ${gb.id} 新成员 (${joined}/${gb.target_count})`, gb.id) } catch {}
    res.json({ success: true, id, joined_count: joined, target_count: gb.target_count })
  })

  // 离开团购
  app.delete('/api/group-buys/:id/leave', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ id: string; escrow_amount: number; status: string; gb_status: string }>(`SELECT p.id, p.escrow_amount, p.status, gb.status as gb_status FROM group_buy_participants p
      JOIN group_buys gb ON gb.id = p.group_buy_id
      WHERE p.group_buy_id = ? AND p.buyer_id = ?`, [req.params.id, user.id])
    if (!p) return void res.status(404).json({ error: '未加入此团购' })
    if (p.status === 'fulfilled') return void res.status(400).json({ error: '团购已成团，无法退出' })
    if (p.status === 'refunded') return void res.status(400).json({ error: '已退款' })
    if (p.gb_status !== 'active') return void res.status(400).json({ error: '团购已结算，无法退出' })
    db.transaction(() => {
      db.prepare(`UPDATE group_buy_participants SET status = 'refunded' WHERE id = ?`).run(p.id)
      db.prepare('UPDATE wallets SET balance = balance + ?, escrowed = escrowed - ? WHERE user_id = ?').run(p.escrow_amount, p.escrow_amount, user.id)
    })()
    res.json({ success: true })
  })
}
