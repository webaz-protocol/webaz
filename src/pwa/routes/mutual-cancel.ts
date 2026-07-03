/**
 * 协商取消(mutual cancel)路由 —— 争议中订单的无责·双方合意下车口。
 *
 * 端点(全部 order 当事方鉴权,域逻辑在 ../../layer3-trust/L3-1-dispute-engine/mutual-cancel.ts):
 *   POST   /api/orders/:id/mutual-cancel/propose    当事方提议(可带 reason)
 *   POST   /api/orders/:id/mutual-cancel/accept     对方确认 → 执行(资金+状态+争议 resolved,db.transaction 原子)
 *   POST   /api/orders/:id/mutual-cancel/decline     对方拒绝
 *   POST   /api/orders/:id/mutual-cancel/withdraw    提议方撤回
 *   GET    /api/orders/:id/mutual-cancel             当前提议 + 该 caller 可执行的动作(UI)
 *
 * 本文件只做「接线」:auth + 参数 + accept 的 db.transaction 原子边界 + 统一 errorRes 映射。
 * 无资金/状态语义 —— 那些全在域模块,便于审计与状态机 adapter 复用。v1 不发通知(通知系统 N1 改造挂起中),
 * 靠 UI 在对方打开订单/争议页时呈现 pending 提议;通知留后续 PR。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { proposeMutualCancel, acceptMutualCancel, declineMutualCancel, withdrawMutualCancel, getMutualCancelState } from '../../layer3-trust/L3-1-dispute-engine/mutual-cancel.js'

export interface MutualCancelDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

export function registerMutualCancelRoutes(app: Application, deps: MutualCancelDeps): void {
  const { db, auth, generateId, errorRes } = deps
  // 域返回 error_code → HTTP 状态。未知/校验类 → 409(与当前状态冲突);系统缺失 → 500。
  const httpFor = (code: string | undefined): number =>
    code === 'ORDER_NOT_FOUND' ? 404
      : code === 'NOT_A_PARTY' ? 403
        : code === 'SYS_MISSING' || code === 'TRANSITION_FAILED' ? 500
          : 409

  app.get('/api/orders/:id/mutual-cancel', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = getMutualCancelState(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_STATE_ERROR', r.error || '读取失败')
    res.json({ success: true, proposal: r.proposal ?? null, can_propose: !!r.can_propose, can_accept: !!r.can_accept, can_decline: !!r.can_decline, can_withdraw: !!r.can_withdraw })
  })

  app.post('/api/orders/:id/mutual-cancel/propose', (req, res) => {
    const user = auth(req, res); if (!user) return
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null
    const r = proposeMutualCancel(db, req.params.id, user.id as string, reason, generateId('mcp'))
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_PROPOSE_ERROR', r.error || '提议失败')
    res.json({ success: true, proposal_id: r.proposal_id, status: r.status })
  })

  app.post('/api/orders/:id/mutual-cancel/accept', (req, res) => {
    const user = auth(req, res); if (!user) return
    let r
    try {
      // 资金 + 状态翻转 + 争议 resolved 必须同一原子边界(RFC-016 钱路铁律);域函数内已做竞态重校验。
      r = db.transaction(() => acceptMutualCancel(db, req.params.id, user.id as string))()
    } catch (e) { return void errorRes(res, 500, 'MUTUAL_CANCEL_ACCEPT_FAILED', (e as Error).message) }
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_ACCEPT_ERROR', r.error || '确认失败')
    res.json({ success: true, status: r.status, settlement: r.settlement })
  })

  app.post('/api/orders/:id/mutual-cancel/decline', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = declineMutualCancel(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_DECLINE_ERROR', r.error || '拒绝失败')
    res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/mutual-cancel/withdraw', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = withdrawMutualCancel(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_WITHDRAW_ERROR', r.error || '撤回失败')
    res.json({ success: true, status: r.status })
  })
}
