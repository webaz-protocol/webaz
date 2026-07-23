/**
 * L0-2 · 状态机引擎
 *
 * 三个核心职责：
 * 1. transition()     — 执行状态转移（验证权限 + 记录历史）
 * 2. checkTimeouts()  — 扫描超时订单，自动判责
 * 3. getStatus()      — 查询订单当前状态和责任方
 *
 * 关联 / Related: AGENTS.md · 元规则 #1 当一切可见 / #2 代码即规则(状态机=规则的代码化,改这里=改协议行为) ·
 *   合法转移表见 transitions.ts · 协议级改动审批见 CHARTER §3.2
 */

import Database from 'better-sqlite3'
import { generateId } from '../L0-1-database/schema.js'
import { appendOrderEvent } from './order-chain.js'
import {
  VALID_TRANSITIONS,
  CURRENT_RESPONSIBLE,
  CURRENT_RESPONSIBLE_SELF_FULFILL,
  type OrderStatus,
  type UserRole
} from './transitions.js'
// RFC-014 PR2 — 资金算术统一走整数 base-units;分配用 allocate 保证精确守恒。
import { toUnits, toDecimal, mulRate, allocate, type Units } from '../../money.js'
// RFC-014 PR3 — 钱包落库 helper 抽到共享 ledger 模块(原私有于此),防多份漂移。
import { walletUnits, applyWalletDelta } from '../../ledger.js'
// PR-B3b — undeliverable escrow 收口的纯资金拆分(守恒 + 护栏 A clamp 全在纯函数层,单测见 test-undeliverable-refund)。
import { computeUndeliverableRefund, undeliverableConserves } from '../../undeliverable-refund.js'

// ─── 类型定义 ───────────────────────────────────────────────

interface Order {
  id: string
  status: OrderStatus
  buyer_id: string
  seller_id: string
  logistics_id: string | null
  pay_deadline: string | null
  accept_deadline: string | null
  ship_deadline: string | null
  pickup_deadline: string | null
  delivery_deadline: string | null
  confirm_deadline: string | null
  [key: string]: unknown
}

interface User {
  id: string
  role: UserRole
}

export interface TransitionResult {
  success: boolean
  newStatus?: OrderStatus
  error?: string
  historyId?: string
}

// ─── 核心函数 ────────────────────────────────────────────────

/**
 * 执行状态转移
 * @param db        数据库连接
 * @param orderId   订单ID
 * @param toStatus  目标状态
 * @param actorId   操作者用户ID
 * @param evidenceIds 附上的证据ID列表
 * @param notes     备注说明
 * @param options   requireSignedEvent=true 时签名链失败必须回滚转移
 */
export function transition(
  db: Database.Database,
  orderId: string,
  toStatus: OrderStatus,
  actorId: string,
  evidenceIds: string[] = [],
  notes: string = '',
  options: { requireSignedEvent?: boolean } = {},
): TransitionResult {

  // 1. 读取订单和操作者
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Order | undefined
  if (!order) return { success: false, error: `订单不存在：${orderId}` }

  const actor = db.prepare('SELECT * FROM users WHERE id = ?').get(actorId) as User | undefined
  if (!actor) return { success: false, error: `用户不存在：${actorId}` }

  const fromStatus = order.status

  // 2. 查找合法转移规则
  const transitionKey = `${fromStatus}→${toStatus}`
  const rule = VALID_TRANSITIONS[transitionKey]

  if (!rule) {
    return {
      success: false,
      error: `非法状态转移：${fromStatus} → ${toStatus}（协议不允许此操作）`
    }
  }

  // 3. 验证角色权限
  if (!rule.allowedRoles.includes(actor.role)) {
    return {
      success: false,
      error: `权限不足：${actor.role} 无法执行 ${fromStatus} → ${toStatus}。` +
             `允许的角色：${rule.allowedRoles.join(', ')}`
    }
  }

  // 4. 验证证据要求
  if (rule.requiresEvidence && evidenceIds.length === 0) {
    return {
      success: false,
      error: `此操作需要证据。可任选一种方式提供:\n` +
        `(A) 传 evidence_description(文字描述,如 "物流单号: SF1234567 / 顺丰" / "已揽收 GPS:31.2,121.5") — agent 最方便\n` +
        `(B) 上传文件作为证据 — 提示:${rule.evidenceHint ?? '相关证明文件'}\n` +
        `两种都会写入 evidence 表,效力等同。`
    }
  }

  // 5. 执行转移（数据库事务，保证原子性）
  const historyId = generateId('hist')

  const execute = db.transaction(() => {
    // 更新订单状态
    db.prepare(`
      UPDATE orders
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(toStatus, orderId)

    // 记录状态历史（人类可读层）
    db.prepare(`
      INSERT INTO order_state_history
        (id, order_id, from_status, to_status, actor_id, actor_role, evidence_ids, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      historyId,
      orderId,
      fromStatus,
      toStatus,
      actorId,
      actor.role,
      JSON.stringify(evidenceIds),
      notes
    )

    // 协议层：append-only 签名链事件（防篡改 + 防伪造）
    try {
      appendOrderEvent(db, {
        orderId,
        eventType: 'transition',
        fromStatus,
        toStatus,
        actorId,
        actorRole: actor.role,
        extra: { evidence_ids: evidenceIds, notes: notes || null, history_id: historyId },
      })
    } catch (e) {
      if (options.requireSignedEvent) throw e
      // 签名链失败不应阻塞主流程（旧数据 / 老 actor 缺 api_key 等场景）
      console.warn('[order-chain] appendEvent failed:', (e as Error).message)
    }
  })

  execute()

  return { success: true, newStatus: toStatus, historyId }
}

/**
 * 扫描所有超时订单，自动判责
 * 这个函数应该定期运行（如每分钟），是「协议自动执法」的实现
 */
export function checkTimeouts(db: Database.Database, opts?: {
  // 自动确认(delivered→confirmed 超时)的成交结算回调 = settleOrder。engine(layer0)够不着 PWA settleOrder,
  // 由调用方注入(PWA runEnforcement 传);不注入的独立 cron/CLI 不自动确认,避免用 settleFault 误结算。
  settleConfirmed?: (orderId: string) => void
  // PR-B3b:undeliverable 买家责任落定(delivery_failed 争议窗口过期)的声誉回调 = recordViolationReputation(oid,'fault_buyer')。
  // 统一注入(两轨单一发射点,detail 字符串刻意不匹配 cron 的 /→ (fault_\w+)/ 正则 → 绝不双记);
  // 不注入则整个 delivery_failed 落定分支跳过(留 delivery_failed,等带回调的 PWA/守护进程扫描,不丢声誉)。
  recordUndeliverableFault?: (orderId: string) => void
}): {
  processed: number
  // transitions = 本轮对该订单实际执行的转移对(按序)。供调用方(runEnforcement/cron)喂给
  // notifyEnforcementTransitions 统一发通知 —— engine(L0)不 import 通知层,保持分层。
  details: Array<{ orderId: string; action: string; transitions?: Array<[string, string]> }>
} {
  const now = new Date().toISOString()
  const settleConfirmed = opts?.settleConfirmed
  const recordUndeliverableFault = opts?.recordUndeliverableFault
  const details: Array<{ orderId: string; action: string; transitions?: Array<[string, string]> }> = []

  // 找出所有进行中的订单
  // M7.4：跳过 claim 验证进行中的订单（has_pending_claim=1）— auto-confirm / 判责暂缓
  const activeOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status NOT IN ('completed', 'cancelled', 'fault_buyer', 'fault_seller', 'fault_logistics')
      AND COALESCE(has_pending_claim, 0) = 0
  `).all() as Order[]

  for (const order of activeOrders) {
    const transitionKey = findActiveDeadlineTransition(db, order, now)
    if (!transitionKey) continue

    const [, autoNextState] = transitionKey
    const systemUser = getSystemUser(db)

    // ── delivered→confirmed 超时 = 买家逾期未确认 → 自动确认收货(非判责)──────────────────────
    //   必须走 settleOrder(escrow 结算+佣金 / direct_p2p 释放遗留 stake+accrueFee),【绝不】用 settleFault:
    //   settleFault 是 fault-only(fault_seller/logistics/buyer),对 'confirmed' 会空结算(escrow 卖家永不收款、
    //   escrow 锁死)或幻影回补(direct_p2p 回补已售库存)。settleOrder 由调用方注入(PWA runEnforcement 传);
    //   无 settler 的独立 cron/CLI 不自动确认 → 留 delivered,等有 settler 的 PWA 扫描收口,不误结算、不搁浅。
    //   全链 delivered→confirmed→completed→settle 包一个 db.transaction(镜像 orders-action 手动 confirm 原子路径):
    //   任一步失败整体回滚回 delivered 可重试;买家没收到货会先 delivered→disputed(has_pending_claim 门已滤掉争议单)。
    if (autoNextState === 'confirmed') {
      if (!settleConfirmed) continue
      try {
        db.transaction(() => {
          const r1 = transition(db, order.id, 'confirmed', systemUser.id, [], '买家逾期未确认,系统自动确认收货')
          if (!r1.success) throw new Error(r1.error || 'auto-confirm transition failed')
          const r2 = transition(db, order.id, 'completed', systemUser.id, [], '自动确认后系统结算')
          if (!r2.success) throw new Error(r2.error || 'auto-complete transition failed')
          settleConfirmed(order.id)   // = settleOrder:两轨各自正确结算(escrow 释放+佣金 / direct_p2p accrueFee)
        })()
        details.push({ orderId: order.id, action: `${order.status} → completed（逾期自动确认结算）`, transitions: [['delivered', 'confirmed'], ['confirmed', 'completed']] })
      } catch (e) {
        console.error(`[auto-confirm settle] order=${order.id}`, e)
      }
      continue
    }

    // ── PR-B3b:delivery_failed 争议窗口过期 = 买家责任落定(非普通判责)——【按 rail 分流】────────
    //   direct_p2p:B2 语义不变(fault_buyer→completed,零资金零回补,settleFault 的 G7 守卫处理)。
    //   escrow:货物去向未知 → 不能立刻结算,进 return_pending 持有(escrow 保持锁定),置卖家确认收货
    //   窗口 goods_return_deadline。两轨声誉统一走注入回调(单一发射点);detail 刻意写"买家责任落定"
    //   不含"→ fault_xxx"模式 → cron 的 /→ (fault_\w+)/ 正则不命中,绝不双记。无回调则跳过整个分支
    //   (留 delivery_failed 等带回调的扫描收口,声誉不丢、escrow 不误动)。
    if (autoNextState === 'fault_buyer' && order.status === 'delivery_failed') {
      if (!recordUndeliverableFault) continue
      try {
        if (order.payment_rail === 'direct_p2p') {
          db.transaction(() => {
            const r1 = transition(db, order.id, 'fault_buyer', systemUser.id, [], '未派送成功·买家未在窗口内争议,责任落定')
            if (!r1.success) throw new Error(r1.error || 'fault_buyer transition failed')
            settleFault(db, order.id, 'fault_buyer')   // direct_p2p 分支:零钱包 + G7 不回补 + settled_fault_at
            const r2 = transition(db, order.id, 'completed', systemUser.id, [], '系统自动执行处置')
            if (!r2.success) throw new Error(r2.error || 'completion transition failed')
            recordUndeliverableFault(order.id)   // 回调在【事务内】(审计 F:commit 后回调抛错=声誉永久丢失,订单已进终态不再复扫;tx 内抛错→整体回滚→下轮重试)
          })()
          details.push({ orderId: order.id, action: `delivery_failed ⇒ 买家责任落定并收口(completed,direct_p2p 仅声誉)`, transitions: [['delivery_failed', 'fault_buyer'], ['fault_buyer', 'completed']] })
        } else {
          const windowH = protocolParamNumber(db, 'goods_return_confirm_window_hours', 120)
          const grIso = new Date(Date.now() + Math.max(1, windowH) * 3600 * 1000).toISOString()
          db.transaction(() => {
            const r1 = transition(db, order.id, 'return_pending', systemUser.id, [], '未派送成功·买家未在窗口内争议,责任落定;escrow 持有等货物返还')
            if (!r1.success) throw new Error(r1.error || 'return_pending transition failed')
            db.prepare('UPDATE orders SET goods_return_deadline = ? WHERE id = ? AND goods_return_deadline IS NULL').run(grIso, order.id)   // I3:IS NULL 不重写
            recordUndeliverableFault(order.id)   // 同上:声誉写与状态转移同一原子边界
          })()
          details.push({ orderId: order.id, action: `delivery_failed ⇒ 买家责任落定,escrow 持有等货物返还(return_pending)`, transitions: [['delivery_failed', 'return_pending']] })
        }
      } catch (e) {
        console.error(`[undeliverable finalize] order=${order.id}`, e)
      }
      continue
    }

    // ── PR-B3b:return_pending 过 goods_return_deadline = 卖家逾期未确认收货 → 默认全款退买家(护栏 B2)──
    //   settleUndeliverableEscrow('seller_silent_default') 在事务内:escrow 全额 → 买家 balance,卖家 0,
    //   退卖家 stake,盖 settled_fault_at;随后转 completed。任一步失败整体回滚回 return_pending 可重试。
    if (autoNextState === 'completed' && order.status === 'return_pending') {
      // rail 守卫(审计 F2,防御性):direct_p2p 不可能进 return_pending(rail 分流只送 escrow);若经数据修复/
      //   未来写入者误入,settle 硬门会抛错 → 每轮扫描重抛刷屏且永不收口。此处直接跳过 + 单行错误日志,
      //   留待人工数据修复(不假装结算)。
      if (order.payment_rail === 'direct_p2p') { console.error(`[return_pending sweep] 不可能状态:direct_p2p 订单 ${order.id} 处于 return_pending,跳过待人工修复`); continue }
      try {
        db.transaction(() => {
          settleUndeliverableEscrow(db, order.id, 'seller_silent_default')
          const r = transition(db, order.id, 'completed', systemUser.id, [], '卖家逾期未确认收到退货 → 默认全款退买家')
          if (!r.success) throw new Error(r.error || 'return_pending completion failed')
        })()
        details.push({ orderId: order.id, action: `return_pending ⇒ 卖家逾期未确认,默认全款退买家(completed)`, transitions: [['return_pending', 'completed']] })
      } catch (e) {
        console.error(`[return_pending default settle] order=${order.id}`, e)
      }
      continue
    }

    // ── 判责状态(fault_*)自动触发 + 资金处置 ────────────────────────────────────────────────
    const result = transition(
      db,
      order.id,
      autoNextState,
      systemUser.id,
      [],
      `系统自动判责：超过截止时间 ${new Date(now).toLocaleString()}`
    )

    if (result.success) {
      const entry: { orderId: string; action: string; transitions: Array<[string, string]> } = {
        orderId: order.id,
        action: `${order.status} → ${autoNextState}（超时自动判责）`,
        transitions: [[order.status, autoNextState]],
      }
      details.push(entry)

      // 如果判责状态可以自动完成，继续执行 — 资金处置 + 状态转移在一个事务内
      const completionKey = `${autoNextState}→completed`
      if (VALID_TRANSITIONS[completionKey]) {
        try {
          settleFault(db, order.id, autoNextState as OrderStatus)
          transition(db, order.id, 'completed', systemUser.id, [], '系统自动执行处置')
          entry.transitions.push([autoNextState, 'completed'])
        } catch (e) {
          console.error(`[settleFault] order=${order.id} state=${autoNextState}`, e)
        }
      }
    }
  }

  // RFC-007 stage 3：终结【临时判责】的客观拒单 —— 举证窗口逾期仍无人仲裁 → 落定为违约结算。
  //   (被仲裁接手的订单 stage 5 会清 pending / 改 disputed,不会命中此扫描;settled_fault_at 防重入。)
  // 注:deadline 存为 SQLite datetime(空格)、now 为 JS ISO(带 T/Z),字符串直比会错(空格<T) → 两侧都用 datetime() 归一化。
  const staleProvisional = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'fault_seller' AND COALESCE(decline_objective_pending, 0) = 1
      AND COALESCE(decline_contested, 0) = 0
      AND settled_fault_at IS NULL
      AND decline_contest_deadline IS NOT NULL AND datetime(decline_contest_deadline) < datetime(?)
  `).all(now) as Array<{ id: string }>
  for (const o of staleProvisional) {
    try {
      const sys = getSystemUser(db)
      settleFault(db, o.id, 'fault_seller')
      transition(db, o.id, 'completed', sys.id, [], 'RFC-007：客观拒单举证窗口逾期未仲裁 → 终结为违约')
      db.prepare('UPDATE orders SET decline_objective_pending = 0 WHERE id = ?').run(o.id)
      details.push({ orderId: o.id, action: '临时判责 → fault_seller（举证逾期终结）', transitions: [['fault_seller', 'completed']] })
    } catch (e) {
      console.error(`[decline finalize] order=${o.id}`, e)
    }
  }

  return { processed: details.length, details }
}

/**
 * 查询订单的完整状态（含当前责任方、距截止时间）
 */
export function getOrderStatus(db: Database.Database, orderId: string) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Order | undefined
  if (!order) return null

  const history = db.prepare(`
    SELECT h.*, u.name as actor_name, u.role as actor_role_name
    FROM order_state_history h
    JOIN users u ON h.actor_id = u.id
    WHERE h.order_id = ?
    ORDER BY h.created_at ASC
  `).all(orderId)

  // QA 轮 7 P1：self-fulfill 时 logistics_id 为 null，应该按 seller 表示责任方
  const isSelfFulfill = !order.logistics_id
  const responsibleTable = isSelfFulfill ? CURRENT_RESPONSIBLE_SELF_FULFILL : CURRENT_RESPONSIBLE
  const currentResponsible = responsibleTable[order.status] ?? null
  const activeDeadline = getActiveDeadline(order, db)

  // 2026-05-31 透传 Phase 1 兜底语义给 agent — 当 fulfillment_mode='shipping' 但 logistics_id NULL,
  // 实际是"协议 Phase 1 没物流市场,seller 自履行兜底"。agent 看到 responsible=seller 容易误解为
  // "卖家本来就要自履行",所以加显式 phase + context 让 agent 明白这是 Phase 1 临时兜底。
  // 真正面交(fulfillment_mode='in_person')才是 self-fulfill 本意。
  const mode = (order as Record<string, unknown>).fulfillment_mode as string | undefined
  const isInPerson = mode === 'in_person'
  const isPhase1Fallback = isSelfFulfill && !isInPerson && (mode === 'shipping' || !mode)
  const fulfillmentPhase = isPhase1Fallback
    ? 'phase_1_no_logistics_market'
    : (isInPerson ? 'in_person' : (order.logistics_id ? 'phase_2_logistics_assigned' : 'unknown'))
  const responsibleContext = isPhase1Fallback
    ? `Phase 1 fallback: 协议物流市场未启用,logistics_id 未绑定。seller 自履行兜底(自己揽收/运输/送达),超时按 fault_seller 处置。Phase 2 logistics 市场上线后会自动派单给 logistics 角色,届时 shipped/picked_up/in_transit → logistics 负责。`
    : (isInPerson
        ? '面交模式(fulfillment_mode=in_person):seller 与 buyer 当面交接,无第三方物流'
        : (order.logistics_id ? '已绑定物流方,按 logistics 责任流转(market-fulfill)' : null))

  return {
    order,
    history,
    currentResponsible,
    activeDeadline,
    // isOverdue 与 checkTimeouts 判定同源:走 SQLite datetime() 归一化。旧写法 new Date()>new Date(deadline) 对
    //   空格格式 deadline 会被 V8 按【本地时区】解析 → 展示"是否超时"与执法判定分叉(尤其直付 ship_deadline)。
    isOverdue: activeDeadline ? (db.prepare('SELECT datetime(?) < datetime(?) AS e').get(activeDeadline.deadline, new Date().toISOString()) as { e: number }).e === 1 : false,
    fulfillmentPhase,
    responsibleContext,
  }
}

// ─── 超时判责资金处置 ────────────────────────────────────────
// fault_*→completed 转移时由 checkTimeouts 调用，确保 escrow / stake / 库存 全部正确清算
// 设计原则：
//   - fault_seller   → buyer 全额退款 + stake 50/50 扣罚（与 dispute refund_buyer 对等）
//   - fault_logistics→ buyer 全额退款 + seller stake 全额返还（卖家无责，物流坏账协议吸收）
//   - fault_buyer    → 仅库存回退（escrow 未锁，无资金动作）
// 不发放 commission / PV / 基金池入金 — 无真实成交
// export: 供 tests/test-fault-forfeit-conservation.ts 直接验证守恒(真实代码,非复刻)。
//   生产仅由本模块 checkTimeouts 内部调用;导出不改变其调用语义。
export function settleFault(db: Database.Database, orderId: string, faultState: OrderStatus): void {
  const sysUserId = 'sys_protocol'

  // 幂等检查 + 资金处置全部包在 transaction 内（防未来迁 PG 时并发 race）
  db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
    if (!order) return
    if (order.settled_fault_at) return  // 幂等：已处置过

    const total = Number(order.total_amount)
    const buyerId = order.buyer_id as string
    const sellerId = order.seller_id as string
    const isSecondhand = order.source === 'secondhand'

    // ── Rail 1 直付(非托管)= 零钱包移动 ──────────────────────────────────────────────────
    //   决策(2026-07-08,Holden):非托管轨【卖家违约 = 仅信誉处罚 + 库存回补,零钱包退款】。协议从不托管买家
    //   本金(direct_p2p 建单 escrow_amount=0、买家钱包不写),【退不了】买家场外已付给卖家的钱;若在下方走 escrow
    //   退款分支(applyWalletDelta escrowed→balance),买家从无 escrowed → escrowed 转负 + balance 凭空 +total =
    //   【印钱 + 冤枉卖家】。信誉处罚由 cron 侧 recordViolationReputation(timeout_violation)另记,不受此早退影响;
    //   争议路径早已非托管感知(disputes-write.ts ncRail 门),此处补齐【超时/settleFault】这条被漏掉的路径。
    if (order.payment_rail === 'direct_p2p') {
      // 库存回补仅【发货前】fault:post-ship 绝不回补【已发出】的货。两条 post-ship 排除:
      //   ① fault_logistics(直付今天不设 pickup/delivery deadline,不可达;显式守卫防未来加 SLA 后幻影回补)。
      //   ② PR-B undeliverable:fault_buyer 且 delivery_failed_deadline 已置(经 delivery_failed 而来=货已发出)。
      //      —— 区分【发货前】created→fault_buyer(该列 NULL,正常回补)与【发货后】delivery_failed→fault_buyer(不回补)。
      //   按 create 扣减口径回补 quantity(非 +1)。
      if (faultState !== 'fault_logistics' && !order.delivery_failed_deadline) {
        const qty = Math.max(1, Number(order.quantity) || 1)
        if (!isSecondhand) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, order.product_id as string)
        else { try { db.prepare("UPDATE secondhand_items SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string) } catch { /* 二手回补 best-effort */ } }
      }
      db.prepare("UPDATE orders SET settled_fault_at = datetime('now') WHERE id = ?").run(orderId)   // 幂等标记(也供缓交配额排除已退款单)
      return
    }

    // RFC-008 stage 1（印钱 bug 修复）+ stage 2（罚没解耦）：
    //   stage 1：违约没收按订单 stake_backing 快照,绝不假设已锁、绝不超背书 → 根治"staked 转负+印钱"bug。
    //   stage 2：罚没率【与质押率解耦】—— penalty = fault_penalty_rate(默认 30%) × total,独立于 stake_rate。
    //     · 背书订单(stake_backing>0)：先扣 staked(封顶背书额),不足再扣卖家【自由 balance】(责任自负,
    //       罚没真可执行,不被薄质押架构性封顶)。
    //     · 起步免赔付(require_seller_stake=0 → backing=0)：仍 0 没收,【绝不碰新商家自由余额】(否则重新引入
    //       我们刚移除的门槛),买家已全额退款,卖家仅掉信誉。
    //   守恒不变：实扣 F(staked+balance) === 分出去的 F(协议/买家/推广/公池),永不印钱、永不转负。
    const faultPenaltyRate = (): number => {
      const row = db.prepare("SELECT value FROM protocol_params WHERE key = 'fault_penalty_rate'").get() as { value: string } | undefined
      const v = Number(row?.value)
      return Number.isFinite(v) && v >= 0 ? v : 0.30
    }
    // RFC-014:金额一律转整数 base-units 后再算/分配。
    const totalU = toUnits(total)
    const penaltyU = isSecondhand ? 0 : mulRate(totalU, faultPenaltyRate())
    const orderStakeBackingU = Math.max(0, toUnits(Number(order.stake_backing || 0)))

    // RFC-007 stage 4：没收后的【守恒 + 不牟利】再分配(取代旧的 buyer 50% / protocol 50%)。
    //   旧分配漏掉推广人(违反 §谁责任谁承担:推广人承担了真实推广成本却零补偿)。
    //   新规则(全部用订单快照,可复算,绝不印钱):
    //     1. 协议只回收【原本该收的平台费】protocolTake = min(F, total × protocol_fee_rate)
    //        —— 协议不从违约牟利;fund_base(1%) 排除(无成交=无 GMV,社区基金不应从罚没获利)。
    //     2. R = F − protocolTake;买家补偿 = R × 50% 起(受损对手方基础份额)。
    //     3. 推广人 = R 的另一半,按 l1/l2/l3 原始佣金比例分,【封顶各自原始佣金】—— 永不超过其真实损失。
    //     4. 推广半残值(超封顶 / 无推广人)→ 【买家】(受损方吸收违约方罚金剩余,故买家可超 50%)。
    //        决策 A(2026-06-07,对齐 RFC-007 Invariant #2):残值是罚金且无成交,归被坑方,不入 commission_reserve。
    //   守恒:protocolTake + buyerComp + promotersPaid + reserveResidual ≡ F(按构造,残值兜底)。
    const FORFEIT_LEVEL_RATES: Record<number, number> = { 1: 0.70, 2: 0.20, 3: 0.10 }
    const protocolFeeRate = (): number => {
      const key = isSecondhand ? 'protocol_fee_rate_secondhand' : 'protocol_fee_rate_shop'
      const row = db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(key) as { value: string } | undefined
      const v = Number(row?.value)
      return Number.isFinite(v) && v >= 0 ? v : (isSecondhand ? 0.01 : 0.02)
    }

    // 罚没【收取 + RFC-007 守恒分配】(整数 base-units;allocate 保证精确守恒),返回实扣额 units(0=起步免赔付)
    const forfeitAndDistribute = (penalty: Units): Units => {
      // 起步免赔付:无背书订单(stake_backing=0)绝不没收、绝不碰新商家自由余额
      if (orderStakeBackingU <= 0) return 0
      // 收取:先扣 staked(封顶背书额),不足再扣卖家自由 balance(责任自负;封顶其真实余额→不转负)
      const fromStaked = Math.min(penalty, orderStakeBackingU)
      const remainder = penalty - fromStaked
      const sellerBalU = Math.max(0, walletUnits(db, sellerId).balance)
      const fromBalance = Math.min(remainder, sellerBalU)
      const F = fromStaked + fromBalance
      if (F <= 0) return 0
      applyWalletDelta(db, sellerId, { staked: -fromStaked, balance: -fromBalance })

      // 1. 协议回收原始平台费(封顶 F,不牟利)
      const protocolTake = Math.min(F, mulRate(totalU, protocolFeeRate()))
      if (protocolTake > 0) applyWalletDelta(db, sysUserId, { balance: protocolTake })

      // 2. R 与买家补偿(精确平分:allocate 两桶求和 ≡ R)
      const R = F - protocolTake
      const [buyerComp, promoterHalf] = allocate(R, [1, 1])
      if (buyerComp > 0) applyWalletDelta(db, buyerId, { balance: buyerComp })

      // 3. 推广半 → l1/l2/l3 按原始佣金比例分,封顶原始佣金总额(allocate 求和 ≡ payable)
      const commissionRate = Number(order.snapshot_commission_rate ?? 0)
      const poolU = mulRate(totalU, Number.isFinite(commissionRate) && commissionRate > 0 ? commissionRate : 0)
      const levels = [
        { uid: order.l1_uid as string | null, orig: mulRate(poolU, FORFEIT_LEVEL_RATES[1]) },
        { uid: order.l2_uid as string | null, orig: mulRate(poolU, FORFEIT_LEVEL_RATES[2]) },
        { uid: order.l3_uid as string | null, orig: mulRate(poolU, FORFEIT_LEVEL_RATES[3]) },
      ].filter(l => l.uid)   // 仅【真实存在的推广人】参与
      const originalCommissionTotal = levels.reduce((s, l) => s + l.orig, 0)
      let promotersPaid = 0
      if (promoterHalf > 0 && originalCommissionTotal > 0) {
        const payable = Math.min(promoterHalf, originalCommissionTotal)   // 封顶原始佣金总额
        const shares = allocate(payable, levels.map(l => l.orig))
        levels.forEach((l, i) => {
          const share = shares[i]
          if (share <= 0) return
          applyWalletDelta(db, l.uid as string, { balance: share, earned: share })
          promotersPaid += share
        })
      }

      // 4. 推广半残值(超封顶 / 无推广人 / 取整余数)→ 【买家】(受损方吸收违约方罚金剩余,可超 50%)。
      //    决策 A(2026-06-07):对齐 RFC-007 Invariant #2「buyer absorbs the residual」+ 公开 economic.json。
      //    理由:残值是【卖家罚金 + 无成交】,非正常单的未归属销售 margin,故归被坑的对手方,不入 commission_reserve。
      //    守恒:protocolTake + (buyerComp+residual) + promotersPaid = protocolTake + R = F。绝不印钱。
      const residual = promoterHalf - promotersPaid
      if (residual > 0) applyWalletDelta(db, buyerId, { balance: residual })
      return F
    }

    // P0.1：RFQ 路径的 bid_stake_held — fault 时由各分支按规则处理
    const bidStakeHeldU = toUnits(Number(order.bid_stake_held || 0))

    // bid_stake_held 没收 50/50 的公用逻辑(中标后弃单的额外惩罚)
    const forfeitBidStake5050 = (): void => {
      if (bidStakeHeldU <= 0) return
      applyWalletDelta(db, sellerId, { staked: -bidStakeHeldU })
      const [compBuyer, compSys] = allocate(bidStakeHeldU, [1, 1])
      if (compBuyer > 0) applyWalletDelta(db, buyerId, { balance: compBuyer })
      if (compSys > 0) applyWalletDelta(db, sysUserId, { balance: compSys })
    }

    if (faultState === 'fault_seller') {
      // 1. buyer escrow 全额退回
      applyWalletDelta(db, buyerId, { escrowed: -totalU, balance: totalU })
      // P0.1：bid_stake_held 没收 50/50（中标后弃单的额外惩罚）
      forfeitBidStake5050()
      // 2. 罚没（fault_penalty_rate×total,staked 不足扣自由 balance,绝不印钱）→ RFC-007 守恒分配
      if (penaltyU > 0) forfeitAndDistribute(penaltyU)
      // 3. 库存回退（非二手）
      if (!isSecondhand) db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(order.product_id as string)
      // 4. 二手物品：状态恢复 available（保护卖家可重新发布）
      if (isSecondhand) {
        try { db.prepare("UPDATE secondhand_items SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string) } catch {}
      }
    } else if (faultState === 'fault_logistics') {
      // Phase 1（2026-05-27）：logistics_id 为 null 等价"self-fulfill seller"信号
      //   → seller 自选自负物流，超时未送达即 seller 违约，按 fault_seller 同样规则处置
      //   → 严格守"无责方零成本，谁责任谁承担"原则（详见 docs/LOGISTICS-PHASING.md）
      // Phase 2 logistics 市场启用后，logistics_id 非空走原始 logistics-penalty 逻辑
      const isSelfFulfill = !order.logistics_id
      if (isSelfFulfill) {
        // 1. buyer escrow 全额退回
        applyWalletDelta(db, buyerId, { escrowed: -totalU, balance: totalU })
        // 2. bid_stake_held 没收 50/50（同 fault_seller 逻辑）
        forfeitBidStake5050()
        // 3. 罚没（self-fulfill seller 违约;fault_penalty_rate×total,staked 不足扣自由 balance）→ RFC-007 守恒分配
        if (penaltyU > 0) forfeitAndDistribute(penaltyU)
        // 4. 库存回退
        if (!isSecondhand) db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(order.product_id as string)
        if (isSecondhand) {
          try { db.prepare("UPDATE secondhand_items SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string) } catch {}
        }
      } else {
        // Phase 2 logistics 市场：真正的 logistics 接单后违约
        // 1. buyer escrow 全额退回
        applyWalletDelta(db, buyerId, { escrowed: -totalU, balance: totalU })
        // 2. seller 无责 → bid_stake_held / stake 全额返还
        if (bidStakeHeldU > 0) applyWalletDelta(db, sellerId, { balance: bidStakeHeldU, staked: -bidStakeHeldU })
        // seller 无责 → 退还其【该单实际背书的 stake】(= stake_backing;起步阶段=0,无可退)
        if (orderStakeBackingU > 0) applyWalletDelta(db, sellerId, { staked: -orderStakeBackingU, balance: orderStakeBackingU })
        // 3. 库存回退
        if (!isSecondhand) db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(order.product_id as string)
        if (isSecondhand) {
          try { db.prepare("UPDATE secondhand_items SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string) } catch {}
        }
        // TODO（Phase 2）：logistics 接入 stake/insurance/deposit 后，从 logistics 池扣给 seller 补货款
      }
    } else if (faultState === 'fault_buyer') {
      // PR-B 防御(defense-in-depth):escrow 轨的 undeliverable(delivery_failed_deadline 已置)= post-ship 买家责任,
      //   资金收口(成本扣除/退余款)在 PR-B3。B2 不可达(mark_undeliverable 门控拒 escrow)——此处 fail-loud,
      //   防未来若门控回归导致【静默锁死 escrow + 错误回补已发出的货】。抛错→checkTimeouts 记录并留 fault_buyer 不 completed。
      if (order.delivery_failed_deadline) throw new Error('escrow undeliverable(delivery_failed)结算未上线(见 PR-B3);拒绝在 B2 mis-settle 以免锁死 escrow')
      // created→fault_buyer：escrow 未锁，仅库存回退(pre-ship)
      if (!isSecondhand) db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(order.product_id as string)
      if (isSecondhand) {
        try { db.prepare("UPDATE secondhand_items SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string) } catch {}
      }
      // P0.1：买家违约 → bid_stake_held 全额返还卖家（卖家未失责）
      if (bidStakeHeldU > 0) applyWalletDelta(db, sellerId, { balance: bidStakeHeldU, staked: -bidStakeHeldU })
    }

    // 标记已结算（防止重复处置）
    db.prepare("UPDATE orders SET settled_fault_at = datetime('now') WHERE id = ?").run(orderId)
  })()
}

// ─── RFC-007 stage 5：无责拒单结算（仲裁认定客观无责后调用）──────────────────
//   §无责零成本:买家全额退款 + 卖家质押全退,零罚没、零佣金、零基金入金(无真实成交)。
//   + 中性 no_fault_decline 信誉事件(points=0,不降分,仅作 rate-observable 信号防滥用)。
//   守恒:仅做"escrow→买家 balance"和"staked→卖家 balance"两笔内部移动,系统总额不变,绝不印钱。
export function settleDeclinedNoFault(db: Database.Database, orderId: string): void {
  db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
    if (!order) return
    if (order.settled_fault_at) return  // 幂等(复用 settled_fault_at 标记)

    const buyerId = order.buyer_id as string
    const sellerId = order.seller_id as string
    const isSecondhand = order.source === 'secondhand'
    // RFC-014:整数 base-units
    const totalU = toUnits(Number(order.total_amount))
    const orderStakeBackingU = Math.max(0, toUnits(Number(order.stake_backing || 0)))
    const bidStakeHeldU = toUnits(Number(order.bid_stake_held || 0))

    // 1. 买家 escrow 全额退回
    applyWalletDelta(db, buyerId, { escrowed: -totalU, balance: totalU })
    // 2. 卖家质押全退(封顶其实际 staked,绝不转负)—— 无责零成本
    const sellerStakedU = Math.max(0, walletUnits(db, sellerId).staked)
    const returnStake = Math.min(orderStakeBackingU + bidStakeHeldU, sellerStakedU)
    if (returnStake > 0) applyWalletDelta(db, sellerId, { staked: -returnStake, balance: returnStake })
    // 3. 库存 / 二手状态恢复
    if (!isSecondhand) db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(order.product_id as string)
    else { try { db.prepare("UPDATE secondhand_items SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(order.product_id as string) } catch {} }
    // 4. 中性 no_fault_decline 信誉事件(points=0 → 不降分;rate-observable 防"假客观"滥用)
    try {
      db.prepare('INSERT INTO reputation_events (id, user_id, order_id, event_type, points, reason) VALUES (?,?,?,?,?,?)')
        .run(generateId('rep'), sellerId, orderId, 'no_fault_decline', 0, `客观无责拒单(仲裁认定) reason=${order.decline_reason_code || ''}`)
    } catch (e) { console.warn('[no_fault_decline rep event]', (e as Error).message) }
    // 5. 结算标记 + 清临时判责 flag
    db.prepare("UPDATE orders SET settled_fault_at = datetime('now'), decline_objective_pending = 0 WHERE id = ?").run(orderId)
  })()
}

// ─── PR-B3b:undeliverable escrow 收口结算(买家责任已定,货物返还三选一中的两条自动/确认路径)────────
//   mode 类型【刻意只收两值】:goods_returned(卖家确认收货→成本扣除)/ seller_silent_default(卖家逾期→
//   默认全款退买家)。"货丢全额没收"(goods_lost_forfeit)【结构性不可达】—— 本函数类型层就表达不了,
//   只能经 return_pending→disputed 仲裁走既有 executeSettlement(release_seller),兑现"没收仅仲裁"铁律。
//   资金:纯 escrow 再分配(refund+seller ≡ total,undeliverableConserves 运行期断言,fail-loud);
//   另退卖家 stake(买家违约,卖家无责 —— 镜像 settleDeclinedNoFault);零佣金/零 PV(无真实成交);
//   【零库存回补】(已出库绝不自动回补 —— 货物经卖家退货验收后手动重新上架)。
//   幂等:settled_fault_at(与 settleFault/settleDeclinedNoFault 同一标记,语义=fault 类结算已处置)。
export function settleUndeliverableEscrow(
  db: Database.Database,
  orderId: string,
  mode: 'goods_returned' | 'seller_silent_default',
  sellerDeclaredReturnU: Units = 0,
): void {
  db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
    if (!order) return
    if (order.settled_fault_at) return   // 幂等:已处置
    // escrow-only 硬门:direct_p2p 无托管,任何调用都是接线 bug → fail-loud(绝不假装结算)
    if (order.payment_rail === 'direct_p2p') throw new Error('settleUndeliverableEscrow 仅限 escrow 轨(direct_p2p 无托管,收口=仅声誉)')

    const totalU = toUnits(Number(order.total_amount))
    const buyerId = order.buyer_id as string
    const sellerId = order.seller_id as string
    const split = computeUndeliverableRefund({
      mode,
      totalU,
      outboundShippingU: toUnits(Number(order.shipping_fee || 0)),
      sellerDeclaredReturnU,
      restockingFeeRate: protocolParamNumber(db, 'restocking_fee_rate', 0.10),
      returnShippingMaxRate: protocolParamNumber(db, 'return_shipping_max_rate', 0.20),
    })
    if (!undeliverableConserves(totalU, split)) throw new Error(`undeliverable split 守恒断言失败 order=${orderId}`)   // 绝不带着坏拆分动钱

    // 1. escrow 释放:退买家余款(escrowed 全解,balance 只进 refund;差额即卖家成本补偿)
    applyWalletDelta(db, buyerId, { escrowed: -totalU, balance: split.refundBuyerU })
    // 2. 卖家成本补偿(仅 goods_returned 有;silent_default 恒 0)
    if (split.toSellerU > 0) applyWalletDelta(db, sellerId, { balance: split.toSellerU })
    // 3. 退卖家 stake(封顶实际 staked,绝不转负 —— 买家违约,卖家无责)
    const stakeBackingU = Math.max(0, toUnits(Number(order.stake_backing || 0)))
    const bidStakeU = toUnits(Number(order.bid_stake_held || 0))
    const sellerStakedU = Math.max(0, walletUnits(db, sellerId).staked)
    const returnStake = Math.min(stakeBackingU + bidStakeU, sellerStakedU)
    if (returnStake > 0) applyWalletDelta(db, sellerId, { staked: -returnStake, balance: returnStake })
    // 4. 审计留痕:卖家申报的退程运费【原始值】(结算用的 clamp 后值 = split.returnU,可由本值+帽复算)
    if (mode === 'goods_returned') {
      db.prepare('UPDATE orders SET return_shipping_actual = ? WHERE id = ?').run(toDecimal(Math.max(0, Math.floor(sellerDeclaredReturnU))), orderId)
    }
    // 5. 幂等标记(无佣金/PV/回补 —— 无真实成交,货物走线下退货验收再上架)
    db.prepare("UPDATE orders SET settled_fault_at = datetime('now') WHERE id = ?").run(orderId)
  })()
}

/** 读 number 型协议参数(finite 且 ≥0 才生效,否则回退默认 —— 坏值只会让纯函数层 clamp 到更保守)。 */
function protocolParamNumber(db: Database.Database, key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM protocol_params WHERE key = ?').get(key) as { value: string } | undefined
    const v = Number(row?.value)
    return Number.isFinite(v) && v >= 0 ? v : fallback
  } catch { return fallback }
}

// ─── 内部工具函数 ─────────────────────────────────────────────

/** 找出当前订单超时的转移（如果有） */
function findActiveDeadlineTransition(
  db: Database.Database,
  order: Order,
  now: string
): [string, OrderStatus] | null {
  // 按当前状态找对应的截止时间规则
  const relevantRules = Object.entries(VALID_TRANSITIONS).filter(
    ([key, rule]) =>
      key.startsWith(`${order.status}→`) &&
      rule.deadlineField &&
      rule.autoFaultState
  )

  // deadline 到期判定统一走 SQLite datetime() 归一化(而非 JS 字符串直比):
  //   deadline 有两种存储格式 —— escrow 建单走 addHours→ISO('YYYY-MM-DDTHH:MM:SS.sssZ','T'),
  //   直付路径(如 ship_deadline @ orders-action)走 datetime('now',...)→空格格式('YYYY-MM-DD HH:MM:SS')。
  //   `now`(new Date().toISOString())带 'T'。JS 字符串比较 now>deadline 对【空格格式】deadline 在同一日历日会因
  //   'T'(0x54) > ' '(0x20) 误判为已过 → 最多提前 ~24h 自动判责(如卖家被提前判 fault_seller 未发货)。
  //   本函数此前是仓库里唯一未归一化的 deadline 比较点;改为 datetime()<datetime(),与本文件 RFC-007 块
  //   (checkTimeouts 内)+ order-action-exec.ts SLA 的既有约定一致,对 ISO/空格两种格式都正确。
  const expiryStmt = db.prepare('SELECT datetime(?) < datetime(?) AS e')   // 预编译一次(而非每规则重编译)
  for (const [, rule] of relevantRules) {
    const deadlineField = rule.deadlineField!
    const deadline = order[deadlineField] as string | null
    if (!deadline || !rule.autoFaultState) continue
    const expired = (expiryStmt.get(deadline, now) as { e: number }).e === 1
    if (expired) return [deadlineField, rule.autoFaultState]
  }

  return null
}

/** 获取当前有效的截止时间 */
export function getActiveDeadline(order: Order, db?: Database.Database) {
  // QA 轮 7 P1：旧表 picked_up 状态没 deadline → agent 不知道下一步多久前要做完
  // 修：picked_up 状态视为"已揽收，等运输/投递"，下一个 deadline 是 delivery_deadline
  // QA 轮 7 P1（另一条）：disputed 状态下没读 dispute_cases 的 arbitrate_deadline → agent 不知道仲裁还有多久
  const deadlineMapMarket: Record<string, string> = {
    pending_accept: 'pending_accept_deadline',   // 手动接单(v16):等卖家确认,超时无责取消
    created:   'pay_deadline',
    paid:      'accept_deadline',
    accepted:  'ship_deadline',
    shipped:   'pickup_deadline',
    picked_up: 'delivery_deadline',
    in_transit: 'delivery_deadline',
    delivered: 'confirm_deadline',
    delivery_failed: 'delivery_failed_deadline',   // PR-B:买家争议窗口(不争议→fault_buyer/return_pending 按 rail)
    return_pending: 'goods_return_deadline',       // PR-B3b:卖家确认收货窗口(超时→默认全款退买家)
  }
  // 2026-05-31 修：self-fulfill(logistics_id 空)无三方揽收环节,shipped/picked_up/in_transit
  // 全部直接走 delivery_deadline,跟 CURRENT_RESPONSIBLE_SELF_FULFILL 对齐(都归 seller)。
  // 之前 deadlineMap 单表导致 self-fulfill shipped 显示 pickup_deadline + responsible=seller,
  // agent 看到矛盾不知道下一步(pickup 是物流的事,seller 又没物流可揽收)。
  const deadlineMapSelfFulfill: Record<string, string> = {
    ...deadlineMapMarket,
    shipped:    'delivery_deadline',
    picked_up:  'delivery_deadline',
    in_transit: 'delivery_deadline',
  }
  const isSelfFulfill = !order.logistics_id
  const deadlineMap = isSelfFulfill ? deadlineMapSelfFulfill : deadlineMapMarket

  // disputed 状态：从 `disputes` 表（active dispute, not the `dispute_cases` archive）查 deadline
  // 优先返 arbitrate_deadline（仲裁总截止）；如果还在 respond 窗口（被诉方未回应）返 respond_deadline
  if (order.status === 'disputed' && db) {
    try {
      const dispute = db.prepare(
        `SELECT respond_deadline, arbitrate_deadline, ruling_type, status FROM disputes WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`
      ).get(order.id) as { respond_deadline?: string; arbitrate_deadline?: string; ruling_type?: string | null; status?: string } | undefined
      if (dispute && !dispute.ruling_type && dispute.status !== 'resolved' && dispute.status !== 'dismissed') {
        if (dispute.arbitrate_deadline) return { field: 'arbitrate_deadline', deadline: dispute.arbitrate_deadline }
        if (dispute.respond_deadline)  return { field: 'respond_deadline',  deadline: dispute.respond_deadline }
      }
    } catch {}
    return null
  }

  const field = deadlineMap[order.status]
  if (!field) return null

  const deadline = order[field] as string | null
  if (!deadline) return null

  return { field, deadline }
}

/** 获取或创建系统用户（用于自动触发），启动时调用一次 */
export function initSystemUser(db: Database.Database): User {
  return getSystemUser(db)
}

function getSystemUser(db: Database.Database): User {
  let sys = db.prepare("SELECT * FROM users WHERE id = 'sys_protocol'").get() as User | undefined
  if (!sys) {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, name, role, api_key)
      VALUES ('sys_protocol', '协议系统', 'system', 'sys_internal_key')
    `).run()
    db.prepare(`
      INSERT OR IGNORE INTO wallets (user_id, balance)
      VALUES ('sys_protocol', 0)
    `).run()
    sys = db.prepare("SELECT * FROM users WHERE id = 'sys_protocol'").get() as User
  }
  return sys
}
