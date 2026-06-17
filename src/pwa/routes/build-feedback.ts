/**
 * build_feedback routes (RFC-004) — agent-native "use → build" feedback.
 *
 *   POST /api/build-feedback             提交(真人 Passkey 门 + 频率限制 + proposal 去重)
 *   GET  /api/build-feedback/mine        查"我的反馈到哪了"(闭环)
 *   GET  /api/build-feedback/:id         单条详情(owner 或 admin)
 *   GET  /api/admin/build-feedback       maintainer triage 列表(support perm)
 *   POST /api/admin/build-feedback/:id   改状态 / 处置说明 / 采纳记功(support perm)
 *
 * 注:路径用 /api/build-feedback 独立命名空间,**不**与客服工单 routes/feedback.ts 的
 * /api/feedback 撞车(那套是 helpdesk;本套是 RFC-004 建设反馈,两套并存)。
 *
 * 注入:db / auth / requireSupportAdmin
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import {
  submitBuildFeedback, listMyBuildFeedback, getBuildFeedback,
  adminListBuildFeedback, adminUpdateBuildFeedback, triagePendingBuildFeedback,
} from '../../layer2-business/L2-8-feedback/build-feedback-engine.js'

export interface BuildFeedbackDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireSupportAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerBuildFeedbackRoutes(app: Application, deps: BuildFeedbackDeps): void {
  const { db, auth, requireSupportAdmin } = deps

  const hasPasskey = async (userId: string): Promise<boolean> =>
    (((await dbOne<{ n: number }>('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', [userId]))?.n) || 0) > 0

  // ── 提交 ──────────────────────────────────────────────
  app.post('/api/build-feedback', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const { type, area, severity, subject, text, body, scene } = req.body ?? {}
    // 分级门(RFC-004 精确化 2026-06-05):
    //   「报告问题」(ux_issue/bug = 用)→ 登录即可,不要 Passkey(没 Passkey 也要能报问题)
    //   「建设平台」(proposal = 建)→ 必须 Passkey(真人锚点,后期贡献/奖励才有归属)
    if (String(type) === 'proposal' && !(await hasPasskey(user.id as string))) {
      return void res.status(403).json({
        error: '提交「改进提案 / proposal」需先绑定 Passkey 成为可问责真人 —— 提案是建设行为,被采纳会记入共建信誉,需真人锚点。报告 bug / 体验问题无需 Passkey。请在 webaz.xyz「我的」绑定 Passkey。',
        error_code: 'PROPOSAL_REQUIRES_PASSKEY',
      })
    }
    const result = submitBuildFeedback(db, {
      userId: user.id as string,
      type, area, severity, subject,
      body: text ?? body,                 // 接受 text 或 body
      sceneJson: scene,
      source: 'agent',
    })
    if ('error' in result) return void res.status(result.error_code === 'RATE_LIMITED' ? 429 : 400).json(result)
    res.json(result)
  })

  // ── 闭环:我的反馈进度 ──(必须在 /:id 之前声明)──────────
  app.get('/api/build-feedback/mine', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    res.json({ feedback: await listMyBuildFeedback(db, user.id as string) })
  })

  app.get('/api/build-feedback/:id', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const isAdmin = !!(user.is_admin || user.admin_permissions)   // 宽松判定;admin 端点另有严格门
    const row = await getBuildFeedback(db, String(req.params.id), user.id as string, !!isAdmin)
    if (!row) return void res.status(404).json({ error: '反馈不存在或无权查看' })
    res.json(row)
  })

  // ── maintainer triage ────────────────────────────────
  app.get('/api/admin/build-feedback', async (req: Request, res: Response) => {
    if (!requireSupportAdmin(req, res)) return
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    res.json({ feedback: await adminListBuildFeedback(db, status) })
  })

  // RFC-005 Phase 2:AI 自动 triage(advisory)— 批量处理 received 反馈:去重 + 标风险/摘要 + 置 triaged。
  // 不 resolve、不记功(人类的)。无 AI key 时只做确定性去重 + 置 triaged。
  // ⚠️ 必须在 /:id 之前声明,否则 'triage' 会被 :id 捕获。
  app.post('/api/admin/build-feedback/triage', async (req: Request, res: Response) => {
    if (!requireSupportAdmin(req, res)) return
    const limit = Math.min(50, Math.max(1, Number((req.body ?? {}).limit) || 20))
    try {
      const r = await triagePendingBuildFeedback(db, limit)
      res.json(r)
    } catch (e) {
      res.status(500).json({ error: 'triage failed', detail: String((e as Error).message) })
    }
  })

  app.post('/api/admin/build-feedback/:id', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const { status, resolution, rfc_draft, credit, promote_to_task } = req.body ?? {}
    const result = adminUpdateBuildFeedback(db, {
      id: String(req.params.id), status, resolution, rfcDraft: rfc_draft, credit: !!credit,
      promoteToTask: !!promote_to_task, adminId: admin.id as string,
    })
    if ('error' in result) return void res.status(404).json(result)
    res.json(result)
  })
}
