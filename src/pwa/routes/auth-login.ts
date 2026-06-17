/**
 * Login — 密码登录（handle 优先 / 多账户拒登）
 *
 * 由 #1013 Phase 117 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint:
 *   POST /api/login  handle → name fallback · 5 次 lockout 15min · 成功写 session
 *
 * 跨域注入：db + INTERNAL_AUDITOR_ID + isLocked + verifyPassword + recordFailure
 *           + resetFailures + recordSession
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AuthLoginDeps {
  db: Database.Database
  INTERNAL_AUDITOR_ID: string
  isLocked: (user: Record<string, unknown>) => boolean
  verifyPassword: (plain: string, stored: string) => boolean
  recordFailure: (userId: string, prevAttempts: number) => void
  resetFailures: (userId: string) => void
  recordSession: (userId: string, apiKey: string, req: Request) => void
}

export function registerAuthLoginRoutes(app: Application, deps: AuthLoginDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbAll),不再直接用 deps.db
  const { INTERNAL_AUDITOR_ID, isLocked, verifyPassword,
          recordFailure, resetFailures, recordSession } = deps

  app.post('/api/login', async (req, res) => {
    const { name, password } = req.body
    if (!name?.trim() || !password) return void res.json({ error: '请填写用户名 / 昵称和密码' })

    const ref = name.trim().replace(/^@/, '').toLowerCase()
    let matches = await dbAll<Record<string, unknown>>(
      "SELECT * FROM users WHERE handle = ? AND id NOT IN ('sys_protocol', ?)", [ref, INTERNAL_AUDITOR_ID]
    )
    if (matches.length === 0) {
      matches = await dbAll<Record<string, unknown>>(
        "SELECT * FROM users WHERE name = ? AND id NOT IN ('sys_protocol', ?)", [name.trim(), INTERNAL_AUDITOR_ID]
      )
    }

    if (matches.length === 0) return void res.json({ error: '账号或密码错误' })
    if (matches.length > 1) return void res.json({ error: '该昵称对应多个账户，请改用 @用户名 或 API Key 登录' })

    const user = matches[0]
    if (isLocked(user)) {
      const minutes = Math.ceil((new Date(user.locked_until as string).getTime() - Date.now()) / 60_000)
      return void res.json({ error: `账户已临时锁定，约 ${minutes} 分钟后再试` })
    }
    if (!user.password_hash) return void res.json({ error: '该账户未设置密码，请使用 API Key 登录' })

    if (!verifyPassword(String(password), user.password_hash as string)) {
      recordFailure(user.id as string, (user.failed_attempts as number) || 0)
      return void res.json({ error: '名称或密码错误' })
    }
    resetFailures(user.id as string)
    try { recordSession(user.id as string, user.api_key as string, req) } catch {}
    res.json({
      success: true,
      api_key: user.api_key,
      user_id: user.id,
      name:    user.name,
      role:    user.role,
    })
  })
}
