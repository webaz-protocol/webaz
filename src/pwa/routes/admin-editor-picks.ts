/**
 * Admin: Editor Picks（精选商品/卖家）
 *
 * 由 #1013 Phase 66 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   POST   /api/admin/editor-picks       创建（kind: product | seller，时间窗 SQLite 兼容格式）
 *   GET    /api/admin/editor-picks       列表
 *   DELETE /api/admin/editor-picks/:id   删除
 *
 * 权限：content
 *
 * 跨域注入：requireContentAdmin + generateId
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminEditorPicksDeps {
  db: Database.Database
  requireContentAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerAdminEditorPicksRoutes(app: Application, deps: AdminEditorPicksDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { requireContentAdmin, generateId } = deps

  app.post('/api/admin/editor-picks', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const { kind, target_id, title, note, starts_at, ends_at, sort_order } = req.body || {}
    if (!['product', 'seller'].includes(String(kind))) return void res.status(400).json({ error: 'kind 必须是 product/seller' })
    if (!target_id) return void res.status(400).json({ error: 'target_id 必填' })
    if (kind === 'product') {
      if (!await dbOne("SELECT 1 FROM products WHERE id = ? AND status != 'deleted'", [target_id])) return void res.status(400).json({ error: '商品不存在' })
    } else {
      if (!await dbOne("SELECT 1 FROM users WHERE id = ? AND role = 'seller'", [target_id])) return void res.status(400).json({ error: '卖家不存在' })
    }
    // SQLite 兼容："YYYY-MM-DD HH:MM:SS" — ISO 'T'/毫秒会让窗口比较失效
    const toSqliteUtc = (d: Date) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    const startsDate = starts_at ? new Date(starts_at) : new Date()
    const endsDate = ends_at ? new Date(ends_at) : new Date(Date.now() + 7 * 86400_000)
    if (endsDate <= startsDate) return void res.status(400).json({ error: 'ends_at 必须晚于 starts_at' })
    const id = generateId('ep')
    await dbRun(`INSERT INTO editor_picks (id, kind, target_id, title, note, starts_at, ends_at, sort_order, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, kind, target_id,
        title ? String(title).slice(0, 100) : null,
        note ? String(note).slice(0, 500) : null,
        toSqliteUtc(startsDate), toSqliteUtc(endsDate),
        Number(sort_order) || 0, admin.id])
    res.json({ success: true, id })
  })

  app.delete('/api/admin/editor-picks/:id', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    await dbRun('DELETE FROM editor_picks WHERE id = ?', [req.params.id])
    res.json({ success: true })
  })

  app.get('/api/admin/editor-picks', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const rows = await dbAll(`SELECT * FROM editor_picks ORDER BY ends_at DESC LIMIT 200`)
    res.json({ items: rows })
  })
}
