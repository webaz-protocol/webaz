/**
 * Admin 读表盘 — 订单 / 争议 / 验证任务 / 审计日志
 *
 * 由 #1013 Phase 101 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET /api/admin/orders        (content)      最近 100 订单 + 商品/买卖家 join
 *   GET /api/admin/disputes      (arbitration)  最近 100 争议 + 双方/订单/商品 join
 *   GET /api/admin/verify-tasks  (arbitration)  最近 100 验证任务 + 商品/卖家 join，可按 status 过滤
 *   GET /api/admin/audit-log     (protocol)     最近 50 条管理动作日志，detail 自动 JSON.parse
 *
 * 跨域注入：requireContentAdmin / requireArbitrationAdmin / requireProtocolAdmin（预绑好的权限闸）
 */
import type { Application } from 'express'
import type Database from 'better-sqlite3'
import type { Request, Response } from 'express'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminReportsDeps {
  db: Database.Database
  requireContentAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireArbitrationAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerAdminReportsRoutes(app: Application, deps: AdminReportsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { requireContentAdmin, requireArbitrationAdmin, requireProtocolAdmin } = deps

  app.get('/api/admin/orders', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    // 审计项 G:补 payment_rail 列 + ?rail 过滤 —— admin/AML 此前在订单总览里区分不出 direct_p2p(非托管轨监控盲区)
    const status = req.query.status as string | undefined
    const rail = typeof req.query.rail === 'string' ? req.query.rail.trim() : ''
    let sql = `SELECT o.id, o.product_id, o.buyer_id, o.seller_id, o.logistics_id, o.status,
                      o.total_amount, o.created_at, o.payment_rail,
                      p.title as product_title,
                      ub.name as buyer_name, us.name as seller_name
               FROM orders o
               JOIN products p ON o.product_id = p.id
               JOIN users ub ON o.buyer_id = ub.id
               JOIN users us ON o.seller_id = us.id`
    const where: string[] = []; const params: unknown[] = []
    if (status && status.trim()) { where.push('o.status = ?'); params.push(status) }
    if (rail) { where.push('o.payment_rail = ?'); params.push(rail) }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ` ORDER BY o.created_at DESC LIMIT 100`
    res.json({ orders: await dbAll(sql, params) })
  })

  app.get('/api/admin/disputes', async (req, res) => {
    const admin = requireArbitrationAdmin(req, res); if (!admin) return
    // 区分:按 status(open/in_review/resolved/dismissed)+ rail(direct_p2p/escrow)过滤;附 verdict/ruling_type/
    //   assigned_arbitrators/payment_rail 让 admin 分辨类型/进度/是否已指派/如何结案。summary 给全量分状态计数。
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : ''
    const rail = typeof req.query.rail === 'string' ? req.query.rail.trim() : ''
    const where: string[] = []; const params: unknown[] = []
    // PR2:decline_contest 现进入 admin 监督台(前端按 dispute_type 打"拒单举证仲裁"标签)。
    if (status) { where.push('d.status = ?'); params.push(status) }
    if (rail) { where.push('o.payment_rail = ?'); params.push(rail) }
    const rows = await dbAll(`
      SELECT d.id, d.order_id, d.initiator_id, d.defendant_id, d.reason, d.status, d.dispute_type,
             d.created_at, d.respond_deadline, d.arbitrate_deadline, d.resolved_at,
             d.verdict, d.ruling_type, d.assigned_arbitrators,
             u1.name as initiator_name, u2.name as defendant_name,
             o.total_amount, o.status as order_status, o.payment_rail,
             p.title as product_title
      FROM disputes d
      LEFT JOIN users u1 ON d.initiator_id = u1.id
      LEFT JOIN users u2 ON d.defendant_id = u2.id
      LEFT JOIN orders o ON d.order_id = o.id
      LEFT JOIN products p ON o.product_id = p.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.created_at DESC LIMIT 100
    `, params)
    const counts = await dbAll<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM disputes GROUP BY status')
    res.json({ disputes: rows, counts: Object.fromEntries(counts.map(c => [c.status, c.n])), total: counts.reduce((s, c) => s + c.n, 0) })
  })

  app.get('/api/admin/verify-tasks', async (req, res) => {
    const admin = requireArbitrationAdmin(req, res); if (!admin) return
    const status = req.query.status as string | undefined
    let sql = `SELECT vt.id, vt.type, vt.status, vt.url, vt.code, vt.result, vt.fee_locked,
                      vt.verifiers_needed, vt.created_at, vt.expires_at, vt.settled_at,
                      vt.product_id, p.title as product_title, p.seller_id, u.name as seller_name
               FROM verify_tasks vt
               LEFT JOIN products p ON vt.product_id = p.id
               LEFT JOIN users u ON p.seller_id = u.id`
    const params: unknown[] = []
    if (status && status.trim()) { sql += ` WHERE vt.status = ?`; params.push(status) }
    sql += ` ORDER BY vt.created_at DESC LIMIT 100`
    res.json({ tasks: await dbAll(sql, params) })
  })

  // 收入治理视图 — 联盟佣金(按真实成交)协议级聚合。匹配奖励引擎已切除(#401),不再聚合其指标。
  // 隐私第一：运营财务，仅 protocol admin 可见。
  app.get('/api/admin/economic-summary', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const r2 = (n: number) => Math.round(Number(n || 0) * 100) / 100

    // 引擎 A：三级奖励（commission_records 实际分账，按 level）
    const commByLevel = await dbAll<{ level: number; cnt: number; total: number }>(`
      SELECT level, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
      FROM commission_records GROUP BY level
    `)
    const engineA = { l1: { count: 0, total: 0 }, l2: { count: 0, total: 0 }, l3: { count: 0, total: 0 }, distributed_total: 0 }
    for (const r of commByLevel) {
      const k = `l${r.level}` as 'l1' | 'l2' | 'l3'
      if (engineA[k]) { engineA[k] = { count: r.cnt, total: r2(r.total) }; engineA.distributed_total += Number(r.total) }
    }
    engineA.distributed_total = r2(engineA.distributed_total)

    // 2026-06-04 三科目解耦：引擎 A 所有 redirect 去向统一 → commission_pool（三级公池，只进不出）。
    // charity_fund 自此纯净（仅捐款/还愿/拨款），不再承接佣金兜底。
    const charity = await dbOne<Record<string, number>>(`SELECT balance, total_donated, total_disbursed, total_redirected FROM charity_fund WHERE id='main'`)
    const cpool = await dbOne<Record<string, number>>(`SELECT balance, total_chain_gap, total_orphan_sponsor, total_region_cap FROM commission_reserve WHERE id='main'`)

    // 资金管道：fund_base 1% 累计 + commission region_cap redirect（历史，新订单恒 0）
    const pipe = (await dbOne<{ base: number; redirect: number }>(`SELECT COALESCE(SUM(amount_base),0) AS base, COALESCE(SUM(amount_l3),0) AS redirect FROM fund_deposits`))!

    res.json({
      engine_a_commission: {
        ...engineA,
        // 2026-06-04 起所有兜底 → commission_reserve（三级公池，只进不出）。三个分项互斥：
        commission_reserve_chain_gap: r2(Number(cpool?.total_chain_gap || 0)),       // 无 L / 上家断链
        commission_reserve_orphan_sponsor: r2(Number(cpool?.total_orphan_sponsor || 0)), // sponsor 无效 + opt-out 放弃 + escrow 到期
        commission_reserve_region_cap: r2(Number(cpool?.total_region_cap || 0)),     // level>maxLevels 截断 + max=0 整池
        commission_reserve_balance: r2(Number(cpool?.balance || 0)),
        legacy_global_fund_redirect: r2(pipe.redirect),  // 历史：解耦前曾入 global_fund（fund_deposits.amount_l3），新订单恒 0
        note: '即时分账；兜底全部入 commission_reserve（独立科目，只进不出，治理决定用途），不再污染 charity / global_fund。',
      },
      funding_pipe: {
        fund_base_1pct_accumulated: r2(pipe.base),
        commission_redirect_accumulated: r2(pipe.redirect),
        note: 'global_fund 蓄水来源（单向）：每单 1% fund_base + commission region_cap redirect。',
      },
      charity_fund: {
        balance: r2(Number(charity?.balance || 0)),
        total_donated: r2(Number(charity?.total_donated || 0)),
        total_disbursed: r2(Number(charity?.total_disbursed || 0)),
      },
      governance_hint: '联盟佣金=消费即时分账→钱包，兜底→commission_reserve(独立科目,只进不出)。匹配奖励引擎已切除(#401)。',
      generated_at: new Date().toISOString(),
    })
  })

  app.get('/api/admin/audit-log', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT al.id, al.admin_id, al.action, al.target_type, al.target_id, al.detail, al.created_at,
             u.name as admin_name
      FROM admin_audit_log al
      LEFT JOIN users u ON u.id = al.admin_id
      ORDER BY al.created_at DESC LIMIT 50
    `)
    res.json({
      entries: rows.map(r => ({
        ...r,
        detail: r.detail ? (() => { try { return JSON.parse(r.detail as string) } catch { return r.detail } })() : null,
      })),
    })
  })
}
