/**
 * build_tasks routes (RFC-006 — Gap 1: coordination layer).
 *
 *   POST /api/build-tasks                提任务(登录即可;反灌水频率限制)
 *   GET  /api/build-tasks                列任务(登录;?status=&area=&mine=1 过滤)
 *   GET  /api/build-tasks/:id            单任务详情 + 事件
 *   POST /api/build-tasks/:id/claim      认领(open → claimed,带 provenance 自报)
 *   POST /api/build-tasks/:id/submit     提交进 in_review(认领者,带 pr_ref + 必填 verification_summary)
 *   POST /api/build-tasks/:id/release    放弃认领(认领者,回 open)
 *   POST /api/admin/build-tasks/:id/resolve  验收 done|abandoned(admin/maintainer — 验收=真人)
 *
 * 边界:协调 + 记录,不发奖励/不记信誉/不 merge(RFC-006)。
 * 注入:db / auth / requireSupportAdmin
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  createBuildTask,
  claimBuildTask, submitBuildTask, releaseBuildTask, resolveBuildTask,
} from '../../layer2-business/L2-9-contribution/build-tasks-engine.js'
// PR9C-1 — read/filter the build_tasks core + PR9B agent metadata (member scope; restricted/internal hidden).
import { listBuildTasksWithAgentMetadata, getBuildTaskWithAgentMetadata, validateTaskFilters, withContributionReadEnvelope } from '../../layer2-business/L2-9-contribution/build-task-read.js'
// PR9C-2 — participation guard (claim/submit/release): restricted/internal 404 no-leak, auto_claimable, canonical PR.
import { guardParticipation, validatePrRefAgainstCanonical } from '../../layer2-business/L2-9-contribution/build-task-participation.js'

export interface BuildTasksDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireSupportAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerBuildTasksRoutes(app: Application, deps: BuildTasksDeps): void {
  const { db, auth, requireSupportAdmin } = deps

  app.post('/api/build-tasks', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const { title, area, description, rfc_ref } = req.body ?? {}
    const result = createBuildTask(db, { creatorId: user.id as string, title, area, description, rfcRef: rfc_ref })
    if ('error' in result) return void res.status(result.error_code === 'RATE_LIMITED' ? 429 : 400).json(result)
    res.json(result)
  })

  // PR9C-1: list now returns build_tasks core + parsed agent_metadata (null for old tasks) under the
  // uncommitted value_boundary; member scope hides restricted/internal. Bad filter → fail-closed 400.
  app.get('/api/build-tasks', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const v = validateTaskFilters(req.query as Record<string, unknown>)
    if (!v.ok) return void res.status(400).json({ error: v.detail, error_code: v.code })
    if (req.query.mine === '1') v.filters.claimerId = user.id as string
    const tasks = listBuildTasksWithAgentMetadata(db, v.filters, 'member')
    res.json(withContributionReadEnvelope({ tasks }))
  })

  app.get('/api/build-tasks/:id', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const task = getBuildTaskWithAgentMetadata(db, String(req.params.id), 'member')   // null → not found OR restricted/internal (no leak)
    if (!task) return void res.status(404).json({ error: '任务不存在' })
    // backward-compat: spread the legacy build_tasks fields + events at top level; only append the new fields.
    res.json(withContributionReadEnvelope(task))
  })

  // PR9C-2: participation guard runs BEFORE the engine — restricted/internal → 404 no-leak; metadata public
  // task → claim respects auto_claimable. Success appends value_boundary + canonical_contribution_target only.
  app.post('/api/build-tasks/:id/claim', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const g = guardParticipation(db, String(req.params.id), 'claim')
    if (!g.ok) return void res.status(g.status).json({ error: g.message, error_code: g.code })
    const result = claimBuildTask(db, String(req.params.id), user.id as string, (req.body ?? {}).provenance)
    if ('error' in result) {
      const code = result.error_code === 'NOT_FOUND' ? 404 : result.error_code === 'TOO_MANY_CLAIMS' ? 429 : 409
      return void res.status(code).json(result)
    }
    res.json(withContributionReadEnvelope(result))
  })

  app.post('/api/build-tasks/:id/submit', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const g = guardParticipation(db, String(req.params.id), 'submit')
    if (!g.ok) return void res.status(g.status).json({ error: g.message, error_code: g.code })
    const { pr_ref, note, verification_summary } = req.body ?? {}
    // anti GitHub-target confusion: a PR must target the canonical repo (the response shows where to submit).
    const pr = validatePrRefAgainstCanonical(pr_ref)
    if (!pr.ok) return void res.status(400).json(withContributionReadEnvelope({ error: pr.message, error_code: pr.code }))
    // submit evidence (design contract): a PR/ref alone is not enough — the contributor must summarize what
    // they ran/verified (the task's verification_commands + results). Fail-closed; stored in the event log.
    const vs = typeof verification_summary === 'string' ? verification_summary.trim() : ''
    if (vs.length < 1) return void res.status(400).json(withContributionReadEnvelope({ error: 'submit requires a verification_summary — summarize what you ran/verified (the task verification_commands and their results)', error_code: 'VERIFICATION_SUMMARY_REQUIRED' }))
    if (vs.length > 2000) return void res.status(400).json(withContributionReadEnvelope({ error: 'verification_summary too long (max 2000 chars)', error_code: 'VERIFICATION_SUMMARY_TOO_LONG' }))
    const result = submitBuildTask(db, String(req.params.id), user.id as string, pr_ref, note, vs)
    if ('error' in result) return void res.status(result.error_code === 'NOT_FOUND' ? 404 : 400).json(result)
    res.json(withContributionReadEnvelope(result))
  })

  app.post('/api/build-tasks/:id/release', (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const g = guardParticipation(db, String(req.params.id), 'release')
    if (!g.ok) return void res.status(g.status).json({ error: g.message, error_code: g.code })
    const result = releaseBuildTask(db, String(req.params.id), user.id as string)
    if ('error' in result) return void res.status(result.error_code === 'NOT_FOUND' ? 404 : 400).json(result)
    res.json(withContributionReadEnvelope(result))
  })

  // 验收终态 —— 仅 admin/maintainer(验收=真人,RFC-006 不变量 2;不发奖励/不记信誉)
  app.post('/api/admin/build-tasks/:id/resolve', (req: Request, res: Response) => {
    const admin = requireSupportAdmin(req, res); if (!admin) return
    const { status, note } = req.body ?? {}
    const result = resolveBuildTask(db, String(req.params.id), String(status), admin.id as string, note)
    if ('error' in result) return void res.status(result.error_code === 'NOT_FOUND' ? 404 : 400).json(result)
    res.json(result)
  })
}
