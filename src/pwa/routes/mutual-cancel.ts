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
 * 本文件只做「接线」:auth + 参数 + accept 的 db.transaction 原子边界 + 统一 errorRes 映射 +
 * 当事方通知(propose/accept/decline;2026-07 订单流遍历审计补齐,accept 通知在事务提交后发)。
 * 无资金/状态语义 —— 那些全在域模块,便于审计与状态机 adapter 复用。
 */
import { railOutsideWazCustody } from '../../direct-pay-rails.js'
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { proposeMutualCancel, acceptMutualCancel, declineMutualCancel, withdrawMutualCancel, getMutualCancelState } from '../../layer3-trust/L3-1-dispute-engine/mutual-cancel.js'
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'   // RFC-016 异步 seam(纯读,不在事务内)

export interface MutualCancelDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

export function registerMutualCancelRoutes(app: Application, deps: MutualCancelDeps): void {
  const { db, auth, generateId, errorRes } = deps

  // 通知补齐(原 v1 刻意不发,靠对方主动打开页面才能看到 pending 提议 —— 静默协商=永远谈不拢):
  //   propose→通知对方;accept→通知双方(rail-fork 资金语义);decline→通知提议方。失败不阻断主流程。
  const orderParties = async (orderId: string): Promise<{ buyer_id: string; seller_id: string; payment_rail: string | null; product_title: string } | undefined> =>
    await dbOne<{ buyer_id: string; seller_id: string; payment_rail: string | null; product_title: string }>(
      `SELECT o.buyer_id, o.seller_id, o.payment_rail, COALESCE(p.title,'') AS product_title
       FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.id = ?`, [orderId]) ?? undefined
  const notifyMc = (orderId: string, recipients: Array<string | null | undefined>, type: string, title: string, body: string, templateKey: string, productTitle: string): void => {
    try {
      for (const uid of recipients) { if (uid) createNotification(db, uid, orderId, type, title, body, { templateKey, params: { product: productTitle } }) }
    } catch (e) { console.warn('[mutual-cancel notify]', (e as Error).message) }
  }
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

  app.post('/api/orders/:id/mutual-cancel/propose', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null
    const r = proposeMutualCancel(db, req.params.id, user.id as string, reason, generateId('mcp'))
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_PROPOSE_ERROR', r.error || '提议失败')
    const o = await orderParties(req.params.id)
    if (o) {
      const counterpart = user.id === o.buyer_id ? o.seller_id : o.buyer_id
      notifyMc(req.params.id, [counterpart], 'mutual_cancel_proposed', '🤝 对方提议协商取消', `订单「${o.product_title}」:对方提议无责协商取消,请到订单页处理(同意/拒绝)。`, 'mc_proposed', o.product_title)
    }
    res.json({ success: true, proposal_id: r.proposal_id, status: r.status })
  })

  app.post('/api/orders/:id/mutual-cancel/accept', async (req, res) => {
    const user = auth(req, res); if (!user) return
    let r
    try {
      // 资金 + 状态翻转 + 争议 resolved 必须同一原子边界(RFC-016 钱路铁律);域函数内已做竞态重校验。
      r = db.transaction(() => acceptMutualCancel(db, req.params.id, user.id as string))()
    } catch (e) { return void errorRes(res, 500, 'MUTUAL_CANCEL_ACCEPT_FAILED', (e as Error).message) }
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_ACCEPT_ERROR', r.error || '确认失败')
    // 通知在事务提交之后(回滚不发假通知);rail-fork:direct_p2p 非托管零资金,绝不写"已退款"
    const o = await orderParties(req.params.id)
    if (o) {
      const direct = railOutsideWazCustody(o.payment_rail)   // B3:usdc_escrow 通知走非托管文案(绝不宣称 WAZ 已退款)
      notifyMc(req.params.id, [o.buyer_id, o.seller_id], 'mutual_cancel_done', '🤝 协商取消达成,订单已关闭',
        direct
          ? `订单「${o.product_title}」双方协商一致无责取消(非托管:零资金操作,场外款项以双方约定为准),双方信誉不受影响。`
          : `订单「${o.product_title}」双方协商一致无责取消:货款已全额退回买家,卖家质押已退还,双方信誉不受影响。`,
        direct ? 'mc_done_dp' : 'mc_done', o.product_title)
    }
    res.json({ success: true, status: r.status, settlement: r.settlement })
  })

  app.post('/api/orders/:id/mutual-cancel/decline', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = declineMutualCancel(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_DECLINE_ERROR', r.error || '拒绝失败')
    const o = await orderParties(req.params.id)
    if (o) {
      const counterpart = user.id === o.buyer_id ? o.seller_id : o.buyer_id
      notifyMc(req.params.id, [counterpart], 'mutual_cancel_declined', '🤝 协商取消被拒绝', `订单「${o.product_title}」:对方拒绝了协商取消提议,订单维持原状态。`, 'mc_declined', o.product_title)
    }
    res.json({ success: true, status: r.status })
  })

  app.post('/api/orders/:id/mutual-cancel/withdraw', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = withdrawMutualCancel(db, req.params.id, user.id as string)
    if (!r.ok) return void errorRes(res, httpFor(r.error_code), r.error_code || 'MUTUAL_CANCEL_WITHDRAW_ERROR', r.error || '撤回失败')
    res.json({ success: true, status: r.status })
  })
}
