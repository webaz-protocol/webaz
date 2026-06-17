/**
 * Claim 撤回 — 5 个声明垂类的发起人撤回端点
 *
 * 由 #1013 Phase 74 从 src/pwa/server.ts 抽出（Wave A-5）。
 *
 * 5 endpoints:
 *   DELETE /api/product-claims/:id
 *   DELETE /api/review-claims/:id
 *   DELETE /api/secondhand-claims/:id
 *   DELETE /api/auction-claims/:id
 *   DELETE /api/wish-claims/:id
 *
 * 规则：仅发起人本人，且当前 0 票时可撤回；撤回退还原 stake
 *
 * 跨域注入：auth + withdrawClaim（参数化 table，valid set 防注入）
 */
import type { Application, Request, Response } from 'express'

export interface ClaimWithdrawalsDeps {
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  withdrawClaim: (taskTable: string, voteTable: string, claimId: string, userId: string) => { ok: boolean; error?: string }
}

export function registerClaimWithdrawalsRoutes(app: Application, deps: ClaimWithdrawalsDeps): void {
  const { auth, withdrawClaim } = deps

  const mk = (path: string, taskTable: string, voteTable: string) => {
    app.delete(path, (req, res) => {
      const user = auth(req, res); if (!user) return
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
      const r = withdrawClaim(taskTable, voteTable, id, user.id as string)
      if (!r.ok) return void res.status(400).json({ error: r.error })
      res.json({ success: true, stake_refunded: true })
    })
  }

  mk('/api/product-claims/:id',     'product_claim_tasks',     'product_claim_votes')
  mk('/api/review-claims/:id',      'review_claim_tasks',      'review_claim_votes')
  mk('/api/secondhand-claims/:id',  'secondhand_claim_tasks',  'secondhand_claim_votes')
  mk('/api/auction-claims/:id',     'auction_claim_tasks',     'auction_claim_votes')
  mk('/api/wish-claims/:id',        'wish_claim_tasks',        'wish_claim_votes')
}
