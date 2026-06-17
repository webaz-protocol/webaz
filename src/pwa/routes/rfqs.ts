/**
 * RFQ + Bid 端点
 *
 * 由 #1013 Phase 82 从 src/pwa/server.ts 抽出。
 *
 * 9 endpoints:
 *   POST   /api/rfqs                  买家发求购（押金 + region 默认 + 收货地址 + 自动通知/auto_bid）
 *   GET    /api/rfqs                  卖家 RFQ 看板（多 filter + i_have_bid）
 *   GET    /api/rfqs/mine             买家我的 RFQ 列表
 *   GET    /api/rfqs/:id              详情（owner 看全部 bids，第三方 buyer 脱敏）
 *   DELETE /api/rfqs/:id              买家取消（扣 30% 押金 + 释放 active bids）
 *   POST   /api/rfqs/:id/bids         卖家报价（押金 + first_match 自动 award）
 *   POST   /api/rfqs/:id/award        买家选定（指定 bid 或自动最低价 → awardBidAndCreateOrder + auto_accept Skill）
 *   PATCH  /api/bids/:id              卖家改价（stake 差额自动结算）
 *   DELETE /api/bids/:id              卖家撤回（释放 stake）
 *
 * 关键链：
 *   - 押金：buyerRfqDeposit(maxPrice, qty) = min(1, max(0.1, maxPrice*qty*0.01))
 *   - bid stake：bidStakeFor(price, qty) = max(0.5, price*qty*BID_STAKE_RATE)
 *   - first_match: 卖家报价后立刻评估 + awardBidAndCreateOrder（事务内）
 *   - award 后触发 auto_accept Skill（系统用户帮卖家自动接单）
 *
 * 跨域注入：auth + generateId + RFQ/BID 常量 + isListingCategoryKey + LISTING_CATEGORIES
 *           + VALID_FULFILLMENT_TYPES + awardBidAndCreateOrder + notifyMatchedSellers
 *           + evaluateAutoBidsForRfq + shouldAutoAccept + transition + notifyTransition
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

// RFC-016 Phase 1 — 端点纯校验读/公开读/列表/读回 + 单语句通知写 → async seam。
// 钱路径保持同步:create/cancel/bid/patch/delete 的 db.transaction 写序列;
// 以及把读结果【作为权威 subject 直接喂进 awardBidAndCreateOrder 而事务内不再 re-read】
// 的 award/first_match 选标读(awardBidAndCreateOrder 在 server.ts,整体同步,不在本文件计数)。

export interface RfqsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  VALID_RFQ_URGENCIES: Set<string>
  VALID_AWARD_MODES: Set<string>
  RFQ_MAX_QTY: number
  RFQ_MAX_PRICE: number
  RFQ_DAILY_CAP_PER_BUYER: number
  RFQ_MAX_WINDOW_MIN: number
  RFQ_DEFAULT_WINDOW_MIN: Record<string, number>
  BID_DAILY_CAP_PER_SELLER: number
  BID_STAKE_RATE: number
  VALID_FULFILLMENT_TYPES: Set<string>
  isListingCategoryKey: (s: string) => boolean
  LISTING_CATEGORIES: Record<string, unknown>
  awardBidAndCreateOrder: (rfq: Record<string, unknown>, winner: Record<string, unknown>) => { ok: boolean; order_id?: string; error?: string }
  notifyMatchedSellers: (rfqId: string) => void
  evaluateAutoBidsForRfq: (rfqId: string) => number
  // 这些跨域 helper 的真实签名带泛型/字面量类型；用 any 接口对齐
  shouldAutoAccept: any
  transition: any
  notifyTransition: any
}

export function registerRfqsRoutes(app: Application, deps: RfqsDeps): void {
  const { db, auth, generateId,
          VALID_RFQ_URGENCIES, VALID_AWARD_MODES, RFQ_MAX_QTY, RFQ_MAX_PRICE,
          RFQ_DAILY_CAP_PER_BUYER, RFQ_MAX_WINDOW_MIN, RFQ_DEFAULT_WINDOW_MIN,
          BID_DAILY_CAP_PER_SELLER, BID_STAKE_RATE,
          VALID_FULFILLMENT_TYPES, isListingCategoryKey, LISTING_CATEGORIES,
          awardBidAndCreateOrder, notifyMatchedSellers, evaluateAutoBidsForRfq,
          shouldAutoAccept, transition, notifyTransition } = deps

  // 内联押金 helper（小巧、仅 rfq 域用）
  const buyerRfqDeposit = (maxPrice: number | null, qty: number): number => {
    const base = (maxPrice && qty) ? maxPrice * qty * 0.01 : 0.1
    return Math.max(0.1, Math.min(1, Math.round(base * 100) / 100))
  }
  const bidStakeFor = (price: number, qty: number): number =>
    Math.max(0.5, Math.round(price * qty * BID_STAKE_RATE * 100) / 100)

  // 买家：创建 RFQ
  app.post('/api/rfqs', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'buyer') return void res.json({ error: '仅买家可发求购单' })

    const body = req.body as Record<string, unknown>
    const title = String(body.title || '').trim()
    if (title.length < 2) return void res.json({ error: '标题至少 2 字' })
    const qty = Math.max(1, Math.floor(Number(body.qty) || 1))
    if (qty > RFQ_MAX_QTY) return void res.json({ error: `qty 超出上限 ${RFQ_MAX_QTY}` })
    const urgency = String(body.urgency || 'flex')
    if (!VALID_RFQ_URGENCIES.has(urgency)) return void res.json({ error: 'urgency 无效' })
    const awardMode = String(body.award_mode || 'time_window')
    if (!VALID_AWARD_MODES.has(awardMode)) return void res.json({ error: 'award_mode 无效' })
    const maxPrice = body.max_price != null ? Number(body.max_price) : null
    if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice <= 0)) return void res.json({ error: 'max_price 必须 > 0' })
    if (maxPrice != null && maxPrice > RFQ_MAX_PRICE) return void res.json({ error: `max_price 超出上限 ${RFQ_MAX_PRICE} WAZ` })
    const category = String(body.category || 'general')
    if (!isListingCategoryKey(category)) return void res.json({ error: '类目无效' })

    const explicitWindow = body.award_window_min != null ? Math.max(5, Math.min(RFQ_MAX_WINDOW_MIN, Math.floor(Number(body.award_window_min)))) : null
    const windowMin = explicitWindow ?? RFQ_DEFAULT_WINDOW_MIN[urgency]

    const todayCount = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM rfqs WHERE buyer_id = ? AND created_at > datetime('now','-1 day')", [user.id]))!.n
    if (todayCount >= RFQ_DAILY_CAP_PER_BUYER) {
      return void res.json({ error: `今日已达上限 ${RFQ_DAILY_CAP_PER_BUYER} 单求购` })
    }

    const deposit = buyerRfqDeposit(maxPrice, qty)
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || Number(wallet.balance) < deposit) {
      return void res.json({ error: `余额不足，发求购需 ${deposit} WAZ 押金（中标后释放，撤销扣 30%）` })
    }

    // P3c：award 自动建单需要收货地址。优先 body，否则 buyer 的默认地址
    const buyerProfile = await dbOne<{ default_address_text: string | null; default_address_json: string | null }>('SELECT default_address_text, default_address_json FROM users WHERE id = ?', [user.id])
    let shippingAddress = body.shipping_address ? String(body.shipping_address).trim() : null
    if (!shippingAddress) {
      if (buyerProfile?.default_address_text) shippingAddress = buyerProfile.default_address_text
      else if (buyerProfile?.default_address_json) {
        try {
          const a = JSON.parse(buyerProfile.default_address_json) as Record<string, string>
          const parts = [a.recipient, a.line1, a.line2, a.city, a.state, a.country, a.phone1].filter(Boolean)
          if (parts.length) shippingAddress = parts.join(' / ')
        } catch {}
      }
    }
    if (!shippingAddress) return void res.json({ error: '请先在个人主页设置默认收货地址，或在发求购时传 shipping_address' })

    const id = generateId('rfq')
    const regionRequired = body.region_required ? String(body.region_required) : (user.region as string | null) || null
    const fulfillmentRequired = body.fulfillment_required ? JSON.stringify(body.fulfillment_required) : null

    // Codex #236 P1:await 余额预检与同步 tx 间有 yield;扣款带 balance>=deposit 守卫,
    // changes!==1 即并发已花掉余额 → 抛回滚(连带回滚已插入的 rfq),杜绝超额。
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO rfqs (id, buyer_id, listing_id, title, spec_json, qty, category, region_required, urgency,
            max_price, fulfillment_required, award_mode, award_window_min, deadline_at, buyer_stake_locked, notes, shipping_address)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now', '+' || ? || ' minutes'),?,?,?)
        `).run(
          id, user.id,
          body.listing_id ? String(body.listing_id) : null,
          title,
          body.spec_json ? JSON.stringify(body.spec_json) : null,
          qty, category, regionRequired, urgency,
          maxPrice, fulfillmentRequired,
          awardMode, windowMin, windowMin, deposit,
          body.notes ? String(body.notes) : null,
          shippingAddress,
        )
        const d = db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?').run(deposit, deposit, user.id, deposit)
        if (d.changes !== 1) throw new Error('RFQ_INSUFFICIENT_BALANCE')
      })()
    } catch (e) {
      if ((e as Error).message === 'RFQ_INSUFFICIENT_BALANCE') return void res.json({ error: `余额不足，发求购需 ${deposit} WAZ 押金（中标后释放，撤销扣 30%）` })
      throw e
    }

    try { notifyMatchedSellers(id) } catch (e) { console.error('[P3 notify]', e) }
    let autoBidCount = 0
    try { autoBidCount = evaluateAutoBidsForRfq(id) } catch (e) { console.error('[P3e auto_bid]', e) }

    res.json({ id, deposit, window_min: windowMin, deadline_at_minutes: windowMin, auto_bids: autoBidCount })
  })

  // 卖家 RFQ 看板
  app.get('/api/rfqs', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const where: string[] = ["r.status = 'open'", "r.deadline_at > datetime('now')"]
    const args: unknown[] = []
    if (req.query.region) { where.push('(r.region_required IS NULL OR r.region_required = ?)'); args.push(String(req.query.region)) }
    if (req.query.category) { where.push('r.category = ?'); args.push(String(req.query.category)) }
    if (req.query.urgency && VALID_RFQ_URGENCIES.has(String(req.query.urgency))) { where.push('r.urgency = ?'); args.push(String(req.query.urgency)) }
    if (req.query.unbidded === '1') { where.push('r.bid_count = 0') }
    // #974: q LIKE 搜索（title / notes）
    if (req.query.q && typeof req.query.q === 'string' && req.query.q.trim()) {
      const qE = req.query.q.trim().replace(/[\\%_]/g, '\\$&')
      where.push("(r.title LIKE ? ESCAPE '\\' OR r.notes LIKE ? ESCAPE '\\')")
      args.push('%' + qE + '%', '%' + qE + '%')
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30))

    const rows = await dbAll(`
      SELECT r.id, r.title, r.qty, r.category, r.region_required, r.urgency, r.max_price,
             r.award_mode, r.deadline_at, r.bid_count, r.created_at,
             (SELECT MIN(price) FROM bids b WHERE b.rfq_id = r.id AND b.status = 'active') as current_lowest_bid,
             EXISTS(SELECT 1 FROM bids b WHERE b.rfq_id = r.id AND b.seller_id = ? AND b.status = 'active') as i_have_bid
      FROM rfqs r
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC
      LIMIT ?
    `, [user.id, ...args, limit])
    res.json({ items: rows, urgencies: ['now', 'today', 'flex'], categories: LISTING_CATEGORIES })
  })

  app.get('/api/rfqs/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT r.*,
        (SELECT MIN(price) FROM bids b WHERE b.rfq_id = r.id AND b.status = 'active') as current_lowest_bid
      FROM rfqs r
      WHERE r.buyer_id = ?
      ORDER BY r.created_at DESC
      LIMIT 100
    `, [user.id])
    res.json({ items: rows })
  })

  app.get('/api/rfqs/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rfq = await dbOne<Record<string, unknown>>('SELECT * FROM rfqs WHERE id = ?', [req.params.id])
    if (!rfq) return void res.status(404).json({ error: 'RFQ 不存在' })
    const isOwner = rfq.buyer_id === user.id

    const bids = await dbAll<Record<string, unknown>>(`
      SELECT b.id, b.seller_id, b.price, b.qty_offered, b.eta_hours, b.fulfillment_type, b.note,
        b.auto_bid_skill, b.status, b.submitted_at, b.offer_id,
        u.handle as seller_handle, u.region as seller_region,
        (SELECT COUNT(1) FROM orders WHERE seller_id = b.seller_id AND status = 'completed') as seller_sales
      FROM bids b
      LEFT JOIN users u ON u.id = b.seller_id
      WHERE b.rfq_id = ?
      ORDER BY b.price ASC, b.submitted_at ASC
    `, [req.params.id])

    // 仅 owner 看全部；第三方只看自己 + 计数
    const visibleBids = isOwner ? bids : bids.filter(b => b.seller_id === user.id)
    // P1：非 owner 时 buyer 身份脱敏（防止私下交易）
    const safeRfq: Record<string, unknown> = { ...rfq }
    if (!isOwner) {
      const bid = String(rfq.buyer_id || '')
      safeRfq.buyer_id = '买家 #' + bid.slice(-6)
      delete safeRfq.shipping_address    // 中标后从订单读
    }
    res.json({ rfq: safeRfq, bids: visibleBids, bid_count: bids.length, is_owner: isOwner })
  })

  app.delete('/api/rfqs/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rfq = await dbOne<Record<string, unknown>>('SELECT * FROM rfqs WHERE id = ?', [req.params.id])
    if (!rfq) return void res.status(404).json({ error: 'RFQ 不存在' })
    if (rfq.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家本人可取消' })
    if (rfq.status !== 'open') return void res.json({ error: `当前状态 ${rfq.status} 不可取消` })

    const deposit = Number(rfq.buyer_stake_locked) || 0
    const forfeit = Math.round(deposit * 0.30 * 100) / 100
    const refund = Math.round((deposit - forfeit) * 100) / 100

    // Codex #236 P1:tx 内先 CAS RFQ open→cancelled,changes!==1 即并发已取消/中标 → 抛回滚,
    // 先于释放买家/bid stake,杜绝重复释放。
    let releasedCount = 0
    try {
      db.transaction(() => {
        const c = db.prepare("UPDATE rfqs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'open'").run(req.params.id)
        if (c.changes !== 1) throw new Error('RFQ_NOT_OPEN')
        if (refund > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(refund, deposit, user.id)
        const activeBids = db.prepare("SELECT id, seller_id, stake_locked FROM bids WHERE rfq_id = ? AND status = 'active'").all(req.params.id) as Array<{ id: string; seller_id: string; stake_locked: number }>
        for (const b of activeBids) {
          db.prepare("UPDATE bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(b.id)
          if (b.stake_locked > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(b.stake_locked, b.stake_locked, b.seller_id)
          releasedCount++
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'RFQ_NOT_OPEN') return void res.json({ error: `当前状态不可取消（可能已取消/中标）` })
      throw e
    }
    res.json({ success: true, refund, forfeit, active_bids_released: releasedCount })
  })

  app.post('/api/rfqs/:id/bids', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可报价' })
    const rfq = await dbOne<Record<string, unknown>>('SELECT * FROM rfqs WHERE id = ?', [req.params.id])
    if (!rfq) return void res.status(404).json({ error: 'RFQ 不存在' })
    if (rfq.status !== 'open') return void res.json({ error: `当前状态 ${rfq.status} 不接受报价` })
    if (String(rfq.deadline_at) <= new Date().toISOString().replace('T', ' ').slice(0, 19)) {
      return void res.json({ error: '该 RFQ 已过期' })
    }

    const body = req.body as Record<string, unknown>
    const price = Number(body.price)
    if (!Number.isFinite(price) || price <= 0) return void res.json({ error: 'price 必须 > 0' })
    if (price > RFQ_MAX_PRICE) return void res.json({ error: `price 超出上限 ${RFQ_MAX_PRICE} WAZ` })
    if (rfq.max_price && price > Number(rfq.max_price)) return void res.json({ error: `超出买家预算 ${rfq.max_price}` })
    const qtyOffered = Math.max(1, Math.floor(Number(body.qty_offered) || Number(rfq.qty)))
    if (qtyOffered > RFQ_MAX_QTY) return void res.json({ error: `qty_offered 超出上限 ${RFQ_MAX_QTY}` })
    const fulfillmentType = String(body.fulfillment_type || 'standard')
    if (!VALID_FULFILLMENT_TYPES.has(fulfillmentType)) return void res.json({ error: 'fulfillment_type 无效' })

    const today = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM bids WHERE seller_id = ? AND submitted_at > datetime('now','-1 day')", [user.id]))!.n
    if (today >= BID_DAILY_CAP_PER_SELLER) {
      return void res.json({ error: `今日报价已达上限 ${BID_DAILY_CAP_PER_SELLER} 条` })
    }

    // 一卖家 × 一 RFQ = 一 bid（已有则用 PATCH）
    const existing = await dbOne<{ id: string; status: string }>("SELECT id, status FROM bids WHERE rfq_id = ? AND seller_id = ?", [req.params.id, user.id])
    if (existing && existing.status === 'active') return void res.json({ error: '已有进行中的 bid，请改用 PATCH 修改', bid_id: existing.id })

    const stake = bidStakeFor(price, qtyOffered)
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || Number(wallet.balance) < stake) {
      return void res.json({ error: `余额不足，bid 押金 ${stake} WAZ（落选/取消立即释放，中标后转 escrow）` })
    }

    const id = generateId('bid')
    // Codex #236 P1:await 预检(rfq open / 余额)与同步 tx 间有 yield。tx 内先原子确认 RFQ 仍 open
    // (WHERE status='open' bump bid_count;原来无条件 SET status='open' 会把已中标/取消的 RFQ 复活,一并修掉),
    // 再插 bid + 带 balance>=stake 守卫扣款;任一失败抛回滚(连带回滚已插 bid),杜绝超额/向已关闭 RFQ 报价。
    try {
      db.transaction(() => {
        const rOpen = db.prepare(`UPDATE rfqs SET bid_count = bid_count + 1, updated_at = datetime('now') WHERE id = ? AND status = 'open'`).run(req.params.id)
        if (rOpen.changes !== 1) throw new Error('RFQ_NOT_OPEN')
        db.prepare(`
          INSERT INTO bids (id, rfq_id, seller_id, offer_id, price, qty_offered, eta_hours, fulfillment_type, note, stake_locked, auto_bid_skill)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          id, req.params.id, user.id,
          body.offer_id ? String(body.offer_id) : null,
          price, qtyOffered,
          body.eta_hours != null ? Number(body.eta_hours) : null,
          fulfillmentType,
          body.note ? String(body.note).slice(0, 500) : null,
          stake,
          body.auto_bid_skill ? 1 : 0,
        )
        const d = db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?').run(stake, stake, user.id, stake)
        if (d.changes !== 1) throw new Error('BID_INSUFFICIENT_BALANCE')
      })()
    } catch (e) {
      const m = (e as Error).message
      if (m === 'RFQ_NOT_OPEN') return void res.json({ error: `当前状态不接受报价（可能已中标/取消）` })
      if (m === 'BID_INSUFFICIENT_BALANCE') return void res.json({ error: `余额不足，bid 押金 ${stake} WAZ（落选/取消立即释放，中标后转 escrow）` })
      throw e
    }

    try {
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'rfq_bid',?,?,datetime('now'))`,
        [generateId('ntf'), rfq.buyer_id as string, `💰 新报价 ${price} WAZ`, `RFQ：${rfq.title} · #${req.params.id}`])
    } catch (e) { console.error('[P3 notify bid]', e) }

    // P3c.4: first_match 模式 → 立即评估并自动 award
    let autoAwardedOrder: string | undefined
    if (rfq.award_mode === 'first_match') {
      const okForMatch = !rfq.max_price || price <= Number(rfq.max_price)
      if (okForMatch) {
        const newBid = db.prepare('SELECT * FROM bids WHERE id = ?').get(id) as Record<string, unknown>
        let result: ReturnType<typeof awardBidAndCreateOrder> = { ok: false }
        try {
          db.transaction(() => {
            const rfqLatest = db.prepare('SELECT * FROM rfqs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
            if (rfqLatest && rfqLatest.status === 'open') {
              result = awardBidAndCreateOrder(rfqLatest, newBid)
              if (!result.ok) throw new Error(result.error || 'first_match award failed')
            }
          })()
          if (result.ok) {
            autoAwardedOrder = result.order_id
            try {
              await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                          VALUES (?,?,'rfq_won',?,?,datetime('now'))`,
                [generateId('ntf'), user.id as string, `🎉 中标（first_match 自动选）`, `订单 ${result.order_id}`])
            } catch (e) { console.error('[P3c notify first_match won]', e) }
          }
        } catch (e) { console.error('[P3c first_match]', (e as Error).message) }
      }
    }

    res.json({ id, stake_locked: stake, auto_awarded_order_id: autoAwardedOrder })
  })

  // 卖家：修改 bid（仅 active；stake 差额自动结算）
  app.patch('/api/bids/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const bid = await dbOne<Record<string, unknown>>('SELECT * FROM bids WHERE id = ?', [req.params.id])
    if (!bid) return void res.status(404).json({ error: 'bid 不存在' })
    if (bid.seller_id !== user.id) return void res.status(403).json({ error: '仅本人可修改' })
    if (bid.status !== 'active') return void res.json({ error: `当前状态 ${bid.status} 不可修改` })
    const rfq = await dbOne<{ max_price: number | null; status: string; deadline_at: string }>('SELECT max_price, status, deadline_at FROM rfqs WHERE id = ?', [bid.rfq_id])
    if (!rfq || rfq.status !== 'open') return void res.json({ error: 'RFQ 已不接受改价' })

    const body = req.body as Record<string, unknown>
    let newPrice = Number(bid.price)
    let newQty = Number(bid.qty_offered)
    let newEta = bid.eta_hours
    let newFt = String(bid.fulfillment_type)
    let newNote = bid.note as string | null

    if (body.price != null) {
      const p = Number(body.price)
      if (!Number.isFinite(p) || p <= 0) return void res.json({ error: 'price 必须 > 0' })
      if (rfq.max_price && p > Number(rfq.max_price)) return void res.json({ error: `超出买家预算 ${rfq.max_price}` })
      newPrice = p
    }
    if (body.qty_offered != null) {
      const q = Math.max(1, Math.floor(Number(body.qty_offered)))
      if (!Number.isFinite(q)) return void res.json({ error: 'qty 无效' })
      newQty = q
    }
    if (body.eta_hours !== undefined) newEta = body.eta_hours != null ? Number(body.eta_hours) : null
    if (body.fulfillment_type != null) {
      const ft = String(body.fulfillment_type)
      if (!VALID_FULFILLMENT_TYPES.has(ft)) return void res.json({ error: 'fulfillment_type 无效' })
      newFt = ft
    }
    if (body.note !== undefined) newNote = body.note ? String(body.note).slice(0, 500) : null

    const oldStake = Number(bid.stake_locked) || 0
    const newStake = bidStakeFor(newPrice, newQty)
    const delta = Math.round((newStake - oldStake) * 100) / 100

    if (delta > 0) {
      const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
      if (!wallet || Number(wallet.balance) < delta) {
        return void res.json({ error: `余额不足补足 stake 差额 ${delta} WAZ` })
      }
    }

    // Codex #236 P1:await 预检后进入同步 tx 前,bid/rfq 状态与 stake 可能变。tx 内重读 bid(必须仍
    // active)+ rfq(必须仍 open),delta 用【tx 内重读的 stake】重算,正 delta 扣款带 balance 守卫。
    let txDelta = delta
    try {
      db.transaction(() => {
        const freshBid = db.prepare('SELECT status, stake_locked FROM bids WHERE id = ?').get(req.params.id) as { status: string; stake_locked: number } | undefined
        if (!freshBid || freshBid.status !== 'active') throw new Error('BID_NOT_ACTIVE')
        const freshRfq = db.prepare('SELECT status FROM rfqs WHERE id = ?').get(bid.rfq_id) as { status: string } | undefined
        if (!freshRfq || freshRfq.status !== 'open') throw new Error('RFQ_NOT_OPEN')
        txDelta = Math.round((newStake - (Number(freshBid.stake_locked) || 0)) * 100) / 100
        db.prepare(`UPDATE bids SET price = ?, qty_offered = ?, eta_hours = ?, fulfillment_type = ?, note = ?, stake_locked = ?
                    WHERE id = ?`).run(newPrice, newQty, newEta, newFt, newNote, newStake, req.params.id)
        if (txDelta > 0) {
          const d = db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?').run(txDelta, txDelta, user.id, txDelta)
          if (d.changes !== 1) throw new Error('PATCH_INSUFFICIENT_BALANCE')
        } else if (txDelta < 0) {
          const back = -txDelta
          db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(back, back, user.id)
        }
      })()
    } catch (e) {
      const m = (e as Error).message
      if (m === 'BID_NOT_ACTIVE') return void res.json({ error: 'bid 已不是 active 状态,不可修改' })
      if (m === 'RFQ_NOT_OPEN') return void res.json({ error: 'RFQ 已不接受改价' })
      if (m === 'PATCH_INSUFFICIENT_BALANCE') return void res.json({ error: `余额不足补足 stake 差额 ${txDelta} WAZ` })
      throw e
    }
    res.json({ success: true, stake_locked: newStake, stake_delta: txDelta })
  })

  // 卖家：撤回 bid（释放 stake）
  app.delete('/api/bids/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const bid = await dbOne<Record<string, unknown>>('SELECT * FROM bids WHERE id = ?', [req.params.id])
    if (!bid) return void res.status(404).json({ error: 'bid 不存在' })
    if (bid.seller_id !== user.id) return void res.status(403).json({ error: '仅本人可撤回' })
    if (bid.status !== 'active') return void res.json({ error: `当前状态 ${bid.status} 不可撤回` })

    // Codex #236 P1:tx 内先 CAS bid active→cancelled,changes!==1 即并发已撤回/中标 → 抛回滚,
    // 先于释放 stake + 减 bid_count;释放额用 tx 内重读的 stake_locked(防并发 patch 改过)。
    let releasedStake = 0
    try {
      db.transaction(() => {
        const c = db.prepare("UPDATE bids SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ? AND status = 'active'").run(req.params.id)
        if (c.changes !== 1) throw new Error('BID_NOT_ACTIVE')
        const fresh = db.prepare('SELECT stake_locked FROM bids WHERE id = ?').get(req.params.id) as { stake_locked: number }
        releasedStake = Number(fresh.stake_locked) || 0
        if (releasedStake > 0) db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(releasedStake, releasedStake, user.id)
        db.prepare("UPDATE rfqs SET bid_count = MAX(0, bid_count - 1), updated_at = datetime('now') WHERE id = ?").run(String(bid.rfq_id))
      })()
    } catch (e) {
      if ((e as Error).message === 'BID_NOT_ACTIVE') return void res.json({ error: `当前状态不可撤回（可能已撤回/中标）` })
      throw e
    }
    res.json({ success: true, stake_released: releasedStake })
  })

  // 买家：选定 winning bid
  app.post('/api/rfqs/:id/award', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // 选标读保持同步:rfq/winner 直接作为权威 subject 喂进 awardBidAndCreateOrder,
    // 而该函数事务内不再 re-read,async 化会在读→建单事务之间插入 await gap → 破坏原子性。
    const rfq = db.prepare('SELECT * FROM rfqs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
    if (!rfq) return void res.status(404).json({ error: 'RFQ 不存在' })
    if (rfq.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家本人可选定' })
    if (rfq.status !== 'open') return void res.json({ error: `当前状态 ${rfq.status} 不可选定` })

    const bidId = String((req.body as Record<string, unknown>).bid_id || '')
    let winner: Record<string, unknown> | undefined
    if (bidId) {
      winner = db.prepare("SELECT * FROM bids WHERE id = ? AND rfq_id = ? AND status = 'active'").get(bidId, req.params.id) as Record<string, unknown> | undefined
    } else {
      // P3c.3 提前结算：自动选当前最低价（同 cron 逻辑）
      winner = db.prepare("SELECT * FROM bids WHERE rfq_id = ? AND status = 'active' ORDER BY price ASC, submitted_at ASC LIMIT 1").get(req.params.id) as Record<string, unknown> | undefined
    }
    if (!winner) return void res.status(404).json({ error: bidId ? 'bid 无效或已失效' : '当前无有效报价可选' })

    let result: ReturnType<typeof awardBidAndCreateOrder> = { ok: false }
    try {
      db.transaction(() => {
        result = awardBidAndCreateOrder(rfq, winner!)
        if (!result.ok) throw new Error(result.error || 'award failed')
      })()
    } catch (e) {
      return void res.status(400).json({ error: result.error || String((e as Error).message) })
    }

    // 通知（事务外）：中标
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'rfq_won',?,?,datetime('now'))`,
        [generateId('ntf'), winner.seller_id as string, `🎉 中标：${rfq.title}`, `订单 ${result.order_id}`])
    } catch (e) { console.error('[P3 notify won]', e) }

    // auto_accept Skill 触发
    try {
      if (shouldAutoAccept(db, result.order_id!)) {
        const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
        if (sysUser) {
          const ar = transition(db, result.order_id!, 'accepted', sysUser.id, [], '⚡ auto_accept Skill 自动接单')
          if (ar.success) notifyTransition(db, result.order_id!, 'paid', 'accepted')
        }
      }
    } catch (e) { console.error('[P3c auto_accept]', e) }

    res.json({ success: true, winning_bid_id: String(winner.id), order_id: result.order_id })
  })
}
