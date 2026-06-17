/**
 * Skill 市场域 (L4-4)
 *
 * 由 #1013 Phase 33 从 src/pwa/server.ts 抽出。
 *
 * 8 endpoints:
 *   GET    /api/skills                       浏览（公开，无需登录）
 *   GET    /api/skills/mine                  我发布的
 *   GET    /api/skills/subscriptions         我订阅的
 *   POST   /api/skills                       发布（含 trust level + config 边界校验）
 *   PATCH  /api/skills/:id                   修改（仅 owner）
 *   POST   /api/skills/:id/disable           停用（active=0 快捷）
 *   POST   /api/skills/:id/subscribe         订阅
 *   DELETE /api/skills/:id/subscribe         取消订阅
 *
 * 边界（P0/P1 audit fix 5.1/5.2）：
 *   - 仅 role=seller 可发布
 *   - skill_type 等级门槛：price_negotiation/quality_guarantee → quality+；
 *     catalog_sync → trusted+；其余 → new
 *   - config 边界：max_discount_pct 0-0.5 / guarantee_amount 0-100k /
 *     coverage_days 0-365 / ship_within_hours 1-168 / max_daily_orders 1-10k
 *
 * 跨域：所有 helpers 来自 L4-4 skill-engine
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  publishSkill,
  listSkills,
  getMySkills,
  subscribeSkill,
  unsubscribeSkill,
  getMySubscriptions,
  type SkillType,
} from '../../layer4-economics/L4-4-skill-market/skill-engine.js'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const SKILL_TRUST_REQ: Record<string, 'new' | 'trusted' | 'quality'> = {
  price_negotiation: 'quality',
  quality_guarantee: 'quality',
  catalog_sync: 'trusted',
  auto_accept: 'new',
  instant_ship: 'new',
}
const LEVEL_ORDER = ['new', 'trusted', 'quality', 'legend']

export interface SkillsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getUser: (req: Request) => Record<string, unknown> | null
}

export function registerSkillsRoutes(app: Application, deps: SkillsDeps): void {
  const { db, auth, getUser } = deps

  // 公开浏览
  app.get('/api/skills', async (req, res) => {
    const user = getUser(req)
    const skills = await listSkills(db, {
      skillType: req.query.type as SkillType | undefined,
      query: req.query.q as string | undefined,
      subscriberId: user?.id as string | undefined,
      limit: 30,
    })
    res.json(skills)
  })

  app.get('/api/skills/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(await getMySkills(db, user.id as string))
  })

  app.get('/api/skills/subscriptions', async (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(await getMySubscriptions(db, user.id as string))
  })

  // 发布
  app.post('/api/skills', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '只有卖家才能发布 Skill' })
    const { name, description, category, skill_type, config } = req.body
    if (!name || !description || !skill_type) return void res.json({ error: '请填写 name、description、skill_type' })

    // trust level 门槛
    const required = SKILL_TRUST_REQ[skill_type as string] || 'new'
    if (required !== 'new') {
      const rep = await dbOne<{ level: string }>(`SELECT level FROM agent_reputation WHERE api_key = ?`, [user.api_key])
      const myLevel = rep?.level || 'new'
      if (LEVEL_ORDER.indexOf(myLevel) < LEVEL_ORDER.indexOf(required)) {
        return void res.status(403).json({
          error: `发布 ${skill_type} 类型 Skill 需要 ${required}+ 等级（你当前 ${myLevel}）`,
          error_code: 'SKILL_TRUST_LEVEL_REQUIRED',
          required, current: myLevel,
        })
      }
    }

    // config 边界
    const cfg = (config && typeof config === 'object') ? config as Record<string, unknown> : {}
    if (skill_type === 'price_negotiation') {
      const maxDiscount = Number(cfg.max_discount_pct ?? 0)
      if (!Number.isFinite(maxDiscount) || maxDiscount < 0 || maxDiscount > 0.5) {
        return void res.json({ error: 'price_negotiation: max_discount_pct 必须 0-0.5（即 0%-50%）' })
      }
      const minQty = Number(cfg.min_quantity ?? 1)
      if (!Number.isInteger(minQty) || minQty < 1 || minQty > 10000) {
        return void res.json({ error: 'price_negotiation: min_quantity 必须 1-10000 整数' })
      }
    }
    if (skill_type === 'quality_guarantee') {
      const guarantee = Number(cfg.guarantee_amount ?? 0)
      if (!Number.isFinite(guarantee) || guarantee < 0 || guarantee > 100000) {
        return void res.json({ error: 'quality_guarantee: guarantee_amount 必须 0-100000 WAZ' })
      }
      const coverDays = Number(cfg.coverage_days ?? 0)
      if (!Number.isInteger(coverDays) || coverDays < 0 || coverDays > 365) {
        return void res.json({ error: 'quality_guarantee: coverage_days 必须 0-365 整数' })
      }
    }
    if (skill_type === 'instant_ship') {
      const shipHrs = Number(cfg.ship_within_hours ?? 24)
      if (!Number.isInteger(shipHrs) || shipHrs < 1 || shipHrs > 168) {
        return void res.json({ error: 'instant_ship: ship_within_hours 必须 1-168 整数（最多 7 天）' })
      }
    }
    if (skill_type === 'auto_accept') {
      const maxDaily = Number(cfg.max_daily_orders ?? 0)
      if (cfg.max_daily_orders != null && (!Number.isInteger(maxDaily) || maxDaily < 1 || maxDaily > 10000)) {
        return void res.json({ error: 'auto_accept: max_daily_orders 必须 1-10000 整数' })
      }
    }
    try {
      const skill = publishSkill(db, {
        sellerId: user.id as string,
        name, description, category,
        skillType: skill_type as SkillType,
        config: cfg,
      })
      res.json({ success: true, skill })
    } catch (err) {
      res.json({ error: (err as Error).message })
    }
  })

  // 卖家：修改 Skill
  app.patch('/api/skills/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const skill = await dbOne<{ seller_id: string }>('SELECT seller_id FROM skills WHERE id = ?', [req.params.id])
    if (!skill) return void res.status(404).json({ error: 'Skill 不存在' })
    if (skill.seller_id !== user.id) return void res.status(403).json({ error: '仅 Skill owner 可修改' })
    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const args: unknown[] = []
    if (body.config !== undefined) { updates.push('config = ?'); args.push(JSON.stringify(body.config ?? {})) }
    if (body.active !== undefined) { updates.push('active = ?'); args.push(body.active ? 1 : 0) }
    if (body.name && typeof body.name === 'string') { updates.push('name = ?'); args.push(body.name) }
    if (body.description && typeof body.description === 'string') { updates.push('description = ?'); args.push(body.description) }
    if (!updates.length) return void res.json({ error: '无任何修改' })
    args.push(req.params.id)
    await dbRun(`UPDATE skills SET ${updates.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })

  // 卖家：停用
  app.post('/api/skills/:id/disable', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const skill = await dbOne<{ seller_id: string }>('SELECT seller_id FROM skills WHERE id = ?', [req.params.id])
    if (!skill) return void res.status(404).json({ error: 'Skill 不存在' })
    if (skill.seller_id !== user.id) return void res.status(403).json({ error: '仅 Skill owner 可停用' })
    await dbRun("UPDATE skills SET active = 0 WHERE id = ?", [req.params.id])
    res.json({ success: true })
  })

  // 订阅
  app.post('/api/skills/:id/subscribe', (req, res) => {
    const user = auth(req, res); if (!user) return
    try {
      const result = subscribeSkill(db, user.id as string, req.params.id, req.body?.config ?? {})
      res.json(result)
    } catch (err) {
      res.json({ error: (err as Error).message })
    }
  })

  // 取消订阅
  app.delete('/api/skills/:id/subscribe', (req, res) => {
    const user = auth(req, res); if (!user) return
    unsubscribeSkill(db, user.id as string, req.params.id)
    res.json({ success: true })
  })
}
