/**
 * 平台服务费【预充值申请】—— 卖家侧端点。
 *
 * 卖家:看平台收款方式(据此线下付款)→ 提交申请(金额 + 平台账户 + 凭据,必填)→ 查自己的申请状态 → 撤销 pending。
 * ⚠️ 申请【不动钱、不 Passkey】(申请本身不授予任何东西,与缓交申请同范式);真正入账在 admin 确认后(PR3)。
 *   凭据必填 —— 杜绝"场外直接付、无据可查"。不碰 wallet/escrow/settlement/fee 余额。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { listActivePlatformAccounts } from '../../platform-receive-accounts.js'
import { createFeePrepayRequest, listSellerRequests, cancelRequest } from '../../direct-pay-fee-prepay-request.js'
// N3:申请提交 → 通知有审批权的 admin(approve/reject 是 ROOT 门,只通知 root;regional 收到也办不了)。
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface FeePrepayRequestsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerFeePrepayRequestRoutes(app: Application, deps: FeePrepayRequestsDeps): void {
  const { db, auth, generateId } = deps

  /** 登录 + seller 角色。返回 user 或 null(已写响应)。 */
  function requireSeller(req: Request, res: Response): Record<string, unknown> | null {
    const user = auth(req, res); if (!user) return null
    if (user.role !== 'seller') { res.status(403).json({ error: '仅卖家可申请平台服务费预充值', error_code: 'SELLER_ONLY' }); return null }
    return user
  }

  // ── 卖家看平台收款方式(active;含 instruction + qr_data_uri —— 平台公开收款明细,据此付款)──
  app.get('/api/direct-receive/platform-receive-accounts', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    res.json({ accounts: listActivePlatformAccounts(db) })
  })

  // ── 提交预充值申请(不 Passkey;凭据必填)──
  app.post('/api/direct-receive/fee-prepay-request', async (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const b = req.body || {}
    const r = createFeePrepayRequest(db, user.id as string, {
      amountUnits: Number(b.amount_units), currency: b.currency, platformAccountId: b.platform_account_id,
      evidenceRef: b.evidence_ref, evidenceNote: b.evidence_note,
    }, generateId)
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'FEE_PREPAY_REQUEST_INVALID' })
    // N3:通知 root admin 有待审申请(此前提交后无人收到任何未读信号,全靠人肉翻队列)。best-effort 不阻断。
    try {
      const roots = await dbAll<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND (admin_type = 'root' OR admin_type IS NULL)")
      const amountUsdc = Number(b.amount_units) / 1_000_000
      for (const a of roots) {
        createNotification(db, a.id, null, 'dp_fee_prepay_requested', '💳 新预充值申请待审',
          `卖家 ${String(user.name ?? user.id)} 申请平台服务费预充值 ${amountUsdc} USDC,请到 admin 后台核对到账后处理。`,
          { templateKey: 'dp_fee_prepay_requested', params: { seller: String(user.name ?? user.id), amount: amountUsdc } })
      }
    } catch (e) { console.warn('[fee-prepay-request notify]', (e as Error).message) }
    res.json({ ok: true, request: r.request })
  })

  // ── 卖家看自己的申请(全状态)──
  app.get('/api/direct-receive/fee-prepay-requests', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    res.json({ requests: listSellerRequests(db, user.id as string) })
  })

  // ── 卖家撤销自己的 pending 申请 ──
  app.post('/api/direct-receive/fee-prepay-request/:id/cancel', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const changed = cancelRequest(db, String(req.params.id), user.id as string)
    res.json({ ok: true, changed })
  })
}
