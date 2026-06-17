/**
 * A2 用户黑名单域
 *
 * 由 #1013 Phase 32 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST   /api/blocklist/:user_id            拉黑（INSERT OR IGNORE）
 *   DELETE /api/blocklist/:user_id            解除
 *   GET    /api/blocklist                     D-2 列表（含被拉黑用户的 name/handle/role）
 *   GET    /api/blocklist/me                  另一格式列表（兼容旧 UI）
 *   GET    /api/blocklist/:user_id/status     是否已拉黑（boolean）
 *
 * 边界：
 *   - 不能拉黑自己
 *   - 不能拉黑 sys_protocol
 *   - reason ≤ 200 字
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface BlocklistDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerBlocklistRoutes(app: Application, deps: BlocklistDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth } = deps

  app.post('/api/blocklist/:user_id', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const target = req.params.user_id
    if (target === me.id) return void res.json({ error: '不能拉黑自己' })
    if (target === 'sys_protocol') return void res.json({ error: '不能拉黑系统账户' })
    const exists = await dbOne("SELECT 1 FROM users WHERE id = ?", [target])
    if (!exists) return void res.json({ error: '用户不存在' })
    const reason = (req.body?.reason || '').toString().slice(0, 200)
    await dbRun("INSERT OR IGNORE INTO user_blocklist (blocker_id, blocked_id, reason) VALUES (?, ?, ?)",
      [me.id, target, reason || null])
    res.json({ ok: true })
  })

  app.delete('/api/blocklist/:user_id', async (req, res) => {
    const me = auth(req, res); if (!me) return
    await dbRun("DELETE FROM user_blocklist WHERE blocker_id = ? AND blocked_id = ?", [me.id, req.params.user_id])
    res.json({ ok: true })
  })

  // D-2: 列表
  app.get('/api/blocklist', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const rows = await dbAll(`
      SELECT b.blocked_id, b.reason, b.created_at,
        u.name, u.handle, u.role
      FROM user_blocklist b
      JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ?
      ORDER BY b.created_at DESC LIMIT 200
    `, [me.id])
    res.json({ items: rows })
  })

  app.get('/api/blocklist/me', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const rows = await dbAll(`
      SELECT b.blocked_id, b.reason, b.created_at, u.name as blocked_name, u.role as blocked_role
      FROM user_blocklist b LEFT JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC
    `, [me.id])
    res.json({ blocked: rows })
  })

  app.get('/api/blocklist/:user_id/status', async (req, res) => {
    const me = auth(req, res); if (!me) return
    const row = await dbOne("SELECT 1 FROM user_blocklist WHERE blocker_id = ? AND blocked_id = ?", [me.id, req.params.user_id])
    res.json({ blocked: !!row })
  })
}
