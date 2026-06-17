/**
 * 找回密钥域
 *
 * 由 #1013 Phase 49 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   POST /api/recover-key             按 name 查找账户（masked hint，rate-limited 5/min/IP）
 *   POST /api/recover-key/start       发验证码到已绑定邮箱
 *   POST /api/recover-key/confirm     提交验证码 → 返回完整 api_key
 *
 * 隐私保护：
 *   - hint 只显示首/末 4 位 + 邮箱用户名首字 + 手机首 3 末 4
 *   - /start 无论是否找到都返相同响应（防枚举）
 *   - 错误 5 次自动作废验证码
 *
 * 跨域：issueCode / findActiveCode (server.ts 顶层)
 */
import type { Application } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import type { EmailDeliveryFailure, IssueCodeResult } from '../email-delivery.js'

export interface RecoverKeyDeps {
  db: Database.Database
  internalAuditorId: string
  issueCode: (userId: string, channel: string, target: string, purpose: string) => Promise<IssueCodeResult>
  findActiveCode: (channel: string, target: string, purpose: string) => Record<string, unknown> | undefined
  canDeliverCodes: () => boolean
  emailDeliveryNotConfigured: () => EmailDeliveryFailure
  hashPassword: (plain: string) => string
  CODE_TTL_MIN: number
  MAX_CODE_ATTEMPTS: number
}

export function registerRecoverKeyRoutes(app: Application, deps: RecoverKeyDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { internalAuditorId, issueCode, findActiveCode, canDeliverCodes, emailDeliveryNotConfigured, hashPassword, CODE_TTL_MIN, MAX_CODE_ATTEMPTS } = deps

  // 账号标识解析 —— 与 /api/login 一致:@handle / handle(小写)优先,name 兜底。
  // 找回三步全部复用它,否则用 handle 登录的用户(如 @holden)在找回页按 name 永远查不到、邮件不发。
  const accountRef = (raw: unknown): { display: string; handleRef: string } => {
    const display = String(raw || '').trim()
    return { display, handleRef: display.replace(/^@/, '').toLowerCase() }
  }
  // (handle = ? OR name = ?) 子句 + 参数,排除 sys/auditor。
  const ACCOUNT_MATCH = "(lower(coalesce(handle, '')) = ? OR name = ?) AND id NOT IN ('sys_protocol', ?)"

  // IP 级速率（5/min）— 防爆破列举账户
  const recoverKeyHits = new Map<string, { count: number; firstAt: number }>()

  app.post('/api/recover-key', async (req, res) => {
    const ip = req.ip || ''
    if (ip) {
      const now = Date.now()
      const rec = recoverKeyHits.get(ip)
      if (rec && now - rec.firstAt < 60_000) {
        rec.count++
        if (rec.count > 5) return void res.status(429).json({ error: '查询过于频繁，请 1 分钟后再试' })
      } else {
        recoverKeyHits.set(ip, { count: 1, firstAt: now })
      }
      if (recoverKeyHits.size > 1000) {
        for (const [k, v] of recoverKeyHits) if (now - v.firstAt > 60_000) recoverKeyHits.delete(k)
      }
    }
    const { name } = req.body
    if (!name?.trim()) return void res.json({ error: '请填写注册时使用的名称或 @用户名' })
    const { display, handleRef } = accountRef(name)
    const rows = await dbAll<Record<string, unknown>>(
      `SELECT name, role, api_key, email, phone, created_at FROM users WHERE ${ACCOUNT_MATCH}`
    , [handleRef, display, internalAuditorId])
    if (rows.length === 0) return void res.json({ error: '未找到该名称 / @用户名的账号' })

    const mask = (s: string) => s && s.length > 8 ? `${s.slice(0,4)}…${s.slice(-4)}` : s
    const maskEmail = (e: string | null) => {
      if (!e) return null
      const [u, d] = e.split('@')
      if (!d) return mask(e)
      return `${u.slice(0,1)}***@${d}`
    }
    const maskPhone = (p: string | null) => p ? `${p.slice(0,3)}****${p.slice(-4)}` : null

    const accounts = rows.map(r => ({
      name:        r.name,
      role:        r.role,
      key_hint:    mask(r.api_key as string),       // 模糊辨认，不可登录
      email_hint:  maskEmail((r.email as string) || null),
      phone_hint:  maskPhone((r.phone as string) || null),
      has_email:   !!r.email,
      has_phone:   !!r.phone,
      created_at:  r.created_at,
    }))
    res.json({
      found:     accounts.length,
      accounts,
      notice:    '完整密钥找回需通过已绑定的邮箱/手机验证（P1 即将上线）。若你此前未绑定任何渠道，请使用本机已保存的密钥登录或联系管理员。',
    })
  })

  // 步骤 1：发送验证码到已绑定邮箱（防泄露：找没找到都同响应）
  app.post('/api/recover-key/start', async (req, res) => {
    const { name, email } = req.body
    if (!name?.trim() || !email?.trim()) return void res.json({ error: '请填写名称和邮箱' })
    if (!canDeliverCodes()) {
      const unavailable = emailDeliveryNotConfigured()
      return void res.status(unavailable.status).json({ error: unavailable.error, error_code: unavailable.error_code })
    }
    const target = email.trim().toLowerCase()
    const genericResponse = {
      success: true,
      notice: '若该名称与邮箱组合存在，验证码已发送至该邮箱',
      expires_in_min: CODE_TTL_MIN,
    }

    const { display, handleRef } = accountRef(name)
    const user = await dbOne<{ id: string }>(`
      SELECT id, name, email FROM users
      WHERE ${ACCOUNT_MATCH} AND email = ? AND email_verified = 1 LIMIT 1
    `, [handleRef, display, internalAuditorId, target])

    if (user) {
      const issued = await issueCode(user.id, 'email', target, 'recover_key')
      if (!issued.ok) {
        console.warn(`[recover-key] verification email delivery failed: ${issued.error_code}`)
        return void res.json(genericResponse)
      }
    }

    res.json(genericResponse)
  })

  // 步骤 2：提交验证码 → 返回完整 api_key,并可选同时重置登录密码(code + new_password)。
  // 安全等价:本端点本就返回完整 api_key(最高凭证),允许同时重置密码不扩大权限面 —— 验证码已是同等门槛。
  app.post('/api/recover-key/confirm', async (req, res) => {
    const { name, email, code, new_password } = req.body
    if (!name?.trim() || !email?.trim() || !code?.trim()) return void res.json({ error: '请填写完整信息' })
    // 可选新密码:格式与 change-password 一致(≥8,≤200)。先校验格式,失败【不消费验证码】,可重试。
    const wantsPasswordReset = new_password !== undefined && new_password !== null && String(new_password) !== ''
    if (wantsPasswordReset) {
      if (String(new_password).length < 8)   return void res.json({ error: '新密码至少 8 字符' })
      if (String(new_password).length > 200) return void res.json({ error: '密码过长（>200 字符）' })
    }
    const target = email.trim().toLowerCase()

    const row = findActiveCode('email', target, 'recover_key')
    if (!row) return void res.json({ error: '验证码已过期或未发送，请重新开始' })

    const user = await dbOne<{ id: string; name: string; handle: string | null; api_key: string }>(`SELECT id, name, handle, api_key FROM users WHERE id = ?`, [row.user_id])
    const { display, handleRef } = accountRef(name)
    const refMatches = !!user && (user.name === display || String(user.handle || '').toLowerCase() === handleRef)
    if (!user || !refMatches) return void res.json({ error: '名称 / @用户名与验证码不匹配' })

    if (String(row.code) !== code.trim()) {
      const attempts = (row.attempts as number) + 1
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await dbRun("UPDATE verification_codes SET attempts = ?, used_at = datetime('now') WHERE id = ?",
          [attempts, row.id as string])
        return void res.json({ error: '错误次数过多，验证码已作废，请重新开始' })
      }
      await dbRun("UPDATE verification_codes SET attempts = ? WHERE id = ?", [attempts, row.id as string])
      return void res.json({ error: `验证码错误（剩余 ${MAX_CODE_ATTEMPTS - attempts} 次）` })
    }

    await dbRun("UPDATE verification_codes SET used_at = datetime('now') WHERE id = ?", [row.id as string])
    // optional password reset — same credential gate as returning the api_key, so no extra power.
    let passwordReset = false
    if (wantsPasswordReset) {
      // mirror /profile/set-password: also clear lock state, else a user who forgot + got locked out by
      // failed attempts stays locked and "new password is correct but can't log in" (auth-login rejects
      // locked users before verifying the password).
      await dbRun("UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?",
        [hashPassword(String(new_password)), user.id])
      passwordReset = true
    }
    res.json({ success: true, api_key: user.api_key, name: user.name, ...(passwordReset ? { password_reset: true } : {}) })
  })
}
