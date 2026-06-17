/**
 * Admin: Verifier 申请 + 申诉处理
 *
 * 由 #1013 Phase 64 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET  /api/admin/verifier-applications           待审申请列表
 *   POST /api/admin/verifier-applications/:id/approve  批准 → 加白名单 + 设置 tier/quota
 *   POST /api/admin/verifier-applications/:id/reject   拒绝 → 退质押
 *   GET  /api/admin/verifier-appeals                待处理申诉列表
 *   POST /api/admin/verifier-appeals/:id/decide     裁决 accept/reject（accept → 解封 + 重审 verdict）
 *
 * 权限：verifier_mgmt
 *
 * 跨域注入：requireVerifierMgmtAdmin + TIER_QUOTAS + VERIFIER_STAKE_REQUIRED + todayStartISO + logAdminAction
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminVerifierFlowDeps {
  db: Database.Database
  requireVerifierMgmtAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  TIER_QUOTAS: Record<string, number>
  VERIFIER_STAKE_REQUIRED: number
  todayStartISO: () => string
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminVerifierFlowRoutes(app: Application, deps: AdminVerifierFlowDeps): void {
  // 只读站点走 RFC-016 异步 seam;db 保留:approve/reject/decide 含状态翻转 + 退质押 + 补发奖励,
  // 必须原子(db.transaction + CAS 翻转,退款/奖励仅在本请求真翻转时落),Phase 3 迁 pg 行锁。
  const { db, requireVerifierMgmtAdmin, TIER_QUOTAS, VERIFIER_STAKE_REQUIRED, todayStartISO, logAdminAction } = deps

  app.get('/api/admin/verifier-applications', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const status = (req.query.status as string) || 'pending'
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT va.id, va.user_id, va.status, va.applied_at, va.reviewed_at, va.reviewed_by, va.decision_note, va.snapshot,
             u.name as user_name, u.email
      FROM verifier_applications va
      LEFT JOIN users u ON u.id = va.user_id
      WHERE va.status = ?
      ORDER BY va.applied_at DESC LIMIT 100
    `, [status])
    res.json({
      applications: rows.map(r => ({
        ...r,
        snapshot: r.snapshot ? (() => { try { return JSON.parse(r.snapshot as string) } catch { return r.snapshot } })() : null,
      })),
    })
  })

  app.post('/api/admin/verifier-applications/:id/approve', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const { tier, note } = req.body
    const validTier = ['trial-1', 'trial-2', 'trial-3', 'active-1', 'active-2'].includes(tier) ? tier : 'trial-1'
    const apl = await dbOne<{ id: string; user_id: string; status: string }>("SELECT id, user_id, status FROM verifier_applications WHERE id = ?", [req.params.id])
    if (!apl) return void res.json({ error: '申请不存在' })
    if (apl.status !== 'pending') return void res.json({ error: '该申请不在待审状态' })

    // 原子段:CAS 翻转 pending→approved + 入白名单 + 建 stats(防并发双批准)
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE verifier_applications SET status='approved', reviewed_at=datetime('now'), reviewed_by=?, decision_note=? WHERE id=? AND status='pending'")
          .run(admin.id, note || null, apl.id)
        if (cas.changes === 0) throw new Error('APP_RACE')
        db.prepare(`INSERT OR REPLACE INTO verifier_whitelist
                    (user_id, note, tier, daily_quota, tasks_today, quota_reset_at, granted_by, stake_amount, is_system)
                    VALUES (?,?,?,?,0,?,?,?,0)`)
          .run(apl.user_id, note || `批准为 ${validTier}`, validTier, TIER_QUOTAS[validTier], todayStartISO(), admin.id, VERIFIER_STAKE_REQUIRED)
        db.prepare("INSERT OR IGNORE INTO verifier_stats (user_id) VALUES (?)").run(apl.user_id)
      })()
    } catch (e) {
      if ((e as Error).message === 'APP_RACE') return void res.json({ error: '该申请不在待审状态' })
      console.error('[verifier approve tx]', (e as Error).message)
      return void res.status(500).json({ error: '批准失败,请重试' })
    }
    logAdminAction(admin.id as string, 'approve_verifier', 'user', apl.user_id, { tier: validTier, note })
    res.json({ success: true })
  })

  app.post('/api/admin/verifier-applications/:id/reject', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const { note } = req.body
    const apl = await dbOne<{ id: string; user_id: string; status: string }>("SELECT id, user_id, status FROM verifier_applications WHERE id = ?", [req.params.id])
    if (!apl) return void res.json({ error: '申请不存在' })
    if (apl.status !== 'pending') return void res.json({ error: '该申请不在待审状态' })

    // 原子段:CAS 翻转 pending→rejected + 退质押仅在本请求真翻转时(防并发双拒双退)
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE verifier_applications SET status='rejected', reviewed_at=datetime('now'), reviewed_by=?, decision_note=? WHERE id=? AND status='pending'")
          .run(admin.id, note || null, apl.id)
        if (cas.changes === 0) throw new Error('APP_RACE')
        if (VERIFIER_STAKE_REQUIRED > 0) {
          db.prepare("UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?").run(VERIFIER_STAKE_REQUIRED, VERIFIER_STAKE_REQUIRED, apl.user_id)
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'APP_RACE') return void res.json({ error: '该申请不在待审状态' })
      console.error('[verifier reject tx]', (e as Error).message)
      return void res.status(500).json({ error: '拒绝失败,请重试' })
    }
    logAdminAction(admin.id as string, 'reject_verifier', 'user', apl.user_id, { note })
    res.json({ success: true })
  })

  app.get('/api/admin/verifier-appeals', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const status = (req.query.status as string) || 'pending'
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT va.id, va.user_id, va.task_id, va.submission_id, va.reason, va.evidence_urls, va.status,
             va.admin_note, va.reviewed_by, va.reviewed_at, va.created_at, u.name as user_name
      FROM verifier_appeals va LEFT JOIN users u ON u.id = va.user_id
      WHERE va.status = ?
      ORDER BY va.created_at DESC LIMIT 100
    `, [status])
    res.json({
      appeals: rows.map(r => ({
        ...r,
        evidence_urls: r.evidence_urls ? (() => { try { return JSON.parse(r.evidence_urls as string) } catch { return [] } })() : [],
      })),
    })
  })

  app.post('/api/admin/verifier-appeals/:id/decide', async (req, res) => {
    const admin = requireVerifierMgmtAdmin(req, res); if (!admin) return
    const { decision, note } = req.body  // 'accepted' | 'rejected'
    if (!['accepted', 'rejected'].includes(decision)) return void res.json({ error: 'decision 无效' })
    const appeal = await dbOne<{ id: string; user_id: string; status: string }>("SELECT id, user_id, status FROM verifier_appeals WHERE id = ?", [req.params.id])
    if (!appeal) return void res.json({ error: '申诉不存在' })
    if (appeal.status !== 'pending') return void res.json({ error: '该申诉已处理' })

    // 原子段:CAS 翻转 appeal pending→decision + (accepted 时)解封/重审/补发奖励 一起落,
    // 防并发双裁决导致 verify_rights 多加、verdict 多翻、奖励多发。
    try {
      db.transaction(() => {
        const cas = db.prepare("UPDATE verifier_appeals SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'")
          .run(decision, note || null, admin.id, appeal.id)
        if (cas.changes === 0) throw new Error('APPEAL_RACE')
        if (decision === 'accepted') {
          // 解封 + 验证权 +2 + 错误次数 -1
          db.prepare("UPDATE verifier_stats SET suspended_until = NULL, verify_rights = verify_rights + 2 WHERE user_id = ?").run(appeal.user_id)
          db.prepare("UPDATE verifier_whitelist SET error_count_180d = MAX(0, error_count_180d - 1) WHERE user_id = ?").run(appeal.user_id)
          // 完整重审：翻转该 verifier 在该 task 的 verdict + 补发奖励 + 翻回 stats
          const fullAppeal = db.prepare("SELECT task_id FROM verifier_appeals WHERE id = ?").get(appeal.id) as { task_id: string | null } | undefined
          if (fullAppeal?.task_id) {
            const sub = db.prepare("SELECT vs.id, vs.verdict, vt.reward_per_verifier FROM verify_submissions vs JOIN verify_tasks vt ON vt.id = vs.task_id WHERE vs.task_id = ? AND vs.verifier_id = ?")
              .get(fullAppeal.task_id, appeal.user_id) as { id: string; verdict: string | null; reward_per_verifier: number } | undefined
            if (sub && sub.verdict === 'wrong') {
              db.prepare("UPDATE verify_submissions SET verdict = 'correct' WHERE id = ?").run(sub.id)
              db.prepare("UPDATE verifier_stats SET tasks_correct = tasks_correct + 1, tasks_wrong = MAX(0, tasks_wrong - 1), verify_rights = verify_rights + 3 WHERE user_id = ?").run(appeal.user_id)
              db.prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = ?").run(sub.reward_per_verifier, appeal.user_id)
            }
          }
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'APPEAL_RACE') return void res.json({ error: '该申诉已处理' })
      console.error('[verifier appeal decide tx]', (e as Error).message)
      return void res.status(500).json({ error: '裁决失败,请重试' })
    }
    logAdminAction(admin.id as string, 'decide_appeal', 'user', appeal.user_id, { decision, note: note || null })
    res.json({ success: true })
  })
}
