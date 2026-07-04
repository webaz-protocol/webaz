/**
 * 商家保证金罚没 —— 提案/冷静期/执行 域模块(B3)。
 *
 * 口径(用户批准,v1):
 *  - 【仅】仲裁裁定卖家责的直付争议可发起提案:dispute.status='resolved' 且 ruling_type ∈
 *    ('refund_buyer','partial_refund'),且争议订单 payment_rail='direct_p2p'、seller = bond 持有人。
 *  - 【人工铁律】绝不自动:仲裁裁决只产生"可提案"事实;提案由 admin 显式发起(留痕),过冷静期
 *    (param direct_pay.bond_slash_cooling_days,默认 7 天,propose 时算成【绝对截止】存库)后由
 *    ROOT+Passkey 执行;执行前提案可撤销。
 *  - v1 = 全额罚没(slashBond:全额 provenance + status slashed + 资格吊销)。部分罚没需要入场门/
 *    状态机扩展(余额<要求额的 locked 语义),留待真实需求出现再单独拍板 —— 保证金罚没是重大违约的
 *    终局手段,轻过错走信誉处罚,不动担保物。
 *  - 罚没只进 penalty subject(recordBaseBondSlash,只进不出 + 3 红线:never→buyer / never→webaz
 *    profit / never→按案发奖),无任何 outflow 代码路径。
 *  - 一个 deposit 同时最多一个 open 提案;提案存在即挡退出退还(B2 blockers PENDING_SLASH_REVIEW)。
 */
import type Database from 'better-sqlite3'
import { slashBond } from './direct-receive-deposits.js'

export interface BondSlashResult { ok: boolean; reason?: string; proposalId?: string; status?: string; already?: boolean }

const SELLER_FAULT_RULINGS = ['refund_buyer', 'partial_refund']

/** 卖家是否有待复核罚没提案(B2 退出 blockers 用)。 */
export function sellerHasPendingSlash(db: Database.Database, sellerId: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM bond_slash_proposals WHERE seller_id = ? AND status = 'proposed' LIMIT 1").get(sellerId)
  } catch { return true }   // 表读不了 → fail-closed(视为有,挡退出)
}

/** admin 发起罚没提案。校验依据争议 + deposit 状态;冷静期算成绝对截止存库。 */
export function proposeBondSlash(db: Database.Database, args: {
  proposalId: string; depositId: string; disputeId: string; reason?: string | null; proposedBy: string; coolingDays: number
}): BondSlashResult {
  const dep = db.prepare('SELECT id, user_id, status, production_receipt_confirmed_at FROM direct_receive_deposits WHERE id = ?')
    .get(args.depositId) as { id: string; user_id: string; status: string; production_receipt_confirmed_at: string | null } | undefined
  if (!dep) return { ok: false, reason: 'deposit not found' }
  if (dep.status !== 'locked' && dep.status !== 'refunding') return { ok: false, reason: `can only propose slash on a locked/refunding bond (got '${dep.status}')` }
  const dsp = db.prepare(`SELECT d.id, d.status, d.ruling_type, o.payment_rail, o.seller_id
                          FROM disputes d JOIN orders o ON o.id = d.order_id WHERE d.id = ?`)
    .get(args.disputeId) as { id: string; status: string; ruling_type: string | null; payment_rail: string | null; seller_id: string } | undefined
  if (!dsp) return { ok: false, reason: 'dispute not found' }
  if (dsp.payment_rail !== 'direct_p2p') return { ok: false, reason: 'dispute is not on a direct_p2p order(罚没口径仅直付争议)' }
  if (dsp.seller_id !== dep.user_id) return { ok: false, reason: 'dispute seller does not match bond owner' }
  if (dsp.status !== 'resolved' || !dsp.ruling_type || !SELLER_FAULT_RULINGS.includes(dsp.ruling_type)) {
    return { ok: false, reason: `dispute must be resolved with a seller-fault ruling (${SELLER_FAULT_RULINGS.join('|')}); got status='${dsp.status}' ruling='${dsp.ruling_type ?? 'none'}'` }
  }
  const open = db.prepare("SELECT 1 FROM bond_slash_proposals WHERE deposit_id = ? AND status = 'proposed' LIMIT 1").get(args.depositId)
  if (open) return { ok: false, reason: 'an open slash proposal already exists for this deposit' }
  const days = Math.max(0, args.coolingDays)
  db.prepare(`INSERT INTO bond_slash_proposals (id, deposit_id, seller_id, dispute_id, reason, status, cooling_until, proposed_by)
              VALUES (?,?,?,?,?, 'proposed', datetime('now', ?), ?)`)
    .run(args.proposalId, args.depositId, dep.user_id, args.disputeId, args.reason ? String(args.reason).slice(0, 300) : null, `+${days} days`, args.proposedBy)
  return { ok: true, proposalId: args.proposalId, status: 'proposed' }
}

/** admin 撤销提案(执行前任意时刻)。 */
export function cancelBondSlashProposal(db: Database.Database, args: { proposalId: string; note?: string | null }): BondSlashResult {
  const row = db.prepare('SELECT status FROM bond_slash_proposals WHERE id = ?').get(args.proposalId) as { status: string } | undefined
  if (!row) return { ok: false, reason: 'proposal not found' }
  if (row.status === 'cancelled') return { ok: true, status: 'cancelled', already: true }
  if (row.status !== 'proposed') return { ok: false, reason: `cannot cancel from status '${row.status}'` }
  db.prepare("UPDATE bond_slash_proposals SET status = 'cancelled', cancelled_at = datetime('now'), cancel_note = ? WHERE id = ? AND status = 'proposed'")
    .run(args.note ? String(args.note).slice(0, 300) : null, args.proposalId)
  return { ok: true, status: 'cancelled' }
}

/**
 * 执行罚没:提案 proposed + 冷静期已过 → 同一事务内 CAS(proposed→executed)+ slashBond(全额 provenance
 * + status slashed + 资格吊销)。txnId 由调用方生成(审计关联)。
 */
export function executeBondSlashProposal(db: Database.Database, args: { proposalId: string; txnId: string; nowIso: string }): BondSlashResult {
  const row = db.prepare('SELECT id, deposit_id, seller_id, dispute_id, reason, status, cooling_until FROM bond_slash_proposals WHERE id = ?')
    .get(args.proposalId) as { id: string; deposit_id: string; seller_id: string; dispute_id: string; reason: string | null; status: string; cooling_until: string } | undefined
  if (!row) return { ok: false, reason: 'proposal not found' }
  if (row.status === 'executed') return { ok: true, status: 'executed', already: true }
  if (row.status !== 'proposed') return { ok: false, reason: `cannot execute from status '${row.status}'` }
  const coolMs = Date.parse(row.cooling_until.includes('T') ? row.cooling_until : row.cooling_until.replace(' ', 'T') + 'Z')
  const nowMs = Date.parse(args.nowIso)
  if (!Number.isFinite(coolMs) || !Number.isFinite(nowMs)) return { ok: false, reason: 'unparseable cooling timestamps' }
  if (nowMs < coolMs) return { ok: false, reason: `cooling window not over (until ${row.cooling_until})` }
  let out: BondSlashResult = { ok: true, status: 'executed' }
  db.transaction(() => {
    const cas = db.prepare("UPDATE bond_slash_proposals SET status = 'executed', executed_at = datetime('now'), executed_txn_id = ? WHERE id = ? AND status = 'proposed'")
      .run(args.txnId, args.proposalId)
    if (cas.changes !== 1) throw new Error('execute race: already processed')
    const s = slashBond(db, { depositId: row.deposit_id, txnId: args.txnId, reason: `bond_slash_proposal:${row.id} dispute:${row.dispute_id}${row.reason ? ` ${row.reason}` : ''}` })
    if (!s.ok) throw new Error(s.reason)
  })()
  return out
}

/** 提案列表(admin 队列/卖家告知)。 */
export function listBondSlashProposals(db: Database.Database, filter: { sellerId?: string; status?: string } = {}): Record<string, unknown>[] {
  const where: string[] = []; const params: unknown[] = []
  if (filter.sellerId) { where.push('p.seller_id = ?'); params.push(filter.sellerId) }
  if (filter.status) { where.push('p.status = ?'); params.push(filter.status) }
  return db.prepare(`SELECT p.*, u.name AS seller_name, u.handle AS seller_handle
                     FROM bond_slash_proposals p JOIN users u ON u.id = p.seller_id
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.proposed_at DESC LIMIT 200`).all(...params) as Record<string, unknown>[]
}
