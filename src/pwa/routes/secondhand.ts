/**
 * 二手板块 (M8 secondhand) 域
 *
 * 由 #1013 Phase 27 从 src/pwa/server.ts 抽出（#1013 大模块第二大单 phase）。
 *
 * 6 endpoints:
 *   POST   /api/secondhand                发布物品（≤9 张图）
 *   GET    /api/secondhand                市场列表（类目/成色多选/区域/价格区间/q/排序）
 *   GET    /api/secondhand/mine           我的发布 + 状态统计
 *   GET    /api/secondhand/:id            详情 + 同卖家其他在售
 *   PATCH  /api/secondhand/:id            编辑（价格/描述/可议价/状态/履约方式）
 *   POST   /api/secondhand/:id/order      下单（CAS 锁库存）
 *
 * 不变量：
 *   - 类目 / 成色 / 履约方式 不可改（防偷梁换柱）
 *   - reserved 状态由系统切换（买家下单时 CAS）
 *   - claim_loss_count ≥ 3 的 closed 物品不可自助 re-open
 *   - 二手订单 commission_rate=0（个人偶发交易，无 PV 链路）
 *   - foreign_keys 临时关闭：orders.product_id 指向 secondhand_items.id
 *
 * 跨域：
 *   - transition（L0-2 state machine）
 *   - notifyTransition（L2-6 notifications）
 *   - 都是 module 内 import
 *
 * 注意：/api/orders/:id/confirm-in-person 留在 orders module（属于 order 域）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { notifyTransition } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const SH_CATEGORIES  = new Set(['phone','computer','appliance','furniture','clothing','book','toy','sports','other'])
const SH_CONDITIONS  = new Set(['brand_new','like_new','lightly_used','well_used','heavily_used'])
const SH_FULFILLMENT = new Set(['shipping','in_person','both'])
const SH_STATUS_USER_SET = new Set(['available','reserved','closed'])  // 'sold' 由系统在 settleOrder 设

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

export interface SecondhandDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerSecondhandRoutes(app: Application, deps: SecondhandDeps): void {
  // db 仍保留:order 下单是 money/escrow 路径(pragma FK-OFF 窗口 + CAS + 钱包扣减),
  // 不能引入 await 否则会在 FK-OFF 窗口被其他请求并发穿插;随 order/资金路径在 Phase 3 一并迁移。
  const { db, generateId, auth, errorRes, getProtocolParam } = deps

  // 1. 发布
  app.post('/api/secondhand', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { title, description, category, condition_grade, price, negotiable, images, region, fulfillment } = req.body || {}
    const t = String(title || '').trim()
    if (t.length < 2 || t.length > 60) return void res.status(400).json({ error: '标题需 2-60 字' })
    if (!SH_CATEGORIES.has(category)) return void res.status(400).json({ error: '类目无效' })
    if (!SH_CONDITIONS.has(condition_grade)) return void res.status(400).json({ error: '成色无效' })
    const p = Number(price)
    if (!Number.isFinite(p) || p <= 0 || p > 100000) return void res.status(400).json({ error: '价格须 0-100000 WAZ' })
    const desc = description ? String(description).trim().slice(0, 1000) : null
    const imgs = Array.isArray(images) ? images.filter((x: unknown) => typeof x === 'string' && (x as string).length < 800_000).slice(0, 9) : []
    if (imgs.length === 0) return void res.status(400).json({ error: '至少上传 1 张图片' })
    const ff = SH_FULFILLMENT.has(fulfillment) ? fulfillment : 'both'
    const reg = region ? String(region).trim().slice(0, 40) : null
    const id = generateId('shi')
    await dbRun(`INSERT INTO secondhand_items (id, seller_id, title, description, category, condition_grade, price, negotiable, images, region, fulfillment)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, user.id, t, desc, category, condition_grade, p, negotiable ? 1 : 0, JSON.stringify(imgs), reg, ff])
    res.json({ success: true, id })
  })

  // 2. 列表（市场入口）
  app.get('/api/secondhand', async (req, res) => {
    const category = String(req.query.category || '').trim()
    const conditionList = String(req.query.condition || '').split(',').map(s => s.trim()).filter(s => SH_CONDITIONS.has(s))
    const region    = String(req.query.region || '').trim()
    const minP = Number(req.query.min_price) || 0
    const maxP = Number(req.query.max_price) || Infinity
    const q    = String(req.query.q || '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 100)
    const sort = String(req.query.sort || 'newest')
    const orderBy = sort === 'price_asc' ? 'si.price ASC' : sort === 'price_desc' ? 'si.price DESC' : sort === 'popular' ? 'si.view_count DESC, si.created_at DESC' : 'si.created_at DESC'
    const where: string[] = [`status = 'available'`]
    const args: unknown[] = []
    if (SH_CATEGORIES.has(category)) { where.push('category = ?'); args.push(category) }
    if (conditionList.length > 0) { where.push(`condition_grade IN (${conditionList.map(() => '?').join(',')})`); args.push(...conditionList) }
    if (region) { where.push('region = ?'); args.push(region) }
    if (minP > 0) { where.push('price >= ?'); args.push(minP) }
    if (Number.isFinite(maxP)) { where.push('price <= ?'); args.push(maxP) }
    if (q) { where.push('LOWER(title) LIKE ?'); args.push('%' + q + '%') }
    // 排除自己（如登录）
    const me = (req.headers.authorization || '').replace('Bearer ', '')
    if (me) {
      const u = await dbOne<{ id: string }>("SELECT id FROM users WHERE api_key = ?", [me])
      if (u) { where.push('seller_id != ?'); args.push(u.id) }
    }
    const rows = await dbAll<Record<string, unknown>>(`SELECT si.id, si.seller_id, si.title, si.category, si.condition_grade, si.price, si.negotiable,
      si.region, si.fulfillment, si.images, si.view_count, si.created_at,
      u.name as seller_name, u.handle as seller_handle
      FROM secondhand_items si JOIN users u ON u.id = si.seller_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy} LIMIT ${limit}`, args)
    for (const r of rows) {
      try { const arr = JSON.parse(r.images as string); r.cover = arr[0] || null } catch { r.cover = null }
      delete r.images
    }
    res.json({ items: rows })
  })

  // 3. 我的二手发布
  app.get('/api/secondhand/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(`SELECT id, title, category, condition_grade, price, negotiable, status,
      region, fulfillment, images, view_count, created_at, sold_at, sold_order_id
      FROM secondhand_items WHERE seller_id = ? ORDER BY created_at DESC LIMIT 100`, [user.id])
    for (const r of rows) {
      try { const arr = JSON.parse(r.images as string); r.cover = arr[0] || null } catch { r.cover = null }
      delete r.images
    }
    const stats = (await dbOne<Record<string, number>>(`SELECT
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available_count,
      SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END) as reserved_count,
      SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) as sold_count,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed_count,
      COALESCE(SUM(CASE WHEN status='sold' THEN price ELSE 0 END), 0) as gross_sold_amount
      FROM secondhand_items WHERE seller_id = ?`, [user.id]))!
    // 估算净收入（扣 1% 协议 + 1% 基金）
    stats.estimated_earned = Math.round((stats.gross_sold_amount || 0) * 0.98 * 100) / 100
    res.json({ items: rows, stats })
  })

  // 4. 详情（view_count++）+ 同卖家其他在售
  app.get('/api/secondhand/:id', async (req, res) => {
    const row = await dbOne<Record<string, unknown>>(`SELECT si.*, u.name as seller_name, u.handle as seller_handle, u.permanent_code as seller_code
      FROM secondhand_items si JOIN users u ON u.id = si.seller_id WHERE si.id = ?`, [req.params.id])
    if (!row) return void res.status(404).json({ error: '物品不存在' })
    await dbRun('UPDATE secondhand_items SET view_count = view_count + 1 WHERE id = ?', [req.params.id])
    try { row.images = JSON.parse(row.images as string) } catch { row.images = [] }
    const sellerOthers = await dbAll<Record<string, unknown>>(`SELECT id, title, category, condition_grade, price, images, region
      FROM secondhand_items WHERE seller_id = ? AND status='available' AND id != ?
      ORDER BY created_at DESC LIMIT 6`, [row.seller_id, req.params.id])
    for (const o of sellerOthers) {
      try { const arr = JSON.parse(o.images as string); o.cover = arr[0] || null } catch { o.cover = null }
      delete o.images
    }
    res.json({ item: row, seller_others: sellerOthers })
  })

  // 5. 编辑（仅 owner；可改 price / description / negotiable / status / fulfillment）
  app.patch('/api/secondhand/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const item = await dbOne<Record<string, unknown>>('SELECT * FROM secondhand_items WHERE id = ?', [req.params.id])
    if (!item) return void res.status(404).json({ error: '物品不存在' })
    if (item.seller_id !== user.id) return void res.status(403).json({ error: '仅发布者可编辑' })
    if (item.status === 'sold') return void res.status(400).json({ error: '已售出，不可编辑' })
    const sets: string[] = []; const args: unknown[] = []
    const { price, description, negotiable, status, fulfillment } = req.body || {}
    if (price !== undefined) {
      const p = Number(price)
      if (!Number.isFinite(p) || p <= 0 || p > 100000) return void res.status(400).json({ error: '价格无效' })
      sets.push('price = ?'); args.push(p)
    }
    if (description !== undefined) { sets.push('description = ?'); args.push(String(description).slice(0, 1000)) }
    if (negotiable !== undefined) { sets.push('negotiable = ?'); args.push(negotiable ? 1 : 0) }
    if (status !== undefined) {
      if (!SH_STATUS_USER_SET.has(status)) return void res.status(400).json({ error: '状态无效（仅 available / reserved / closed 可手动设置）' })
      if (item.status === 'reserved' && status === 'available') {
        return void res.status(400).json({ error: 'reserved 状态由系统管理，请等待买家完成支付' })
      }
      // Sprint 5: claim_loss_count >= 3 的 closed 物品不可自助 re-open
      if (status === 'available' && (Number(item.claim_loss_count) || 0) >= 3) {
        return void errorRes(res, 403, 'CLAIM_THRESHOLD_REACHED', `该物品累计 ${item.claim_loss_count} 次声明被验证不实，已达自动下架阈值。需 admin 干预方可重新上架。`)
      }
      sets.push('status = ?'); args.push(status)
    }
    if (fulfillment !== undefined) {
      if (!SH_FULFILLMENT.has(fulfillment)) return void res.status(400).json({ error: '履约方式无效' })
      sets.push('fulfillment = ?'); args.push(fulfillment)
    }
    if (sets.length === 0) return void res.status(400).json({ error: '无字段更新' })
    sets.push("updated_at = datetime('now')")
    args.push(req.params.id)
    await dbRun(`UPDATE secondhand_items SET ${sets.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })

  // 6. 下单（CAS 锁库存）— money/escrow + pragma FK-OFF 窗口,保持同步,Phase 3 随资金路径迁移
  app.post('/api/secondhand/:id/order', (req, res) => {
    const user = auth(req, res); if (!user) return
    // WAZ 退役(2026-07-23)硬闸:二手下单是独立 escrow 建单器(Codex #514 R1 BLOCKER-3)。渠道关 → 409,fail-closed。
    if (Number(getProtocolParam('payment_rail_waz_escrow_enabled', 0)) !== 1) return void res.status(409).json({ error: 'WAZ 模拟托管轨已下架,二手暂不可下单', error_code: 'RAIL_DISABLED' })
    const { shipping_address, notes, fulfillment_mode } = req.body || {}
    const item = db.prepare('SELECT * FROM secondhand_items WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
    if (!item) return void res.status(404).json({ error: '物品不存在' })
    if (item.status !== 'available') return void res.status(409).json({ error: `物品状态：${item.status}，不可购买` })
    if (item.seller_id === user.id) return void res.status(403).json({ error: '不可购买自己的物品' })
    const mode = String(fulfillment_mode || 'shipping')
    if (mode !== 'shipping' && mode !== 'in_person') return void res.status(400).json({ error: 'fulfillment_mode 必须为 shipping / in_person' })
    if (item.fulfillment === 'shipping' && mode === 'in_person') return void res.status(400).json({ error: '该物品仅支持快递' })
    if (item.fulfillment === 'in_person' && mode === 'shipping') return void res.status(400).json({ error: '该物品仅支持面交' })
    if (mode === 'shipping' && !shipping_address) return void res.status(400).json({ error: '快递必须填收货地址' })

    const total = item.price as number
    const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
    if (wallet.balance < total) return void res.status(400).json({ error: `余额不足：需 ${total} WAZ，当前 ${wallet.balance}` })

    // CAS 抢占
    const claim = db.prepare(`UPDATE secondhand_items SET status='reserved', updated_at=datetime('now')
      WHERE id = ? AND status='available'`).run(req.params.id)
    if (claim.changes !== 1) return void res.status(409).json({ error: '物品已被预定，请刷新' })

    try {
      const now = new Date()
      const orderId = generateId('ord')
      const buyer = db.prepare("SELECT sponsor_id, sponsor_path, region FROM users WHERE id = ?").get(user.id) as { sponsor_id: string | null; sponsor_path: string | null; region: string | null }
      const buyerRegionSnapshot = buyer?.region || 'global'
      // orders.product_id 原本 FK products(id)，二手指向 secondhand_items(id) — 临时关 FK
      db.pragma('foreign_keys = OFF')
      try {
        db.prepare(`INSERT INTO orders (
          id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
          status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
          pickup_deadline, delivery_deadline, confirm_deadline,
          snapshot_commission_rate, buyer_region, source, fulfillment_mode
        ) VALUES (?,?,?,?,1,?,?,?,'created',?,?,?,?,?,?,?,?,?,?, 'secondhand', ?)`).run(
          orderId, req.params.id, user.id, item.seller_id, total, total, total,
          mode === 'shipping' ? shipping_address : (shipping_address || '面交'), notes || null,
          addHours(now, 24), addHours(now, 48), addHours(now, 120),
          addHours(now, 168), addHours(now, 336), addHours(now, 408),
          0, buyerRegionSnapshot, mode
        )
      } finally { db.pragma('foreign_keys = ON') }
      db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?')
        .run(total, total, user.id)
      transition(db, orderId, 'paid', user.id as string, [], '二手下单 — escrow 已锁')
      notifyTransition(db, orderId, 'created', 'paid')
      res.json({ success: true, order_id: orderId, total_amount: total, fulfillment_mode: mode })
    } catch (e) {
      // 失败回滚：释放 reserved
      db.prepare(`UPDATE secondhand_items SET status='available', updated_at=datetime('now') WHERE id = ?`).run(req.params.id)
      console.error('[secondhand order]', e)
      res.status(500).json({ error: '下单失败：' + (e as Error).message })
    }
  })
}
