/**
 * 技能市场域（知识技能 / Knowledge Skill Marketplace）— L4-4
 *
 * 人人可发布内容型技能（模板/提示词/指南/清单），经 WebAZ 内容审计后上架，
 * 他人按 免费 / 一次性 / 按次 三种模式付费解锁。收入独立流转（作者净额入钱包，
 * 协议费入 sys_protocol），不进入 PV / 推土机佣金引擎。
 *
 * 端点：
 *   GET   /api/skill-market                   公开列表（filters: category/kind/billing/q）
 *   GET   /api/skill-market/mine              我发布的（含各审核状态）
 *   GET   /api/skill-market/library           我的技能库（已解锁 + 按次使用过）
 *   GET   /api/skill-market/:id               公开详情（登录时附 owned 标记）
 *   POST  /api/skill-market                   发布（任意登录用户）
 *   PATCH /api/skill-market/:id               修改（仅作者；改 approved 触发重审）
 *   POST  /api/skill-market/:id/delist        下架（仅作者）
 *   POST  /api/skill-market/:id/resubmit      重新提交审核（仅作者）
 *   POST  /api/skill-market/:id/purchase      购买/解锁 free|one_time（自己不能买自己）
 *   POST  /api/skill-market/:id/read          读取正文（per_use 在此按次扣费）
 *   GET   /api/admin/skill-market/pending     待审列表（content admin）
 *   POST  /api/admin/skill-market/:id/audit   审核 approve/reject（content admin）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import {
  publishListing,
  updateListing,
  delistListing,
  resubmitListing,
  listMarket,
  getMarketDetail,
  getMyListings,
  purchaseListing,
  readContent,
  getMyLibrary,
  listPendingAudit,
  auditListing,
  type SkillKind,
  type SkillBillingMode,
} from '../../layer4-economics/L4-4-skill-market/skill-listing-engine.js'

export interface SkillMarketDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getUser: (req: Request) => Record<string, unknown> | null
  requireContentAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerSkillMarketRoutes(app: Application, deps: SkillMarketDeps): void {
  const { db, generateId, auth, getUser, requireContentAdmin, getProtocolParam } = deps
  const feeRate = () => getProtocolParam<number>('skill_fee_rate', 0.05)
  const notify = async (userId: string, title: string, body: string) => {
    try {
      await dbRun('INSERT INTO notifications (id, user_id, title, body, order_id) VALUES (?,?,?,?,?)',
        [generateId('ntf'), userId, title, body, null])
    } catch { /* notifications best-effort */ }
  }

  // ─── 公开列表 ───────────────────────────────────────────────
  app.get('/api/skill-market', async (req, res) => {
    const user = getUser(req)
    res.json(await listMarket(db, {
      category: req.query.category as string | undefined,
      skillKind: req.query.kind as SkillKind | undefined,
      billingMode: req.query.billing as SkillBillingMode | undefined,
      query: req.query.q as string | undefined,
      viewerId: user?.id as string | undefined,
      limit: 30,
    }))
  })

  // ─── 我发布的（须在 /:id 之前注册）───────────────────────────
  app.get('/api/skill-market/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(await getMyListings(db, user.id as string))
  })

  // ─── 我的技能库 ─────────────────────────────────────────────
  app.get('/api/skill-market/library', async (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(await getMyLibrary(db, user.id as string))
  })

  // ─── 公开详情 ───────────────────────────────────────────────
  app.get('/api/skill-market/:id', async (req, res) => {
    const user = getUser(req)
    const detail = await getMarketDetail(db, req.params.id, user?.id as string | undefined)
    if (!detail) return void res.status(404).json({ error: '技能不存在或未上架' })
    res.json(detail)
  })

  // ─── 发布（任意登录用户）────────────────────────────────────
  app.post('/api/skill-market', (req, res) => {
    const user = auth(req, res); if (!user) return
    const b = req.body as Record<string, unknown>
    try {
      const listing = publishListing(db, {
        authorId: user.id as string,
        title: String(b.title ?? ''),
        summary: b.summary != null ? String(b.summary) : undefined,
        preview: b.preview != null ? String(b.preview) : undefined,
        content: String(b.content ?? ''),
        category: b.category != null ? String(b.category) : undefined,
        skillKind: b.skill_kind as SkillKind | undefined,
        billingMode: b.billing_mode as SkillBillingMode,
        price: b.price != null ? Number(b.price) : 0,
      })
      res.json({ success: true, listing })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ─── 修改 ───────────────────────────────────────────────────
  app.patch('/api/skill-market/:id', (req, res) => {
    const user = auth(req, res); if (!user) return
    const b = req.body as Record<string, unknown>
    try {
      const listing = updateListing(db, req.params.id, user.id as string, {
        title: b.title != null ? String(b.title) : undefined,
        summary: b.summary != null ? String(b.summary) : undefined,
        preview: b.preview != null ? String(b.preview) : undefined,
        content: b.content != null ? String(b.content) : undefined,
        category: b.category != null ? String(b.category) : undefined,
        skillKind: b.skill_kind as SkillKind | undefined,
        billingMode: b.billing_mode as SkillBillingMode | undefined,
        price: b.price != null ? Number(b.price) : undefined,
      })
      res.json({ success: true, listing })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ─── 下架 ───────────────────────────────────────────────────
  app.post('/api/skill-market/:id/delist', (req, res) => {
    const user = auth(req, res); if (!user) return
    try { delistListing(db, req.params.id, user.id as string); res.json({ success: true }) }
    catch (err) { res.status(400).json({ error: (err as Error).message }) }
  })

  // ─── 重新提交审核 ───────────────────────────────────────────
  app.post('/api/skill-market/:id/resubmit', (req, res) => {
    const user = auth(req, res); if (!user) return
    try { resubmitListing(db, req.params.id, user.id as string); res.json({ success: true }) }
    catch (err) { res.status(400).json({ error: (err as Error).message }) }
  })

  // ─── 购买 / 解锁（free | one_time）──────────────────────────
  app.post('/api/skill-market/:id/purchase', (req, res) => {
    const user = auth(req, res); if (!user) return
    try { res.json(purchaseListing(db, user.id as string, req.params.id, feeRate())) }
    catch (err) { res.status(400).json({ error: (err as Error).message }) }
  })

  // ─── 读取正文（per_use 按次扣费）────────────────────────────
  app.post('/api/skill-market/:id/read', (req, res) => {
    const user = auth(req, res); if (!user) return
    try { res.json(readContent(db, user.id as string, req.params.id, feeRate())) }
    catch (err) { res.status(400).json({ error: (err as Error).message }) }
  })

  // ─── Admin：待审列表 ────────────────────────────────────────
  app.get('/api/admin/skill-market/pending', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    res.json({ items: await listPendingAudit(db) })
  })

  // ─── Admin：审核 ────────────────────────────────────────────
  app.post('/api/admin/skill-market/:id/audit', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const { decision, note } = req.body as { decision?: string; note?: string }
    if (decision !== 'approve' && decision !== 'reject') {
      return void res.status(400).json({ error: 'decision 必须是 approve 或 reject' })
    }
    try {
      const listing = auditListing(db, req.params.id, admin.id as string, decision, note)
      if (decision === 'approve') {
        await notify(listing.author_id, '✓ 技能审核通过', `「${listing.title}」已上架技能市场`)
      } else {
        await notify(listing.author_id, '✗ 技能审核未通过', `「${listing.title}」被退回：${note ?? ''}`)
      }
      res.json({ success: true, listing })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })
}
