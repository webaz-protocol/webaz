/**
 * 卖家配额 + 数据中心域
 *
 * 由 #1013 Phase 45 从 src/pwa/server.ts 抽出。
 *
 * 7 endpoints (4 user + 3 admin)：
 *   GET  /api/seller/quota-status                          配额状态 + next_tier + pending 申请
 *   GET  /api/seller/insights                              30d 数据中心（GMV / 客户 / 状态分布）
 *   POST /api/seller/apply-quota-increase                  申请下一档扩容
 *   POST /api/seller/withdraw-quota-application            撤回 pending
 *   GET  /api/admin/quota-applications                     admin 列表
 *   POST /api/admin/quota-applications/:id/approve         批准（max_products 升档）
 *   POST /api/admin/quota-applications/:id/reject          拒绝
 *
 * 边界：
 *   - QUOTA_TIERS = [200, 500, 1000]
 *   - 仅 buyer/seller 角色可申请扩容（seller 主路径）
 *   - approve / reject 需 users 权限 + scope
 *
 * 跨域：
 *   - QUOTA_TIERS / checkSellerCanList 留在 server.ts（路径中也用）— 通过 deps 注入
 *   - safeRoles / adminCanOperateOn / logAdminAction 注入
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface SellerQuotaDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  requireUsersAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  safeRoles: (user: Record<string, unknown> | undefined | null) => string[]
  checkSellerCanList: (user: Record<string, unknown>) => { ok: boolean; reason?: string; daily_limit?: number; daily_used?: number; total?: number; max?: number; new_user?: boolean }
  adminCanOperateOn: (admin: Record<string, unknown>, targetUserId: string, res: Response) => boolean
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  QUOTA_TIERS: number[]
}

export function registerSellerQuotaRoutes(app: Application, deps: SellerQuotaDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { generateId, auth, requireUsersAdmin, safeRoles, checkSellerCanList, adminCanOperateOn, logAdminAction, QUOTA_TIERS } = deps

  // 配额状态
  app.get('/api/seller/quota-status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller' && !safeRoles(user).includes('seller')) {
      return void res.json({ error: '仅卖家可查看配额' })
    }
    const status = checkSellerCanList(user)
    const pending = await dbOne<Record<string, unknown>>("SELECT id, requested_quota, applied_at FROM quota_increase_applications WHERE user_id = ? AND status = 'pending' ORDER BY applied_at DESC LIMIT 1", [user.id])
    const max = Number(user.max_products ?? 200)
    const nextTierIdx = QUOTA_TIERS.indexOf(max)
    const nextTier = nextTierIdx >= 0 && nextTierIdx < QUOTA_TIERS.length - 1 ? QUOTA_TIERS[nextTierIdx + 1] : null
    res.json({
      max_products:        max,
      total_used:          status.total ?? 0,
      daily_limit:         status.daily_limit,
      daily_used:          status.daily_used ?? 0,
      new_user:            !!status.new_user,
      listing_paused:      !!user.listing_paused,
      listing_paused_reason: user.listing_paused_reason ?? null,
      next_tier:           nextTier,
      pending_application: pending ?? null,
      can_list:            status.ok,
      block_reason:        status.reason ?? null,
    })
  })

  // 数据中心（30d GMV / 7d 曲线 / Top 5 / 客户洞察 / 状态分布）
  app.get('/api/seller/insights', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const roles = safeRoles(user)
    if (user.role !== 'seller' && !roles.includes('seller')) {
      return void res.json({ error: '仅卖家可查看' })
    }
    const sellerId = user.id
    const now = Date.now()
    // SQLite datetime('now') 返回 'YYYY-MM-DD HH:MM:SS' — 用同格式避免字典比较错位
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
    const d30 = fmt(new Date(now - 30 * 86400000))
    const d60 = fmt(new Date(now - 60 * 86400000))

    const orders = await dbAll<{
      id: string; product_id: string; buyer_id: string; status: string;
      total_amount: number; created_at: string; product_title: string; buyer_name: string; payment_rail: string | null;
    }>(`
      SELECT o.id, o.product_id, o.buyer_id, o.status, o.total_amount, o.created_at, o.payment_rail,
             COALESCE(p.title, '已下架商品') as product_title,
             COALESCE(ub.name, '匿名') as buyer_name
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN users ub ON o.buyer_id = ub.id
      WHERE o.seller_id = ? AND o.created_at >= ?
      ORDER BY o.created_at DESC
    `, [sellerId, d60]) as Array<{
      id: string; product_id: string; buyer_id: string; status: string;
      total_amount: number; created_at: string; product_title: string; buyer_name: string; payment_rail: string | null;
    }>

    const completedStatuses = new Set(['completed', 'confirmed'])
    const disputedStatuses = new Set(['disputed', 'fault_seller', 'fault_buyer', 'fault_logistics', 'resolved_for_seller', 'refunded_partial', 'refunded_full', 'dispute_dismissed'])
    const cancelledStatuses = new Set(['cancelled', 'expired'])

    const inLast30 = orders.filter(o => o.created_at >= d30)
    const inPrev30 = orders.filter(o => o.created_at < d30)
    const gmv = (arr: typeof orders) => arr.filter(o => completedStatuses.has(o.status)).reduce((s, o) => s + Number(o.total_amount || 0), 0)
    // GMV 按支付轨拆分:托管=平台真实托管收入,直接收款=场外收款(平台不经手)—— 不再混算(诚实口径)
    const gmvRail = (arr: typeof orders, rail: 'escrow' | 'direct_p2p') => arr.filter(o => completedStatuses.has(o.status) && (rail === 'direct_p2p' ? o.payment_rail === 'direct_p2p' : (o.payment_rail || 'escrow') === 'escrow')).reduce((s, o) => s + Number(o.total_amount || 0), 0)
    const curGmv = gmv(inLast30)
    const prevGmv = gmv(inPrev30)
    const curCount = inLast30.length
    const prevCount = inPrev30.length

    // 7 天日序列
    const daily: { date: string; orders: number; gmv: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now - i * 86400000).toISOString().slice(0, 10)
      const day = inLast30.filter(o => (o.created_at || '').startsWith(dt))
      daily.push({
        date: dt,
        orders: day.length,
        gmv: day.filter(o => completedStatuses.has(o.status)).reduce((s, o) => s + Number(o.total_amount || 0), 0),
      })
    }

    // Top 5 商品（30 天 GMV）
    const productAgg = new Map<string, { product_id: string; title: string; gmv: number; count: number }>()
    for (const o of inLast30) {
      if (!completedStatuses.has(o.status)) continue
      const cur = productAgg.get(o.product_id) || { product_id: o.product_id, title: o.product_title, gmv: 0, count: 0 }
      cur.gmv += Number(o.total_amount || 0)
      cur.count += 1
      productAgg.set(o.product_id, cur)
    }
    const topProducts = [...productAgg.values()].sort((a, b) => b.gmv - a.gmv).slice(0, 5)

    // 客户洞察
    const customerAgg = new Map<string, { buyer_id: string; name: string; gmv: number; count: number }>()
    for (const o of inLast30) {
      if (!completedStatuses.has(o.status)) continue
      const cur = customerAgg.get(o.buyer_id) || { buyer_id: o.buyer_id, name: o.buyer_name || '匿名', gmv: 0, count: 0 }
      cur.gmv += Number(o.total_amount || 0)
      cur.count += 1
      customerAgg.set(o.buyer_id, cur)
    }
    const customers = [...customerAgg.values()]
    const uniqueBuyers = customers.length
    const repeatBuyers = customers.filter(c => c.count >= 2).length
    const repeatRate = uniqueBuyers > 0 ? repeatBuyers / uniqueBuyers : 0
    const topCustomers = customers.sort((a, b) => b.gmv - a.gmv).slice(0, 3)

    const statusBreakdown = {
      completed: inLast30.filter(o => completedStatuses.has(o.status)).length,
      disputed:  inLast30.filter(o => disputedStatuses.has(o.status)).length,
      cancelled: inLast30.filter(o => cancelledStatuses.has(o.status)).length,
      in_progress: inLast30.filter(o => !completedStatuses.has(o.status) && !disputedStatuses.has(o.status) && !cancelledStatuses.has(o.status)).length,
    }
    const totalConcluded = statusBreakdown.completed + statusBreakdown.disputed + statusBreakdown.cancelled
    const completeRate = totalConcluded > 0 ? statusBreakdown.completed / totalConcluded : 0
    const disputeRate = totalConcluded > 0 ? statusBreakdown.disputed / totalConcluded : 0

    const completedOrders30 = inLast30.filter(o => completedStatuses.has(o.status))
    const aov = completedOrders30.length > 0 ? curGmv / completedOrders30.length : 0

    res.json({
      period_days: 30,
      summary: {
        gmv: curGmv,
        gmv_escrow: gmvRail(inLast30, 'escrow'),
        gmv_direct_pay: gmvRail(inLast30, 'direct_p2p'),
        order_count: curCount,
        completed_count: completedOrders30.length,
        aov,
        unique_buyers: uniqueBuyers,
        repeat_buyers: repeatBuyers,
        repeat_rate: repeatRate,
        complete_rate: completeRate,
        dispute_rate: disputeRate,
      },
      vs_prev: {
        gmv_delta:   curGmv - prevGmv,
        gmv_pct:     prevGmv > 0 ? (curGmv - prevGmv) / prevGmv : (curGmv > 0 ? 1 : 0),
        count_delta: curCount - prevCount,
        count_pct:   prevCount > 0 ? (curCount - prevCount) / prevCount : (curCount > 0 ? 1 : 0),
      },
      daily_7d: daily,
      top_products: topProducts,
      top_customers: topCustomers,
      status_breakdown: statusBreakdown,
    })
  })

  app.post('/api/seller/apply-quota-increase', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller' && !safeRoles(user).includes('seller')) {
      return void res.json({ error: '仅卖家可申请扩容' })
    }
    const { requested_quota, reason } = req.body
    const current = Number(user.max_products ?? 200)
    const currentIdx = QUOTA_TIERS.indexOf(current)
    if (currentIdx < 0 || currentIdx >= QUOTA_TIERS.length - 1) {
      return void res.json({ error: '已是最高配额，无法继续扩容' })
    }
    const nextTier = QUOTA_TIERS[currentIdx + 1]
    if (Number(requested_quota) !== nextTier) {
      return void res.json({ error: `下一档配额应为 ${nextTier}` })
    }
    const existing = await dbOne("SELECT 1 FROM quota_increase_applications WHERE user_id = ? AND status = 'pending' LIMIT 1", [user.id])
    if (existing) return void res.json({ error: '已有待审申请' })

    await dbRun(`INSERT INTO quota_increase_applications (id, user_id, current_quota, requested_quota, reason) VALUES (?,?,?,?,?)`,
      [generateId('qapp'), user.id, current, nextTier, (reason || '').toString().slice(0, 500)])
    res.json({ success: true, requested_quota: nextTier })
  })

  app.post('/api/seller/withdraw-quota-application', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const pending = await dbOne<{ id: string }>("SELECT id FROM quota_increase_applications WHERE user_id = ? AND status = 'pending' LIMIT 1", [user.id])
    if (!pending) return void res.json({ error: '没有待审申请' })
    await dbRun("UPDATE quota_increase_applications SET status = 'withdrawn', reviewed_at = datetime('now') WHERE id = ?", [pending.id])
    res.json({ success: true })
  })

  // Admin
  app.get('/api/admin/quota-applications', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const status = (req.query.status as string) || 'pending'
    const rows = await dbAll(`
      SELECT qa.*, u.name as user_name, u.email
      FROM quota_increase_applications qa
      LEFT JOIN users u ON u.id = qa.user_id
      WHERE qa.status = ?
      ORDER BY qa.applied_at DESC LIMIT 100
    `, [status])
    res.json({ applications: rows })
  })

  app.post('/api/admin/quota-applications/:id/approve', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const { note } = req.body
    const appRow = await dbOne<{ id: string; user_id: string; requested_quota: number; status: string }>("SELECT id, user_id, requested_quota, status FROM quota_increase_applications WHERE id = ?",
      [req.params.id])
    if (!appRow) return void res.json({ error: '申请不存在' })
    if (!adminCanOperateOn(admin, appRow.user_id, res)) return
    if (appRow.status !== 'pending') return void res.json({ error: '该申请不在待审状态' })
    if (!QUOTA_TIERS.includes(appRow.requested_quota)) return void res.json({ error: '请求配额不合法' })

    await dbRun("UPDATE quota_increase_applications SET status='approved', reviewed_at=datetime('now'), reviewed_by=?, decision_note=? WHERE id=?",
      [admin.id, note || null, appRow.id])
    await dbRun("UPDATE users SET max_products = ?, updated_at = datetime('now') WHERE id = ?", [appRow.requested_quota, appRow.user_id])
    logAdminAction(admin.id as string, 'approve_quota_increase', 'user', appRow.user_id, { quota: appRow.requested_quota, note })
    res.json({ success: true })
  })

  app.post('/api/admin/quota-applications/:id/reject', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const { note } = req.body
    const appRow = await dbOne<{ id: string; user_id: string; status: string }>("SELECT id, user_id, status FROM quota_increase_applications WHERE id = ?", [req.params.id])
    if (!appRow) return void res.json({ error: '申请不存在' })
    if (!adminCanOperateOn(admin, appRow.user_id, res)) return
    if (appRow.status !== 'pending') return void res.json({ error: '该申请不在待审状态' })
    await dbRun("UPDATE quota_increase_applications SET status='rejected', reviewed_at=datetime('now'), reviewed_by=?, decision_note=? WHERE id=?",
      [admin.id, note || null, appRow.id])
    logAdminAction(admin.id as string, 'reject_quota_increase', 'user', appRow.user_id, { note })
    res.json({ success: true })
  })
}
