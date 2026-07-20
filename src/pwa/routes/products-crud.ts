/**
 * Products CRUD lighter — 单品详情 + 状态切换 + 删除
 *
 * 由 #1013 Phase 92 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET    /api/products/:id          单品详情（agent verify price 用；卖家可看自己非 active）
 *   PATCH  /api/products/:id/status   active / warehouse / deleted 切换
 *                                      (claim_loss_count ≥ 3 禁自助再上架 + verify 任务进行中也禁)
 *   DELETE /api/products/:id          硬删（仅 deleted 状态 + 无进行中订单 + retire anchors）
 *
 * 跨域注入：auth + errorRes + formatProductForAgent + retireAnchorsByTarget
 *           + db （Database 必须，因详情用 token 直查 api_key）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProductsCrudDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  formatProductForAgent: (p: Record<string, unknown>, req?: Request) => Record<string, unknown>
  // 真实签名带 AnchorTargetKind 字面量；用 any 避免泛型对齐
  retireAnchorsByTarget: any
  /** Ops Passkey-in-flow(T6 安全支点):硬删必须现场真人 Passkey。一次性 purpose-bound gate token 消费器
   *  (server.ts createHumanPresence 注入)。裸 api_key(含 agent/ops-bot)无 live assertion → 403。 */
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

export function registerProductsCrudRoutes(app: Application, deps: ProductsCrudDeps): void {
  const { db, auth, errorRes, formatProductForAgent, retireAnchorsByTarget, consumeGateToken } = deps

  // 单品详情（agent verify price 时使用）
  // 卖家可查看自己的非上架商品（编辑页用），其他人只能看 active
  app.get('/api/products/:id', async (req, res) => {
    const token = ((req.headers.authorization as string) || '').replace('Bearer ', '')
    const selfUser = token ? await dbOne<{ id: string }>('SELECT id FROM users WHERE api_key = ?', [token]) : undefined
    const row = await dbOne<Record<string, unknown>>(`
      SELECT p.*, u.name as seller_name,
        COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
      FROM products p
      JOIN users u ON p.seller_id = u.id
      LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
      WHERE p.id = ? AND (p.status = 'active' OR p.seller_id = ?)
    `, [req.params.id, selfUser?.id ?? ''])
    if (!row) return void res.status(404).json({ error: 'not_found' })
    res.json(formatProductForAgent(row, req))
  })

  // 状态切换（active / warehouse / deleted）
  app.patch('/api/products/:id/status', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const { status } = req.body as { status: string }
    if (!['active', 'warehouse', 'deleted'].includes(status)) return void res.json({ error: '无效状态值' })
    const product = await dbOne<{ id: string; claim_loss_count: number }>('SELECT id, claim_loss_count FROM products WHERE id = ? AND seller_id = ?', [req.params.id, user.id])
    if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })
    if (status === 'active') {
      // Sprint 5 audit fix: claim_loss_count >= 3 禁 seller 自助再上架，必须 admin 干预（content 权限）
      if ((product.claim_loss_count || 0) >= 3) {
        return void errorRes(res, 403, 'CLAIM_THRESHOLD_REACHED', `该商品累计 ${product.claim_loss_count} 次声明被验证不实，已达自动下架阈值。需 admin 干预方可重新上架，请联系管理员。`)
      }
      const pendingTask = await dbOne(`SELECT id FROM verify_tasks WHERE product_id=? AND status IN ('code_issued','open')`, [req.params.id])
      if (pendingTask) return void res.json({ error: '链接核验进行中，请等待验证结果后再上架' })
      const hasRevoked = await dbOne(`SELECT id FROM product_external_links WHERE product_id=? AND revoked=1`, [req.params.id])
      const hasValid   = await dbOne(`SELECT id FROM product_external_links WHERE product_id=? AND verified=1 AND (revoked IS NULL OR revoked=0)`, [req.params.id])
      if (hasRevoked && !hasValid) return void res.json({ error: '所有外部链接已失效（主权失效），请先添加新链接后再上架' })
    }
    await dbRun(`UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, req.params.id])
    res.json({ success: true })
  })

  // 硬删（仅 deleted 状态 + 无进行中订单）
  app.delete('/api/products/:id', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<Record<string, unknown>>('SELECT * FROM products WHERE id = ? AND seller_id = ?', [req.params.id, user.id])
    if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })
    // ★T6 安全支点:硬删是破坏性动作,必须现场真人 Passkey。裸 api_key(含 agent/ops-bot,无 live assertion)→ 403。
    //   gate token 绑 product_id(为删 A 拿的 token 不能删 B),一次性消费。归属校验在前 → 非 owner 不会白烧 token。
    //   注:ops-bot 的授权路径是【审批流执行器】(在 DB 层删,不走本 HTTP 路由),故本闸只挡"裸 key 直连本路由"。
    const gate = consumeGateToken(String(user.id), req.header('x-webauthn-token') || undefined, 'product_hard_delete',
      (data) => { const d = data as { product_id?: string } | null; return !!d && d.product_id === req.params.id })
    if (!gate.ok) return void errorRes(res, 403, 'HUMAN_PRESENCE_REQUIRED', gate.reason || '彻底删除需现场真人 Passkey 验证')
    if (product.status !== 'deleted') return void res.json({ error: '请先将商品移入回收箱' })
    const activeOrders = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM orders WHERE product_id = ? AND status NOT IN ('completed','cancelled','refunded','expired')
    `, [req.params.id]))!
    if (activeOrders.n > 0) return void res.json({ error: '该商品有进行中的订单，暂无法删除' })
    await dbRun('DELETE FROM product_external_links WHERE product_id = ?', [req.params.id])
    // E1 anchor GC: 指向该 product 的 active anchor → retired
    try { retireAnchorsByTarget(db, 'product', String(req.params.id)) } catch (e) { console.warn('[anchor-gc product]', (e as Error).message) }
    await dbRun('DELETE FROM products WHERE id = ?', [req.params.id])
    res.json({ success: true })
  })
}
