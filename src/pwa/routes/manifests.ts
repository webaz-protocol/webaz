/**
 * Manifest Registry 域 (L0-5 P2P 原生内容)
 *
 * 由 #1013 Phase 40 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints:
 *   POST   /api/manifests                       发布（HMAC 签名校验 + 日限 20）
 *   GET    /api/manifests/me                    我发布的
 *   GET    /api/manifests/:hash                 详情 + 在线 peers (5min heartbeat)
 *   GET    /api/manifests/by-product/:pid       按商品查
 *   GET    /api/manifests/by-anchor/:anchor     按口令查
 *   PATCH  /api/manifests/:hash/takedown        下架（owner / admin）
 *
 * 不变量：
 *   - hash 必须是 64 字符十六进制
 *   - byte_size ≤ 500MB，缩略图 ≤ 9KB 原始 / 12KB base64
 *   - 日上限 MANIFEST_DAILY_LIMIT=20
 *   - 关联商品或 anchor 至少一个
 *   - HMAC-SHA256 签名：`hash|ownerId|content_type|byte_size|signed_at` × api_key
 *   - 创作者自动注册为 owner peer
 *   - admin 下架 → status='takedown_admin'，owner 下架 → status='removed'
 *
 * 留 server.ts：/api/manifest（公开协议规范端点，与 manifest_registry 不同）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import crypto from 'crypto'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const MANIFEST_DAILY_LIMIT = 20
const THUMB_MAX_BYTES = 12000   // ~12KB base64 ≈ 9KB 原始图

function verifyManifestSig(hash: string, ownerId: string, contentType: string, byteSize: number, signedAt: string, apiKey: string, signature: string): boolean {
  const payload = `${hash}|${ownerId}|${contentType}|${byteSize}|${signedAt}`
  const expected = crypto.createHmac('sha256', apiKey).update(payload).digest('hex')
  return expected === signature
}

export interface ManifestsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeRoles: (user: Record<string, unknown> | undefined | null) => string[]
}

export function registerManifestsRoutes(app: Application, deps: ManifestsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, safeRoles } = deps

  app.post('/api/manifests', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const { hash, content_type, byte_size, title, description, thumbnail_data_uri, signature, signed_at, related_product_id, related_anchor } = req.body || {}
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return void res.json({ error: 'hash 必须为 64 字符十六进制' })
    if (!content_type || !signature || !signed_at) return void res.json({ error: '缺少必要字段' })
    if (typeof byte_size !== 'number' || byte_size <= 0 || byte_size > 500 * 1024 * 1024) return void res.json({ error: 'byte_size 不合法（最大 500MB）' })
    if (!related_product_id && !related_anchor) return void res.json({ error: '请关联商品或流量口令' })
    if (thumbnail_data_uri && thumbnail_data_uri.length > THUMB_MAX_BYTES) return void res.json({ error: '缩略图过大（≤ 9KB 原始）' })

    // 验签
    const apiKey = me.api_key as string
    if (!verifyManifestSig(hash, me.id as string, content_type, byte_size, signed_at, apiKey, signature)) {
      return void res.json({ error: '签名验证失败' })
    }
    // 日上限
    const todayCount = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM manifest_registry WHERE owner_id = ? AND created_at > datetime('now', '-1 day')`, [me.id]))!.n
    if (todayCount >= MANIFEST_DAILY_LIMIT) return void res.json({ error: `每日上限 ${MANIFEST_DAILY_LIMIT} 条` })
    if (related_product_id) {
      const p = await dbOne<{ id: string }>("SELECT id FROM products WHERE id = ?", [related_product_id])
      if (!p) return void res.json({ error: '关联商品不存在' })
    }

    try {
      await dbRun(`INSERT INTO manifest_registry (hash, owner_id, content_type, byte_size, title, description, thumbnail_data_uri, signature, signed_at, related_product_id, related_anchor)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [hash, me.id, content_type, byte_size, title || null, description || null, thumbnail_data_uri || null, signature, signed_at, related_product_id || null, related_anchor || null])
      // 创作者立即注册为 owner peer
      await dbRun(`INSERT OR REPLACE INTO peer_directory (peer_id, manifest_hash, is_owner, pin_intent, last_heartbeat)
                  VALUES (?,?,1,1,datetime('now'))`, [me.id, hash])
      res.json({ ok: true, hash })
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || ''
      if (msg.includes('UNIQUE')) return void res.json({ error: '该 hash 已注册', existing: true })
      res.json({ error: '发布失败：' + msg })
    }
  })

  app.get('/api/manifests/me', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const rows = await dbAll(`
      SELECT m.*, p.title as product_title FROM manifest_registry m
      LEFT JOIN products p ON p.id = m.related_product_id
      WHERE m.owner_id = ? AND m.status != 'removed'
      ORDER BY m.created_at DESC LIMIT 100
    `, [me.id])
    res.json({ manifests: rows })
  })

  app.get('/api/manifests/:hash', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const m = await dbOne<Record<string, unknown>>(`SELECT * FROM manifest_registry WHERE hash = ?`, [req.params.hash])
    if (!m) return void res.status(404).json({ error: 'manifest 不存在' })
    if (m.status === 'removed' || m.status === 'takedown_admin') return void res.json({ error: '内容已下架', removed: true, reason: m.takedown_reason || null })
    const peers = await dbAll(`
      SELECT peer_id, is_owner, pin_intent, last_heartbeat FROM peer_directory
      WHERE manifest_hash = ? AND last_heartbeat > datetime('now', '-5 minutes')
      ORDER BY is_owner DESC, last_heartbeat DESC LIMIT 30
    `, [req.params.hash])
    res.json({ manifest: m, peers })
  })

  app.get('/api/manifests/by-product/:pid', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT m.*, u.name as owner_name FROM manifest_registry m
      LEFT JOIN users u ON u.id = m.owner_id
      WHERE m.related_product_id = ? AND m.status = 'active'
      ORDER BY m.created_at DESC LIMIT 20
    `, [req.params.pid])
    res.json({ manifests: rows })
  })

  app.get('/api/manifests/by-anchor/:anchor', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`
      SELECT m.*, u.name as owner_name FROM manifest_registry m
      LEFT JOIN users u ON u.id = m.owner_id
      WHERE m.related_anchor = ? AND m.status = 'active'
      ORDER BY m.created_at DESC LIMIT 50
    `, [req.params.anchor])
    res.json({ manifests: rows })
  })

  app.patch('/api/manifests/:hash/takedown', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const m = await dbOne<{ owner_id: string }>("SELECT owner_id FROM manifest_registry WHERE hash = ?", [req.params.hash])
    if (!m) return void res.status(404).json({ error: 'manifest 不存在' })
    const isAdmin = me.role === 'admin' || safeRoles(me).includes('admin')
    const isOwner = m.owner_id === me.id
    if (!isOwner && !isAdmin) return void res.json({ error: '无权下架' })
    const reason = (req.body?.reason || '').toString().slice(0, 200)
    await dbRun(`UPDATE manifest_registry SET status = ?, takedown_reason = ?, takedown_at = datetime('now'), takedown_by = ? WHERE hash = ?`,
      [isAdmin && !isOwner ? 'takedown_admin' : 'removed', reason, me.id, req.params.hash])
    // 同步清空 peer directory（强制客户端 evict）
    await dbRun("DELETE FROM peer_directory WHERE manifest_hash = ?", [req.params.hash])
    res.json({ ok: true })
  })
}
