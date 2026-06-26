/**
 * Promoter / 推广视图 — dashboard + team
 *
 * 由 #1013 Phase 77 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   GET /api/promoter/dashboard  推广视图（团队 L1-L3 + 佣金分层 + placement 参与记录 + insights）
 *   GET /api/promoter/team       直推 L1 列表
 *
 * dashboard 输出包含：
 *   - team: L1/L2/L3 计数
 *   - earnings: 按 level 聚合 + 最近 20 条流水
 *   - shareable_products: 我买过且有 commission_rate 的可分享商品
 *   - projection: 30日/60日佣金/WAZ 对比
 *   - insights: dormancy / share-hint 等智能洞察
 *   - atomic: 左右区 PV + 左右 child + placement 树（参与记录,无奖励指标）
 *   - permissions: can_l1_share + override 状态
 *
 * 跨域注入：auth + isAllowedSponsor
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // 真实成交单一真相源

export interface PromoterDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isAllowedSponsor: (userId: string) => boolean
  // Category C gate state (injected from server.ts): participation recording (default ON) vs matching-rewards payout (default OFF)
  participationRecordingActive: () => boolean
  matchingRewardsActive: () => boolean
}

export function registerPromoterRoutes(app: Application, deps: PromoterDeps): void {
  const { db, auth, isAllowedSponsor, participationRecordingActive } = deps
  void db  // RFC-016: 本文件已全量走异步 seam;db 仍在 deps 由调用方注入,此处不直接使用

  app.get('/api/promoter/dashboard', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string

    const l1 = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM users WHERE sponsor_id = ?", [userId]))!.n
    const l2 = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM users
      WHERE sponsor_id IN (SELECT id FROM users WHERE sponsor_id = ?)
    `, [userId]))!.n
    const l3 = (await dbOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM users
      WHERE sponsor_id IN (
        SELECT id FROM users WHERE sponsor_id IN (SELECT id FROM users WHERE sponsor_id = ?)
      )
    `, [userId]))!.n

    const earned = await dbAll<{ level: number; orders: number; total: number }>(`
      SELECT level, COUNT(*) as orders, COALESCE(SUM(amount),0) as total
      FROM commission_records WHERE beneficiary_id = ?
      GROUP BY level
    `, [userId])
    const byLevel: Record<number, { orders: number; total: number }> = { 1: { orders: 0, total: 0 }, 2: { orders: 0, total: 0 }, 3: { orders: 0, total: 0 } }
    for (const r of earned) byLevel[r.level] = { orders: r.orders, total: r.total }
    const grand = byLevel[1].total + byLevel[2].total + byLevel[3].total
    // RFC-018: commission accrued but still in the clearing window (matures into grand_total). Pure read.
    const clearing = (await dbOne<{ s: number }>("SELECT COALESCE(SUM(amount),0) as s FROM pending_commission_escrow WHERE recipient_user_id = ? AND matures_at IS NOT NULL AND status = 'pending'", [userId]))!.s

    const recent = await dbAll(`
      SELECT cr.id, cr.order_id, cr.level, cr.amount, cr.rate, cr.created_at,
             u.name as source_buyer_name
      FROM commission_records cr
      LEFT JOIN users u ON u.id = cr.source_buyer_id
      WHERE cr.beneficiary_id = ?
      ORDER BY cr.created_at DESC LIMIT 20
    `, [userId])

    const me = (await dbOne<{ sponsor_id: string | null; sponsor_path: string | null; region: string | null }>("SELECT sponsor_id, sponsor_path, region FROM users WHERE id = ?", [userId]))!
    const mySponsor = me?.sponsor_id ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [me.sponsor_id])) : null

    const myUser = await dbOne<Record<string, unknown>>("SELECT total_left_pv, total_right_pv, left_child_id, right_child_id, placement_id, placement_side FROM users WHERE id = ?", [userId])
    const leftChildName  = myUser?.left_child_id  ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [myUser.left_child_id]))?.name : null
    const rightChildName = myUser?.right_child_id ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [myUser.right_child_id]))?.name : null
    const myPlacementName = myUser?.placement_id ? (await dbOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [myUser.placement_id]))?.name : null

    // matching-rewards reads (score / recent matches / tier config) removed — engine excised (#401).
    const canL1Share = isAllowedSponsor(userId)
    const completedOrders = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [userId]))!.n  // 真实成交,排除退款/违约
    const overrideRow = await dbOne<{ l1_share_override: number }>("SELECT l1_share_override FROM users WHERE id = ?", [userId])

    const shareableProducts = await dbAll<Record<string, unknown>>(`
      SELECT p.id, p.title, p.price, p.category, p.commission_rate,
        (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND o.status = 'completed') as total_sales,
        COALESCE((SELECT SUM(cr.amount) FROM commission_records cr
                  JOIN orders o2 ON o2.id = cr.order_id
                  WHERE cr.beneficiary_id = ? AND o2.product_id = p.id), 0) as my_earned
      FROM products p
      WHERE p.id IN (SELECT DISTINCT product_id FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')})
        AND p.commission_rate IS NOT NULL AND p.commission_rate > 0
        AND p.status = 'active'
      ORDER BY my_earned DESC, total_sales DESC LIMIT 20
    `, [userId, userId])

    const earnedLast30 = (await dbOne<{ total: number }>(`
      SELECT COALESCE(SUM(amount),0) as total FROM commission_records
      WHERE beneficiary_id = ? AND created_at >= datetime('now','-30 days')
    `, [userId]))!.total
    const earnedPrev30 = (await dbOne<{ total: number }>(`
      SELECT COALESCE(SUM(amount),0) as total FROM commission_records
      WHERE beneficiary_id = ? AND created_at >= datetime('now','-60 days')
        AND created_at < datetime('now','-30 days')
    `, [userId]))!.total
    const projection = {
      last_30_commission:  earnedLast30,
      prev_30_commission:  earnedPrev30,
      growth_rate:         earnedPrev30 > 0 ? earnedLast30 / earnedPrev30 - 1 : null,
      next_30_estimate:    earnedLast30,
    }

    const insights: { type: string; level: string; text: string }[] = []
    // 匹配奖励引擎已切除(#401):不展示任何奖励经营建议;位置 / PV 仅为参与记录,非收益路径。
    const lastInvite = (await dbOne<{ t: string | null }>(`SELECT MAX(created_at) as t FROM users WHERE sponsor_id = ?`, [userId]))!
    if (lastInvite.t) {
      const days = Math.floor((Date.now() - new Date(lastInvite.t).getTime()) / 86400_000)
      if (days > 14) insights.push({ type: 'dormancy', level: 'warn', text: `${days} 天没有新直推 — 链接还在裤兜里？` })
      else if (days < 3) insights.push({ type: 'hot', level: 'success', text: `${days} 天前刚有新直推 — 趁热打铁` })
    } else if (l1 === 0) {
      insights.push({ type: 'no_team', level: 'info', text: `还没有直推 — 先分享你买过且好评的商品给好友` })
    }
    if (!canL1Share && completedOrders === 0) {
      insights.push({ type: 'share_hint', level: 'info', text: `完成首笔购买后可使用分享功能;分享记录仅作归因 / 参与记录,不构成收益承诺。` })
    }
    if (shareableProducts.length > 0 && grand === 0) {
      insights.push({ type: 'first_share', level: 'info', text: `你有 ${shareableProducts.length} 个可分享商品但暂无成交 — 试着把链接发给身边的人` })
    }

    const treeNode = async (uid: unknown) => {
      if (!uid) return null
      const u = await dbOne<Record<string, unknown>>("SELECT id, name, total_left_pv, total_right_pv, left_child_id, right_child_id FROM users WHERE id = ?", [uid])
      if (!u) return null
      return {
        id: u.id, name: u.name,
        lpv: Number(u.total_left_pv  ?? 0),
        rpv: Number(u.total_right_pv ?? 0),
        left_id:  u.left_child_id  ?? null,
        right_id: u.right_child_id ?? null,
      }
    }
    const me_node    = await treeNode(userId)
    const left_node  = await treeNode(myUser?.left_child_id)
    const right_node = await treeNode(myUser?.right_child_id)
    const binaryTree = {
      me:    me_node,
      left:  left_node,
      right: right_node,
      ll:    await treeNode(left_node?.left_id),
      lr:    await treeNode(left_node?.right_id),
      rl:    await treeNode(right_node?.left_id),
      rr:    await treeNode(right_node?.right_id),
    }

    const meCard = await dbOne<{ permanent_code: string | null; handle: string | null }>("SELECT permanent_code, handle FROM users WHERE id = ?", [userId])
    // invite links use permanent_code ONLY — never fall back to user_id (would leak usr_xxx into ?ref).
    const codeForLink = meCard?.permanent_code || null
    const host = `${req.protocol}://${req.get('host')}`
    res.json({
      user_id: userId,
      permanent_code: meCard?.permanent_code || null,
      handle: meCard?.handle || null,
      invite_code_available: !!codeForLink,
      referral_link: codeForLink ? `${host}/i/${codeForLink}` : null,
      invite_unavailable_reason: codeForLink ? null : 'permanent_code_missing — refresh or contact support',
      region: me?.region || 'global',
      my_sponsor: mySponsor ? { id: me!.sponsor_id, name: mySponsor.name } : null,
      permissions: {
        can_l1_share:        canL1Share,
        completed_orders:    completedOrders,
        l1_share_override:   overrideRow?.l1_share_override ?? 0,
        reason: canL1Share
          ? (overrideRow?.l1_share_override === 1 ? 'admin_grant' : 'verified_buyer')
          : 'need_completed_order',
      },
      team: { l1, l2, l3, total: l1 + l2 + l3 },
      earnings: {
        grand_total: grand,
        clearing_total: clearing,   // RFC-018: accrued, maturing after the return window (not yet paid)
        l1: byLevel[1],
        l2: byLevel[2],
        l3: byLevel[3],
      },
      recent,
      shareable_products: shareableProducts,
      projection,
      insights,
      gates: { participation_recording_active: participationRecordingActive() },
      // Neutral participation record only — placement position + per-leg PV. No rewards (matching engine excised #401).
      // (response keys `atomic` / `binary_tree` kept as the placement structure's stable shape — frontend reads them)
      atomic: {
        total_left_pv:    Number(myUser?.total_left_pv  ?? 0),
        total_right_pv:   Number(myUser?.total_right_pv ?? 0),
        left_child:       myUser?.left_child_id  ? { id: myUser.left_child_id,  name: leftChildName }  : null,
        right_child:      myUser?.right_child_id ? { id: myUser.right_child_id, name: rightChildName } : null,
        my_placement:     myUser?.placement_id ? { id: myUser.placement_id, name: myPlacementName, side: myUser.placement_side } : null,
        binary_tree:      binaryTree,
      },
    })
  })

  // 直推 L1 列表
  app.get('/api/promoter/team', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const rows = await dbAll(`
      SELECT u.id, u.name, u.created_at, u.region,
        (SELECT COUNT(*) FROM users WHERE sponsor_id = u.id) as their_l1,
        COALESCE((SELECT SUM(amount) FROM commission_records WHERE beneficiary_id = ? AND source_buyer_id = u.id), 0) as my_earned_from_them
      FROM users u WHERE u.sponsor_id = ?
      ORDER BY u.created_at DESC LIMIT 100
    `, [userId, userId])
    res.json({ team: rows })
  })
}
