/**
 * 验证员用户侧 API
 *
 * 由 #1013 Phase 46 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET  /api/verifier/eligibility        信誉资格
 *   GET  /api/verifier/status             状态 + 配额 + tier
 *   POST /api/verifier/apply              申请（仅 buyer，质押）
 *   POST /api/verifier/withdraw-application  撤回 pending
 *   POST /api/verifier/appeal             申诉处罚（30d 窗口，每处罚 1 次）
 *
 * 边界保留：
 *   - 仅 buyer 角色可申请（内部审核员由 admin 创建）
 *   - 30d 拒绝冷却
 *   - VERIFIER_STAKE_REQUIRED env 控制质押（默认 0）
 *   - appeal 必须在 suspended_until 期内，每次处罚仅可申诉 1 次（近 30 天）
 *
 * 留 server.ts：admin verifier-applications/whitelist/appeals 端点 + helpers
 *   (maybeAutoPromote / applyVerifierErrorPenalty 等深耦合 settleTask)
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam (dbRun: appeal single-write)

export interface VerifierUserDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  checkVerifierEligibility: (userId: string) => { eligible: boolean; items: unknown[] }
  getVerifierState: (userId: string) => Record<string, unknown>
  resetDailyQuotaIfNeeded: (userId: string) => void
  TIER_QUOTAS: Record<string, number>
  VERIFIER_STAKE_REQUIRED: number
  APP_REJECT_COOLDOWN_DAYS: number
}

export function registerVerifierUserRoutes(app: Application, deps: VerifierUserDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam;db 保留:apply/withdraw 是 stake 资金路径,
  // 状态翻转 + 钱包扣/退必须原子(db.transaction + CAS),Phase 3 迁 pg 行锁。
  const { db, generateId, auth, errorRes,
    checkVerifierEligibility, getVerifierState, resetDailyQuotaIfNeeded,
    TIER_QUOTAS, VERIFIER_STAKE_REQUIRED, APP_REJECT_COOLDOWN_DAYS,
  } = deps

  app.get('/api/verifier/eligibility', (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(checkVerifierEligibility(user.id as string))
  })

  app.get('/api/verifier/status', (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.id) resetDailyQuotaIfNeeded(user.id as string)
    const state = getVerifierState(user.id as string)
    const wl = state.whitelist as Record<string, unknown> | null
    const tier = wl?.tier as string | undefined
    const quota = tier ? TIER_QUOTAS[tier] : 0
    res.json({
      ...state,
      tier:          tier ?? null,
      daily_quota:   quota,
      tasks_today:   wl?.tasks_today ?? 0,
      remaining:     quota > 0 ? Math.max(0, quota - Number(wl?.tasks_today ?? 0)) : 0,
      is_system:     wl?.is_system === 1,
      stake_amount:  Number(wl?.stake_amount ?? 0),
    })
  })

  app.post('/api/verifier/apply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string

    // 外部审核员仅 buyer 角色（内部审核员由 admin 创建）
    if (user.role !== 'buyer') {
      return void errorRes(res, 403, 'ROLE_NOT_BUYER', '外部审核员仅 buyer 角色可申请（卖家 / 受信角色请联系管理员）')
    }

    const wl = await dbOne("SELECT 1 FROM verifier_whitelist WHERE user_id = ?", [userId])
    if (wl) return void res.json({ error: '你已经是审核员，无需重新申请' })

    const pending = await dbOne("SELECT 1 FROM verifier_applications WHERE user_id = ? AND status = 'pending'", [userId])
    if (pending) return void res.json({ error: '你已有待审申请' })

    // 30d 拒绝冷却
    const lastReject = await dbOne<{ reviewed_at: string }>(
      "SELECT reviewed_at FROM verifier_applications WHERE user_id = ? AND status = 'rejected' ORDER BY reviewed_at DESC LIMIT 1", [userId])
    if (lastReject?.reviewed_at) {
      const cooldownEnd = new Date(new Date(lastReject.reviewed_at).getTime() + APP_REJECT_COOLDOWN_DAYS * 86400_000)
      if (cooldownEnd > new Date()) {
        return void res.json({ error: `申请冷却期未结束，可在 ${cooldownEnd.toISOString().slice(0,10)} 后重新申请` })
      }
    }

    const elig = checkVerifierEligibility(userId)
    if (!elig.eligible) {
      return void res.json({ error: '信誉指标未达标', eligibility: elig })
    }

    // 友好预检查(读):真正的守恒门在事务内(WHERE balance >= stake)。
    if (VERIFIER_STAKE_REQUIRED > 0) {
      const wallet = await dbOne<{ balance: number }>("SELECT balance FROM wallets WHERE user_id = ?", [userId])
      if (!wallet || wallet.balance < VERIFIER_STAKE_REQUIRED) {
        return void res.json({ error: `质押需 ${VERIFIER_STAKE_REQUIRED} WAZ，钱包余额不足` })
      }
    }
    const appId = generateId('vapp')
    // stake 原子段:重检 whitelist/pending(防并发双申请双质押)+ 钱包扣减(守恒 guard)+ INSERT 申请
    try {
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM verifier_whitelist WHERE user_id = ?").get(userId)) throw new Error('VER_ALREADY')
        if (db.prepare("SELECT 1 FROM verifier_applications WHERE user_id = ? AND status = 'pending'").get(userId)) throw new Error('VER_PENDING')
        if (VERIFIER_STAKE_REQUIRED > 0) {
          const debit = db.prepare("UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?")
            .run(VERIFIER_STAKE_REQUIRED, VERIFIER_STAKE_REQUIRED, userId, VERIFIER_STAKE_REQUIRED)
          if (debit.changes === 0) throw new Error('VER_INSUFFICIENT')
        }
        db.prepare(`INSERT INTO verifier_applications (id, user_id, status, snapshot) VALUES (?,?,?,?)`)
          .run(appId, userId, 'pending', JSON.stringify(elig.items))
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'VER_ALREADY') return void res.json({ error: '你已经是审核员，无需重新申请' })
      if (msg === 'VER_PENDING') return void res.json({ error: '你已有待审申请' })
      if (msg === 'VER_INSUFFICIENT') return void res.json({ error: `质押需 ${VERIFIER_STAKE_REQUIRED} WAZ，钱包余额不足` })
      console.error('[verifier apply tx]', msg)
      return void res.status(500).json({ error: '申请失败,请重试' })
    }
    res.json({ success: true, stake_locked: VERIFIER_STAKE_REQUIRED })
  })

  app.post('/api/verifier/withdraw-application', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const pending = await dbOne<{ id: string }>("SELECT id FROM verifier_applications WHERE user_id = ? AND status = 'pending' LIMIT 1", [userId])
    if (!pending) return void res.json({ error: '没有待审申请' })
    // 原子段:CAS 翻转 pending→withdrawn(防并发/admin 抢跑双退)+ 退质押仅在本请求真翻转时
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE verifier_applications SET status = 'withdrawn', reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(pending.id)
        if (cas.changes === 0) throw new Error('VER_RACE')
        if (VERIFIER_STAKE_REQUIRED > 0) {
          db.prepare("UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?").run(VERIFIER_STAKE_REQUIRED, VERIFIER_STAKE_REQUIRED, userId)
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'VER_RACE') return void res.status(409).json({ error: '申请状态已变化,请刷新' })
      console.error('[verifier withdraw tx]', (e as Error).message)
      return void res.status(500).json({ error: '撤回失败,请重试' })
    }
    res.json({ success: true })
  })

  app.post('/api/verifier/appeal', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { task_id, submission_id, reason, evidence_urls } = req.body
    if (!reason?.trim()) return void res.json({ error: '请填写申诉理由' })
    if (reason.length > 500) return void res.json({ error: '申诉理由过长（>500 字）' })

    // 必须当前 suspended
    const stats = await dbOne<{ suspended_until: string | null }>("SELECT suspended_until FROM verifier_stats WHERE user_id = ?", [user.id])
    if (!stats?.suspended_until || new Date(stats.suspended_until).getTime() <= Date.now()) {
      return void res.json({ error: '当前未处于暂停状态，无需申诉' })
    }

    // 近 30 天有申诉过即重复
    const recent = await dbOne(`SELECT 1 FROM verifier_appeals WHERE user_id = ? AND created_at > datetime('now','-30 day')`, [user.id])
    if (recent) return void res.json({ error: '近期已申诉过，每次处罚只能申诉一次' })

    const evidenceArr = Array.isArray(evidence_urls) ? evidence_urls.slice(0, 3) : []
    await dbRun(`INSERT INTO verifier_appeals (id, user_id, task_id, submission_id, reason, evidence_urls)
                VALUES (?,?,?,?,?,?)`,
      [generateId('vapl'), user.id, task_id || null, submission_id || null, reason.trim(), JSON.stringify(evidenceArr)])
    res.json({ success: true })
  })
}
