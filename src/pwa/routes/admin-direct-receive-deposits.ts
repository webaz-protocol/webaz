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
import { recordKybReview, recordSanctionsScreening, recordAmlFlagIngress, amlDetailHash } from '../../direct-pay-compliance-ingress.js'
import { readDirectPayLaunchReadiness } from '../../direct-pay-launch-readiness.js'
import { approveDeferral, rejectDeferral, listDeferrals, type DeferralStatus } from '../../direct-receive-deferral.js'
import { listProductVerifications, reviewProductVerification, type ProductVerificationStatus } from '../../product-verification.js'
import { listStoreVerifications, reviewStoreVerification, type StoreVerificationStatus } from '../../store-verification.js'
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'

export interface AdminDirectReceiveDepositsDeps {
  db: Database.Database
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerAdminDirectReceiveDepositsRoutes(app: Application, deps: AdminDirectReceiveDepositsDeps): void {
  const { db, requireRootAdmin, consumeGateToken, logAdminAction, getProtocolParam } = deps

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
    if (!r.ok) return void res.status(400).json({ error: '合规 ingress 失败', error_code: r.error })
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
