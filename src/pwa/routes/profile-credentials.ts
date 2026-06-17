/**
 * Profile 凭据域 — 密码管理 + 邮箱绑定
 *
 * 由 #1013 Phase 55 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST /api/profile/set-password         设置/修改密码（有密码时需 old_password）
 *   POST /api/profile/verify-password      验证密码（显示 API Key 前的二次确认）
 *   POST /api/profile/remove-password      移除密码（恢复 API Key 模式）
 *   POST /api/profile/bind-email           绑定邮箱（步骤 1 发码）
 *   POST /api/profile/confirm-email        确认邮箱（步骤 2 验码）
 *
 * 边界：
 *   - 新密码 ≥ 8，≤ 200 字符
 *   - 设置过密码时改密码需 old_password
 *   - bind-email 防同邮箱被其他账户占用
 *   - confirm-email 错误 ≥5 次自动作废
 *
 * 跨域注入：verifyPassword / hashPassword / issueCode / findActiveCode / 等常量
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import type { IssueCodeResult } from '../email-delivery.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ProfileCredentialsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  verifyPassword: (plain: string, stored: string) => boolean
  hashPassword: (plain: string) => string
  issueCode: (userId: string, channel: string, target: string, purpose: string) => Promise<IssueCodeResult>
  findActiveCode: (channel: string, target: string, purpose: string) => Record<string, unknown> | undefined
  MAX_CODE_ATTEMPTS: number
}

export function registerProfileCredentialsRoutes(app: Application, deps: ProfileCredentialsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth, verifyPassword, hashPassword, issueCode, findActiveCode, MAX_CODE_ATTEMPTS } = deps

  // 设置 / 修改密码
  app.post('/api/profile/set-password', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { old_password, new_password } = req.body
    if (!new_password || String(new_password).length < 8) return void res.json({ error: '新密码至少 8 字符' })
    if (String(new_password).length > 200)               return void res.json({ error: '密码过长（>200 字符）' })

    if (user.password_hash) {
      if (!old_password) return void res.json({ error: '请提供原密码' })
      if (!verifyPassword(String(old_password), user.password_hash as string)) {
        return void res.json({ error: '原密码错误' })
      }
    }
    const hash = hashPassword(String(new_password))
    await dbRun("UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?",
      [hash, user.id as string])
    res.json({ success: true })
  })

  // 验证密码（显示 API Key 前的二次确认）
  app.post('/api/profile/verify-password', (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!user.password_hash) return void res.json({ ok: false, no_password: true, error: '未设置密码' })
    const { password } = req.body
    if (!password) return void res.json({ ok: false, error: '请输入密码' })
    if (!verifyPassword(String(password), user.password_hash as string)) {
      return void res.json({ ok: false, error: '密码错误' })
    }
    res.json({ ok: true })
  })

  // 移除密码（恢复只用 API Key 模式）
  app.post('/api/profile/remove-password', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { current_password } = req.body
    if (!user.password_hash) return void res.json({ error: '当前未设置密码' })
    if (!current_password || !verifyPassword(String(current_password), user.password_hash as string)) {
      return void res.json({ error: '密码错误' })
    }
    await dbRun("UPDATE users SET password_hash = NULL, updated_at = datetime('now') WHERE id = ?",
      [user.id as string])
    res.json({ success: true })
  })

  // 绑定邮箱 — 步骤 1：发码
  app.post('/api/profile/bind-email', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { email } = req.body
    if (!email?.trim() || !EMAIL_RE.test(email.trim())) return void res.json({ error: '邮箱格式无效' })
    const target = email.trim().toLowerCase()

    const dup = await dbOne("SELECT 1 FROM users WHERE email = ? AND id != ? LIMIT 1", [target, user.id])
    if (dup) return void res.json({ error: '该邮箱已被其他账户绑定' })

    const issued = await issueCode(user.id as string, 'email', target, 'bind_email')
    if (!issued.ok) {
      return void res.status(issued.status).json({ error: issued.error, error_code: issued.error_code })
    }
    res.json({
      success: true,
      target_hint: target.replace(/^(.).*(@.*)$/, '$1***$2'),
      expires_at: issued.expires_at,
      ...(issued.provider === 'dev_console' ? { dev_code: issued.code } : {}),
    })
  })

  // 绑定邮箱 — 步骤 2：确认验证码
  app.post('/api/profile/confirm-email', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { email, code } = req.body
    if (!email?.trim() || !code?.trim()) return void res.json({ error: '请填写邮箱和验证码' })
    const target = email.trim().toLowerCase()

    const row = findActiveCode('email', target, 'bind_email')
    if (!row) return void res.json({ error: '验证码已过期或未发送，请重新获取' })
    if (row.user_id !== user.id) return void res.json({ error: '此验证码不属于当前账号' })

    if (String(row.code) !== code.trim()) {
      const attempts = (row.attempts as number) + 1
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await dbRun("UPDATE verification_codes SET attempts = ?, used_at = datetime('now') WHERE id = ?",
          [attempts, row.id as string])
        return void res.json({ error: '错误次数过多，验证码已作废，请重新获取' })
      }
      await dbRun("UPDATE verification_codes SET attempts = ? WHERE id = ?", [attempts, row.id as string])
      return void res.json({ error: `验证码错误（剩余 ${MAX_CODE_ATTEMPTS - attempts} 次）` })
    }

    await dbRun("UPDATE verification_codes SET used_at = datetime('now') WHERE id = ?", [row.id as string])
    await dbRun("UPDATE users SET email = ?, email_verified = 1, updated_at = datetime('now') WHERE id = ?",
      [target, user.id as string])
    res.json({ success: true, email: target })
  })
}
