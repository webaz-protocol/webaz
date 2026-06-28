/**
 * Direct Pay (Rail 1) — admin Rail-1 合规控制端点。薄 route adapter,两个端点共用同一组 deps
 *   (ROOT + 真人 Passkey + admin audit),都【不】碰 buyer wallet/escrow/order/settlement/refund/状态机:
 *
 *   ① POST .../deposits/:id/confirm-production (PR-4b-3) — 生产保证金 receipt 确认。全部写入委托
 *      confirmProductionReceipt(唯一 production receipt writer);本文件【零】direct_receive_deposits 写入
 *      (满足 direct-pay-deposit-guard)。当前【永远 fail-closed】:assertProductionDepositRail 对所有现有 rail 抛
 *      → 恒返回 409 PRODUCTION_RAIL_NOT_CLEARED,绝不让 Direct Pay 变 launchable。
 *   ② POST .../aml-flags/:id/review (PR-6E) — AML flag 合规复核。全部写入委托 reviewAmlFlag(唯一 aml_flags
 *      review writer,原子改 flag + 写 audit);本文件【零】aml_flags 直写。clear/escalate/suspend 受控解除/维持
 *      #107 breaker 阻断。不接真实 AML vendor、不做真实 STR 申报。
 *
 * 门(两端点共用):ROOT admin + 现场真人 Passkey(铁律,purpose 绑定动作,purpose_data 绑关键字段杜绝跨动作复用
 *   token)。每次 ROOT 尝试(含 gate 失败)都写 admin audit log。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { confirmProductionReceipt } from '../../direct-receive-deposits.js'
import { reviewAmlFlag } from '../../direct-pay-aml-review.js'
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
    // 每次 ROOT 尝试都审计 —— 含【gate 失败】(生产保证金确认本身是敏感控制事件,缺 Passkey / 缺 token /
    //   purpose_data 不符的 ROOT 尝试同样要留痕)。非 ROOT 不审计(requireRootAdmin 已拦,无可信 admin 身份)。
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_receive.production_confirm', 'direct_receive_deposit', depositId,
        { rail_id: railId, jurisdiction, ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }

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

  // POST /api/admin/direct-receive/aml-flags/:id/review — ROOT + 真人 Passkey 复核单条 AML flag (PR-6E)。
  //   route 只做 auth + gate + 参数校验 + 调 reviewAmlFlag(唯一 review writer,原子改 flag + 写 audit)。
  app.post('/api/admin/direct-receive/aml-flags/:id/review', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const flagId = req.params.id
    const decision = String(req.body?.decision || '')
    const notes = req.body?.notes != null ? String(req.body.notes) : undefined
    const webauthnToken = req.body?.webauthn_token as string | undefined

    // 现场真人 Passkey(铁律)。purpose_data 绑 flag_id + decision:一次签名只用于该 flag 的该决策,杜绝复用。
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_pay_aml_review',
      validate: (data) => {
        const d = data as { flag_id?: string; decision?: string } | null
        return !!d && d.flag_id === flagId && d.decision === decision
      },
    })
    if (!gate.ok) {
      // gate 失败也审计(无 PII:flag_id + decision + 结果);成功复核的审计由 reviewAmlFlag 原子写入。
      logAdminAction(admin.id as string, 'direct_pay.aml_review', 'aml_flag', flagId,
        { decision, ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }

    const r = reviewAmlFlag(db, { flagId, reviewerId: admin.id as string, decision, notes })
    if (!r.ok) {
      const status = r.error === 'FLAG_NOT_FOUND' ? 404 : 400
      return void res.status(status).json({ error: 'AML flag 复核失败', error_code: r.error })
    }
    return void res.json({ ok: true, flag_id: r.flagId, decision: r.decision, status: r.status, disposition: r.disposition })
  })
}
