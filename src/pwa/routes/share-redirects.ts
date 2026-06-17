/**
 * 分享 / 重定向 / 二维码工具域
 *
 * 由 #1013 Phase 54 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET  /api/qr                      二维码 SVG（24h cache + ETag）
 *   GET  /s/:id                       shareable 短链解析 → 重定向（含点击统计 + 6h dedup）
 *   POST /api/product-share/touch     商品分享归因落库（first-touch + 30d 过期）
 *   GET  /i/:code                     邀请短链 (permanent_code / handle，带 -L/-R 后缀)
 *
 * 点击防互助：shareable_id × ip_hash × ua_hash × 6h 窗口去重
 * 商品归因 first-touch：未过期不覆盖；过期 → 替换
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import QRCode from 'qrcode'
import { createHash } from 'crypto'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ShareRedirectsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  clientIpHash: (req: Request) => string
  clientUaHash: (req: Request) => string
  // invite-code-ONLY resolver (permanent_code [+ -L/-R]); rejects usr_xxx / @handle / handle
  resolveInviteCodeRef: (raw: string) => { userId: string; code: string; side: 'left' | 'right' | null } | null
}

export function registerShareRedirectsRoutes(app: Application, deps: ShareRedirectsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth, clientIpHash, clientUaHash, resolveInviteCodeRef } = deps

  // Resolve the ?ref for a /s/<shareable> redirect: a permanent_code ONLY — never the raw owner_id (usr_xxx).
  // Prefer the shareable's stored owner_code; if missing/invalid, look up the owner's permanent_code and
  // opportunistically backfill owner_code. If the owner has no permanent_code, return null (emit NO ref).
  async function shareOwnerRefCode(ownerCode: unknown, ownerId: unknown): Promise<string | null> {
    const oc = typeof ownerCode === 'string' ? ownerCode.trim().toUpperCase() : ''
    if (/^[A-Z0-9]{6,7}$/.test(oc)) return oc
    const oid = typeof ownerId === 'string' ? ownerId : ''
    if (oid) {
      const r = await dbOne<{ permanent_code: string | null }>("SELECT permanent_code FROM users WHERE id = ? AND id != 'sys_protocol'", [oid])
      if (r?.permanent_code) {
        try { await dbRun("UPDATE shareables SET owner_code = ? WHERE owner_id = ? AND (owner_code IS NULL OR owner_code = '')", [r.permanent_code, oid]) } catch {}
        return r.permanent_code
      }
    }
    return null
  }

  // 二维码生成（24h cache + ETag）
  app.get('/api/qr', async (req, res) => {
    const text = String(req.query.text || '').slice(0, 1024).trim()
    if (!text) return void res.status(400).send('text required')
    const size = Math.min(Math.max(parseInt(String(req.query.size || '256'), 10) || 256, 64), 1024)
    try {
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M' })
      const etag = '"' + createHash('sha1').update(text + ':' + size).digest('hex').slice(0, 16) + '"'
      if (req.headers['if-none-match'] === etag) return void res.status(304).end()
      res.set('Content-Type', 'image/svg+xml')
      res.set('Cache-Control', 'public, max-age=86400, immutable')
      res.set('ETag', etag)
      res.send(svg)
    } catch (e) {
      res.status(500).send('qr generation failed: ' + (e as Error).message)
    }
  })

  // 商品分享短链 /s/<shareable_id>
  // 笔记 → 跳 PWA 内 #note/<id>；商品 → #order-product/<id>；外链 → 直跳外部 URL
  app.get('/s/:id', async (req, res) => {
    const id = String(req.params.id || '').trim()
    const row = await dbOne<Record<string, unknown>>(`
      SELECT id, owner_id, owner_code, type, external_url, related_product_id, related_anchor, status
      FROM shareables WHERE id = ? AND status = 'active'
    `, [id])
    // Phase C 笔记着陆页 — type=note 优先跳 PWA 内的 #note/<id>
    if (row && row.type === 'note') {
      const ownerRef = await shareOwnerRefCode(row.owner_code, row.owner_id)
      const qs = new URLSearchParams()
      if (ownerRef) qs.set('ref', ownerRef)
      qs.set('share_id', id)
      try {
        const ipHash = clientIpHash(req)
        const uaHash = clientUaHash(req)
        const dup = await dbOne(`SELECT 1 FROM shareable_click_log WHERE shareable_id = ? AND ip_hash = ? AND ua_hash = ? AND created_at > datetime('now', '-6 hours') LIMIT 1`, [id, ipHash, uaHash])
        await dbRun(`INSERT INTO shareable_click_log (shareable_id, ip_hash, ua_hash, ref_path) VALUES (?,?,?,?)`, [id, ipHash, uaHash, req.originalUrl || null])
        await dbRun(`UPDATE shareables SET click_count = COALESCE(click_count,0) + 1 WHERE id = ?`, [id])
        if (!dup) await dbRun(`UPDATE shareables SET unique_click_count = COALESCE(unique_click_count,0) + 1 WHERE id = ?`, [id])
      } catch (e) { console.error('[note-click]', e) }
      return void res.redirect(302, `/?${qs.toString()}#note/${id}`)
    }
    if (!row) return void res.status(404).send('Shareable not found or removed.')
    // 点击量 + 反互助点击 unique 去重（6h 窗口）
    try {
      const ipHash = clientIpHash(req)
      const uaHash = clientUaHash(req)
      const dup = await dbOne(`
        SELECT 1 FROM shareable_click_log
        WHERE shareable_id = ? AND ip_hash = ? AND ua_hash = ?
          AND created_at > datetime('now', '-6 hours') LIMIT 1
      `, [id, ipHash, uaHash])
      await dbRun(`INSERT INTO shareable_click_log (shareable_id, ip_hash, ua_hash, ref_path) VALUES (?,?,?,?)`,
        [id, ipHash, uaHash, req.originalUrl || null])
      await dbRun(`UPDATE shareables SET click_count = COALESCE(click_count,0) + 1 WHERE id = ?`, [id])
      if (!dup) {
        await dbRun(`UPDATE shareables SET unique_click_count = COALESCE(unique_click_count,0) + 1 WHERE id = ?`, [id])
      }
    } catch (e) { console.error('[M3-click]', e) }
    const ownerRef = await shareOwnerRefCode(row.owner_code, row.owner_id)
    const isProduct = !!row.related_product_id
    const baseParams = new URLSearchParams()
    if (ownerRef) baseParams.set('ref', ownerRef)
    if (isProduct) baseParams.set('share_id', id)
    const qs = baseParams.toString() ? '?' + baseParams.toString() : ''
    if (isProduct) {
      return void res.redirect(302, `/${qs}#order-product/${row.related_product_id}`)
    }
    if (row.related_anchor) {
      return void res.redirect(302, `/${qs}#u/${row.owner_id}`)
    }
    if (row.external_url) {
      return void res.redirect(302, String(row.external_url))
    }
    res.redirect(302, `/${qs}#u/${row.owner_id}`)
  })

  // 商品分享归因落库（前端登录后首次进入带 share_id 时调用）
  app.post('/api/product-share/touch', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { shareable_id } = req.body || {}
    if (!shareable_id || typeof shareable_id !== 'string') {
      return void res.json({ ok: false, error: 'invalid_shareable_id' })
    }
    const s = await dbOne<{ id: string; owner_id: string; related_product_id: string | null }>(`
      SELECT id, owner_id, related_product_id FROM shareables
      WHERE id = ? AND status = 'active'
    `, [shareable_id])
    if (!s || !s.related_product_id) return void res.json({ ok: false, error: 'not_product_shareable' })
    if (s.owner_id === user.id) return void res.json({ ok: false, error: 'cannot_self_attribute' })

    const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
    // first-touch：未过期 → 静默保留；过期 → 替换
    const existing = await dbOne<{ sharer_id: string; expires_at: string }>(`
      SELECT sharer_id, expires_at FROM product_share_attribution
      WHERE product_id = ? AND recipient_id = ?
    `, [s.related_product_id, user.id])

    if (!existing) {
      await dbRun(`
        INSERT INTO product_share_attribution (product_id, recipient_id, sharer_id, shareable_id, expires_at, source_type, source_ref)
        VALUES (?, ?, ?, ?, ?, 'direct_share', ?)
      `, [s.related_product_id, user.id, s.owner_id, s.id, expiresAt, s.id])
      return void res.json({ ok: true, attributed: true, sharer_id: s.owner_id, product_id: s.related_product_id })
    }
    const stillValid = new Date(existing.expires_at.replace(' ', 'T') + 'Z').getTime() > Date.now()
    if (stillValid) {
      return void res.json({ ok: true, attributed: false, existing_sharer_id: existing.sharer_id, locked: true })
    }
    // 已过期 → 刷新
    await dbRun(`
      UPDATE product_share_attribution
      SET sharer_id = ?, shareable_id = ?, created_at = datetime('now'), expires_at = ?,
          source_type = 'direct_share', source_ref = ?, source_shop_seller_id = NULL, source_qualified_order_id = NULL
      WHERE product_id = ? AND recipient_id = ?
    `, [s.owner_id, s.id, expiresAt, s.id, s.related_product_id, user.id])
    res.json({ ok: true, attributed: true, refreshed: true, sharer_id: s.owner_id })
  })

  // 邀请短链 /i/CODE — invite-code ONLY (permanent_code, 兼容旧的 -L/-R 后缀). usr_xxx / @handle / 裸 handle
  // 一律 404(不再做 handle 解析)。pre-public 去左右码:/i/CODE 与旧 /i/CODE-L、/i/CODE-R 一律
  // 规范化重定向到 /?ref=CODE(丢弃 side;放置侧别由注册时系统自动决定),旧链接/二维码仍可用。
  // 不受 invite_rotation_enabled 影响:已有用户分享出的 /i/CODE 链接和二维码必须始终可用。
  app.get('/i/:code', (req, res) => {
    const ref = resolveInviteCodeRef(String(req.params.code || ''))
    if (!ref) return void res.status(404).send('Invitation link not found.')
    const target = `/?ref=${encodeURIComponent(ref.code)}`
    res.redirect(302, target)
  })
}
