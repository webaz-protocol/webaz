/**
 * WAZ 退役(2026-07-23)PR-A2 — 余额清零引擎 + append-only 冲正台账。
 *
 * 背景:WAZ escrow 轨已下架(#514 渠道开关默认关),Holden 拍板清空所有 WAZ。原则:
 *   - 【绝不 DELETE/UPDATE 任何历史流水】:清零 = applyWalletDelta 负 delta(RFC-014 绝对值落库)
 *     + 每笔写入本表一行冲正记录(before/delta 快照)。基金池经 creditColumns 同姿态。
 *   - 【fail-closed 三阶段】:盘点(任何在途承诺 → 拒绝清零)→ 清零(单事务原子)→ 校验(Σ=0)。
 *     在途承诺 = wallets.escrowed>0 / 非终态 escrow 单 / open RFQ/拍卖/active 团购 / active bid 押金 /
 *     pending 提现。这些先经正常状态机收敛(全是测试数据,#514 后不再新增)。
 *   - 基金池(charity/commission_reserve/global_fund/protocol_reserve_pool/penalty_fund)挂
 *     includeFunds 开关,默认不动 —— 执行前 dry-run 报告给 Holden 拍板。
 *   - dry-run 默认零写入;commit 幂等(已清零的行不再产生冲正记录)。
 *
 * 生产执行(等拍板):scripts/ops-waz-sunset.ts 经 railway ssh,先 dry-run 贴报告再 --commit。
 */
import type Database from 'better-sqlite3'
import { toDecimal, type Units } from './money.js'
import { applyWalletDelta, creditColumns, walletUnits, type WalletField } from './ledger.js'
import { VALID_TRANSITIONS } from './layer0-foundation/L0-2-state-machine/transitions.js'

/** 冲正台账(append-only,BEFORE UPDATE/DELETE → ABORT)。server boot 与 runtime 组合根都会建。 */
export function initWazSunsetSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS waz_sunset_corrections (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL,
    subject      TEXT NOT NULL,             -- 用户 id 或 'fund:<table>'
    field        TEXT NOT NULL,             -- balance | staked | earned | fee_staked | <fund 列名>
    before_units INTEGER NOT NULL,          -- 清零前(1e-6 base-units)
    delta_units  INTEGER NOT NULL,          -- 施加的 delta(= -before_units)
    reason       TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wsc_run ON waz_sunset_corrections(run_id)`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_wsc_no_update BEFORE UPDATE ON waz_sunset_corrections
           BEGIN SELECT RAISE(ABORT, 'waz_sunset_corrections is append-only'); END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_wsc_no_delete BEFORE DELETE ON waz_sunset_corrections
           BEGIN SELECT RAISE(ABORT, 'waz_sunset_corrections is append-only'); END`)
}

// 非终态 = 状态机里仍有出边的状态(从 VALID_TRANSITIONS 派生,零手写零漂移 —— Codex #515 R1 C-1:
// 手写集合曾把 fault_seller/fault_buyer 当终态,而引擎在这些状态仍会动 escrow)。
const NON_TERMINAL_ORDER_STATUSES = new Set(Object.keys(VALID_TRANSITIONS).map(k => k.split('→')[0]))

export interface SunsetBlocker { kind: string; ref: string; detail: string }

/** 盘点:返回全部阻断项。空数组 = 可以进入清零阶段。只读。 */
export function wazSunsetInventory(db: Database.Database): SunsetBlocker[] {
  const blockers: SunsetBlocker[] = []
  const q = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[] } catch { return [] } }
  for (const w of q<{ user_id: string; escrowed: number }>('SELECT user_id, escrowed FROM wallets WHERE COALESCE(escrowed,0) != 0')) {
    blockers.push({ kind: 'wallet_escrowed', ref: w.user_id, detail: `escrowed=${w.escrowed}` })
  }
  for (const o of q<{ id: string; status: string; escrow_amount: number }>(
    `SELECT id, status, escrow_amount FROM orders WHERE COALESCE(payment_rail,'escrow') != 'direct_p2p' AND COALESCE(escrow_amount,0) > 0`)) {
    if (NON_TERMINAL_ORDER_STATUSES.has(String(o.status))) blockers.push({ kind: 'order_in_flight', ref: o.id, detail: `status=${o.status} escrow=${o.escrow_amount}` })
  }
  // Direct Pay fee-stake(卖家 fee_staked 的锁定行):locked 行后续会结算/释放/罚没 fee_staked —— 清零后
  // 这些动作会把余额变负或凭空变钱(Codex #515 R1 C-2)。必须先收敛(结算完/释放/罚没)。
  for (const f of q<{ id: string; order_id: string; amount: number }>(`SELECT id, order_id, amount FROM direct_pay_fee_stakes WHERE status = 'locked'`)) {
    blockers.push({ kind: 'fee_stake_locked', ref: f.id, detail: `order=${f.order_id} amount=${f.amount}` })
  }
  // RFC-018 清算期佣金:pending 行到期/激活会给用户 balance/earned 记账,清零后把 WAZ"变回来"
  // (Codex #515 R1 C-3)。含 matures_at NULL(opt-out escrow)与非 NULL 两类。
  for (const c of q<{ id: number; recipient_user_id: string; amount: number }>(`SELECT id, recipient_user_id, amount FROM pending_commission_escrow WHERE status = 'pending'`)) {
    blockers.push({ kind: 'pending_commission', ref: String(c.id), detail: `user=${c.recipient_user_id} amount=${c.amount}` })
  }
  for (const r of q<{ id: string; status: string }>(`SELECT id, status FROM rfqs WHERE status = 'open'`)) {
    blockers.push({ kind: 'rfq_open', ref: r.id, detail: '等到期 cron 退押金或手动取消' })
  }
  for (const a of q<{ id: string }>(`SELECT id FROM auctions WHERE status = 'open'`)) {
    blockers.push({ kind: 'auction_open', ref: a.id, detail: '等结算 cron 收敛(渠道关=退款终局)' })
  }
  for (const g of q<{ id: string }>(`SELECT id FROM group_buys WHERE status = 'active'`)) {
    blockers.push({ kind: 'group_buy_active', ref: g.id, detail: '等到期 sweep(渠道关=强制全员退款)' })
  }
  for (const b of q<{ id: string; stake_locked: number }>(`SELECT id, stake_locked FROM bids WHERE status = 'active' AND COALESCE(stake_locked,0) > 0`)) {
    blockers.push({ kind: 'bid_stake_active', ref: b.id, detail: `stake=${b.stake_locked}` })
  }
  for (const b of q<{ id: string; stake_locked: number }>(`SELECT id, stake_locked FROM auction_bids WHERE status = 'active' AND COALESCE(stake_locked,0) > 0`)) {
    blockers.push({ kind: 'auction_bid_stake_active', ref: b.id, detail: `stake=${b.stake_locked}` })
  }
  for (const wd of q<{ id: string; status: string }>(`SELECT id, status FROM withdrawal_requests WHERE status IN ('pending','approved','processing')`)) {
    blockers.push({ kind: 'withdrawal_pending', ref: wd.id, detail: `status=${wd.status};先由 admin 处理完毕` })
  }
  // 试用免单(Codex #515 R2 H-1):active campaign 仍可产生新 claim;pending claim 评估通过会把 WAZ 从
  // 卖家转给买家 —— 清零后即凭空动钱。先关停 campaign / 收敛 claim。
  for (const t of q<{ id: string }>(`SELECT id FROM product_trial_campaigns WHERE status = 'active'`)) {
    blockers.push({ kind: 'trial_campaign_active', ref: t.id, detail: '先关停试用活动' })
  }
  for (const t of q<{ id: string; status: string }>(`SELECT id, status FROM product_trial_claims WHERE status IN ('pending_note','pending_threshold')`)) {
    blockers.push({ kind: 'trial_claim_pending', ref: t.id, detail: `status=${t.status}` })
  }
  // 商品/外链验证任务(Codex #515 R2 H-2):fee 在建任务时已离开钱包、只存在 verify_tasks.fee_locked,
  // 清零看不见;settleTask 之后会给 verifier 钱包入账。未终结任务必须先结完。
  for (const v of q<{ id: string; status: string; fee_locked: number }>(`SELECT id, status, COALESCE(fee_locked,0) fee_locked FROM verify_tasks WHERE status IN ('code_issued','open','settling')`)) {
    blockers.push({ kind: 'verify_task_open', ref: v.id, detail: `status=${v.status} fee_locked=${v.fee_locked}` })
  }
  return blockers
}

// 基金池清单(单行池表;列/表名全是代码字面量,经 creditColumns 绝对值清零)。
// 映射对照真实 DDL(Codex #515 R1 H-4):global_fund/protocol_reserve_pool 是 id=1,
// global_fund 的钱在 pool_balance + pv_escrow_reserve(守恒:pool+reserve+wallets)。
const FUND_POOLS: Array<{ table: string; where: string; args: unknown[]; cols: string[] }> = [
  { table: 'charity_fund', where: "id = 'main'", args: [], cols: ['balance'] },
  { table: 'commission_reserve', where: "id = 'main'", args: [], cols: ['balance'] },
  { table: 'global_fund', where: 'id = 1', args: [], cols: ['pool_balance', 'pv_escrow_reserve'] },
  { table: 'protocol_reserve_pool', where: 'id = 1', args: [], cols: ['balance'] },
  { table: 'penalty_fund', where: "id = 'main'", args: [], cols: ['balance'] },
]

export interface SunsetPlanRow { subject: string; field: string; beforeUnits: Units }
export interface SunsetResult {
  runId: string
  committed: boolean
  blockers: SunsetBlocker[]
  plan: SunsetPlanRow[]                    // 将/已 清零的每一笔(dry-run 与 commit 同一来源)
  residual: Array<{ subject: string; field: string; units: Units }>   // 校验阶段的非零残留(commit 后应为空)
}

/**
 * 清零主流程。commit=false(默认)= dry-run:只产出 plan,零写入。
 * commit=true:盘点必须零阻断,整个清零在单个 sync transaction 内原子完成。
 */
export function runWazSunsetZeroing(
  db: Database.Database,
  opts: { runId: string; reason: string; includeFunds?: boolean; commit?: boolean },
): SunsetResult {
  const { runId, reason } = opts
  const includeFunds = opts.includeFunds === true
  const commit = opts.commit === true
  const blockers = wazSunsetInventory(db)

  // ── 计划(读):所有非零钱包字段(escrowed 除外 —— 有值即 blocker)+ 可选基金池 ──
  const plan: SunsetPlanRow[] = []
  const WALLET_FIELDS: WalletField[] = ['balance', 'staked', 'earned', 'fee_staked']
  const users = db.prepare(`SELECT user_id FROM wallets WHERE COALESCE(balance,0) != 0 OR COALESCE(staked,0) != 0 OR COALESCE(earned,0) != 0 OR COALESCE(fee_staked,0) != 0 ORDER BY user_id`).all() as Array<{ user_id: string }>
  for (const u of users) {
    const w = walletUnits(db, u.user_id)
    for (const f of WALLET_FIELDS) if (w[f] !== 0) plan.push({ subject: u.user_id, field: f, beforeUnits: w[f] })
  }
  if (includeFunds) {
    for (const p of FUND_POOLS) {
      try {
        const row = db.prepare(`SELECT ${p.cols.map(c => `COALESCE(${c},0) AS ${c}`).join(', ')} FROM ${p.table} WHERE ${p.where}`).get(...p.args) as Record<string, number> | undefined
        if (row) for (const c of p.cols) { const u = Math.round(Number(row[c]) * 1e6); if (u !== 0) plan.push({ subject: `fund:${p.table}`, field: c, beforeUnits: u }) }
      } catch { /* 池表不存在(最小库)→ 跳过 */ }
    }
  }

  // dry-run 严格零写入:连 DDL 都不发(Codex #515 R1 M-5);建表只发生在 commit 分支。
  if (!commit) return { runId, committed: false, blockers, plan, residual: verifyResidual(db, includeFunds) }
  if (blockers.length > 0) throw new Error(`WAZ sunset blocked: ${blockers.length} in-flight item(s) — converge them first (fail-closed)`)
  initWazSunsetSchema(db)

  // ── 清零(单事务原子):负 delta + 冲正行;绝不动历史流水 ──
  const ins = db.prepare(`INSERT INTO waz_sunset_corrections (id, run_id, subject, field, before_units, delta_units, reason) VALUES (?,?,?,?,?,?,?)`)
  let seq = 0
  db.transaction(() => {
    for (const row of plan) {
      if (row.subject.startsWith('fund:')) {
        const pool = FUND_POOLS.find(p => `fund:${p.table}` === row.subject)!
        creditColumns(db, pool.table, pool.where, pool.args, { [row.field]: -row.beforeUnits })
      } else {
        applyWalletDelta(db, row.subject, { [row.field]: -row.beforeUnits })
      }
      ins.run(`wsc_${runId}_${++seq}`, runId, row.subject, row.field, row.beforeUnits, -row.beforeUnits, reason)
    }
  })()

  return { runId, committed: true, blockers: [], plan, residual: verifyResidual(db, includeFunds) }
}

/** 校验:重扫全部钱包字段(escrowed 含)与(可选)基金池,返回非零残留。commit 后应为空。 */
export function verifyResidual(db: Database.Database, includeFunds: boolean): Array<{ subject: string; field: string; units: Units }> {
  const out: Array<{ subject: string; field: string; units: Units }> = []
  const rows = db.prepare('SELECT user_id FROM wallets').all() as Array<{ user_id: string }>
  for (const r of rows) {
    const w = walletUnits(db, r.user_id)
    for (const f of Object.keys(w) as WalletField[]) if (w[f] !== 0) out.push({ subject: r.user_id, field: f, units: w[f] })
  }
  if (includeFunds) {
    for (const p of FUND_POOLS) {
      try {
        const row = db.prepare(`SELECT ${p.cols.map(c => `COALESCE(${c},0) AS ${c}`).join(', ')} FROM ${p.table} WHERE ${p.where}`).get(...p.args) as Record<string, number> | undefined
        if (row) for (const c of p.cols) { const u = Math.round(Number(row[c]) * 1e6); if (u !== 0) out.push({ subject: `fund:${p.table}`, field: c, units: u }) }
      } catch { /* absent */ }
    }
  }
  return out
}

/** 报告渲染(dry-run 与 commit 共用;script 打印)。 */
export function renderSunsetReport(r: SunsetResult): string {
  const lines: string[] = []
  lines.push(`── WAZ sunset ${r.committed ? 'COMMIT' : 'DRY-RUN'} · run_id=${r.runId} ──`)
  if (r.blockers.length) {
    lines.push(`⛔ blockers(${r.blockers.length})— 先收敛这些在途项(fail-closed,commit 会拒绝):`)
    for (const b of r.blockers) lines.push(`   [${b.kind}] ${b.ref} · ${b.detail}`)
  } else lines.push('✅ blockers: none')
  lines.push(`plan(${r.plan.length} 笔):`)
  for (const p of r.plan) lines.push(`   ${p.subject} · ${p.field}: ${toDecimal(p.beforeUnits)} → 0`)
  if (r.plan.length === 0) lines.push('   (nothing to zero — already clean)')
  lines.push(r.residual.length === 0 ? '✅ residual: all zero' : `residual 非零 ${r.residual.length} 项${r.committed ? '(异常!)' : '(dry-run,待 commit)'}`)
  return lines.join('\n')
}
