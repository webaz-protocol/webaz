/**
 * Direct Pay (Rail 1) — 可用性只读端点 (PR-4a / Phase 4a)。薄 read adapter:复用控制面 SSOT
 *   (direct-pay-controls.ts)回答"某商品现在能否直付、不能的话为什么",供 UI 展示。
 *
 * 不泄露敏感信息:全局/地区/单笔上限是非敏感的运营状态,原样返回;但【卖家合规类】拒绝(production base-bond /
 *   KYC-制裁 / AML 断路器)统一收敛为通用 'DIRECT_PAY_SELLER_NOT_ELIGIBLE',不向买家暴露卖家的 KYC/担保/AML/STR 具体状态。
 * 纯读:不建单、不碰 wallet/escrow/settlement/refund、不改状态机。route 文件无同步 prepare 调用(走 dbOne seam + 控制面 helper)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'
import { toUnits } from '../../money.js'
import { sellerBaseBondEntrySatisfied } from '../../direct-pay-base-bond-entry.js'
import { evaluateDirectPayLaunchControls, readDirectPayControlsConfig, sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear, sellerDirectPayBreakerTripped } from '../../direct-pay-controls.js'
import { checkDeferralQuota, readDeferralQuotaConfig } from '../../direct-pay-deferral-quota.js'
import { sellerDirectPayReadinessView } from '../../direct-pay-launch-readiness.js'
import { requestDeferral, getActiveDeferral, getLatestDeferral } from '../../direct-receive-deferral.js'

export interface DirectPayAvailabilityDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
  generateId: (prefix: string) => string
}

// 卖家合规类拒绝 → 对外通用码(不暴露具体是 base-bond 还是 KYC/制裁)。其余(全局/地区/上限)非敏感,原样透出。
const SELLER_PRIVATE_REASONS = new Set(['DIRECT_PAY_NOT_AVAILABLE', 'DIRECT_PAY_KYC_REQUIRED', 'DIRECT_PAY_AML_REVIEW_REQUIRED', 'DIRECT_PAY_SELLER_SUSPENDED'])

export function registerDirectPayAvailabilityRoutes(app: Application, deps: DirectPayAvailabilityDeps): void {
  const { db, auth, getProtocolParam, generateId } = deps

  /** 登录 + seller 角色门(缓交申请仅卖家本人)。返回 user 或 null(已写错误响应)。 */
  function requireSeller(req: Request, res: Response): Record<string, unknown> | null {
    const user = auth(req, res); if (!user) return null
    if (user.role !== 'seller') { res.status(403).json({ error: '仅卖家可申请缓交', error_code: 'SELLER_ONLY' }); return null }
    return user
  }

  // GET /api/direct-pay/availability?product_id=... — 该商品(以 qty=1 计)当前是否可直付 + 不可用原因(脱敏)。
  app.get('/api/direct-pay/availability', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const productId = String(req.query.product_id || '')
    if (!productId) return void res.status(400).json({ error: '缺少 product_id', error_code: 'MISSING_PRODUCT_ID' })
    const product = await dbOne<{ seller_id: string; price: number }>(
      'SELECT seller_id, price FROM products WHERE id = ?', [productId])
    if (!product) return void res.status(404).json({ error: '商品不存在', error_code: 'PRODUCT_NOT_FOUND' })

    const cfg = readDirectPayControlsConfig(getProtocolParam)
    const decision = evaluateDirectPayLaunchControls(cfg, {
      amountUnits: toUnits(Number(product.price) || 0),
      sellerBreakerTripped: sellerDirectPayBreakerTripped(db, product.seller_id),  // 与 create 路径同源:卖家熔断也判不可用
      baseBondSatisfied: sellerBaseBondEntrySatisfied(db, product.seller_id, new Date().toISOString()),
      kycSanctionsPassed: sellerDirectPayKybPassed(db, product.seller_id) && sellerDirectPaySanctionsClear(db, product.seller_id),
      amlClear: sellerDirectPayAmlClear(db, product.seller_id),
    })
    if (decision.ok) {
      // 镜像 create 的缓交额度门(qty=1 预览;以商品单价为本次拟建单金额)。超额是【缓交卖家私密状态】→ 收敛为通用不可用,
      //   不向买家暴露"该卖家在缓交期/已超额"。create 仍是权威强制点。
      const quota = checkDeferralQuota(db, product.seller_id, toUnits(Number(product.price) || 0), new Date().toISOString(), readDeferralQuotaConfig(getProtocolParam))
      if (!quota.ok) return void res.json({ available: false, error_code: 'DIRECT_PAY_SELLER_NOT_ELIGIBLE', reason: '该卖家暂不支持直付', per_tx_cap_units: cfg.perTxCapUnits })
      return void res.json({ available: true, per_tx_cap_units: cfg.perTxCapUnits })
    }
    const code = SELLER_PRIVATE_REASONS.has(decision.error_code as string) ? 'DIRECT_PAY_SELLER_NOT_ELIGIBLE' : decision.error_code
    return void res.json({
      available: false,
      error_code: code,
      reason: code === 'DIRECT_PAY_SELLER_NOT_ELIGIBLE' ? '该卖家暂不支持直付' : decision.reason,
      per_tx_cap_units: cfg.perTxCapUnits,
    })
  })

  // GET /api/direct-receive/readiness — 卖家【自助脱敏】readiness:仅可行动/状态项(收款说明/Passkey/保证金/审核/暂停/平台开放)。
  //   绝不下发 raw blocker / KYB·制裁·AML 分项(见 sellerDirectPayReadinessView)。只读 self(auth 用户自身 id)。
  app.get('/api/direct-receive/readiness', (req, res) => {
    const user = auth(req, res); if (!user) return
    return void res.json(sellerDirectPayReadinessView(db, { getProtocolParam, sellerId: user.id as string }))
  })

  // ── 缓交(base-bond deferred deposit)卖家自助:申请 + 查看自己的状态。授予【绝不】在此发生 ──
  //   申请只创建 pending 行(requestDeferral),【不授予任何权限/资格】;真正放行 = admin ROOT + 真人 Passkey 审批
  //   (POST /api/admin/direct-receive/deferrals/:id/approve)。故 apply 本身非 RISK 动作、不需 Passkey:无论谁(含 agent)
  //   申请都拿不到资格,安全门坐落在审批侧。所有合规门(KYC/KYB/制裁/AML/收款说明/Passkey)在直付建单时仍逐一 AND,缓交只免"先交保证金"。
  // POST /api/direct-receive/deferral — 卖家申请缓交。helper 强制:单一活跃、periodDays 正整数、id 唯一。
  app.post('/api/direct-receive/deferral', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : undefined
    const periodDays = req.body?.period_days != null ? Number(req.body.period_days) : undefined
    const r = requestDeferral(db, { deferralId: generateId('dfr'), userId: user.id as string, periodDays, reason, nowIso: new Date().toISOString() })
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'DEFERRAL_REQUEST_REJECTED' })
    return void res.json({ ok: true, status: r.status })
  })

  // GET /api/direct-receive/deferral — 卖家本人缓交状态:最新一条申请(脱敏:不含 admin 身份)+ 是否当前生效(active)。
  app.get('/api/direct-receive/deferral', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const sellerId = user.id as string
    const latest = getLatestDeferral(db, sellerId)   // 脱敏:不含 approved_by/approved_at(admin 身份)
    const active = getActiveDeferral(db, sellerId, new Date().toISOString())
    return void res.json({
      deferral: latest,
      active: active ? { reduced_quota_factor: active.reducedQuotaFactor, expires_at: active.expiresAt, grace_until: active.graceUntil, in_grace: active.inGrace } : null,
    })
  })
}
