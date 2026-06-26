/**
 * 邀请码（个人邀请 dashboard + 商品分享链接）
 *
 * 由 #1013 Phase 98 从 src/pwa/server.ts 抽出。
 *
 * endpoints:
 *   GET  /api/referral/me   B-1 个人邀请 dashboard（链接 + 直推 + earning 3 桶）
 *   GET  /api/share-link    生成商品分享链接（rewards opt-in gate）
 *
 * 跨域注入：auth
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { genuineSalePredicate } from '../../layer0-foundation/L0-2-state-machine/genuine-sale.js'  // 真实成交单一真相源

export interface ReferralDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerReferralRoutes(app: Application, deps: ReferralDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth } = deps

  // B-1: 个人邀请 dashboard
  app.get('/api/referral/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const code = user.permanent_code || null
    // 我直接邀请的人
    const directInvitees = await dbAll<{ id: string; handle: string; name: string; role: string; created_at: string; completed_orders: number; gmv: number }>(`
      SELECT u.id, u.handle, u.name, u.role, u.created_at,
        (SELECT COUNT(*) FROM orders WHERE buyer_id = u.id AND status = 'completed') as completed_orders,
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE buyer_id = u.id AND status = 'completed') as gmv
      FROM users u WHERE u.sponsor_id = ?
      ORDER BY u.created_at DESC LIMIT 50
    `, [user.id])
    // 推土机奖励 / 商品分享佣金（commission_records 按订单粒度）
    const earnings = (await dbOne<{ cnt: number; total: number }>(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total FROM commission_records WHERE beneficiary_id = ?
    `, [user.id]))!
    const todayEarnings = (await dbOne<{ t: number }>(`SELECT COALESCE(SUM(amount), 0) as t FROM commission_records WHERE beneficiary_id = ? AND created_at > datetime('now', '-1 day')`, [user.id]))!.t
    const monthEarnings = (await dbOne<{ t: number }>(`SELECT COALESCE(SUM(amount), 0) as t FROM commission_records WHERE beneficiary_id = ? AND created_at > datetime('now', '-30 days')`, [user.id]))!.t
    // RFC-018: commission accrued but still in the clearing window (pending → matures into total_waz).
    // Pure read; surfaced so earnings don't appear to vanish during clearing (Option A keeps total_waz = paid).
    const clearingWaz = (await dbOne<{ t: number }>(`SELECT COALESCE(SUM(amount), 0) as t FROM pending_commission_escrow WHERE recipient_user_id = ? AND matures_at IS NOT NULL AND status = 'pending'`, [user.id]))!.t

    res.json({
      invite_code: code,
      invite_link: code ? `${req.protocol}://${req.get('host')}/i/${code}` : null,
      invite_unavailable_reason: code ? null : 'permanent_code_missing — refresh or contact support',
      direct_invitees_count: directInvitees.length,
      direct_invitees: directInvitees,
      earnings: {
        total_records: earnings.cnt,
        total_waz: earnings.total,
        today_waz: todayEarnings,
        month_waz: monthEarnings,
        clearing_waz: clearingWaz,   // RFC-018: accrued, maturing after the return window (not yet paid)
      },
    })
  })

  // RFC-003 #1122: 生成商品分享链接(把 MCP webaz_share_link 的本地计算搬到服务端,
  // 让 MCP NETWORK 模式可代理)。RFC-002 §3.5 valuation-layer gate:需 rewards opt-in。
  // pre-public 去左右码:不再接受/返回 side,放置侧别由注册时系统自动决定。
  app.get('/api/share-link', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const productId = String(req.query.product_id || '')
    if (!productId) return void res.status(400).json({ error: 'product_id required', error_code: 'PRODUCT_ID_REQUIRED' })

    const optIn = (await dbOne<{ rewards_opted_in: number }>("SELECT rewards_opted_in FROM users WHERE id = ?", [userId]))?.rewards_opted_in ?? 0
    if (optIn !== 1) {
      const getParam = async (key: string, def: number): Promise<number> => {
        const r = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = ?", [key])
        return r ? Number(r.value) : def
      }
      const minOrders = await getParam('rewards_opt_in.min_completed_orders', 1)
      const requirePasskey = await getParam('rewards_opt_in.require_passkey', 1)
      const totalCompleted = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [userId]))!.n  // 真实成交,排除退款/违约
      const passkeyCount = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?", [userId]))!.n
      const missing: string[] = []
      if (totalCompleted < minOrders) missing.push(`completed_orders ${totalCompleted}/${minOrders}`)
      if (requirePasskey === 1 && passkeyCount === 0) missing.push('passkey_not_registered')
      if (missing.length === 0) missing.push('application_not_submitted')
      return void res.status(403).json({
        error: 'rewards_opt_in_required',
        message: 'Share-link generation is a valuation-layer (rewards / share-link) action, NOT a contribution gate — requires rewards / share-commission opt-in (RFC-002 §3.5)',
        missing_requirements: missing,
        next_steps: [
          'Open PWA #me → tap "申请分享分润 / Enable share-commission opt-in"',
          'Read the 8-second disclosure (cannot skip)',
          'Submit application — pre-checks run server-side',
        ],
      })
    }

    const product = await dbOne<{ id: string; title: string; price: number; commission_rate: number | null }>("SELECT id, title, price, commission_rate FROM products WHERE id = ? AND status='active'", [productId])
    if (!product) return void res.status(404).json({ error: '商品不存在或已下架', error_code: 'PRODUCT_NOT_FOUND' })

    // pre-public 去左右码:分享链接不再计算/携带 side(放置侧别由注册时系统自动决定)
    const completed = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND ${genuineSalePredicate('orders')}`, [userId]))!.n  // 真实成交,排除退款/违约
    const override = (await dbOne<{ l1_share_override: number }>("SELECT l1_share_override FROM users WHERE id = ?", [userId]))?.l1_share_override ?? 0
    const canL1 = override === 1 || (override === 0 && completed > 0)
    const rate = Number(product.commission_rate ?? 0)
    // share ref uses permanent_code ONLY — never the raw user_id; fail clearly if it's missing.
    const refCode = (await dbOne<{ permanent_code: string | null }>("SELECT permanent_code FROM users WHERE id = ?", [userId]))?.permanent_code || null
    if (!refCode) return void res.status(409).json({ error: '邀请码暂不可用，请刷新或联系支持', error_code: 'PERMANENT_CODE_MISSING' })
    const link = `/?ref=${refCode}#order-product/${productId}`
    res.json({
      product: { id: product.id, title: product.title, price: product.price, commission_rate: rate },
      share_link: link,
      full_url_hint: 'Prepend webaz.xyz (production) to get the absolute URL',
      placement_note: 'New user via this link → placement is recorded automatically by the system (no left/right choice).',
      commission_eligibility: canL1
        ? `You will earn 3-tier commission: L1=${(rate*0.70*100).toFixed(1)}% L2=${(rate*0.20*100).toFixed(1)}% L3=${(rate*0.10*100).toFixed(1)}% of sale price`
        : 'You are NOT verified yet (need 1 completed purchase). 3-tier commission will be skipped, but points-matching still builds.',
      next_steps: 'Share on TikTok / WeChat / Telegram. New user clicks → 30-day attribution window starts.',
    })
  })
}
