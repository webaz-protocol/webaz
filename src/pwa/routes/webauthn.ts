/**
 * WebAuthn / Passkey 端点（commit B · 大额提现 + 仲裁等敏感操作的二次确认）
 *
 * 由 #1013 Phase 1 从 src/pwa/server.ts 抽出（试水 monolith 拆分）。
 * 当前 Phase 1 范围：只拆 endpoint handlers + setup 函数；
 * helpers (consumeGateToken / requireHumanPresence) 仍在 server.ts，
 * 因为它们被 withdraw / arbitrate / vote 等 4+ 个其它 endpoint 引用，
 * 移动它们需要同步改 4+ 处 call site，超出 Phase 1 风险面。
 *
 * 7 个端点：
 *   POST  /api/webauthn/register/start
 *   POST  /api/webauthn/register/finish
 *   POST  /api/webauthn/auth/start
 *   POST  /api/webauthn/auth/finish
 *   GET   /api/webauthn/credentials
 *   DELETE /api/webauthn/credentials/:id
 *   POST  /api/webauthn/settings
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { randomBytes } from 'node:crypto'
// RFC-004 体验补:绑定 Passkey 后,追溯补发此前"已受理但无锚点跳过"的建设信誉。
import { grantPendingAnchorCredits } from '../../layer2-business/L2-8-feedback/build-feedback-engine.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { registerAgentGrantsRoutes } from './agent-grants.js'  // RFC-020 PR-B — Passkey-domain delegation grants (keeps server.ts untouched)

export interface WebauthnDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean  // RFC-020 PR-C1 — throttles anon pair/start
  rpId: string                              // WEBAUTHN_RP_ID
  rpName: string                            // WEBAUTHN_RP_NAME
  origin: string | string[]                 // WEBAUTHN_ORIGIN
  challengeTtlMs: number                    // WEBAUTHN_CHALLENGE_TTL_MS
  gateTtlMs: number                         // WEBAUTHN_GATE_TTL_MS
  invalidateAgentRiskCacheForUser: (userId: string) => void  // 绑/解绑 Passkey 后立刻刷 D2b 风险缓存
  requireHumanPresence: (                                     // #1044 — DELETE passkey 自身要 Passkey gate;RFC-020 pair approve 同机制
    userId: string,
    purpose: 'delete_passkey' | 'agent_pair_approve' | 'agent_permission_approve',
    token: string | undefined,
    paramKey: string,
    validate?: (data: unknown) => boolean
  ) => { ok: boolean; reason?: string; error_code?: string }
  // RFC-020 PR-4: the shared product-create handler (from makeCreateProductHandler), forwarded to the
  //   grant-gated warehouse-draft route. Optional so other registrations of webauthn routes don't break.
  createProductDraftHandler?: (req: Request, res: Response, user: Record<string, unknown>, opts?: { forceStatus?: 'warehouse'; onCreated?: (productId: string) => Promise<void> | void; skipExternalLinkEffects?: boolean }) => Promise<void>
  getProtocolParam?: <T>(key: string, fallback: T) => T   // RFC-025 PR-3: 透传给 agent-grants 的 quote 服务
  createOrderLoopback?: (apiKey: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>   // RFC-025 PR-5a: 透传给批准执行域
  apiLoopback?: (apiKey: string, path: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>   // RFC-026 PR-4: 透传给 order-chat 发送域
}

export function registerWebauthnRoutes(app: Application, deps: WebauthnDeps): void {
  const { db, auth, generateId, rateLimitOk, rpId, rpName, origin, challengeTtlMs, gateTtlMs, invalidateAgentRiskCacheForUser, requireHumanPresence } = deps

  // 1. 注册：start — 生成 challenge + 选项
  app.post('/api/webauthn/register/start', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const existing = await dbAll<{ id: string }>('SELECT id FROM webauthn_credentials WHERE user_id = ?', [user.id])
    const opts = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: String(user.handle || user.name || user.id),
      userID: new TextEncoder().encode(String(user.id)),
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({ id: c.id })),
      // H-1: 注册时就强制生物识别 / PIN，否则只按硬件键 = 无 UV 闸门
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    })
    const chId = generateId('wac')
    await dbRun(`INSERT INTO webauthn_challenges (id, user_id, challenge, purpose, expires_at) VALUES (?,?,?,?,?)`,
      [chId, user.id as string, opts.challenge, 'register', new Date(Date.now() + challengeTtlMs).toISOString()])
    res.json({ options: opts, challenge_id: chId })
  })

  // 2. 注册：finish — 验证 + 入库
  app.post('/api/webauthn/register/finish', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { challenge_id, response, device_label } = req.body || {}
    const ch = await dbOne<{ challenge: string; expires_at: string; consumed_at: string | null }>(`SELECT challenge, expires_at, consumed_at FROM webauthn_challenges WHERE id = ? AND user_id = ? AND purpose = 'register'`, [challenge_id, user.id])
    if (!ch) return void res.status(404).json({ error: 'challenge not found' })
    if (ch.consumed_at) return void res.status(409).json({ error: 'challenge already used' })
    if (new Date(ch.expires_at).getTime() < Date.now()) return void res.status(410).json({ error: 'challenge expired' })

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        // H-1: 大额闸门必须有真正的生物识别 / PIN（user verified bit = 1）
        requireUserVerification: true,
      })
      if (!verification.verified || !verification.registrationInfo) {
        return void res.status(400).json({ error: 'verification failed' })
      }
      const { credential } = verification.registrationInfo
      await dbRun(`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_label) VALUES (?,?,?,?,?,?)`,
        [credential.id, user.id as string, Buffer.from(credential.publicKey), credential.counter || 0,
             JSON.stringify(credential.transports || []), (device_label || '').slice(0, 60) || null])
      await dbRun("UPDATE webauthn_challenges SET consumed_at = datetime('now') WHERE id = ?", [challenge_id])
      invalidateAgentRiskCacheForUser(user.id as string)  // 让 D2b 中间件立刻看到刚绑的 Passkey,否则 5min 缓存窗内仍被拦
      // RFC-004:绑定 Passkey = 成为可问责真人 → 追溯补发此前因无锚点跳过的建设信誉(advisory,永不阻塞绑定)
      let backfilled: { granted: number; total_points: number } | undefined
      try { backfilled = grantPendingAnchorCredits(db, user.id as string) } catch { /* 不影响绑定主流程 */ }
      res.json({ success: true, credential_id: credential.id, ...(backfilled && backfilled.granted > 0 ? { build_credit_backfilled: backfilled } : {}) })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  // 3. 认证：start — 生成 challenge（指定 purpose + 业务数据；同一 challenge 不可复用）
  app.post('/api/webauthn/auth/start', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const purpose = String(req.body?.purpose || '').trim()
    const allowed = new Set(['withdraw', 'change-password', 'reveal-key', 'region', 'delete_passkey', 'governance_apply', 'governance_activate', 'governance_resign', 'governance_appeal_resolve', 'rewards_apply', 'rewards_deactivate', 'identity_claim', 'operator_claim_unlink', 'direct_pay_disclosure_ack', 'direct_pay_order_action', 'direct_receive_production_confirm', 'direct_receive_bond_refund', 'direct_pay_bond_slash', 'direct_pay_aml_review', 'direct_pay_kyb_ingress', 'direct_pay_sanctions_ingress', 'direct_pay_aml_ingress', 'direct_pay_admin_readiness', 'direct_pay_deferral_approve', 'direct_pay_deferral_reject', 'direct_pay_deferral_adjust', 'direct_pay_product_verify', 'direct_pay_store_verify', 'direct_pay_fee_prepay_record', 'direct_pay_fee_adjust', 'direct_pay_fee_refund', 'direct_receive_account_manage', 'platform_receive_account_manage', 'direct_pay_fee_prepay_reject', 'direct_pay_fee_prepay_request_approve', 'direct_pay_payment_info_reveal', 'arbitrator_grant', 'arbitrator_suspend', 'arbitrator_reinstate', 'arbitrator_revoke', 'arbitrate', 'agent_pair_approve', 'agent_permission_approve', 'oauth_consent_approve', 'vote', 'agent_revoke', 'product_action_approve'])
    if (!allowed.has(purpose)) return void res.status(400).json({ error: 'invalid purpose' })
    const purpose_data = req.body?.purpose_data ?? null

    const creds = await dbAll<{ id: string; transports: string }>('SELECT id, transports FROM webauthn_credentials WHERE user_id = ?', [user.id])
    if (creds.length === 0) return void res.status(403).json({ error: '尚未注册任何 Passkey', error_code: 'NO_PASSKEY_REGISTERED' })  // 前端据此才提示注册;已注册者的取消/设备失败不误导去注册

    const opts = await generateAuthenticationOptions({
      rpID: rpId,
      // H-1: 闸门必须真正 UV，不接受 "硬件按一下" 兜底
      userVerification: 'required',
      allowCredentials: creds.map(c => ({ id: c.id, transports: (() => { try { return JSON.parse(c.transports) } catch { return [] } })() })),
    })
    const chId = generateId('wac')
    await dbRun(`INSERT INTO webauthn_challenges (id, user_id, challenge, purpose, purpose_data, expires_at) VALUES (?,?,?,?,?,?)`,
      [chId, user.id as string, opts.challenge, purpose,
           purpose_data ? JSON.stringify(purpose_data) : null,
           new Date(Date.now() + challengeTtlMs).toISOString()])
    res.json({ options: opts, challenge_id: chId })
  })

  // 4. 认证：finish — 验证签名 + 颁发短 gate token
  app.post('/api/webauthn/auth/finish', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { challenge_id, response } = req.body || {}
    const ch = await dbOne<{ challenge: string; purpose: string; purpose_data: string | null; expires_at: string; consumed_at: string | null }>(`SELECT challenge, purpose, purpose_data, expires_at, consumed_at FROM webauthn_challenges WHERE id = ? AND user_id = ?`, [challenge_id, user.id])
    if (!ch) return void res.status(404).json({ error: 'challenge not found' })
    if (ch.consumed_at) return void res.status(409).json({ error: 'challenge already used' })
    if (new Date(ch.expires_at).getTime() < Date.now()) return void res.status(410).json({ error: 'challenge expired' })

    const cred = await dbOne<{ id: string; public_key: Buffer; counter: number; transports: string }>(`SELECT id, public_key, counter, transports FROM webauthn_credentials WHERE id = ? AND user_id = ?`,
      [response?.id, user.id])
    if (!cred) return void res.status(404).json({ error: 'credential not registered' })

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: (() => { try { return JSON.parse(cred.transports) } catch { return undefined } })(),
        },
        // H-1: 签名必须由 UV 通过的 authenticator 产生（user verified bit = 1）
        requireUserVerification: true,
      })
      if (!verification.verified) return void res.status(400).json({ error: 'signature failed' })
      // 更新 counter（防重放）
      await dbRun(`UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?`,
        [verification.authenticationInfo.newCounter, cred.id])
      await dbRun("UPDATE webauthn_challenges SET consumed_at = datetime('now') WHERE id = ?", [challenge_id])

      // 颁发短 token
      const token = generateId('wgt') + '_' + randomBytes(8).toString('hex')
      await dbRun(`INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,?)`,
        [token, user.id as string, ch.purpose, ch.purpose_data,
             new Date(Date.now() + gateTtlMs).toISOString()])
      res.json({ success: true, gate_token: token, expires_in_seconds: Math.floor(gateTtlMs / 1000) })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  // 列出 / 删除 credential
  app.get('/api/webauthn/credentials', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll(`SELECT id, device_label, transports, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`, [user.id])
    const required = !!user.webauthn_required_for_withdraw
    res.json({ credentials: rows, settings: { required_for_withdraw: required } })
  })

  app.delete('/api/webauthn/credentials/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // #1044 防"失窃 Passkey 不需 Passkey 即可删除"漏洞 — 删 passkey 自身要先用同一把(或同账号其它)passkey ceremony 拿 token
    // 验证 purpose_data.credential_id 必须等于路径 :id,避免"为删 A 拿到的 token 被复用去删 B"
    const hpCheck = requireHumanPresence(
      user.id as string, 'delete_passkey', (req.body || {}).webauthn_token,
      'require_human_presence_for_delete_passkey',
      (data) => {
        try { return typeof data === 'object' && data !== null && (data as Record<string, unknown>).credential_id === req.params.id } catch { return false }
      },
    )
    if (!hpCheck.ok) return void res.status(412).json({ error: hpCheck.reason, error_code: hpCheck.error_code })

    const r = await dbRun('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', [req.params.id, user.id])
    if (r.changes > 0) invalidateAgentRiskCacheForUser(user.id as string)  // 删到最后一把就丢真人身份,立刻反映到 D2b
    res.json({ success: true, deleted: r.changes })
  })

  app.post('/api/webauthn/settings', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const required = req.body?.required_for_withdraw ? 1 : 0
    // 开启前必须至少有 1 个 credential
    if (required) {
      const n = (await dbOne<{ n: number }>('SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?', [user.id]))!.n
      if (n === 0) return void res.status(400).json({ error: '请先注册至少一个 Passkey' })
    }
    await dbRun('UPDATE users SET webauthn_required_for_withdraw = ? WHERE id = ?', [required, user.id])
    res.json({ success: true, required_for_withdraw: !!required })
  })

  // RFC-020 PR-B — agent delegation grants (issue/read/revoke). Co-registered with the
  // Passkey security routes so the money-dense server.ts stays untouched. Safe scopes
  // only; risk scopes default-hard-reject. Reuses db/auth/generateId from WebauthnDeps.
  registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk, requireHumanPresence, createProductDraftHandler: deps.createProductDraftHandler, getProtocolParam: deps.getProtocolParam, createOrderLoopback: deps.createOrderLoopback, apiLoopback: deps.apiLoopback })
}
