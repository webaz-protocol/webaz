/**
 * 跟卖 Offer 管理域
 *
 * 由 #1013 Phase 51 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   PATCH  /api/offers/:id           修改 offer（薄包装，仅 listing 跟卖类字段）
 *   DELETE /api/offers/:id           撤回（status=warehouse + 释放 stake；不真删 product）
 *   POST   /api/offers/:id/refresh   现货确认（更新 freshness_ts）
 *
 * 边界：
 *   - 仅 owner 可操作
 *   - 撤回时有进行中订单 → 拒
 *   - VALID_FULFILLMENT_TYPES 通过 deps 注入（RFQ 也用）
 *
 * 注：常规 product 字段走 /api/products/:id/status；这里只覆盖跟卖独有字段
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface OffersDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  VALID_FULFILLMENT_TYPES: Set<string>
}

export function registerOffersRoutes(app: Application, deps: OffersDeps): void {
  // db 仍保留:用于 DELETE /offers 的 db.transaction(撤回 offer + 释放质押守恒,better-sqlite3 事务须同步)。
  // 其余只读/单写站点已走 RFC-016 异步 seam(dbOne/dbRun)。
  const { db, auth, VALID_FULFILLMENT_TYPES } = deps

  app.patch('/api/offers/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const offer = await dbOne<Record<string, unknown>>("SELECT * FROM products WHERE id = ? AND listing_id IS NOT NULL", [req.params.id])
    if (!offer) return void res.status(404).json({ error: 'offer 不存在' })
    if (offer.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家本人可修改' })

    const body = req.body as Record<string, unknown>
    const updates: string[] = []
    const args: unknown[] = []

    if (body.price != null) {
      const p = Number(body.price)
      if (!Number.isFinite(p) || p <= 0) return void res.json({ error: 'price 必须 > 0' })
      updates.push('price = ?'); args.push(p)
    }
    if (body.stock != null) {
      const s = Math.max(0, Math.floor(Number(body.stock) || 0))
      updates.push('stock = ?'); args.push(s)
    }
    if (body.fulfillment_type != null) {
      const ft = String(body.fulfillment_type)
      if (!VALID_FULFILLMENT_TYPES.has(ft)) return void res.json({ error: 'fulfillment_type 无效' })
      updates.push('fulfillment_type = ?'); args.push(ft)
    }
    if (body.eta_hours != null) { updates.push('eta_hours = ?'); args.push(Number(body.eta_hours)) }
    if (body.is_clearance != null) { updates.push('is_clearance = ?'); args.push(body.is_clearance ? 1 : 0) }
    if (body.clearance_until !== undefined) { updates.push('clearance_until = ?'); args.push(body.clearance_until ? String(body.clearance_until) : null) }

    if (!updates.length) return void res.json({ error: '无任何修改' })
    updates.push("updated_at = datetime('now')")
    updates.push("freshness_ts = datetime('now')")
    args.push(req.params.id)
    await dbRun(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, args)
    res.json({ success: true })
  })

  // 撤回 offer（status=warehouse + 释放 stake；不真删 product）
  app.delete('/api/offers/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const offer = await dbOne<Record<string, unknown>>("SELECT * FROM products WHERE id = ? AND listing_id IS NOT NULL", [req.params.id])
    if (!offer) return void res.status(404).json({ error: 'offer 不存在' })
    if (offer.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家本人可撤回' })

    const pending = (await dbOne<{ n: number }>(`SELECT COUNT(1) as n FROM orders WHERE product_id = ? AND status NOT IN ('completed','cancelled','refunded','expired')`, [req.params.id]))!
    if (pending.n > 0) return void res.json({ error: `该 offer 有 ${pending.n} 个进行中订单，暂无法撤回` })

    const stake = Number(offer.listing_stake_locked) || 0
    const tx = db.transaction(() => {
      // await-gap P1(proactive sweep,与 #239 系列同类):offer 行先 await 读出 stake,再进同步 tx 释放。
      //   并发双撤回会都读到同一 listing_stake_locked 并各退一次 → 双倍退质押(印钱)。CAS 抢占该 offer
      //   (仍未撤回 + stake 仍等于读到的值),changes!==1 即并发已撤回 → 抛回滚,先于任何钱写。
      const flip = db.prepare(`UPDATE products SET status = 'warehouse', listing_stake_locked = 0, updated_at = datetime('now') WHERE id = ? AND status != 'warehouse' AND listing_stake_locked = ?`).run(req.params.id, stake)
      if (flip.changes !== 1) throw new Error('OFFER_ALREADY_WITHDRAWN')
      if (stake > 0) {
        // Codex #254 follow-up P2:钱包释放带 staked>=stake 守卫 + changes 校验。若 wallet 行缺失或
        //   staked < listing_stake_locked(历史漂移/并发异常/前序 bug),不能在已清零 products.stake 的同时
        //   让 staked 变负或丢质押 —— changes!==1 即抛回滚整笔(products 不清零、listings 不递减、钱包不动)。
        const rel = db.prepare(`UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ? AND staked >= ?`).run(stake, stake, user.id, stake)
        if (rel.changes !== 1) throw new Error('OFFER_STAKE_INVARIANT_VIOLATION')
      }
      db.prepare(`UPDATE listings SET total_offers = MAX(0, total_offers - 1) WHERE id = ?`).run(String(offer.listing_id))
    })
    try { tx() } catch (e) {
      const m = (e as Error).message
      if (m === 'OFFER_ALREADY_WITHDRAWN') return void res.status(409).json({ error: '该 offer 已撤回（请刷新）', error_code: 'OFFER_ALREADY_WITHDRAWN' })
      if (m === 'OFFER_STAKE_INVARIANT_VIOLATION') return void res.status(500).json({ error: '质押释放校验失败（资金状态异常，已回滚未做任何变更，请联系支持）', error_code: 'OFFER_STAKE_INVARIANT_VIOLATION' })
      return void res.status(500).json({ error: String(m) })
    }
    res.json({ success: true, stake_released: stake })
  })

  // 刷新 freshness（卖家点 "现货确认"）
  app.post('/api/offers/:id/refresh', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const offer = await dbOne<{ seller_id: string }>("SELECT seller_id FROM products WHERE id = ? AND listing_id IS NOT NULL", [req.params.id])
    if (!offer) return void res.status(404).json({ error: 'offer 不存在' })
    if (offer.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家本人可刷新' })
    await dbRun(`UPDATE products SET freshness_ts = datetime('now') WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  })
}
