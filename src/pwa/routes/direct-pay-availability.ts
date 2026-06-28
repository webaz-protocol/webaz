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
import { sellerHasProductionBaseBondLocked } from '../../direct-receive-deposits.js'
import { evaluateDirectPayLaunchControls, readDirectPayControlsConfig, sellerDirectPayKybPassed, sellerDirectPaySanctionsClear, sellerDirectPayAmlClear, sellerDirectPayBreakerTripped } from '../../direct-pay-controls.js'
import { sellerDirectPayReadinessView } from '../../direct-pay-launch-readiness.js'

export interface DirectPayAvailabilityDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
}

// 卖家合规类拒绝 → 对外通用码(不暴露具体是 base-bond 还是 KYC/制裁)。其余(全局/地区/上限)非敏感,原样透出。
const SELLER_PRIVATE_REASONS = new Set(['DIRECT_PAY_NOT_AVAILABLE', 'DIRECT_PAY_KYC_REQUIRED', 'DIRECT_PAY_AML_REVIEW_REQUIRED', 'DIRECT_PAY_SELLER_SUSPENDED'])

export function registerDirectPayAvailabilityRoutes(app: Application, deps: DirectPayAvailabilityDeps): void {
  const { db, auth, getProtocolParam } = deps

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
      productionBaseBondLocked: sellerHasProductionBaseBondLocked(db, product.seller_id),
      kycSanctionsPassed: sellerDirectPayKybPassed(db, product.seller_id) && sellerDirectPaySanctionsClear(db, product.seller_id),
      amlClear: sellerDirectPayAmlClear(db, product.seller_id),
    })
    if (decision.ok) return void res.json({ available: true, per_tx_cap_units: cfg.perTxCapUnits })
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
}
