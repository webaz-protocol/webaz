/**
 * PR9C-1 — Public Task Board read surface (no auth; READ/FILTER only). Lets a stranger and their agent see
 * tasks they may participate in, with clear boundary/acceptance/verification info — BUT only `audience=public`
 * AND `status=open` tasks (the read helper's 'public' scope; restricted/internal are never exposed, and a
 * task with no metadata is excluded from the public surface). Every response carries the uncommitted
 * value_boundary (no reward/payout/amount). No create/claim/submit here — that is PR9C-2.
 *
 *   GET /api/public/build-tasks       list (lightweight triage fields) + filters
 *   GET /api/public/build-tasks/:id   detail (full execution boundary + acceptance); 404 if not public/open
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { listBuildTasksWithAgentMetadata, getBuildTaskWithAgentMetadata, validateTaskFilters, withContributionReadEnvelope } from '../../layer2-business/L2-9-contribution/build-task-read.js'
import { caseIdForTask } from '../../layer2-business/L2-9-contribution/task-proposal-draft.js'

export interface PublicBuildTasksDeps {
  db: Database.Database
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
}

export function registerPublicBuildTasksRoutes(app: Application, deps: PublicBuildTasksDeps): void {
  const { db, errorRes } = deps

  app.get('/api/public/build-tasks', (req: Request, res: Response) => {
    const v = validateTaskFilters(req.query as Record<string, unknown>)
    if (!v.ok) return void errorRes(res, 400, v.code, v.detail)   // fail-closed: bad filter → typed 400
    const tasks = listBuildTasksWithAgentMetadata(db, v.filters, 'public')
    res.json(withContributionReadEnvelope({ tasks }))
  })

  app.get('/api/public/build-tasks/:id', (req: Request, res: Response) => {
    // 'public' scope already restricts to audience=public + status=open; a non-visible task returns null →
    // 404 (same as truly-missing, so existence of a restricted/internal task is never disclosed).
    const task = getBuildTaskWithAgentMetadata(db, String(req.params.id), 'public')
    if (!task) return void errorRes(res, 404, 'NOT_FOUND', '任务不存在')
    // case_id threads proposal → task → PR (= source proposal id if converted from a proposal, else the task id),
    // so the proposer, the contributor, and the PR all quote one id. (Helper lives in the store — keeps this
    // route off the RFC-016 raw-db seam.)
    res.json(withContributionReadEnvelope({ task: { ...task, case_id: caseIdForTask(db, String(req.params.id)) } }))
  })
}
