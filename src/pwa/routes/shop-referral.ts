/**
 * 店铺推荐锚定 — POST /api/shop-referral/touch
 *
 * 锚定"谁把这家店推荐给了我"(推荐关系 + 二叉树位置 + 店铺来源),first-touch 30 天锁。它【不是】全店佣金权:
 * 真正的商品三级分润仍只在 buyer 真实下单某商品、且推荐人自己也 completed 买过同款时,由 orders-create 的
 * maybePromoteShopReferralToProductAttribution 懒升级为该商品的 product_share_attribution。
 *
 * ref 边界:referrer 只接受 permanent_code(旧 -L/-R 后缀接受但归一化、忽略 side)—— usr_xxx / @handle / 裸 handle 一律拒绝
 * (与全站邀请面收窄一致)。seller_identifier 是个人页定位(非邀请用途),沿用 resolveUserRef 多形态解析。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export interface ShopReferralDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string, extra?: Record<string, unknown>) => void
  internalAuditorId: string
  resolveUserRef: (raw: string | null | undefined) => string | null
  resolveInviteCodeRef: (raw: string) => { userId: string; code: string; side: 'left' | 'right' | null } | null
}

export function registerShopReferralRoutes(app: Application, deps: ShopReferralDeps): void {
  const { auth, errorRes, internalAuditorId, resolveUserRef, resolveInviteCodeRef } = deps

  app.post('/api/shop-referral/touch', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const recipientId = user.id as string
    const { seller_identifier, ref_code } = req.body || {}
    if (!seller_identifier || typeof seller_identifier !== 'string') return void errorRes(res, 400, 'SELLER_REQUIRED', 'seller_identifier required')
    if (!ref_code || typeof ref_code !== 'string') return void errorRes(res, 400, 'REF_REQUIRED', 'ref_code required')

    // referrer = invite code ONLY (permanent_code); usr_xxx / @handle / handle rejected.
    // pre-public 去左右码:旧 -L/-R 后缀仍被接受但归一化为基础码(ref.code),side 一律忽略。
    const ref = resolveInviteCodeRef(ref_code)
    if (!ref) return void errorRes(res, 400, 'INVALID_REF_CODE', '邀请码无效（仅 6-7 位永久码）')
    const referrerId = ref.userId
    // pre-public 去左右码:不再按 side 归属(忽略 body.side 与邀请码 -L/-R),统一存 null
    const finalSide: 'left' | 'right' | null = null

    // seller 定位:个人页多形态(usr_xxx / @handle / handle / permanent_code)。
    // 必须是真实 seller 店铺 —— 普通 buyer / admin / 其它角色不能被写成 shop_referral_attribution.seller_id。
    const sellerId = resolveUserRef(seller_identifier)
    if (!sellerId) return void errorRes(res, 404, 'SELLER_NOT_FOUND', '店铺不存在')
    const sellerRow = await dbOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [sellerId])
    if (sellerRow?.role !== 'seller') return void errorRes(res, 404, 'SELLER_NOT_FOUND', '店铺不存在')
    if ([referrerId, sellerId].some(id => id === 'sys_protocol' || id === internalAuditorId)) {
      return void errorRes(res, 400, 'INVALID_PARTY', '无效推荐关系')
    }
    // 退化关系安全跳过(不报错,不写坏数据)
    if (recipientId === referrerId) return void res.json({ ok: true, attributed: false, skipped: 'self_referral', seller_id: sellerId })
    if (recipientId === sellerId)   return void res.json({ ok: true, attributed: false, skipped: 'recipient_is_seller', seller_id: sellerId })

    // first-touch:已有未过期记录不覆盖;过期记录可被刷新。
    const existing = await dbOne<{ referrer_id: string }>(
      "SELECT referrer_id FROM shop_referral_attribution WHERE seller_id = ? AND recipient_id = ? AND expires_at > datetime('now')",
      [sellerId, recipientId])
    if (existing) return void res.json({ ok: true, attributed: false, skipped: 'already_locked', seller_id: sellerId })

    const had = await dbOne<{ referrer_id: string }>("SELECT referrer_id FROM shop_referral_attribution WHERE seller_id = ? AND recipient_id = ?", [sellerId, recipientId])
    try {
      if (had) {
        // 只刷新仍过期的行(WHERE 双保险:并发下另一请求先刷新 → 本次 0 行,不覆盖)
        await dbRun("UPDATE shop_referral_attribution SET referrer_id = ?, ref_code = ?, side = ?, created_at = datetime('now'), expires_at = datetime('now','+30 days'), source = 'shop_referral' WHERE seller_id = ? AND recipient_id = ? AND expires_at <= datetime('now')",
          [referrerId, ref.code, finalSide, sellerId, recipientId])
      } else {
        await dbRun("INSERT INTO shop_referral_attribution (seller_id, recipient_id, referrer_id, ref_code, side, expires_at) VALUES (?,?,?,?,?, datetime('now','+30 days'))",
          [sellerId, recipientId, referrerId, ref.code, finalSide])
      }
    } catch {
      // SELECT→INSERT 非原子(async seam):并发 first-touch 撞 PRIMARY KEY → 视作已锁定,不 500
      return void res.json({ ok: true, attributed: false, skipped: 'already_locked', seller_id: sellerId })
    }
    res.json({ ok: true, attributed: true, seller_id: sellerId })
  })
}
