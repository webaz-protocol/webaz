/**
 * 仲裁员申请域
 *
 * 由 #1013 Phase 44 从 src/pwa/server.ts 抽出。
 *
 * 7 endpoints (4 user + 3 admin):
 *   GET  /api/arbitrator/eligibility                       检查信誉资格
 *   GET  /api/arbitrator/status                            当前状态（whitelist / pending / rejected）
 *   POST /api/arbitrator/apply                             申请（仅 buyer，质押 ARB_STAKE_REQUIRED）
 *   POST /api/arbitrator/withdraw-application              撤回 pending 申请
 *   GET  /api/admin/arbitrator-applications                admin 列表
 *   POST /api/admin/arbitrator-applications/:id/approve    admin 批准（入 arbitrator_whitelist）
 *   POST /api/admin/arbitrator-applications/:id/reject     admin 拒绝（退质押）
 *
 * 边界保留：
 *   - 申请仅 buyer 角色（卖家 / 受信角色请联系 admin）
 *   - 重复申请 / 已批准 → 拒
 *   - 拒绝冷却期 60d
 *   - 质押 ARB_STAKE_REQUIRED（env，默认 0）→ 通过转 whitelist / 撤回 / 拒绝时退还
 *
 * 留 server.ts：isEligibleArbitrator（disputes 流程跨域使用）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { grantArbitrator, suspendArbitrator, reinstateArbitrator, revokeArbitrator, listArbitrators, type ArbMutation } from '../arbitrator-lifecycle.js'  // PR-B 生产仲裁员生命周期域逻辑

export interface ArbitratorDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireArbitrationAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  checkArbitratorEligibility: (userId: string) => { eligible: boolean; items: unknown[] }
  getArbitratorState: (userId: string) => unknown
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  ARB_STAKE_REQUIRED: number
  ARB_APP_REJECT_COOLDOWN_DAYS: number
}

export function registerArbitratorRoutes(app: Application, deps: ArbitratorDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam;db 保留:apply/withdraw/approve/reject 是
  // stake 资金路径,状态翻转 + 钱包扣/退必须原子(db.transaction + CAS),Phase 3 迁 pg 行锁。
  const {
    db, generateId, auth, requireArbitrationAdmin,
    checkArbitratorEligibility, getArbitratorState, errorRes, logAdminAction, consumeGateToken,
    ARB_STAKE_REQUIRED, ARB_APP_REJECT_COOLDOWN_DAYS,
  } = deps

  // ── PR-B:生产仲裁员生命周期(grant/suspend/reinstate/revoke)。门(四端点共用):ROOT/admin auth +
  //   现场真人 Passkey(purpose 绑动作 + purpose_data.user_id 绑目标,杜绝跨动作/跨目标复用)+ admin_audit_log(含失败留痕)。
  //   域逻辑(active-only 授权源 / revoked 终态 / 拒非人类)在 arbitrator-lifecycle.ts;此处只做 auth + Passkey + 审计。
  const arbLifecycle = (action: 'grant' | 'suspend' | 'reinstate' | 'revoke', purpose: string,
    fn: (userId: string, adminId: string, note?: string | null) => ArbMutation) =>
    (req: Request, res: Response): void => {
      const admin = requireArbitrationAdmin(req, res); if (!admin) return
      const userId = String((action === 'grant' ? req.body?.user_id : req.params.user_id) || '')
      const note = (req.body?.note ?? null) as string | null
      if (!userId) return void errorRes(res, 400, 'MISSING_USER_ID', '缺少目标 user_id')
      const gate = consumeGateToken(admin.id as string, req.body?.webauthn_token as string | undefined, purpose, (d) => (d as { user_id?: string } | null)?.user_id === userId)
      if (!gate.ok) {
        logAdminAction(admin.id as string, `arbitrator.${action}`, 'user', userId, { ok: false, gate: gate.reason })  // ROOT 尝试也留痕(purpose 不符/无 token)
        return void errorRes(res, 412, 'HUMAN_PRESENCE_REQUIRED', gate.reason || '此操作需现场真人 Passkey 确认')
      }
      const r = fn(userId, admin.id as string, note)
      logAdminAction(admin.id as string, `arbitrator.${action}`, 'user', userId, { ok: r.ok, error_code: r.error_code, note })
      if (!r.ok) return void errorRes(res, 409, r.error_code || 'ARB_MUTATION_FAILED', r.error || '操作失败')
      res.json({ success: true, user_id: userId, action })
    }

  app.post('/api/admin/arbitrators/grant', arbLifecycle('grant', 'arbitrator_grant', (userId, adminId, note) => grantArbitrator(db, { userId, grantedBy: adminId, note })))
  app.post('/api/admin/arbitrators/:user_id/suspend', arbLifecycle('suspend', 'arbitrator_suspend', (userId, _a, note) => suspendArbitrator(db, { userId, note })))
  app.post('/api/admin/arbitrators/:user_id/reinstate', arbLifecycle('reinstate', 'arbitrator_reinstate', (userId, _a, note) => reinstateArbitrator(db, { userId, note })))
  app.post('/api/admin/arbitrators/:user_id/revoke', arbLifecycle('revoke', 'arbitrator_revoke', (userId, _a, note) => revokeArbitrator(db, { userId, note })))

  // 名册(admin 只读,无需 Passkey)。含 active/suspended/revoked 全量 + 状态。
  app.get('/api/admin/arbitrators', (req, res) => {
    const admin = requireArbitrationAdmin(req, res); if (!admin) return
    res.json({ arbitrators: listArbitrators(db) })
  })

  app.get('/api/arbitrator/eligibility', (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(checkArbitratorEligibility(user.id as string))
  })

  app.get('/api/arbitrator/status', (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(getArbitratorState(user.id as string))
  })

  app.post('/api/arbitrator/apply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'buyer') {
      return void errorRes(res, 403, 'ROLE_NOT_BUYER', '外部仲裁员仅 buyer 角色可申请（卖家 / 受信角色请联系管理员）')
    }
    const userId = user.id as string
    const wl = await dbOne("SELECT 1 FROM arbitrator_whitelist WHERE user_id = ?", [userId])
    if (wl) return void res.json({ error: '你已经是仲裁员，无需重新申请' })
    const pending = await dbOne("SELECT 1 FROM arbitrator_applications WHERE user_id = ? AND status = 'pending'", [userId])
    if (pending) return void res.json({ error: '你已有待审申请' })
    const lastReject = await dbOne<{ reviewed_at: string }>("SELECT reviewed_at FROM arbitrator_applications WHERE user_id = ? AND status = 'rejected' ORDER BY reviewed_at DESC LIMIT 1", [userId])
    if (lastReject?.reviewed_at) {
      const cooldownEnd = new Date(new Date(lastReject.reviewed_at).getTime() + ARB_APP_REJECT_COOLDOWN_DAYS * 86400_000)
      if (cooldownEnd > new Date()) {
        return void res.json({ error: `申请冷却期未结束，可在 ${cooldownEnd.toISOString().slice(0,10)} 后重新申请` })
      }
    }
    const elig = checkArbitratorEligibility(userId)
    if (!elig.eligible) return void res.json({ error: '信誉指标未达标', eligibility: elig })
    // 友好预检查(读):真正的守恒门在事务内(WHERE balance >= stake)。
    if (ARB_STAKE_REQUIRED > 0) {
      const wallet = await dbOne<{ balance: number }>("SELECT balance FROM wallets WHERE user_id = ?", [userId])
      if (!wallet || wallet.balance < ARB_STAKE_REQUIRED) {
        return void res.json({ error: `质押需 ${ARB_STAKE_REQUIRED} WAZ，钱包余额不足` })
      }
    }
    const appId = generateId('aapp')
    // stake 原子段:重检 whitelist/pending(防并发双申请双质押)+ 钱包扣减(守恒 guard)+ INSERT 申请
    try {
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM arbitrator_whitelist WHERE user_id = ?").get(userId)) throw new Error('ARB_ALREADY')
        if (db.prepare("SELECT 1 FROM arbitrator_applications WHERE user_id = ? AND status = 'pending'").get(userId)) throw new Error('ARB_PENDING')
        if (ARB_STAKE_REQUIRED > 0) {
          const debit = db.prepare("UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?")
            .run(ARB_STAKE_REQUIRED, ARB_STAKE_REQUIRED, userId, ARB_STAKE_REQUIRED)
          if (debit.changes === 0) throw new Error('ARB_INSUFFICIENT')
        }
        db.prepare("INSERT INTO arbitrator_applications (id, user_id, status, snapshot) VALUES (?,?,?,?)")
          .run(appId, userId, 'pending', JSON.stringify(elig.items))
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'ARB_ALREADY') return void res.json({ error: '你已经是仲裁员，无需重新申请' })
      if (msg === 'ARB_PENDING') return void res.json({ error: '你已有待审申请' })
      if (msg === 'ARB_INSUFFICIENT') return void res.json({ error: `质押需 ${ARB_STAKE_REQUIRED} WAZ，钱包余额不足` })
      console.error('[arbitrator apply tx]', msg)
      return void res.status(500).json({ error: '申请失败,请重试' })
    }
    res.json({ success: true, stake_locked: ARB_STAKE_REQUIRED })
  })

  app.post('/api/arbitrator/withdraw-application', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const pending = await dbOne<{ id: string }>("SELECT id FROM arbitrator_applications WHERE user_id = ? AND status = 'pending' LIMIT 1", [userId])
    if (!pending) return void res.json({ error: '没有待审申请' })
    // 原子段:CAS 翻转 pending→withdrawn(防并发/admin 抢跑双退)+ 退质押仅在本请求真翻转时
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE arbitrator_applications SET status='withdrawn', reviewed_at=datetime('now') WHERE id = ? AND status = 'pending'").run(pending.id)
        if (cas.changes === 0) throw new Error('ARB_RACE')
        if (ARB_STAKE_REQUIRED > 0) {
          db.prepare("UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?").run(ARB_STAKE_REQUIRED, ARB_STAKE_REQUIRED, userId)
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'ARB_RACE') return void res.status(409).json({ error: '申请状态已变化,请刷新' })
      console.error('[arbitrator withdraw tx]', (e as Error).message)
      return void res.status(500).json({ error: '撤回失败,请重试' })
    }
    res.json({ success: true })
  })

  // Admin
  app.get('/api/admin/arbitrator-applications', async (req, res) => {
    const admin = requireArbitrationAdmin(req, res); if (!admin) return
    const status = String(req.query.status || 'pending')
    const items = await dbAll(`
      SELECT aa.*, u.name as user_name, u.handle, u.region
      FROM arbitrator_applications aa
      JOIN users u ON u.id = aa.user_id
      WHERE aa.status = ?
      ORDER BY aa.applied_at DESC LIMIT 100
    `, [status])
    res.json({ items })
  })

  app.post('/api/admin/arbitrator-applications/:id/approve', async (req, res) => {
    const admin = requireArbitrationAdmin(req, res); if (!admin) return
    const { note } = req.body
    const appRow = await dbOne<{ id: string; user_id: string; status: string }>("SELECT id, user_id, status FROM arbitrator_applications WHERE id = ?", [req.params.id])
    if (!appRow) return void res.json({ error: '申请不存在' })
    if (appRow.status !== 'pending') return void res.json({ error: '该申请不在待审状态' })
    // 原子段:CAS 翻转 pending→approved + 入白名单仅在本请求真翻转时(防并发双批准)
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE arbitrator_applications SET status='approved', reviewed_at=datetime('now'), reviewed_by=?, decision_note=? WHERE id=? AND status='pending'")
          .run(admin.id, note || null, appRow.id)
        if (cas.changes === 0) throw new Error('ARB_RACE')
        db.prepare(`INSERT OR REPLACE INTO arbitrator_whitelist (user_id, note, is_system, granted_by, stake_amount) VALUES (?,?,0,?,?)`)
          .run(appRow.user_id, note || '外部仲裁员批准', admin.id, ARB_STAKE_REQUIRED)
      })()
    } catch (e) {
      if ((e as Error).message === 'ARB_RACE') return void res.json({ error: '该申请不在待审状态' })
      console.error('[arbitrator approve tx]', (e as Error).message)
      return void res.status(500).json({ error: '批准失败,请重试' })
    }
    logAdminAction(admin.id as string, 'approve_arbitrator', 'user', appRow.user_id, { note })
    res.json({ success: true })
  })

  app.post('/api/admin/arbitrator-applications/:id/reject', async (req, res) => {
    const admin = requireArbitrationAdmin(req, res); if (!admin) return
    const { note } = req.body
    const appRow = await dbOne<{ id: string; user_id: string; status: string }>("SELECT id, user_id, status FROM arbitrator_applications WHERE id = ?", [req.params.id])
    if (!appRow) return void res.json({ error: '申请不存在' })
    if (appRow.status !== 'pending') return void res.json({ error: '该申请不在待审状态' })
    // 原子段:CAS 翻转 pending→rejected + 退质押仅在本请求真翻转时(防并发双拒双退)
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE arbitrator_applications SET status='rejected', reviewed_at=datetime('now'), reviewed_by=?, decision_note=? WHERE id=? AND status='pending'")
          .run(admin.id, note || null, appRow.id)
        if (cas.changes === 0) throw new Error('ARB_RACE')
        if (ARB_STAKE_REQUIRED > 0) {
          db.prepare("UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?").run(ARB_STAKE_REQUIRED, ARB_STAKE_REQUIRED, appRow.user_id)
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'ARB_RACE') return void res.json({ error: '该申请不在待审状态' })
      console.error('[arbitrator reject tx]', (e as Error).message)
      return void res.status(500).json({ error: '拒绝失败,请重试' })
    }
    logAdminAction(admin.id as string, 'reject_arbitrator', 'user', appRow.user_id, { note })
    res.json({ success: true })
  })
}
