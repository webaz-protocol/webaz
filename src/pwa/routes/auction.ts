/**
 * 拍卖 (auction) 域端点 + 提醒 cron
 *
 * 由 #1013 Phase 5 从 src/pwa/server.ts 抽出。第五次试水（含 cron，巩固 Phase 3 模式）。
 *
 * 9 endpoints + 1 cron 函数 + 1 admin endpoint:
 *   POST   /api/auctions                   — 卖家发起拍卖
 *   GET    /api/auctions                   — 公开看板（匿名可）
 *   GET    /api/auctions/mine              — 我的（卖家+买家双视角）
 *   GET    /api/auctions/:id               — 详情（买家身份脱敏）
 *   POST   /api/auctions/:id/remind        — #959 提醒订阅
 *   DELETE /api/auctions/:id/remind        — 取消订阅
 *   GET    /api/auctions/:id/remind        — 查订阅状态
 *   POST   /api/auctions/:id/bids          — 买家出价（反狙击 + stake 自动补足）
 *   DELETE /api/auctions/:id               — 卖家取消（仅未出价时）
 *   POST   /api/admin/auction-reminders/run— admin 手动跑提醒
 *
 * + fireDueAuctionReminders() — 60s cron 跑的提醒派发函数
 *
 * settleAuction* 留 server.ts（深耦合 transition + checkStockAndMaybeDelist），AUC 结算 cron 也留。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
// RFC-014 PR6 — 拍卖 stake 锁定/释放走整数 base-units + 绝对值落库。
import { toUnits } from '../../money.js'
import { applyWalletDelta } from '../../ledger.js'
// RFC-016 Phase 1 — 纯校验读/公开读/读回 → async seam;db.transaction 内 stake 写序列 + cron 保持同步。
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

// ─── 拍卖常量（域内）──────────────────────────────────────────
const AUC_MAX_WINDOW_MIN = 14 * 24 * 60   // 14 天上限
const AUC_MIN_WINDOW_MIN = 5
const AUC_DEFAULT_WINDOW_MIN = 60
const AUC_DEFAULT_INCREMENT = 1
const AUC_DEFAULT_SNIPER_MIN = 5
const AUC_SELLER_STAKE_PCT = 0.05
const AUC_BUYER_STAKE_PCT = 0.05
const AUC_DAILY_CAP_PER_SELLER = 20

function aucSellerStake(startingPrice: number): number {
  return Math.max(1, Math.round(startingPrice * AUC_SELLER_STAKE_PCT * 100) / 100)
}
function aucBuyerStake(price: number, qty: number): number {
  return Math.max(0.5, Math.round(price * qty * AUC_BUYER_STAKE_PCT * 100) / 100)
}

// 2026-05-24 #959：拍卖「⏰ 提醒我」3 个 endpoint
// 默认订阅 = deadline 前 60min + 10min 各 1 条通知
const AUCTION_REMINDER_LEADS = [60, 10]

export interface AuctionDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  // RFQ-shared 上限 + listing 分类（这些跨域共用，由 server.ts 注入）
  RFQ_MAX_QTY: number
  RFQ_MAX_PRICE: number
  LISTING_CATEGORIES: Record<string, unknown>
  isListingCategoryKey: (s: string) => boolean
  // pre-bound 'protocol' 权限 admin gate
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  // 手动触发的派发(影响其他用户)→ 记录触发的 admin + 结果摘要(治理审计)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

// ─── 提醒 cron — 60s 扫一次，派发 due 提醒 + 标记 sent_at ────
export function fireDueAuctionReminders(
  db: Database.Database,
  generateId: (prefix: string) => string,
): { fired: number } {
  const due = db.prepare(`
    SELECT r.id, r.auction_id, r.user_id, r.lead_minutes,
           a.title as auction_title, a.current_price, a.deadline_at, a.status as auction_status
    FROM auction_reminders r
    JOIN auctions a ON a.id = r.auction_id
    WHERE r.sent_at IS NULL AND r.fire_at <= datetime('now')
    LIMIT 200
  `).all() as Array<{ id: string; auction_id: string; user_id: string; lead_minutes: number; auction_title: string; current_price: number; deadline_at: string; auction_status: string }>
  let fired = 0
  for (const r of due) {
    try {
      // 拍卖已不是 open（结束/取消）→ 跳过通知但标 sent_at 避免重复扫
      if (r.auction_status !== 'open') {
        db.prepare("UPDATE auction_reminders SET sent_at=datetime('now') WHERE id=?").run(r.id)
        continue
      }
      const title = `⏰ 拍卖${r.lead_minutes >= 60 ? Math.round(r.lead_minutes / 60) + 'h' : r.lead_minutes + 'min'}后结束`
      const body = `${r.auction_title} · 当前价 ${r.current_price} WAZ`
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, actions)
                    VALUES (?, ?, 'auction_reminder', ?, ?, ?)`).run(
          generateId('ntf'), r.user_id, title, body,
          JSON.stringify([{ label: '去出价', hash: '#auction/' + r.auction_id }])
        )
        db.prepare("UPDATE auction_reminders SET sent_at=datetime('now') WHERE id=?").run(r.id)
      })
      tx()
      fired++
    } catch (e) {
      console.error('[cron auction-reminder]', r.id, e)
    }
  }
  return { fired }
}

export function registerAuctionRoutes(app: Application, deps: AuctionDeps): void {
  const { db, auth, generateId, RFQ_MAX_QTY, RFQ_MAX_PRICE, LISTING_CATEGORIES, isListingCategoryKey, requireProtocolAdmin, logAdminAction } = deps

  // 卖家发起拍卖
  app.post('/api/auctions', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可发起拍卖' })

    const body = req.body as Record<string, unknown>
    const title = String(body.title || '').trim()
    if (title.length < 2) return void res.json({ error: '标题至少 2 字' })
    const qty = Math.max(1, Math.floor(Number(body.qty) || 1))
    if (qty > RFQ_MAX_QTY) return void res.json({ error: `qty 超出上限 ${RFQ_MAX_QTY}` })
    const cat = String(body.category || 'general')
    if (!isListingCategoryKey(cat)) return void res.json({ error: '类目无效' })
    const startingPrice = Number(body.starting_price)
    if (!Number.isFinite(startingPrice) || startingPrice <= 0) return void res.json({ error: 'starting_price 必须 > 0' })
    if (startingPrice > RFQ_MAX_PRICE) return void res.json({ error: `starting_price 超出上限 ${RFQ_MAX_PRICE} WAZ` })
    const minIncrement = Number(body.min_increment ?? AUC_DEFAULT_INCREMENT)
    if (!Number.isFinite(minIncrement) || minIncrement <= 0) return void res.json({ error: 'min_increment 必须 > 0' })
    const reservePrice = body.reserve_price != null ? Number(body.reserve_price) : null
    if (reservePrice != null) {
      if (!Number.isFinite(reservePrice) || reservePrice <= 0) return void res.json({ error: 'reserve_price 无效' })
      if (reservePrice < startingPrice) return void res.json({ error: 'reserve_price 不可低于 starting_price' })
    }
    const windowMin = Math.max(AUC_MIN_WINDOW_MIN, Math.min(AUC_MAX_WINDOW_MIN, Math.floor(Number(body.window_min || AUC_DEFAULT_WINDOW_MIN))))
    const sniperExtend = Math.max(0, Math.min(60, Math.floor(Number(body.sniper_extend_min ?? AUC_DEFAULT_SNIPER_MIN))))

    // 频率限制
    const today = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM auctions WHERE seller_id = ? AND created_at > datetime('now','-1 day')", [user.id]))!.n
    if (today >= AUC_DAILY_CAP_PER_SELLER) return void res.json({ error: `今日已达上限 ${AUC_DAILY_CAP_PER_SELLER} 场拍卖` })

    // 卖家担保金
    const sellerStake = aucSellerStake(startingPrice)
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet || Number(wallet.balance) < sellerStake) {
      return void res.json({ error: `余额不足，卖家担保金 ${sellerStake} WAZ（5% × 起拍价）` })
    }

    // product_id 引用（可选）：若提供，校验属于本人 + stock>=qty
    let productId: string | null = null
    if (body.product_id) {
      productId = String(body.product_id)
      const p = await dbOne<{ seller_id: string; stock: number; status: string }>("SELECT seller_id, stock, status FROM products WHERE id = ?", [productId])
      if (!p) return void res.json({ error: '关联商品不存在' })
      if (p.seller_id !== user.id) return void res.json({ error: '关联商品归属不匹配' })
      if (p.status !== 'active') return void res.json({ error: '关联商品未上架' })
      if (Number(p.stock) < qty) return void res.json({ error: `库存不足（${p.stock} < ${qty}）` })
    }

    const id = generateId('auc')
    try {
      db.transaction(() => {
        // 余额守恒 guard(Codex PR#228 P1):tx 内重读余额并在任何写之前判定。
        // 上面 `await dbOne` 预检与同步 stake tx 之间有 yield,并发请求可都通过陈旧余额预检后
        // 双双锁押 → 超额。同步 tx 体内无 yield,这次重读反映已提交的扣减,失败即抛回滚。
        const wTx = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number } | undefined
        if (!wTx || Number(wTx.balance) < sellerStake) throw new Error('AUC_INSUFFICIENT')
        db.prepare(`
          INSERT INTO auctions (id, seller_id, listing_id, product_id, title, spec_json, qty, category,
            starting_price, current_price, min_increment, reserve_price, deadline_at, sniper_extend_min,
            seller_stake_locked, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now', '+' || ? || ' minutes'),?,?,?)
        `).run(
          id, user.id,
          body.listing_id ? String(body.listing_id) : null,
          productId,
          title,
          body.spec_json ? JSON.stringify(body.spec_json) : null,
          qty, cat,
          startingPrice, startingPrice, minIncrement, reservePrice,
          windowMin, sniperExtend, sellerStake,
          body.notes ? String(body.notes).slice(0, 500) : null,
        )
        applyWalletDelta(db, user.id as string, { balance: -toUnits(sellerStake), staked: toUnits(sellerStake) })
        // 商品状态机 CAS(Codex follow-up #239):active→auction_pending 必须带 status 守卫。
        // 上面 `await dbOne` 校验 status='active' 与同步 tx 间有 yield,并发 create 可都通过陈旧
        // 'active' 预检 → 同一商品被双双挂进两个拍卖。CAS changes=0 即已被他人移走,抛回滚。
        if (productId) {
          const flipped = db.prepare("UPDATE products SET status = 'auction_pending', updated_at = datetime('now') WHERE id = ? AND status = 'active'").run(productId)
          if (flipped.changes === 0) throw new Error('AUC_PRODUCT_CONFLICT')
        }
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'AUC_INSUFFICIENT') {
        return void res.json({ error: `余额不足，卖家担保金 ${sellerStake} WAZ（5% × 起拍价）` })
      }
      if (msg === 'AUC_PRODUCT_CONFLICT') {
        return void res.json({ error: '关联商品状态已变更（可能已被上架到其它拍卖或下架），请刷新后重试' })
      }
      throw e
    }

    // QA 轮 12 P1：返回完整 echo 字段 + ISO deadline_at 与 detail 一致(tx 后纯读回)
    const created = (await dbOne<{ deadline_at: string; status: string }>('SELECT deadline_at, status FROM auctions WHERE id = ?', [id]))!
    res.json({
      id,
      seller_stake: sellerStake,
      window_min: windowMin,
      deadline_at_minutes: windowMin,   // 保留以兼容老客户端
      deadline_at: created.deadline_at, // 与 detail 一致的 ISO
      status: created.status,
      starting_price: startingPrice,
      current_price: startingPrice,
      reserve_price: reservePrice,
      min_increment: minIncrement,
      sniper_extend_min: sniperExtend,
      qty,
      category: cat,
      notes: body.notes ? String(body.notes).slice(0, 500) : null,
    })
  })

  // 看板：浏览公开拍卖（匿名可访问）
  app.get('/api/auctions', async (req, res) => {
    const where: string[] = ["a.status = 'open'", "a.deadline_at > datetime('now')"]
    const args: unknown[] = []
    if (req.query.category) { where.push('a.category = ?'); args.push(String(req.query.category)) }
    if (req.query.q) {
      const qE = String(req.query.q).replace(/[\\%_]/g, '\\$&')
      where.push("(a.title LIKE ? ESCAPE '\\' OR a.notes LIKE ? ESCAPE '\\')")
      const like = '%' + qE + '%'
      args.push(like, like)
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30))
    const rows = await dbAll(`
      SELECT a.id, a.seller_id, a.title, a.qty, a.category, a.starting_price, a.current_price,
             a.min_increment, a.reserve_price, a.deadline_at, a.bid_count, a.sniper_extend_min, a.created_at,
             u.handle as seller_handle, u.region as seller_region
      FROM auctions a
      LEFT JOIN users u ON u.id = a.seller_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.deadline_at ASC
      LIMIT ?
    `, [...args, limit])
    res.json({ items: rows, categories: LISTING_CATEGORIES })
  })

  // 我的：买家=我出过价的，卖家=我发起的
  app.get('/api/auctions/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const seller = await dbAll(`SELECT * FROM auctions WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50`, [user.id])
    const buyer = await dbAll(`
      SELECT DISTINCT a.*, (SELECT b.price FROM auction_bids b WHERE b.auction_id = a.id AND b.buyer_id = ? ORDER BY b.submitted_at DESC LIMIT 1) as my_last_bid,
        (SELECT b.status FROM auction_bids b WHERE b.auction_id = a.id AND b.buyer_id = ? ORDER BY b.submitted_at DESC LIMIT 1) as my_last_status
      FROM auctions a
      JOIN auction_bids b ON b.auction_id = a.id
      WHERE b.buyer_id = ? ORDER BY a.created_at DESC LIMIT 50
    `, [user.id, user.id, user.id])
    res.json({ as_seller: seller, as_buyer: buyer })
  })

  // 详情：含 bid 历史（buyer 身份脱敏；卖家+出价人本人 可见全名）
  app.get('/api/auctions/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const auc = await dbOne<Record<string, unknown>>('SELECT * FROM auctions WHERE id = ?', [req.params.id])
    if (!auc) return void res.status(404).json({ error: '拍卖不存在' })
    const isSellerSelf = auc.seller_id === user.id
    const isSettled = auc.status !== 'open'

    const bids = await dbAll<Record<string, unknown>>(`
      SELECT b.id, b.buyer_id, b.price, b.stake_locked, b.status, b.submitted_at, b.resolved_at,
        u.handle as buyer_handle
      FROM auction_bids b
      LEFT JOIN users u ON u.id = b.buyer_id
      WHERE b.auction_id = ?
      ORDER BY b.price DESC, b.submitted_at ASC
    `, [req.params.id])

    // 脱敏：非 (卖家/拍卖结束/出价人本人) 时，buyer_id 用后 6 位 + handle 隐藏
    const safeBids = bids.map(b => {
      const isMine = b.buyer_id === user.id
      if (isSellerSelf || isSettled || isMine) return b
      return {
        ...b,
        buyer_id: '买家 #' + String(b.buyer_id || '').slice(-6),
        buyer_handle: null,
      }
    })

    res.json({ auction: auc, bids: safeBids, is_seller: isSellerSelf })
  })

  // 拍卖「⏰ 提醒我」(#959)
  app.post('/api/auctions/:id/remind', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const aucRow = await dbOne<{ id: string; deadline_at: string; status: string; seller_id: string }>("SELECT id, deadline_at, status, seller_id FROM auctions WHERE id = ?", [req.params.id])
    if (!aucRow) return void res.status(404).json({ error: '拍卖不存在' })
    if (aucRow.seller_id === user.id) return void res.status(400).json({ error: '卖家本人无需订阅自己的拍卖' })
    if (aucRow.status !== 'open') return void res.status(400).json({ error: '该拍卖已结束，无需提醒' })
    // SQLite datetime('now') 是 UTC，但 JS Date 解析无 Z 的字符串当本地时间 — 强制按 UTC 解析
    const deadlineMs = new Date(aucRow.deadline_at.replace(' ', 'T') + 'Z').getTime()
    if (deadlineMs <= Date.now()) return void res.status(400).json({ error: '拍卖已截止' })

    const tx = db.transaction(() => {
      for (const lead of AUCTION_REMINDER_LEADS) {
        const fireAtMs = deadlineMs - lead * 60_000
        if (fireAtMs <= Date.now()) continue   // 已过该提醒时间，跳过该 lead
        const fireAtIso = new Date(fireAtMs).toISOString().replace('T', ' ').slice(0, 19)
        db.prepare(`INSERT OR IGNORE INTO auction_reminders (id, auction_id, user_id, lead_minutes, fire_at)
                    VALUES (?, ?, ?, ?, ?)`).run(generateId('arm'), aucRow.id, user.id, lead, fireAtIso)
      }
    })
    tx()
    res.json({ ok: true, subscribed: true, leads_minutes: AUCTION_REMINDER_LEADS })
  })

  app.delete('/api/auctions/:id/remind', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbRun("DELETE FROM auction_reminders WHERE auction_id = ? AND user_id = ?", [req.params.id, user.id])
    res.json({ ok: true, deleted: r.changes })
  })

  app.get('/api/auctions/:id/remind', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<{ lead_minutes: number; fire_at: string; sent_at: string | null }>("SELECT lead_minutes, fire_at, sent_at FROM auction_reminders WHERE auction_id = ? AND user_id = ? ORDER BY lead_minutes DESC", [req.params.id, user.id])
    res.json({ subscribed: rows.length > 0, reminders: rows })
  })

  // 买家：出价
  app.post('/api/auctions/:id/bids', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'buyer') return void res.json({ error: '仅买家可出价' })
    const auc = await dbOne<Record<string, unknown>>('SELECT * FROM auctions WHERE id = ?', [req.params.id])
    if (!auc) return void res.status(404).json({ error: '拍卖不存在' })
    if (auc.status !== 'open') return void res.json({ error: `当前状态 ${auc.status} 不接受出价` })
    if (auc.seller_id === user.id) return void res.json({ error: '卖家不能自拍自买' })

    // deadline 校验（cron 可能未及时翻状态）
    if (String(auc.deadline_at) <= new Date().toISOString().replace('T', ' ').slice(0, 19)) {
      return void res.json({ error: '拍卖已到期，等待结算' })
    }

    const price = Number((req.body as Record<string, unknown>).price)
    if (!Number.isFinite(price) || price <= 0) return void res.json({ error: 'price 必须 > 0' })
    if (price > RFQ_MAX_PRICE) return void res.json({ error: `price 超出上限 ${RFQ_MAX_PRICE} WAZ` })

    const minNextPrice = Math.round((Number(auc.current_price) + Number(auc.min_increment)) * 100) / 100
    const curPrice = Number(auc.current_price)
    const startingPrice = Number(auc.starting_price)
    // 首次出价：≥ starting_price；之后：≥ current_price + min_increment
    const isFirst = Number(auc.bid_count) === 0
    if (isFirst) {
      if (price < startingPrice) return void res.json({ error: `首次出价不能低于起拍价 ${startingPrice}` })
    } else {
      if (price < minNextPrice) return void res.json({ error: `下一口价至少 ${minNextPrice}（当前 ${curPrice} + 加价 ${auc.min_increment}）` })
    }

    const qty = Math.max(1, Math.floor(Number(auc.qty || 1)))
    const stake = aucBuyerStake(price, qty)
    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    // QA 轮 12 P1：自我加价 affordability check 应含已锁旧 stake（会在 tx 内释放）
    // 否则用户必须 ≥ 2× stake 余额才能加价，UX 卡。
    const myExisting = await dbOne<{ stake_locked: number }>("SELECT stake_locked FROM auction_bids WHERE auction_id = ? AND buyer_id = ? AND status = 'active'", [req.params.id, user.id])
    const myExistingStake = Number(myExisting?.stake_locked || 0)
    const availableForBid = Number(wallet?.balance || 0) + myExistingStake
    if (!wallet || availableForBid < stake) {
      return void res.json({ error: `余额不足，出价押金 ${stake} WAZ（被超越后立即释放）` })
    }

    // 上一个最高 active bid（如果是别人的）→ outbid + 释放 stake
    // 自己的旧 active bid（同 auction 同 buyer）→ outbid + 释放 stake
    const id = generateId('abid')
    let newDeadlineExt: number | null = null
    let sellerTopup = 0
    let closedErr = '' as string

    try {
    db.transaction(() => {
      // P1 #4：TX 内重读 auction 状态 + deadline 防 TOCTOU
      const fresh = db.prepare('SELECT status, deadline_at, current_price, bid_count, seller_stake_locked, max_extends, extends_used, sniper_extend_min FROM auctions WHERE id = ?').get(req.params.id) as { status: string; deadline_at: string; current_price: number; bid_count: number; seller_stake_locked: number; max_extends: number; extends_used: number; sniper_extend_min: number } | undefined
      if (!fresh) { closedErr = 'not_found'; return }
      if (fresh.status !== 'open') { closedErr = `closed_${fresh.status}`; return }
      if (fresh.deadline_at <= new Date().toISOString().replace('T', ' ').slice(0, 19)) { closedErr = 'expired'; return }
      // 价格重判（中间可能有别人插队）
      const curFresh = Number(fresh.current_price)
      const isFirstFresh = Number(fresh.bid_count) === 0
      if (isFirstFresh) {
        if (price < startingPrice) { closedErr = `below_starting_${startingPrice}`; return }
      } else {
        const minNeed = Math.round((curFresh + Number(auc.min_increment)) * 100) / 100
        if (price < minNeed) { closedErr = `below_min_${minNeed}`; return }
      }

      // 释放本人之前的 active bid
      const myPrev = db.prepare("SELECT id, stake_locked FROM auction_bids WHERE auction_id = ? AND buyer_id = ? AND status = 'active'").get(req.params.id, user.id) as { id: string; stake_locked: number } | undefined
      if (myPrev) {
        db.prepare("UPDATE auction_bids SET status = 'outbid', resolved_at = datetime('now') WHERE id = ?").run(myPrev.id)
        if (myPrev.stake_locked > 0) applyWalletDelta(db, user.id as string, { balance: toUnits(myPrev.stake_locked), staked: -toUnits(myPrev.stake_locked) })
      }
      // 释放别人的最高 active bid
      const others = db.prepare("SELECT id, buyer_id, stake_locked FROM auction_bids WHERE auction_id = ? AND status = 'active' AND buyer_id != ?").all(req.params.id, user.id) as Array<{ id: string; buyer_id: string; stake_locked: number }>
      for (const o of others) {
        db.prepare("UPDATE auction_bids SET status = 'outbid', resolved_at = datetime('now') WHERE id = ?").run(o.id)
        if (o.stake_locked > 0) applyWalletDelta(db, o.buyer_id, { balance: toUnits(o.stake_locked), staked: -toUnits(o.stake_locked) })
      }

      // 余额守恒 guard(Codex PR#228 P1):tx 内、释放本人旧 stake 之后、锁新 stake 之前重读余额。
      // 上面 `await dbOne` 预检与同步 tx 间的 yield 让并发请求都通过陈旧余额 → 双双锁押超额。
      // 此时 balance 已含本人旧 stake 的释放(若有),等价于预检的 availableForBid;不足即抛回滚。
      const wTx = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number } | undefined
      if (!wTx || Number(wTx.balance) < stake) throw new Error('AUC_INSUFFICIENT')

      // 插入新 bid
      db.prepare(`INSERT INTO auction_bids (id, auction_id, buyer_id, price, stake_locked) VALUES (?,?,?,?,?)`)
        .run(id, req.params.id, user.id, price, stake)
      applyWalletDelta(db, user.id as string, { balance: -toUnits(stake), staked: toUnits(stake) })

      // P1 #9：卖家 stake 动态补足（5% × current_price，余额不足则尽量补）
      const targetSellerStake = Math.max(1, Math.round(price * AUC_SELLER_STAKE_PCT * 100) / 100)
      const curSellerStake = Number(fresh.seller_stake_locked) || 0
      if (targetSellerStake > curSellerStake) {
        const delta = Math.round((targetSellerStake - curSellerStake) * 100) / 100
        const sWal = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(auc.seller_id) as { balance: number } | undefined
        const canTopup = sWal ? Math.min(delta, Number(sWal.balance)) : 0
        if (canTopup > 0) {
          applyWalletDelta(db, auc.seller_id as string, { balance: -toUnits(canTopup), staked: toUnits(canTopup) })
          db.prepare('UPDATE auctions SET seller_stake_locked = seller_stake_locked + ? WHERE id = ?').run(canTopup, req.params.id)
          sellerTopup = canTopup
        }
      }

      // P1 #5：反狙击延长（max_extends 上限保护）
      const sniperMin = Number(fresh.sniper_extend_min || 0)
      const deadlineMs = Date.parse(String(fresh.deadline_at).replace(' ', 'T') + 'Z')
      const nowMs = Date.now()
      const inSnipeWindow = sniperMin > 0 && deadlineMs - nowMs < sniperMin * 60_000
      const canExtend = Number(fresh.extends_used) < Number(fresh.max_extends || 10)
      if (inSnipeWindow && canExtend) {
        newDeadlineExt = sniperMin
        db.prepare(`UPDATE auctions SET current_price = ?, bid_count = bid_count + 1,
                    deadline_at = datetime(deadline_at, '+' || ? || ' minutes'),
                    extends_used = extends_used + 1,
                    updated_at = datetime('now') WHERE id = ?`).run(price, sniperMin, req.params.id)
      } else {
        db.prepare(`UPDATE auctions SET current_price = ?, bid_count = bid_count + 1, updated_at = datetime('now') WHERE id = ?`).run(price, req.params.id)
      }
    })()
    } catch (e) {
      if ((e as Error).message === 'AUC_INSUFFICIENT') {
        return void res.json({ error: `余额不足，出价押金 ${stake} WAZ（被超越后立即释放）` })
      }
      throw e
    }

    if (closedErr) {
      const ce = closedErr as string
      return void res.json({ error: ce === 'expired' ? '拍卖已到期' : ce === 'not_found' ? '拍卖不存在' : ce.startsWith('below_') ? '出价不足，请刷新页面查看当前最高价' : `拍卖已结束（${ce}）` })
    }

    // 通知卖家 + 被超越的买家(tx 后 fire-and-forget 单写 → seam)
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, created_at)
                  VALUES (?,?,'auction_new_bid',?,?,datetime('now'))`,
        [generateId('ntf'), auc.seller_id as string, `🔨 新出价 ${price} WAZ`, `拍卖：${String(auc.title).slice(0, 30)}`])
    } catch {}

    res.json({ id, stake_locked: stake, current_price: price, sniper_extended_min: newDeadlineExt, seller_topup: sellerTopup || undefined })
  })

  // 卖家：取消（仅未出价时）
  app.delete('/api/auctions/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const auc = await dbOne<Record<string, unknown>>('SELECT * FROM auctions WHERE id = ?', [req.params.id])
    if (!auc) return void res.status(404).json({ error: '拍卖不存在' })
    if (auc.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家本人可取消' })
    if (auc.status !== 'open') return void res.json({ error: `当前状态 ${auc.status} 不可取消` })
    if (Number(auc.bid_count) > 0) return void res.json({ error: '已有买家出价，无法取消' })

    const sellerStake = Number(auc.seller_stake_locked) || 0
    db.transaction(() => {
      db.prepare("UPDATE auctions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id)
      if (sellerStake > 0) applyWalletDelta(db, user.id as string, { balance: toUnits(sellerStake), staked: -toUnits(sellerStake) })
      if (auc.product_id) db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'auction_pending'").run(auc.product_id)
    })()
    res.json({ success: true, stake_released: sellerStake })
  })

  // Admin 手动跑提醒派发
  app.post('/api/admin/auction-reminders/run', (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const result = fireDueAuctionReminders(db, generateId)
    logAdminAction(admin.id as string, 'auction_reminders_run', 'protocol', null, { result })
    res.json(result)
  })
}
