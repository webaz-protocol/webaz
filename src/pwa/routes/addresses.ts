/**
 * 多收货地址簿域 (Wave C-2)
 *
 * 由 #1013 Phase 19 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET    /api/addresses           我的地址列表（default 优先 + 时间倒序）
 *   POST   /api/addresses           添加（上限 20）
 *   PATCH  /api/addresses/:id       修改 / 切换 default
 *   DELETE /api/addresses/:id       删除（删默认会自动挑下一个）
 *
 * 边界：
 *   - 受信角色 (TRUSTED_ROLE_NO_TRADE) 不能用收货地址
 *   - 每用户最多 20 个地址
 *   - is_default 互斥（同用户仅一个为 1）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AddressesDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

export function registerAddressesRoutes(app: Application, deps: AddressesDeps): void {
  const { db, generateId, auth, isTrustedRole, errorRes } = deps

  app.get('/api/addresses', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const rows = await dbAll(`SELECT id, label, recipient, phone, region, detail, is_default, created_at
      FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 50`, [user.id])
    res.json({ items: rows })
  })

  app.post('/api/addresses', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无购物功能')
    const { label, recipient, phone, region, detail, is_default } = req.body || {}
    if (!label || !recipient || !detail) return void res.status(400).json({ error: '标签 / 收件人 / 详细地址必填' })
    if (String(label).length > 30 || String(recipient).length > 60 || String(detail).length > 200) {
      return void res.status(400).json({ error: '字段超长（标签≤30, 收件人≤60, 详址≤200）' })
    }
    const cnt = (await dbOne<{ n: number }>('SELECT COUNT(*) as n FROM user_addresses WHERE user_id = ?', [user.id]))!.n
    if (cnt >= 20) return void res.status(400).json({ error: '地址数量已达上限 (20)' })
    const id = generateId('adr')
    db.transaction(() => {
      if (is_default || cnt === 0) {
        db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(user.id)
      }
      db.prepare(`INSERT INTO user_addresses (id, user_id, label, recipient, phone, region, detail, is_default) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, user.id, String(label), String(recipient), phone ? String(phone) : null, region ? String(region) : null, String(detail), (is_default || cnt === 0) ? 1 : 0)
    })()
    res.json({ success: true, id })
  })

  app.patch('/api/addresses/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne<{ user_id: string }>('SELECT user_id FROM user_addresses WHERE id = ?', [req.params.id])
    if (!row) return void res.status(404).json({ error: '地址不存在' })
    if (row.user_id !== user.id) return void res.status(403).json({ error: '无权限' })
    const { label, recipient, phone, region, detail, is_default } = req.body || {}
    const sets: string[] = []
    const args: unknown[] = []
    if (label !== undefined) { sets.push('label = ?'); args.push(String(label).slice(0, 30)) }
    if (recipient !== undefined) { sets.push('recipient = ?'); args.push(String(recipient).slice(0, 60)) }
    if (phone !== undefined) { sets.push('phone = ?'); args.push(phone ? String(phone).slice(0, 30) : null) }
    if (region !== undefined) { sets.push('region = ?'); args.push(region ? String(region).slice(0, 60) : null) }
    if (detail !== undefined) { sets.push('detail = ?'); args.push(String(detail).slice(0, 200)) }
    if (sets.length === 0 && is_default === undefined) return void res.status(400).json({ error: '无可更新字段' })
    db.transaction(() => {
      if (sets.length > 0) {
        sets.push(`updated_at = datetime('now')`)
        args.push(req.params.id)
        db.prepare(`UPDATE user_addresses SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      }
      if (is_default) {
        db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(user.id)
        db.prepare('UPDATE user_addresses SET is_default = 1 WHERE id = ?').run(req.params.id)
      }
    })()
    res.json({ success: true })
  })

  app.delete('/api/addresses/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne<{ user_id: string; is_default: number }>('SELECT user_id, is_default FROM user_addresses WHERE id = ?', [req.params.id])
    if (!row) return void res.status(404).json({ error: '地址不存在' })
    if (row.user_id !== user.id) return void res.status(403).json({ error: '无权限' })
    db.transaction(() => {
      db.prepare('DELETE FROM user_addresses WHERE id = ?').run(req.params.id)
      // 若删了默认地址，挑一个最近的设为默认
      if (row.is_default) {
        const next = db.prepare('SELECT id FROM user_addresses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id) as { id: string } | undefined
        if (next) db.prepare('UPDATE user_addresses SET is_default = 1 WHERE id = ?').run(next.id)
      }
    })()
    res.json({ success: true })
  })
}
