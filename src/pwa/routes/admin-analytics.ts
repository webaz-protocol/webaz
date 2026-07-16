/**
 * Admin 分析看板 — MCP usage / 内部审核账号 / 财务月度 / 协议 KPI / 简版 dashboard
 *
 * 由 #1013 Phase 105 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints:
 *   GET /api/admin/usage             (x-admin-key)  MCP 工具调用 7d/24h 汇总
 *   GET /api/admin/auditor           (root)         内部审核账号 api_key（极敏感）
 *   GET /api/admin/finance/monthly   (any admin)    协议费 vs 平台拨付月度净额
 *   GET /api/admin/protocol-kpi      (any admin)    多窗口 DAU/MAU + 订单/争议/退款 + 财务
 *   GET /api/admin/dashboard         (any admin)    简版 summary（首屏）
 *   GET /api/admin/rewards-health    (any admin)    RFC-002 opt-in 申请流 / 佣金 escrow / consent 漂移监控 (#937 A8)
 *
 * 跨域注入：adminAuth (x-admin-key) + requireAdmin + requireRootAdmin
 *           + getProtocolParam + INTERNAL_AUDITOR_ID
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminAnalyticsDeps {
  db: Database.Database
  adminAuth: (req: Request, res: Response) => boolean
  requireAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
  INTERNAL_AUDITOR_ID: string
}

export function registerAdminAnalyticsRoutes(app: Application, deps: AdminAnalyticsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { adminAuth, requireAdmin, requireRootAdmin, getProtocolParam, INTERNAL_AUDITOR_ID } = deps

  // RFC-025 PR-2 — demand_signals 内部只读(admin key)。原始信号(含 human_id)只进这里;
  //   公开给商家 = 未来独立 gated PR(聚合阈值≥N + 脱敏,永不暴露单买家)。
  app.get('/api/admin/demand-signals', async (req, res) => {
    if (!adminAuth(req, res)) return
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const rows = await dbAll(`SELECT id, human_id, source, intent_json, category, region, budget_units, result_count, created_at
      FROM demand_signals ORDER BY created_at DESC LIMIT ?`, [limit])
    const agg = await dbAll(`SELECT category, region, COUNT(*) AS signals, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS unmet
      FROM demand_signals GROUP BY category, region ORDER BY unmet DESC, signals DESC LIMIT 50`)
    res.json({ count: rows.length, signals: rows, aggregate: agg, note: 'internal only — public aggregation is a separate gated PR (threshold + anonymization)' })
  })

  app.get('/api/admin/usage', async (req, res) => {
    if (!adminAuth(req, res)) return

    const total      = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM mcp_tool_calls`))!
    const total24h   = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM mcp_tool_calls WHERE ts > datetime('now','-1 day')`))!
    const total7d    = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM mcp_tool_calls WHERE ts > datetime('now','-7 day')`))!
    const totalUsers = (await dbOne<{ n: number }>(`SELECT COUNT(DISTINCT user_id_hash) as n FROM mcp_tool_calls WHERE user_id_hash IS NOT NULL`))!
    const wau7d      = (await dbOne<{ n: number }>(`SELECT COUNT(DISTINCT user_id_hash) as n FROM mcp_tool_calls WHERE user_id_hash IS NOT NULL AND ts > datetime('now','-7 day')`))!
    const dau24h     = (await dbOne<{ n: number }>(`SELECT COUNT(DISTINCT user_id_hash) as n FROM mcp_tool_calls WHERE user_id_hash IS NOT NULL AND ts > datetime('now','-1 day')`))!

    const byTool = await dbAll(`
      SELECT tool_name,
             COUNT(*) AS calls,
             SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) AS errors,
             ROUND(AVG(latency_ms), 0) AS avg_latency_ms
      FROM mcp_tool_calls WHERE ts > datetime('now','-7 day')
      GROUP BY tool_name ORDER BY calls DESC
    `)
    const byDay = await dbAll(`
      SELECT substr(ts, 1, 10) AS day,
             COUNT(*) AS calls,
             COUNT(DISTINCT user_id_hash) AS distinct_users
      FROM mcp_tool_calls WHERE ts > datetime('now','-14 day')
      GROUP BY day ORDER BY day
    `)
    const byVersion = await dbAll(`
      SELECT server_version,
             COUNT(*) AS calls,
             COUNT(DISTINCT user_id_hash) AS distinct_users
      FROM mcp_tool_calls WHERE ts > datetime('now','-7 day')
      GROUP BY server_version ORDER BY calls DESC
    `)

    res.json({
      summary: {
        total_calls:        total.n,
        total_calls_24h:    total24h.n,
        total_calls_7d:     total7d.n,
        distinct_users_all: totalUsers.n,
        dau_24h:            dau24h.n,
        wau_7d:             wau7d.n,
      },
      by_tool_7d:    byTool,
      by_day_14d:    byDay,
      by_version_7d: byVersion,
    })
  })

  app.get('/api/admin/auditor', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const auditor = await dbOne<Record<string, unknown>>('SELECT id, name, api_key, created_at FROM users WHERE id = ?', [INTERNAL_AUDITOR_ID])
    if (!auditor) return void res.json({ error: '内部审核账号未初始化' })
    res.json({ id: auditor.id, name: auditor.name, api_key: auditor.api_key })
  })

  app.get('/api/admin/finance/monthly', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return
    const months = Math.max(3, Math.min(24, Number(req.query.months) || 12))
    const feeShop = getProtocolParam<number>('protocol_fee_rate_shop', 0.02)
    const feeSecondhand = getProtocolParam<number>('protocol_fee_rate_secondhand', 0.01)

    const orderRows = await dbAll<{ ym: string; fee: number; gmv: number; orders_count: number }>(`
      SELECT strftime('%Y-%m', created_at) as ym,
             COALESCE(SUM(CASE WHEN source = 'secondhand' THEN total_amount * ? ELSE total_amount * ? END), 0) as fee,
             COALESCE(SUM(total_amount), 0) as gmv,
             COUNT(*) as orders_count
      FROM orders
      WHERE status = 'completed'
        AND created_at > datetime('now', '-' || ? || ' months')
      GROUP BY ym ORDER BY ym DESC
    `, [feeSecondhand, feeShop, months])

    const rewardRows = await dbAll<{ ym: string; rewards: number; count: number }>(`
      SELECT strftime('%Y-%m', created_at) as ym, COALESCE(SUM(amount), 0) as rewards, COUNT(*) as count
      FROM platform_reward_log
      WHERE created_at > datetime('now', '-' || ? || ' months')
      GROUP BY ym ORDER BY ym DESC
    `, [months])

    const byMonth = new Map<string, { ym: string; fee: number; gmv: number; orders: number; rewards: number; reward_count: number }>()
    for (const o of orderRows) byMonth.set(o.ym, { ym: o.ym, fee: o.fee, gmv: o.gmv, orders: o.orders_count, rewards: 0, reward_count: 0 })
    for (const r of rewardRows) {
      const m = byMonth.get(r.ym)
      if (m) { m.rewards = r.rewards; m.reward_count = r.count }
      else byMonth.set(r.ym, { ym: r.ym, fee: 0, gmv: 0, orders: 0, rewards: r.rewards, reward_count: r.count })
    }
    const rows = [...byMonth.values()].sort((a, b) => b.ym.localeCompare(a.ym))

    const totalFee = rows.reduce((s, r) => s + r.fee, 0)
    const totalRewards = rows.reduce((s, r) => s + r.rewards, 0)
    const totalGmv = rows.reduce((s, r) => s + r.gmv, 0)
    const sysWallet = await dbOne<{ balance: number }>("SELECT balance FROM wallets WHERE user_id = 'sys_protocol'")

    res.json({
      months,
      fee_rate_shop: feeShop,
      fee_rate_secondhand: feeSecondhand,
      monthly: rows.map(r => ({ ...r, net: r.fee - r.rewards })),
      totals: {
        fee_revenue: totalFee,
        reward_expenditure: totalRewards,
        net: totalFee - totalRewards,
        gmv: totalGmv,
        sys_protocol_balance: Number(sysWallet?.balance || 0),
      },
    })
  })

  app.get('/api/admin/protocol-kpi', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return

    const windowCounts = async (label: string, days: number) => {
      const t = `datetime('now','-${days} days')`
      const orders = (await dbOne<{ n: number; gmv: number }>(`SELECT COUNT(*) as n, COALESCE(SUM(total_amount),0) as gmv FROM orders WHERE created_at > ${t}`))!
      const completed = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE status='completed' AND created_at > ${t}`))!.n
      const disputes = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM disputes WHERE created_at > ${t}`))!.n
      const refunds = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM return_requests WHERE status='refunded' AND created_at > ${t}`))!.n
      const newUsers = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM users WHERE created_at > ${t} AND id NOT IN ('sys_protocol', ?)`, [INTERNAL_AUDITOR_ID]))!.n
      return { label, days, orders: orders.n, gmv: orders.gmv, completed, disputes, refunds, new_users: newUsers,
        dispute_rate: orders.n > 0 ? disputes / orders.n : 0,
        refund_rate: completed > 0 ? refunds / completed : 0,
      }
    }

    const dauProxy = (await dbOne<{ n: number }>(`
      SELECT COUNT(DISTINCT u_id) as n FROM (
        SELECT buyer_id as u_id FROM orders WHERE created_at > datetime('now', '-1 day')
        UNION SELECT seller_id FROM orders WHERE created_at > datetime('now', '-1 day')
        UNION SELECT buyer_id FROM order_ratings WHERE created_at > datetime('now', '-1 day')
        UNION SELECT user_id FROM daily_checkins WHERE checkin_date >= date('now', '-1 day')
        UNION SELECT user_id FROM feedback_tickets WHERE created_at > datetime('now', '-1 day')
      )
    `))!.n
    const mauProxy = (await dbOne<{ n: number }>(`
      SELECT COUNT(DISTINCT u_id) as n FROM (
        SELECT buyer_id as u_id FROM orders WHERE created_at > datetime('now', '-30 days')
        UNION SELECT seller_id FROM orders WHERE created_at > datetime('now', '-30 days')
        UNION SELECT buyer_id FROM order_ratings WHERE created_at > datetime('now', '-30 days')
        UNION SELECT user_id FROM daily_checkins WHERE checkin_date >= date('now', '-30 days')
        UNION SELECT user_id FROM feedback_tickets WHERE created_at > datetime('now', '-30 days')
      )
    `))!.n

    const userTotals = (await dbOne<Record<string, number>>(`
      SELECT
        SUM(CASE WHEN role='buyer' THEN 1 ELSE 0 END) as buyers,
        SUM(CASE WHEN role='seller' THEN 1 ELSE 0 END) as sellers,
        SUM(CASE WHEN role='logistics' THEN 1 ELSE 0 END) as logistics,
        SUM(CASE WHEN role='verifier' THEN 1 ELSE 0 END) as verifiers,
        SUM(CASE WHEN role='arbitrator' THEN 1 ELSE 0 END) as arbitrators,
        SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END) as admins,
        COUNT(*) as total
      FROM users WHERE id NOT IN ('sys_protocol', ?)
    `, [INTERNAL_AUDITOR_ID]))!

    const sysWallet = await dbOne<{ balance: number }>("SELECT balance FROM wallets WHERE user_id = 'sys_protocol'")
    const totalEscrowed = (await dbOne<{ t: number }>("SELECT COALESCE(SUM(escrowed),0) as t FROM wallets"))!.t
    const totalStaked = (await dbOne<{ t: number }>("SELECT COALESCE(SUM(staked),0) as t FROM wallets"))!.t
    const platformRewards = (await dbOne<{ t: number }>("SELECT COALESCE(SUM(amount),0) as t FROM platform_reward_log"))!.t
    const platformRewardsToday = (await dbOne<{ t: number }>("SELECT COALESCE(SUM(amount),0) as t FROM platform_reward_log WHERE created_at > datetime('now','-1 day')"))!.t

    const products = (await dbOne<{ n: number; active: number }>("SELECT COUNT(*) as n, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM products"))!
    const ratings = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM order_ratings"))!.n
    const subs = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM push_subscriptions WHERE enabled=1"))!.n

    const trustOpen = (await dbOne<Record<string, number>>(`
      SELECT
        (SELECT COUNT(*) FROM disputes WHERE status IN ('open','in_review')) as disputes_open,
        (SELECT COUNT(*) FROM feedback_tickets WHERE status IN ('open','in_progress')) as feedback_open,
        (SELECT COUNT(*) FROM return_requests WHERE status='pending') as returns_pending
    `))!

    res.json({
      activity: {
        dau_proxy: dauProxy,
        mau_proxy: mauProxy,
        windows: await Promise.all([ windowCounts('24h', 1), windowCounts('7d', 7), windowCounts('30d', 30) ]),
      },
      users: userTotals,
      finance: {
        sys_protocol_balance: Number(sysWallet?.balance || 0),
        total_escrowed: totalEscrowed,
        total_staked: totalStaked,
        platform_rewards_cumulative: platformRewards,
        platform_rewards_today: platformRewardsToday,
      },
      content: {
        products_total: products.n,
        products_active: products.active,
        ratings_total: ratings,
        push_subscriptions: subs,
      },
      trust_open: trustOpen,
    })
  })

  app.get('/api/admin/dashboard', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return
    const u = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM users WHERE id NOT IN ('sys_protocol', ?)", [INTERNAL_AUDITOR_ID]))!
    const sellers = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM users WHERE role = 'seller' AND id NOT IN ('sys_protocol', ?)", [INTERNAL_AUDITOR_ID]))!
    const active  = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM products WHERE status = 'active'"))!
    const o24    = (await dbOne<{ n: number; gmv: number }>("SELECT COUNT(*) as n, COALESCE(SUM(total_amount),0) as gmv FROM orders WHERE created_at > datetime('now','-1 day')"))!
    const dOpen  = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM disputes WHERE status IN ('open','in_review')"))!
    const vOpen  = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM verify_tasks WHERE status IN ('open','code_issued')"))!
    const locked = (await dbOne<{ t: number }>("SELECT COALESCE(SUM(staked + escrowed),0) as t FROM wallets"))!
    const sus    = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM user_moderation WHERE suspended = 1"))!
    const verifierApps = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM verifier_applications WHERE status = 'pending'"))!
    const verifierAppeals = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM verifier_appeals WHERE status = 'pending'"))!
    const quotaApps = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM quota_increase_applications WHERE status = 'pending'"))!
    const listingPaused = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM users WHERE listing_paused = 1"))!
    const activeVerifiers = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM verifier_whitelist vw
      LEFT JOIN verifier_stats vs ON vs.user_id = vw.user_id
      WHERE (vw.cooldown_until IS NULL OR vw.cooldown_until < datetime('now'))
        AND (vs.suspended_until IS NULL OR vs.suspended_until < datetime('now'))
    `))!
    const tokenomics = await (async () => {
      // matching-rewards admin metrics (pool / scores / mgmt-bonus / binary payout) removed — engine excised (#401).
      const pendingLedger = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM pv_ledger WHERE processed = 0"))!.n
      const commCount = (await dbOne<{ n: number; t: number }>("SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as t FROM commission_records"))!
      const dirtyUsers = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM users WHERE pv_dirty_at IS NOT NULL"))!.n
      return {
        ledger_pending:      pendingLedger,
        dirty_users:         dirtyUsers,
        commission_records:  commCount.n,
        commission_total:    commCount.t,
      }
    })()

    res.json({
      users: u.n, sellers: sellers.n,
      products_active: active.n,
      orders_24h: o24.n, gmv_24h: o24.gmv,
      disputes_open: dOpen.n,
      verify_tasks_open: vOpen.n,
      total_locked: locked.t,
      users_suspended: sus.n,
      verifier_apps_pending: verifierApps.n,
      verifier_appeals_pending: verifierAppeals.n,
      active_verifiers: activeVerifiers.n,
      quota_apps_pending: quotaApps.n,
      listing_paused_count: listingPaused.n,
      tokenomics,
    })
  })

  // RFC-002 rewards opt-in 生命周期监控(#937 A8)— 申请流 / 佣金 escrow / consent 版本漂移。
  //   之前这三张表(rewards_applications / pending_commission_escrow / rewards_consent_texts)只有
  //   引擎 cron 读写,无 admin 监控视图;上线后需盯:opt-in 申请量、escrow 待兑付/将到期、
  //   以及"在旧 major consent 上仍 opted-in"= 下次 auto_downgrade cron 的降级候选。
  app.get('/api/admin/rewards-health', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return

    // 1. 申请流:按 action 计数 + 当前 opted-in 用户数 + 最近 20 条
    const appsByAction = await dbAll(`SELECT action, COUNT(*) AS n FROM rewards_applications GROUP BY action ORDER BY n DESC`)
    const optedIn = (await dbOne<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE rewards_opted_in = 1`))!.n
    const recentApps = await dbAll(`SELECT id, user_id, action, consent_version, verification_method, created_at
      FROM rewards_applications ORDER BY created_at DESC LIMIT 20`)

    // 2. 佣金 escrow:按 status 计数+金额、待兑付按 attribution_path、24h 内将到期
    const nowSec = Math.floor(Date.now() / 1000)
    const escrowByStatus = await dbAll(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
      FROM pending_commission_escrow GROUP BY status`)
    // RFC-018: these "pending escrow" stats mean opt-out escrow (matures_at IS NULL); clearing rows
    // (matures_at NOT NULL) don't expire-to-reserve and would mislabel "expiring soon".
    const escrowPendingByPath = await dbAll(`SELECT attribution_path, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
      FROM pending_commission_escrow WHERE status='pending' AND matures_at IS NULL GROUP BY attribution_path`)
    const expiringSoon = (await dbOne<{ n: number; total: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
      FROM pending_commission_escrow WHERE status='pending' AND matures_at IS NULL AND expires_at <= ?`, [nowSec + 86400]))!

    // 3. consent 版本:当前 major + 仍停留在旧 major 上的 opted-in 用户数(= auto_downgrade 候选)
    const currentMajor = await dbOne<{ version: string; effective_at: number }>(
      `SELECT version, effective_at FROM rewards_consent_texts WHERE change_class='major' ORDER BY effective_at DESC LIMIT 1`)
    let staleConsentOptedIn = 0
    if (currentMajor) {
      staleConsentOptedIn = (await dbOne<{ n: number }>(`SELECT COUNT(*) AS n FROM users u
        WHERE u.rewards_opted_in = 1 AND (
          SELECT consent_version FROM rewards_applications
          WHERE user_id = u.id AND action IN ('activate','reconfirm') ORDER BY created_at DESC LIMIT 1
        ) IS NOT ?`, [currentMajor.version]))!.n
    }
    const consentVersions = await dbAll(`SELECT version, change_class, effective_at FROM rewards_consent_texts ORDER BY effective_at DESC LIMIT 10`)

    res.json({
      applications: { by_action: appsByAction, opted_in_users: optedIn, recent: recentApps },
      commission_escrow: { by_status: escrowByStatus, pending_by_path: escrowPendingByPath, expiring_within_24h: expiringSoon },
      consent: { current_major: currentMajor || null, stale_consent_opted_in: staleConsentOptedIn, versions: consentVersions },
      generated_at: new Date().toISOString(),
    })
  })
}
