/**
 * Direct Pay (Rail 1) — admin 生产保证金 receipt 确认端点 (PR-4b-3 scaffold)。薄 route adapter:
 *   全部写入委托 confirmProductionReceipt(src/direct-receive-deposits.ts 的【唯一 production receipt writer】);
 *   本文件【零】direct_receive_deposits 写入(满足 direct-pay-deposit-guard:routes 不得 raw-write)。
 *
 * 当前【永远 fail-closed】:confirmProductionReceipt 内 assertProductionDepositRail 对所有现有 rail 抛
 *   (无 legal-cleared 生产 rail)→ 本端点恒返回 409 PRODUCTION_RAIL_NOT_CLEARED,绝不写 production receipt,
 *   绝不让 Direct Pay 变 launchable。不接真实 USDC/fiat/PSP/on-chain;不碰 buyer wallet/escrow/order/settlement/refund。
 *
 * 门:ROOT admin(生产保证金=ROOT 级金融控制)+ 现场真人 Passkey(铁律,purpose=direct_receive_production_confirm,
 *   purpose_data 绑定【完整动作字段】杜绝跨动作复用 token)。每次 ROOT 尝试都写 admin audit log(无论结果)。
 *   policy_version 服务端盖章(非入参);jurisdiction 由 helper 严格白名单校验。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { confirmProductionReceipt } from '../../direct-receive-deposits.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'

export interface AdminDirectReceiveDepositsDeps {
  db: Database.Database
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminDirectReceiveDepositsRoutes(app: Application, deps: AdminDirectReceiveDepositsDeps): void {
  const { db, requireRootAdmin, consumeGateToken, logAdminAction } = deps

  // POST /api/admin/direct-receive/deposits/:id/confirm-production — ROOT + 真人 Passkey 手动确认生产保证金 receipt。
  //   当前恒 fail-closed(无 legal-cleared rail → assert 抛 → PRODUCTION_RAIL_NOT_CLEARED)。
  app.post('/api/admin/direct-receive/deposits/:id/confirm-production', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const depositId = req.params.id
    const railId = String(req.body?.rail_id || '')
    const amountUnits = Number(req.body?.expected_amount_units)
    const receiptRef = String(req.body?.receipt_ref || '')
    const jurisdiction = String(req.body?.jurisdiction || '')
    const webauthnToken = req.body?.webauthn_token as string | undefined

    // 现场真人 Passkey(铁律)。purpose_data 绑定【完整动作字段】:deposit/rail/amount/receipt/jurisdiction 全等才放行,
    //   防止把一次签名复用到另一笔/另一参数的确认上。
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_receive_production_confirm',
      validate: (data) => {
        const d = data as { deposit_id?: string; rail_id?: string; amount_units?: number; receipt_ref?: string; jurisdiction?: string } | null
        return !!d && d.deposit_id === depositId && d.rail_id === railId && Number(d.amount_units) === amountUnits
          && d.receipt_ref === receiptRef && d.jurisdiction === jurisdiction
      },
    })
    if (!gate.ok) return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })

    // 写入只走唯一 writer。assert 抛 → 当前恒 fail-closed。每次 ROOT 尝试都审计(含结果)。
    try {
      const r = confirmProductionReceipt(db, { depositId, railId, expectedAmountUnits: amountUnits, receiptRef, jurisdiction })
      logAdminAction(admin.id as string, 'direct_receive.production_confirm', 'direct_receive_deposit', depositId,
        { rail_id: railId, jurisdiction, ok: r.ok, outcome: r.ok ? (r.already ? 'already' : 'confirmed') : r.reason })
      if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'PRODUCTION_CONFIRM_REJECTED' })
      return void res.json({ ok: true, status: r.status, already: !!r.already })
    } catch (e) {
      // assertProductionDepositRail(及任何写前异常)→ 生产 rail 未 legal-clear → fail-closed。
      logAdminAction(admin.id as string, 'direct_receive.production_confirm', 'direct_receive_deposit', depositId,
        { rail_id: railId, jurisdiction, ok: false, outcome: 'rail_not_cleared', error: (e as Error).message })
      return void res.status(409).json({ error: '生产保证金收款轨未通过法务/生产放行,暂不可确认', error_code: 'PRODUCTION_RAIL_NOT_CLEARED' })
    }
  })
}
