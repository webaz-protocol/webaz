/**
 * E1 流量口令注册中心域 (Anchor Registry)
 *
 * 由 #1013 Phase 43 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST  /api/anchor/generate          生成 anchor (prefix+middle+tier_letter)
 *   GET   /api/anchor/:code/lookup      公开查找（含 owner / product 富化）
 *   POST  /api/anchor/:code/touch       写 attribution（first-touch + 30d 窗口）
 *   POST  /api/anchor/:code/retire      owner 主动退役
 *   GET   /api/anchor/me                我的 anchor + tier + quota
 *
 * 不变量：
 *   - target_kind ∈ {user, product, shareable, dispute_case}
 *   - lookup 公开（rate-limit 60/min），retired → 410，reclaimable → 404
 *   - touch first-touch 不覆盖；30d 过期
 *   - user anchor 批量 attribution 限 50 商品（防 DoS）
 *   - generate rate-limit 10/min
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  generateAnchor, lookupAnchor, retireAnchor,
  userReferralVolume, computeTierLetter, userAnchorQuotaStats,
  TIER_THRESHOLDS, ANCHOR_HANDLE_MAX_FOR_USE,
  type AnchorTargetKind,
} from '../../layer2-business/L2-anchor-registry/anchor-registry.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AnchorsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
}

export function registerAnchorsRoutes(app: Application, deps: AnchorsDeps): void {
  const { db, auth, rateLimitOk } = deps

  // POST /api/anchor/generate
  app.post('/api/anchor/generate', (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || 'anon', 10, 60_000)) return void res.status(429).json({ error: '生成过于频繁' })
    const { middle, target_kind, target_id } = req.body || {}
    if (!middle || !target_kind || !target_id) return void res.status(400).json({ error: 'middle / target_kind / target_id 必填' })
    if (!['user', 'product', 'shareable', 'dispute_case'].includes(target_kind)) {
      return void res.status(400).json({ error: 'target_kind 仅允许 user / product / shareable / dispute_case' })
    }
    const r = generateAnchor(db, {
      ownerId: user.id as string,
      middle: String(middle),
      targetKind: target_kind as AnchorTargetKind,
      targetId: String(target_id),
    })
    if (!r.ok) return void res.status(400).json({ error: r.reason })
    res.json({ ok: true, anchor: r.anchor, tier_letter: r.tier_letter })
  })

  // GET /api/anchor/:code/lookup — 公开（无需 auth）
  app.get('/api/anchor/:code/lookup', async (req, res) => {
    if (!rateLimitOk(req.ip || 'anon', 60, 60_000)) return void res.status(429).json({ error: 'too_many_lookups' })
    const r = lookupAnchor(db, String(req.params.code || ''))
    if (!r.found) return void res.status(404).json({ found: false })
    if (r.status === 'retired') {
      return void res.status(410).json({ found: true, status: 'retired', retired_at: r.retired_at, owner_id: r.owner_id, tier_letter: r.tier_letter, hint: 'archived' })
    }
    if (r.status === 'reclaimable') {
      return void res.status(404).json({ found: false, hint: 'reclaimable' })
    }
    // 2026-05-24 富化响应：附 owner 详情 + 商品推荐指数
    const owner = await dbOne<Record<string, unknown>>(`
      SELECT u.name, u.handle, u.region, u.created_at, u.bio,
        (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) as follower_count,
        (SELECT COALESCE(SUM(s.like_count), 0) FROM shareables s WHERE s.owner_id = u.id AND s.status = 'active') as total_likes_received
      FROM users u WHERE u.id = ? AND u.id != 'sys_protocol'
    `, [r.owner_id])

    let product: Record<string, unknown> | null = null
    if (r.target_kind === 'product') {
      product = (await dbOne<Record<string, unknown>>(`
        SELECT p.id, p.title, p.price, p.category, p.images, p.completion_count, p.total_likes,
          (SELECT COUNT(DISTINCT buyer_id) FROM order_ratings rt WHERE rt.product_id = p.id AND rt.stars >= 4) as recommend_count,
          (SELECT ROUND(AVG(stars), 2) FROM order_ratings rt WHERE rt.product_id = p.id) as avg_rating,
          (SELECT COUNT(*) FROM order_ratings rt WHERE rt.product_id = p.id) as rating_count,
          u.handle as seller_handle, u.name as seller_name
        FROM products p LEFT JOIN users u ON u.id = p.seller_id
        WHERE p.id = ? AND p.status = 'active'
      `, [r.target_id])) ?? null
    } else if (r.target_kind === 'shareable') {
      const sh = await dbOne<{ related_product_id: string | null }>(`SELECT related_product_id FROM shareables WHERE id = ?`, [r.target_id])
      if (sh?.related_product_id) {
        product = (await dbOne<Record<string, unknown>>(`
          SELECT p.id, p.title, p.price, p.category, p.images, p.completion_count, p.total_likes,
            (SELECT COUNT(DISTINCT buyer_id) FROM order_ratings rt WHERE rt.product_id = p.id AND rt.stars >= 4) as recommend_count,
            (SELECT ROUND(AVG(stars), 2) FROM order_ratings rt WHERE rt.product_id = p.id) as avg_rating,
            (SELECT COUNT(*) FROM order_ratings rt WHERE rt.product_id = p.id) as rating_count,
            u.handle as seller_handle, u.name as seller_name
          FROM products p LEFT JOIN users u ON u.id = p.seller_id
          WHERE p.id = ? AND p.status = 'active'
        `, [sh.related_product_id])) ?? null
      }
    }

    res.json({
      found: true, status: 'active',
      target_kind: r.target_kind,
      target_id: r.target_id,
      owner_id: r.owner_id,
      tier_letter: r.tier_letter,
      owner,
      product,
    })
  })

  // POST /api/anchor/:code/touch — 写 attribution（first-touch + 30d）
  app.post('/api/anchor/:code/touch', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = lookupAnchor(db, String(req.params.code || ''))
    if (!r.found || r.status !== 'active') return void res.status(404).json({ error: 'anchor_not_active' })
    if (r.owner_id === user.id) return void res.json({ ok: true, skipped: 'self_anchor' })

    let attributedProducts = 0
    const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ')

    if (r.target_kind === 'product') {
      const existing = await dbOne(`SELECT 1 FROM product_share_attribution WHERE product_id = ? AND recipient_id = ?`, [r.target_id, user.id])
      if (!existing) {
        await dbRun(`INSERT INTO product_share_attribution (product_id, recipient_id, sharer_id, shareable_id, expires_at) VALUES (?,?,?,NULL,?)`,
          [r.target_id, user.id, r.owner_id, expiresAt])
        attributedProducts = 1
      }
    } else if (r.target_kind === 'shareable') {
      const s = await dbOne<{ id: string; related_product_id: string | null }>(`SELECT id, related_product_id FROM shareables WHERE id = ?`, [r.target_id])
      if (s?.related_product_id) {
        const existing = await dbOne(`SELECT 1 FROM product_share_attribution WHERE product_id = ? AND recipient_id = ?`, [s.related_product_id, user.id])
        if (!existing) {
          await dbRun(`INSERT INTO product_share_attribution (product_id, recipient_id, sharer_id, shareable_id, expires_at) VALUES (?,?,?,?,?)`,
            [s.related_product_id, user.id, r.owner_id, s.id, expiresAt])
          attributedProducts = 1
        }
      }
    } else if (r.target_kind === 'user') {
      // 限 LIMIT 50 防 DoS
      const ownerProducts = await dbAll<{ id: string }>(`SELECT id FROM products WHERE seller_id = ? AND status = 'active' ORDER BY last_sold_at DESC NULLS LAST LIMIT 50`, [r.owner_id])
      db.transaction(() => {
        for (const p of ownerProducts) {
          const existing = db.prepare(`SELECT 1 FROM product_share_attribution WHERE product_id = ? AND recipient_id = ?`).get(p.id, user.id)
          if (existing) continue
          db.prepare(`INSERT INTO product_share_attribution (product_id, recipient_id, sharer_id, shareable_id, expires_at) VALUES (?,?,?,NULL,?)`)
            .run(p.id, user.id, r.owner_id, expiresAt)
          attributedProducts++
        }
      })()
    }
    // dispute_case：无商业 attribution

    res.json({
      ok: true,
      target_kind: r.target_kind,
      target_id: r.target_id,
      owner_id: r.owner_id,
      tier_letter: r.tier_letter,
      attributed_products: attributedProducts,
    })
  })

  app.post('/api/anchor/:code/retire', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = retireAnchor(db, user.id as string, String(req.params.code || ''))
    if (!r.ok) {
      const status = r.reason === 'not_found' ? 404 : r.reason === 'not_owner' ? 403 : 400
      return void res.status(status).json({ error: r.reason })
    }
    res.json({ ok: true })
  })

  app.get('/api/anchor/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT anchor, prefix, middle, tier_letter, target_kind, target_id, status, retired_at, hits, last_hit_at, created_at
      FROM anchor_registry WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100
    `, [user.id as string])
    const vol = userReferralVolume(db, user.id as string)
    const tier = computeTierLetter(vol)
    const quota = userAnchorQuotaStats(db, user.id as string)
    res.json({
      items: rows,
      current_tier: tier,
      referral_volume: vol,
      handle_max_for_anchor: ANCHOR_HANDLE_MAX_FOR_USE,
      tier_thresholds: TIER_THRESHOLDS,
      quota,
    })
  })
}
