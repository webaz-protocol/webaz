/**
 * Orders 动作端点 — 批量发货 + 面交确认 + 通用状态机 action + 超时检查
 *
 * 由 #1013 Phase 84 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   POST /api/orders/batch-ship                  C-4 卖家批量发货（≤100 单 + 单号自动建 evidence）
 *   POST /api/orders/:id/confirm-in-person       买家确认面交完成（直接 completed + settleOrder）
 *   POST /api/orders/:id/action                  通用状态机 transition（accept/ship/pickup/transit/deliver/confirm/dispute）
 *   POST /api/orders/:id/force-timeout-check     当事人手动触发超时判责（buyer/seller/logistics）
 *
 * action 端点关键路径：
 *   - 受信角色禁交易；P0 所有权校验（防绕 engine 层）
 *   - ship 绑定 logistics_company_id；pickup 兜底（孤儿单 logistics 自助领取）
 *   - 证据描述触发 detectFraud → flag_reasons 存入 evidence
 *   - confirm → 系统用户自动 transition 到 completed + settleOrder
 *   - dispute_withdraw_confirm → 买家撤诉并确认收货(限 delivered 来源履约争议+发起人+裁定前;全原子收口)
 *   - disputed → createDispute + broadcastSystemEvent
 *
 * 跨域注入：auth + isTrustedRole + generateId + transition + notifyTransition
 *           + settleOrder + detectFraud + createDispute + checkTimeouts
 *           + recordViolationReputation + broadcastSystemEvent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import type { OrderStatus } from '../../layer0-foundation/L0-2-state-machine/transitions.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'
import { createNotification, notifyDeclineContestCase } from '../../layer2-business/L2-6-notifications/notification-engine.js'
import { executeSellerOrderAction } from '../order-action-exec.js'  // RFC-021 PR3 共享执行器(api_key 路径 strictTracking=false)
import { releaseFeeStake } from '../../direct-pay-ledger.js'   // Rail1 直付:取消/超时释放任何遗留模拟质押(AR 订单无 stake → no-op)
import { restorePreShipDirectPayStock } from '../../direct-pay-stock.js'   // D3 库存回补唯一入口(pre-ship 放行;已出库拒绝)
import { requireBothDisclosuresAcked } from '../../direct-pay-disclosures.js'   // PR-4e: D1/D2 披露契约门
import { requireDirectPayHumanPasskey } from '../direct-pay-guards.js'          // PR-4e: 现场真人 Passkey/gate-token 门

export interface OrdersActionDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  generateId: (prefix: string) => string
  transition: any
  notifyTransition: any
  settleOrder: (orderId: string) => void
  settleFault: (db: Database.Database, orderId: string, faultState: OrderStatus) => void
  detectFraud: (text: string) => string[]
  createDispute: any
  /** 统一仲裁台:卖家举证客观拒单时,同步建一条 decline_contest dispute 行(不改 order.status;幂等)。 */
  createDeclineContestDispute: (db: Database.Database, orderId: string) => { success: boolean; disputeId?: string; existing?: boolean; error?: string }
  checkTimeouts: any
  recordViolationReputation: any
  broadcastSystemEvent: (type: string, icon: string, msg: string, refId?: string | null) => void
  /** PR-4e: 一次性真人 WebAuthn gate token 消费器(server.ts createHumanPresence 注入)。 */
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
}

export function registerOrdersActionRoutes(app: Application, deps: OrdersActionDeps): void {
  const { db, auth, isTrustedRole, generateId, transition, notifyTransition,
          settleOrder, settleFault, detectFraud, createDispute, createDeclineContestDispute, checkTimeouts, recordViolationReputation,
          broadcastSystemEvent, consumeGateToken } = deps

  // PR-4e: direct_p2p 风险动作门 —— ① D1/D2 两次披露都 ack(缺则 DISCLOSURE_NOT_ACKED);② 现场真人 Passkey + 一次性
  //   WebAuthn gate token(purpose 固定 direct_pay_order_action,order+action 走 purpose_data + validate)。
  //   纯前置门:返回 ok 才允许后续写入。【先 disclosure(只读)再 Passkey(消费 token)】→ 缺 ack 不浪费 token。
  //   调用方必须在【任何写入前 + 只读状态预检之后】调用,避免错误状态消耗 token。
  function directPayActionGate(orderId: string, action: string, userId: string, webauthnToken: string | undefined):
    { ok: true } | { ok: false; status: number; error: string; error_code: string } {
    const disc = requireBothDisclosuresAcked(db, orderId)
    if (!disc.ok) return { ok: false, status: 409, error: disc.reason || '需先完成两次风险披露确认', error_code: disc.error_code || 'DISCLOSURE_NOT_ACKED' }
    const gate = requireDirectPayHumanPasskey({ db, consumeGateToken }, {
      userId, webauthnToken, purpose: 'direct_pay_order_action',
      validate: (data) => { const d = data as { order_id?: string; action?: string } | null; return !!d && d.order_id === orderId && d.action === action },
    })
    if (!gate.ok) return { ok: false, status: 403, error: gate.reason || '需现场真人 Passkey 确认', error_code: gate.error_code || 'HUMAN_PRESENCE_REQUIRED' }
    return { ok: true }
  }

  // RFC-007 stage 2：卖家主动拒单 reason_code 白名单。
  //   classification(客观无责 vs 主观有责)是 stage 3 auto-verify 的事;stage 2 仅捕获 + 一律走违约结算。
  //   objective-claimed(stage 3 将尝试确定性核验):stock_consumed_concurrent / stale_price_snapshot / force_majeure
  //   subjective(stage 3 直接判 fault):price_regret / cherry_pick / other
  const DECLINE_REASON_CODES = new Set([
    'stock_consumed_concurrent', 'stale_price_snapshot', 'force_majeure',
    'price_regret', 'cherry_pick', 'other',
  ])
  // 客观-声称理由:链下事实(外部已售/损毁),协议无确定性信号可自动核验 → 临时判责 + 举证窗口(stage 5 仲裁)。
  const OBJECTIVE_DECLINE_REASONS = new Set(['stock_consumed_concurrent', 'stale_price_snapshot', 'force_majeure'])

  // C-4: 卖家批量发货
  app.post('/api/orders/batch-ship', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { order_ids, logistics_company_id, tracking_numbers } = req.body || {}
    if (!Array.isArray(order_ids) || order_ids.length === 0) return void res.status(400).json({ error: 'order_ids 必填' })
    if (order_ids.length > 100) return void res.status(400).json({ error: '单次最多 100 单' })
    // 自发货(self-fulfill,Phase 1 默认):不传 logistics_company_id → logistics_id 留空,卖家自负后续流转。
    // 只有传了物流公司时才校验其存在。
    // RFC-016: 纯校验读 → 异步 seam(物流公司是否存在);循环内的逐单 read+write 仍同步(Phase 3 随订单事务迁)
    if (logistics_company_id) {
      const lc = await dbOne<{ id: string }>("SELECT id FROM users WHERE id = ? AND role = 'logistics'", [logistics_company_id])
      if (!lc) return void res.status(400).json({ error: '物流公司不存在' })
    }

    const results: Array<{ order_id: string; status: 'shipped' | 'skipped'; reason?: string }> = []
    const trackingMap = (tracking_numbers && typeof tracking_numbers === 'object') ? tracking_numbers as Record<string, string> : {}

    for (const oid of order_ids) {
      try {
        const o = db.prepare("SELECT id, seller_id, status, logistics_id FROM orders WHERE id = ?").get(oid) as { id: string; seller_id: string; status: string; logistics_id: string | null } | undefined
        if (!o) { results.push({ order_id: oid, status: 'skipped', reason: '订单不存在' }); continue }
        if (o.seller_id !== user.id) { results.push({ order_id: oid, status: 'skipped', reason: '非自家订单' }); continue }
        if (o.status !== 'accepted') { results.push({ order_id: oid, status: 'skipped', reason: `状态非 accepted (当前 ${o.status})` }); continue }

        // 仅当指定了物流公司时才绑定;自发货保持 logistics_id 为空(seller self-fulfill)
        if (logistics_company_id && !o.logistics_id) {
          db.prepare("UPDATE orders SET logistics_id = ? WHERE id = ?").run(logistics_company_id, oid)
        }
        const tn = trackingMap[oid] ? String(trackingMap[oid]).slice(0, 50) : null
        // accepted→shipped 状态机要求 evidence(requiresEvidence)。【始终】写一条文字 evidence,
        // 否则无单号(尤其自发货默认)会被状态机拒绝 → shipped:0 卡在 accepted。单号可之后补。
        const evDesc = logistics_company_id
          ? (tn ? `批量发货 · 快递单号：${tn} · 物流方 ${logistics_company_id}` : `批量发货，已交付物流公司 ${logistics_company_id}，快递单号待物流揽收后回传`)
          : (tn ? `卖家自己发货（批量）· 快递单号：${tn}` : `卖家自己发货（批量·自提自送）—— 由卖家负责揽收/运输/送达，单号可之后补`)
        const evIds: string[] = []
        const eid = generateId('evt')
        db.prepare(`INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
          VALUES (?,?,?,'description',?,?)`).run(eid, oid, user.id, evDesc, `hash_${Date.now()}`)
        evIds.push(eid)
        const result = transition(db, oid, 'shipped', user.id as string, evIds, evDesc)
        if (!result.success) { results.push({ order_id: oid, status: 'skipped', reason: result.error || '状态机拒绝' }); continue }
        notifyTransition(db, oid, 'accepted', 'shipped')
        results.push({ order_id: oid, status: 'shipped' })
      } catch (e) {
        results.push({ order_id: oid, status: 'skipped', reason: (e as Error).message })
      }
    }
    const shipped = results.filter(r => r.status === 'shipped').length
    res.json({ success: true, shipped, skipped: results.filter(r => r.status === 'skipped').length, results })
  })

  // 买家确认面交完成 → 直接 completed + settleOrder
  app.post('/api/orders/:id/confirm-in-person', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // RFC-016: 校验读 → 异步 seam;下方 completed+history 写仍是同步 db.transaction(Phase 3 迁 pg 事务)
    const order = await dbOne<Record<string, unknown>>('SELECT * FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在', error_code: 'ORDER_NOT_FOUND' })
    if (order.fulfillment_mode !== 'in_person') return void res.status(400).json({ error: '该订单非面交', error_code: 'NOT_IN_PERSON' })
    if (order.buyer_id !== user.id) return void res.status(403).json({ error: '仅买家可确认面交完成', error_code: 'NOT_ORDER_BUYER' })
    if (!['paid', 'accepted'].includes(order.status as string)) return void res.status(400).json({ error: `订单状态 ${order.status} 不可确认面交`, error_code: 'NOT_CONFIRMABLE_IN_PERSON' })
    if (order.has_pending_claim) return void res.status(400).json({ error: '存在进行中的验证任务，不可确认', error_code: 'HAS_PENDING_CLAIM' })
    // Rail1:平台费已切换为链下应收(accrue 在完成结算时,与 completed 同一原子边界,fail-closed)。
    //   建单不再锁 fee-stake,故【不再】前置要求 locked stake(AR 订单本就无 stake)。
    const isDirectP2p = order.payment_rail === 'direct_p2p'
    // PR-4e:direct_p2p 面交完成 = RISK 动作 → 两次披露门 + 现场真人 Passkey 门。
    if (isDirectP2p) {
      const g = directPayActionGate(req.params.id, 'confirm_in_person', user.id as string, req.body?.webauthn_token as string | undefined)
      if (!g.ok) return void res.status(g.status).json({ error: g.error, error_code: g.error_code })
    }
    const tx = db.transaction(() => {
      db.prepare(`UPDATE orders SET status='completed', updated_at=datetime('now') WHERE id = ?`).run(req.params.id)
      db.prepare(`INSERT INTO order_state_history (id, order_id, from_status, to_status, actor_id, actor_role, notes)
        VALUES (?,?,?,?,?,?, '面交完成 — 买家确认')`)
        .run(generateId('hst'), req.params.id, order.status, 'completed', user.id, (user as Record<string, unknown>).role || 'buyer')
      // direct_p2p:取平台费进同一事务 → 取费失败(缺 locked stake)回滚 completed,订单不会 terminal-completed 而费用落空。
      if (isDirectP2p) settleOrder(req.params.id)
    })
    try { tx() } catch (e) { return void res.status(isDirectP2p ? 409 : 500).json({ error: (isDirectP2p ? '直付完成结算失败,订单未完成：' : '状态写入失败：') + (e as Error).message, ...(isDirectP2p ? { error_code: 'DIRECT_PAY_SETTLE_FAILED' } : {}) }) }
    // escrow:沿用原有非原子结算(失败仅记日志,不回滚 completed —— 与既有行为一致,本次不改 escrow)。
    if (!isDirectP2p) { try { settleOrder(req.params.id) } catch (e) { console.error('[settleOrder in-person]', e) } }
    res.json({ success: true })
  })

  // 通用状态机 action — accept/ship/pickup/transit/deliver/confirm/dispute
  app.post('/api/orders/:id/action', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // P0 fix: 受信角色禁交易
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色不可参与订单流转', error_code: 'TRUSTED_ROLE_NO_TRADE' })

    const { action, evidence_description = '', logistics_company_id = '' } = req.body
    let notes = String(req.body?.notes ?? '').slice(0, 500)   // 服务端硬界:附言/备注最长 500 字符;mark_paid 时被服务端权威付款参考覆盖(见下)

    // RFC-016: 顶层校验读 → 异步 seam;state-machine / settle / decline 写序列仍同步(Phase 3 迁 pg 行锁+事务)
    const order = await dbOne<Record<string, unknown>>('SELECT * FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })

    // P0: 路由层 ownership 校验（engine 层只看 role，必须补 ownership）
    const buyerId = order.buyer_id as string
    const sellerId = order.seller_id as string
    const logisticsId = (order.logistics_id as string | null) || null
    const uid = user.id as string
    if ((action === 'accept' || action === 'ship') && uid !== sellerId) {
      return void res.status(403).json({ error: '你不是本订单的卖家', error_code: 'NOT_ORDER_SELLER' })
    }
    if (action === 'confirm' && uid !== buyerId) {
      return void res.status(403).json({ error: '你不是本订单的买家', error_code: 'NOT_ORDER_BUYER' })
    }
    // Rail1 直付:买家专属动作。mark_paid = 买家声明"我已付款"→ accepted(进卖家发货流程);
    //   cancel = 付款前买家取消 → cancelled(释放费用质押)。仅 buyer、仅 direct_p2p 且仍在付款窗口。
    if (action === 'mark_paid' || action === 'cancel') {
      if (uid !== buyerId) {
        return void res.status(403).json({ error: '你不是本订单的买家', error_code: 'NOT_ORDER_BUYER' })
      }
      // 买家取消:付款窗口内(未付/后悔)/ 货款协商阶段(承认未付)/ 付款窗过期宽限期(确认未付,免等 48h 自动关单 ——
      //   审计项 H:状态机本就允许 buyer direct_expired_unconfirmed→cancelled,此 guard 曾与状态机矛盾=死能力)。mark_paid 仍仅付款窗口。
      const cancelInQuery = action === 'cancel' && ['payment_query', 'direct_expired_unconfirmed'].includes(order.status as string)
      if (order.payment_rail !== 'direct_p2p' || (order.status !== 'direct_pay_window' && !cancelInQuery)) {
        return void res.status(409).json({ error: '该操作仅适用于直付订单的付款窗口/过期宽限/协商阶段', error_code: 'NOT_DIRECT_PAY_WINDOW' })
      }
    }
    // ── Rail1 直付货款协商(争议≠仲裁)动作。均仅 direct_p2p + 角色/状态门。PR-B1 人驱动协商 + PR-B2 卖家宽限后请求取消。 ──
    const PQ_ACTIONS = ['report_nonpayment', 'confirm_received', 'pq_escalate', 'pq_withdraw', 'request_cancel']
    if (PQ_ACTIONS.includes(action)) {
      if (order.payment_rail !== 'direct_p2p') return void res.status(409).json({ error: '该操作仅适用于直付订单', error_code: 'NOT_DIRECT_PAY' })
      if ((action === 'report_nonpayment' || action === 'confirm_received' || action === 'request_cancel') && uid !== sellerId) return void res.status(403).json({ error: '你不是本订单的卖家', error_code: 'NOT_ORDER_SELLER' })
      if ((action === 'pq_escalate' || action === 'pq_withdraw') && uid !== buyerId && uid !== sellerId) return void res.status(403).json({ error: '只有买卖双方可操作', error_code: 'NOT_ORDER_PARTY' })
      if (action === 'report_nonpayment' && order.status !== 'accepted') return void res.status(409).json({ error: `仅可在【待发货(accepted)】阶段报告未收款,当前 ${order.status}`, error_code: 'NOT_ACCEPTED' })
      if ((action === 'confirm_received' || action === 'pq_escalate' || action === 'request_cancel') && order.status !== 'payment_query') return void res.status(409).json({ error: `仅可在【货款协商(payment_query)】阶段操作,当前 ${order.status}`, error_code: 'NOT_PAYMENT_QUERY' })
      if (action === 'pq_withdraw') {
        if (order.status !== 'disputed') return void res.status(409).json({ error: `仅可在【争议(disputed)】阶段撤回,当前 ${order.status}`, error_code: 'NOT_DISPUTED' })
        // 已裁定的争议不可撤回(disputed 已终结成 resolved/dismissed 前,dispute.status 仍 open/in_review)
        const d = await dbOne<{ status: string }>("SELECT status FROM disputes WHERE order_id = ? ORDER BY created_at DESC LIMIT 1", [req.params.id])
        if (d && (d.status === 'resolved' || d.status === 'dismissed')) return void res.status(409).json({ error: '争议已裁定,不可撤回', error_code: 'DISPUTE_ALREADY_RULED' })
        // ★ 撤回【仅限货款协商升级】的仲裁:最近一次进入 disputed 必须 from payment_query。
        //   否则履约类争议(delivered→disputed 货损/货不对版)会被错误撤回、dismiss、状态倒退回 payment_query。fail-closed。
        const lastDisputed = await dbOne<{ from_status: string }>("SELECT from_status FROM order_state_history WHERE order_id = ? AND to_status = 'disputed' ORDER BY created_at DESC, rowid DESC LIMIT 1", [req.params.id])
        if (!lastDisputed || lastDisputed.from_status !== 'payment_query') return void res.status(409).json({ error: '仅可撤回由货款协商升级的仲裁;履约类争议(货损/货不对版)须经仲裁裁定', error_code: 'NOT_PAYMENT_QUERY_DISPUTE' })
      }
    }
    // PR-B2:卖家在【买家响应宽限已过】后请求取消 —— 不立即关单,而是开【N 天买家申诉窗】(payment_query_cancel_deadline)。
    //   窗内买家仍可 confirm-side/主张已付/升级举证(pq_escalate);窗满由 cron 关单。不动状态,不涉资金。幂等(deadline 已设则不重置)。
    if (action === 'request_cancel') {
      const g = await dbOne<{ over: number }>("SELECT (payment_query_deadline IS NOT NULL AND datetime(payment_query_deadline) < datetime('now')) AS over FROM orders WHERE id = ?", [req.params.id])
      if (!g?.over) return void res.status(409).json({ error: '买家响应宽限未到,暂不可请求取消', error_code: 'GRACE_NOT_ELAPSED' })
      let rd = 7; try { const p = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'direct_pay.payment_query_recourse_days'"); if (p) rd = Math.max(1, Number(p.value) || 7) } catch {}
      await dbRun(`UPDATE orders SET payment_query_cancel_deadline = datetime('now', ? ) WHERE id = ? AND payment_query_cancel_deadline IS NULL`, [`+${rd} days`, req.params.id])
      const dl = (await dbOne<{ d: string }>("SELECT payment_query_cancel_deadline d FROM orders WHERE id = ?", [req.params.id]))?.d
      try { createNotification(db, order.buyer_id as string, req.params.id, 'payment_query_cancel_requested', '⏳ 卖家申请取消订单', `卖家称未收到货款且你未回应,已申请取消。你约有 ${rd} 天:若确已付款请提供付款参考或发起举证(pq_escalate),否则订单将于 ${dl} 自动取消。直付非托管,无平台退款。`) } catch {}
      return void res.json({ success: true, status: 'payment_query', cancel_recourse_deadline: dl })
    }
    // PR-4e:mark_paid = direct_p2p RISK 动作(已过 direct_pay_window 只读预检)→ 两次披露门 + 现场真人 Passkey 门。cancel 不门控。
    if (action === 'mark_paid') {
      const g = directPayActionGate(req.params.id, 'mark_paid', uid, req.body?.webauthn_token as string | undefined)
      if (!g.ok) return void res.status(g.status).json({ error: g.error, error_code: g.error_code })
      // 防作弊 D1:付款参考【服务端权威派生】(与前端 dpPayRef 同算法),忽略客户端可伪造的参考文本 —— UI 已锁只读(#222),
      //   这里把 API 级也收口:直接 POST 伪造 notes 冒充别单参考号 → 无效。客户端附言仅作补充备注,剥掉任何"付款参考"字样。
      const canonicalRef = 'WAZ-' + req.params.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase()
      const extra = notes.replace(/付款参考[::]?\s*[^\s·;,。]*/g, '').replace(/WAZ-[A-Z0-9]{8}/g, '').trim().slice(0, 120)
      // 防作弊 D2:同买家·同卖家·同金额的其它在途直付单 → 时间线预警(一笔真实转账冒充两单的重复确认,卖家第一道防线)
      const dup = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND seller_id = ? AND payment_rail = 'direct_p2p' AND total_amount = ? AND id != ? AND status IN ('accepted','shipped','picked_up','in_transit','delivered')`, [buyerId, sellerId, order.total_amount, req.params.id])
      // 审计项 E:时间线带上应付金额(下单冻结的参考换算)—— 卖家对账三要素:参考号 + 金额 + 币种,与买家所见同一数字
      let payable = `应付 ${order.total_amount} USDC`
      try { const ps = JSON.parse((order.direct_pay_account_snapshot as string) || '{}'); if (Number.isFinite(Number(ps?.payable_approx)) && ps?.payable_currency) payable += `（≈${ps.payable_currency} ${Number(ps.payable_approx).toFixed(2)},下单时参考价）` } catch { /* 快照缺失/坏 → 仅 USDC */ }
      notes = `付款参考: ${canonicalRef} · ${payable}${extra ? ' · ' + extra : ''}${(dup?.n || 0) > 0 ? ` ⚠️ 同买家另有 ${dup!.n} 笔同金额直付订单在途,请逐单核对付款参考再发货` : ''}`
    }
    // Rail1:平台费链下应收,accrue 在完成结算时(settleOrder direct_p2p 分支)与 completed 同一原子边界、fail-closed
    //   (accrueFeeReceivable 缺费即抛 → 回滚 completed)。故【不再】前置要求 locked fee-stake。
    // PR-4e:direct_p2p confirm = RISK 动作。先【只读状态预检】(仅 delivered 可确认收货,杜绝错误状态消耗 token),再两次披露门 + 现场真人 Passkey 门。
    if (action === 'confirm' && order.payment_rail === 'direct_p2p') {
      if (order.status !== 'delivered') return void res.status(409).json({ error: `订单状态 ${order.status} 不可确认收货(仅 delivered)`, error_code: 'ORDER_NOT_DELIVERED' })
      const g = directPayActionGate(req.params.id, 'confirm', uid, req.body?.webauthn_token as string | undefined)
      if (!g.ok) return void res.status(g.status).json({ error: g.error, error_code: g.error_code })
    }
    if (action === 'pickup' || action === 'transit' || action === 'deliver') {
      // pickup 时若订单尚无物流，允许领取（孤儿单兜底）
      const isOrphanPickup = action === 'pickup' && !logisticsId
      // Self-fulfill 兜底:logistics_id 为 null 时 seller 可驱动后续 transit/deliver
      // 与 state machine VALID_TRANSITIONS allowedRoles=['seller','logistics'] 对齐
      // (Phase 1: Logistics 市场尚未启用,seller 自履行是默认路径)
      const isSelfFulfillTransition = !logisticsId && uid === sellerId
      if (!isOrphanPickup && !isSelfFulfillTransition && uid !== logisticsId) {
        return void res.status(403).json({ error: '你不是本订单的物流方', error_code: 'NOT_ORDER_LOGISTICS' })
      }
    }
    if (action === 'dispute' && uid !== buyerId && uid !== sellerId && uid !== logisticsId) {
      return void res.status(403).json({ error: '只有交易参与方可发起争议', error_code: 'NOT_ORDER_PARTY' })
    }

    // 卖家发货时绑定物流公司
    if (action === 'ship' && logistics_company_id) {
      const logi = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'logistics'`).get(logistics_company_id)
      if (!logi) return void res.json({ error: '所选物流公司不存在' })
      db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(logistics_company_id, req.params.id)
    }

    // 物流自行揽收（卖家未指定物流时的兜底）
    if (action === 'pickup' && !order.logistics_id && (user as Record<string, unknown>).role === 'logistics') {
      db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(user.id, req.params.id)
    }

    // ── RFC-007 stage 2/3：卖家【主动拒单】decline ───────────────────────────────
    //   仅卖家、仅 paid(待接单) 状态可拒;记 reason_code + declined_at。
    //   stage 3 按理由分流:
    //     · 主观理由(price_regret/cherry_pick/other)→ 立即违约结算(paid→fault_seller→completed)。
    //     · 客观-声称理由(并发耗尽/陈旧快照/不可抗力)→ 【临时判责】:转 fault_seller 但【不结算】,
    //       置 decline_objective_pending=1 + 举证窗口 deadline。窗口内卖家可开仲裁(stage 5)举证翻案;
    //       到期无人仲裁 → checkTimeouts 自动终结为违约。客观场景本质是链下事实(外部已售/损毁),
    //       协议无确定性信号可自动核验,必须人工仲裁 —— 故不自动免责,只给举证窗口。
    if (action === 'decline') {
      if (uid !== sellerId) return void res.status(403).json({ error: '你不是本订单的卖家', error_code: 'NOT_ORDER_SELLER' })
      if (order.status !== 'paid') return void res.status(400).json({ error: `仅可在「待接单(paid)」状态拒单,当前 ${order.status}`, error_code: 'DECLINE_WRONG_STATUS' })
      const reasonCode = String((req.body?.decline_reason_code ?? '') || '').trim()
      if (!DECLINE_REASON_CODES.has(reasonCode)) {
        return void res.status(400).json({ error: `decline_reason_code 无效,需为: ${[...DECLINE_REASON_CODES].join(' / ')}`, error_code: 'DECLINE_REASON_INVALID' })
      }
      const isObjectiveClaim = OBJECTIVE_DECLINE_REASONS.has(reasonCode)
      // 客观-声称 + 举证窗口 > 0 → 临时判责(不结算);否则(主观 或 窗口=0)→ 立即违约结算
      const windowHours = Number((db.prepare("SELECT value FROM protocol_params WHERE key = 'decline_contest_window_hours'").get() as { value: string } | undefined)?.value ?? 24)
      const provisional = isObjectiveClaim && windowHours > 0

      db.prepare("UPDATE orders SET decline_reason_code = ?, declined_at = datetime('now') WHERE id = ?").run(reasonCode, req.params.id)
      const r1 = transition(db, req.params.id, 'fault_seller', uid, [], `卖家主动拒单 reason=${reasonCode}${provisional ? '(临时判责·待举证)' : ''}${notes ? '：' + notes : ''}`)
      if (!r1.success) {
        db.prepare("UPDATE orders SET decline_reason_code = NULL, declined_at = NULL WHERE id = ?").run(req.params.id)
        return void res.json({ error: r1.error })
      }
      notifyTransition(db, req.params.id, 'paid', 'fault_seller')

      if (provisional) {
        // 临时判责:置 pending + deadline,【不结算】(escrow/stake 暂挂,随终结或翻案一次性结算)
        db.prepare(`UPDATE orders SET decline_objective_pending = 1, decline_contest_deadline = datetime('now', '+' || ? || ' hours') WHERE id = ?`).run(windowHours, req.params.id)
        const deadline = (db.prepare("SELECT decline_contest_deadline AS d FROM orders WHERE id = ?").get(req.params.id) as { d: string }).d
        return void res.json({
          success: true, outcome: 'fault_seller_provisional', decline_reason_code: reasonCode, contest_deadline: deadline,
          note: `客观无责拒单为【临时判责】:你声称的客观理由(外部已售/损毁等)是链下事实,协议无法自动核验,需人工仲裁。请在 ${deadline} 前用 webaz_dispute 开仲裁举证;维持则免责全退,逾期未仲裁则自动终结为违约。买家退款随终结/翻案一次性处理。`,
        })
      }

      // 主观(或窗口=0):立即违约结算(退款买家 + 按 stake_backing 罚没,守恒,绝不印钱)
      // Codex #119 P1:这是资金结算路径,settleFault / completed transition 失败【绝不能】吞掉后仍报 success。
      // 订单此刻已在 fault_seller(上面 transition 已提交)。只有结算 + 推进 completed 都成功才返回 success;
      // 任一失败 → 返回 500 DECLINE_SETTLEMENT_FAILED(订单停在 fault_seller,可重试/人工/cron 终结),不谎称已退款。
      const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
      try {
        if (!sysUser) throw new Error('sys_protocol user missing — cannot finalize decline settlement')
        settleFault(db, req.params.id, 'fault_seller')
        const rc = transition(db, req.params.id, 'completed', sysUser.id, [], '主动拒单：系统执行违约结算')
        if (!rc?.success) throw new Error(`fault_seller→completed transition failed: ${rc?.error || 'unknown'}`)
        notifyTransition(db, req.params.id, 'fault_seller', 'completed')
      } catch (e) {
        console.error('[decline settleFault]', e)
        return void res.status(500).json({
          error: '违约结算未完成,订单仍停在 fault_seller,请稍后重试或联系支持(买家尚未退款)',
          error_code: 'DECLINE_SETTLEMENT_FAILED',
          outcome: 'fault_seller',
        })
      }
      return void res.json({
        success: true, outcome: 'fault_seller', decline_reason_code: reasonCode,
        note: '主观理由拒单 → 立即违约结算,买家已全额退款。',
      })
    }

    // ── RFC-007 stage 5：卖家就【临时判责】发起仲裁举证 ───────────────────────────
    //   仅卖家、仅 provisional(fault_seller + decline_objective_pending=1 未结算未过期)。置 decline_contested=1
    //   → checkTimeouts 暂停自动终结,等人工仲裁裁决(维持→declined_nofault 免责 / 驳回→违约)。
    if (action === 'contest_decline') {
      if (uid !== sellerId) return void res.status(403).json({ error: '你不是本订单的卖家', error_code: 'NOT_ORDER_SELLER' })
      if (order.status !== 'fault_seller' || Number(order.decline_objective_pending) !== 1 || order.settled_fault_at) {
        return void res.status(400).json({ error: '本订单不是可举证的【临时判责】状态', error_code: 'NOT_PROVISIONAL_DECLINE' })
      }
      if (Number(order.decline_contested) === 1) return void res.status(400).json({ error: '已在仲裁中,无需重复发起', error_code: 'ALREADY_CONTESTED' })
      const overdue = (db.prepare("SELECT datetime(decline_contest_deadline) < datetime('now') AS od FROM orders WHERE id = ?").get(req.params.id) as { od: number }).od
      if (overdue) return void res.status(400).json({ error: '举证窗口已过期,临时判责已可被终结', error_code: 'CONTEST_WINDOW_CLOSED' })
      const evIds: string[] = []
      if (evidence_description) {
        const eid = generateId('evt')
        const evReasons = detectFraud(String(evidence_description))
        db.prepare(`INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash, flag_reasons) VALUES (?,?,?,'description',?,?,?)`)
          .run(eid, req.params.id, uid, evidence_description, `hash_${Date.now()}`, evReasons.length ? JSON.stringify(evReasons) : null)
        evIds.push(eid)
      }
      db.prepare("UPDATE orders SET decline_contested = 1 WHERE id = ?").run(req.params.id)
      // 统一仲裁台:并入 disputes(不改 order.status)。幂等——重复举证不会建第二条。失败不阻断举证本身
      //   (标志位已置;backfill 脚本可事后补建),但记录以便排查。
      const dc = createDeclineContestDispute(db, req.params.id)
      if (!dc.success) console.error(`[contest_decline] createDeclineContestDispute failed for ${req.params.id}: ${dc.error}`)
      // PR2:通知全体 active 仲裁员 + admin 有新案(去重,只对新建行发;既有行不重复轰炸)。
      else if (!dc.existing && dc.disputeId) { try { notifyDeclineContestCase(db, req.params.id, dc.disputeId) } catch (e) { console.error(`[contest_decline] notify failed: ${(e as Error).message}`) } }
      return void res.json({
        success: true, outcome: 'contested', evidence_ids: evIds, dispute_id: dc.disputeId,
        note: '已就客观无责拒单发起人工仲裁举证。自动终结已暂停,等待仲裁员裁决:维持→免责全退+退质押,驳回→违约结算。',
      })
    }

    // Rail1 直付:付款窗口内买家取消 → cancelled + 释放费用质押(单事务:转移成功必同步放质押,
    //   杜绝"已取消但质押漏放"泄漏 —— cancelled 单超时 cron 不再扫,放质押无后备路径,故必须原子)。
    if (action === 'cancel') {
      const fromStatusCancel = order.status as string
      try {
        db.transaction(() => {
          const r = transition(db, req.params.id, 'cancelled', uid, [], notes)
          if (!r.success) throw new Error(r.error || '状态转移失败')
          releaseFeeStake(db, { orderId: req.params.id })
          // D3 库存回补:经唯一守卫入口(仅 pre-ship 来源放行;已出库走退货验收,绝不直接回补 —— 见 direct-pay-stock.ts 情形矩阵)
          restorePreShipDirectPayStock(db, { fromStatus: fromStatusCancel, productId: order.product_id as string, quantity: Number(order.quantity) || 1 })
        })()
      } catch (e) {
        return void res.status(409).json({ error: (e as Error).message, error_code: 'CANCEL_FAILED' })
      }
      notifyTransition(db, req.params.id, fromStatusCancel, 'cancelled')
      return void res.json({ success: true, status: 'cancelled', fee_stake_released: true })
    }

    // 争议协商收口(买家侧):买家撤诉并确认收货 —— 限【delivered 来源履约争议 + 争议发起人本人 + 裁定前】。
    //   为什么存在:买家发起"未收到货"争议后包裹晚到/找到代收点,双方合意收口不该只剩仲裁(卖家侧收口=协商取消)。
    //   货款争议(payment_query 来源)不走这里 —— 那是 pq_withdraw 的撤回语义(回协商,不确认收货)。
    //   全原子(Codex P1 模式):争议 dismissed + disputed→confirmed→completed + settleOrder 同一 db.transaction,
    //   任一步失败整体回滚(订单仍 disputed、争议仍 open,可重试);两轨同块(escrow 释放托管货款,dp 计提平台费)。
    if (action === 'dispute_withdraw_confirm') {
      if (uid !== buyerId) return void res.status(403).json({ error: '你不是本订单的买家', error_code: 'NOT_ORDER_BUYER' })
      if (order.status !== 'disputed') return void res.status(409).json({ error: `订单状态 ${order.status} 不可撤诉确认收货(仅争议中)`, error_code: 'ORDER_NOT_DISPUTED' })
      // RFC-016:两条纯预检读 → 异步 seam;事务内的 disputes UPDATE + transition + settle 写序列仍同步(原子性)
      const dsp = await dbOne<{ id: string; initiator_id: string }>("SELECT id, initiator_id FROM disputes WHERE order_id = ? AND status IN ('open','in_review') ORDER BY created_at DESC, rowid DESC LIMIT 1", [req.params.id])
      if (!dsp) return void res.status(409).json({ error: '争议已裁定或不存在,不可撤诉', error_code: 'DISPUTE_ALREADY_RULED' })
      if (dsp.initiator_id !== uid) return void res.status(403).json({ error: '仅争议发起人可撤诉', error_code: 'NOT_DISPUTE_INITIATOR' })
      const lastDisputedFrom = await dbOne<{ from_status: string }>("SELECT from_status FROM order_state_history WHERE order_id = ? AND to_status = 'disputed' ORDER BY created_at DESC, rowid DESC LIMIT 1", [req.params.id])
      if (lastDisputedFrom?.from_status !== 'delivered') {
        return void res.status(409).json({ error: '仅"已投递后未收到货/货有问题"类争议可撤诉确认收货;货款争议请用"撤回仲裁·回到协商"', error_code: 'NOT_FULFILMENT_DISPUTE' })
      }
      // dp = RISK 动作(确认收货即完成结算、计提平台费):所有只读预检过后才消费 Passkey token(与 confirm 同门)
      if (order.payment_rail === 'direct_p2p') {
        const g = directPayActionGate(req.params.id, 'dispute_withdraw_confirm', uid, req.body?.webauthn_token as string | undefined)
        if (!g.ok) return void res.status(g.status).json({ error: g.error, error_code: g.error_code })
      }
      try {
        db.transaction(() => {
          db.prepare("UPDATE disputes SET status = 'dismissed', verdict_reason = ?, resolved_at = datetime('now') WHERE id = ? AND status IN ('open','in_review')")
            .run(notes ? `买家撤诉并确认收货:${notes}` : '买家撤诉并确认收货', dsp.id)
          const r1 = transition(db, req.params.id, 'confirmed', uid, [], notes)
          if (!r1.success) throw new Error(r1.error || 'confirmed transition failed')
          const r2 = transition(db, req.params.id, 'completed', 'sys_protocol', [], '系统自动结算')
          if (!r2.success) throw new Error(r2.error || 'completed transition failed')
          settleOrder(req.params.id)
        })()
      } catch (e) {
        return void res.status(409).json({ error: `撤诉确认收货失败,订单未变更(仍在争议中,可重试):${(e as Error).message}`, error_code: 'DISPUTE_CLOSE_SETTLE_FAILED' })
      }
      notifyTransition(db, req.params.id, 'confirmed', 'completed')
      try { createNotification(db, sellerId as string, req.params.id, 'dispute_withdrawn_confirmed', '✅ 买家已撤诉并确认收货', '买家撤回争议并确认收货,订单已完成结算,双方信誉不受影响。', { templateKey: 'dispute_withdrawn_confirmed', params: {} }) } catch { /* 通知失败不阻断 */ }
      try { broadcastSystemEvent('order_completed', '✓', `订单完成 ${req.params.id}`, req.params.id) } catch {}
      return void res.json({ success: true, status: 'completed', dispute_dismissed: true })
    }

    // RFC-021 PR3:accept/ship 经【共享执行器】(与 Passkey-approve 路径同一真相源;守卫全内置)。
    //   api_key 路径 = seller 本人直发 → strictTracking=false(保持现状:无单号/占位单号发货不破坏;tracking 仍为 hint)。
    //   evidence_description 现状语义保留(缺则执行器内 transition 因证据空而拒);logistics 绑定已在上方完成。
    if (action === 'accept' || action === 'ship') {
      const exec = executeSellerOrderAction(db, { orderId: req.params.id, action, actorId: user.id as string, nowIso: new Date().toISOString(), strictTracking: false, tracking: (req.body?.tracking as string | undefined), evidenceDescription: evidence_description as string | undefined, generateId, path: 'api_key' })
      if (!exec.ok) return void res.status(exec.http || 409).json({ error: exec.error, error_code: exec.error_code })
      try { notifyTransition(db, req.params.id, exec.fromStatus as string, exec.toStatus as string) } catch (e) { console.warn('[order-action notify]', (e as Error).message) }
      return void res.json({ success: true, status: exec.toStatus })
    }

    const actionMap: Record<string, string> = {
      accept: 'accepted', ship: 'shipped', pickup: 'picked_up',
      transit: 'in_transit', deliver: 'delivered', confirm: 'confirmed', dispute: 'disputed',
      mark_paid: 'accepted',   // Rail1 直付:买家声明"我已付款" → accepted(汇入既有卖家发货流程;协议不验真实付款)
      // Rail1 货款协商:卖家报未收款→协商;卖家确认已收→恢复;升级→举证仲裁;撤回→回协商(pq_withdraw 由上方原子块 early-return 处理,列此仅为通过 !toStatus 校验)。
      report_nonpayment: 'payment_query', confirm_received: 'accepted', pq_escalate: 'disputed', pq_withdraw: 'payment_query',
      mark_undeliverable: 'delivery_failed',   // PR-B:卖家/物流举证未派送成功(退回/拒收)→ 证据裁决
    }
    const toStatus = actionMap[action]
    if (!toStatus) return void res.json({ error: `未知操作：${action}` })

    // PR-B:mark_undeliverable 门控 —— rollout flag + rail(B2 仅 direct_p2p;escrow 资金收口由 B3 接,先拒不误结算)。
    //   fail fast:在写 evidence / transition 前拦下。证据要求由 delivery_failed 转移规则(requiresEvidence)强制。
    if (action === 'mark_undeliverable') {
      let enabled = 0; try { const p = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'undeliverable_closure_enabled'"); enabled = Number(p?.value) || 0 } catch {}
      if (enabled !== 1) return void res.status(403).json({ error: 'undeliverable 收口未启用', error_code: 'UNDELIVERABLE_DISABLED' })
      if (order.payment_rail !== 'direct_p2p') return void res.status(409).json({ error: 'escrow 轨 undeliverable 收口尚未上线(B3)', error_code: 'UNDELIVERABLE_ESCROW_PENDING' })
    }

    // 创建证据记录 + 跨窗反诈：description 跑 detectFraud
    const evidenceIds: string[] = []
    if (evidence_description) {
      const eid = generateId('evt')
      const evReasons = detectFraud(String(evidence_description))
      db.prepare(`INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash, flag_reasons)
        VALUES (?,?,?,'description',?,?,?)`).run(eid, req.params.id, user.id, evidence_description, `hash_${Date.now()}`,
          evReasons.length ? JSON.stringify(evReasons) : null)
      evidenceIds.push(eid)
    }

    // PR-B:mark_undeliverable 原子块(镜像 confirm/pq_withdraw)—— transition→delivery_failed + 置争议窗口截止
    //   包进【同一 db.transaction】。否则 transition 先提交、随后 deadline UPDATE 失败(crash/BUSY)→ 卡在
    //   delivery_failed 且 delivery_failed_deadline=NULL(checkTimeouts 因 deadline 空不触发 → 无法自动落定,liveness 死角)。
    if (action === 'mark_undeliverable') {
      let ch = 120; try { const p = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'undeliverable_contest_window_hours'"); if (p) ch = Math.max(1, Number(p.value) || 120) } catch {}
      const dfIso = new Date(Date.now() + ch * 3600 * 1000).toISOString()   // ISO(#299),X 默认 120h
      try {
        db.transaction(() => {
          const r = transition(db, req.params.id, 'delivery_failed', user.id as string, evidenceIds, notes)   // requiresEvidence 由转移规则强制
          if (!r.success) throw new Error(r.error || 'delivery_failed transition failed')
          db.prepare("UPDATE orders SET delivery_failed_deadline = ? WHERE id = ? AND delivery_failed_deadline IS NULL").run(dfIso, req.params.id)   // I3:IS NULL 不重写
        })()
      } catch (e) {
        return void res.status(409).json({ error: `未派送成功登记失败(仍停在 ${order.status},可重试):${(e as Error).message}`, error_code: 'UNDELIVERABLE_MARK_FAILED' })
      }
      notifyTransition(db, req.params.id, order.status as string, 'delivery_failed')
      return void res.json({ success: true, status: 'delivery_failed', contest_deadline: dfIso })
    }

    // Rail1 全原子(Codex P1):direct_p2p confirm 必须把 delivered→confirmed→completed→settle/accrue 包进【同一 db.transaction】。
    //   否则 delivered→confirmed 先单独提交、随后 accrue 失败 → 订单卡在 confirmed(retry 被 ORDER_NOT_DELIVERED 拒)。
    //   任一步失败 → 整体回滚到 delivered(可重试);成功后再发通知。confirm-in-person 是另一端点、已单事务原子。
    if (action === 'confirm' && order.payment_rail === 'direct_p2p') {
      try {
        db.transaction(() => {
          const r1 = transition(db, req.params.id, 'confirmed', user.id as string, evidenceIds, notes)
          if (!r1.success) throw new Error(r1.error || 'confirmed transition failed')
          const r2 = transition(db, req.params.id, 'completed', 'sys_protocol', [], '系统自动结算')
          if (!r2.success) throw new Error(r2.error || 'completed transition failed')
          settleOrder(req.params.id)   // direct_p2p 分支:释放遗留模拟 stake + accrueFeeReceivable(fail-closed)
        })()
      } catch (e) {
        return void res.status(409).json({ error: `直付完成结算失败,订单未完成(仍停在 delivered,可重试):${(e as Error).message}`, error_code: 'DIRECT_PAY_SETTLE_FAILED' })
      }
      notifyTransition(db, req.params.id, 'delivered', 'confirmed')
      notifyTransition(db, req.params.id, 'confirmed', 'completed')
      try { broadcastSystemEvent('order_completed', '✓', `订单完成 ${req.params.id}`, req.params.id) } catch {}
      return void res.json({ success: true, status: 'completed', settlement: { rail: 'direct_p2p', fee_accrued: true } })
    }

    // Rail1 撤回仲裁:disputed→payment_query + 【同一事务】关闭活跃 dispute(否则订单回协商但仲裁视图仍见活跃争议 → 脏状态,
    //   仲裁员可能对已回协商的单裁定)。原子后重建买家响应宽限,让 PR-B2 的宽限/超时 cron 有截止时间可依赖。
    if (action === 'pq_withdraw') {
      try {
        db.transaction(() => {
          const r = transition(db, req.params.id, 'payment_query', user.id as string, [], notes)
          if (!r.success) throw new Error(r.error || 'withdraw transition failed')
          db.prepare("UPDATE disputes SET status = 'dismissed', verdict_reason = COALESCE(verdict_reason, '撤回仲裁,回到协商'), resolved_at = datetime('now') WHERE order_id = ? AND status IN ('open', 'in_review')").run(req.params.id)
        })()
      } catch (e) { return void res.status(409).json({ error: `撤回仲裁失败:${(e as Error).message}`, error_code: 'WITHDRAW_FAILED' }) }
      let gh = 72; try { const p = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'direct_pay.payment_query_grace_hours'"); if (p) gh = Math.max(1, Number(p.value) || 72) } catch {}
      await dbRun(`UPDATE orders SET payment_query_deadline = datetime('now', ? ), payment_query_cancel_deadline = NULL WHERE id = ?`, [`+${gh} hours`, req.params.id])
      notifyTransition(db, req.params.id, 'disputed', 'payment_query')
      return void res.json({ success: true, status: 'payment_query', dispute_withdrawn: true })
    }

    const fromStatus = order.status as string
    const result = transition(db, req.params.id, toStatus, user.id as string, evidenceIds, notes)
    if (!result.success) return void res.json({ error: result.error })

    // P1-c(b):direct_p2p 首次进 accepted(mark_paid / confirm_received)才生成 ship_deadline —— direct-pay-create 建单不设该列,
    //   缺 ship_deadline 会被共享执行器 SLA【fail-closed】卡住发货。WHERE ship_deadline IS NULL 兜死:仅 null→值 那一次写,
    //   绝不覆盖已有值(守 I3:deadline 绝对列不重写)。判责钟从付款确认(now)起。
    if (toStatus === 'accepted' && order.payment_rail === 'direct_p2p') {
      let sh = 72; try { const p = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'direct_pay.ship_window_hours'"); if (p) sh = Math.max(1, Number(p.value) || 72) } catch { /* 用默认 72h */ }
      await dbRun("UPDATE orders SET ship_deadline = datetime('now', ?) WHERE id = ? AND ship_deadline IS NULL", [`+${sh} hours`, req.params.id])
    }

    // P1:direct_p2p 进 delivered 时生成 confirm_deadline(投递后 72h)—— direct-pay 建单不设该列,缺它则
    //   checkTimeouts 永不自动确认 → 卡死 delivered、平台费不入账。WHERE confirm_deadline IS NULL 守 I3(deadline
    //   绝对列不重写)。escrow 该列建单时已按 +408h 预置(orders-create),不走本路径。判责钟从投递(now)起。
    if (toStatus === 'delivered' && order.payment_rail === 'direct_p2p') {
      // ISO 存储(非 datetime('now',...) 的空格格式):checkTimeouts.findActiveDeadlineTransition 用 JS 字符串比较
      //   `now(ISO) > deadline`,now=new Date().toISOString() 带 'T'。空格格式 deadline 在同一日历日会因 'T'(0x54)>' '(0x20)
      //   被误判为已过 → 提前最多 ~24h 自动确认。escrow 各 deadline 走 addHours→ISO 无此问题,故此处对齐 ISO。
      const confirmDeadlineIso = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
      await dbRun("UPDATE orders SET confirm_deadline = ? WHERE id = ? AND confirm_deadline IS NULL", [confirmDeadlineIso, req.params.id])
    }

    notifyTransition(db, req.params.id, fromStatus, toStatus)

    // 审计项 B(N2):买家标记付款 → 通知卖家核款发货(direct_pay_window→accepted 不在 notifyTransition RULES,
    //   此前卖家全程收不到"已付款"信号只能手动刷)。notes 即 D1/D2/E 的权威对账串(参考号+应付+多单预警),直接复用。
    if (action === 'mark_paid') {
      try { createNotification(db, sellerId as string, req.params.id, 'direct_pay_marked_paid', '💰 买家已标记付款,请核对后发货', `${notes}。请核对银行/收款App流水后再发货;未收到请点"未收到货款"。`, { templateKey: 'dp_marked_paid', params: { detail: notes } }) } catch { /* 通知失败不阻断 */ }
    }

    // Rail1 货款协商:卖家报未收款 → 设买家响应宽限(PR-B2 卖家据此才可请求取消);确认已收/升级 → 清协商截止。
    if (action === 'report_nonpayment') {
      let gh = 72; try { const p = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'direct_pay.payment_query_grace_hours'"); if (p) gh = Math.max(1, Number(p.value) || 72) } catch {}
      await dbRun(`UPDATE orders SET payment_query_deadline = datetime('now', ? ) WHERE id = ?`, [`+${gh} hours`, req.params.id])
    }
    if (action === 'confirm_received' || action === 'pq_escalate') {
      await dbRun(`UPDATE orders SET payment_query_deadline = NULL, payment_query_cancel_deadline = NULL WHERE id = ?`, [req.params.id])
    }

    if (toStatus === 'disputed') {
      createDispute(db, req.params.id, user.id as string, notes || evidence_description || '买家发起争议', evidenceIds)
      try { broadcastSystemEvent('dispute_open', '⚖', `争议发起 (订单 ${req.params.id})`, req.params.id) } catch {}
    }
    if (toStatus === 'completed') {
      try { broadcastSystemEvent('order_completed', '✓', `订单完成 ${req.params.id}`, req.params.id) } catch {}
    }

    // 确认收货时自动结算
    let settlementBreakdown: Record<string, unknown> | null = null
    if (toStatus === 'confirmed') {
      const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
      // direct_p2p confirm 已在上方【全原子早返回块】处理(delivered→confirmed→completed→settle 同一 tx);此处仅 escrow。
      transition(db, req.params.id, 'completed', sysUser.id, [], '系统自动结算')
      notifyTransition(db, req.params.id, 'confirmed', 'completed')
      settleOrder(req.params.id)
      // QA 轮 9.4-retry-v3 P1：post-hoc build breakdown 从 DB，让 agent 看清每分钱去哪
      try {
        const round2 = (n: number) => Math.round(n * 100) / 100
        // RFC-016: settleOrder 已完成,以下纯只读 breakdown 查询 → 异步 seam(无写,无原子性要求)
        const ord = await dbOne<Record<string, unknown>>("SELECT id, total_amount, source, fulfillment_mode, snapshot_commission_rate, l1_uid, l2_uid, l3_uid, logistics_id, seller_id FROM orders WHERE id = ?", [req.params.id])
        if (ord) {
          const total = Number(ord.total_amount)
          const isSecondhand = ord.source === 'secondhand'
          const isInPerson = ord.fulfillment_mode === 'in_person'
          const feeRate = isSecondhand ? 0.01 : 0.02
          const protocolFee = round2(total * feeRate)
          const logisticsFee = isInPerson ? 0 : round2(total * 0.05)
          const logisticsActual = ord.logistics_id ? logisticsFee : 0
          const commissionRate = Number(ord.snapshot_commission_rate ?? 0.10)
          const commissionPool = round2(total * commissionRate)
          const commRecs = await dbAll<{ level: number; amount: number; beneficiary_id: string }>("SELECT level, amount, beneficiary_id FROM commission_records WHERE order_id = ?", [req.params.id])
          const commByLevel: Record<number, { amount: number; to: string | null }> = {
            1: { amount: 0, to: null }, 2: { amount: 0, to: null }, 3: { amount: 0, to: null },
          }
          let commissionDistributed = 0
          for (const r of commRecs) {
            commByLevel[r.level] = { amount: Number(r.amount), to: r.beneficiary_id }
            commissionDistributed += Number(r.amount)
          }
          const commissionRedirected = round2(commissionPool - commissionDistributed)
          // 2026-06-04 三科目解耦后：未发出的 commission 不再进 charity_fund / global_fund。
          //   region_cap / chain_gap / orphan_sponsor / opt_out_deactivated → commission_reserve（按 kind）
          //   opt-out 未激活（never_activated / auto_downgrade）         → pending_commission_escrow（30 天内 recipient opt-in 可恢复）
          // 此处只读汇总本单去向，让 agent 看清 redirected_total 实际落点（settleOrder 已完成，无写、无原子性要求）。
          const crRows = await dbAll<{ kind: string; s: number }>(
            "SELECT kind, COALESCE(SUM(amount),0) AS s FROM commission_reserve_txns WHERE related_order_id = ? GROUP BY kind", [req.params.id])
          const reserveByKind = { region_cap: 0, chain_gap: 0, orphan_sponsor: 0, opt_out_deactivated: 0, escrow_expired: 0 }
          for (const r of crRows) {
            if (r.kind === 'redirect_region_cap')               reserveByKind.region_cap          = round2(Number(r.s))
            else if (r.kind === 'redirect_chain_gap')           reserveByKind.chain_gap           = round2(Number(r.s))
            else if (r.kind === 'redirect_orphan_sponsor')      reserveByKind.orphan_sponsor      = round2(Number(r.s))
            else if (r.kind === 'redirect_opt_out_deactivated') reserveByKind.opt_out_deactivated = round2(Number(r.s))
            else if (r.kind === 'redirect_escrow_expired')      reserveByKind.escrow_expired      = round2(Number(r.s))
          }
          const redirectedToCommissionReserve = round2(reserveByKind.region_cap + reserveByKind.chain_gap + reserveByKind.orphan_sponsor + reserveByKind.opt_out_deactivated + reserveByKind.escrow_expired)
          // RFC-018: matures_at IS NULL = opt-out escrow only; clearing rows (matures_at NOT NULL) are
          // surfaced separately (PR3), not mislabeled as opt-out escrow here.
          const escrowRow = (await dbOne<{ s: number }>("SELECT COALESCE(SUM(amount),0) AS s FROM pending_commission_escrow WHERE order_id = ? AND status = 'pending' AND matures_at IS NULL", [req.params.id]))!
          const heldInOptOutEscrow = round2(Number(escrowRow.s))
          // QA 轮 9.5 P2：payouts 表只 MCP legacy 写，PWA settleOrder 直更 wallet.balance 不写 payouts
          // 改用公式推算 sellerAmount（跟 PWA settleOrder 内部计算一致），更可靠
          const fundBase1pct = round2(total * 0.01)
          const sellerAmountComputed = round2(total - protocolFee - logisticsActual - commissionPool - fundBase1pct)
          // sum_check 守恒：order_amount 应 = seller_net + protocol_fund + logistics + commission_pool(L1+L2+L3+redirect) + fund_base
          const sumComponents = round2(sellerAmountComputed + protocolFee + logisticsActual + commissionPool + fundBase1pct)
          settlementBreakdown = {
            order_amount: total,
            distribution: {
              seller_net:         { amount: sellerAmountComputed, to: ord.seller_id, note: '不含可能的首销 stake 锁定（settleOrder 内 stake_locked_at 首次锁，从 sellerAmount 划出）' },
              protocol_fund_2pct: { amount: protocolFee, split: { protocol_reserve_pool: round2(protocolFee/2), sys_protocol_ops: round2(protocolFee/2) } },
              logistics_fee:      { amount: logisticsActual, rate: isInPerson ? 'N/A in_person' : (ord.logistics_id ? '5%' : 'N/A self-fulfill') },
              commission_pool:    { total: commissionPool, rate: `${(commissionRate * 100).toFixed(1)}%` },
              commission_distribution_7_2_1: {
                l1: commByLevel[1],
                l2: commByLevel[2],
                l3: commByLevel[3],
                distributed_total: round2(commissionDistributed),
                redirected_total: commissionRedirected,
                redirected_to_commission_reserve: redirectedToCommissionReserve,
                reserve_by_kind: reserveByKind,                     // region_cap / chain_gap / orphan_sponsor / opt_out_deactivated / escrow_expired
                held_in_opt_out_escrow: heldInOptOutEscrow,         // never_activated / auto_downgrade — recipient opt-in 可恢复
                redirect_accounted_ok: Math.abs(commissionRedirected - round2(redirectedToCommissionReserve + heldInOptOutEscrow)) < 0.01,
                redirect_note: '未发出佣金 → commission_reserve（region_cap / chain_gap / orphan_sponsor / opt_out_deactivated）；opt-out 未激活（never_activated / auto_downgrade）暂存 pending_commission_escrow（30 天内 opt-in 可恢复），逾期未恢复则转入 commission_reserve（escrow_expired）。2026-06-04 起不再进 charity_fund / global_fund。',
              },
              fund_base_1pct: fundBase1pct,
            },
            sum_check: sumComponents,
            sum_check_ok: Math.abs(sumComponents - total) < 0.01,
            transparency_note: 'sum_check 校验：order_amount = seller_net + protocol_fund + logistics + commission_pool + fund_base。stake / pinner / PV 分账见各自专用查询。',
          }
        }
      } catch (e) { console.error('[settlement_breakdown build]', e) }
    }

    res.json({
      success: true,
      new_status: result.newStatus,
      ...(settlementBreakdown ? { settlement_breakdown: settlementBreakdown } : {}),
    })
  })

  // 手动触发超时判责（当事人）
  app.post('/api/orders/:id/force-timeout-check', async (req, res) => {
    const user = auth(req, res); if (!user) return
    // RFC-016: 当事人校验读 → 异步 seam;checkTimeouts(db) 自身仍是同步判责引擎(Phase 3 内部迁)
    const order = await dbOne<{ buyer_id: string; seller_id: string; logistics_id: string | null; status: string }>('SELECT buyer_id, seller_id, logistics_id, status FROM orders WHERE id = ?', [req.params.id])
    if (!order) return void res.status(404).json({ error: '订单不存在' })
    const uid = user.id as string
    if (uid !== order.buyer_id && uid !== order.seller_id && uid !== order.logistics_id) {
      return void res.status(403).json({ error: '非订单当事人' })
    }
    const beforeStatus = order.status
    // settleConfirmed 注入:当事人强制超时检查若命中 delivered 逾期 → 与 PWA cron 同路径自动确认+结算(否则本端点对 delivered 单空转)。
    const r = checkTimeouts(db, { settleConfirmed: settleOrder })
    const after = (await dbOne<{ status: string }>('SELECT status FROM orders WHERE id = ?', [req.params.id]))!
    const touched = r.details.find((d: { orderId: string; action: string }) => d.orderId === req.params.id) || null
    if (touched) {
      const faultMatch = touched.action.match(/→ (fault_\w+)/)
      if (faultMatch) {
        try { recordViolationReputation(db, req.params.id, faultMatch[1]) } catch {}
      }
    }
    res.json({
      before_status: beforeStatus,
      after_status: after.status,
      changed: beforeStatus !== after.status,
      action: touched?.action || null,
    })
  })
}
