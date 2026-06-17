/**
 * Follows 域 — 关注 / 取关 / 状态查询 / 双向列表 + feed
 *
 * 由 #1013 Phase 10 从 src/pwa/server.ts 抽出，Phase 35 补 /feed。
 *
 * 5 endpoints:
 *   GET    /api/follows/:user_id/status  — 查关注状态 + 双向计数
 *   POST   /api/follows/:user_id         — 关注（含首次关注通知）
 *   DELETE /api/follows/:user_id         — 取关
 *   GET    /api/follows/me               — 我的 followers + following 列表
 *   GET    /api/follows/feed             — Wave D-1: 关注卖家动态 feed（new_product + restock）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface FollowsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerFollowsRoutes(app: Application, deps: FollowsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, generateId } = deps

  app.get('/api/follows/:user_id/status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbOne("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?", [user.id, req.params.user_id])
    const followers = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM follows WHERE followee_id=?", [req.params.user_id]))!.n
    const following = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM follows WHERE follower_id=?", [req.params.user_id]))!.n
    res.json({ following: !!r, followers, following_count: following })
  })

  app.post('/api/follows/:user_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.id === req.params.user_id) return void res.json({ error: '不能关注自己' })
    const target = await dbOne<{ id: string }>("SELECT id FROM users WHERE id=?", [req.params.user_id])
    if (!target) return void res.json({ error: '用户不存在' })
    const result = await dbRun("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)", [user.id, req.params.user_id])
    // 2026-05-24 新关注 → 通知被关注者（仅首次关注时；重复点击不重发）
    if (result.changes > 0) {
      try {
        const followerName = await dbOne<{ name: string; handle: string }>("SELECT name, handle FROM users WHERE id = ?", [user.id])
        const display = followerName?.handle ? '@' + followerName.handle : followerName?.name || 'someone'
        await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`,
          [generateId('ntf'), req.params.user_id, 'social', `🤝 新关注`, `${display} 关注了你`, null])
      } catch (e) { console.error('[follow notif]', e) }
    }
    res.json({ ok: true, following: true })
  })

  app.delete('/api/follows/:user_id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    await dbRun("DELETE FROM follows WHERE follower_id=? AND followee_id=?", [user.id, req.params.user_id])
    res.json({ ok: true, following: false })
  })

  app.get('/api/follows/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const followers = await dbAll(`
      SELECT u.id, u.name, u.role, f.created_at
      FROM follows f JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT 100
    `, [user.id])
    const following = await dbAll(`
      SELECT u.id, u.name, u.role, f.created_at
      FROM follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 100
    `, [user.id])
    res.json({ followers, following })
  })

  // Wave D-1: 关注卖家动态 feed — new_product + restock 合并 + 去重
  app.get('/api/follows/feed', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50))
    const followees = await dbAll<{ followee_id: string }>(`SELECT followee_id FROM follows WHERE follower_id = ?`, [user.id])
    if (followees.length === 0) return void res.json({ items: [] })
    const ids = followees.map(f => f.followee_id)
    const placeholders = ids.map(() => '?').join(',')
    // 新品（近 30 天 active）
    const newProducts = await dbAll<Record<string, unknown>>(`
      SELECT 'new_product' as type, p.created_at as ts, p.id as product_id, p.title, p.price, p.stock, p.category, p.images,
             u.id as seller_id, u.name as seller_name, u.handle as seller_handle
      FROM products p JOIN users u ON u.id = p.seller_id
      WHERE p.seller_id IN (${placeholders}) AND p.status = 'active'
        AND p.created_at > datetime('now', '-30 days')
      ORDER BY p.created_at DESC LIMIT 100
    `, ids)
    // 重新上架 / 补货（近 7 天 updated_at > created_at + 1 天，stock > 0）
    const restocks = await dbAll<Record<string, unknown>>(`
      SELECT 'restock' as type, p.updated_at as ts, p.id as product_id, p.title, p.price, p.stock, p.category, p.images,
             u.id as seller_id, u.name as seller_name, u.handle as seller_handle
      FROM products p JOIN users u ON u.id = p.seller_id
      WHERE p.seller_id IN (${placeholders}) AND p.status = 'active'
        AND p.stock > 0
        AND p.updated_at > datetime('now', '-7 days')
        AND p.updated_at > datetime(p.created_at, '+1 days')
      ORDER BY p.updated_at DESC LIMIT 30
    `, ids)
    // 合并 + 去重（同 product 同时 new + restock → 优先 new）
    const seen = new Set<string>()
    const merged: Array<Record<string, unknown>> = []
    for (const item of [...newProducts, ...restocks]) {
      const prodKey = String(item.product_id)
      if (seen.has(prodKey)) continue
      seen.add(prodKey)
      merged.push(item)
    }
    merged.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    res.json({ items: merged.slice(0, limit) })
  })
}
