/**
 * 协商取消(mutual cancel)—— 争议中订单的【无责·双方合意】下车口。
 *
 * 背景:disputed 订单原本只有仲裁裁定(有责判罚)或超时自动裁定两条终结路径。若双方只是想取消交易、
 *   并不想背判罚/信誉损失,此前无路可走。本模块提供 propose → accept 的双人握手:
 *     · 任一当事方(买/卖)提议协商取消;对方确认 → 执行。
 *     · 无责:双方信誉均不受影响(不写 dispute_loss_count、不记责任方、不收仲裁费)。
 *     · 买家被 made-whole:托管单全额退款(escrow→buyer)、卖家质押原样返还;直付(非托管)单零资金,仅关单。
 *     · 终态 = 'cancelled'(中性,复用既有 disputed→cancelled 边,system 执行),争议行同事务置 resolved。
 *
 * 【关键不变量 / 安全边界】
 *  1. 只有订单的 buyer/seller 能 propose/accept/decline/withdraw(仲裁员/系统/agent-旁观 一律拒)。
 *  2. accept 是资金+状态手术:必须由【路由用 db.transaction 包裹】,内部所有写在同一原子边界。
 *  3. accept 内重新校验:order.status==='disputed' 且存在 open|in_review 争议 —— 防与自动裁决/仲裁竞态。
 *     争议行在同一事务里被置 status='resolved',checkDisputeTimeouts 只扫 open|in_review → 不会二次结算。
 *  4. 无责:不触碰任何信誉/罚没/手续费科目;托管退款镜像既有 refund_buyer 的守恒写法(仅 escrowed→balance)。
 */
import Database from 'better-sqlite3'
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'
import { toUnits, toDecimal } from '../../money.js'
import { applyWalletDelta } from '../../ledger.js'

export interface MutualCancelResult {
  ok: boolean
  error?: string
  error_code?: string
  proposal_id?: string
  status?: string
  settlement?: Record<string, unknown>
  proposal?: Record<string, unknown> | null
  can_propose?: boolean
  can_accept?: boolean
  can_decline?: boolean
  can_withdraw?: boolean
}

interface OrderRow { id: string; buyer_id: string; seller_id: string; status: string; payment_rail: string | null; total_amount: number; product_id: string }
interface DisputeRow { id: string; status: string }
interface ProposalRow { id: string; proposed_by: string; counterparty: string; status: string; reason: string | null; created_at: string }

export function initMutualCancelSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mutual_cancel_proposals (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL,
    dispute_id    TEXT NOT NULL,
    proposed_by   TEXT NOT NULL,
    counterparty  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | withdrawn
    reason        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at   TEXT,
    resolved_by   TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mutual_cancel_order ON mutual_cancel_proposals(order_id, status)`)
}

/** 载入订单+活跃争议,并判定 caller 是否当事方 + 订单是否处于可协商取消的状态。fail-closed。 */
function loadCancellable(db: Database.Database, orderId: string, userId: string):
  { ok: true; order: OrderRow; dispute: DisputeRow; role: 'buyer' | 'seller' } | { ok: false; error: string; error_code: string } {
  const order = db.prepare('SELECT id, buyer_id, seller_id, status, payment_rail, total_amount, product_id FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  const role = userId === order.buyer_id ? 'buyer' : userId === order.seller_id ? 'seller' : null
  if (!role) return { ok: false, error: '仅买卖双方可协商取消该订单', error_code: 'NOT_A_PARTY' }
  if (order.status !== 'disputed') return { ok: false, error: '仅争议中的订单可协商取消', error_code: 'ORDER_NOT_DISPUTED' }
  const dispute = db.prepare("SELECT id, status FROM disputes WHERE order_id = ? AND status IN ('open','in_review') ORDER BY created_at DESC LIMIT 1").get(orderId) as DisputeRow | undefined
  if (!dispute) return { ok: false, error: '该订单没有进行中的争议', error_code: 'NO_ACTIVE_DISPUTE' }
  return { ok: true, order, dispute, role }
}

/** 当前 pending 提议(至多一条)。 */
function pendingProposal(db: Database.Database, orderId: string): ProposalRow | undefined {
  return db.prepare("SELECT id, proposed_by, counterparty, status, reason, created_at FROM mutual_cancel_proposals WHERE order_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(orderId) as ProposalRow | undefined
}

/** 提议协商取消。proposalId 由路由用 generateId 生成后传入(域模块不自造 id)。 */
export function proposeMutualCancel(db: Database.Database, orderId: string, userId: string, reason: string | null, proposalId: string): MutualCancelResult {
  const g = loadCancellable(db, orderId, userId)
  if (!g.ok) return g
  const existing = pendingProposal(db, orderId)
  if (existing) {
    if (existing.proposed_by === userId) return { ok: false, error: '你已提议协商取消,正在等待对方确认', error_code: 'ALREADY_PROPOSED', proposal_id: existing.id }
    return { ok: false, error: '对方已提议协商取消,请直接确认接受', error_code: 'COUNTERPARTY_ALREADY_PROPOSED', proposal_id: existing.id }
  }
  const counterparty = g.role === 'buyer' ? g.order.seller_id : g.order.buyer_id
  db.prepare("INSERT INTO mutual_cancel_proposals (id, order_id, dispute_id, proposed_by, counterparty, status, reason) VALUES (?,?,?,?,?,'pending',?)")
    .run(proposalId, orderId, g.dispute.id, userId, counterparty, (reason || '').slice(0, 500) || null)
  return { ok: true, proposal_id: proposalId, status: 'pending' }
}

/** 提议方撤回自己的 pending 提议。 */
export function withdrawMutualCancel(db: Database.Database, orderId: string, userId: string): MutualCancelResult {
  const prop = pendingProposal(db, orderId)
  if (!prop) return { ok: false, error: '没有待处理的协商取消提议', error_code: 'NO_PENDING_PROPOSAL' }
  if (prop.proposed_by !== userId) return { ok: false, error: '只能撤回自己提出的提议', error_code: 'NOT_PROPOSER' }
  db.prepare("UPDATE mutual_cancel_proposals SET status='withdrawn', resolved_at=datetime('now'), resolved_by=? WHERE id=?").run(userId, prop.id)
  return { ok: true, status: 'withdrawn' }
}

/** 对方拒绝 pending 提议。 */
export function declineMutualCancel(db: Database.Database, orderId: string, userId: string): MutualCancelResult {
  const g = loadCancellable(db, orderId, userId)
  if (!g.ok) return g
  const prop = pendingProposal(db, orderId)
  if (!prop) return { ok: false, error: '没有待处理的协商取消提议', error_code: 'NO_PENDING_PROPOSAL' }
  if (prop.proposed_by === userId) return { ok: false, error: '不能拒绝自己的提议(如需取消请撤回)', error_code: 'CANNOT_DECLINE_OWN' }
  db.prepare("UPDATE mutual_cancel_proposals SET status='declined', resolved_at=datetime('now'), resolved_by=? WHERE id=?").run(userId, prop.id)
  return { ok: true, status: 'declined' }
}

/**
 * 资金+状态结算(tx-free core)——【必须由路由用 db.transaction 包裹】。
 *  · 直付(非托管):零资金,仅 transition→cancelled。
 *  · 托管:买家全额退款(escrowed→balance),卖家质押原样返还(staked→balance);无罚没/无手续费/无信誉。
 *  · 争议行同事务置 resolved(verdict='mutual_cancel'),防自动裁决二次结算。
 */
function settleMutualCancel(db: Database.Database, order: OrderRow, disputeId: string): MutualCancelResult {
  const sys = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
  if (!sys) return { ok: false, error: 'sys_protocol 用户不存在', error_code: 'SYS_MISSING' }
  const nonCustodial = order.payment_rail === 'direct_p2p'
  let detail: Record<string, unknown>
  if (nonCustodial) {
    detail = { non_custodial: true, buyer_refund: 0, seller_stake_returned: 0, note: '非托管(直付)单:协议不持货款 → 零资金,仅关单' }
  } else {
    const totalU = toUnits(order.total_amount)
    applyWalletDelta(db, order.buyer_id, { escrowed: -totalU, balance: totalU })          // 买家托管货款原路退回(镜像 refund_buyer,守恒)
    const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?').get(order.product_id) as { stake_amount: number } | undefined
    const stakeU = product?.stake_amount ? toUnits(product.stake_amount) : 0
    if (stakeU > 0) applyWalletDelta(db, order.seller_id, { staked: -stakeU, balance: stakeU })  // 卖家质押无责返还
    detail = { non_custodial: false, buyer_refund: toDecimal(totalU), seller_stake_returned: toDecimal(stakeU), note: '托管单:买家全额退款,卖家质押返还,无罚没/无手续费/无信誉影响' }
  }
  const tr = transition(db, order.id, 'cancelled', sys.id, [], '双方协商取消(无责裁定:买家退款,双方信誉不受影响)')
  if (!tr.success) return { ok: false, error: tr.error, error_code: 'TRANSITION_FAILED' }
  db.prepare("UPDATE disputes SET status='resolved', verdict='mutual_cancel', verdict_reason=?, ruling_type='mutual_cancel', resolved_at=datetime('now') WHERE id=?")
    .run('双方合意取消订单 —— 无责终结,不计入任一方信誉', disputeId)
  return { ok: true, settlement: { ...detail, terminal: 'cancelled', dispute: 'resolved', fault: 'none', reputation_impact: 'none' } }
}

/**
 * 对方确认接受 → 执行协商取消。【路由必须 db.transaction 包裹本函数】。
 * 事务内重新校验(competition-safe):当事方 + order 仍 disputed + 争议仍 open|in_review + 存在 pending 提议 + 非自我确认。
 */
export function acceptMutualCancel(db: Database.Database, orderId: string, userId: string): MutualCancelResult {
  const g = loadCancellable(db, orderId, userId)
  if (!g.ok) return g
  const prop = pendingProposal(db, orderId)
  if (!prop) return { ok: false, error: '没有待确认的协商取消提议', error_code: 'NO_PENDING_PROPOSAL' }
  if (prop.proposed_by === userId) return { ok: false, error: '不能确认自己提出的取消,需由对方确认', error_code: 'CANNOT_ACCEPT_OWN' }
  const settle = settleMutualCancel(db, g.order, g.dispute.id)
  if (!settle.ok) return settle
  db.prepare("UPDATE mutual_cancel_proposals SET status='accepted', resolved_at=datetime('now'), resolved_by=? WHERE id=?").run(userId, prop.id)
  return { ok: true, status: 'accepted', settlement: settle.settlement }
}

/** UI 状态:当前提议 + 该 caller 可执行的动作(纯展示;真正的边界在各写函数)。 */
export function getMutualCancelState(db: Database.Database, orderId: string, userId: string): MutualCancelResult {
  const order = db.prepare('SELECT buyer_id, seller_id, status FROM orders WHERE id = ?').get(orderId) as { buyer_id: string; seller_id: string; status: string } | undefined
  if (!order) return { ok: false, error: '订单不存在', error_code: 'ORDER_NOT_FOUND' }
  const isParty = userId === order.buyer_id || userId === order.seller_id
  const hasActiveDispute = !!db.prepare("SELECT 1 FROM disputes WHERE order_id = ? AND status IN ('open','in_review') LIMIT 1").get(orderId)
  const eligible = isParty && order.status === 'disputed' && hasActiveDispute
  const prop = pendingProposal(db, orderId)
  const proposal = prop ? { id: prop.id, proposed_by: prop.proposed_by, reason: prop.reason, created_at: prop.created_at, mine: prop.proposed_by === userId } : null
  return {
    ok: true,
    proposal,
    can_propose: eligible && !prop,
    can_accept: eligible && !!prop && prop.proposed_by !== userId,
    can_decline: eligible && !!prop && prop.proposed_by !== userId,
    can_withdraw: eligible && !!prop && prop.proposed_by === userId,
  }
}
