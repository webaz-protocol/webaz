/**
 * 话题 / 标签域
 *
 * 由 #1013 Phase 50 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/tags/:tag/notes      该标签下的笔记列表（公开）
 *   GET /api/tags/trending        热门标签（24h + 总数综合排序）
 *
 * 数据源：shareable_tags 表
 */
import type { Application } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface TagsDeps {
  db: Database.Database
}

export function registerTagsRoutes(app: Application, _deps: TagsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll),不再用 deps.db

  app.get('/api/tags/:tag/notes', async (req, res) => {
    const tag = String(req.params.tag || '').trim().toLowerCase()
    if (!tag || tag.length > 30) return void res.status(400).json({ error: 'tag invalid' })
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30))
    const rows = await dbAll(`
      SELECT s.id, s.owner_id, s.owner_code, s.type, s.title, s.native_text,
             s.related_product_id, s.related_anchor, s.photo_hashes,
             s.click_count, s.like_count, s.created_at,
             p.title AS product_title,
             u.handle as owner_handle, u.name as owner_name,
             t.created_at as tagged_at
      FROM shareable_tags t
      JOIN shareables s ON s.id = t.shareable_id
      LEFT JOIN products p ON p.id = s.related_product_id
      LEFT JOIN users u ON u.id = s.owner_id
      WHERE t.tag = ? AND s.status = 'active'
      ORDER BY s.created_at DESC LIMIT ?
    `, [tag, limit])
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r.photo_hashes === 'string') {
        try { r.photo_hashes = JSON.parse(r.photo_hashes as string) } catch { r.photo_hashes = [] }
      }
    }
    const stat = (await dbOne<{ count: number }>(`SELECT COUNT(*) as count FROM shareable_tags WHERE tag = ?`, [tag]))!
    res.json({ tag, count: stat.count, items: rows })
  })

  // 热门标签：24h + 总数综合排序
  app.get('/api/tags/trending', async (_req, res) => {
    const rows = await dbAll(`
      SELECT tag, COUNT(*) as total,
        SUM(CASE WHEN created_at > datetime('now', '-1 day') THEN 1 ELSE 0 END) as recent_24h
      FROM shareable_tags
      GROUP BY tag
      HAVING total >= 1
      ORDER BY recent_24h DESC, total DESC LIMIT 20
    `)
    res.json({ items: rows })
  })
}
