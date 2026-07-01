/**
 * 物流 — 公司列表 + 可接订单/进行中订单
 *
 * 由 #1013 Phase 103 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/logistics/companies   公开列表（卖家发货选择）
 *   GET /api/logistics/orders      仅 logistics 角色：available + mine
 *
 * 跨域注入：auth
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { stripDirectPayPaymentTarget } from '../direct-pay-order-redaction.js'  // 披露门:物流第三方绝不该见收款目标

export interface LogisticsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerLogisticsRoutes(app: Application, deps: LogisticsDeps): void {
  // db 已走 RFC-016 异步 seam(dbAll),不再直接用 deps.db
  const { auth } = deps

  app.get('/api/logistics/companies', async (_req, res) => {
    const companies = await dbAll(
      `SELECT id, name FROM users WHERE role = 'logistics' ORDER BY name ASC`
    )
    res.json(companies)
  })

  app.get('/api/logistics/orders', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if ((user as Record<string, unknown>).role !== 'logistics') return void res.status(403).json({ error: '仅限物流角色' })

    const available = await dbAll(`
      SELECT o.*, p.title as product_title, p.category,
        ub.name as buyer_name, us.name as seller_name
      FROM orders o
      JOIN products p ON o.product_id = p.id
      JOIN users ub ON o.buyer_id = ub.id
      JOIN users us ON o.seller_id = us.id
      WHERE o.status = 'shipped' AND (o.logistics_id IS NULL OR o.logistics_id = '')
      ORDER BY o.created_at ASC LIMIT 20
    `)

    const mine = await dbAll(`
      SELECT o.*, p.title as product_title, p.category,
        ub.name as buyer_name, us.name as seller_name
      FROM orders o
      JOIN products p ON o.product_id = p.id
      JOIN users ub ON o.buyer_id = ub.id
      JOIN users us ON o.seller_id = us.id
      WHERE o.logistics_id = ? AND o.status IN ('shipped','picked_up','in_transit')
      ORDER BY o.created_at ASC LIMIT 20
    `, [user.id])

    // 披露门:物流是非买家第三方,无条件删除 direct_p2p 收款目标(instruction 快照 + 账号快照);物流只需商品/状态/地址。
    for (const o of [...(available as Array<Record<string, unknown>>), ...(mine as Array<Record<string, unknown>>)]) stripDirectPayPaymentTarget(o)
    res.json({ available, mine })
  })
}
