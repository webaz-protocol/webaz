/**
 * Register — 注册（推土机 sponsor + 原子能 placement + 邀请轮询统计）
 *
 * 由 #1013 Phase 118 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint:
 *   POST /api/register  仅 buyer/seller · 受信角色拒绝公开注册
 *                       · sponsor 仅 permanent_code(可带 -L/-R);usr_xxx / @handle / handle 不再接受
 *                       · region 必填（影响 L3 分账）
 *                       · 写入打包成事务（user + wallet + audit + placement + invite stat）
 *                       · 事务外 recordSession + broadcastSystemEvent
 *
 * 跨域注入：db + errorRes + INTERNAL_AUDITOR_ID + isAllowedSponsor + resolveUserRef
 *           + generateId + generateSecureKey + generatePermanentCode + deriveHandle
 *           + clientIpHash + clientUaHash + VALID_REGIONS + pickPreferredSide
 *           + joinPowerLeg + INVITE_ROTATION_HANDLES + inviteRotationLookup
 *           + recordSession + broadcastSystemEvent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import type { EmailDeliveryFailure, IssueCodeResult } from '../email-delivery.js'

export interface AuthRegisterDeps {
  db: Database.Database
  errorRes: (res: Response, status: number, code: string, msg: string, extra?: Record<string, unknown>) => void
  INTERNAL_AUDITOR_ID: string
  // 邮箱验证优先注册(PWA 人类路径)— 与 recover-key / profile-credentials 复用同一套发码/查码/投递闸门。
  // agent/MCP 路径走 handleRegister 直插库,不经此端点,故不受邮箱强制影响。
  issueCode: (userId: string, channel: string, target: string, purpose: string) => Promise<IssueCodeResult>
  findActiveCode: (channel: string, target: string, purpose: string) => Record<string, unknown> | undefined
  canDeliverCodes: () => boolean
  emailDeliveryNotConfigured: () => EmailDeliveryFailure
  CODE_TTL_MIN: number
  MAX_CODE_ATTEMPTS: number
  isAllowedSponsor: (id: string) => boolean
  resolveUserRef: (ref: string) => string | null
  // invite-code-ONLY resolver (permanent_code [+ -L/-R]); rejects usr_xxx / @handle / handle
  resolveInviteCodeRef: (raw: string) => { userId: string; code: string; side: 'left' | 'right' | null } | null
  generateId: (prefix: string) => string
  generateSecureKey: (prefix: string) => string
  generatePermanentCode: () => string
  deriveHandle: (name: string) => string
  clientIpHash: (req: Request) => string
  clientUaHash: (req: Request) => string
  VALID_REGIONS: Set<string>
  pickPreferredSide: (inviterId: string) => 'left' | 'right'
  joinPowerLeg: (inviterId: string, side: 'left' | 'right', newId: string) => { tail: string; depth: number }
  INVITE_ROTATION_HANDLES: readonly string[]
  inviteRotationLookup: (slot: number) => { id: string; code: string; handle: string; name: string } | null
  recordSession: (userId: string, apiKey: string, req: Request) => void
  broadcastSystemEvent: (type: string, icon: string, msg: string, refId?: string | null) => void
}

export function registerAuthRegisterRoutes(app: Application, deps: AuthRegisterDeps): void {
  // VALID_REGIONS + INVITE_ROTATION_HANDLES 通过 deps.X 在 handler 内延迟读
  // （server.ts 用 getter 注入；destructure at register-time would trigger TDZ 因为它们在下方 const）
  const { db, errorRes, INTERNAL_AUDITOR_ID, isAllowedSponsor, resolveInviteCodeRef,
          generateId, generateSecureKey, generatePermanentCode, deriveHandle,
          clientIpHash, clientUaHash,
          pickPreferredSide, joinPowerLeg,
          inviteRotationLookup,
          issueCode, findActiveCode, canDeliverCodes, emailDeliveryNotConfigured,
          recordSession, broadcastSystemEvent } = deps
  // CODE_TTL_MIN / MAX_CODE_ATTEMPTS 通过 deps.X 在 handler 内延迟读(它们在 server.ts 是后置 const,
  // register-time destructure 会触发 TDZ)。

  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
  const normEmail = (raw: unknown): string => String(raw || '').trim().toLowerCase()
  // IP 级发码限流(5/min)— 防爆破列举邮箱 / 刷验证码
  const regCodeHits = new Map<string, { count: number; firstAt: number }>()

  // 注册邮箱验证:发码到邮箱(purpose='register',无账号故 user_id='')。
  // 注册场景需明确告知"邮箱已占用"(无法防枚举,标准取舍),但限流 + captcha 兜底。
  app.post('/api/register/send-code', async (req, res) => {
    const email = normEmail(req.body?.email)
    if (!email || !EMAIL_RE.test(email)) return void errorRes(res, 400, 'EMAIL_INVALID', '请填写有效邮箱')
    if (!canDeliverCodes()) {
      const u = emailDeliveryNotConfigured()
      return void res.status(u.status).json({ error: u.error, error_code: u.error_code })
    }
    const ip = req.ip || ''
    if (ip) {
      const now = Date.now()
      const rec = regCodeHits.get(ip)
      if (rec && now - rec.firstAt < 60_000) {
        rec.count++
        if (rec.count > 5) return void errorRes(res, 429, 'CODE_RATE_LIMITED', '发送过于频繁，请 1 分钟后再试')
      } else {
        regCodeHits.set(ip, { count: 1, firstAt: now })
      }
      if (regCodeHits.size > 1000) {
        for (const [k, v] of regCodeHits) if (now - v.firstAt > 60_000) regCodeHits.delete(k)
      }
    }
    const dup = await dbOne(
      "SELECT 1 FROM users WHERE lower(email) = ? AND email_verified = 1 AND id NOT IN ('sys_protocol', ?) LIMIT 1"
    , [email, INTERNAL_AUDITOR_ID])
    if (dup) return void errorRes(res, 409, 'EMAIL_TAKEN', '该邮箱已注册，请直接登录或用 #recover 找回')
    const issued = await issueCode('', 'email', email, 'register')
    if (!issued.ok) {
      return void res.status(issued.status || 503).json({ error: issued.error || '验证码发送失败，请稍后再试', error_code: issued.error_code || 'EMAIL_DELIVERY_FAILED' })
    }
    res.json({ success: true, notice: '验证码已发送至邮箱，请查收（含垃圾箱）', expires_in_min: deps.CODE_TTL_MIN })
  })

  app.post('/api/register', async (req, res) => {
    const { name, role, sponsor_id, region, placement_inviter_id, turnstile_token } = req.body
    const validRoles = ['buyer', 'seller']
    if (!name?.trim()) return void errorRes(res, 400, 'NAME_REQUIRED', '请填写名称')
    if (!validRoles.includes(role)) return void errorRes(res, 400, 'ROLE_NOT_PUBLIC_REGISTERABLE', '角色无效（仅允许 buyer/seller — 受信角色须经内部审批）')

    // #1049 Cloudflare Turnstile anti-sybil — env 缺失则跳过(dev/pre-launch fallback,不阻断)
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY
    if (turnstileSecret) {
      if (!turnstile_token || typeof turnstile_token !== 'string') {
        return void errorRes(res, 400, 'CAPTCHA_REQUIRED', '请完成人机校验')
      }
      // P1-3:Cloudflare Turnstile token 通常 <2KB,卡 4KB 防大体积注入 siteverify 浪费带宽
      if (turnstile_token.length > 4096) {
        return void errorRes(res, 400, 'CAPTCHA_INVALID', '人机校验未通过,请刷新后重试')
      }
      try {
        const remoteIp = req.ip || req.socket?.remoteAddress || ''
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: turnstileSecret, response: turnstile_token, ...(remoteIp ? { remoteip: remoteIp } : {}) }).toString(),
        })
        const verifyJson = await verifyRes.json() as { success: boolean; 'error-codes'?: string[] }
        if (!verifyJson.success) {
          return void errorRes(res, 403, 'CAPTCHA_INVALID', '人机校验未通过,请刷新后重试', { codes: verifyJson['error-codes'] })
        }
      } catch (e) {
        // siteverify 网络故障 — 保守拒绝(防绕过),用户重试即可
        return void errorRes(res, 503, 'CAPTCHA_VERIFY_UNAVAILABLE', '人机校验服务暂不可用,请稍后再试')
      }
    }

    const trimmed = name.trim()
    if (trimmed.length < 2 || trimmed.length > 40) return void errorRes(res, 400, 'NAME_LENGTH', '名称长度需在 2–40 个字符之间')

    const dup = await dbOne(
      "SELECT 1 FROM users WHERE name = ? AND id NOT IN ('sys_protocol', ?) LIMIT 1"
    , [trimmed, INTERNAL_AUDITOR_ID])
    if (dup) return void errorRes(res, 409, 'NAME_TAKEN', '该名称已被占用，请换一个')

    // ── 邮箱验证优先注册 ────────────────────────────────────────
    // PWA 人类路径强制:必须先 /register/send-code 拿验证码,提交时带 email + code,校验通过才建号 + email_verified=1。
    // 这样每个新 PWA 账号天生有 verified 邮箱 → #recover 永远可用。
    // agent/MCP 注册走 handleRegister 直插库(自托管 key,不需邮件找回),不经此端点,不受影响。
    const email = normEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()
    if (!email || !code) return void errorRes(res, 400, 'EMAIL_VERIFICATION_REQUIRED', '注册需先验证邮箱:请填写邮箱并输入收到的验证码')
    if (!EMAIL_RE.test(email)) return void errorRes(res, 400, 'EMAIL_INVALID', '邮箱格式不正确')
    const emailDup = await dbOne(
      "SELECT 1 FROM users WHERE lower(email) = ? AND email_verified = 1 AND id NOT IN ('sys_protocol', ?) LIMIT 1"
    , [email, INTERNAL_AUDITOR_ID])
    if (emailDup) return void errorRes(res, 409, 'EMAIL_TAKEN', '该邮箱已注册，请直接登录或用 #recover 找回')
    // 校验注册验证码(按 email 查,purpose='register')。错码计数,超限作废,均【不建号】。
    const codeRow = findActiveCode('email', email, 'register') as { id: string; code: string; attempts: number } | undefined
    if (!codeRow) return void errorRes(res, 400, 'CODE_EXPIRED', '验证码已过期或未发送，请重新获取')
    if (String(codeRow.code) !== code) {
      const attempts = Number(codeRow.attempts || 0) + 1
      if (attempts >= deps.MAX_CODE_ATTEMPTS) {
        await dbRun("UPDATE verification_codes SET attempts = ?, used_at = datetime('now') WHERE id = ?", [attempts, codeRow.id])
        return void errorRes(res, 400, 'CODE_TOO_MANY', '错误次数过多，验证码已作废，请重新获取')
      }
      await dbRun("UPDATE verification_codes SET attempts = ? WHERE id = ?", [attempts, codeRow.id])
      return void errorRes(res, 400, 'CODE_INVALID', `验证码错误（剩余 ${deps.MAX_CODE_ATTEMPTS - attempts} 次）`)
    }

    const ROLE_WHITELIST: string[] = []
    const requireRef = (await dbOne<{ value: string }>("SELECT value FROM system_state WHERE key='require_ref_to_register'", []))?.value === '1'
    // 2026-05-30 合规复审:取消 china 豁免——D1b 引入时保留 china 通道是为获客,
    // 但合规上正好反向(china 是 MLM 风险最高地区,豁免反而把最高风险地区做成最容易进)。
    // 全球统一需邀请。第三方尽调报告风险 1 + 问题 1 的回应。
    if (requireRef && !sponsor_id && !ROLE_WHITELIST.includes(role)) {
      return void errorRes(res, 403, 'INVITE_REQUIRED', '注册需要邀请码。请联系已有用户获取邀请链接。', { hint: 'require_ref_enabled' })
    }

    let sponsorId: string | null = null
    let sponsorPath: string | null = null
    let sponsorSkipped: string | null = null
    // invite codes ONLY: 6-7 char permanent_code with optional -L/-R side. usr_xxx / @handle / handle are
    // no longer accepted as a registration sponsor (anti-ambiguity; narrows the public invite surface).
    const sponsorRawRef = (sponsor_id && typeof sponsor_id === 'string') ? sponsor_id.trim() : ''
    let resolvedSponsorId: string | null = null
    if (sponsorRawRef) {
      const ref = resolveInviteCodeRef(sponsorRawRef)
      if (!ref) {
        return void errorRes(res, 400, 'INVALID_SPONSOR_REF', `邀请码无效：${sponsorRawRef.slice(0, 24)}（仅接受 6-7 位永久码；请检查或留空跳过）`)
      }
      resolvedSponsorId = ref.userId
      // pre-public: 去左右码 — 邀请码自带的 -L/-R 侧别一律忽略,放置永远自动(见下)
      const sponsor = await dbOne<{ id: string; sponsor_path: string | null }>("SELECT id, sponsor_path FROM users WHERE id = ?", [ref.userId])
      if (!sponsor) {
        return void errorRes(res, 400, 'INVALID_SPONSOR_REF', `邀请码对应用户不存在：${sponsorRawRef.slice(0, 24)}`)
      }
      sponsorId = sponsor.id
      sponsorPath = sponsor.sponsor_path ? `${sponsor.sponsor_path}>${sponsor.id}` : sponsor.id
      if (!isAllowedSponsor(sponsor.id)) sponsorSkipped = 'sponsor_pending_verification'
    }
    if (!sponsorId && !ROLE_WHITELIST.includes(role)) {
      sponsorId = 'sys_protocol'
      sponsorPath = 'sys_protocol'
    }
    const userRegion = (typeof region === 'string' && region.trim()) ? region.trim() : ''
    if (!deps.VALID_REGIONS.has(userRegion)) {
      return void errorRes(res, 400, 'REGION_REQUIRED', '请选择国家 / 地区（影响分润分账配置）')
    }

    const id = generateId('usr')
    const apiKey = generateSecureKey('key')
    const permaCode = generatePermanentCode()
    const userHandle = deriveHandle(trimmed)
    const ipHash = clientIpHash(req)
    const uaHash = clientUaHash(req)

    // Phase 3a：注册限频 — 同 IP 每小时最多 5 个新账号(挡批量刷号)
    const recentReg = (await dbOne<{ n: number }>(`SELECT COUNT(*) AS n FROM registration_audit_log WHERE ip_hash = ? AND created_at > datetime('now','-1 hour')`, [ipHash]))!.n
    if (recentReg >= 5) {
      return void errorRes(res, 429, 'REGISTER_RATE_LIMITED', '注册过于频繁 — 同一网络每小时最多 5 个新账号，请稍后再试')
    }

    const registerTx = db.transaction(() => {
      db.prepare(`INSERT INTO users (id, name, role, roles, api_key, sponsor_id, sponsor_path, region, permanent_code, handle, email, email_verified)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
        .run(id, trimmed, role, JSON.stringify([role]), apiKey, sponsorId, sponsorPath, userRegion, permaCode, userHandle, email)
      // 消费注册验证码(单次性)— 与建号同一事务,失败则整体回滚,不留"码已用但没建号"
      db.prepare("UPDATE verification_codes SET used_at = datetime('now') WHERE id = ?").run(codeRow.id)
      db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,1000)').run(id)
      db.prepare(`INSERT INTO registration_audit_log (user_id, ip_hash, ua_hash, sponsor_id) VALUES (?,?,?,?)`)
        .run(id, ipHash, uaHash, sponsorId)

      // placement inviter is invite-code-only too (the sponsor code, or an explicit placement_inviter_id code)
      let effectiveInviter: string | null = resolvedSponsorId
      // pre-public 去左右码:不再接受用户/邀请码指定的左右侧,放置侧别永远由系统自动决定(pickPreferredSide)
      let effectiveSide: 'left' | 'right' | null = null
      if (placement_inviter_id) {
        const p = resolveInviteCodeRef(String(placement_inviter_id))
        if (p) { effectiveInviter = p.userId }
      }
      if (effectiveInviter && !effectiveSide) {
        try { effectiveSide = pickPreferredSide(effectiveInviter) } catch { effectiveSide = 'left' }
      }
      let placement: { tail: string; depth: number } | null = null
      if (effectiveInviter && effectiveSide) {
        const inviter = db.prepare("SELECT id FROM users WHERE id = ? AND id NOT IN ('sys_protocol', ?) LIMIT 1")
          .get(effectiveInviter, INTERNAL_AUDITOR_ID) as { id: string } | undefined
        if (inviter) {
          // do NOT swallow: a known inviter+side that fails to place would leave a placement orphan
          // (sponsor recorded but absent from the binary tree). Fail-closed → rethrow so the whole
          // registration transaction rolls back (no users / wallet / audit rows persist).
          try {
            placement = joinPowerLeg(inviter.id, effectiveSide, id)
          } catch (e) {
            throw new Error('PLACEMENT_FAILED:' + (e as Error).message)
          }
        }
      }

      const rotationEnabled = (db.prepare("SELECT value FROM system_state WHERE key='invite_rotation_enabled'").get() as { value: string } | undefined)?.value === '1'
      if (rotationEnabled && sponsorId) {
        for (let i = 0; i < deps.INVITE_ROTATION_HANDLES.length; i++) {
          const u = inviteRotationLookup(i)
          if (u && u.id === sponsorId) {
            db.prepare("UPDATE invite_rotation_stats SET registered_count = registered_count + 1 WHERE slot = ?").run(i)
            break
          }
        }
      }
      return { placement, effectiveInviter, effectiveSide }
    })

    let txResult: { placement: { tail: string; depth: number } | null; effectiveInviter: string | null; effectiveSide: 'left' | 'right' | null }
    try {
      txResult = registerTx()
    } catch (e) {
      const msg = (e as Error).message
      console.error('[register-tx]', msg)
      if (msg.startsWith('PLACEMENT_FAILED:')) return void errorRes(res, 409, 'PLACEMENT_FAILED', '注册挂靠失败，请重试或联系支持（未创建账号）')
      return void res.status(500).json({ error: '注册写入失败，请重试' })
    }
    const { placement, effectiveInviter, effectiveSide } = txResult
    try { recordSession(id, apiKey, req) } catch {}
    try { broadcastSystemEvent('register', '🎉', `新用户注册: ${trimmed} (${role})`, id) } catch {}

    res.json({
      success: true, api_key: apiKey, user_id: id, name: trimmed, role, roles: [role],
      sponsor_id: sponsorId, region: userRegion,
      permanent_code: permaCode,
      handle: userHandle,
      email, email_verified: true,
      placement: placement ? { inviter_id: effectiveInviter, side: effectiveSide, depth: placement.depth } : null,
      ...(sponsorSkipped ? { sponsor_skipped: sponsorSkipped } : {}),
    })
  })
}
