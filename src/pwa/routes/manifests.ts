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
// Whitelist for stored/served thumbnails: raster data-URI only. Blocks svg/text/html data URIs so a malicious
// seller can't smuggle scriptable content that the public /thumb endpoint would serve (stored-XSS guard).
const THUMB_DATA_URI_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

// /thumb?format=jpeg 转码结果缓存:hash 内容不可变 → 每 hash 至多付一次转码 CPU。
//   有界两重(Codex #510 R2):项数 FIFO ≤512,且【单项 >64KB 的转码结果不入缓存】(tiny webp 可能膨胀成
//   ~200KB JPEG;不缓存时照常下发,只是该 hash 每次重转)→ 内存上界 512×64KB = 32MB 真实成立。
//   takedown 不受影响:每次请求先查 DB 状态/白名单再碰缓存。
const thumbJpegCache = new Map<string, Buffer>()
const THUMB_JPEG_CACHE_MAX = 512
const THUMB_JPEG_CACHE_ITEM_MAX = 64 * 1024

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
    if (thumbnail_data_uri && !THUMB_DATA_URI_RE.test(thumbnail_data_uri)) return void res.json({ error: '缩略图必须是 data:image/(jpeg|png|webp);base64 格式' })

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

  // PUBLIC thumbnail bytes for <img src> (product cards can't send an auth header). Hardened:
  //   - :hash must be 64-hex (format guard)
  //   - only status='active' manifests
  //   - the stored data-URI must match the raster whitelist (jpeg/png/webp) — else 404 (no svg/text/html)
  //   - Content-Type is FORCED from the whitelisted subtype (never echoed from the stored value) + nosniff
  //   - size guard; SHORT revalidatable cache (max-age=300, must-revalidate) — NOT immutable: the content is
  //     hash-fixed but its serve-ability is not (owner/admin takedown flips status), so a long cache would
  //     keep serving a taken-down thumbnail. 5-min TTL absorbs list bursts while honoring takedown promptly.
  //   Only the low-res thumbnail is exposed (never full-res / metadata / other columns).
  app.get('/api/manifests/:hash/thumb', async (req, res) => {
    const hash = String(req.params.hash || '')
    if (!/^[0-9a-f]{64}$/i.test(hash)) return void res.status(400).end()
    const m = await dbOne<{ thumbnail_data_uri: string | null; status: string }>(
      `SELECT thumbnail_data_uri, status FROM manifest_registry WHERE hash = ?`, [hash])
    if (!m || m.status !== 'active' || !m.thumbnail_data_uri) return void res.status(404).end()
    const parsed = THUMB_DATA_URI_RE.exec(m.thumbnail_data_uri)
    if (!parsed) return void res.status(404).end()
    let buf: Buffer
    try { buf = Buffer.from(m.thumbnail_data_uri.slice(m.thumbnail_data_uri.indexOf(',') + 1), 'base64') } catch { return void res.status(404).end() }
    if (buf.length === 0 || buf.length > 64 * 1024) return void res.status(404).end()
    // ?format=jpeg:按需转码(ACP product feed 只收 JPEG/PNG,存量缩略图多为 webp)。
    //   - 仅在存储格式非 jpeg 时转;sharp 懒加载(不进 boot 路径);转码失败 → 降级发原格式(仍是白名单光栅图),不 500。
    //   - 输出 Content-Type 永远反映【实际发出的字节】格式,绝不假报。
    //   - DoS 收敛(Codex #510 R1):hash 内容不可变 → 转码结果按 hash 有界缓存(每 hash 只付一次 CPU;
    //     状态/白名单检查在缓存命中前已过,takedown 仍即时生效);limitInputPixels 限制解码像素
    //     (≤64KB 的 webp 也可能声明超大画幅);任意多余 query 只影响 CDN 缓存键,进程内代价 = 一次 Map 查。
    let outSubtype = parsed[1]
    if (String(req.query.format || '').toLowerCase() === 'jpeg' && outSubtype !== 'jpeg') {
      const cached = thumbJpegCache.get(hash)
      if (cached) { buf = cached; outSubtype = 'jpeg' }
      else {
        try {
          const sharp = (await import('sharp')).default
          const jpeg = await sharp(buf, { limitInputPixels: 1_000_000 }).jpeg({ quality: 82 }).toBuffer()
          buf = jpeg; outSubtype = 'jpeg'
          if (jpeg.length <= THUMB_JPEG_CACHE_ITEM_MAX) {
            thumbJpegCache.set(hash, jpeg)
            if (thumbJpegCache.size > THUMB_JPEG_CACHE_MAX) { const oldest = thumbJpegCache.keys().next().value; if (oldest) thumbJpegCache.delete(oldest) }
          }
        } catch { /* 转码不可用/失败 → 原格式降级 */ }
      }
    }
    res.setHeader('Content-Type', `image/${outSubtype}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate')
    res.send(buf)
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
