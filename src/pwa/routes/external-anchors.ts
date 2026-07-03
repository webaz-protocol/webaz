/**
 * External Anchor 域 (L1-2 第三方平台存证锚)
 *
 * 由 #1013 Phase 42 从 src/pwa/server.ts 抽出。
 *
 * 10 endpoints:
 *   POST   /api/external-anchors                              创建（platform/url/canonical/seller_node）
 *   GET    /api/external-anchors/:id/rewards                  分发奖励详情 + 推荐 fee
 *   POST   /api/external-anchors/:id/distribute-rewards       手动分发（admin/arbitrator）
 *   GET    /api/external-anchors/by-product/:id               按商品查
 *   GET    /api/external-anchors/by-seller/:id                按卖家查
 *   GET    /api/external-anchors/:id                          详情
 *   GET    /api/external-anchors/:id/verify-sig               验签
 *   POST   /api/external-anchors/:id/revoke                   撤销
 *   POST   /api/external-anchors/:id/issue-token              发放所有权 token
 *   POST   /api/external-anchors/:id/verify                   verifier 提交独立验证
 *
 * 跨域：所有 helpers 来自 L1-2 anchor-engine
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import {
  createAnchor, verifyAnchorSignature, revokeAnchor, issueOwnershipToken,
  submitVerification, getAnchor, listAnchorsByProduct, listAnchorsBySeller,
  distributeAnchorRewards, ANCHOR_VERIFICATION_FEE_RECOMMENDED,
} from '../../layer1-agent/L1-2-external-anchor/anchor-engine.js'
import { isEligibleArbitrator } from '../arbitrator-lifecycle.js'  // 仲裁能力唯一源=active 白名单(distribute 是动钱动作,不认 legacy role)

export interface ExternalAnchorsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerExternalAnchorsRoutes(app: Application, deps: ExternalAnchorsDeps): void {
  const { db, auth } = deps

  app.post('/api/external-anchors', (req, res) => {
    const user = auth(req, res); if (!user) return
    const { product_id, platform, external_url, canonical, seller_node_url, verification_fee } = req.body || {}
    if (!platform || !external_url || !canonical) return void res.status(400).json({ error: 'platform / external_url / canonical 必填' })
    try {
      const r = createAnchor(db, {
        sellerId: user.id as string,
        productId: product_id ? String(product_id) : null,
        platform: String(platform), externalUrl: String(external_url),
        canonical: canonical as Record<string, unknown>,
        sellerNodeUrl: seller_node_url ? String(seller_node_url) : null,
        verificationFee: verification_fee != null ? Number(verification_fee) : undefined,
      })
      res.json({ ok: true, ...r })
    } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })

  // 透出推荐 fee + anchor 的奖励情况
  app.get('/api/external-anchors/:id/rewards', async (req, res) => {
    const a = await getAnchor(db, req.params.id) as Record<string, unknown> | null
    if (!a) return void res.status(404).json({ error: 'anchor 不存在' })
    const verifications = await dbAll<Record<string, unknown>>(`
      SELECT verifier_id, verifier_role, content_matches, token_found, reward_amount, verified_at
      FROM external_anchor_verifications WHERE anchor_id = ? ORDER BY verified_at ASC
    `, [req.params.id])
    res.json({
      verification_fee: a.verification_fee || 0,
      fee_paid_out: !!a.fee_paid_out,
      ownership_verified: a.ownership_verified,
      recommended_fee: ANCHOR_VERIFICATION_FEE_RECOMMENDED,
      verifications,
      total_paid_out: verifications.reduce((s, v) => s + Number(v.reward_amount || 0), 0),
    })
  })

  // 手动 distribute（admin/白名单仲裁员 补救：anchor 已 community 但 fee_paid_out=0）——动钱动作,仲裁员认 active
  //   白名单(isEligibleArbitrator),不认 legacy user.role(否则已 suspend/revoke 但 role 未同步的账号仍可触发放款)。
  app.post('/api/external-anchors/:id/distribute-rewards', (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'admin' && !isEligibleArbitrator(db, user.id as string).ok) return void res.status(403).json({ error: '仅管理员/仲裁员可手动分发' })
    const paid = distributeAnchorRewards(db, req.params.id)
    res.json({ ok: true, paid })
  })

  app.get('/api/external-anchors/by-product/:id', async (req, res) => {
    res.json({ items: await listAnchorsByProduct(db, req.params.id) })
  })

  app.get('/api/external-anchors/by-seller/:id', async (req, res) => {
    res.json({ items: await listAnchorsBySeller(db, req.params.id) })
  })

  app.get('/api/external-anchors/:id', async (req, res) => {
    const a = await getAnchor(db, req.params.id)
    if (!a) return void res.status(404).json({ error: 'anchor 不存在' })
    res.json(a)
  })

  app.get('/api/external-anchors/:id/verify-sig', async (req, res) => {
    res.json(await verifyAnchorSignature(db, req.params.id))
  })

  app.post('/api/external-anchors/:id/revoke', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = revokeAnchor(db, req.params.id, user.id as string, String(req.body?.reason || 'manual'))
    if (!r.ok) return void res.status(400).json({ error: r.reason })
    res.json({ ok: true })
  })

  app.post('/api/external-anchors/:id/issue-token', (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = issueOwnershipToken(db, req.params.id, user.id as string)
    if (!r.ok) return void res.status(400).json({ error: r.reason })
    res.json(r)
  })

  // verifier 提交独立验证（任何已登录用户可做）
  app.post('/api/external-anchors/:id/verify', (req, res) => {
    const user = auth(req, res); if (!user) return
    const { submitted_canonical, token_found, notes } = req.body || {}
    if (!submitted_canonical) return void res.status(400).json({ error: '请提交独立提取的 canonical 数据' })
    const r = submitVerification(db, {
      anchorId: req.params.id,
      verifierId: user.id as string,
      verifierRole: user.role as string,
      submittedCanonical: submitted_canonical as Record<string, unknown>,
      tokenFoundInExternal: !!token_found,
      notes: notes ? String(notes) : undefined,
    })
    if (!r.ok) return void res.status(400).json({ error: r.reason })
    res.json(r)
  })
}
