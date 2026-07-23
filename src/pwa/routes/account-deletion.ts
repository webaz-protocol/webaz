/**
 * 账号注销域 (2026-05-22 COP P0-2 GDPR / 个保法)
 *
 * 由 #1013 Phase 37 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   POST /api/me/delete-request    申请注销（7d 冷却 + 14d 后选定档案/地址字段匿名化）
 *   POST /api/me/delete-cancel     冷却期内撤销
 *   GET  /api/me/delete-status     查注销请求状态
 *
 * 注销 blockers：
 *   - 未完成订单（status not in completed/confirmed/cancelled/refunded_*）
 *   - 未结争议（disputes.status not in resolved/closed）
 *   - 钱包余额 > 0.01 WAZ（需先提现）
 *
 * 副作用：
 *   - users.feed_visible = 0 + deleted_requested_at 写时间
 *   - 撤销时复原 feed_visible = 1 / deleted_requested_at = NULL
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AccountDeletionDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerAccountDeletionRoutes(app: Application, deps: AccountDeletionDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth } = deps

  app.post('/api/me/delete-request', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const uid = user.id as string
    const reason = String((req.body || {}).reason || '').slice(0, 500)

    const blockers: string[] = []
    const pendingOrders = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND status NOT IN ('completed', 'confirmed', 'cancelled', 'refunded_full', 'refunded_partial')`, [uid, uid]))!.n
    if (pendingOrders > 0) blockers.push(`你有 ${pendingOrders} 个未完成订单，请先处理`)
    // #1017 fix: dispute_cases 是已结公开判例（无 status 列）；查"未结争议"应走 disputes 表
    const openDisputes = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM disputes WHERE (initiator_id = ? OR defendant_id = ?) AND status NOT IN ('resolved', 'closed')`, [uid, uid]))!.n
    if (openDisputes > 0) blockers.push(`你有 ${openDisputes} 个未结争议，请先处理`)
    const wallet = await dbOne<{ balance: number }>(`SELECT balance FROM wallets WHERE user_id = ?`, [uid])
    if (wallet && wallet.balance > 0.01) blockers.push(`钱包余额 ${wallet.balance} WAZ — 请先提现`)
    if (blockers.length > 0) return void res.status(400).json({ error: '账号注销前请先处理', blockers })

    await dbRun(`INSERT OR REPLACE INTO account_deletion_requests (user_id, requested_at, reason, cancelled_at, pii_wiped_at) VALUES (?, datetime('now'), ?, NULL, NULL)`, [uid, reason])
    await dbRun(`UPDATE users SET feed_visible = 0, deleted_requested_at = datetime('now') WHERE id = ?`, [uid])
    res.json({
      ok: true,
      cooldown_days: 7,
      wipe_after_days: 14,
      notice: '账号已进入注销冷却期。7 天内可撤销；14 天后将匿名化选定的档案和地址字段，关联订单、争议、KYC、审计及安全记录不会全部删除。',
    })
  })

  app.post('/api/me/delete-cancel', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const uid = user.id as string
    const req_row = await dbOne<{ requested_at: string }>(`SELECT * FROM account_deletion_requests WHERE user_id = ? AND cancelled_at IS NULL AND pii_wiped_at IS NULL`, [uid])
    if (!req_row) return void res.status(404).json({ error: 'no active deletion request' })
    const reqTs = new Date(req_row.requested_at.replace(' ', 'T') + 'Z').getTime()
    if (Date.now() - reqTs > 7 * 86400_000) return void res.status(400).json({ error: '冷却期已过，无法撤销' })
    await dbRun(`UPDATE account_deletion_requests SET cancelled_at = datetime('now') WHERE user_id = ?`, [uid])
    await dbRun(`UPDATE users SET feed_visible = 1, deleted_requested_at = NULL WHERE id = ?`, [uid])
    res.json({ ok: true, message: '账号注销已撤销' })
  })

  app.get('/api/me/delete-status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne(`SELECT requested_at, cancelled_at, pii_wiped_at, reason FROM account_deletion_requests WHERE user_id = ?`, [user.id])
    res.json({ deletion_request: row || null })
  })
}
