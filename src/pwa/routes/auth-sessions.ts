/**
 * 会话管理域 — 多设备审计 + 远程登出
 *
 * 由 #1013 Phase 48 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET  /api/auth/sessions               活跃会话列表（含 is_current 标记）
 *   POST /api/auth/sessions/:id/revoke    远程吊销某会话（不能吊销当前）
 *   POST /api/auth/logout-all             一键全登出（rotate api_key + 吊销全部，需密码二次验证）
 *
 * 隐私：
 *   - fingerprint_hash 仅显示前 8 位
 *   - logout-all 要求密码（防 api_key 被盗后被锁死）
 *   - 未设密码的账户不能 logout-all（先去设密码）
 *
 * 跨域：verifyPassword / recordSession / generateSecureKey
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AuthSessionsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  verifyPassword: (plain: string, stored: string) => boolean
  recordSession: (userId: string, apiKey: string, req: Request) => string
  generateSecureKey: (prefix: string) => string
}

export function registerAuthSessionsRoutes(app: Application, deps: AuthSessionsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, verifyPassword, recordSession, generateSecureKey } = deps

  app.get('/api/auth/sessions', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const currentKey = req.headers.authorization?.replace('Bearer ', '') ?? ''
    const rows = await dbAll<{ id: string; ip: string | null; user_agent: string | null; fingerprint_hash: string | null; created_at: string; last_seen_at: string; revoked_at: string | null; api_key: string }>(`
      SELECT id, ip, user_agent, fingerprint_hash, created_at, last_seen_at, revoked_at, api_key
      FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen_at DESC LIMIT 30
    `, [user.id])
    res.json({
      sessions: rows.map(r => ({
        id: r.id,
        ip: r.ip,
        user_agent: r.user_agent,
        fingerprint_hash: r.fingerprint_hash?.slice(0, 8),
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        is_current: r.api_key === currentKey,
      })),
    })
  })

  // 远程吊销某个会话（不影响当前 session）
  app.post('/api/auth/sessions/:id/revoke', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const sid = req.params.id
    const row = await dbOne<{ user_id: string; api_key: string }>("SELECT user_id, api_key FROM user_sessions WHERE id = ?", [sid])
    if (!row || row.user_id !== user.id) return void res.status(404).json({ error: '会话不存在' })
    const currentKey = req.headers.authorization?.replace('Bearer ', '') ?? ''
    if (row.api_key === currentKey) return void res.json({ error: '不能吊销当前会话，请改用「全部登出」' })
    await dbRun("UPDATE user_sessions SET revoked_at = datetime('now') WHERE id = ?", [sid])
    res.json({ ok: true })
  })

  // 一键全登出：rotate users.api_key + 吊销所有 session
  // 要求密码二次验证（防 api_key 被盗后攻击者锁死真用户）
  app.post('/api/auth/logout-all', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const pwd = String(req.body?.password || '')
    if (!user.password_hash) return void res.json({ error: '该账户未设置登录密码，无法一键全登出。请先设置密码。' })
    if (!verifyPassword(pwd, user.password_hash as string)) return void res.json({ error: '密码错误' })
    const newKey = generateSecureKey('key')
    await dbRun("UPDATE users SET api_key = ? WHERE id = ?", [newKey, user.id])
    await dbRun("UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      [user.id])
    // 为新 key 建一个 session 行（让当前发起者继续可用）
    try { recordSession(user.id as string, newKey, req) } catch {}
    res.json({ ok: true, new_api_key: newKey })
  })
}
