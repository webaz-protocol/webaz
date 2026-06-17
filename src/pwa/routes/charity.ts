/**
 * 慈善许愿池 (charity) 域 — 双匿名 + 双签锚定 + 隔离 prestige
 *
 * 由 #1013 Phase 6 从 src/pwa/server.ts 抽出。最大单 phase（~870 行）。
 *
 * 17 endpoints + 2 cron 函数:
 *   POST /api/wishes                              — 发布愿望
 *   GET  /api/wishes                              — 浏览（匿名可）
 *   GET  /api/wishes/:id                          — 详情
 *   POST /api/wishes/:id/fulfill                  — 圆梦人认领（#1018 改名：原 /claim 被 wish_claim_task 路由 shadow）
 *   POST /api/wishes/:id/proof                    — 提交证据
 *   POST /api/wishes/:id/confirm                  — 许愿人确认 → fireWebhooks('wish.confirmed')
 *   POST /api/wishes/:id/disclose                 — 申请公开（双方同意才公开）
 *   POST /api/wishes/:id/cancel                   — 许愿人取消
 *   GET  /api/charity/me                          — 我的慈善档案
 *   GET  /api/charity/stories                     — 公开故事板
 *   POST /api/wishes/:id/repay                    — 还愿
 *   POST /api/wishes/:id/repay/:rid/respond       — 施善人响应
 *   POST /api/charity/fund/donate                 — 捐款 → fireWebhooks('charity.donation')
 *   GET  /api/charity/fund                        — 基金概况
 *   POST /api/wishes/:id/report                   — 举报愿望
 *   GET  /api/charity/leaderboard                 — 慈善榜
 *   POST/GET /api/admin/wish-reports*             — admin 举报处理（content perm）
 *   POST /api/admin/wishes/:id/takedown           — admin 强制下架（content perm）
 *   POST /api/admin/charity/fund/disburse         — admin 拨款（protocol perm）
 *   GET  /api/admin/charity/fund                  — admin 基金概况
 *
 * + expireCharityWishes() — 每 5min enforcement cron 调用
 * + autoAcceptExpiredRepayments() — 每 5min enforcement cron 调用
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

// RFC-016 Phase 1 — 仅端点纯校验读/公开列表/读回 + 单语句标记/CAS/通知写 → async seam。
// 保持同步(Phase 3 再用 pg tx/行锁):
//   - 模块级 helper ensureCharityRep(被多个 tx 内部调用)/ isCharityBlocked(为一致性);
//   - 两个 cron 函数 expireCharityWishes / autoAcceptExpiredRepayments 整体(逐项 db.transaction 写,
//     由 server.ts 同步 runEnforcement 调用,不动该扫描循环);
//   - 所有端点 db.transaction 钱块(发布/确认/取消/还愿/响应/捐款/下架/拨款)。

// ─── 域常量 ───────────────────────────────────────────────
const CHARITY_CATEGORIES = ['medical','education','daily','elderly','disaster','tech','other'] as const
const CHARITY_CATEGORY_LABEL: Record<string, string> = {
  medical: '医疗救助', education: '教育求学', daily: '生活物资',
  elderly: '助老', disaster: '灾害互助', tech: '科技/设备', other: '其它',
}
const CHARITY_MAX_CASH_WAZ = 500
const CHARITY_MONTHLY_WISH_CAP = 5
const CHARITY_MONTHLY_FULFILL_CAP = 10
const CHARITY_WINDOW_MIN_HOURS = 24
const CHARITY_WINDOW_MAX_HOURS = 30 * 24
const CHARITY_CLAIM_TIMEOUT_HOURS = 48
const CHARITY_AUTO_CONFIRM_DAYS = 14   // P1.4: cash wish 兜底自动确认
const CHARITY_REPAY_MIN = 0.1
const CHARITY_REPAY_AUTO_ACCEPT_DAYS = 7
const CHARITY_DONATION_MIN = 0.1
const CHARITY_DONATION_DAILY_HONOR_CAP = 50

function isCharityCategory(s: string): s is typeof CHARITY_CATEGORIES[number] {
  return (CHARITY_CATEGORIES as readonly string[]).includes(s)
}

function charityBadgeTier(prestige: number): string {
  if (prestige >= 1000) return 'diamond'
  if (prestige >= 200)  return 'gold'
  if (prestige >= 50)   return 'silver'
  if (prestige >= 10)   return 'bronze'
  return 'none'
}

// P2.6 修复：独立 ANON_SEED；MASTER_SEED 单独泄露 ≠ 全员去匿名化
// 模块加载时读 env（与 server.ts MASTER_SEED 用同源 env 变量）
const CHARITY_ANON_SEED = process.env.CHARITY_ANON_SEED
  || ((process.env.WALLET_MASTER_SEED ?? 'webaz-dev-seed-changeme') + ':charity:anon:v1')
function charityAnonHandle(userId: string, wishId: string, role: 'wisher' | 'fulfiller'): string {
  return createHmac('sha256', CHARITY_ANON_SEED).update(`charity:${role}:${userId}:${wishId}`).digest('hex').slice(0, 12)
}

// ─── 模块级 db-taking helpers（供 cron + 路由共用）──────────
// exported because server.ts order-creation path (B5 下单捐赠) 仍引用
export function ensureCharityRep(db: Database.Database, userId: string): void {
  db.prepare(`INSERT OR IGNORE INTO charity_reputation (user_id) VALUES (?)`).run(userId)
}

function isCharityBlocked(db: Database.Database, userId: string): { blocked: boolean; reason?: string; until?: string } {
  const row = db.prepare("SELECT reason, until FROM charity_blocklist WHERE user_id = ? AND until > datetime('now')").get(userId) as { reason: string; until: string } | undefined
  if (row) return { blocked: true, reason: row.reason, until: row.until }
  return { blocked: false }
}

// 自动过期清理（仅 runEnforcement 调用；GET 端点不再触发写）
export function expireCharityWishes(db: Database.Database): void {
  // 超时未认领 → expired，释放托管
  const expired = db.prepare(`
    SELECT id, user_id, escrow_locked FROM wishes
    WHERE status = 'open' AND expires_at <= datetime('now')
  `).all() as { id: string; user_id: string; escrow_locked: number }[]
  for (const w of expired) {
    db.transaction(() => {
      db.prepare("UPDATE wishes SET status = 'expired' WHERE id = ?").run(w.id)
      if (w.escrow_locked > 0) {
        db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(w.escrow_locked, w.escrow_locked, w.user_id)
      }
    })()
  }
  // P1.3 修复：48h 仅指 claim 后 *零证据* 的情况；如果已提交 proof_pending wf 则不强 reset
  // 改判定：NOT EXISTS ANY wf at all（含 proof_pending）。已交证据的 fulfiller 不被回收
  const stale = db.prepare(`
    SELECT w.id, w.fulfiller_user_id FROM wishes w
    WHERE w.status = 'claimed' AND w.claimed_at <= datetime('now', '-${CHARITY_CLAIM_TIMEOUT_HOURS} hours')
      AND NOT EXISTS (SELECT 1 FROM wish_fulfillments wf WHERE wf.wish_id = w.id)
  `).all() as { id: string; fulfiller_user_id: string }[]
  for (const w of stale) {
    db.transaction(() => {
      db.prepare("UPDATE wishes SET status = 'open', fulfiller_user_id = NULL, claimed_at = NULL WHERE id = ?").run(w.id)
      if (w.fulfiller_user_id) {
        ensureCharityRep(db, w.fulfiller_user_id)
        db.prepare("UPDATE charity_reputation SET prestige_score = MAX(0, prestige_score - 1) WHERE user_id = ?").run(w.fulfiller_user_id)
      }
    })()
  }

  // P1.4 修复：fulfiller 兜底 — wisher 14 天不 confirm → 自动确认（防止 cash wish escrow 永久锁）
  // 仅 proof_pending 的 wf 才参与
  const orphans = db.prepare(`
    SELECT w.id as wid, w.user_id as wuid, w.fulfiller_user_id as fuid,
           w.target_kind, w.escrow_locked, wf.id as wfid, wf.proof_hash
    FROM wishes w JOIN wish_fulfillments wf ON wf.wish_id = w.id
    WHERE w.status = 'claimed' AND wf.status = 'proof_pending'
      AND wf.created_at <= datetime('now', '-${CHARITY_AUTO_CONFIRM_DAYS} days')
  `).all() as { wid: string; wuid: string; fuid: string; target_kind: string; escrow_locked: number; wfid: string; proof_hash: string }[]
  for (const o of orphans) {
    db.transaction(() => {
      // 不签名（许愿人未参与），仅记录 auto_confirmed
      const upd = db.prepare(`UPDATE wish_fulfillments SET status='confirmed', wisher_sig='AUTO_CONFIRM', confirmed_at=datetime('now')
                              WHERE id = ? AND status='proof_pending'`).run(o.wfid)
      if (upd.changes === 0) return
      db.prepare(`UPDATE wishes SET status='completed', completed_at=datetime('now') WHERE id = ? AND status='claimed'`).run(o.wid)
      if (o.target_kind === 'cash' && Number(o.escrow_locked) > 0) {
        db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(o.escrow_locked, o.wuid)
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(o.escrow_locked, o.fuid)
      }
      ensureCharityRep(db, o.fuid)
      db.prepare(`UPDATE charity_reputation SET wishes_fulfilled = wishes_fulfilled + 1,
                  prestige_score = prestige_score + 10, last_active = datetime('now') WHERE user_id = ?`).run(o.fuid)
      const s = (db.prepare('SELECT prestige_score FROM charity_reputation WHERE user_id = ?').get(o.fuid) as { prestige_score: number }).prestige_score
      db.prepare(`UPDATE charity_reputation SET badge_tier = ? WHERE user_id = ?`).run(charityBadgeTier(s), o.fuid)
    })()
  }
}

// 自动接受过期还愿（每 5 分钟 enforcement 调用）
export function autoAcceptExpiredRepayments(db: Database.Database): void {
  const rows = db.prepare(`SELECT * FROM wish_repayments WHERE status = 'offered' AND auto_expire_at <= datetime('now')`).all() as Record<string, unknown>[]
  for (const r of rows) {
    const amount = Number(r.amount)
    db.transaction(() => {
      // P0.3 修复：UPDATE 带 status 守门；与手动 respond 撞车时 changes=0 直接跳过
      const upd = db.prepare(`UPDATE wish_repayments SET status='expired_auto_accept', responded_at=datetime('now'), locked=0
                              WHERE id = ? AND status='offered'`).run(r.id)
      if (upd.changes === 0) return
      db.prepare(`UPDATE wallets SET staked = staked - ? WHERE user_id = ?`).run(amount, r.wisher_user_id)
      db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(amount, r.fulfiller_user_id)
      ensureCharityRep(db, r.fulfiller_user_id as string)
      db.prepare(`UPDATE charity_reputation SET repay_honor = repay_honor + 5, prestige_score = prestige_score + 5 WHERE user_id = ?`).run(r.fulfiller_user_id)
    })()
  }
}

export interface CharityDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
  getUser: (req: Request) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown> | undefined | null) => boolean
  // pre-bound admin gates（同 Phase 2-5 模式）
  requireContentAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  // webhook fire — 由 server.ts 的 webhooks 域注入（webhooks 还未拆出）
  fireWebhooks: (eventType: string, payload: Record<string, unknown>, userIds?: string[]) => Promise<void>
}

export function registerCharityRoutes(app: Application, deps: CharityDeps): void {
  const { db, auth, generateId, rateLimitOk, getUser, isTrustedRole, requireContentAdmin, requireProtocolAdmin, fireWebhooks } = deps

  // POST /api/wishes — 发布愿望
  app.post('/api/wishes', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 10, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })

    const blocked = isCharityBlocked(db, user.id as string)
    if (blocked.blocked) return void res.json({ error: `已被暂时禁言：${blocked.reason}（${blocked.until} 解除）`, blocklist_reason: blocked.reason, blocklist_until: blocked.until })

    const body = req.body as Record<string, unknown>
    const title = String(body.title || '').trim()
    if (title.length < 4 || title.length > 100) return void res.json({ error: '标题 4-100 字' })
    const content = String(body.content || '').trim()
    if (content.length < 10 || content.length > 1000) return void res.json({ error: '描述 10-1000 字' })
    const cat = String(body.category || 'other')
    if (!isCharityCategory(cat)) return void res.json({ error: '类目无效' })
    const targetKind = String(body.target_kind || 'item')
    if (!['item','service','cash'].includes(targetKind)) return void res.json({ error: 'target_kind 无效' })
    const windowHours = Math.max(CHARITY_WINDOW_MIN_HOURS, Math.min(CHARITY_WINDOW_MAX_HOURS, Math.floor(Number(body.window_hours || 168))))
    const allowPublic = body.allow_public ? 1 : 0

    // 月度上限
    const monthly = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM wishes WHERE user_id = ? AND created_at > datetime('now','-30 days')", [user.id]))!.n
    if (monthly >= CHARITY_MONTHLY_WISH_CAP) return void res.json({ error: `月度许愿上限 ${CHARITY_MONTHLY_WISH_CAP} 个，请下月再来` })

    // 现金类需托管
    let targetWaz: number | null = null
    let escrow = 0
    if (targetKind === 'cash') {
      targetWaz = Number(body.target_waz)
      if (!Number.isFinite(targetWaz) || targetWaz <= 0) return void res.json({ error: 'cash 类型需 target_waz > 0' })
      if (targetWaz > CHARITY_MAX_CASH_WAZ) return void res.json({ error: `单愿金额上限 ${CHARITY_MAX_CASH_WAZ} WAZ` })
      // 卖家承诺托管：可选 — 锁仓 0 表示纯协调（不推荐），>0 表示真托管
      const lockSelf = body.escrow_self ? Number(body.target_waz) : 0
      if (lockSelf > 0) {
        const w = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
        if (!w || w.balance < lockSelf) return void res.json({ error: '余额不足以自托管' })
        escrow = lockSelf
      }
    }

    const id = generateId('wish')
    // P2.1 修复：去掉 secret_keep_safe（无 reveal 端点用不上，节省一次握手）
    const commitHash = createHash('sha256').update(`${user.id}|${randomBytes(16).toString('hex')}|${id}|${Date.now()}`).digest('hex')
    const wisherHandle = charityAnonHandle(user.id as string, id, 'wisher')

    // Codex #238 P1:await 余额预检与同步 tx 间有 yield;escrow 扣款带 balance>=escrow 守卫,
    // changes!==1 即并发已花掉余额 → 抛回滚(连带回滚已插 wish),杜绝超额自助托管。
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO wishes (id, user_id, wisher_handle, category, title, content, target_kind, target_waz, escrow_locked, commit_hash, allow_public, expires_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now', '+' || ? || ' hours'))`).run(
          id, user.id, wisherHandle, cat, title, content, targetKind, targetWaz, escrow, commitHash, allowPublic, windowHours
        )
        if (escrow > 0) {
          const d = db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?').run(escrow, escrow, user.id, escrow)
          if (d.changes !== 1) throw new Error('CHARITY_INSUFFICIENT_BALANCE')
        }
        ensureCharityRep(db, user.id as string)
        db.prepare("UPDATE charity_reputation SET wishes_made = wishes_made + 1, last_active = datetime('now') WHERE user_id = ?").run(user.id)
      })()
    } catch (e) {
      if ((e as Error).message === 'CHARITY_INSUFFICIENT_BALANCE') return void res.json({ error: '余额不足，无法锁定自助托管金' })
      throw e
    }

    res.json({ id, wisher_handle: wisherHandle, escrow_locked: escrow })
  })

  // GET /api/wishes — 浏览（匿名可访问）
  app.get('/api/wishes', async (req, res) => {
    const where: string[] = ["status IN ('open','claimed')"]
    const args: unknown[] = []
    if (req.query.category && isCharityCategory(String(req.query.category))) {
      where.push('category = ?'); args.push(String(req.query.category))
    }
    if (req.query.target_kind) {
      const k = String(req.query.target_kind)
      if (['item','service','cash'].includes(k)) { where.push('target_kind = ?'); args.push(k) }
    }
    if (req.query.status) {
      where[0] = 'status = ?'
      args.unshift(String(req.query.status))
    }
    if (req.query.q && typeof req.query.q === 'string' && req.query.q.trim()) {
      const qE = req.query.q.trim().replace(/[\\%_]/g, '\\$&')
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
      args.push('%' + qE + '%', '%' + qE + '%')
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30))
    const rows = await dbAll(`
      SELECT id, wisher_handle, category, title,
             substr(content, 1, 120) as content_preview,
             target_kind, target_waz, escrow_locked, status, allow_public,
             expires_at, created_at, claimed_at
      FROM wishes
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `, [...args, limit])
    res.json({ items: rows, categories: CHARITY_CATEGORIES, category_labels: CHARITY_CATEGORY_LABEL })
  })

  // GET /api/wishes/:id — 详情
  app.get('/api/wishes/:id', async (req, res) => {
    const id = req.params.id
    const w = await dbOne<Record<string, unknown>>(`SELECT * FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    const me = getUser(req)
    const isWisher = !!me && me.id === w.user_id
    const isFulfiller = !!me && me.id === w.fulfiller_user_id

    const fulfillments = await dbAll(`
      SELECT id, fulfiller_handle, proof_hash, proof_note, status,
             confirmed_at, disclose_wisher, disclose_fulfiller, disclosed_at, created_at
      FROM wish_fulfillments WHERE wish_id = ?
      ORDER BY created_at DESC
    `, [id])
    const repayments = await dbAll(`
      SELECT id, fulfillment_id, amount, note, status, responded_at, auto_expire_at, created_at
      FROM wish_repayments WHERE wish_id = ?
      ORDER BY created_at DESC
    `, [id])

    res.json({
      id: w.id, wisher_handle: w.wisher_handle, category: w.category, title: w.title,
      content: w.content, target_kind: w.target_kind, target_waz: w.target_waz,
      escrow_locked: w.escrow_locked, commit_hash: w.commit_hash, allow_public: w.allow_public,
      status: w.status, claimed_at: w.claimed_at, completed_at: w.completed_at,
      expires_at: w.expires_at, created_at: w.created_at,
      fulfillments, repayments,
      is_wisher: isWisher, is_fulfiller: isFulfiller,
    })
  })

  // POST /api/wishes/:id/fulfill — 圆梦人认领
  // #1018 改名：原 /claim path 与 claim-initiators 的 wish_claim_task (fraud claim) 冲突
  // /claim 让 fraud-claim 独占（与 secondhand/auctions 三垂类对称）
  app.post('/api/wishes/:id/fulfill', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 30, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const id = req.params.id
    const blocked = isCharityBlocked(db, user.id as string)
    if (blocked.blocked) return void res.json({ error: `已被暂时禁言：${blocked.reason}`, blocklist_reason: blocked.reason, blocklist_until: blocked.until })

    const w = await dbOne<{ user_id: string; status: string }>(`SELECT user_id, status FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    if (w.status !== 'open') return void res.json({ error: '该愿望已被认领或已结束' })
    if (w.user_id === user.id) {
      // 反自施善（防自己给自己许愿圆满，套取威望）：直接封锁 30 天
      await dbRun("INSERT OR REPLACE INTO charity_blocklist (user_id, reason, until) VALUES (?, 'self_fulfill_fraud', datetime('now','+30 days'))", [user.id])
      return void res.json({ error: '禁止圆自己的愿。已封锁 30 天。' })
    }
    const monthly = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM wishes WHERE fulfiller_user_id = ? AND claimed_at > datetime('now','-30 days')", [user.id]))!.n
    if (monthly >= CHARITY_MONTHLY_FULFILL_CAP) return void res.json({ error: `月度施善上限 ${CHARITY_MONTHLY_FULFILL_CAP} 次` })

    const claimRes = await dbRun(`UPDATE wishes SET status='claimed', fulfiller_user_id=?, claimed_at=datetime('now')
                WHERE id = ? AND status='open'`, [user.id, id])
    if (claimRes.changes === 0) return void res.json({ error: '该愿望已被他人认领，请刷新' })
    // P2.4 通知：许愿人收到"你的愿望被认领"
    try {
      const t = (await dbOne<{ title: string }>('SELECT title FROM wishes WHERE id = ?', [id]))!.title
      await dbRun(`INSERT INTO notifications (id, user_id, wish_id, type, title, body, created_at)
                  VALUES (?,?,?,'wish_claimed',?,?,datetime('now'))`,
        [generateId('ntf'), w.user_id, id, '🤝 你的愿望被认领', `「${t}」 施善人已开始行动，请等待证据`])
    } catch (e) { console.error('[charity notify claim]', e) }
    res.json({ ok: true, claim_timeout_hours: CHARITY_CLAIM_TIMEOUT_HOURS })
  })

  // POST /api/wishes/:id/proof — 提交证据
  app.post('/api/wishes/:id/proof', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 30, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const id = req.params.id
    const w = await dbOne<{ user_id: string; fulfiller_user_id: string; status: string }>(`SELECT user_id, fulfiller_user_id, status FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    if (w.fulfiller_user_id !== user.id) return void res.json({ error: '仅施善人可提交证据' })
    if (w.status !== 'claimed') return void res.json({ error: '当前状态不可提交证据' })

    const body = req.body as Record<string, unknown>
    const proofHash = String(body.proof_hash || '').trim()
    if (proofHash.length < 16 || proofHash.length > 128) return void res.json({ error: 'proof_hash 长度无效（16-128 hex）' })
    const proofNote = body.proof_note ? String(body.proof_note).slice(0, 500) : null

    // 施善人签名 = HMAC(api_key, wish_id||proof_hash)
    const sig = createHmac('sha256', user.api_key as string).update(`${id}|${proofHash}`).digest('hex')

    const fid = generateId('wf')
    const handle = charityAnonHandle(user.id as string, id, 'fulfiller')
    await dbRun(`INSERT INTO wish_fulfillments (id, wish_id, fulfiller_user_id, fulfiller_handle, proof_hash, proof_note, fulfiller_sig)
                VALUES (?,?,?,?,?,?,?)`, [fid, id, user.id, handle, proofHash, proofNote, sig])
    // P2.4 通知：许愿人收到"施善证据已提交，请确认"
    try {
      const t = (await dbOne<{ title: string }>('SELECT title FROM wishes WHERE id = ?', [id]))!.title
      await dbRun(`INSERT INTO notifications (id, user_id, wish_id, type, title, body, created_at)
                  VALUES (?,?,?,'wish_proof',?,?,datetime('now'))`,
        [generateId('ntf'), w.user_id, id, '📤 施善证据已提交', `「${t}」 请尽快确认（14 天不响应会自动确认）`])
    } catch (e) { console.error('[charity notify proof]', e) }
    res.json({ id: fid, fulfiller_handle: handle, signature: sig })
  })

  // POST /api/wishes/:id/confirm — 许愿人确认
  app.post('/api/wishes/:id/confirm', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 30, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const id = req.params.id
    const w = await dbOne<Record<string, unknown>>(`SELECT * FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    if (w.user_id !== user.id) return void res.json({ error: '仅许愿人可确认' })
    if (w.status !== 'claimed') return void res.json({ error: '当前状态不可确认' })

    const fid = String((req.body as Record<string, unknown>).fulfillment_id || '')
    const wf = await dbOne<Record<string, unknown>>(`SELECT * FROM wish_fulfillments WHERE id = ? AND wish_id = ?`, [fid, id])
    if (!wf) return void res.json({ error: '证据不存在' })
    if (wf.status !== 'proof_pending') return void res.json({ error: '该证据已处理' })

    const wisherSig = createHmac('sha256', user.api_key as string).update(`${id}|${wf.proof_hash}|confirm`).digest('hex')

    let raceLost = false
    db.transaction(() => {
      // P0.1 修复：原子状态推进 — 仅 status='proof_pending' 时 update；双击/重放只有一次生效
      const upd = db.prepare(`UPDATE wish_fulfillments SET status='confirmed', wisher_sig=?, confirmed_at=datetime('now')
                              WHERE id = ? AND status='proof_pending'`).run(wisherSig, fid)
      if (upd.changes === 0) { raceLost = true; return }
      db.prepare(`UPDATE wishes SET status='completed', completed_at=datetime('now') WHERE id = ? AND status='claimed'`).run(id)

      // cash 模式释放托管给施善人
      if (w.target_kind === 'cash' && Number(w.escrow_locked) > 0) {
        const amt = Number(w.escrow_locked)
        db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(amt, w.user_id)
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amt, w.fulfiller_user_id)
      }

      // prestige：施善人 +10，许愿人 +1（鼓励确认）
      ensureCharityRep(db, w.fulfiller_user_id as string)
      db.prepare(`UPDATE charity_reputation SET wishes_fulfilled = wishes_fulfilled + 1,
                  prestige_score = prestige_score + 10, last_active = datetime('now') WHERE user_id = ?`).run(w.fulfiller_user_id)
      const newScore = (db.prepare('SELECT prestige_score FROM charity_reputation WHERE user_id = ?').get(w.fulfiller_user_id) as { prestige_score: number }).prestige_score
      db.prepare(`UPDATE charity_reputation SET badge_tier = ? WHERE user_id = ?`).run(charityBadgeTier(newScore), w.fulfiller_user_id)

      ensureCharityRep(db, user.id as string)
      db.prepare(`UPDATE charity_reputation SET prestige_score = prestige_score + 1, last_active = datetime('now') WHERE user_id = ?`).run(user.id)
    })()
    if (raceLost) return void res.json({ error: '该证据已被处理，请刷新' })
    // P2.4 通知：施善人收到"许愿人已确认"
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, wish_id, type, title, body, created_at)
                  VALUES (?,?,?,'wish_confirmed',?,?,datetime('now'))`,
        [generateId('ntf'), w.fulfiller_user_id as string, id, '✓ 许愿人已确认圆梦', `「${w.title}」 +10 威望已入账`])
    } catch (e) { console.error('[charity notify confirm]', e) }
    // 📡 Webhook fire — 通知双方 (异步不 await)
    fireWebhooks('wish.confirmed', { wish_id: id, wisher_handle: w.wisher_handle, title: w.title }, [w.user_id as string, w.fulfiller_user_id as string]).catch(e => console.error('[webhook]', e))

    res.json({ ok: true, wisher_sig: wisherSig })
  })

  // POST /api/wishes/:id/disclose — 申请公开（双方同意才公开）
  app.post('/api/wishes/:id/disclose', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const id = req.params.id
    const w = await dbOne<{ user_id: string; fulfiller_user_id: string; status: string; allow_public: number }>(`SELECT user_id, fulfiller_user_id, status, allow_public FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    if (w.status !== 'completed') return void res.json({ error: '仅完成后可申请公开' })
    if (!w.allow_public) return void res.json({ error: '该愿望已声明保持匿名，不可公开' })

    const wf = await dbOne<{ id: string; disclose_wisher: number; disclose_fulfiller: number }>(`SELECT id, disclose_wisher, disclose_fulfiller FROM wish_fulfillments WHERE wish_id = ? AND status='confirmed' ORDER BY created_at DESC LIMIT 1`, [id])
    if (!wf) return void res.json({ error: '未找到对应证据' })

    let update: string | null = null
    if (user.id === w.user_id) update = 'disclose_wisher = 1'
    else if (user.id === w.fulfiller_user_id) update = 'disclose_fulfiller = 1'
    else return void res.json({ error: '非当事人不可申请公开' })

    await dbRun(`UPDATE wish_fulfillments SET ${update} WHERE id = ?`, [wf.id])

    // 双方都同意 → 标记 disclosed_at
    const both = (await dbOne<{ disclose_wisher: number; disclose_fulfiller: number }>(`SELECT disclose_wisher, disclose_fulfiller FROM wish_fulfillments WHERE id = ?`, [wf.id]))!
    let disclosed = false
    if (both.disclose_wisher && both.disclose_fulfiller) {
      await dbRun(`UPDATE wish_fulfillments SET disclosed_at = datetime('now') WHERE id = ?`, [wf.id])
      disclosed = true
    }
    res.json({ ok: true, disclosed, wisher_agreed: !!both.disclose_wisher, fulfiller_agreed: !!both.disclose_fulfiller })
  })

  // POST /api/wishes/:id/cancel — 许愿人取消（仅 open 状态）
  app.post('/api/wishes/:id/cancel', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const id = req.params.id
    const w = await dbOne<{ user_id: string; status: string; escrow_locked: number }>(`SELECT user_id, status, escrow_locked FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    if (w.user_id !== user.id) return void res.json({ error: '仅许愿人可取消' })
    if (w.status !== 'open') return void res.json({ error: '已认领或已完成的愿望不可取消' })

    // Codex #238 P1:tx 内先 CAS open→cancelled,changes!==1 即并发已认领/取消 → 抛回滚,先于释放 escrow,杜绝双退。
    try {
      db.transaction(() => {
        const c = db.prepare("UPDATE wishes SET status='cancelled' WHERE id = ? AND status = 'open'").run(id)
        if (c.changes !== 1) throw new Error('WISH_NOT_OPEN')
        if (w.escrow_locked > 0) {
          db.prepare('UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?').run(w.escrow_locked, w.escrow_locked, user.id)
        }
      })()
    } catch (e) {
      if ((e as Error).message === 'WISH_NOT_OPEN') return void res.json({ error: '已认领或已完成的愿望不可取消' })
      throw e
    }
    res.json({ ok: true })
  })

  // GET /api/charity/me — 我的慈善档案
  app.get('/api/charity/me', async (req, res) => {
    const user = auth(req, res); if (!user) return
    ensureCharityRep(db, user.id as string)
    const rep = await dbOne(`SELECT * FROM charity_reputation WHERE user_id = ?`, [user.id])
    const myWishes = await dbAll(`SELECT id, wisher_handle, category, title, status, target_kind, target_waz, expires_at, created_at, completed_at
                                 FROM wishes WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [user.id])
    const myFulfilled = await dbAll(`
      SELECT w.id, w.title, w.category, w.target_kind, w.target_waz, w.status, w.completed_at, wf.fulfiller_handle, wf.status as wf_status
      FROM wish_fulfillments wf JOIN wishes w ON w.id = wf.wish_id
      WHERE wf.fulfiller_user_id = ? ORDER BY wf.created_at DESC LIMIT 50
    `, [user.id])
    // 待我响应的还愿
    const pendingRepays = await dbAll(`
      SELECT r.id, r.wish_id, r.amount, r.note, r.auto_expire_at, w.title
      FROM wish_repayments r JOIN wishes w ON w.id = r.wish_id
      WHERE r.fulfiller_user_id = ? AND r.status = 'offered'
      ORDER BY r.created_at DESC
    `, [user.id])
    res.json({ reputation: rep, my_wishes: myWishes, my_fulfillments: myFulfilled, pending_repayments: pendingRepays })
  })

  // GET /api/charity/stories — 公开披露的故事板
  app.get('/api/charity/stories', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30))
    const rows = await dbAll(`
      SELECT w.id, w.category, w.title, w.content, w.target_kind, w.target_waz, w.completed_at,
             wf.disclosed_at, wf.proof_note,
             uw.handle as wisher_name, uw.region as wisher_region,
             uf.handle as fulfiller_name, uf.region as fulfiller_region
      FROM wish_fulfillments wf
      JOIN wishes w  ON w.id = wf.wish_id
      JOIN users uw  ON uw.id = w.user_id
      JOIN users uf  ON uf.id = wf.fulfiller_user_id
      WHERE wf.disclosed_at IS NOT NULL
      ORDER BY wf.disclosed_at DESC
      LIMIT ?
    `, [limit])
    res.json({ items: rows })
  })

  // 还愿：许愿人发起
  app.post('/api/wishes/:id/repay', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 20, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const id = req.params.id
    const body = req.body as Record<string, unknown>
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount < CHARITY_REPAY_MIN) return void res.json({ error: `金额需 ≥ ${CHARITY_REPAY_MIN} WAZ` })

    const w = await dbOne<{ user_id: string; fulfiller_user_id: string; status: string }>(`SELECT user_id, fulfiller_user_id, status FROM wishes WHERE id = ?`, [id])
    if (!w) return void res.json({ error: '愿望不存在' })
    if (w.user_id !== user.id) return void res.json({ error: '仅许愿人可发起还愿' })
    if (w.status !== 'completed') return void res.json({ error: '仅已施善完成的愿望可还愿' })

    const fid = String(body.fulfillment_id || '')
    const wf = await dbOne<{ id: string; status: string }>(`SELECT id, status FROM wish_fulfillments WHERE id = ? AND wish_id = ?`, [fid, id])
    if (!wf || wf.status !== 'confirmed') return void res.json({ error: '证据不存在或未确认' })

    // 已发起的等待中还愿不可重复
    const existing = await dbOne<{ id: string }>(`SELECT id FROM wish_repayments WHERE wish_id = ? AND status = 'offered'`, [id])
    if (existing) return void res.json({ error: '已有进行中的还愿，请等待对方响应' })

    // 余额检查 + 锁仓
    const wallet = await dbOne<{ balance: number }>(`SELECT balance FROM wallets WHERE user_id = ?`, [user.id])
    if (!wallet || wallet.balance < amount) return void res.json({ error: '余额不足' })

    const rid = generateId('repay')
    // Codex #238 P1:tx 内重检无并发 offered 还愿 + 余额守卫锁仓,任一失败回滚已插 repayment。
    try {
      db.transaction(() => {
        const dup = db.prepare(`SELECT id FROM wish_repayments WHERE wish_id = ? AND status = 'offered'`).get(id) as { id: string } | undefined
        if (dup) throw new Error('REPAY_EXISTS')
        db.prepare(`INSERT INTO wish_repayments (id, wish_id, fulfillment_id, wisher_user_id, fulfiller_user_id, amount, note, locked, auto_expire_at)
                    VALUES (?,?,?,?,?,?,?,?, datetime('now', '+${CHARITY_REPAY_AUTO_ACCEPT_DAYS} days'))`).run(
          rid, id, fid, user.id, w.fulfiller_user_id, amount, body.note ? String(body.note).slice(0, 300) : null, amount
        )
        const d = db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?`).run(amount, amount, user.id, amount)
        if (d.changes !== 1) throw new Error('REPAY_INSUFFICIENT_BALANCE')
      })()
    } catch (e) {
      const m = (e as Error).message
      if (m === 'REPAY_EXISTS') return void res.json({ error: '已有进行中的还愿，请等待对方响应' })
      if (m === 'REPAY_INSUFFICIENT_BALANCE') return void res.json({ error: '余额不足' })
      throw e
    }
    // P2.4 通知：施善人收到"有人向你还愿"
    try {
      const t = (await dbOne<{ title: string }>('SELECT title FROM wishes WHERE id = ?', [id]))!.title
      await dbRun(`INSERT INTO notifications (id, user_id, wish_id, type, title, body, created_at)
                  VALUES (?,?,?,'wish_repay',?,?,datetime('now'))`,
        [generateId('ntf'), w.fulfiller_user_id, id, `🙏 有人向你还愿 ${amount} WAZ`, `「${t}」 可接受或谢绝转入慈善基金（7 天不响应自动接受）`])
    } catch (e) { console.error('[charity notify repay]', e) }
    res.json({ id: rid, auto_accept_in_days: CHARITY_REPAY_AUTO_ACCEPT_DAYS })
  })

  // 施善人响应还愿（accept / decline_to_fund）
  app.post('/api/wishes/:id/repay/:rid/respond', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 20, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const id = req.params.id
    const rid = req.params.rid
    const choice = String((req.body as Record<string, unknown>).choice || '')
    if (!['accept','decline_to_fund'].includes(choice)) return void res.json({ error: 'choice 必须是 accept 或 decline_to_fund' })

    const r = await dbOne<Record<string, unknown>>(`SELECT * FROM wish_repayments WHERE id = ? AND wish_id = ?`, [rid, id])
    if (!r) return void res.json({ error: '还愿不存在' })
    if (r.fulfiller_user_id !== user.id) return void res.json({ error: '仅施善人可响应' })
    if (r.status !== 'offered') return void res.json({ error: '已处理' })

    const amount = Number(r.amount)
    let raceLost = false
    db.transaction(() => {
      const newStatus = choice === 'accept' ? 'accepted' : 'declined_to_fund'
      const upd = db.prepare(`UPDATE wish_repayments SET status=?, responded_at=datetime('now'), locked=0
                              WHERE id = ? AND status='offered'`).run(newStatus, rid)
      if (upd.changes === 0) { raceLost = true; return }
      if (choice === 'accept') {
        db.prepare(`UPDATE wallets SET staked = staked - ? WHERE user_id = ?`).run(amount, r.wisher_user_id)
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(amount, r.fulfiller_user_id)
        ensureCharityRep(db, user.id as string)
        db.prepare(`UPDATE charity_reputation SET repay_honor = repay_honor + 5, prestige_score = prestige_score + 5, last_active = datetime('now') WHERE user_id = ?`).run(user.id)
      } else {
        // decline_to_fund：钱转入基金，双方都得荣誉
        db.prepare(`UPDATE wallets SET staked = staked - ? WHERE user_id = ?`).run(amount, r.wisher_user_id)
        db.prepare(`UPDATE charity_fund SET balance = balance + ?, total_redirected = total_redirected + ?, updated_at = datetime('now') WHERE id = 'main'`).run(amount, amount)
        db.prepare(`INSERT INTO charity_fund_txns (id, kind, from_user_id, to_user_id, amount, related_wish_id, related_repay_id, note)
                    VALUES (?, 'repay_redirect', ?, NULL, ?, ?, ?, ?)`).run(
          generateId('cft'), r.wisher_user_id, amount, id, rid, r.note || null
        )
        // 许愿人：还愿 5 + 转捐额外 3
        ensureCharityRep(db, r.wisher_user_id as string)
        db.prepare(`UPDATE charity_reputation SET redirect_honor = redirect_honor + 3, prestige_score = prestige_score + 8, last_active = datetime('now') WHERE user_id = ?`).run(r.wisher_user_id)
        // 施善人：谢绝接受荣誉 +2
        ensureCharityRep(db, user.id as string)
        db.prepare(`UPDATE charity_reputation SET grace_honor = grace_honor + 2, prestige_score = prestige_score + 2, last_active = datetime('now') WHERE user_id = ?`).run(user.id)
      }
      // 重算徽章
      for (const uid of [r.wisher_user_id, r.fulfiller_user_id]) {
        const s = (db.prepare('SELECT prestige_score FROM charity_reputation WHERE user_id = ?').get(uid) as { prestige_score: number } | undefined)?.prestige_score || 0
        db.prepare('UPDATE charity_reputation SET badge_tier = ? WHERE user_id = ?').run(charityBadgeTier(s), uid)
      }
    })()
    if (raceLost) return void res.json({ error: '该还愿已被处理（可能 auto-accept 或重复点击），请刷新' })
    // P2.4 通知：许愿人收到响应
    try {
      const label = choice === 'accept' ? '已接受你的还愿' : '谢绝接受 · 已转入慈善基金'
      const t = (await dbOne<{ title: string }>('SELECT title FROM wishes WHERE id = ?', [id]))!.title
      await dbRun(`INSERT INTO notifications (id, user_id, wish_id, type, title, body, created_at)
                  VALUES (?,?,?,'wish_repay_resp',?,?,datetime('now'))`,
        [generateId('ntf'), r.wisher_user_id as string, id, `🌸 ${label}`, `「${t}」 ${choice === 'accept' ? '施善人已接受还愿' : '+8 威望已入账（含 +3 转捐荣誉）'}`])
    } catch (e) { console.error('[charity notify repay resp]', e) }
    res.json({ ok: true, choice })
  })

  // 任何人捐款给慈善基金
  app.post('/api/charity/fund/donate', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // P0 fix: 受信角色不可捐款（无钱包）— 鼓励中立治理
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色无钱包', error_code: 'TRUSTED_ROLE_NO_WALLET' })
    if (!rateLimitOk(req.ip || '', 20, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const body = req.body as Record<string, unknown>
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount < CHARITY_DONATION_MIN) return void res.json({ error: `捐款需 ≥ ${CHARITY_DONATION_MIN} WAZ` })

    const wallet = await dbOne<{ balance: number }>(`SELECT balance FROM wallets WHERE user_id = ?`, [user.id])
    if (!wallet || wallet.balance < amount) return void res.json({ error: '余额不足' })

    // 当日已得荣誉上限
    const todayHonor = (await dbOne<{ s: number }>(`SELECT IFNULL(SUM(amount),0) as s FROM charity_fund_txns WHERE kind='donation' AND from_user_id = ? AND created_at > datetime('now','-1 day')`, [user.id]))!.s
    const remain = Math.max(0, CHARITY_DONATION_DAILY_HONOR_CAP - todayHonor)
    const honor = Math.min(amount, remain)   // 1 WAZ = 1 honor，封顶 50/日

    // Codex #238 P1:扣款带 balance>=amount 守卫,changes!==1 → 余额已变 → 抛回滚,基金不入账
    try {
      db.transaction(() => {
        const d = db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?`).run(amount, user.id, amount)
        if (d.changes !== 1) throw new Error('DONATE_INSUFFICIENT_BALANCE')
        db.prepare(`UPDATE charity_fund SET balance = balance + ?, total_donated = total_donated + ?, updated_at = datetime('now') WHERE id = 'main'`).run(amount, amount)
        db.prepare(`INSERT INTO charity_fund_txns (id, kind, from_user_id, to_user_id, amount, note)
                    VALUES (?, 'donation', ?, NULL, ?, ?)`).run(
          generateId('cft'), user.id, amount, body.note ? String(body.note).slice(0, 300) : null
        )
        ensureCharityRep(db, user.id as string)
        db.prepare(`UPDATE charity_reputation SET donation_total = donation_total + ?, donation_honor = donation_honor + ?, prestige_score = prestige_score + ?, last_active = datetime('now') WHERE user_id = ?`).run(amount, honor, honor, user.id)
        const s = (db.prepare('SELECT prestige_score FROM charity_reputation WHERE user_id = ?').get(user.id) as { prestige_score: number }).prestige_score
        db.prepare('UPDATE charity_reputation SET badge_tier = ? WHERE user_id = ?').run(charityBadgeTier(s), user.id)
      })()
    } catch (e) {
      if ((e as Error).message === 'DONATE_INSUFFICIENT_BALANCE') return void res.json({ error: '余额不足' })
      throw e
    }
    // 📡 Webhook fire — 通知 donor 自己（可订阅自己的捐款历史）
    fireWebhooks('charity.donation', { amount, note: body.note || null, honor_earned: honor }, [user.id as string]).catch(e => console.error('[webhook]', e))
    res.json({ ok: true, amount, honor_earned: honor, daily_cap_remaining: Math.max(0, remain - honor) })
  })

  // GET 基金概况 + 最近流水
  app.get('/api/charity/fund', async (_req, res) => {
    const fund = await dbOne<Record<string, unknown>>(`SELECT * FROM charity_fund WHERE id = 'main'`, [])
    const recent = await dbAll(`
      SELECT cft.id, cft.kind, cft.amount, cft.note, cft.created_at,
             u.handle as donor_handle, u.region as donor_region
      FROM charity_fund_txns cft
      LEFT JOIN users u ON u.id = cft.from_user_id
      ORDER BY cft.created_at DESC LIMIT 50
    `, [])
    const topDonors = await dbAll(`
      SELECT u.handle, u.region, cr.donation_total, cr.donation_honor
      FROM charity_reputation cr JOIN users u ON u.id = cr.user_id
      WHERE cr.donation_total > 0
      ORDER BY cr.donation_total DESC LIMIT 20
    `, [])
    res.json({ fund, recent, top_donors: topDonors })
  })

  // P2.3 — 举报愿望
  app.post('/api/wishes/:id/report', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(req.ip || '', 10, 60_000)) return void res.status(429).json({ error: '请求过于频繁' })
    const id = req.params.id
    const body = req.body as Record<string, unknown>
    const reason = String(body.reason || '')
    if (!['spam','fraud','inappropriate','other'].includes(reason)) return void res.json({ error: 'reason 无效' })
    const note = body.note ? String(body.note).slice(0, 300) : null
    const exists = await dbOne('SELECT 1 FROM wishes WHERE id = ?', [id])
    if (!exists) return void res.json({ error: '愿望不存在' })
    try {
      await dbRun(`INSERT INTO wish_reports (id, wish_id, reporter_id, reason, note) VALUES (?,?,?,?,?)`,
        [generateId('wr'), id, user.id, reason, note])
    } catch {
      return void res.json({ error: '你已举报过此愿望' })
    }
    // 3 个不同举报人 → 自动隐藏（status='disputed'）
    const cnt = (await dbOne<{ n: number }>("SELECT COUNT(1) as n FROM wish_reports WHERE wish_id = ? AND status = 'pending'", [id]))!.n
    if (cnt >= 3) {
      await dbRun("UPDATE wishes SET status = 'disputed' WHERE id = ? AND status IN ('open','claimed')", [id])
    }
    res.json({ ok: true, total_reports: cnt, auto_hidden: cnt >= 3 })
  })

  // ─── admin 慈善管理 ─────────────────────────────────────────
  app.get('/api/admin/wish-reports', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const status = String(req.query.status || 'pending')
    const where = status === 'all' ? '1=1' : 'wr.status = ?'
    const args = status === 'all' ? [] : [status]
    const rows = await dbAll(`
      SELECT wr.id, wr.wish_id, wr.reporter_id, wr.reason, wr.note, wr.status, wr.created_at,
             w.title as wish_title, w.user_id as wish_owner_id, w.status as wish_status,
             u.handle as reporter_handle
      FROM wish_reports wr
      JOIN wishes w ON w.id = wr.wish_id
      LEFT JOIN users u ON u.id = wr.reporter_id
      WHERE ${where}
      ORDER BY wr.created_at DESC LIMIT 200
    `, args)
    res.json({ items: rows })
  })

  app.patch('/api/admin/wish-reports/:id', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const action = String((req.body as Record<string, unknown>).action || '')
    if (!['dismiss','actioned'].includes(action)) return void res.json({ error: 'action 必须是 dismiss 或 actioned' })
    const r = await dbRun(`UPDATE wish_reports SET status = ? WHERE id = ?`, [action === 'dismiss' ? 'dismissed' : 'actioned', req.params.id])
    if (r.changes === 0) return void res.json({ error: '举报不存在' })
    try {
      await dbRun(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`,
        [generateId('audit'), admin.id, 'wish_report_' + action, 'wish_report', req.params.id, null])
    } catch {}
    res.json({ ok: true, status: action === 'dismiss' ? 'dismissed' : 'actioned' })
  })

  app.post('/api/admin/wishes/:id/takedown', async (req, res) => {
    const admin = requireContentAdmin(req, res); if (!admin) return
    const reason = String((req.body as Record<string, unknown>).reason || '').trim()
    if (!reason) return void res.json({ error: '必须填写下架原因' })
    const w = await dbOne<{ user_id: string; status: string; escrow_locked: number }>(`SELECT user_id, status, escrow_locked FROM wishes WHERE id = ?`, [req.params.id])
    if (!w) return void res.json({ error: '愿望不存在' })
    db.transaction(() => {
      // Codex #238 P1 + #247 复审:CAS open/claimed/disputed→cancelled。仅当本次真正完成该转换(changes===1)
      // 才释放 escrow——若已是 escrow 已释放终态(completed/cancelled)则不重复释放,避免双退;审计始终记录。
      // 'disputed' = 被 3 个举报人自动隐藏(line 734),escrow 仍锁定未释放,故必须纳入释放集合,否则
      // 现金愿望先被举报隐藏再被 takedown 时 staked 会永久卡死。
      const c = db.prepare(`UPDATE wishes SET status='cancelled' WHERE id = ? AND status IN ('open','claimed','disputed')`).run(req.params.id)
      if (c.changes === 1 && w.escrow_locked > 0) {
        db.prepare(`UPDATE wallets SET balance = balance + ?, staked = staked - ? WHERE user_id = ?`).run(w.escrow_locked, w.escrow_locked, w.user_id)
      }
      db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
        .run(generateId('audit'), admin.id, 'wish_takedown', 'wish', req.params.id, JSON.stringify({ reason, escrow_released: c.changes === 1 && w.escrow_locked > 0 }))
    })()
    res.json({ ok: true })
  })

  app.post('/api/admin/charity/fund/disburse', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const body = req.body as Record<string, unknown>
    const amount = Number(body.amount)
    const toUserId = String(body.to_user_id || '').trim()
    const note = String(body.note || '').trim()
    if (!Number.isFinite(amount) || amount <= 0) return void res.json({ error: 'amount 无效' })
    if (!toUserId) return void res.json({ error: 'to_user_id 必填' })
    if (!note) return void res.json({ error: '必须填写拨款用途（写入审计）' })
    const targetUser = await dbOne<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ?`, [toUserId])
    if (!targetUser) return void res.json({ error: '收款用户不存在' })
    const fund = (await dbOne<{ balance: number }>(`SELECT balance FROM charity_fund WHERE id = 'main'`, []))!
    if (fund.balance < amount) return void res.json({ error: `基金余额不足 (当前 ${fund.balance})` })

    // Codex #238 P1:基金扣款带 balance>=amount 守卫(WHERE id='main' AND balance>=?),changes!==1 →
    // 余额在 await 预检后已变 → 抛回滚,先于给收款人入账,杜绝基金超额拨款。
    try {
      db.transaction(() => {
        const f = db.prepare(`UPDATE charity_fund SET balance = balance - ?, total_disbursed = total_disbursed + ?, updated_at = datetime('now') WHERE id = 'main' AND balance >= ?`).run(amount, amount, amount)
        if (f.changes !== 1) throw new Error('FUND_INSUFFICIENT')
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(amount, toUserId)
        db.prepare(`INSERT INTO charity_fund_txns (id, kind, from_user_id, to_user_id, amount, note) VALUES (?, 'disburse', NULL, ?, ?, ?)`)
          .run(generateId('cft'), toUserId, amount, note)
        db.prepare(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)`)
          .run(generateId('audit'), admin.id, 'charity_disburse', 'user', toUserId, JSON.stringify({ amount, note }))
        try {
          db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at) VALUES (?,?,'charity_disburse',?,?,datetime('now'))`)
            .run(generateId('ntf'), toUserId, `💰 慈善基金拨款 +${amount} WAZ`, note)
        } catch {}
      })()
    } catch (e) {
      if ((e as Error).message === 'FUND_INSUFFICIENT') return void res.json({ error: `基金余额不足` })
      throw e
    }
    res.json({ ok: true, amount, to_user: targetUser.name })
  })

  app.get('/api/admin/charity/fund', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const fund = await dbOne(`SELECT * FROM charity_fund WHERE id = 'main'`, [])
    const recent = await dbAll(`
      SELECT cft.*, uf.name as from_name, ut.name as to_name
      FROM charity_fund_txns cft
      LEFT JOIN users uf ON uf.id = cft.from_user_id
      LEFT JOIN users ut ON ut.id = cft.to_user_id
      ORDER BY cft.created_at DESC LIMIT 100
    `, [])
    res.json({ fund, recent })
  })

  // 慈善排行
  app.get('/api/charity/leaderboard', async (_req, res) => {
    const rows = await dbAll(`
      SELECT cr.prestige_score, cr.wishes_fulfilled, cr.wishes_made, cr.badge_tier,
             u.handle, u.region
      FROM charity_reputation cr JOIN users u ON u.id = cr.user_id
      WHERE cr.prestige_score > 0
      ORDER BY cr.prestige_score DESC, cr.wishes_fulfilled DESC
      LIMIT 50
    `, [])
    res.json({ items: rows })
  })
}
