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
import { evaluateDirectPayLaunchControls, readDirectPayControlsConfig, sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear, sellerDirectPayBreakerTripped, coarsenBuyerFacingDirectPayCode, DIRECT_PAY_SELLER_NOT_ELIGIBLE } from '../../direct-pay-controls.js'
import { checkDeferralQuota, readDeferralQuotaConfig } from '../../direct-pay-deferral-quota.js'
import { sellerDirectPayReadinessView } from '../../direct-pay-launch-readiness.js'
import { requestDeferral, getActiveDeferral, getLatestDeferral } from '../../direct-receive-deferral.js'
import { requestProductVerification, submitProductVerificationLink, listSellerProductVerifications, toSellerProductVerificationView, productStoreVerified } from '../../product-verification.js'

export interface DirectPayAvailabilityDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
  generateId: (prefix: string) => string
}

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
      // 硬门(镜像 create):该产品必须【单独】通过验证。未验证 → 不可直付(产品级、非敏感)。
      if (!productStoreVerified(db, productId)) return void res.json({ available: false, error_code: 'DIRECT_PAY_PRODUCT_NOT_VERIFIED', reason: '该商品暂不支持直付(待平台逐品验证)', per_tx_cap_units: cfg.perTxCapUnits })
      // 镜像 create 的缓交额度门(qty=1 预览;以商品单价为本次拟建单金额)。超额是【缓交卖家私密状态】→ 收敛为通用不可用,
      //   不向买家暴露"该卖家在缓交期/已超额"。create 仍是权威强制点。
      const quota = checkDeferralQuota(db, product.seller_id, toUnits(Number(product.price) || 0), new Date().toISOString(), readDeferralQuotaConfig(getProtocolParam))
      if (!quota.ok) return void res.json({ available: false, error_code: coarsenBuyerFacingDirectPayCode(quota.code), reason: '该卖家暂不支持直付', per_tx_cap_units: cfg.perTxCapUnits })
      return void res.json({ available: true, per_tx_cap_units: cfg.perTxCapUnits })
    }
    const code = coarsenBuyerFacingDirectPayCode(decision.error_code as string)
    return void res.json({
      available: false,
      error_code: code,
      reason: code === DIRECT_PAY_SELLER_NOT_ELIGIBLE ? '该卖家暂不支持直付' : decision.reason,
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

  // ── 按产品认证(per-product verification)卖家自助:申领验证码 → 提交外部商品链接 → 查看逐产品状态 ──
  //   硬门:每个直付商品都须【单独】被真人 admin 核验;一次验证绝不放行所有产品。这里只建/改记录,verify 在 admin 侧。
  //   所有权:必须卖家本人拥有该产品(读 products.seller_id 校验),否则 403。

  /** 校验登录卖家拥有该产品;返回 owner user(含 id)或 null(已写错误响应)。productId 由调用方持有。 */
  async function requireOwnedProduct(req: Request, res: Response, productId: string): Promise<Record<string, unknown> | null> {
    const user = requireSeller(req, res); if (!user) return null
    if (!productId) { res.status(400).json({ error: '缺少 product_id', error_code: 'MISSING_PRODUCT_ID' }); return null }
    const product = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [productId])
    if (!product) { res.status(404).json({ error: '商品不存在', error_code: 'PRODUCT_NOT_FOUND' }); return null }
    if (product.seller_id !== user.id) { res.status(403).json({ error: '只能为自己的商品申请认证', error_code: 'NOT_PRODUCT_OWNER' }); return null }
    return user
  }

  // POST /api/direct-receive/product-verification — 卖家为某产品申领验证码(单一活跃 per product)。
  app.post('/api/direct-receive/product-verification', async (req, res) => {
    const productId = String(req.body?.product_id || '')
    const user = await requireOwnedProduct(req, res, productId); if (!user) return
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim().slice(0, 60) : undefined
    const r = requestProductVerification(db, { id: generateId('pv'), productId, sellerId: user.id as string, code: generateId('wzv'), platform })
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'PRODUCT_VERIFICATION_REJECTED' })
    return void res.json({ ok: true, status: r.status, code: r.code })
  })

  // PUT /api/direct-receive/product-verification — 卖家为某产品提交外部商品链接(链接仅存储,WebAZ 不抓取)。
  app.put('/api/direct-receive/product-verification', async (req, res) => {
    const productId = String(req.body?.product_id || '')
    const user = await requireOwnedProduct(req, res, productId); if (!user) return
    const externalUrl = typeof req.body?.external_url === 'string' ? req.body.external_url.trim() : ''
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim().slice(0, 60) : undefined
    const r = submitProductVerificationLink(db, { productId, externalUrl, platform })
    if (!r.ok) return void res.status(400).json({ error: r.reason, error_code: 'PRODUCT_VERIFICATION_SUBMIT_REJECTED' })
    return void res.json({ ok: true, status: r.status })
  })

  // GET /api/direct-receive/product-verifications — 卖家本人所有产品的认证状态(逐产品)。
  app.get('/api/direct-receive/product-verifications', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    // 脱敏:DTO 去掉 reviewed_by(admin 身份)+ notes(内部审核备注),与缓交/readiness 卖家侧一致。
    return void res.json({ verifications: listSellerProductVerifications(db, user.id as string).map(toSellerProductVerificationView) })
  })
}
