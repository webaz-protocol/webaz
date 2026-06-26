/**
 * 排行榜 (leaderboard) 域 — 单 endpoint 8 种榜单
 *
 * 由 #1013 Phase 11 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint, 8 kinds:
 *   GET /api/leaderboard?kind=<kind>&limit=<n>
 *
 * Kinds:
 *   - products       — 热门商品 (rank_score = completion×0.5 + recommend×2 + likes×1)
 *   - creators       — 创作者 (按 shareable 总点赞)
 *   - buyers         — 买家活跃 (按完成订单数；不展示 GMV)
 *   - sellers        — 卖家 (评分主导 avg × log(1+rating_count)；不展示 GMV)
 *   - value_products — 性价比 (value_badge=1 按 rank/pct 排)
 *   - agents         — Agent 评测 (trust_score + 30d 调用数)
 *   - arbitrators    — 仲裁员声誉 (fairness_score)
 *   - verifiers      — Verifier (正确率主导)
 *
 * 隐私第一：所有榜单不暴露 GMV / 收入金额（2026-05-23 spec）。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface LeaderboardDeps {
  db: Database.Database
  internalAuditorId: string   // 'usr_iaudit_001' — buyers 榜单排除内部审核员
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
}

// ── Anonymous-projection allowlist (security: this is a NO-AUTH public endpoint) ──────────────
// Each board's anon payload carries ONLY what the public value proposition needs: a public
// identity for linking (handle/name) + the reputation/content signal. It must NEVER carry
// internal canonical user ids (usr_xxx — those are the keyed inputs the #1043 cross-user-read
// cap rate-limits; emitting them here would be a free enumeration seed-list), account-structure
// metadata (keys_count), or behavior-fingerprint integers (calls_30d). ALLOWLIST, not denylist,
// so a future SELECT column can't silently ride to the public surface. (Product boards keep `id`
// — that's a public PRODUCT id for linking, not a user id.)
export const BOARD_ALLOWLIST: Record<string, string[]> = {
  products:       ['id', 'title', 'price', 'total_likes', 'completion_count', 'seller_handle', 'seller_name', 'recommend_count', 'rank_score'],
  value_products: ['id', 'title', 'price', 'category', 'value_badge_rank', 'value_badge_pct', 'value_badge_at', 'completion_count', 'total_likes', 'seller_handle', 'seller_name'],
  creators:       ['handle', 'name', 'region', 'products_shared', 'shareable_count', 'total_likes', 'total_clicks'],
  buyers:         ['handle', 'name', 'region', 'orders_count'],
  sellers:        ['handle', 'name', 'region', 'orders_count', 'avg_rating', 'rating_count'],
  agents:         ['handle', 'name', 'trust_score', 'level', 'activity'],   // NO id / keys_count / calls_30d
  arbitrators:    ['handle', 'name', 'cases_count', 'total_yes', 'total_no', 'fairness_score'],
  verifiers:      ['handle', 'name', 'tasks_done', 'tasks_correct', 'tasks_wrong', 'accuracy', 'tier'],
}
// calls_30d (behavior fingerprint) → coarse activity bucket (keeps "busy vs dormant" product signal
// without leaking a raw per-account integer or the all-zero "network looks dead" aggregate).
function activityBucket(calls: number): 'active' | 'quiet' | 'dormant' {
  return calls >= 20 ? 'active' : calls >= 1 ? 'quiet' : 'dormant'
}
function projectBoard(kind: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const allow = BOARD_ALLOWLIST[kind] || []
  return rows.map(r => {
    const src = kind === 'agents' ? { ...r, activity: activityBucket(Number(r.calls_30d) || 0) } : r
    const out: Record<string, unknown> = {}
    for (const k of allow) if (k in src) out[k] = src[k]
    return out
  })
}

export function registerLeaderboardRoutes(app: Application, deps: LeaderboardDeps): void {
  // db 已走 RFC-016 异步 seam(dbAll),不再直接用 deps.db
  const { internalAuditorId, rateLimitOk } = deps
  const LB_RATE = 60   // 每 IP/分钟 60 次 — 公开端点防 DoS

  app.get('/api/leaderboard', async (req, res) => {
    const ip = req.ip || 'unknown'
    if (!rateLimitOk(`lb:${ip}`, LB_RATE, 60_000)) return void res.status(429).json({ error: 'rate-limited' })
    const kind = String(req.query.kind || 'products')
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 20))

    if (kind === 'products') {
      // recommend_count 严格语义：完成购买 + 4 星+评价 + 去重 buyer_id（一买家计 1）
      // 排序权重也用 recommend_count 替代旧 unique_sharer_count（任何人分享）
      const rows = await dbAll(`
        SELECT p.id, p.title, p.price, p.total_likes, p.completion_count,
          u.handle as seller_handle, u.name as seller_name,
          (SELECT COUNT(DISTINCT buyer_id) FROM order_ratings r
           WHERE r.product_id = p.id AND r.stars >= 4) as recommend_count,
          (COALESCE(p.completion_count, 0) * 0.5
           + (SELECT COUNT(DISTINCT buyer_id) FROM order_ratings r
              WHERE r.product_id = p.id AND r.stars >= 4) * 2.0
           + COALESCE(p.total_likes, 0) * 1.0) as rank_score
        FROM products p
        LEFT JOIN users u ON u.id = p.seller_id
        WHERE p.status = 'active' AND p.stock > 0
        ORDER BY rank_score DESC, p.id DESC
        LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }

    if (kind === 'creators') {
      // 创作者维度：聚合自己 shareables 的总点赞 + 关联商品总数
      const rows = await dbAll(`
        SELECT u.id, u.handle, u.name, u.region,
          COUNT(DISTINCT s.related_product_id) as products_shared,
          COUNT(s.id) as shareable_count,
          COALESCE(SUM(s.like_count), 0) as total_likes,
          COALESCE(SUM(s.click_count), 0) as total_clicks
        FROM users u
        JOIN shareables s ON s.owner_id = u.id AND s.status = 'active'
        GROUP BY u.id
        ORDER BY total_likes DESC, shareable_count DESC, u.id DESC
        LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }

    // B-2: 用户排行 — top buyers / sellers / verifiers
    // 2026-05-23 隐私第一原理：移除 gmv 字段（运营状态私密，防过早 fork）
    if (kind === 'buyers') {
      const rows = await dbAll(`
        SELECT u.id, u.handle, u.name, u.region,
          COUNT(*) as orders_count
        FROM orders o JOIN users u ON u.id = o.buyer_id
        WHERE o.status = 'completed' AND u.id NOT IN ('sys_protocol', ?)
        GROUP BY u.id ORDER BY orders_count DESC, u.id DESC LIMIT ?
      `, [internalAuditorId, limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }
    if (kind === 'sellers') {
      // 排序改为 评分主导（avg_rating × log(1+rating_count)），不再按 GMV
      const rows = await dbAll(`
        SELECT u.id, u.handle, u.name, u.region,
          COUNT(*) as orders_count,
          (SELECT COALESCE(AVG(stars), 0) FROM order_ratings WHERE seller_id = u.id) as avg_rating,
          (SELECT COUNT(*) FROM order_ratings WHERE seller_id = u.id) as rating_count
        FROM orders o JOIN users u ON u.id = o.seller_id
        WHERE o.status = 'completed' AND u.role = 'seller'
        GROUP BY u.id
        ORDER BY (avg_rating * (1.0 + log(1.0 + rating_count))) DESC, rating_count DESC, orders_count DESC
        LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }
    if (kind === 'value_products') {
      // 2026-05-23 S5：极致性价比榜 — 按 value_badge=1 + 同类目 rank 排
      // 排序：rank 越小越靠前（同类目第 1 名最便宜），相同 rank 按 pct 折扣大优先
      const rows = await dbAll(`
        SELECT p.id, p.title, p.price, p.category,
          p.value_badge_rank, p.value_badge_pct, p.value_badge_at,
          p.completion_count, p.total_likes,
          u.handle as seller_handle, u.name as seller_name
        FROM products p
        LEFT JOIN users u ON u.id = p.seller_id
        WHERE p.value_badge = 1 AND p.status = 'active' AND p.stock > 0
        ORDER BY p.value_badge_rank ASC, p.value_badge_pct DESC LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }
    if (kind === 'agents') {
      // 2026-05-22 AG1：Agent 评测竞赛榜单
      // 数据源：agent_reputation（trust_score + level）+ agent_call_log（30d 调用数）
      // 不暴露 api_key（隐私），只展示 user handle + 聚合指标
      const rows = await dbAll(`
        SELECT u.id, u.handle, u.name,
          MAX(ar.trust_score) as trust_score,
          MAX(ar.level) as level,
          COUNT(DISTINCT ar.api_key) as keys_count,
          (SELECT COUNT(*) FROM agent_call_log acl
            WHERE acl.user_id = u.id
            AND acl.created_at > datetime('now', '-30 days')) as calls_30d
        FROM agent_reputation ar
        JOIN users u ON u.id = ar.user_id
        WHERE u.id != 'sys_protocol' AND u.role != 'admin'
        GROUP BY u.id
        HAVING calls_30d > 0 OR trust_score > 0
        ORDER BY trust_score DESC, calls_30d DESC LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }
    if (kind === 'arbitrators') {
      // 2026-05-22 A3：仲裁员声誉排行
      // 从 dispute_cases 聚合 — 每个 arbitrator_id 的 case 数 + 公平评价
      // fairness_score = fairness_yes / (fairness_yes + fairness_no)（仅在有评价时）
      //
      // 2026-06-03 #1080 audit: ORDER BY 改为 case_count desc + u.id tie-breaker
      // 移除 fairness_score 作为 secondary sort key — spec §3 禁 composite/multi-key
      // ("display 4 separate dimensions, let user pick sort dimension")
      const rows = await dbAll(`
        SELECT u.id, u.handle, u.name,
          COUNT(dc.id) as cases_count,
          COALESCE(SUM(dc.fairness_yes), 0) as total_yes,
          COALESCE(SUM(dc.fairness_no), 0) as total_no,
          CASE
            WHEN COALESCE(SUM(dc.fairness_yes + dc.fairness_no), 0) > 0
            THEN ROUND(CAST(SUM(dc.fairness_yes) AS REAL) / SUM(dc.fairness_yes + dc.fairness_no), 3)
            ELSE NULL
          END as fairness_score
        FROM dispute_cases dc
        JOIN users u ON u.id = dc.arbitrator_id
        WHERE dc.arbitrator_id IS NOT NULL
        GROUP BY u.id
        ORDER BY cases_count DESC, u.id DESC LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }
    if (kind === 'verifiers') {
      // 2026-05-22 V1：移除 tasks_done >= 5 门槛 — 小协议早期阶段会卡死榜单
      // 新人有 tasks_done < 5 时前端打 "新人" badge 区分（仍能看到自己排名）
      //
      // 2026-06-03 #1080 audit: ORDER BY 改为 tasks_done desc(spec default case_count desc)
      // + u.id tie-breaker。移除 tasks_correct/accuracy 作为 secondary sort key — 该排序奖励
      // "活跃 + 准确" 隐含 composite,spec §3 明确"最活跃 first ≠ 最好 first"。
      const rows = await dbAll(`
        SELECT u.id, u.handle, u.name,
          vs.tasks_done, vs.tasks_correct, vs.tasks_wrong,
          CASE WHEN vs.tasks_done > 0 THEN ROUND(CAST(vs.tasks_correct AS REAL) / vs.tasks_done, 3) ELSE NULL END as accuracy,
          vw.tier
        FROM verifier_stats vs
        JOIN users u ON u.id = vs.user_id
        LEFT JOIN verifier_whitelist vw ON vw.user_id = vs.user_id
        WHERE vs.tasks_done >= 1
        ORDER BY vs.tasks_done DESC, u.id DESC LIMIT ?
      `, [limit])
      return void res.json({ kind, items: projectBoard(kind, rows) })
    }

    return void res.json({ error: 'kind 必须是 products / creators / buyers / sellers / verifiers / arbitrators / agents / value_products' })
  })
}
