/**
 * Trusted 角色 KPI 仪表盘域 (Wave D-5)
 *
 * 由 #1013 Phase 22 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/verifier/me/kpi      verifier 自己累计 + 窗口数据 + 奖励统计
 *   GET /api/arbitrator/me/kpi    arbitrator 自己累计 + 窗口处理 + pending 计数
 *
 * 窗口参数（默认 30 天，min 7 / max 365）：聚合 votes、reputation_events、disputes 的窗口数据
 * 不暴露 GMV / 营收细节（隐私第一）— 只展示行为指标 + earned WAZ
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { wazEscrowChannelOn } from '../../waz-escrow-channel.js'   // WAZ 退役:earned KPI 零化
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface TrustedKpiDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export function registerTrustedKpiRoutes(app: Application, deps: TrustedKpiDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne),不再直接用 deps.db
  const { auth, getProtocolParam } = deps

  // Verifier KPI（白名单 tier / 配额 / 准确率 / 窗口奖励）
  app.get('/api/verifier/me/kpi', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const windowDays = Math.max(7, Math.min(365, Number(req.query.window) || 30))
    const cumul = await dbOne<{ tasks_done: number; tasks_correct: number; tasks_wrong: number; verify_rights: number }>('SELECT tasks_done, tasks_correct, tasks_wrong, verify_rights FROM verifier_stats WHERE user_id = ?', [user.id])
    const wl = await dbOne<{ tier: string; daily_quota: number; tasks_today: number; is_system: number }>('SELECT tier, daily_quota, tasks_today, is_system FROM verifier_whitelist WHERE user_id = ?', [user.id])
    // 窗口内投票数（跨多个 votes 表聚合）
    const windowVotes = (await dbOne<{ n: number }>(`
      SELECT
        (SELECT COUNT(*) FROM claim_verification_votes WHERE verifier_id = ? AND voted_at > datetime('now', '-' || ? || ' days')) +
        (SELECT COUNT(*) FROM product_claim_votes WHERE verifier_id = ? AND voted_at > datetime('now', '-' || ? || ' days')) +
        (SELECT COUNT(*) FROM review_claim_votes WHERE verifier_id = ? AND voted_at > datetime('now', '-' || ? || ' days'))
        as n
    `, [user.id, windowDays, user.id, windowDays, user.id, windowDays]))!.n
    // 窗口内奖励 (reputation_events: claim_correct 等)
    const earnedEvents = (await dbOne<{ pts: number }>(`
      SELECT COALESCE(SUM(points), 0) as pts FROM reputation_events
      WHERE user_id = ? AND event_type IN ('claim_correct', 'claim_upheld_against', 'claim_dismissed_false')
        AND created_at > datetime('now', '-' || ? || ' days')
    `, [user.id, windowDays]))!.pts
    const wal = await dbOne<{ earned: number }>('SELECT earned FROM wallets WHERE user_id = ?', [user.id])
    const accuracy = cumul && cumul.tasks_done > 0 ? cumul.tasks_correct / cumul.tasks_done : null
    res.json({
      window_days: windowDays,
      is_external: wl ? wl.is_system === 0 : false,
      tier: wl?.tier || null,
      daily_quota: wl?.daily_quota || 0,
      tasks_today: wl?.tasks_today || 0,
      verify_rights: cumul?.verify_rights || 0,
      cumulative: {
        tasks_done: cumul?.tasks_done || 0,
        tasks_correct: cumul?.tasks_correct || 0,
        tasks_wrong: cumul?.tasks_wrong || 0,
        accuracy,
      },
      window: {
        votes: windowVotes,
        rep_points: earnedEvents,
      },
      total_earned_waz: wazEscrowChannelOn(getProtocolParam) ? Number(wal?.earned || 0) : 0,   // WAZ 退役:渠道关 → 0(冲正后真值亦 0)
    })
  })

  // Arbitrator KPI（仲裁累计 + 裁决分布 + pending）
  app.get('/api/arbitrator/me/kpi', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const windowDays = Math.max(7, Math.min(365, Number(req.query.window) || 30))
    const idLike = `%"${user.id}"%`
    const cumul = await dbOne<{ total: number; refund_buyer_cnt: number; partial_cnt: number; release_seller_cnt: number }>(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN ruling_type = 'refund_buyer' THEN 1 ELSE 0 END) as refund_buyer_cnt,
        SUM(CASE WHEN ruling_type = 'partial_refund' THEN 1 ELSE 0 END) as partial_cnt,
        SUM(CASE WHEN ruling_type = 'release_seller' THEN 1 ELSE 0 END) as release_seller_cnt
      FROM disputes WHERE assigned_arbitrators LIKE ? AND status IN ('resolved','dismissed')
    `, [idLike])
    const windowTotal = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM disputes
      WHERE assigned_arbitrators LIKE ? AND status IN ('resolved','dismissed')
        AND resolved_at > datetime('now', '-' || ? || ' days')
    `, [idLike, windowDays]))!.n
    const pending = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM disputes
      WHERE assigned_arbitrators LIKE ? AND status NOT IN ('resolved','dismissed')
    `, [idLike]))!.n
    const wl = await dbOne<{ is_system: number; stake_amount: number }>('SELECT is_system, stake_amount FROM arbitrator_whitelist WHERE user_id = ?', [user.id])
    const wal = await dbOne<{ earned: number }>('SELECT earned FROM wallets WHERE user_id = ?', [user.id])
    res.json({
      window_days: windowDays,
      is_external: wl ? wl.is_system === 0 : false,
      stake_amount: wl?.stake_amount || 0,
      cumulative: {
        total: cumul?.total || 0,
        refund_buyer: cumul?.refund_buyer_cnt || 0,
        partial_refund: cumul?.partial_cnt || 0,
        release_seller: cumul?.release_seller_cnt || 0,
      },
      window_total: windowTotal,
      pending,
      total_earned_waz: wazEscrowChannelOn(getProtocolParam) ? Number(wal?.earned || 0) : 0,   // WAZ 退役:渠道关 → 0(冲正后真值亦 0)
    })
  })
}
