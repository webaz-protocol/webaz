/**
 * 公告域 (Wave A-4)
 *
 * 由 #1013 Phase 17 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   POST  /api/admin/announcements              发公告（protocol 权限；region admin 仅本区）
 *   PATCH /api/admin/announcements/:id          改 is_active / expires_at（root 全管，区域 admin 仅改自己发的）
 *   GET   /api/announcements/active             用户视角 active 公告（按 role + region 过滤 + 已读标记）
 *   POST  /api/announcements/:id/read           标记已读
 *
 * Severity: info / warning / critical
 *
 * 区域边界：
 *   - root admin 可发任意 target_regions
 *   - 区域 admin 必须指定 target_regions = [own_scope]
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AnnouncementsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeRoles: (user: Record<string, unknown> | undefined | null) => string[]
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  isRootAdmin: (user: Record<string, unknown>) => boolean
  getAdminScope: (user: Record<string, unknown>) => string
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAnnouncementsRoutes(app: Application, deps: AnnouncementsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { generateId, auth, safeRoles, requireProtocolAdmin, isRootAdmin, getAdminScope, logAdminAction } = deps

  app.post('/api/admin/announcements', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const { title, body, target_roles, target_regions, severity, starts_at, expires_at } = req.body || {}
    if (!title?.trim() || title.length > 100) return void res.status(400).json({ error: 'title 1-100 字' })
    if (!body?.trim() || body.length > 2000) return void res.status(400).json({ error: 'body 1-2000 字' })
    if (severity && !['info', 'warning', 'critical'].includes(severity)) return void res.status(400).json({ error: 'severity 须为 info / warning / critical' })
    const rolesJson = Array.isArray(target_roles) && target_roles.length > 0 ? JSON.stringify(target_roles) : null
    const regionsJson = Array.isArray(target_regions) && target_regions.length > 0 ? JSON.stringify(target_regions) : null
    // 区域 admin 只能发本区域
    if (!isRootAdmin(admin)) {
      const scope = getAdminScope(admin)
      if (regionsJson) {
        const parsedRegions = JSON.parse(regionsJson) as string[]
        if (!parsedRegions.every(r => r === scope)) return void res.status(403).json({ error: `区域 admin 仅可发本区域 (${scope}) 公告` })
      } else {
        return void res.status(400).json({ error: `区域 admin 必须指定 target_regions: ['${scope}']` })
      }
    }
    const id = generateId('ann')
    await dbRun(`INSERT INTO announcements (id, author_id, title, body, target_roles, target_regions, severity, starts_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, admin.id, title.trim(), body.trim(), rolesJson, regionsJson, severity || 'info', starts_at || null, expires_at || null])
    logAdminAction(admin.id as string, 'create_announcement', 'announcement', id, { title, severity: severity || 'info' })
    res.json({ success: true, id })
  })

  app.patch('/api/admin/announcements/:id', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const ann = await dbOne<{ id: string; author_id: string }>('SELECT id, author_id FROM announcements WHERE id = ?', [req.params.id])
    if (!ann) return void res.status(404).json({ error: '公告不存在' })
    if (!isRootAdmin(admin) && ann.author_id !== admin.id) return void res.status(403).json({ error: '仅可编辑自己发的公告（root 可全管）' })
    const { is_active, expires_at } = req.body || {}
    const sets: string[] = []
    const args: unknown[] = []
    if (is_active !== undefined) { sets.push('is_active = ?'); args.push(is_active ? 1 : 0) }
    if (expires_at !== undefined) { sets.push('expires_at = ?'); args.push(expires_at) }
    if (sets.length === 0) return void res.status(400).json({ error: '无可更新字段' })
    args.push(req.params.id)
    await dbRun(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })

  // 列出对当前用户可见的活跃公告（按角色 + 区域过滤）
  app.get('/api/announcements/active', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userRoles = safeRoles(user)
    const userRegion = (user.region as string) || 'global'
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT a.id, a.title, a.body, a.severity, a.created_at, a.target_roles, a.target_regions,
             (SELECT 1 FROM announcement_reads WHERE user_id = ? AND announcement_id = a.id) as is_read
      FROM announcements a
      WHERE a.is_active = 1
        AND (a.starts_at IS NULL OR a.starts_at <= datetime('now'))
        AND (a.expires_at IS NULL OR a.expires_at >= datetime('now'))
      ORDER BY a.created_at DESC LIMIT 50
    `, [user.id])
    // JS 端 filter 角色 / 区域（避免 JSON LIKE 在 SQLite 中麻烦）
    const filtered = rows.filter(a => {
      if (a.target_roles) {
        try {
          const tr = JSON.parse(a.target_roles as string) as string[]
          const matches = tr.some(r => userRoles.includes(r) || user.role === r)
          if (!matches) return false
        } catch {}
      }
      if (a.target_regions) {
        try {
          const tg = JSON.parse(a.target_regions as string) as string[]
          if (!tg.includes(userRegion)) return false
        } catch {}
      }
      return true
    }).map(a => ({ ...a, target_roles: undefined, target_regions: undefined, is_read: !!a.is_read }))
    res.json({ items: filtered })
  })

  app.post('/api/announcements/:id/read', async (req, res) => {
    const user = auth(req, res); if (!user) return
    try {
      await dbRun(`INSERT OR IGNORE INTO announcement_reads (user_id, announcement_id) VALUES (?,?)`,
        [user.id, req.params.id])
    } catch {}
    res.json({ success: true })
  })
}
