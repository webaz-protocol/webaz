/**
 * 公开用户主页 / Profile 域
 *
 * 由 #1013 Phase 47 从 src/pwa/server.ts 抽出。聚合 6 个 /api/users/:id/* 端点。
 *
 * 6 endpoints:
 *   GET /api/users/:id/reputation          公开 reputation level
 *   GET /api/users/:id/pv-summary          PV 简报（组织图节点点击用）
 *   GET /api/users/:id/shareables          用户公开 shareables
 *   GET /api/users/:id/liked-shareables    用户赞过的 shareables（仅 owner）
 *   GET /api/users/:id/public-card         未登录可调，分享 banner 用
 *   GET /api/users/:user_id                公开用户主页（含 D2 信誉徽章墙）
 *
 * Lookup 三态：usr_xxx / permanent_code (6-7 大写字母数字) / @handle
 *
 * 隐私：
 *   - reputation 仅显示 level（数值给 owner 自己看 — agent.trust_score）
 *   - liked-shareables 仅 owner 自己可见
 *   - private_stats（wallet/PV）仅 owner 自己可见
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { projectWalletForSunset } from '../../waz-escrow-channel.js'   // WAZ 退役:owner private_stats wallet 零化

export interface UsersPublicDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
  noteAuthenticityBadges: (row: { owner_id: unknown; related_order_id: unknown; photo_hashes: unknown; created_at: unknown }) => { verified_buyer: boolean; original_photos: boolean }
}

export function registerUsersPublicRoutes(app: Application, deps: UsersPublicDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { auth, noteAuthenticityBadges, getProtocolParam } = deps

  // ref → user id（usr_xxx / permanent_code / @handle 三态）
  const resolveUserId = async (ref0: string): Promise<string | null> => {
    const ref = String(ref0 || '').trim()
    if (/^usr_[A-Za-z0-9_]+$/.test(ref)) return ref
    if (/^[A-Z0-9]{6,7}$/i.test(ref) && !ref.startsWith('@')) {
      const r = await dbOne<{ id: string }>("SELECT id FROM users WHERE permanent_code = ?", [ref.toUpperCase()])
      if (r) return r.id
    }
    const h = ref.replace(/^@/, '').toLowerCase()
    const r = await dbOne<{ id: string }>("SELECT id FROM users WHERE handle = ?", [h])
    return r ? r.id : null
  }

  // 公开 reputation — 仅 level
  app.get('/api/users/:id/reputation', async (req, res) => {
    let userId = req.params.id
    if (userId === 'me') {
      const user = auth(req, res); if (!user) return
      userId = user.id as string
    } else {
      // ref 三态(usr_xxx / permanent_code / @handle)必须解析为 canonical id;
      // 漏掉解析会让 @handle/permanent_code 当字面 user_id 去查 → 永远落到默认 'new'。
      const resolved = await resolveUserId(userId)
      if (!resolved) return void res.status(404).json({ error: 'user not found' })
      userId = resolved
    }
    const row = await dbOne<{ level: string; max_score: number }>(`
      SELECT level, MAX(trust_score) as max_score
      FROM agent_reputation WHERE user_id = ?
      GROUP BY user_id
    `, [userId])
    if (!row) return void res.json({ user_id: userId, level: 'new' })
    res.json({ user_id: userId, level: row.level })
  })

  // PV 简报：组织图点击节点用
  app.get('/api/users/:id/pv-summary', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const ref = String(req.params.id || '').trim()
    let targetId: string | null = null
    if (/^usr_[A-Za-z0-9_]+$/.test(ref)) targetId = ref
    else if (/^[A-Z0-9]{6,7}$/i.test(ref) && !ref.startsWith('@')) {
      const r = await dbOne<{ id: string }>("SELECT id FROM users WHERE permanent_code = ?", [ref.toUpperCase()])
      if (r) targetId = r.id
    }
    if (!targetId) return void res.json({ error: 'user not found' })

    const u = await dbOne<Record<string, unknown>>(`
      SELECT id, name, permanent_code, handle, total_left_pv, total_right_pv,
             placement_id, placement_side, placement_depth, left_child_id, right_child_id, created_at
      FROM users WHERE id = ?
    `, [targetId])
    if (!u) return void res.json({ error: 'user not found' })

    const placementName = u.placement_id ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [u.placement_id]))?.name : null
    const leftChildName = u.left_child_id ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [u.left_child_id]))?.name : null
    const rightChildName = u.right_child_id ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [u.right_child_id]))?.name : null
    const leftPv  = Number(u.total_left_pv  ?? 0)
    const rightPv = Number(u.total_right_pv ?? 0)
    // 匹配奖励引擎已切除(#401):public 端口只保留位置 + 左右区 PV 作为参与记录,不暴露任何奖励指标。
    res.json({
      id: u.id,
      name: u.name,
      permanent_code: u.permanent_code || null,
      handle: u.handle || null,
      placement: u.placement_id ? { id: u.placement_id, name: placementName, side: u.placement_side, depth: u.placement_depth } : null,
      left_child:  u.left_child_id  ? { id: u.left_child_id,  name: leftChildName  } : null,
      right_child: u.right_child_id ? { id: u.right_child_id, name: rightChildName } : null,
      total_left_pv:  leftPv,
      total_right_pv: rightPv,
      joined_at:      u.created_at,
    })
  })

  // 用户公开 shareables
  app.get('/api/users/:id/shareables', async (req, res) => {
    const ref = String(req.params.id || '').trim()
    let ownerId: string | null = null
    if (/^usr_[A-Za-z0-9_]+$/.test(ref)) ownerId = ref
    else if (/^[A-Z0-9]{6,7}$/i.test(ref) && !ref.startsWith('@')) {
      const r = await dbOne<{ id: string }>("SELECT id FROM users WHERE permanent_code = ?", [ref.toUpperCase()])
      if (r) ownerId = r.id
    }
    if (!ownerId) {
      const h = ref.replace(/^@/, '').toLowerCase()
      const r = await dbOne<{ id: string }>("SELECT id FROM users WHERE handle = ?", [h])
      if (r) ownerId = r.id
    }
    if (!ownerId) return void res.status(404).json({ error: 'user not found' })
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT s.id, s.owner_id, s.owner_code, s.type, s.external_url, s.external_platform, s.external_video_id,
             s.thumbnail_url, s.title, s.description, s.related_product_id, s.related_anchor,
             s.related_order_id, s.photo_hashes,
             s.click_count, s.created_at,
             p.title AS product_title
      FROM shareables s
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE s.owner_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC LIMIT 100
    `, [ownerId])
    for (const r of rows) {
      r.badges = noteAuthenticityBadges(r as { owner_id: string; related_order_id: string | null; photo_hashes: string | null; created_at: string })
    }
    res.json({ shareables: rows })
  })

  // 用户在售二手（公开：available + reserved）
  app.get('/api/users/:id/secondhand', async (req, res) => {
    const ownerId = await resolveUserId(req.params.id)
    if (!ownerId) return void res.status(404).json({ error: 'user not found' })
    const items = await dbAll<Record<string, unknown>>(`
      SELECT id, title, price, condition_grade, images, status, category, created_at
      FROM secondhand_items
      WHERE seller_id = ? AND status IN ('available', 'reserved')
      ORDER BY created_at DESC LIMIT 50
    `, [ownerId])
    res.json({ items })
  })

  // 用户进行中拍卖（公开：open）
  app.get('/api/users/:id/auctions', async (req, res) => {
    const ownerId = await resolveUserId(req.params.id)
    if (!ownerId) return void res.status(404).json({ error: 'user not found' })
    const items = await dbAll<Record<string, unknown>>(`
      SELECT id, title, current_price, starting_price, status, deadline_at, bid_count, category, created_at
      FROM auctions
      WHERE seller_id = ? AND status = 'open' AND deadline_at > datetime('now')
      ORDER BY deadline_at ASC LIMIT 50
    `, [ownerId])
    res.json({ items })
  })

  // 用户写的测评（公开：作为买家给出的评价）
  app.get('/api/users/:id/reviews', async (req, res) => {
    const ownerId = await resolveUserId(req.params.id)
    if (!ownerId) return void res.status(404).json({ error: 'user not found' })
    const items = await dbAll<Record<string, unknown>>(`
      SELECT r.order_id, r.product_id, r.stars, r.comment, r.reply, r.created_at,
             p.title AS product_title, p.images AS product_images
      FROM order_ratings r
      LEFT JOIN products p ON p.id = r.product_id
      WHERE r.buyer_id = ? AND (r.hidden_until IS NULL OR r.hidden_until <= datetime('now'))
      ORDER BY r.created_at DESC LIMIT 50
    `, [ownerId])
    res.json({ items })
  })

  // 用户在售商品（公开：卖家 active 商品）
  app.get('/api/users/:id/products', async (req, res) => {
    const ownerId = await resolveUserId(req.params.id)
    if (!ownerId) return void res.status(404).json({ error: 'user not found' })
    const items = await dbAll<Record<string, unknown>>(`
      SELECT id, title, price, images, category, completion_count, total_likes, created_at
      FROM products
      WHERE seller_id = ? AND status = 'active' AND stock > 0
      ORDER BY completion_count DESC, created_at DESC LIMIT 50
    `, [ownerId])
    res.json({ items })
  })

  // 用户赞过的 shareables（仅 owner 可见）
  app.get('/api/users/:id/liked-shareables', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const ref = String(req.params.id || '').trim()
    let ownerId: string | null = null
    if (ref === 'me' || ref === me.id) ownerId = me.id as string
    if (!ownerId) return void res.status(403).json({ error: 'only owner can view liked list' })
    const rows = await dbAll(`
      SELECT s.id, s.owner_id, s.owner_code, s.type, s.external_url, s.external_platform,
             s.thumbnail_url, s.title, s.description, s.photo_hashes, s.related_product_id, s.related_anchor,
             s.click_count, s.like_count, s.created_at,
             p.title AS product_title,
             l.created_at as liked_at
      FROM shareable_likes l
      JOIN shareables s ON s.id = l.shareable_id
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE l.user_id = ? AND s.status = 'active'
      ORDER BY l.created_at DESC LIMIT 100
    `, [ownerId])
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r.photo_hashes === 'string') {
        try { r.photo_hashes = JSON.parse(r.photo_hashes as string) } catch { r.photo_hashes = [] }
      }
    }
    res.json({ shareables: rows })
  })

  // 公开卡（未登录可调，分享 banner 用）
  app.get('/api/users/:id/public-card', async (req, res) => {
    const ref = String(req.params.id || '').trim()
    const cols = "id, name, bio, search_anchor, created_at, permanent_code, handle"
    const filter = " AND id != 'sys_protocol'"
    let row: Record<string, unknown> | undefined
    if (/^usr_[A-Za-z0-9_]+$/.test(ref)) {
      row = await dbOne<Record<string, unknown>>(`SELECT ${cols} FROM users WHERE id = ?${filter}`, [ref])
    }
    if (!row && /^[A-Z0-9]{6,7}$/.test(ref.toUpperCase()) && !ref.startsWith('@')) {
      row = await dbOne<Record<string, unknown>>(`SELECT ${cols} FROM users WHERE permanent_code = ?${filter}`, [ref.toUpperCase()])
    }
    if (!row) {
      const h = ref.replace(/^@/, '').toLowerCase()
      row = await dbOne<Record<string, unknown>>(`SELECT ${cols} FROM users WHERE handle = ?${filter}`, [h])
    }
    if (!row) return void res.status(404).json({ error: 'not_found' })
    const created = String(row.created_at || '')
    const days = created ? Math.floor((Date.now() - new Date(created).getTime()) / 86400_000) : null
    res.json({
      id: row.id,
      permanent_code: row.permanent_code || null,
      handle: row.handle || null,
      name: row.name,
      bio: row.bio || null,
      search_anchor: row.search_anchor || null,
      joined_days_ago: days,
    })
  })

  // 公开用户主页 + D2 信誉徽章墙
  app.get('/api/users/:user_id', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const ref = String(req.params.user_id || '').trim()
    // P2-E:reputation = 真实台账 reputation_scores.total_points(旧 users.reputation 静止列废弃不读)
    const cols = "u.id, u.name, u.role, u.region, u.bio, u.search_anchor, u.created_at, COALESCE(rs.total_points, 0) AS reputation, COALESCE(u.feed_visible, 1) as feed_visible"
    let target: Record<string, unknown> | undefined
    if (/^usr_[A-Za-z0-9_]+$/.test(ref)) {
      target = await dbOne<Record<string, unknown>>(`SELECT ${cols} FROM users u LEFT JOIN reputation_scores rs ON rs.user_id = u.id WHERE u.id = ? AND u.id != 'sys_protocol'`, [ref])
    } else if (/^[A-Z0-9]{6,7}$/.test(ref) && !ref.startsWith('@')) {
      target = await dbOne<Record<string, unknown>>(`SELECT ${cols} FROM users u LEFT JOIN reputation_scores rs ON rs.user_id = u.id WHERE u.permanent_code = ? AND u.id != 'sys_protocol'`, [ref.toUpperCase()])
    }
    if (!target) {
      const h = ref.replace(/^@/, '').toLowerCase()
      target = await dbOne<Record<string, unknown>>(`SELECT ${cols} FROM users u LEFT JOIN reputation_scores rs ON rs.user_id = u.id WHERE u.handle = ? AND u.id != 'sys_protocol'`, [h])
    }
    if (!target) return void res.status(404).json({ error: '用户不存在' })

    const followers = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM follows WHERE followee_id = ?", [target.id]))!.n
    const following = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM follows WHERE follower_id = ?", [target.id]))!.n
    const isFollowing = !!(await dbOne("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?", [me.id, target.id]))
    const purchaseCount = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND status = 'completed'", [target.id]))!.n
    const salesCount    = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM orders WHERE seller_id = ? AND status = 'completed'", [target.id]))!.n
    const likesReceived = (await dbOne<{ n: number }>("SELECT COALESCE(SUM(like_count), 0) as n FROM shareables WHERE owner_id = ? AND status = 'active'", [target.id]))!.n

    // 主人视角加私有统计
    const isOwner = me.id === target.id
    let privateStats: Record<string, unknown> | null = null
    if (isOwner) {
      // WAZ 退役(2026-07-23):渠道关 → wallet_* 零化(与 /api/wallet sunset DTO 同真值);PV 是参与记录非余额,保留
      const w = projectWalletForSunset(getProtocolParam, await dbOne<{ balance: number; earned: number }>('SELECT balance, earned FROM wallets WHERE user_id = ?', [me.id]))
      const pv = await dbOne<{ total_left_pv: number; total_right_pv: number }>("SELECT total_left_pv, total_right_pv FROM users WHERE id = ?", [me.id])
      privateStats = {
        ...(w && (w as Record<string, unknown>).waz_sunset ? { waz_sunset: true } : {}),
        wallet_balance: Number((w as Record<string, unknown> | null)?.balance ?? 0),
        wallet_earned:  Number((w as Record<string, unknown> | null)?.earned  ?? 0),
        total_left_pv:  Number(pv?.total_left_pv  ?? 0),
        total_right_pv: Number(pv?.total_right_pv ?? 0),
      }
    }
    // D2 信誉徽章墙
    const rep = Number(target.reputation ?? 0)
    const commercialLevel =
      rep >= 400 ? { tier: 5, label: '传奇', emoji: '🌟', color: '#dc2626' } :
      rep >= 200 ? { tier: 4, label: '专家', emoji: '👑', color: '#9333ea' } :
      rep >= 100 ? { tier: 3, label: '资深', emoji: '⭐', color: '#4f46e5' } :
      rep >= 30  ? { tier: 2, label: '可靠', emoji: '✓',  color: '#16a34a' } :
                   { tier: 1, label: '新手', emoji: '🌱', color: '#9ca3af' }
    // Agent trust band（P1.2 隐私：trust_score 仅 owner 看，他人仅 level）
    const agentRow = await dbOne<{ level: string; score: number }>(`SELECT level, MAX(trust_score) as score FROM agent_reputation WHERE user_id = ? GROUP BY user_id`, [target.id])
    const agentBand = agentRow ? (isOwner
      ? { level: agentRow.level, score: Math.round(agentRow.score || 0) }
      : { level: agentRow.level }) : null
    const charity = await dbOne<{ prestige_score: number; badge_tier: string; wishes_fulfilled: number; wishes_made: number }>(`SELECT prestige_score, badge_tier, wishes_fulfilled, wishes_made FROM charity_reputation WHERE user_id = ?`, [target.id])
    let verifier: { tier: string } | undefined
    try { verifier = await dbOne<{ tier: string }>(`SELECT tier FROM verifier_whitelist WHERE user_id = ?`, [target.id]) } catch {}

    res.json({
      id: target.id, name: target.name, role: target.role, region: target.region,
      bio: target.bio, search_anchor: target.search_anchor, created_at: target.created_at,
      feed_visible: Number(target.feed_visible),
      followers, following, is_following: isFollowing,
      purchase_count: purchaseCount, sales_count: salesCount, likes_received: likesReceived,
      is_owner: isOwner,
      private_stats: privateStats,
      badges: {
        commercial: { ...commercialLevel, score: rep },
        agent: agentBand,
        charity: charity ? { prestige: Math.round(charity.prestige_score || 0), badge: charity.badge_tier, fulfilled: charity.wishes_fulfilled || 0, made: charity.wishes_made || 0 } : null,
        verifier: verifier ? { tier: verifier.tier } : null,
      },
    })
  })
}
