/**
 * 测评免单 (product trial campaigns) 域端点 + 评估 cron
 *
 * 由 #1013 Phase 3 从 src/pwa/server.ts 抽出。第三次试水拆分模式 — 包含 cron。
 *
 * 9 endpoints:
 *   POST   /api/products/:product_id/trial-campaign  — 卖家开/更新活动
 *   DELETE /api/products/:product_id/trial-campaign  — 卖家关闭
 *   GET    /api/products/:product_id/trial-campaign  — 公开查询活动状态
 *   POST   /api/products/:product_id/trial-claim     — 买家申请名额
 *   POST   /api/trial-claims/:claim_id/link-note     — 买家关联笔记
 *   GET    /api/me/trial-claims                      — 买家：我的测评
 *   GET    /api/me/seller/trial-campaigns            — 卖家：我的活动
 *   GET    /api/trial-campaigns/:campaign_id/claims  — 卖家：活动 claims 详情
 *   POST   /api/admin/trial/run-eval                 — admin 手动触发评估
 *
 * + evaluateTrialClaims() — 评估 cron 函数（由 server.ts setInterval 调用）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
// RFC-016 Phase 1 — 端点纯校验读/公开读/读回 + 单语句写 + cron 顶层扫描读 → async seam;
//   退款 db.transaction + claim 抢名额 tx + cron 逐 claim 评估读写保持同步(Phase 3 迁 pg)。
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export interface TrialDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  clientIpHash: (req: Request) => string
  clientUaHash: (req: Request) => string
  // pre-bound 'protocol' 权限 admin gate（同 Phase 2 welcome.ts 的 requireSupportAdmin 模式）
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  // run-eval 会从卖家钱包扣款退给买家 → 必须记录触发的 admin + 结果摘要(治理审计铁律)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

// ─── 评估 cron — 重算 reach_score 决定退款 / 兜底超时 ──────────
// reach_score = views(unique_click_count)*0.1 + shares(child notes)*1 + conversions(attributed orders)*10
// 达阈 → 从卖家钱包扣 refund_amount 退给买家；30 天兜底超时
export async function evaluateTrialClaims(
  db: Database.Database,
  generateId: (prefix: string) => string,
): Promise<{ evaluated: number; refunded: number; expired: number }> {
  let evaluated = 0, refunded = 0, expired = 0
  // RFC-016: 顶层候选扫描读 → seam;下方逐 claim 的 metrics 读 + 退款 db.transaction 仍同步(Phase 3)。
  const candidates = await dbAll<Record<string, unknown>>(`
    SELECT c.*,
           -- 审计 P0-2：优先用 snapshot 字段（claim 时锁定），fallback 到 campaign 当前值
           COALESCE(c.snap_reach_threshold, camp.reach_threshold) as eval_threshold,
           COALESCE(c.snap_min_days_live, camp.min_days_live) as eval_min_days_live,
           COALESCE(c.snap_min_chars, camp.min_chars) as eval_min_chars,
           o.total_amount as order_amount,
           -- 审计 P1-3：用 unique_click_count（dedup by IP+UA）而非 raw click_count
           COALESCE(n.unique_click_count, n.click_count, 0) as views,
           n.like_count, n.native_text, n.photo_hashes, n.status as note_status
    FROM product_trial_claims c
    JOIN product_trial_campaigns camp ON camp.id = c.campaign_id
    JOIN orders o ON o.id = c.order_id
    LEFT JOIN shareables n ON n.id = c.note_id
    WHERE c.status = 'pending_threshold' AND c.note_id IS NOT NULL
  `)

  for (const r of candidates) {
    evaluated++
    try {
      // 笔记必须仍存在 + active + 满足最少字数 + 至少 1 张图
      if (!r.note_status || r.note_status !== 'active') continue
      const txtLen = String(r.native_text || '').length
      if (txtLen < Number(r.eval_min_chars || 50)) continue
      const photos = r.photo_hashes ? JSON.parse(String(r.photo_hashes)) : []
      if (!Array.isArray(photos) || photos.length === 0) continue

      // 检查 note 是否 live 够久
      const linkedAt = new Date(String(r.note_linked_at)).getTime()
      const liveDays = (Date.now() - linkedAt) / 86400_000
      if (liveDays < Number(r.eval_min_days_live || 7)) continue

      // 30 天兜底超时
      if (liveDays > 30) {
        db.prepare("UPDATE product_trial_claims SET status='expired', expired_at=datetime('now'), last_eval_at=datetime('now') WHERE id=? AND status='pending_threshold'").run(r.id)
        expired++
        continue
      }

      // 计算 metrics（views 已用 unique 去重）
      const views = Number(r.views || 0)
      const sharesRow = db.prepare("SELECT COUNT(*) as n FROM shareables WHERE parent_id = ? AND status='active'").get(r.note_id) as { n: number }
      const shares = Number(sharesRow?.n || 0)
      const convRow = db.prepare(`SELECT COUNT(DISTINCT o2.id) as n FROM orders o2
        JOIN product_share_attribution psa ON psa.product_id = o2.product_id AND psa.recipient_id = o2.buyer_id
        WHERE psa.shareable_id = ? AND o2.status IN ('confirmed','completed')
          AND o2.buyer_id != ?
          AND o2.created_at >= psa.created_at`).get(r.note_id, r.buyer_id) as { n: number }
      const conversions = Number(convRow?.n || 0)
      const reachScore = views * 0.1 + shares * 1 + conversions * 10
      const metricsJson = JSON.stringify({ views, shares, conversions })

      if (reachScore >= Number(r.eval_threshold || 50)) {
        // 达阈 → 退款。卖家钱包扣 refund_amount，买家钱包加（不变 escrow / commission）
        const amount = Number(r.order_amount || 0)
        if (amount <= 0) {
          db.prepare("UPDATE product_trial_claims SET reach_score=?, metrics_json=?, last_eval_at=datetime('now') WHERE id=? AND status='pending_threshold'").run(reachScore, metricsJson, r.id)
          continue
        }
        const seller = db.prepare("SELECT balance FROM wallets WHERE user_id = ?").get(r.seller_id) as { balance: number } | undefined
        if (!seller || Number(seller.balance) < amount) {
          // 卖家余额不足 — 暂不退，下次再评（卖家可能补充余额）
          db.prepare("UPDATE product_trial_claims SET reach_score=?, metrics_json=?, last_eval_at=datetime('now') WHERE id=? AND status='pending_threshold'").run(reachScore, metricsJson, r.id)
          continue
        }
        const tx = db.transaction(() => {
          // Codex #233 P1:先用 CAS 抢占 claim(pending_threshold→refunded),changes!==1 说明
          // 并发 eval(cron + admin 手动 / 重叠调用)已退过 → 抛回滚,杜绝双退。先于任何钱包写。
          const claimed = db.prepare(`UPDATE product_trial_claims SET status='refunded', refund_amount=?, refunded_at=datetime('now'),
            reach_score=?, metrics_json=?, last_eval_at=datetime('now') WHERE id=? AND status='pending_threshold'`).run(amount, reachScore, metricsJson, r.id)
          if (claimed.changes !== 1) throw new Error('TRIAL_ALREADY_SETTLED')
          // 卖家扣款带余额守卫(balance>=amount);changes!==1 → 余额在预检后已变 → 抛回滚,买家不入账
          const debited = db.prepare("UPDATE wallets SET balance = balance - ?, updated_at=datetime('now') WHERE user_id = ? AND balance >= ?").run(amount, r.seller_id, amount)
          if (debited.changes !== 1) throw new Error('TRIAL_SELLER_INSUFFICIENT')
          db.prepare("INSERT INTO wallets (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?, updated_at=datetime('now')").run(r.buyer_id, amount, amount)
          try {
            // notifications schema 没有 data 列；用 actions（JSON 数组）存可点击跳转
            db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, actions)
              VALUES (?, ?, 'trial_refunded', ?, ?, ?)`).run(
                generateId('ntf'), r.buyer_id, '测评免单 · 退款已到账',
                `reach=${Math.round(reachScore)} 达阈 ${r.eval_threshold}，已退 ${amount} WAZ`,
                JSON.stringify([{ label: '查看', hash: '#trials' }])
              )
            db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, actions)
              VALUES (?, ?, 'trial_refunded', ?, ?, ?)`).run(
                generateId('ntf'), r.seller_id, '测评免单 · 已为买家退款',
                `claim 完成 reach=${Math.round(reachScore)}，退 ${amount} WAZ`,
                JSON.stringify([{ label: '查看活动', hash: '#seller-trials' }])
              )
          } catch { /* notifications 表可能用旧 schema, 忽略 */ }
        })
        try {
          tx()
          refunded++
        } catch (e) {
          const msg = (e as Error).message
          // 并发已结算 / 卖家余额已变 → 跳过(下次评估再处理),非异常,不计退款
          if (msg !== 'TRIAL_ALREADY_SETTLED' && msg !== 'TRIAL_SELLER_INSUFFICIENT') throw e
        }
      } else {
        db.prepare("UPDATE product_trial_claims SET reach_score=?, metrics_json=?, last_eval_at=datetime('now') WHERE id=? AND status='pending_threshold'").run(reachScore, metricsJson, r.id)
      }
    } catch (e) {
      console.error('[cron trial-eval]', r.id, e)
    }
  }
  return { evaluated, refunded, expired }
}

export function registerTrialRoutes(app: Application, deps: TrialDeps): void {
  const { db, generateId, auth, clientIpHash, clientUaHash, requireProtocolAdmin, logAdminAction } = deps

  // 卖家：开/更新活动
  app.post('/api/products/:product_id/trial-campaign', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<{ id: string; seller_id: string; status: string }>('SELECT id, seller_id, status FROM products WHERE id = ?', [req.params.product_id])
    if (!product) return void res.status(404).json({ error: '商品不存在' })
    if (product.seller_id !== user.id) return void res.status(403).json({ error: '仅商品卖家可开启测评' })
    const body = req.body || {}
    const quota = Math.floor(Number(body.quota_total) || 0)
    const threshold = Math.floor(Number(body.reach_threshold) || 50)
    const minChars = Math.floor(Number(body.min_chars) || 50)
    const minDays = Math.floor(Number(body.min_days_live) || 7)
    if (quota < 1 || quota > 200) return void res.status(400).json({ error: 'quota_total 需在 1-200 之间' })
    if (threshold < 10 || threshold > 10000) return void res.status(400).json({ error: 'reach_threshold 需在 10-10000 之间' })
    if (minChars < 20 || minChars > 5000) return void res.status(400).json({ error: 'min_chars 需在 20-5000 之间' })
    if (minDays < 1 || minDays > 90) return void res.status(400).json({ error: 'min_days_live 需在 1-90 之间' })

    // B3 修：1 product 1 row（UNIQUE）所以"关闭后再开"必须走 UPDATE 路径，不再 INSERT
    // 查任意 status 的现存行；存在即 UPDATE，不存在才 INSERT
    const existing = await dbOne<{ id: string; status: string; quota_claimed: number; reach_threshold: number; min_chars: number; min_days_live: number }>("SELECT id, status, quota_claimed, reach_threshold, min_chars, min_days_live FROM product_trial_campaigns WHERE product_id = ?", [product.id])
    if (existing) {
      if (quota < existing.quota_claimed) return void res.status(400).json({ error: `quota_total 不可低于已申请数 ${existing.quota_claimed}` })
      // 审计 P0-3：仅 active + 有 claim 时禁止上调阈值（关闭活动重开不限）
      if (existing.status === 'active' && existing.quota_claimed > 0) {
        if (threshold > existing.reach_threshold) return void res.status(400).json({ error: `已有 ${existing.quota_claimed} 个申请，reach_threshold 不可上调（当前 ${existing.reach_threshold}）` })
        if (minChars > existing.min_chars) return void res.status(400).json({ error: `已有申请，min_chars 不可上调（当前 ${existing.min_chars}）` })
        if (minDays > existing.min_days_live) return void res.status(400).json({ error: `已有申请，min_days_live 不可上调（当前 ${existing.min_days_live}）` })
      }
      // 重开：status='closed' → 重置为 active 且清 closed_at
      await dbRun(`UPDATE product_trial_campaigns
                  SET quota_total=?, reach_threshold=?, min_chars=?, min_days_live=?,
                      status='active', closed_at=NULL
                  WHERE id=?`, [quota, threshold, minChars, minDays, existing.id])
      return void res.json({ ok: true, campaign_id: existing.id, updated: true, reopened: existing.status !== 'active' })
    }
    const id = generateId('ptc')
    await dbRun(`INSERT INTO product_trial_campaigns (id, product_id, seller_id, quota_total, reach_threshold, min_chars, min_days_live)
                VALUES (?,?,?,?,?,?,?)`, [id, product.id, user.id, quota, threshold, minChars, minDays])
    res.json({ ok: true, campaign_id: id, created: true })
  })

  // 卖家关闭活动（仍允许 pending claims 完成评估）
  app.delete('/api/products/:product_id/trial-campaign', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const camp = await dbOne<{ id: string; seller_id: string }>("SELECT id, seller_id FROM product_trial_campaigns WHERE product_id = ? AND status = 'active'", [req.params.product_id])
    if (!camp) return void res.status(404).json({ error: '无活跃活动' })
    if (camp.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可关闭' })
    await dbRun("UPDATE product_trial_campaigns SET status='closed', closed_at=datetime('now') WHERE id=?", [camp.id])
    res.json({ ok: true, closed: true })
  })

  // 公开查询商品的活动状态（任何人）
  app.get('/api/products/:product_id/trial-campaign', async (req, res) => {
    const camp = await dbOne<Record<string, unknown>>(`SELECT id, quota_total, quota_claimed, reach_threshold, min_chars, min_days_live, status, created_at
      FROM product_trial_campaigns WHERE product_id = ? AND status = 'active'`, [req.params.product_id])
    if (!camp) return void res.json({ campaign: null })
    res.json({ campaign: { ...camp, quota_remaining: Number(camp.quota_total) - Number(camp.quota_claimed) } })
  })

  // 买家申请名额（必须已 confirmed/completed 该商品订单）
  // 审计防御：
  //   P0: 拒绝 buyer_id === seller_id（自买自评）
  //   P0: 快照 campaign 配置到 claim 行，cron 按快照评估（防卖家中途上调阈值）
  //   P1: 新账号 < 3 天禁申请；IP/UA 与卖家 session 重叠 → 标 account_link 审计 flag
  app.post('/api/products/:product_id/trial-claim', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const productId = req.params.product_id
    const camp = await dbOne<Record<string, unknown>>("SELECT * FROM product_trial_campaigns WHERE product_id = ? AND status = 'active'", [productId])
    if (!camp) return void res.status(404).json({ error: '该商品当前无测评活动' })
    if (Number(camp.quota_claimed) >= Number(camp.quota_total)) return void res.status(409).json({ error: '名额已满' })

    // 审计 P0-2：禁止卖家给自己商品申请测评（自买自评最直接的形式）
    if (user.id === camp.seller_id) return void res.status(403).json({ error: '卖家不能为自己的商品申请测评' })

    // 审计 P1-1：新账号冷启动锁（注册 < 3 天）
    const userCreatedAt = String(user.created_at || '')
    if (userCreatedAt) {
      const ageDays = (Date.now() - new Date(userCreatedAt).getTime()) / 86400_000
      if (ageDays < 3) return void res.status(403).json({ error: `新账号需注册满 3 天才能申请测评（你已注册 ${ageDays.toFixed(1)} 天）` })
    }

    // 买家必须有该商品的 confirmed/completed 订单
    const order = await dbOne<{ id: string; total_amount: number }>(`SELECT id, total_amount FROM orders WHERE product_id = ? AND buyer_id = ? AND status IN ('confirmed','completed') ORDER BY created_at DESC LIMIT 1`, [productId, user.id])
    if (!order) return void res.status(400).json({ error: '需先完成订单 (confirmed 或 completed) 才能申请测评' })
    const dup = await dbOne<{ id: string }>("SELECT id FROM product_trial_claims WHERE buyer_id = ? AND product_id = ?", [user.id, productId])
    if (dup) return void res.status(409).json({ error: '已申请过该商品测评', existing_id: dup.id })

    // 审计 P1-7（2026-05-25）：单 IP 1h 频次限制 — 防脚本批量小号撞名额
    // #1016 fix: 实际列名是 claimed_at（datetime('now') default），不是 created_at
    const buyerIp = clientIpHash(req)
    const buyerUa = clientUaHash(req)
    const recentIpClaims = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM product_trial_claims
      WHERE buyer_ip_hash = ? AND claimed_at > datetime('now', '-1 hour')`, [buyerIp]))!.n
    if (recentIpClaims >= 3) {
      return void res.status(429).json({ error: '当前网络申请过于频繁，请稍后再试', error_code: 'TRIAL_IP_RATE_LIMITED' })
    }

    // 审计 P1-2：IP/UA 重叠检测 — 标记 flag，不阻断（阻断会误伤共享网络的真买家）
    const linkRow = await dbOne<{ '1': number }>(`SELECT 1 FROM user_sessions
      WHERE user_id = ? AND (ip = ? OR fingerprint_hash = ?) LIMIT 1`, [camp.seller_id, buyerIp, buyerUa])
    const flags: string[] = []
    if (linkRow) flags.push('account_link_ip_or_ua')
    const auditFlags = flags.length ? JSON.stringify(flags) : null

    const id = generateId('pcl')
    // R1 修：quota 超卖竞态 — 用条件性 UPDATE 抢名额，原子化
    // 把 UPDATE 放在 tx 最前面，changes==0 即抛错让 tx 回滚（INSERT 也不会执行）
    try {
      const tx = db.transaction(() => {
        const upd = db.prepare(`UPDATE product_trial_campaigns
                                SET quota_claimed = quota_claimed + 1
                                WHERE id = ? AND quota_claimed < quota_total AND status = 'active'`).run(camp.id)
        if (upd.changes === 0) throw new Error('QUOTA_FULL')
        db.prepare(`INSERT INTO product_trial_claims (id, campaign_id, product_id, seller_id, buyer_id, order_id,
                    snap_reach_threshold, snap_min_chars, snap_min_days_live, buyer_ip_hash, buyer_ua_hash, audit_flags)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, camp.id, productId, camp.seller_id, user.id, order.id,
          Number(camp.reach_threshold), Number(camp.min_chars), Number(camp.min_days_live),
          buyerIp, buyerUa, auditFlags
        )
      })
      tx()
    } catch (e) {
      if ((e as Error).message === 'QUOTA_FULL') return void res.status(409).json({ error: '名额已满（并发申请抢占）' })
      throw e
    }
    res.json({ ok: true, claim_id: id, refund_eligible_amount: order.total_amount, audit_flags: flags })
  })

  // 买家关联笔记
  app.post('/api/trial-claims/:claim_id/link-note', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const claim = await dbOne<Record<string, unknown>>("SELECT * FROM product_trial_claims WHERE id = ?", [req.params.claim_id])
    if (!claim) return void res.status(404).json({ error: '申请不存在' })
    if (claim.buyer_id !== user.id) return void res.status(403).json({ error: '仅本人可关联' })
    if (claim.status !== 'pending_note') return void res.status(400).json({ error: `当前状态 ${claim.status} 不可关联笔记` })
    const { note_id } = req.body || {}
    if (!note_id) return void res.status(400).json({ error: '缺少 note_id' })
    // 笔记必须存在 + 是 type=note + owner=买家 + related_product_id=该商品
    const note = await dbOne<Record<string, unknown>>(`SELECT id, owner_id, type, related_product_id, native_text, photo_hashes, status, created_at
      FROM shareables WHERE id = ?`, [note_id])
    if (!note) return void res.status(404).json({ error: '笔记不存在' })
    if (note.owner_id !== user.id) return void res.status(403).json({ error: '仅本人笔记可关联' })
    if (note.type !== 'note') return void res.status(400).json({ error: '仅 type=note 可关联' })
    if (note.related_product_id !== claim.product_id) return void res.status(400).json({ error: '笔记需绑定该商品（含 anchor）' })
    if (note.status !== 'active') return void res.status(400).json({ error: '笔记需为 active' })
    const txtLen = String(note.native_text || '').length
    // 审计 P0-2：用 claim 的 snapshot（申请时锁定），非 campaign 当前值
    const minChars = Number(claim.snap_min_chars || 50)
    if (txtLen < minChars) {
      return void res.status(400).json({ error: `笔记字数不足 ${minChars}（当前 ${txtLen}）` })
    }
    const photoHashes = note.photo_hashes ? JSON.parse(String(note.photo_hashes)) : []
    if (!Array.isArray(photoHashes) || photoHashes.length === 0) return void res.status(400).json({ error: '笔记需至少 1 张图' })
    await dbRun(`UPDATE product_trial_claims SET note_id=?, note_linked_at=datetime('now'), status='pending_threshold' WHERE id=?`, [note_id, claim.id])
    res.json({ ok: true, status: 'pending_threshold' })
  })

  // 买家：我的测评列表
  app.get('/api/me/trial-claims', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(`SELECT c.*, p.title as product_title, p.price as product_price,
        camp.reach_threshold, camp.min_days_live
      FROM product_trial_claims c
      LEFT JOIN products p ON p.id = c.product_id
      LEFT JOIN product_trial_campaigns camp ON camp.id = c.campaign_id
      WHERE c.buyer_id = ?
      ORDER BY c.claimed_at DESC LIMIT 100`, [user.id])
    res.json({ items: rows })
  })

  // 卖家：我的测评活动列表（含每个的 claims 计数）
  app.get('/api/me/seller/trial-campaigns', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(`SELECT camp.*, p.title as product_title, p.price as product_price,
        (SELECT COUNT(*) FROM product_trial_claims WHERE campaign_id = camp.id AND status='refunded') as refunded_count,
        (SELECT COUNT(*) FROM product_trial_claims WHERE campaign_id = camp.id AND status='pending_threshold') as evaluating_count,
        (SELECT COUNT(*) FROM product_trial_claims WHERE campaign_id = camp.id AND status='expired') as expired_count
      FROM product_trial_campaigns camp
      LEFT JOIN products p ON p.id = camp.product_id
      WHERE camp.seller_id = ?
      ORDER BY camp.created_at DESC LIMIT 100`, [user.id])
    res.json({ items: rows })
  })

  // 卖家：查看某活动的 claims 详情
  app.get('/api/trial-campaigns/:campaign_id/claims', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const camp = await dbOne<{ id: string; seller_id: string }>("SELECT id, seller_id FROM product_trial_campaigns WHERE id = ?", [req.params.campaign_id])
    if (!camp) return void res.status(404).json({ error: '活动不存在' })
    if (camp.seller_id !== user.id) return void res.status(403).json({ error: '仅卖家可查看' })
    const rows = await dbAll<Record<string, unknown>>(`SELECT c.*, u.handle as buyer_handle, u.created_at as buyer_created_at FROM product_trial_claims c
      LEFT JOIN users u ON u.id = c.buyer_id
      WHERE c.campaign_id = ? ORDER BY c.claimed_at DESC`, [camp.id])
    res.json({ items: rows })
  })

  // Admin 手动触发测评评估（测试 + 紧急 + 立即生效）
  app.post('/api/admin/trial/run-eval', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const result = await evaluateTrialClaims(db, generateId)
    logAdminAction(admin.id as string, 'trial_run_eval', 'protocol', null, { result })
    res.json(result)
  })
}
