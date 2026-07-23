/**
 * Wallet — 写端点（钱包连接 + 提现流程 + 取消）
 *
 * 由 #1013 Phase 81 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   POST /api/wallet/connect/challenge        签名挑战（5min 一次性）
 *   POST /api/wallet/connect/verify           签名验证 → 加入白名单（免 24h 冷却）
 *   POST /api/wallet/withdraw                 提现申请（KYC + Passkey + 白名单 + 大额邮件路径）
 *   POST /api/wallet/withdraw/:id/confirm     大额邮件验证码确认
 *   POST /api/wallet/withdrawals/:id/cancel   取消 pending（自动退余）
 *
 * 关键守卫：
 *   - 受信角色无钱包（POST 全部门）
 *   - 大额（>= kyc_required_withdraw_waz）或 24h 累计（>= kyc_daily_cumulative_waz）→ 必须 KYC（防 smurf）
 *   - 大额 + 已注册 Passkey → 强制 WebAuthn gate（#1009 自动强制）
 *   - 出金白名单 + 24h 冷却（连接验签可跳过）
 *   - 大额走 pending_email 路径 + 邮件验证码二次确认
 *
 * walletChallenges Map + cleanup 内化到模块
 *
 * 跨域注入：auth + isTrustedRole + generateId + getProtocolParam +
 *           consumeGateToken + issueCode + findActiveCode + maskEmail +
 *           LARGE_WITHDRAW_THRESHOLD + viem.verifyMessage
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { verifyMessage } from 'viem'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface WalletWriteDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  generateId: (prefix: string) => string
  getProtocolParam: <T>(key: string, fallback: T) => T
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  issueCode: (userId: string, channel: string, target: string, purpose: string) => void | Promise<unknown>
  findActiveCode: (channel: string, target: string, purpose: string) => unknown
  maskEmail: (email: string) => string
  LARGE_WITHDRAW_THRESHOLD: number
}

export function registerWalletWriteRoutes(app: Application, deps: WalletWriteDeps): void {
  const { db, auth, isTrustedRole, generateId, getProtocolParam, consumeGateToken,
          issueCode, findActiveCode, maskEmail, LARGE_WITHDRAW_THRESHOLD } = deps

  // Wave G-1: 签名挑战 — 5min 一次性 nonce
  const walletChallenges = new Map<string, { userId: string; nonce: string; expiresAt: number }>()
  const cleanupWalletChallenges = () => {
    const now = Date.now()
    for (const [k, v] of walletChallenges) if (v.expiresAt < now) walletChallenges.delete(k)
  }

  app.post('/api/wallet/connect/challenge', (req, res) => {
    const user = auth(req, res); if (!user) return
    if (Number(getProtocolParam('payment_rail_waz_escrow_enabled', 0)) !== 1) return void res.status(409).json({ error: 'WAZ 已退役,钱包绑定已关闭', error_code: 'RAIL_DISABLED' })   // WAZ 退役:connect 是提现前置,同闸
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色无钱包' })
    cleanupWalletChallenges()
    const nonce = generateId('nce').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) + Date.now().toString(36)
    const id = generateId('chl')
    walletChallenges.set(id, { userId: String(user.id), nonce, expiresAt: Date.now() + 5 * 60_000 })
    const message = `WebAZ 钱包绑定验证\n\nNonce: ${nonce}\nUserID: ${user.id}\nExpires: ${new Date(Date.now() + 5 * 60_000).toISOString()}\n\n签名仅用于证明地址归属，不消耗任何 gas，也不会触发任何链上交易。`
    res.json({ challenge_id: id, message })
  })

  app.post('/api/wallet/connect/verify', async (req, res) => {
    if (Number(getProtocolParam('payment_rail_waz_escrow_enabled', 0)) !== 1) return void res.status(409).json({ error: 'WAZ 已退役,钱包绑定已关闭', error_code: 'RAIL_DISABLED' })   // WAZ 退役:关停前发的 5min challenge 也不能在关停后 verify 入白名单(Codex #516 R1 P2)
    const user = auth(req, res); if (!user) return
    // H-2 P1-1: 防御性 — 受信角色不应能绑钱包
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色无钱包' })
    cleanupWalletChallenges()
    const { challenge_id, address, signature, label } = req.body || {}
    if (!challenge_id || !address || !signature) {
      return void res.status(400).json({ error: '缺少 challenge_id / address / signature' })
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) {
      return void res.status(400).json({ error: '地址格式无效' })
    }
    const chl = walletChallenges.get(String(challenge_id))
    if (!chl) return void res.status(400).json({ error: 'challenge 无效或已过期' })
    if (chl.userId !== String(user.id)) return void res.status(403).json({ error: 'challenge 不属于当前用户' })
    walletChallenges.delete(String(challenge_id))  // 单次使用

    const message = `WebAZ 钱包绑定验证\n\nNonce: ${chl.nonce}\nUserID: ${user.id}\nExpires: ${new Date(chl.expiresAt).toISOString()}\n\n签名仅用于证明地址归属，不消耗任何 gas，也不会触发任何链上交易。`

    // viem verifyMessage 自动处理 EIP-191 personal_sign 格式
    try {
      const valid = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      })
      if (!valid) return void res.status(400).json({ error: '签名验证失败' })
    } catch (e) {
      return void res.status(400).json({ error: '签名格式错误: ' + (e as Error).message })
    }

    // 已通过签名校验 → 加入白名单，免 24h 冷却（activates_at = NOW）
    const addrLc = String(address).toLowerCase()
    const existing = await dbOne<{ id: string; revoked_at: string | null }>('SELECT id, revoked_at FROM withdrawal_whitelist WHERE user_id = ? AND address = ?', [user.id, addrLc])
    if (existing) {
      await dbRun(`UPDATE withdrawal_whitelist SET activates_at = datetime('now'), revoked_at = NULL,
        signature_verified_at = datetime('now'), label = COALESCE(?, label) WHERE id = ?`,
        [label || null, existing.id])
      return void res.json({ success: true, id: existing.id, activated: true })
    }
    const id = generateId('wl')
    await dbRun(`INSERT INTO withdrawal_whitelist (id, user_id, address, label, activates_at, signature_verified_at)
      VALUES (?,?,?,?,datetime('now'),datetime('now'))`,
      [id, user.id, addrLc, label ? String(label).slice(0, 30) : null])
    res.json({ success: true, id, activated: true })
  })

  // 提现申请
  // RFC-016: withdraw + confirm 是铁律资金转出路径,余额扣减是裸顺序写(非 db.transaction)。
  // 保持整体同步,Phase 3 随资金路径整体迁 pg(BEGIN + SELECT...FOR UPDATE 行锁),不在此引入 await 间隙。
  app.post('/api/wallet/withdraw', (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色无钱包，不可提现', error_code: 'TRUSTED_ROLE_NO_WALLET' })
    // WAZ 退役(2026-07-23):渠道关(默认)→ 不再受理【新】提现申请(fail-closed);已提申请的
    //   confirm/cancel 与 admin 处理不受影响(存量收敛路径绝不门控)。
    if (Number(getProtocolParam('payment_rail_waz_escrow_enabled', 0)) !== 1) return void res.status(409).json({ error: 'WAZ 已退役,提现通道已关闭', error_code: 'RAIL_DISABLED' })
    const { to_address: to_address_raw, amount } = req.body
    // P0-1: toLowerCase 后与白名单匹配
    const to_address = typeof to_address_raw === 'string' ? to_address_raw.toLowerCase() : to_address_raw

    if (!/^0x[0-9a-fA-F]{40}$/.test(to_address ?? '')) {
      return void res.json({ error: '请输入有效的以太坊地址（0x 开头，42 位字符）' })
    }
    const amountNum = Number(amount)
    if (!amountNum || amountNum <= 0) return void res.json({ error: '请输入提现金额' })
    const minWithdraw = getProtocolParam<number>('usdc_min_withdraw_waz', 10)
    if (amountNum < minWithdraw) return void res.json({ error: `最低提现金额为 ${minWithdraw} WAZ` })

    // 2026-05-22 audit P1：大额提现 KYC 强制（双维度防 smurf 分拆）
    const kycThreshold = getProtocolParam<number>('kyc_required_withdraw_waz', 1000)
    const kycDailyThreshold = getProtocolParam<number>('kyc_daily_cumulative_waz', 3000)
    let kycReason: string | null = null
    let kycField = 'single'

    if (amountNum >= kycThreshold) {
      kycReason = `提现 ≥ ${kycThreshold} WAZ 需要先完成实名认证（KYC）`
      kycField = 'single'
    } else {
      const dailyRow = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM withdrawal_requests
        WHERE user_id = ?
          AND status IN ('pending', 'processing', 'completed', 'awaiting_email_confirm')
          AND created_at > datetime('now', '-1 day')
      `).get(user.id) as { total: number }
      const dailyTotal = Number(dailyRow.total) + amountNum
      if (dailyTotal >= kycDailyThreshold) {
        kycReason = `24h 内提现累计 ${dailyTotal.toFixed(2)} ≥ ${kycDailyThreshold} WAZ，需先完成实名认证（防 smurf）`
        kycField = 'daily_cumulative'
      }
    }

    if (kycReason) {
      const k = db.prepare("SELECT status FROM kyc_records WHERE user_id = ?").get(user.id) as { status: string } | undefined
      if (!k || k.status !== 'approved') {
        return void res.status(403).json({
          error: kycReason,
          error_code: 'KYC_REQUIRED_FOR_WITHDRAW',
          trigger: kycField,
          threshold: kycField === 'single' ? kycThreshold : kycDailyThreshold,
        })
      }
    }

    // WebAuthn gate — #1115 全额对齐铁律:**所有**提现都要真人 Passkey 一次性 token。
    //   资金转出 = 真人在场(spec §4 铁律,与 vote/arbitrate/agent_revoke 同档)。
    //   email-OTP 在 agent 威胁模型下不足(agent 可读监护人收件箱);故弃用旧的"非 Passkey → email 兜底"路径。
    //   未注册 Passkey 的账户:不能提现,先去「安全」绑 Passkey(资金操作强制 Passkey)。
    // Codex #100 P1:提现真人 Passkey 是【铁律】,绝不可被任何 protocol param 关闭 → 无条件执行,不读开关。
    //   (旧代码 if (require_human_presence_for_withdraw===1) 让 protocol admin 把它设 0 即可绕过铁律。)
    //   该 param 已锁死 value=min=max=1,仅作展示(见 server.ts DEFAULT_PARAMS + 启动迁移)。
    {
      const hasPasskeyRow = db.prepare('SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?').get(user.id) as { n: number }
      const hasPasskey = (hasPasskeyRow?.n || 0) > 0
      if (!hasPasskey) {
        return void res.status(403).json({
          error: '提现需先绑定 Passkey（资金转出需真人在场，铁律）。请到「安全」页绑定后再试。',
          error_code: 'PASSKEY_REQUIRED_FOR_WITHDRAW',
          requires_passkey_setup: true,
        })
      }
      const token = req.headers['x-webauthn-token'] as string | undefined
      const gate = consumeGateToken(user.id as string, token, 'withdraw', (data) => {
        const d = (data || {}) as { to_address?: string; amount?: number }
        return d.to_address === to_address && Number(d.amount) === amountNum
      })
      if (!gate.ok) {
        return void res.status(403).json({
          error: gate.reason,
          webauthn_required: true,
          purpose: 'withdraw',
          purpose_data: { to_address, amount: amountNum },
          force_reason: 'iron_rule_withdraw',
        })
      }
    }

    const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number } | undefined
    if (!wallet) return void res.status(500).json({ error: '钱包记录缺失', error_code: 'WALLET_MISSING' })
    if (wallet.balance < amountNum) {
      return void res.json({ error: `余额不足：当前可用 ${wallet.balance.toFixed(2)} WAZ` })
    }

    // 白名单校验：必须在 user 的 active 白名单内，且过了 24h 冷却
    const wl = db.prepare(`
      SELECT activates_at FROM withdrawal_whitelist
      WHERE user_id = ? AND address = ? AND revoked_at IS NULL
    `).get(user.id, to_address) as { activates_at: string } | undefined
    if (!wl) {
      return void res.json({ error: '该地址不在你的白名单中，请先到「提现白名单」添加（添加后 24h 冷却生效）' })
    }
    if (new Date(wl.activates_at.replace(' ', 'T') + 'Z').getTime() > Date.now()) {
      const mins = Math.ceil((new Date(wl.activates_at.replace(' ', 'T') + 'Z').getTime() - Date.now()) / 60_000)
      return void res.json({ error: `该地址在冷却期内，约 ${mins} 分钟后可用（添加后 24h 强制冷却）` })
    }

    // Passkey 已过真人门 → 即时扣款 + pending（admin 处理）。各金额一致(大额二次邮件确认已被 Passkey 取代)。
    const wid = generateId('wdr')
    db.prepare(`INSERT INTO withdrawal_requests (id, user_id, to_address, amount) VALUES (?,?,?,?)`)
      .run(wid, user.id, to_address, amountNum)
    db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(amountNum, user.id)

    res.json({
      success: true,
      request_id: wid,
      message: '提现申请已提交，将在 24 小时内到账。',
    })
  })

  // 大额提现：邮件验证码确认
  app.post('/api/wallet/withdraw/:id/confirm', (req, res) => {
    const user = auth(req, res); if (!user) return
    const wid = req.params.id
    const code = String(req.body?.code || '').trim()
    if (!/^\d{6}$/.test(code)) return void res.json({ error: '请输入 6 位验证码' })
    const wr = db.prepare(`
      SELECT id, user_id, amount, to_address, status FROM withdrawal_requests WHERE id = ?
    `).get(wid) as { id: string; user_id: string; amount: number; to_address: string; status: string } | undefined
    if (!wr || wr.user_id !== user.id) return void res.json({ error: '请求不存在' })
    if (wr.status !== 'pending_email') return void res.json({ error: '该请求无需邮件确认或已确认' })

    const purpose = 'withdraw_confirm:' + wid
    const row = findActiveCode('email', user.email as string, purpose) as { id: string; code: string } | undefined
    if (!row) return void res.json({ error: '验证码已过期，请重新发起提现' })
    if (row.code !== code) return void res.json({ error: '验证码错误' })

    db.prepare("UPDATE verification_codes SET used_at = datetime('now') WHERE id = ?").run(row.id)
    const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
    if (wallet.balance < wr.amount) {
      db.prepare("UPDATE withdrawal_requests SET status = 'rejected', status_detail = 'insufficient_balance_at_confirm' WHERE id = ?").run(wid)
      return void res.json({ error: '余额不足（确认时刻余额已变化），请重新提现' })
    }
    db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(wr.amount, user.id)
    db.prepare(`UPDATE withdrawal_requests SET status = 'pending', email_confirmed_at = datetime('now'), status_detail = NULL WHERE id = ?`).run(wid)
    res.json({ success: true, message: '邮件确认通过，提现进入处理队列，24 小时内到账' })
  })

  // 用户取消尚未 approve 的 withdrawal — 余额自动退回
  app.post('/api/wallet/withdrawals/:id/cancel', (req, res) => {
    const user = auth(req, res); if (!user) return
    const wid = req.params.id
    const tx = db.transaction(() => {
      // SELECT inside tx + UPDATE WHERE status='pending' 双重门防并发取消 + admin approve 抢跑
      const wr = db.prepare(`SELECT user_id, amount, status FROM withdrawal_requests WHERE id = ?`).get(wid) as { user_id: string; amount: number; status: string } | undefined
      if (!wr) throw new Error('withdrawal_not_found')
      if (wr.user_id !== user.id) throw new Error('not_owner')
      if (wr.status !== 'pending' && wr.status !== 'pending_email') throw new Error('cannot_cancel_in_status_' + wr.status)

      const isPendingEmail = wr.status === 'pending_email'
      // pending 阶段已扣款 → 退；pending_email 还没扣款 → 不退
      const upd = db.prepare(`UPDATE withdrawal_requests SET status = 'cancelled', status_detail = 'user_cancelled' WHERE id = ? AND status = ?`)
        .run(wid, wr.status)
      if (upd.changes === 0) throw new Error('race_status_changed')
      if (!isPendingEmail) {
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(wr.amount, user.id)
        return wr.amount
      }
      return 0
    })

    try {
      const refunded = tx()
      res.json({ success: true, refunded })
    } catch (e) {
      const msg = (e as Error).message
      const status = msg === 'not_owner' || msg.startsWith('cannot_cancel_in_status_') ? 403
        : msg === 'withdrawal_not_found' ? 404
        : msg === 'race_status_changed' ? 409
        : 400
      res.status(status).json({ error: msg })
    }
  })
}
