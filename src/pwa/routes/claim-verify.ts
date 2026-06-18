/**
 * 索赔验证 (claim_verify) 域 — 三路径结算 + outlier strike + 协议铁律 §4
 *
 * 由 #1013 Phase 9 从 src/pwa/server.ts 抽出。最复杂域之一（含铁律 §4 vote）。
 *
 * 8 endpoints + 1 cron + 5 helpers + 13 常量:
 *   POST /api/orders/:id/claim-verification           — 买家发起 claim（锁 stake）
 *   GET  /api/orders/:id/claim-task                   — 通过 order_id 查关联 task
 *   GET  /api/claim-tasks/available                   — 列出可接的 open 任务
 *   POST /api/claim-tasks/:id/vote                    — verifier 投票（铁律 §4 — HUMAN_PRESENCE_REQUIRED）
 *   GET  /api/claim-tasks/mine                        — 我相关的任务（三视角）
 *   POST /api/me/notify-claim-tasks                   — 通知偏好开关
 *   GET  /api/me/notify-claim-tasks                   — 查通知偏好
 *   GET  /api/claims/public                           — 公开 #claims 广场
 *   GET  /api/claim-tasks/:id                         — 任务详情
 *   POST /api/claim-tasks/:id/seller-evidence         — 卖家提交反证（延期 24h）
 *
 * + export processClaimTaskQueue(db, generateId) — 5min enforcement cron 调用
 *
 * 留 server.ts：
 *   - requireHumanPresence — 铁律 helper，被 arbitrate / agent_revoke / vote 3 处用
 *   - checkVerifierEligibility — verifier 申请相关（属 verifier-管理域，未拆）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'
// #420 P1-3 — verifier outlier 阈值改由 governance-adjustable protocol_params 驱动
import { readAntiAbuseThresholds, verifierOutlierBand } from '../anti-abuse-thresholds.js'

// RFC-016 Phase 1 — 仅端点纯校验读/列表/公开查询/读回 + 单语句标记/字段写 + 写后通知 → async seam。
// 全部保持同步(Phase 3 再用 pg tx/行锁):
//   - 模块级 helper(settleClaimTask 三路径结算 / distributePool / checkAndApplyOutlierStrike /
//     notifyEligibleVerifiers / isEligibleClaimVerifier / activeClaimTaskCountForVerifier /
//     processClaimTaskQueue)——settleClaimTask 是裸(非 db.transaction)多写结算序列,
//     由 vote 端点与 cron 调用,必须整体同步;
//   - claim 发起锁押序列(INSERT task + 锁 stake + has_pending_claim);
//   - vote 共识序列(票数 guard + INSERT vote + 收齐重数 + seal),seal 后同步调 settleClaimTask。

// ─── 域常量 ───────────────────────────────────────────────
export const CLAIM_STAKE_DEFAULT = 10                // 买家发起质押 10 WAZ
export const CLAIM_DEADLINE_HOURS = 48               // 接单 + 投票截止
export const CLAIM_SELLER_EXTENSION_HOURS = 24       // 卖家提交证据后延期
export const CLAIM_VERIFIERS_NEEDED = 3              // 共识阈值
export const CLAIM_VERIFIER_MIN_REP = 200            // reputation_scores.total_points 门槛
export const CLAIM_VERIFIER_MAX_ACTIVE = 5           // 同时进行中任务上限
const CLAIM_VALID_TARGETS = new Set(['price', 'commission', 'protection', 'return', 'warranty', 'handling', 'other'])
export const CLAIM_TARGET_LABEL_ZH: Record<string, string> = {
  price: '价格优势', commission: '分享佣金', protection: '协议保障',
  return: '退货条款', warranty: '质保条款', handling: '发货时效', other: '其他理由',
}
const CLAIM_VALID_VOTES = new Set(['pass', 'fail', 'no_fault', 'abstain'])
// V3：abstain 不计入 3-vote 共识、不参与 majority、不触发 outlier
const CLAIM_SELLER_FINE_RATE = 0.10   // pass 时扣 product.stake_amount × 10%
const CLAIM_NO_FAULT_SUBSIDY = 1      // no_fault 路径协议池补贴每个 verifier 1 WAZ
// #420 P1-3:verifier outlier 阈值（暂停/撤销/窗口/暂停时长）已抽到 governance-adjustable
// protocol_params,单一真相源在 ../anti-abuse-thresholds.ts(DEFAULT_ANTI_ABUSE_THRESHOLDS:
// outlierSuspendCount=3 / outlierRevokeCount=5 / outlierSuspendDays=30 / outlierWindowDays=180)。
// checkAndApplyOutlierStrike + server.ts checkVerifierOutlier 通过 readAntiAbuseThresholds(db) 读取。

// ─── helpers (module-level, db 通过参数传) ───────────────────
// 2026-05-22 V2：通知所有资格内 verifier 有新 claim 任务
export function notifyEligibleVerifiers(
  db: Database.Database,
  generateId: (prefix: string) => string,
  args: {
    taskId: string
    productTitle: string
    claimTargetLabel: string
    buyerId: string
    sellerId: string
    notificationType: 'claim_new' | 'claim_evidence_added'
  },
): number {
  const { taskId: _taskId, productTitle, claimTargetLabel, buyerId, sellerId, notificationType } = args
  // ① whitelist 用户（含内部审核员）  ② reputation_scores >= CLAIM_VERIFIER_MIN_REP
  const rows = db.prepare(`
    SELECT DISTINCT u.id
    FROM users u
    WHERE u.id IN (
      SELECT user_id FROM verifier_whitelist
      UNION
      SELECT user_id FROM reputation_scores WHERE total_points >= ?
    )
    AND u.id NOT IN (?, ?)
    AND COALESCE(u.notify_claim_tasks, 1) = 1
    AND NOT EXISTS (
      SELECT 1 FROM claim_verifier_suspensions s
      WHERE s.user_id = u.id
        AND (s.type = 'revoked' OR (s.until_at IS NOT NULL AND s.until_at > datetime('now')))
    )
  `).all(CLAIM_VERIFIER_MIN_REP, buyerId, sellerId) as Array<{ id: string }>
  if (rows.length === 0) return 0
  const title = notificationType === 'claim_new'
    ? `🔎 新验证任务：${claimTargetLabel}`
    : `📎 验证任务有新证据：${claimTargetLabel}`
  const body = notificationType === 'claim_new'
    ? `「${productTitle}」 — 去 #claims 广场查看并投票`
    : `「${productTitle}」卖家提交了新证据，截止延期 24h`
  const ins = db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
  db.transaction(() => {
    for (const r of rows) {
      try { ins.run(generateId('ntf'), r.id, notificationType, title, body, null) } catch {}
    }
  })()
  return rows.length
}

export function isEligibleClaimVerifier(db: Database.Database, userId: string): { ok: boolean; reason?: string; via?: 'whitelist' | 'reputation' } {
  // ── M7.3b：先看是否被禁言 / 永封 ──
  const sus = db.prepare(`SELECT type, until_at FROM claim_verifier_suspensions
    WHERE user_id = ? AND (type = 'revoked' OR until_at > datetime('now'))
    ORDER BY created_at DESC LIMIT 1`).get(userId) as { type: string; until_at: string | null } | undefined
  if (sus) {
    if (sus.type === 'revoked') return { ok: false, reason: '该账号已永久撤销 verifier 资格（累计 5 次 outlier）' }
    return { ok: false, reason: `账号 verifier 资格被冻结至 ${sus.until_at}（累计 3 次 outlier）` }
  }
  // ① verifier_whitelist 一票通过
  const wl = db.prepare('SELECT user_id FROM verifier_whitelist WHERE user_id = ?').get(userId)
  if (wl) return { ok: true, via: 'whitelist' }
  // ② 信誉门槛
  const rep = db.prepare('SELECT total_points FROM reputation_scores WHERE user_id = ?').get(userId) as { total_points: number } | undefined
  if (rep && (rep.total_points ?? 0) >= CLAIM_VERIFIER_MIN_REP) return { ok: true, via: 'reputation' }
  return { ok: false, reason: `需要 verifier_whitelist 或 信誉积分 ≥ ${CLAIM_VERIFIER_MIN_REP}（当前 ${rep?.total_points ?? 0}）` }
}

export function activeClaimTaskCountForVerifier(db: Database.Database, userId: string): number {
  const r = db.prepare(`
    SELECT COUNT(DISTINCT cvv.task_id) as n
    FROM claim_verification_votes cvv
    JOIN claim_verification_tasks cvt ON cvt.id = cvv.task_id
    WHERE cvv.verifier_id = ? AND cvt.status = 'open'
  `).get(userId) as { n: number }
  return r.n
}

// M7.3b：单个 outlier 处罚检查
function checkAndApplyOutlierStrike(db: Database.Database, generateId: (p: string) => string, userId: string): { strikes_180d: number; suspension?: { type: 'suspended' | 'revoked'; until_at: string | null } } {
  // #420 P1-3:窗口/暂停/撤销阈值由 protocol_params 驱动(默认 = 原 180d/≥5/≥3/30d)
  const t = readAntiAbuseThresholds(db)
  const cnt = (db.prepare(`
    SELECT COUNT(*) as n FROM claim_verification_votes cvv
    JOIN claim_verification_tasks cvt ON cvt.id = cvv.task_id
    WHERE cvv.verifier_id = ?
      AND cvv.was_majority = 0
      AND cvt.resolved_at IS NOT NULL
      AND cvt.resolved_at >= datetime('now', '-${t.outlierWindowDays} days')
  `).get(userId) as { n: number }).n
  const existing = db.prepare(`SELECT type, outlier_count FROM claim_verifier_suspensions
    WHERE user_id = ? AND (type = 'revoked' OR until_at > datetime('now'))
    ORDER BY created_at DESC LIMIT 1`).get(userId) as { type: string; outlier_count: number } | undefined
  if (existing?.type === 'revoked') return { strikes_180d: cnt }
  const band = verifierOutlierBand(cnt, t)
  if (band === 'revoke' && (!existing || existing.outlier_count < t.outlierRevokeCount)) {
    db.prepare(`INSERT INTO claim_verifier_suspensions (id, user_id, type, reason, outlier_count)
      VALUES (?,?, 'revoked', ?, ?)`).run(generateId('cvs'), userId, `${t.outlierWindowDays}d 内累计 ${cnt} 次 outlier`, cnt)
    return { strikes_180d: cnt, suspension: { type: 'revoked', until_at: null } }
  }
  if (band === 'suspend' && !existing) {
    const until = new Date(Date.now() + t.outlierSuspendDays * 86400_000).toISOString()
    db.prepare(`INSERT INTO claim_verifier_suspensions (id, user_id, type, until_at, reason, outlier_count)
      VALUES (?,?, 'suspended', ?, ?, ?)`).run(generateId('cvs'), userId, until, `${t.outlierWindowDays}d 内累计 ${cnt} 次 outlier`, cnt)
    return { strikes_180d: cnt, suspension: { type: 'suspended', until_at: until } }
  }
  return { strikes_180d: cnt }
}

// 给一组 user_id 平均分发金额
function distributePool(db: Database.Database, userIds: string[], total: number): void {
  if (userIds.length === 0 || total <= 0) return
  const each = Math.floor((total / userIds.length) * 100) / 100
  let used = 0
  for (let i = 0; i < userIds.length; i++) {
    const amt = i === userIds.length - 1 ? Math.round((total - used) * 100) / 100 : each
    used += amt
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amt, userIds[i])
  }
}

// M7.3b 核心：三路径结算
export function settleClaimTask(db: Database.Database, generateId: (p: string) => string, taskId: string): { ok: boolean; path?: string; majority?: string; payouts?: Record<string, unknown>; reason?: string } {
  const task = db.prepare('SELECT * FROM claim_verification_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!task) return { ok: false, reason: 'task not found' }
  if (String(task.status).startsWith('resolved_') || String(task.status).startsWith('timeout_')) {
    return { ok: false, reason: '已结算' }
  }
  const allVotes = db.prepare('SELECT id, verifier_id, vote FROM claim_verification_votes WHERE task_id = ?').all(taskId) as Array<{ id: string; verifier_id: string; vote: string }>
  const votes = allVotes.filter(v => v.vote !== 'abstain')

  const counts: Record<string, number> = { pass: 0, fail: 0, no_fault: 0 }
  for (const v of votes) counts[v.vote] = (counts[v.vote] || 0) + 1
  let majority: 'pass' | 'fail' | 'no_fault' = 'no_fault'
  let path: 'pass' | 'fail' | 'no_fault' | 'timeout_no_fault' = 'no_fault'
  if (votes.length === 0) {
    path = 'timeout_no_fault'
    majority = 'no_fault'
  } else {
    const maxN = Math.max(counts.pass, counts.fail, counts.no_fault)
    const winners = (['pass', 'fail', 'no_fault'] as const).filter(k => counts[k] === maxN)
    if (winners.length > 1) majority = 'no_fault'
    else majority = winners[0]
    path = majority === 'pass' ? 'pass' : majority === 'fail' ? 'fail' : 'no_fault'
  }

  const buyerId = task.buyer_id as string
  const sellerId = task.seller_id as string
  const productId = task.product_id as string
  const stake = Number(task.stake_buyer)
  const payouts: Record<string, unknown> = { path, majority, stake_buyer: stake }

  db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(stake, buyerId)

  const majorityVoters = majority === 'no_fault'
    ? votes.map(v => v.verifier_id)
    : votes.filter(v => v.vote === majority).map(v => v.verifier_id)

  if (path === 'pass') {
    const refund = Math.round(stake * 0.5 * 100) / 100
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(refund, buyerId)
    const voterPool = Math.round(stake * 0.5 * 100) / 100
    payouts.buyer_refund = refund
    payouts.voter_reward_from_buyer = voterPool
    distributePool(db, majorityVoters, voterPool)
    const prod = db.prepare('SELECT stake_amount, stake_locked_at FROM products WHERE id = ?').get(productId) as { stake_amount: number; stake_locked_at: string | null } | undefined
    if (prod && prod.stake_amount > 0) {
      const fine = Math.round(prod.stake_amount * CLAIM_SELLER_FINE_RATE * 100) / 100
      const sellerWallet = db.prepare('SELECT balance, staked FROM wallets WHERE user_id = ?').get(sellerId) as { balance: number; staked: number }
      if (prod.stake_locked_at) {
        const fromStaked = Math.min(fine, sellerWallet.staked || 0)
        db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(fromStaked, sellerId)
        const remain = fine - fromStaked
        if (remain > 0) {
          db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(remain, sellerId)
        }
      } else {
        const fromBalance = Math.min(fine, sellerWallet.balance || 0)
        db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(fromBalance, sellerId)
        db.prepare("UPDATE products SET stake_locked_at = datetime('now') WHERE id = ?").run(productId)
      }
      const halfFine = Math.round(fine * 0.5 * 100) / 100
      distributePool(db, majorityVoters, halfFine)
      db.prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = 'sys_protocol'").run(fine - halfFine)
      payouts.seller_fine = fine
      payouts.voter_reward_from_seller_fine = halfFine
      payouts.protocol_share = fine - halfFine
    }
    db.prepare(`UPDATE claim_verification_tasks SET status = 'resolved_pass', majority_vote = ?, resolved_at = datetime('now') WHERE id = ?`).run(majority, taskId)
  } else if (path === 'fail') {
    const voterPool = Math.round(stake * 0.5 * 100) / 100
    distributePool(db, majorityVoters, voterPool)
    db.prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = 'sys_protocol'").run(stake - voterPool)
    payouts.buyer_refund = 0
    payouts.voter_reward = voterPool
    payouts.protocol_share = stake - voterPool
    db.prepare(`UPDATE claim_verification_tasks SET status = 'resolved_fail', majority_vote = ?, resolved_at = datetime('now') WHERE id = ?`).run(majority, taskId)
  } else {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(stake, buyerId)
    const allVoters = votes.map(v => v.verifier_id)
    const idealSubsidy = CLAIM_NO_FAULT_SUBSIDY * allVoters.length
    const sp = db.prepare("SELECT balance FROM wallets WHERE user_id = 'sys_protocol'").get() as { balance: number } | undefined
    const available = Math.max(0, sp?.balance ?? 0)
    const subsidy = Math.min(idealSubsidy, available)
    if (subsidy > 0) {
      db.prepare("UPDATE wallets SET balance = balance - ? WHERE user_id = 'sys_protocol'").run(subsidy)
      distributePool(db, allVoters, subsidy)
    }
    payouts.buyer_refund = stake
    payouts.voter_subsidy = subsidy
    if (subsidy < idealSubsidy) payouts.voter_subsidy_shortfall = idealSubsidy - subsidy
    const finalStatus = votes.length === 0 ? 'timeout_no_fault' : 'resolved_no_fault'
    db.prepare(`UPDATE claim_verification_tasks SET status = ?, majority_vote = ?, resolved_at = datetime('now') WHERE id = ?`).run(finalStatus, majority, taskId)
  }

  // 标记每张票是否属于 majority 派
  for (const v of allVotes) {
    if (v.vote === 'abstain') {
      db.prepare('UPDATE claim_verification_votes SET was_majority = NULL WHERE id = ?').run(v.id)
    } else {
      const wasMaj = v.vote === majority ? 1 : 0
      db.prepare('UPDATE claim_verification_votes SET was_majority = ? WHERE id = ?').run(wasMaj, v.id)
    }
  }
  // outlier 处罚
  const strikes: Record<string, unknown> = {}
  if (votes.length >= 2) {
    for (const v of votes) {
      if (v.vote !== majority) {
        const r = checkAndApplyOutlierStrike(db, generateId, v.verifier_id)
        strikes[v.verifier_id] = r
      }
    }
  }
  payouts.outlier_strikes = strikes

  db.prepare('UPDATE orders SET has_pending_claim = 0 WHERE id = ?').run(task.order_id as string)
  return { ok: true, path, majority, payouts }
}

// 扫描需要结算的任务（5min enforcement cron 调用）
export function processClaimTaskQueue(db: Database.Database, generateId: (p: string) => string): { sealed: number; timeout: number; details: Array<Record<string, unknown>> } {
  const details: Array<Record<string, unknown>> = []
  let sealed = 0, timeout = 0
  try {
    const sealedTasks = db.prepare(`SELECT id FROM claim_verification_tasks WHERE status = 'sealed'`).all() as Array<{ id: string }>
    for (const t of sealedTasks) {
      const r = settleClaimTask(db, generateId, t.id)
      if (r.ok) { sealed++; details.push({ task_id: t.id, ...r }) }
    }
    const timedOut = db.prepare(`SELECT id FROM claim_verification_tasks WHERE status = 'open' AND deadline_at < datetime('now')`).all() as Array<{ id: string }>
    for (const t of timedOut) {
      const r = settleClaimTask(db, generateId, t.id)
      if (r.ok) { timeout++; details.push({ task_id: t.id, ...r }) }
    }
  } catch (e) {
    console.error('[M7.3b processClaimTaskQueue]', (e as Error).message)
  }
  return { sealed, timeout, details }
}

export interface ClaimVerifyDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  // 铁律 helper — 留 server.ts（arbitrate / agent_revoke / vote 3 处用）
  requireHumanPresence: (userId: string, purpose: 'vote' | 'arbitrate' | 'agent_revoke', token: string | undefined, paramKey: string, validate?: (data: unknown) => boolean) => { ok: boolean; reason?: string; error_code?: string; required_when_enabled?: boolean }
}

export function registerClaimVerifyRoutes(app: Application, deps: ClaimVerifyDeps): void {
  const { db, auth, generateId, requireHumanPresence } = deps

  // 买家发起 claim 验证任务（绑定 paid 及之后的订单）
  app.post('/api/orders/:id/claim-verification', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const order = await dbOne<Record<string, unknown>>('SELECT * FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    if (order.buyer_id !== user.id) return void res.status(403).json({ error: '仅订单买家可发起验证' })
    const blockedStatuses = new Set(['created', 'cancelled', 'completed', 'refunded'])
    if (blockedStatuses.has(order.status as string)) {
      return void res.status(400).json({ error: `当前订单状态（${order.status}）不可发起验证` })
    }
    const existing = await dbOne<{ id: string }>('SELECT id FROM claim_verification_tasks WHERE order_id = ?', [req.params.id])
    if (existing) return void res.status(409).json({ error: '该订单已存在验证任务（不可撤销）', task_id: existing.id })

    const claim_target = String(req.body?.claim_target || '').trim()
    if (!CLAIM_VALID_TARGETS.has(claim_target)) {
      return void res.status(400).json({ error: `claim_target 必须是 ${[...CLAIM_VALID_TARGETS].join(' / ')} 之一` })
    }
    const claim_text = String(req.body?.claim_text || '').trim()
    if (claim_text.length < 6 || claim_text.length > 500) {
      return void res.status(400).json({ error: 'claim_text 长度需 6-500 字' })
    }
    const evidence_uri = req.body?.evidence_uri ? String(req.body.evidence_uri).trim().slice(0, 500) : null

    const wallet = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    const stake = CLAIM_STAKE_DEFAULT
    if (!wallet || wallet.balance < stake) {
      return void res.status(400).json({ error: `余额不足：发起需锁 ${stake} WAZ，当前余额 ${wallet?.balance ?? 0} WAZ` })
    }

    const id = generateId('cvt')
    const deadline = new Date(Date.now() + CLAIM_DEADLINE_HOURS * 3600_000).toISOString()
    const sellerId = order.seller_id as string
    // Codex #237 P1:原为裸多写序列(await 预检后直接 3 连写,无 db.transaction、无余额守卫)。
    // 包进 db.transaction + tx 内重检无重复 task + 余额守卫扣押 + 订单 flag CAS;任一失败回滚全部。
    const BLOCKED = ['created', 'cancelled', 'completed', 'refunded']
    try {
      db.transaction(() => {
        const dup = db.prepare('SELECT id FROM claim_verification_tasks WHERE order_id = ?').get(req.params.id) as { id: string } | undefined
        if (dup) throw new Error('CLAIM_EXISTS')
        db.prepare(`INSERT INTO claim_verification_tasks
          (id, order_id, buyer_id, seller_id, product_id, claim_target, claim_text, evidence_uri, stake_buyer, deadline_at, status)
          VALUES (?,?,?,?,?,?,?,?,?,?, 'open')`).run(
            id, req.params.id, user.id, sellerId, order.product_id, claim_target, claim_text, evidence_uri, stake, deadline)
        const d = db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ? AND balance >= ?')
          .run(stake, stake, user.id, stake)
        if (d.changes !== 1) throw new Error('CLAIM_INSUFFICIENT_BALANCE')
        const o = db.prepare(`UPDATE orders SET has_pending_claim = 1 WHERE id = ? AND (has_pending_claim IS NULL OR has_pending_claim != 1) AND status NOT IN ('created','cancelled','completed','refunded')`).run(req.params.id)
        if (o.changes !== 1) throw new Error('CLAIM_ORDER_BLOCKED')
      })()
    } catch (e) {
      const m = (e as Error).message
      if (m === 'CLAIM_EXISTS') return void res.status(409).json({ error: '该订单已存在验证任务（不可撤销）' })
      if (m === 'CLAIM_INSUFFICIENT_BALANCE') return void res.status(400).json({ error: `余额不足：发起需锁 ${stake} WAZ` })
      if (m === 'CLAIM_ORDER_BLOCKED') return void res.status(400).json({ error: `当前订单状态不可发起验证（${BLOCKED.join('/')} 或已挂验证）` })
      throw e
    }

    const productTitle = (await dbOne<{ title: string }>('SELECT title FROM products WHERE id = ?', [order.product_id as string]))?.title || '—'
    const claimLabel = CLAIM_TARGET_LABEL_ZH[claim_target] || claim_target
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`,
        [generateId('ntf'), sellerId, 'claim_new',
          `⚠️ 买家发起验证：${claimLabel}`,
          `订单「${productTitle}」 — 48h 内提交证据可延期至 verifier 共识结案`,
          req.params.id])
    } catch (e) { console.error('[V2 notify seller]', (e as Error).message) }
    try {
      const notified = notifyEligibleVerifiers(db, generateId, {
        taskId: id, productTitle, claimTargetLabel: claimLabel,
        buyerId: user.id as string, sellerId,
        notificationType: 'claim_new',
      })
      console.log(`[V2] claim_new ${id} notified ${notified} verifiers`)
    } catch (e) { console.error('[V2 notify verifiers]', (e as Error).message) }

    res.json({ success: true, task_id: id, deadline_at: deadline, stake_locked: stake })
  })

  // 通过 order_id 查关联 task
  app.get('/api/orders/:id/claim-task', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const task = await dbOne<Record<string, unknown>>('SELECT * FROM claim_verification_tasks WHERE order_id = ?', [req.params.id])
    if (!task) return void res.json({ task: null })
    const hasVoted = await dbOne('SELECT id FROM claim_verification_votes WHERE task_id = ? AND verifier_id = ?', [task.id, user.id])
    const isParty = task.buyer_id === user.id || task.seller_id === user.id
    const elig = isEligibleClaimVerifier(db, user.id as string)
    if (!isParty && !hasVoted && !elig.ok) return void res.json({ task: null, visibility: 'restricted' })
    const votes = await dbAll(`SELECT verifier_id, vote, voted_at FROM claim_verification_votes WHERE task_id = ? ORDER BY voted_at ASC`, [task.id])
    res.json({ task, votes, votes_needed: CLAIM_VERIFIERS_NEEDED })
  })

  // 列出可接的 open 任务
  app.get('/api/claim-tasks/available', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleClaimVerifier(db, user.id as string)
    if (!elig.ok) return void res.status(403).json({ error: elig.reason, eligible: false })
    const active = activeClaimTaskCountForVerifier(db, user.id as string)
    if (active >= CLAIM_VERIFIER_MAX_ACTIVE) {
      return void res.status(429).json({ error: `已有 ${active} 个进行中任务（上限 ${CLAIM_VERIFIER_MAX_ACTIVE}），请先完成`, active })
    }
    const rows = await dbAll(`
      SELECT cvt.id, cvt.order_id, cvt.product_id, cvt.claim_target, cvt.claim_text,
             cvt.evidence_uri, cvt.seller_evidence_uri, cvt.deadline_at, cvt.created_at,
             (SELECT COUNT(*) FROM claim_verification_votes WHERE task_id = cvt.id AND vote != 'abstain') as votes_count,
             p.title as product_title
      FROM claim_verification_tasks cvt
      LEFT JOIN products p ON p.id = cvt.product_id
      WHERE cvt.status = 'open'
        AND cvt.buyer_id != ? AND cvt.seller_id != ?
        AND NOT EXISTS (SELECT 1 FROM claim_verification_votes WHERE task_id = cvt.id AND verifier_id = ?)
        AND (SELECT COUNT(*) FROM claim_verification_votes WHERE task_id = cvt.id AND vote != 'abstain') < ?
      ORDER BY cvt.created_at ASC
      LIMIT 50
    `, [user.id, user.id, user.id, CLAIM_VERIFIERS_NEEDED])
    res.json({ eligible: true, via: elig.via, active, max_active: CLAIM_VERIFIER_MAX_ACTIVE, tasks: rows })
  })

  // verifier 投票 — 铁律 §4
  app.post('/api/claim-tasks/:id/vote', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const elig = isEligibleClaimVerifier(db, user.id as string)
    if (!elig.ok) return void res.status(403).json({ error: elig.reason })

    // 2026-05-23 Agent 治理铁律：投票需真实人工
    const hpCheck = requireHumanPresence(user.id as string, 'vote', req.body?.webauthn_token, 'require_human_presence_for_vote', (data) => {
      const d = data as Record<string, unknown> | null
      return d == null || d.task_id === req.params.id
    })
    if (!hpCheck.ok) return void res.status(412).json({ error: hpCheck.reason, error_code: hpCheck.error_code })

    const task = await dbOne<Record<string, unknown>>('SELECT * FROM claim_verification_tasks WHERE id = ?', [req.params.id])
    if (!task) return void res.status(404).json({ error: '任务不存在' })
    if (task.status !== 'open') return void res.status(400).json({ error: `任务状态为 ${task.status}，不接受投票` })
    if (task.buyer_id === user.id) return void res.status(403).json({ error: '买家不可对自己的发起任务投票' })
    if (task.seller_id === user.id) return void res.status(403).json({ error: '卖家不可对自己的商品投票' })

    const vote = String(req.body?.vote || '').trim()
    if (!CLAIM_VALID_VOTES.has(vote)) {
      return void res.status(400).json({ error: `vote 必须是 ${[...CLAIM_VALID_VOTES].join(' / ')}` })
    }
    const evidence_uri = req.body?.evidence_uri ? String(req.body.evidence_uri).trim().slice(0, 500) : null
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null

    const dup = await dbOne('SELECT id FROM claim_verification_votes WHERE task_id = ? AND verifier_id = ?', [req.params.id, user.id])
    if (dup) return void res.status(409).json({ error: '已投过票' })

    const votesNow = (db.prepare(`SELECT COUNT(*) as n FROM claim_verification_votes WHERE task_id = ? AND vote != 'abstain'`)
      .get(req.params.id) as { n: number }).n
    if (votesNow >= CLAIM_VERIFIERS_NEEDED) return void res.status(409).json({ error: '已收齐共识票数，等待结算' })

    const active = activeClaimTaskCountForVerifier(db, user.id as string)
    if (active >= CLAIM_VERIFIER_MAX_ACTIVE) {
      return void res.status(429).json({ error: `已有 ${active} 个进行中任务（上限 ${CLAIM_VERIFIER_MAX_ACTIVE}）` })
    }

    const id = generateId('cvv')
    try {
      db.prepare(`INSERT INTO claim_verification_votes (id, task_id, verifier_id, vote, evidence_uri, note) VALUES (?,?,?,?,?,?)`)
        .run(id, req.params.id, user.id as string, vote, evidence_uri, note)
    } catch {
      return void res.status(409).json({ error: '投票失败（可能并发重复）' })
    }

    // 收齐 3 共识票 → 标记 sealed 并立即结算
    const after = (db.prepare(`SELECT COUNT(*) as n FROM claim_verification_votes WHERE task_id = ? AND vote != 'abstain'`)
      .get(req.params.id) as { n: number }).n
    let settlement: ReturnType<typeof settleClaimTask> | null = null
    if (after >= CLAIM_VERIFIERS_NEEDED) {
      db.prepare(`UPDATE claim_verification_tasks SET status = 'sealed' WHERE id = ? AND status = 'open'`)
        .run(req.params.id)
      settlement = settleClaimTask(db, generateId, req.params.id)
    }
    res.json({
      success: true, vote_id: id, votes_collected: after,
      sealed: after >= CLAIM_VERIFIERS_NEEDED,
      settlement: settlement?.ok ? { path: settlement.path, majority: settlement.majority, payouts: settlement.payouts } : undefined,
    })
  })

  // 我相关的任务（必须在 /:id 之前注册，否则被 /:id 截获）
  app.get('/api/claim-tasks/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const asBuyer = await dbAll(`SELECT id, order_id, product_id, claim_target, status, deadline_at, created_at
      FROM claim_verification_tasks WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 50`, [user.id])
    const asSeller = await dbAll(`SELECT id, order_id, product_id, claim_target, status, deadline_at, created_at
      FROM claim_verification_tasks WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50`, [user.id])
    const asVerifier = await dbAll(`
      SELECT cvt.id, cvt.order_id, cvt.product_id, cvt.claim_target, cvt.status, cvt.deadline_at, cvt.created_at,
             cvv.vote, cvv.voted_at
      FROM claim_verification_votes cvv
      JOIN claim_verification_tasks cvt ON cvt.id = cvv.task_id
      WHERE cvv.verifier_id = ?
      ORDER BY cvv.voted_at DESC
      LIMIT 50`, [user.id])
    res.json({ as_buyer: asBuyer, as_seller: asSeller, as_verifier: asVerifier })
  })

  // 通知偏好
  app.post('/api/me/notify-claim-tasks', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const enabled = req.body?.enabled === false ? 0 : 1
    await dbRun('UPDATE users SET notify_claim_tasks = ? WHERE id = ?', [enabled, user.id])
    res.json({ success: true, notify_claim_tasks: enabled })
  })
  app.get('/api/me/notify-claim-tasks', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne<{ enabled: number }>('SELECT COALESCE(notify_claim_tasks, 1) as enabled FROM users WHERE id = ?', [user.id])
    res.json({ notify_claim_tasks: row?.enabled ?? 1 })
  })

  // 公开 #claims 广场（无 auth — 透明性是验证声明信任的前提）
  app.get('/api/claims/public', async (req, res) => {
    const status = String(req.query.status || 'open')
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30))
    let where: string
    let orderBy: string
    if (status === 'open') {
      where = `cvt.status = 'open'`
      orderBy = `cvt.deadline_at ASC`
    } else if (status === 'sealed') {
      where = `cvt.status = 'sealed'`
      orderBy = `cvt.created_at DESC`
    } else if (status === 'resolved') {
      where = `cvt.status LIKE 'resolved_%' OR cvt.status LIKE 'timeout_%'`
      orderBy = `cvt.resolved_at DESC`
    } else {
      where = `1=1`
      orderBy = `cvt.created_at DESC`
    }
    const rows = await dbAll<Record<string, unknown>>(`
      SELECT cvt.id, cvt.order_id, cvt.product_id, cvt.claim_target,
             SUBSTR(cvt.claim_text, 1, 140) as claim_excerpt,
             cvt.evidence_uri IS NOT NULL as has_buyer_evidence,
             cvt.seller_evidence_uri IS NOT NULL as has_seller_evidence,
             cvt.deadline_at, cvt.created_at, cvt.resolved_at,
             cvt.status, cvt.majority_vote,
             (SELECT COUNT(*) FROM claim_verification_votes WHERE task_id = cvt.id AND vote != 'abstain') as votes_count,
             p.title as product_title, p.images as product_images, p.price as product_price
      FROM claim_verification_tasks cvt
      LEFT JOIN products p ON p.id = cvt.product_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `, [limit])
    const items = rows.map(r => {
      let firstImage: string | null = null
      try {
        const arr = JSON.parse((r.product_images as string) || '[]')
        if (Array.isArray(arr) && arr.length > 0) firstImage = String(arr[0])
      } catch {}
      return {
        id: r.id,
        product_id: r.product_id,
        product_title: r.product_title,
        product_image: firstImage,
        product_price: r.product_price,
        claim_target: r.claim_target,
        claim_excerpt: r.claim_excerpt,
        has_buyer_evidence: !!r.has_buyer_evidence,
        has_seller_evidence: !!r.has_seller_evidence,
        votes_count: r.votes_count,
        votes_needed: CLAIM_VERIFIERS_NEEDED,
        status: r.status,
        majority_vote: r.majority_vote,
        deadline_at: r.deadline_at,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
      }
    })
    res.json({ items, votes_needed: CLAIM_VERIFIERS_NEEDED })
  })

  // 任务详情
  app.get('/api/claim-tasks/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const task = await dbOne<Record<string, unknown>>('SELECT * FROM claim_verification_tasks WHERE id = ?', [req.params.id])
    if (!task) return void res.status(404).json({ error: '任务不存在' })

    const hasVoted = await dbOne('SELECT id FROM claim_verification_votes WHERE task_id = ? AND verifier_id = ?', [req.params.id, user.id])
    const isParty = task.buyer_id === user.id || task.seller_id === user.id
    const elig = isEligibleClaimVerifier(db, user.id as string)
    const canRead = isParty || !!hasVoted || elig.ok
    if (!canRead) {
      return void res.status(403).json({ error: '仅当事人或已投票 / 资格内 verifier 可见任务详情' })
    }

    const votes = await dbAll(`SELECT id, verifier_id, vote, evidence_uri, note, voted_at
      FROM claim_verification_votes WHERE task_id = ? ORDER BY voted_at ASC`, [req.params.id])
    res.json({ task, votes, votes_needed: CLAIM_VERIFIERS_NEEDED })
  })

  // 卖家提交证据 → 延期 24h；状态保持 open
  app.post('/api/claim-tasks/:id/seller-evidence', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const task = await dbOne<Record<string, unknown>>('SELECT * FROM claim_verification_tasks WHERE id = ?', [req.params.id])
    if (!task) return void res.status(404).json({ error: '任务不存在' })
    if (task.seller_id !== user.id) return void res.status(403).json({ error: '仅订单卖家可提交证据' })
    if (task.status !== 'open') return void res.status(400).json({ error: '任务非 open 状态，不接受证据' })
    if (task.seller_evidence_at) return void res.status(409).json({ error: '已提交过证据' })

    const evidence_uri = String(req.body?.evidence_uri || '').trim()
    if (!evidence_uri || evidence_uri.length < 4 || evidence_uri.length > 500) {
      return void res.status(400).json({ error: 'evidence_uri 长度需 4-500' })
    }
    const oldDeadline = new Date(String(task.deadline_at)).getTime()
    const newCandidate = Date.now() + CLAIM_SELLER_EXTENSION_HOURS * 3600_000
    const newDeadline = new Date(Math.max(oldDeadline, newCandidate)).toISOString()
    // Codex #237 P2:await 预检与写之间 task 可能被结算/并发提证;status='open' + seller_evidence_at IS NULL
    // 守卫保证只在仍 open 且未提交过时写,changes===0 → 409。
    const ev = await dbRun(`UPDATE claim_verification_tasks
      SET seller_evidence_uri = ?, seller_evidence_at = datetime('now'), deadline_at = ?
      WHERE id = ? AND status = 'open' AND seller_evidence_at IS NULL`, [evidence_uri, newDeadline, req.params.id])
    if (ev.changes === 0) return void res.status(409).json({ error: '任务状态已变更或已提交过证据（请刷新）' })
    try {
      const productTitle = (await dbOne<{ title: string }>('SELECT title FROM products WHERE id = ?', [task.product_id as string]))?.title || '—'
      const claimLabel = CLAIM_TARGET_LABEL_ZH[String(task.claim_target)] || String(task.claim_target)
      notifyEligibleVerifiers(db, generateId, {
        taskId: String(task.id), productTitle, claimTargetLabel: claimLabel,
        buyerId: task.buyer_id as string, sellerId: task.seller_id as string,
        notificationType: 'claim_evidence_added',
      })
    } catch (e) { console.error('[V2 seller evidence notify]', (e as Error).message) }
    res.json({ success: true, deadline_at: newDeadline, warning: '虚假证据将在结算时扣除 20% stake（M7.3b）' })
  })
}
