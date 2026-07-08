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
import { confirmProductionReceipt, rejectDeposit, executeBondRefund } from '../../direct-receive-deposits.js'
import { enumerateBondRefundBlockers } from '../../bond-refund-blockers.js'   // B2:执行前复核(冷静期内可能新增退货等责任)
import { proposeBondSlash, cancelBondSlashProposal, executeBondSlashProposal, listBondSlashProposals } from '../../bond-slash.js'   // B3:罚没提案/冷静期/执行(人工铁律)
import { dbAll, dbOne } from '../../layer0-foundation/L0-1-database/db.js'   // B1:保证金申报队列/通知收件人只读(async seam)
import { reviewAmlFlag } from '../../direct-pay-aml-review.js'
import { recordKybReview, recordSanctionsScreening, recordAmlFlagIngress, amlDetailHash } from '../../direct-pay-compliance-ingress.js'
import { readDirectPayLaunchReadiness } from '../../direct-pay-launch-readiness.js'
import { approveDeferral, rejectDeferral, adjustGrantedDeferralQuota, listDeferrals, satisfyDeferralOnBond, type DeferralStatus } from '../../direct-receive-deferral.js'
import { listProductVerifications, reviewProductVerification, type ProductVerificationStatus } from '../../product-verification.js'
import { listStoreVerifications, reviewStoreVerification, type StoreVerificationStatus } from '../../store-verification.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'
import { recordFeePrepayTopup, recordFeePrepayAdjustment, recordFeePrepayRefund, getDirectPayFeeAccount } from '../../direct-pay-fee-ar.js'
import { listAllRequests, getRequest as getFeePrepayRequest, approveFeePrepayRequest, rejectFeePrepayRequest } from '../../direct-pay-fee-prepay-request.js'
// N3:审批结果通知卖家(approve 入账/reject 驳回;此前审批后卖家无任何未读信号)。
import { createNotification } from '../../layer2-business/L2-6-notifications/notification-engine.js'

export interface AdminDirectReceiveDepositsDeps {
  db: Database.Database
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerAdminDirectReceiveDepositsRoutes(app: Application, deps: AdminDirectReceiveDepositsDeps): void {
  const { db, requireRootAdmin, consumeGateToken, logAdminAction, getProtocolParam } = deps

  // GET /api/admin/direct-receive/deposits?status=pending — ROOT 只读:保证金申报队列(核对到账用)。B1。
  app.get('/api/admin/direct-receive/deposits', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const status = req.query?.status != null ? String(req.query.status) : ''
    const rows = await dbAll(`
      SELECT d.id, d.user_id, d.tier, d.required_amount, d.amount, d.currency, d.deposit_rail, d.status,
             d.external_ref, d.reject_note, d.production_receipt_confirmed_at, d.created_at, d.locked_at,
             u.name AS seller_name, u.handle AS seller_handle
      FROM direct_receive_deposits d JOIN users u ON u.id = d.user_id
      ${status ? 'WHERE d.status = ?' : ''} ORDER BY d.created_at DESC LIMIT 200`, status ? [status] : [])
    return void res.json({ deposits: rows })
  })

  // POST /api/admin/direct-receive/deposits/:id/reject — ROOT 驳回申报(未 lock 的申报;不动钱,留说明通知卖家)。B1。
  //   不 Passkey:驳回不授予/不移动任何东西(与缓交 reject 不同 —— 那是资格决定;这里只是"到账核不上"退回重报)。
  app.post('/api/admin/direct-receive/deposits/:id/reject', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const note = req.body?.note != null ? String(req.body.note).slice(0, 300) : ''
    const r = rejectDeposit(db, { depositId: req.params.id, note })
    logAdminAction(admin.id as string, 'direct_receive.bond_deposit_reject', 'direct_receive_deposit', req.params.id, { ok: r.ok, note_present: !!note, outcome: r.ok ? r.status : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'BOND_REJECT_FAILED' })
    try { const dep = await dbOne<{ user_id: string }>('SELECT user_id FROM direct_receive_deposits WHERE id = ?', [req.params.id])
      if (dep) createNotification(db, dep.user_id, null, 'bond_deposit_rejected', '❌ 保证金申报未通过核实', `你的保证金缴纳申报未通过核实${note ? `(${note})` : ''}。请核对付款凭据后重新提交,或联系平台。`, { templateKey: 'bond_deposit_rejected', params: { note: note ? `(${note})` : '' } }) } catch { /* 不阻断 */ }
    return void res.json({ ok: true, status: r.status })
  })

  // ── B3:保证金罚没(人工铁律:仲裁裁定卖家责的直付争议 → 提案 → 冷静期 → ROOT+Passkey 执行;绝不自动)──
  app.get('/api/admin/direct-receive/bond-slash', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const status = req.query?.status != null ? String(req.query.status) : ''
    return void res.json({ proposals: listBondSlashProposals(db, status ? { status } : {}) })
  })

  // 提案(ROOT,审计留痕,不 Passkey —— 提案不动任何东西;执行才是终局动作)。通知卖家(冷静期=申诉窗)。
  app.post('/api/admin/direct-receive/bond-slash/propose', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const depositId = String(req.body?.deposit_id || ''); const disputeId = String(req.body?.dispute_id || '')
    if (!depositId || !disputeId) return void res.status(400).json({ error: '须提供 deposit_id 与依据 dispute_id', error_code: 'MISSING_BASIS' })
    const coolingDays = Math.max(0, Number(getProtocolParam<number>('direct_pay.bond_slash_cooling_days', 7)) || 7)
    const proposalId = 'bslash_' + Math.random().toString(36).slice(2, 10)
    const r = proposeBondSlash(db, { proposalId, depositId, disputeId, reason: req.body?.reason != null ? String(req.body.reason) : null, proposedBy: admin.id as string, coolingDays })
    logAdminAction(admin.id as string, 'direct_receive.bond_slash_propose', 'direct_receive_deposit', depositId, { ok: r.ok, dispute_id: disputeId, outcome: r.ok ? proposalId : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'SLASH_PROPOSE_REJECTED' })
    try { const dep = await dbOne<{ user_id: string }>('SELECT user_id FROM direct_receive_deposits WHERE id = ?', [depositId])
      if (dep) createNotification(db, dep.user_id, null, 'bond_slash_proposed', '⚠️ 保证金罚没提案(待复核)', `因争议 ${disputeId} 裁定卖家责任,平台已发起保证金罚没提案。冷静期 ${coolingDays} 天内如有异议请联系平台并提供依据;冷静期满后将复核执行(全额罚没,进入处罚金专户,平台不获益)。`, { templateKey: 'bond_slash_proposed', params: { dispute: disputeId, days: coolingDays } }) } catch { /* 不阻断 */ }
    return void res.json({ ok: true, proposal_id: proposalId, cooling_days: coolingDays })
  })

  app.post('/api/admin/direct-receive/bond-slash/:id/cancel', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const r = cancelBondSlashProposal(db, { proposalId: req.params.id, note: req.body?.note != null ? String(req.body.note) : null })
    logAdminAction(admin.id as string, 'direct_receive.bond_slash_cancel', 'bond_slash_proposal', req.params.id, { ok: r.ok, outcome: r.ok ? 'cancelled' : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'SLASH_CANCEL_REJECTED' })
    try { const p = await dbOne<{ seller_id: string }>('SELECT seller_id FROM bond_slash_proposals WHERE id = ?', [req.params.id])
      if (p) createNotification(db, p.seller_id, null, 'bond_slash_cancelled', '✅ 保证金罚没提案已撤销', '此前的罚没提案经复核已撤销,你的保证金不受影响。', { templateKey: 'bond_slash_cancelled', params: {} }) } catch { /* 不阻断 */ }
    return void res.json({ ok: true, status: r.status, already: !!r.already })
  })

  // 执行(ROOT + 真人 Passkey,purpose direct_pay_bond_slash 绑 proposal_id;冷静期由域内绝对截止校验)。
  app.post('/api/admin/direct-receive/bond-slash/:id/execute', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const proposalId = req.params.id
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken: req.body?.webauthn_token as string | undefined, purpose: 'direct_pay_bond_slash',
      validate: (data) => { const d = data as { proposal_id?: string } | null; return !!d && d.proposal_id === proposalId },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_receive.bond_slash_execute', 'bond_slash_proposal', proposalId, { ok: false, error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const txnId = 'bslashtxn_' + Math.random().toString(36).slice(2, 10)
    let r
    try { r = executeBondSlashProposal(db, { proposalId, txnId, nowIso: new Date().toISOString() }) }
    catch (e) { r = { ok: false as const, reason: (e as Error).message } }
    logAdminAction(admin.id as string, 'direct_receive.bond_slash_execute', 'bond_slash_proposal', proposalId, { ok: r.ok, txn_id: txnId, outcome: r.ok ? (r.already ? 'already' : 'executed') : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'SLASH_EXECUTE_REJECTED' })
    if (!r.already) { try { const p = await dbOne<{ seller_id: string; dispute_id: string }>('SELECT seller_id, dispute_id FROM bond_slash_proposals WHERE id = ?', [proposalId])
      if (p) createNotification(db, p.seller_id, null, 'bond_slash_executed', '❌ 保证金已罚没', `依据争议 ${p.dispute_id} 的卖家责任裁定,你的履约保证金已全额罚没(进入处罚金专户,平台不获益),直付资格已吊销。重新缴纳保证金并通过审核后可再次申请开通。`, { templateKey: 'bond_slash_executed', params: { dispute: p.dispute_id } }) } catch { /* 不阻断 */ } }
    return void res.json({ ok: true, status: r.status, already: !!r.already })
  })

  // POST /api/admin/direct-receive/deposits/:id/execute-refund — ROOT + 真人 Passkey:记录已完成的【场外】保证金退还(B2)。
  //   前置:refunding + 冷静期满(param direct_pay.bond_refund_cooling_days,默认 14d,域内校验)+ 【执行时复核】
  //   unlock blockers(冷静期内可能新增退货/欠费等责任 —— 有任一即拒)。凭据必填;真实退款发生在协议外,此处只记录。
  app.post('/api/admin/direct-receive/deposits/:id/execute-refund', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const depositId = req.params.id
    const evidenceRef = String(req.body?.evidence_ref || '').trim()
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken: req.body?.webauthn_token as string | undefined, purpose: 'direct_receive_bond_refund',
      validate: (data) => { const d = data as { deposit_id?: string; evidence_ref?: string } | null; return !!d && d.deposit_id === depositId && d.evidence_ref === evidenceRef },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_receive.bond_refund_execute', 'direct_receive_deposit', depositId, { ok: false, error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const dep = await dbOne<{ user_id: string }>('SELECT user_id FROM direct_receive_deposits WHERE id = ?', [depositId])
    if (!dep) return void res.status(404).json({ error: '存款不存在', error_code: 'DEPOSIT_NOT_FOUND' })
    const blockers = enumerateBondRefundBlockers(db, dep.user_id)
    if (blockers.length > 0) {
      logAdminAction(admin.id as string, 'direct_receive.bond_refund_execute', 'direct_receive_deposit', depositId, { ok: false, outcome: 'blocked', blockers: blockers.map(b => b.code) })
      return void res.status(409).json({ error: '卖家仍有未了结直付责任,不可退还', error_code: 'REFUND_BLOCKED', blockers })
    }
    const coolingDays = Math.max(0, Number(getProtocolParam<number>('direct_pay.bond_refund_cooling_days', 14)) || 14)
    const r = executeBondRefund(db, { depositId, nowIso: new Date().toISOString(), coolingDays, evidenceRef })
    logAdminAction(admin.id as string, 'direct_receive.bond_refund_execute', 'direct_receive_deposit', depositId, { ok: r.ok, evidence_present: !!evidenceRef, outcome: r.ok ? (r.already ? 'already' : 'refunded') : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'REFUND_EXECUTE_REJECTED' })
    if (!r.already) { try { createNotification(db, dep.user_id, null, 'bond_refund_executed', '✅ 履约保证金已退还', `你的保证金已在协议外退还并记录(凭据:${evidenceRef.slice(0, 60)})。直付资格随保证金退出关闭;重新缴纳后可再次开通。`, { templateKey: 'bond_refund_executed', params: { evidence: evidenceRef.slice(0, 60) } }) } catch { /* 不阻断 */ } }
    return void res.json({ ok: true, status: r.status, already: !!r.already })
  })

  // POST /api/admin/direct-receive/deposits/:id/confirm-production — ROOT + 真人 Passkey 手动确认生产保证金 receipt。
  //   当前恒 fail-closed(无 legal-cleared rail → assert 抛 → PRODUCTION_RAIL_NOT_CLEARED)。
  app.post('/api/admin/direct-receive/deposits/:id/confirm-production', async (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const depositId = req.params.id
    const railId = String(req.body?.rail_id || '')
    const amountUnits = Number(req.body?.expected_amount_units)
    const receiptRef = String(req.body?.receipt_ref || '')
    // jurisdiction=【平台收款主体法域】(P2 澄清:非卖家法域;卖家资格由 KYB/制裁/AML 独立把守)。
    //   自由输入但被域内 DIRECT_PAY_BOND_JURISDICTIONS 严格白名单硬约束(非白名单值必拒),并进 Passkey purpose_data + 审计。
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
      // B1:确认成功 → 通知卖家保证金已生效;B4:缓交期间缴清 → granted 缓交转 satisfied(解除额度压低)+ 告知。best-effort 不阻断。
      if (!r.already) { try { const dep = await dbOne<{ user_id: string }>('SELECT user_id FROM direct_receive_deposits WHERE id = ?', [depositId]); if (dep) {
        const converted = satisfyDeferralOnBond(db, dep.user_id)
        createNotification(db, dep.user_id, null, 'bond_deposit_confirmed', '✅ 履约保证金已确认锁定', `你的保证金已核实到账并正式锁定,直付入场的保证金门已满足。${converted > 0 ? '缓交资格已转正式,额度限制同步解除。' : ''}退出时可申请退还(须无未了结直付责任)。`, { templateKey: 'bond_deposit_confirmed', params: { converted } })
      } } catch { /* 通知失败不阻断 */ } }
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

  // ── PR-6F 合规 ingress(受控写入入口)。三端点共用:ROOT + 真人 Passkey(purpose-bound)+ 调 ingress helper。 ──
  //   route 只做 auth + gate + 取参 + 调 helper(helper 原子写台账 + 审计);gate 失败也审计。无 vendor 外呼、无资金/状态机改动。
  const str = (v: unknown): string => v != null ? String(v) : ''
  const opt = (v: unknown): string | undefined => v != null ? String(v) : undefined
  // gatedIngress 返回一个 express handler(literal-path app.post 调用之 —— 让 API-doc 扫描器能识别端点)。
  const gatedIngress = (
    purpose: string,
    makeValidate: (req: Request) => (data: unknown) => boolean,
    run: (req: Request, adminId: string) => { ok: boolean; error?: string; id?: string },
    failAudit: (req: Request) => { targetId: string; detail: Record<string, unknown> },
  ) => (req: Request, res: Response): void => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken: req.body?.webauthn_token as string | undefined, purpose, validate: makeValidate(req),
    })
    if (!gate.ok) {
      const fa = failAudit(req)
      logAdminAction(admin.id as string, purpose, 'user', fa.targetId, { ...fa.detail, ok: false, error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const r = run(req, admin.id as string)
    if (!r.ok) {
      // 业务校验失败(Passkey 已过)也留痕:money-adjacent admin 尝试(如退款余额不足被拒)必须可审计。
      const fa = failAudit(req)
      logAdminAction(admin.id as string, purpose, 'user', fa.targetId, { ...fa.detail, ok: false, error_code: r.error })
      return void res.status(400).json({ error: '合规 ingress 失败', error_code: r.error })
    }
    return void res.json({ ok: true, id: r.id })
  }

  // POST /api/admin/direct-receive/kyb-reviews — KYB 复核结论 ingress(ROOT + 真人 Passkey)。
  // Passkey purpose_data 绑定【完整写入内容】(user_id+status+provider_ref+expires_at):签 A 写 B 一律拒。
  app.post('/api/admin/direct-receive/kyb-reviews', gatedIngress('direct_pay_kyb_ingress',
    (req) => (data) => { const d = data as { user_id?: string; status?: string; provider_ref?: string; expires_at?: string } | null
      return !!d && str(d.user_id) === str(req.body?.user_id) && str(d.status) === str(req.body?.status)
        && str(d.provider_ref) === str(req.body?.provider_ref) && str(d.expires_at) === str(req.body?.expires_at) },
    (req, adminId) => recordKybReview(db, { userId: str(req.body?.user_id), reviewerId: adminId, status: str(req.body?.status), providerRef: opt(req.body?.provider_ref), expiresAt: opt(req.body?.expires_at) }),
    (req) => ({ targetId: str(req.body?.user_id), detail: { kyb_status: str(req.body?.status) } })))

  // POST /api/admin/direct-receive/sanctions-screenings — 制裁筛查结论 ingress(ROOT + 真人 Passkey;high-risk)。
  // purpose_data 绑定 user_id+status+provider_ref+expires_at。
  app.post('/api/admin/direct-receive/sanctions-screenings', gatedIngress('direct_pay_sanctions_ingress',
    (req) => (data) => { const d = data as { user_id?: string; status?: string; provider_ref?: string; expires_at?: string } | null
      return !!d && str(d.user_id) === str(req.body?.user_id) && str(d.status) === str(req.body?.status)
        && str(d.provider_ref) === str(req.body?.provider_ref) && str(d.expires_at) === str(req.body?.expires_at) },
    (req, adminId) => recordSanctionsScreening(db, { userId: str(req.body?.user_id), reviewerId: adminId, status: str(req.body?.status), providerRef: opt(req.body?.provider_ref), expiresAt: opt(req.body?.expires_at) }),
    (req) => ({ targetId: str(req.body?.user_id), detail: { sanctions_status: str(req.body?.status) } })))

  // POST /api/admin/direct-receive/aml-flags — AML flag ingress(ROOT + 真人 Passkey;high-risk)。与 .../aml-flags/:id/review 区分。
  // purpose_data 绑定 user_id+rule+severity+status+related_order_id+detail_hash(canonical):签 A 写 B 一律拒。
  const amlDetail = (req: Request): Record<string, unknown> | undefined => (req.body?.detail && typeof req.body.detail === 'object' && !Array.isArray(req.body.detail)) ? req.body.detail as Record<string, unknown> : undefined
  app.post('/api/admin/direct-receive/aml-flags', gatedIngress('direct_pay_aml_ingress',
    (req) => (data) => { const d = data as { user_id?: string; rule?: string; severity?: string; status?: string; related_order_id?: string; detail_hash?: string } | null
      return !!d && str(d.user_id) === str(req.body?.user_id) && str(d.rule) === str(req.body?.rule) && str(d.severity) === str(req.body?.severity)
        && str(d.status) === str(req.body?.status) && str(d.related_order_id) === str(req.body?.related_order_id) && str(d.detail_hash) === amlDetailHash(amlDetail(req)) },
    (req, adminId) => recordAmlFlagIngress(db, { userId: str(req.body?.user_id), reviewerId: adminId, rule: str(req.body?.rule), severity: str(req.body?.severity), status: str(req.body?.status), relatedOrderId: opt(req.body?.related_order_id), detail: amlDetail(req) }),
    (req) => ({ targetId: str(req.body?.user_id), detail: { rule: str(req.body?.rule), severity: str(req.body?.severity), aml_status: str(req.body?.status) } })))

  // POST /api/admin/direct-receive/fee-prepay — 记录商家【平台服务费预付款】(ROOT + 真人 Passkey)。append-only;
  //   invoice_id NULL = 未分配预充值 → 计入 available_prepay(首单后续建单门)。purpose_data 绑定 seller_id+amount_units+method+evidence_ref。
  //   不碰 buyer wallet/escrow/order/settlement/refund;非买家 escrow/保证金/penalty。本轮无"余额退款"(仅正向预付款登记)。
  app.post('/api/admin/direct-receive/fee-prepay', gatedIngress('direct_pay_fee_prepay_record',
    (req) => (data) => { const d = data as { seller_id?: string; amount_units?: number; method?: string; evidence_ref?: string } | null
      return !!d && str(d.seller_id) === str(req.body?.seller_id) && Number(d.amount_units) === Number(req.body?.amount_units)
        && str(d.method) === str(req.body?.method) && str(d.evidence_ref) === str(req.body?.evidence_ref) },
    (req, adminId) => recordFeePrepayTopup(db, { sellerId: str(req.body?.seller_id), amountUnits: Number(req.body?.amount_units), method: str(req.body?.method), recordedBy: adminId, evidenceRef: opt(req.body?.evidence_ref), note: opt(req.body?.note) }),
    (req) => ({ targetId: str(req.body?.seller_id), detail: { amount_units: Number(req.body?.amount_units), method: str(req.body?.method) } })))

  // POST /api/admin/direct-receive/fee-adjust — 平台服务费账务【更正】(ROOT + 真人 Passkey)。带符号 delta;append-only + audit。
  //   ≠ 退款(不动真钱,只调记账)。purpose_data 绑 seller_id+delta_units+reason。
  app.post('/api/admin/direct-receive/fee-adjust', gatedIngress('direct_pay_fee_adjust',
    (req) => (data) => { const d = data as { seller_id?: string; delta_units?: number; reason?: string } | null
      return !!d && str(d.seller_id) === str(req.body?.seller_id) && Number(d.delta_units) === Number(req.body?.delta_units) && str(d.reason) === str(req.body?.reason) },
    (req, adminId) => recordFeePrepayAdjustment(db, { sellerId: str(req.body?.seller_id), deltaUnits: Number(req.body?.delta_units), reason: str(req.body?.reason), recordedBy: adminId }),
    (req) => ({ targetId: str(req.body?.seller_id), detail: { delta_units: Number(req.body?.delta_units) } })))

  // POST /api/admin/direct-receive/fee-refund — 平台服务费余额【退款】(ROOT + 真人 Passkey)。真实退还未消耗预付款;
  //   amount ≤ 当前 available(helper 同事务校验)。append-only + audit。purpose_data 绑 seller_id+amount_units+method+evidence_ref。
  app.post('/api/admin/direct-receive/fee-refund', gatedIngress('direct_pay_fee_refund',
    (req) => (data) => { const d = data as { seller_id?: string; amount_units?: number; method?: string; evidence_ref?: string } | null
      return !!d && str(d.seller_id) === str(req.body?.seller_id) && Number(d.amount_units) === Number(req.body?.amount_units)
        && str(d.method) === str(req.body?.method) && str(d.evidence_ref) === str(req.body?.evidence_ref) },
    (req, adminId) => recordFeePrepayRefund(db, { sellerId: str(req.body?.seller_id), amountUnits: Number(req.body?.amount_units), method: str(req.body?.method), recordedBy: adminId, evidenceRef: opt(req.body?.evidence_ref), reason: opt(req.body?.reason) }),
    (req) => ({ targetId: str(req.body?.seller_id), detail: { amount_units: Number(req.body?.amount_units), method: str(req.body?.method) } })))

  // GET /api/admin/direct-receive/fee-account/:seller_id — ROOT 只读:某商家平台服务费账户汇总(余额/预充值/应收/调整/退款/在途预估/宽限)。
  //   只读诊断,不写、无 Passkey(读不授权能力);卖家私密财务,买家/卖家拿不到此 admin 视图。
  app.get('/api/admin/direct-receive/fee-account/:seller_id', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    return void res.json({ ok: true, account: getDirectPayFeeAccount(db, str(req.params.seller_id)) })
  })

  // GET /api/admin/direct-receive/fee-prepay-requests?status=pending — ROOT 只读:预充值申请队列(核对到账用)。
  app.get('/api/admin/direct-receive/fee-prepay-requests', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    return void res.json({ ok: true, requests: listAllRequests(db, req.query.status ? str(req.query.status) : undefined) })
  })

  // POST /api/admin/direct-receive/fee-prepay-requests/:id/approve — ROOT + Passkey【确认真实到账 → 入账】(唯一动钱)。
  //   ⚠️ 独立 purpose 'direct_pay_fee_prepay_request_approve'(≠ 手动入账的 'direct_pay_fee_prepay_record')——
  //   否则"批准申请"的 token 能被拿去打手动 /fee-prepay 记一笔【未关联 fpr】的预充值,原申请仍 pending → 双入账/断链。
  //   purpose_data 绑 request_id + seller_id + amount_units + method(把入账金额/对象钉进 Passkey)。原子:approved + recordFeePrepay + 关联 payment。
  app.post('/api/admin/direct-receive/fee-prepay-requests/:id/approve', gatedIngress('direct_pay_fee_prepay_request_approve',
    (req) => (data) => { const d = data as { request_id?: string; seller_id?: string; amount_units?: number; method?: string } | null
      const fr = getFeePrepayRequest(db, str(req.params.id))
      return !!d && !!fr && d.request_id === str(req.params.id) && d.seller_id === fr.seller_id && Number(d.amount_units) === Number(fr.amount_units) && str(d.method) === str(req.body?.method) },
    (req, adminId) => { const fr = getFeePrepayRequest(db, str(req.params.id))
      const r = approveFeePrepayRequest(db, { requestId: str(req.params.id), adminId, method: str(req.body?.method), reviewNote: opt(req.body?.note) })
      if (r.ok && fr) { const amt = Number(fr.amount_units) / 1_000_000
        try { createNotification(db, fr.seller_id, null, 'dp_fee_prepay_approved', '✅ 预充值已确认入账', `你的平台服务费预充值 ${amt} USDC 已确认入账,直付新单额度已恢复。`, { templateKey: 'dp_fee_prepay_approved', params: { amount: amt } }) } catch { /* 通知失败不阻断入账 */ } }
      return r.ok ? { ok: true, id: r.paymentId } : { ok: false, error: r.error } },
    (req) => { const fr = getFeePrepayRequest(db, str(req.params.id)); return { targetId: fr?.seller_id ?? str(req.params.id), detail: { request_id: str(req.params.id), amount_units: fr?.amount_units, method: str(req.body?.method) } } }))

  // POST /api/admin/direct-receive/fee-prepay-requests/:id/reject — ROOT + Passkey(不动钱)。purpose_data 绑 request_id。
  app.post('/api/admin/direct-receive/fee-prepay-requests/:id/reject', gatedIngress('direct_pay_fee_prepay_reject',
    (req) => (data) => { const d = data as { request_id?: string } | null; return !!d && d.request_id === str(req.params.id) },
    (req, adminId) => { const fr = getFeePrepayRequest(db, str(req.params.id))
      const r = rejectFeePrepayRequest(db, { requestId: str(req.params.id), adminId, reviewNote: opt(req.body?.note) })
      if (r.ok && fr) { const note = opt(req.body?.note) ? `(${opt(req.body?.note)})` : ''
        try { createNotification(db, fr.seller_id, null, 'dp_fee_prepay_rejected', '❌ 预充值申请未通过', `你的平台服务费预充值申请未通过${note}。请核对付款凭据后重新提交,或联系平台。`, { templateKey: 'dp_fee_prepay_rejected', params: { note } }) } catch { /* 通知失败不阻断 */ } }
      return r },
    (req) => ({ targetId: str(req.params.id), detail: { request_id: str(req.params.id) } })))

  // POST /api/admin/direct-receive/readiness — ROOT + 真人 Passkey:返回【完整】Direct Pay launch readiness(blockers + facts,
  //   含 KYB/sanctions/AML/base-bond/rail clearance 全细节)。只读诊断(不写库、不 flip launch);ROOT 专用,买家/卖家拿不到。
  app.post('/api/admin/direct-receive/readiness', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const sellerId = req.body?.seller_id != null ? String(req.body.seller_id) : undefined
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken: req.body?.webauthn_token as string | undefined, purpose: 'direct_pay_admin_readiness',
      validate: (data) => { const d = data as { seller_id?: string } | null; return !!d && String(d.seller_id ?? '') === String(sellerId ?? '') },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_pay.admin_readiness', 'user', sellerId ?? null, { ok: false, error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const readiness = readDirectPayLaunchReadiness(db, { getProtocolParam, sellerId })
    logAdminAction(admin.id as string, 'direct_pay.admin_readiness', 'user', sellerId ?? null, { ok: true, ready: readiness.ready, blocker_count: readiness.blockers.length })
    return void res.json(readiness)
  })

  // ── 缓交(deferred base-bond)审批队列。读 = ROOT;批准/拒绝 = ROOT + 真人 Passkey(铁律,授予绝不自动)。 ──
  //   approveDeferral/rejectDeferral 是唯一 writer;本文件零 direct_receive_deferrals 直写。审批只改缓交状态机,
  //   【不】碰 buyer wallet/escrow/order/settlement/refund/privileges,也不 flip launch。
  const DEFERRAL_STATUSES = new Set<DeferralStatus>(['pending', 'granted', 'rejected', 'expired'])

  // GET /api/admin/direct-receive/deferrals?status=pending — ROOT 审批队列(默认全部;可按 status 过滤)。纯读。
  app.get('/api/admin/direct-receive/deferrals', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const status = req.query?.status != null ? String(req.query.status) : ''
    if (status && !DEFERRAL_STATUSES.has(status as DeferralStatus)) return void res.status(400).json({ error: '非法 status', error_code: 'BAD_STATUS' })
    return void res.json({ deferrals: listDeferrals(db, status ? { status: status as DeferralStatus } : {}) })
  })

  // POST /api/admin/direct-receive/deferrals/:id/approve — ROOT + 真人 Passkey 批准缓交。
  //   Passkey purpose_data 绑定【完整审批条款】(deferral_id + reduced_quota_factor + grace_days):签 A 批 B / 改条款一律拒。
  app.post('/api/admin/direct-receive/deferrals/:id/approve', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const deferralId = req.params.id
    const rqfRaw = req.body?.reduced_quota_factor
    const graceRaw = req.body?.grace_days
    const webauthnToken = req.body?.webauthn_token as string | undefined
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_pay_deferral_approve',
      validate: (data) => { const d = data as { deferral_id?: string; reduced_quota_factor?: unknown; grace_days?: unknown } | null
        return !!d && str(d.deferral_id) === deferralId && str(d.reduced_quota_factor) === str(rqfRaw) && str(d.grace_days) === str(graceRaw) },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_pay.deferral_approve', 'direct_receive_deferral', deferralId,
        { ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const r = approveDeferral(db, { deferralId, adminId: admin.id as string, nowIso: new Date().toISOString(),
      graceDays: graceRaw != null ? Number(graceRaw) : undefined, reducedQuotaFactor: rqfRaw != null ? Number(rqfRaw) : undefined })
    logAdminAction(admin.id as string, 'direct_pay.deferral_approve', 'direct_receive_deferral', deferralId,
      { ok: r.ok, outcome: r.ok ? (r.already ? 'already' : 'granted') : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'DEFERRAL_APPROVE_REJECTED' })
    return void res.json({ ok: true, status: r.status, already: !!r.already })
  })

  // POST /api/admin/direct-receive/deferrals/:id/reject — ROOT + 真人 Passkey 拒绝缓交。purpose_data 绑 deferral_id。
  app.post('/api/admin/direct-receive/deferrals/:id/reject', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const deferralId = req.params.id
    const webauthnToken = req.body?.webauthn_token as string | undefined
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_pay_deferral_reject',
      validate: (data) => { const d = data as { deferral_id?: string } | null; return !!d && str(d.deferral_id) === deferralId },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_pay.deferral_reject', 'direct_receive_deferral', deferralId,
        { ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const r = rejectDeferral(db, { deferralId, adminId: admin.id as string })
    logAdminAction(admin.id as string, 'direct_pay.deferral_reject', 'direct_receive_deferral', deferralId,
      { ok: r.ok, outcome: r.ok ? (r.already ? 'already' : 'rejected') : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'DEFERRAL_REJECT_REJECTED' })
    return void res.json({ ok: true, status: r.status, already: !!r.already })
  })

  // POST /api/admin/direct-receive/deferrals/:id/adjust-quota — ROOT + 真人 Passkey 调整【已 granted】缓交的压低配额系数
  //   (只改 reduced_quota_factor,不动到期/宽限)。补齐"缓交批后无调额入口"的运营缺口:批准时一次性设定后,卖家逼近
  //   配额时此前只能裸改 DB → 现有正规、带 Passkey+audit+clamp 的端点。Passkey purpose_data 绑 deferral_id +
  //   reduced_quota_factor(签 A 改 B / 改数值一律拒)。adjustGrantedDeferralQuota 是唯一 writer(CAS on granted)。
  app.post('/api/admin/direct-receive/deferrals/:id/adjust-quota', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const deferralId = req.params.id
    const rqfRaw = req.body?.reduced_quota_factor
    const webauthnToken = req.body?.webauthn_token as string | undefined
    if (rqfRaw == null || !Number.isFinite(Number(rqfRaw))) return void res.status(400).json({ error: 'reduced_quota_factor 必填(数值)', error_code: 'INVALID_QUOTA_FACTOR' })
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_pay_deferral_adjust',
      validate: (data) => { const d = data as { deferral_id?: string; reduced_quota_factor?: unknown } | null
        return !!d && str(d.deferral_id) === deferralId && str(d.reduced_quota_factor) === str(rqfRaw) },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_pay.deferral_adjust_quota', 'direct_receive_deferral', deferralId,
        { ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const r = adjustGrantedDeferralQuota(db, { deferralId, adminId: admin.id as string, reducedQuotaFactor: Number(rqfRaw) })
    logAdminAction(admin.id as string, 'direct_pay.deferral_adjust_quota', 'direct_receive_deferral', deferralId,
      { ok: r.ok, outcome: r.ok ? `factor ${r.previousFactor}→${r.newFactor}` : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'DEFERRAL_ADJUST_REJECTED' })
    return void res.json({ ok: true, status: r.status, previous_factor: r.previousFactor, new_factor: r.newFactor })
  })

  // ── 按产品认证(per-product verification)审批。读 = ROOT;verify/reject = ROOT + 真人 Passkey(硬门:核验=放行该产品直付,
  //   capability-granting → 铁律 Passkey)。reviewProductVerification 是唯一 writer;本文件零 product_verifications 直写。 ──
  const PV_STATUSES = new Set<ProductVerificationStatus>(['issued', 'submitted', 'verified', 'rejected'])

  // GET /api/admin/direct-receive/product-verifications?status=submitted — ROOT 审核队列(默认全部)。纯读。
  app.get('/api/admin/direct-receive/product-verifications', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const status = req.query?.status != null ? String(req.query.status) : ''
    if (status && !PV_STATUSES.has(status as ProductVerificationStatus)) return void res.status(400).json({ error: '非法 status', error_code: 'BAD_STATUS' })
    return void res.json({ verifications: listProductVerifications(db, status ? { status: status as ProductVerificationStatus } : {}) })
  })

  // POST /api/admin/direct-receive/product-verifications/:id/review — ROOT + 真人 Passkey 手动核对结论(verified|rejected)。
  //   Passkey purpose_data 绑 verification_id + decision:签 A 用 B / 改结论一律拒。verify = 放行该产品直付(逐品,绝不放行全部)。
  app.post('/api/admin/direct-receive/product-verifications/:id/review', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const verificationId = req.params.id
    const decision = String(req.body?.decision || '')
    const notes = req.body?.notes != null ? String(req.body.notes) : undefined
    const webauthnToken = req.body?.webauthn_token as string | undefined
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_pay_product_verify',
      validate: (data) => { const d = data as { verification_id?: string; decision?: string } | null; return !!d && str(d.verification_id) === verificationId && str(d.decision) === decision },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_pay.product_verify', 'product_verification', verificationId,
        { decision, ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const r = reviewProductVerification(db, { id: verificationId, reviewerId: admin.id as string, decision: decision as 'verified' | 'rejected', notes })
    logAdminAction(admin.id as string, 'direct_pay.product_verify', 'product_verification', verificationId,
      { decision, ok: r.ok, outcome: r.ok ? (r.already ? 'already' : r.status) : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'PRODUCT_VERIFICATION_REVIEW_REJECTED' })
    return void res.json({ ok: true, status: r.status, already: !!r.already })
  })

  // ── 店铺认证(per-seller)审批 = 逐品验证豁免决定。读 = ROOT;verify/reject = ROOT + 真人 Passkey。 ──
  //   核店铺时勾选 per_product_exempt:true → 该卖家所有商品免逐品验证(capability-granting → 铁律 Passkey;
  //   purpose_data 绑 verification_id+decision+per_product_exempt,签 A 用 B / 改豁免位一律拒)。reviewStoreVerification 唯一 writer。
  const SV_STATUSES = new Set<StoreVerificationStatus>(['issued', 'submitted', 'verified', 'rejected'])

  // GET /api/admin/direct-receive/store-verifications?status=submitted — ROOT 审核队列(默认全部)。纯读。
  app.get('/api/admin/direct-receive/store-verifications', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const status = req.query?.status != null ? String(req.query.status) : ''
    if (status && !SV_STATUSES.has(status as StoreVerificationStatus)) return void res.status(400).json({ error: '非法 status', error_code: 'BAD_STATUS' })
    return void res.json({ verifications: listStoreVerifications(db, status ? { status: status as StoreVerificationStatus } : {}) })
  })

  // POST /api/admin/direct-receive/store-verifications/:id/review — ROOT + 真人 Passkey 核店铺 + 勾选逐品豁免。
  app.post('/api/admin/direct-receive/store-verifications/:id/review', (req, res) => {
    const admin = requireRootAdmin(req, res); if (!admin) return
    const verificationId = req.params.id
    const decision = String(req.body?.decision || '')
    const perProductExempt = req.body?.per_product_exempt === true
    const notes = req.body?.notes != null ? String(req.body.notes) : undefined
    const webauthnToken = req.body?.webauthn_token as string | undefined
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId: admin.id as string, webauthnToken, purpose: 'direct_pay_store_verify',
      validate: (data) => { const d = data as { verification_id?: string; decision?: string; per_product_exempt?: unknown } | null
        return !!d && str(d.verification_id) === verificationId && str(d.decision) === decision && (d.per_product_exempt === true) === perProductExempt },
    })
    if (!gate.ok) {
      logAdminAction(admin.id as string, 'direct_pay.store_verify', 'store_verification', verificationId,
        { decision, per_product_exempt: perProductExempt, ok: false, outcome: gate.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY' ? 'passkey_required' : 'human_presence_required', error_code: gate.error_code })
      return void res.status(403).json({ error: gate.reason, error_code: gate.error_code })
    }
    const r = reviewStoreVerification(db, { id: verificationId, reviewerId: admin.id as string, decision: decision as 'verified' | 'rejected', perProductExempt, notes })
    logAdminAction(admin.id as string, 'direct_pay.store_verify', 'store_verification', verificationId,
      { decision, per_product_exempt: perProductExempt, ok: r.ok, outcome: r.ok ? (r.already ? 'already' : r.status) : r.reason })
    if (!r.ok) return void res.status(409).json({ error: r.reason, error_code: 'STORE_VERIFICATION_REVIEW_REJECTED' })
    return void res.json({ ok: true, status: r.status, per_product_exempt: !!r.perProductExempt, already: !!r.already })
  })
}
