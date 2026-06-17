/**
 * RFC-002 §3.2 / §3.3 — rewards opt-in apply/deactivate endpoints (PR-2a)
 *
 *   POST /api/rewards/apply       — activate rewards_opted_in + drain escrow
 *   POST /api/rewards/deactivate  — flip off; future commissions go to commission_reserve (protocol pool), not charity
 *   GET  /api/rewards/status      — current state + escrow tally
 *
 * Anti-induction (apply only): client must include `page_loaded_at` (ms epoch)
 * matching the moment the disclosure page rendered. Server enforces:
 *   now - page_loaded_at >= rewards_opt_in.consent_delay_seconds * 1000
 * `consent_hash` reconstructed from
 *   sha256('rewards_apply|consent_version|user|page_loaded_at')
 * and compared to what client submitted (defense against 16-char-bypass).
 *
 * Pre-checks (apply):
 *   - users.rewards_opted_in MUST be 0
 *   - completed_orders >= rewards_opt_in.min_completed_orders
 *   - Passkey gate token from purpose='rewards_apply'
 *
 * Atomicity (apply): wraps in db.transaction:
 *   - INSERT rewards_applications row (action='activate', consent_version, hash)
 *   - UPDATE users SET rewards_opted_in = 1
 *   - Activate batch settle: SELECT pending escrow rows → credit wallets → mark settled
 *
 * Pre-checks (deactivate):
 *   - users.rewards_opted_in MUST be 1
 *   - Passkey gate token from purpose='rewards_deactivate'
 *   - No 8s delay (closing should be friction-light, anti-induction not applicable)
 *
 * Spec: docs/rfcs/RFC-002-rewards-opt-in.md §3.3 + §3.7 (closure path)
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // 真实成交单一真相源

export interface RewardsApplyDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  getProtocolParam: <T>(key: string, fallback: T) => T
}

function sha256_hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function registerRewardsApplyRoutes(app: Application, deps: RewardsApplyDeps): void {
  const { db, auth, errorRes, consumeGateToken, getProtocolParam } = deps

  function expectedApplyConsentHash(userId: string, consentVersion: string, pageLoadedAt: number): string {
    return sha256_hex(`rewards_apply|consent_version=${consentVersion}|user=${userId}|page_loaded_at=${pageLoadedAt}`)
  }

  // GET /api/rewards/status — current state + escrow tally
  app.get('/api/rewards/status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string

    const optIn = (await dbOne<{ rewards_opted_in: number }>("SELECT rewards_opted_in FROM users WHERE id = ?", [userId]))?.rewards_opted_in ?? 0
    const lastAction = (await dbOne<{ action: string; created_at: number }>("SELECT action, created_at FROM rewards_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", [userId]))
    const currentMajor = await dbOne<{ version: string; hash: string; change_class: string; effective_at: number; text_zh: string; text_en: string }>("SELECT version, hash, change_class, effective_at, text_zh, text_en FROM rewards_consent_texts WHERE change_class='major' ORDER BY effective_at DESC LIMIT 1", [])

    let state: 'opted_in' | 'never_activated' | 'auto_downgraded' | 'deactivated'
    if (optIn === 1) state = 'opted_in'
    else if (lastAction?.action === 'deactivate') state = 'deactivated'
    else if (lastAction?.action === 'auto_downgrade') state = 'auto_downgraded'
    else state = 'never_activated'

    const completedOrders = (await dbOne<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [userId]))!.n  // 真实成交,排除退款/违约
    const passkeyCount = (await dbOne<{ n: number }>("SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?", [userId]))!.n

    const minOrders = Number(getProtocolParam<number>('rewards_opt_in.min_completed_orders', 1))
    const requirePasskey = Number(getProtocolParam<number>('rewards_opt_in.require_passkey', 1))
    const delaySec = Number(getProtocolParam<number>('rewards_opt_in.consent_delay_seconds', 8))

    const missing: string[] = []
    if (completedOrders < minOrders) missing.push(`completed_orders ${completedOrders}/${minOrders}`)
    if (requirePasskey === 1 && passkeyCount === 0) missing.push('passkey_not_registered')

    const pending = (await dbOne<{ n: number; total: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM pending_commission_escrow WHERE recipient_user_id = ? AND status = 'pending'", [userId]))!
    const expired = (await dbOne<{ n: number; total: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM pending_commission_escrow WHERE recipient_user_id = ? AND status = 'expired'", [userId]))!

    res.json({
      state,
      opted_in: optIn === 1,
      consent_version: currentMajor?.version || null,
      consent_hash: currentMajor?.hash || null,
      consent_effective_at: currentMajor?.effective_at || null,
      consent_text_zh: currentMajor?.text_zh || null,
      consent_text_en: currentMajor?.text_en || null,
      eligibility: {
        completed_orders: completedOrders,
        min_completed_orders: minOrders,
        passkey_count: passkeyCount,
        require_passkey: requirePasskey === 1,
        consent_delay_seconds: delaySec,
        missing,
        can_apply: optIn === 0 && missing.length === 0,
      },
      pending_escrow: { count: pending.n, total_amount: pending.total },
      expired_to_charity: { count: expired.n, total_amount: expired.total },
      last_action: lastAction ? { action: lastAction.action, at: lastAction.created_at } : null,
    })
  })

  // POST /api/rewards/apply — activate (or reconfirm) opt-in + drain escrow
  app.post('/api/rewards/apply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const consent_version = String(body.consent_version || '')
    const consent_hash = String(body.consent_hash || '')
    const page_loaded_at = Number(body.page_loaded_at || 0)
    const webauthn_token = body.webauthn_token ? String(body.webauthn_token) : undefined

    // 1. Verify currently opted-out
    const optIn = (await dbOne<{ rewards_opted_in: number }>("SELECT rewards_opted_in FROM users WHERE id = ?", [userId]))?.rewards_opted_in ?? 0
    if (optIn === 1) return void errorRes(res, 409, 'ALREADY_OPTED_IN', '已 opted-in,无需重复申请')

    // 2. Verify consent version matches current major
    const currentMajor = await dbOne<{ version: string; hash: string }>("SELECT version, hash FROM rewards_consent_texts WHERE change_class='major' ORDER BY effective_at DESC LIMIT 1", [])
    if (!currentMajor) return void errorRes(res, 500, 'NO_CONSENT_TEXT', 'rewards_consent_texts 未 seed,无法申请')
    if (consent_version !== currentMajor.version) {
      return void errorRes(res, 400, 'STALE_CONSENT_VERSION', `请重新加载披露页 — current=${currentMajor.version}, you sent=${consent_version}`)
    }

    // 3. Anti-induction 8s delay (with upper bound to defeat page_loaded_at=1 bypass)
    const delaySec = Number(getProtocolParam<number>('rewards_opt_in.consent_delay_seconds', 8))
    const minDelayMs = delaySec * 1000
    const maxDelayMs = 60 * 60 * 1000  // 1h — session shouldn't be older than this
    if (page_loaded_at <= 0) return void errorRes(res, 400, 'MISSING_PAGE_LOADED_AT', 'page_loaded_at 缺失(反诱导校验)')
    const elapsedMs = Date.now() - page_loaded_at
    if (elapsedMs < minDelayMs) {
      const waitSec = Math.ceil((minDelayMs - elapsedMs) / 1000)
      return void errorRes(res, 400, 'ANTI_INDUCTION_DELAY', `必须等待 ${waitSec}s 后才能提交(反诱导)`)
    }
    if (elapsedMs > maxDelayMs) {
      return void errorRes(res, 400, 'STALE_PAGE_LOAD', '披露页过期(> 1h),请重新加载')
    }

    // 4. Verify consent_hash reconstructed from server-known fields
    const expectedHash = expectedApplyConsentHash(userId, consent_version, page_loaded_at)
    if (consent_hash !== expectedHash) {
      return void errorRes(res, 400, 'BAD_CONSENT_HASH', 'consent_hash 不匹配 — 请重新加载披露页')
    }

    // 5. Pre-conditions (re-check inside server)
    const minOrders = Number(getProtocolParam<number>('rewards_opt_in.min_completed_orders', 1))
    const completedOrders = (await dbOne<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [userId]))!.n  // 真实成交,排除退款/违约
    if (completedOrders < minOrders) return void errorRes(res, 403, 'INSUFFICIENT_ORDERS', `需 ${minOrders} 笔已完成订单,目前 ${completedOrders}`)

    const requirePasskey = Number(getProtocolParam<number>('rewards_opt_in.require_passkey', 1))
    const passkeyCount = (await dbOne<{ n: number }>("SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?", [userId]))!.n
    if (requirePasskey === 1 && passkeyCount === 0) return void errorRes(res, 403, 'PASSKEY_REQUIRED', '需先注册 Passkey')

    // 6. Atomic: consume Passkey gate + insert audit + flip flag + drain escrow → wallet
    // consumeGateToken is moved INSIDE the transaction so a downstream rollback
    // also rolls back the consumed_at mark (user can retry without re-doing Passkey).
    let drained = { count: 0, total: 0 }
    let raceLost = false
    let gateFailReason: string | null = null
    try {
      db.transaction(() => {
        if (requirePasskey === 1) {
          const gate = consumeGateToken(userId, webauthn_token, 'rewards_apply', () => true)
          if (!gate.ok) { gateFailReason = gate.reason || 'Passkey 验证失败'; throw new Error('gate_failed') }
        }

        const now = Date.now()
        // Race guard: flip flag only if still 0. Concurrent tabs / replay would
        // see changes=0 here and roll back the whole transaction.
        const flip = db.prepare("UPDATE users SET rewards_opted_in = 1 WHERE id = ? AND rewards_opted_in = 0").run(userId)
        if (flip.changes === 0) { raceLost = true; throw new Error('race_lost') }

        db.prepare(`INSERT INTO rewards_applications (user_id, action, consent_version, consent_hash, passkey_sig, verification_method, ip_hash, ua_hash, created_at)
                    VALUES (?, 'activate', ?, ?, ?, ?, ?, ?, ?)`)
          .run(userId, consent_version, currentMajor.hash,
               webauthn_token || null,  // store gate_token id as audit cross-ref to webauthn_gate_tokens
               requirePasskey === 1 ? 'passkey' : 'password',
               sha256_hex(req.ip || '').slice(0, 16),
               sha256_hex(String(req.headers['user-agent'] || '')).slice(0, 16),
               now)

        // Activate batch settle: drain pending escrow to wallet
        const pending = db.prepare(`SELECT id, amount, attribution_path FROM pending_commission_escrow
                                    WHERE recipient_user_id = ? AND status = 'pending' AND expires_at > ?`).all(userId, now) as Array<{ id: number; amount: number; attribution_path: string }>
        let total = 0
        for (const p of pending) {
          const upd = db.prepare(`UPDATE pending_commission_escrow SET status='settled', settled_at=? WHERE id=? AND status='pending'`).run(now, p.id)
          if (upd.changes === 0) continue  // race: expire cron took it
          db.prepare(`UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?`).run(p.amount, p.amount, userId)
          // #1106：pv_pair escrow 的钱在结算时已从 pool 移入 pv_escrow_reserve，兑付从 reserve 出。
          // L1/L2/L3 commission escrow 的钱在下单结算时已从 seller 扣（不在任何池），兑付无需动池/reserve。
          if (p.attribution_path === 'pv_pair') {
            db.prepare(`UPDATE global_fund SET pv_escrow_reserve = pv_escrow_reserve - ? WHERE id = 1`).run(p.amount)
          }
          total += p.amount
        }
        drained = { count: pending.length, total: Math.round(total * 100) / 100 }
      })()
    } catch (e) {
      if (gateFailReason) return void errorRes(res, 403, 'PASSKEY_GATE_FAILED', gateFailReason)
      if (raceLost) return void errorRes(res, 409, 'CONCURRENT_APPLY', '已被另一并发请求 opt-in,无需重复')
      return void errorRes(res, 500, 'APPLY_FAILED', (e as Error).message)
    }

    res.json({ ok: true, state: 'opted_in', drained_from_escrow: drained })
  })

  // POST /api/rewards/deactivate — flip off; subsequent commissions → charity
  app.post('/api/rewards/deactivate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const webauthn_token = body.webauthn_token ? String(body.webauthn_token) : undefined

    const optIn = (await dbOne<{ rewards_opted_in: number }>("SELECT rewards_opted_in FROM users WHERE id = ?", [userId]))?.rewards_opted_in ?? 0
    if (optIn === 0) return void errorRes(res, 409, 'ALREADY_OPTED_OUT', '本来就未 opted-in,无需关闭')

    const requirePasskey = Number(getProtocolParam<number>('rewards_opt_in.require_passkey', 1))

    let raceLost = false
    let gateFailReason: string | null = null
    try {
      db.transaction(() => {
        if (requirePasskey === 1) {
          const gate = consumeGateToken(userId, webauthn_token, 'rewards_deactivate', () => true)
          if (!gate.ok) { gateFailReason = gate.reason || 'Passkey 验证失败'; throw new Error('gate_failed') }
        }

        const now = Date.now()
        const flip = db.prepare("UPDATE users SET rewards_opted_in = 0 WHERE id = ? AND rewards_opted_in = 1").run(userId)
        if (flip.changes === 0) { raceLost = true; throw new Error('race_lost') }

        db.prepare(`INSERT INTO rewards_applications (user_id, action, passkey_sig, verification_method, ip_hash, ua_hash, created_at)
                    VALUES (?, 'deactivate', ?, ?, ?, ?, ?)`)
          .run(userId,
               webauthn_token || null,
               requirePasskey === 1 ? 'passkey' : 'password',
               sha256_hex(req.ip || '').slice(0, 16),
               sha256_hex(String(req.headers['user-agent'] || '')).slice(0, 16),
               now)
      })()
    } catch (e) {
      if (gateFailReason) return void errorRes(res, 403, 'PASSKEY_GATE_FAILED', gateFailReason)
      if (raceLost) return void errorRes(res, 409, 'CONCURRENT_DEACTIVATE', '已被另一并发请求 opt-out')
      return void errorRes(res, 500, 'DEACTIVATE_FAILED', (e as Error).message)
    }

    res.json({ ok: true, state: 'deactivated' })
  })
}
