/**
 * Direct Pay (Rail 1) — PR-6C AML/CFT runtime FLAG WRITER scaffold。
 *
 * 给 #107 已合并的运行期 AML 断路器(sellerDirectPayAmlClear / aml_flags)提供【内部 append-only 写入来源】。
 * 这【不是】真实第三方 AML vendor 接入,【不】做真实 STR 申报,【不】碰任何资金流;只在 direct_p2p 建单【成功后】
 *   对卖家近窗口行为做最小启发式监控,命中治理阈值即 append 一条 aml_flags(medium / open / review_queue)。
 *
 * 边界(铁律):
 *  - 只写 aml_flags,且【append-only】:仅 INSERT OR IGNORE;本模块绝不 UPDATE/DELETE 任何行。
 *    不写 wallet / escrow / settlement / refund / commission / fund / tokenomics,不改 order 状态机。
 *  - 不阻断当前订单:本函数在【订单事务已提交后】运行;写出的 flag 只影响【后续】Direct Pay create / availability
 *    (经 #107 breaker),不回滚/不影响刚建成的这一单。
 *  - 幂等:flag id = deterministic `amlf_<rule>_<orderId>`;同一 (order, rule) 重跑只存一条(INSERT OR IGNORE)。
 *  - detail 仅存【聚合数字】(window / count / threshold):无 PII、无买家身份、无地址、无订单内容。
 *  - 默认 INERT:阈值 param 默认 0 = 该规则关闭(不写任何 flag),避免 scaffold 误伤真实卖家;治理设正值方激活。
 *    监控关闭【不】放宽 #107 breaker —— breaker 独立 fail-closed;本 writer 只【增加】flag 来源,从不清白任何 flag。
 *  - fail-soft:用 safeRunDirectPayAmlMonitor 包装;监控写入异常【不得】破坏已提交的建单(见 direct-pay-create.ts)。
 */
import type Database from 'better-sqlite3'

/**
 * 治理可调 param 描述(供未来 launch-policy PR seed 进 DEFAULT_PARAMS;本 PR【不】改 server.ts —— 它已到 LOC 上限,
 *   且默认值全 inert,monitor 经 getProtocolParam fallback 即用)。默认值是本模块各阈值的【单一真相源】(num() 回落到此)。
 */
export const DIRECT_PAY_AML_PARAMS = [
  { key: 'direct_pay.aml.window_hours', value: '24', type: 'number', description: 'Direct Pay AML 监控回看窗口(小时)。默认 24。', category: 'system', min: 1 },
  { key: 'direct_pay.aml.velocity_max_orders', value: '0', type: 'number', description: 'Direct Pay AML velocity 规则:窗口内卖家 direct_p2p 单数达此值即 flag(medium/open)。0=关闭(默认 inert)。', category: 'system', min: 0 },
  { key: 'direct_pay.aml.small_order_amount', value: '0', type: 'number', description: 'Direct Pay AML concentration 规则:"小额单"判定阈值(与 orders.total_amount 同标度)。0=关闭。', category: 'system', min: 0 },
  { key: 'direct_pay.aml.concentration_max_small_orders', value: '0', type: 'number', description: 'Direct Pay AML concentration 规则:窗口内小额单数达此值即 flag;需与 small_order_amount 同时 >0 方激活。0=关闭。', category: 'system', min: 0 },
] as const

export interface DirectPayAmlMonitorArgs {
  sellerId: string
  orderId: string                                  // 触发本次监控的 direct_p2p 单(已提交);flag.related_order_id
  nowIso: string                                   // 调用方传入的当前时刻 ISO(派生窗口起点;便于测试注入)
  getProtocolParam: <T>(key: string, fallback: T) => T
}

/** 读非负数 param,脏值/缺失回落默认(默认 inert)。 */
function num(gp: <T>(k: string, fb: T) => T, key: string, fb: number): number {
  const v = Number(gp(key, fb))
  return Number.isFinite(v) && v >= 0 ? v : fb
}

/** ISO → SQLite datetime('now') 同格式 'YYYY-MM-DD HH:MM:SS'(UTC,秒级),以便与 orders.created_at 做可比的字符串比较。 */
function toSqliteTs(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * direct_p2p 建单成功后运行。按治理阈值检测窗口内卖家行为,命中即 append aml_flags。返回写入的 flag id 列表(可空)。
 * 纯写 aml_flags(append-only);无其它副作用。绝不阻断/回滚当前订单。
 */
export function runDirectPayAmlMonitor(db: Database.Database, args: DirectPayAmlMonitorArgs): { flagsWritten: string[] } {
  const { sellerId, orderId, nowIso, getProtocolParam: gp } = args
  const windowHours = num(gp, 'direct_pay.aml.window_hours', 24) || 24
  const maxOrders = num(gp, 'direct_pay.aml.velocity_max_orders', 0)
  const smallAmt = num(gp, 'direct_pay.aml.small_order_amount', 0)
  const maxSmall = num(gp, 'direct_pay.aml.concentration_max_small_orders', 0)

  const since = toSqliteTs(new Date(new Date(nowIso).getTime() - windowHours * 3600_000).toISOString())
  const flagsWritten: string[] = []

  const write = (rule: string, detail: Record<string, number>): void => {
    const id = `amlf_${rule}_${orderId}`
    const r = db.prepare(
      `INSERT OR IGNORE INTO aml_flags (id, subject_user_id, related_order_id, rule, severity, detail, status, disposition)
       VALUES (?,?,?,?, 'medium', ?, 'open', 'review_queue')`,
    ).run(id, sellerId, orderId, rule, JSON.stringify(detail))
    if (r.changes === 1) flagsWritten.push(id)
  }

  // Rule 1 — velocity / cumulative:窗口内卖家 direct_p2p 单数 ≥ 阈值(阈值 >0 方激活)。
  if (maxOrders > 0) {
    const row = db.prepare(
      "SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND created_at >= ?",
    ).get(sellerId, since) as { n: number }
    if (row.n >= maxOrders) write('velocity', { window_hours: windowHours, order_count: row.n, threshold: maxOrders })
  }

  // Rule 2 — concentration:窗口内小额(total_amount ≤ smallAmt)direct_p2p 单数 ≥ 阈值(两阈值都 >0 方激活)。
  if (smallAmt > 0 && maxSmall > 0) {
    const row = db.prepare(
      "SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND payment_rail = 'direct_p2p' AND total_amount <= ? AND created_at >= ?",
    ).get(sellerId, smallAmt, since) as { n: number }
    if (row.n >= maxSmall) write('concentration', { window_hours: windowHours, small_order_count: row.n, small_order_amount: smallAmt, threshold: maxSmall })
  }

  return { flagsWritten }
}

/**
 * fail-soft 包装:监控写入异常【不得】破坏已提交的建单。建单成功后调用此函数(而非裸 runDirectPayAmlMonitor),
 *   任何异常被吞并返回 { ok:false, error };绝不向上抛、绝不影响订单响应。
 */
export function safeRunDirectPayAmlMonitor(db: Database.Database, args: DirectPayAmlMonitorArgs): { ok: boolean; flagsWritten?: string[]; error?: string } {
  try {
    const { flagsWritten } = runDirectPayAmlMonitor(db, args)
    return { ok: true, flagsWritten }
  } catch (e) {
    // 仅记录;绝不抛(订单已提交,监控失败不能回流成建单失败)。
    console.error('[direct-pay-aml-monitor] non-fatal:', (e as Error).message)
    return { ok: false, error: (e as Error).message }
  }
}
