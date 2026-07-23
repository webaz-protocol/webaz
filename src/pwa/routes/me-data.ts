/**
 * 用户自我数据域 — COP 飞轮 + 数据主权
 *
 * 由 #1013 Phase 39 从 src/pwa/server.ts 抽出。两个 /me/* 数据端点合并：
 *
 * 2 endpoints:
 *   GET /api/me/note-prompts    7d 内完成但未发笔记的订单（COP 顶部 banner 用）
 *   GET /api/me/export          全量数据导出（GDPR / CCPA / 个保法 compliant, JSON 或 CSV）
 *
 * 注释：
 *   - note-prompts dismiss 状态在前端 localStorage 维护，无后端持久化
 *   - export?format=csv 仅导 orders 主表（join 太复杂时 JSON 更友好）
 *   - 钱包流水复合：deposit_txns + withdrawal_requests + commission_records
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { projectDirectPayTargetForViewer } from '../direct-pay-order-redaction.js'  // 披露门:自导出的 orders 也按查看者投影,不得旁路

export interface MeDataDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerMeDataRoutes(app: Application, deps: MeDataDeps): void {
  // db 走 RFC-016 异步 seam(dbOne/dbAll);deps.db 仅供披露门(requireBothDisclosuresAcked 是同步 gate)
  const { auth, db } = deps

  // COP 飞轮: 完成订单 7d 引导发笔记
  app.get('/api/me/note-prompts', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<{
      order_id: string; product_id: string; completed_at: string;
      total_amount: number; product_title: string; product_images: string | null;
    }>(`
      SELECT o.id as order_id, o.product_id, o.updated_at as completed_at, o.total_amount,
             p.title as product_title, p.images as product_images
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE o.buyer_id = ?
        AND o.status IN ('confirmed', 'completed')
        AND datetime(o.updated_at) > datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1 FROM shareables s
          WHERE s.owner_id = ? AND s.related_order_id = o.id AND s.type = 'note' AND s.status = 'active'
        )
      ORDER BY o.updated_at DESC
      LIMIT 10
    `, [user.id, user.id])
    const prompts = rows.map(r => {
      let firstImage: string | null = null
      try {
        const arr = JSON.parse(r.product_images || '[]')
        if (Array.isArray(arr) && arr.length > 0) firstImage = String(arr[0])
      } catch {}
      return {
        order_id: r.order_id,
        product_id: r.product_id,
        product_title: r.product_title,
        product_image: firstImage,
        completed_at: r.completed_at,
        total_amount: r.total_amount,
      }
    })
    res.json({ prompts })
  })

  // COP P0-1: 数据导出（用户主权）
  app.get('/api/me/export', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const uid = user.id as string
    const data: Record<string, unknown> = {
      exported_at: new Date().toISOString(),
      user_id: uid,
      notice: 'WebAZ COP 承诺：你的数据属于你。可随时导出，可随时迁出。',
    }
    try {
      // P2-E:reputation = 真实台账 reputation_scores.total_points(旧 users.reputation 静止列废弃不读)
      data.profile = await dbOne(`SELECT u.id, u.name, u.handle, u.role, u.region, u.bio, u.search_anchor, u.email, u.phone, u.permanent_code, u.created_at, COALESCE(rs.total_points, 0) AS reputation FROM users u LEFT JOIN reputation_scores rs ON rs.user_id = u.id WHERE u.id = ?`, [uid])
      data.wallet = await dbOne(`SELECT balance, staked, escrowed, earned FROM wallets WHERE user_id = ?`, [uid])
      data.orders = await dbAll(`SELECT * FROM orders WHERE buyer_id = ? OR seller_id = ? ORDER BY created_at DESC LIMIT 1000`, [uid, uid])
      for (const o of data.orders as Array<Record<string, unknown>>) projectDirectPayTargetForViewer(db, o, uid)  // 披露门:自导出按查看者投影(买家行=ack 门/卖家行=收款方保留),JSON + CSV 同源
      data.shareables = await dbAll(`SELECT * FROM shareables WHERE owner_id = ? AND status != 'removed'`, [uid])
      data.bookmarks = await dbAll(`SELECT b.*, s.title FROM shareable_bookmarks b LEFT JOIN shareables s ON s.id = b.shareable_id WHERE b.user_id = ?`, [uid])
      data.likes = await dbAll(`SELECT l.*, s.title FROM shareable_likes l LEFT JOIN shareables s ON s.id = l.shareable_id WHERE l.user_id = ?`, [uid])
      data.follows_following = await dbAll(`SELECT followee_id, created_at FROM follows WHERE follower_id = ?`, [uid])
      data.follows_followers = await dbAll(`SELECT follower_id, created_at FROM follows WHERE followee_id = ?`, [uid])
      data.addresses = await dbAll(`SELECT * FROM user_addresses WHERE user_id = ?`, [uid])
      data.kyc = await dbOne(`SELECT status, id_type, id_number_last4, submitted_at, reviewed_at FROM kyc_records WHERE user_id = ?`, [uid])
      // #1017: wallet_history 不存在 — 用 deposits + withdrawals + commissions 复合
      try { data.deposits = await dbAll(`SELECT * FROM deposit_txns WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`, [uid]) } catch { data.deposits = [] }
      try { data.withdrawals = await dbAll(`SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`, [uid]) } catch { data.withdrawals = [] }
      data.commissions = await dbAll(`SELECT * FROM commission_records WHERE beneficiary_id = ? ORDER BY created_at DESC LIMIT 500`, [uid]) || []
      data.anchors = await dbAll(`SELECT anchor, target_kind, target_id, status, created_at FROM anchor_registry WHERE owner_id = ?`, [uid])
      data.notifications = await dbAll(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`, [uid])
      data.error_log = await dbAll(`SELECT id, source, message, created_at FROM error_log WHERE user_id = ? ORDER BY id DESC LIMIT 100`, [uid]) || []
    } catch (e) {
      console.warn('[export] partial:', (e as Error).message)
    }

    const format = String(req.query.format || 'json').toLowerCase()
    if (format === 'csv') {
      // CSV：只导 orders 主表
      const orders = data.orders as Array<Record<string, unknown>>
      if (!orders || orders.length === 0) return void res.status(204).end()
      const cols = Object.keys(orders[0])
      const csv = [cols.join(',')].concat(orders.map(o => cols.map(c => JSON.stringify(o[c] ?? '')).join(','))).join('\n')
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="webaz-orders-${uid}-${Date.now()}.csv"`)
      return void res.send(csv)
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="webaz-export-${uid}-${Date.now()}.json"`)
    res.json(data)
  })
}
