/**
 * RFC-021 PR3 — order-action 共享执行器(accept/ship)。钱路相邻:守卫【全部内置】,api_key 路由与 Passkey-approve
 * 两路径共调此函数 = 单一执行真相源。绝不 UPDATE accept_deadline/ship_deadline(I3);不处理 decline、不做资金结算(D2/I8)。
 *
 * 只 import 状态机 transition;不 import money/ledger/结算函数,不做任何资金处置(D2/I8)。
 * 核心守卫两路径【逐一相同】:归属 + 状态前置(accept 须 paid / ship 须 accepted) + SLA(deadline 未过) + evidence + transition。
 * I4 tracking 内容重校 = 【仅 strictTracking=true(agent-approve 路径)】—— strictTracking 只由【调用点常量】决定,
 *   绝不来自请求体/params/grant/任何 agent 可影响的入参(决策 X-1)。默认 true(fail-safe)。
 * agent 路径 = 核心守卫 ＋ I4(额外),永不弱于 api_key 路径。
 *
 * I1:本文件仅被 api_key 路由(orders-action.ts)与人类 approve handler(agent-grants.ts /approve)import;
 *   agent-bearer 提交路径(order-action-request.ts)【不】import 它 —— execute 对 agent 不可达(负向 grep 守卫)。
 */
import type Database from 'better-sqlite3'
import { transition } from '../layer0-foundation/L0-2-state-machine/engine.js'

/** I4 占位符黑名单:N/A、无、test、全 0、纯重复字符(≥8 长度的多为全 0/纯重复;短的由长度/正则先挡)。从严。 */
function isPlaceholderTracking(s: string): boolean {
  return /^n\/?a$/i.test(s) || s === '无' || /^test$/i.test(s) || /^0+$/.test(s) || /^(.)\1+$/.test(s)
}
/** I4 tracking 内容校验:非空 + trim≥8 + ^[A-Za-z0-9-]+$ + 非占位符。宁可误拒。 */
export function validateTrackingContent(tracking: string | undefined): { ok: boolean; error?: string } {
  const t = (tracking ?? '').trim()
  if (t.length < 8) return { ok: false, error: 'tracking 长度不足(需 ≥8)' }
  if (!/^[A-Za-z0-9-]+$/.test(t)) return { ok: false, error: 'tracking 含非法字符(仅字母/数字/连字符)' }
  if (isPlaceholderTracking(t)) return { ok: false, error: 'tracking 疑似占位符,请填真实单号' }
  return { ok: true }
}

export type OrderExecAction = 'accept' | 'ship'
export interface ExecResult { ok: boolean; fromStatus?: string; toStatus?: string; error?: string; error_code?: string; http?: number }
export interface ExecOpts {
  orderId: string; action: OrderExecAction; actorId: string; nowIso: string;
  strictTracking?: boolean;             // P2 fail-safe:漏传/undefined → true;仅显式 false 放宽。只由调用点常量决定(禁 agent 影响)。
  tracking?: string; evidenceRef?: string; evidenceDescription?: string;
  generateId: (p: string) => string;
  path: 'api_key' | 'approve';          // 审计:哪条路径
}

/**
 * 执行 accept/ship。守卫全内置;任一不满足 → {ok:false}(不 transition)。成功 → 订单状态跃迁 + evidence(ship)。
 * 幂等/executed_at 由调用方(approve 路径)在外层 CAS;本函数只做守卫 + transition。
 */
export function executeSellerOrderAction(db: Database.Database, opts: ExecOpts): ExecResult {
  const { orderId, action, actorId, nowIso, path } = opts
  // P2 fail-safe:漏传/undefined → strict;仅显式 false 放宽(自履行/无单号 api_key 路径)。
  const strictTracking = opts.strictTracking !== false
  const fail = (error_code: string, http: number, error?: string): ExecResult => ({ ok: false, error_code, http, error })

  // SLA 比较用 datetime() 归一化(SQLite datetime 空格格式 vs JS ISO 'T' 直比会错 → engine.ts:223、direct-pay-timeouts 全用 datetime()<datetime()。
  //   *_expired = 1 已过 / 0 未过 / NULL 该 deadline 缺失(fail-closed 用)。
  const order = db.prepare(`SELECT seller_id, status, accept_deadline, ship_deadline,
      CASE WHEN accept_deadline IS NULL THEN NULL WHEN datetime(accept_deadline) < datetime(?) THEN 1 ELSE 0 END AS accept_expired,
      CASE WHEN ship_deadline   IS NULL THEN NULL WHEN datetime(ship_deadline)   < datetime(?) THEN 1 ELSE 0 END AS ship_expired
    FROM orders WHERE id = ?`).get(nowIso, nowIso, orderId) as { seller_id: string; status: string; accept_deadline: string | null; ship_deadline: string | null; accept_expired: number | null; ship_expired: number | null } | undefined
  if (!order) return fail('ORDER_NOT_FOUND', 404, '订单不存在')
  // 核心守卫①:归属(actor 必须是本单卖家)
  if (order.seller_id !== actorId) return fail('NOT_ORDER_SELLER', 403, '该订单不属于你')
  // 核心守卫②③:状态前置 + SLA。P1-c(a) fail-closed:需要 SLA 的状态遇 deadline=NULL → 拒绝放行(绝不 skip),
  //   防任何"忘写 deadline"的下单路径(如缺 ship_deadline 的 direct_p2p)静默绕过判责钟。
  if (action === 'accept') {
    if (order.status !== 'paid') return fail('WRONG_STATUS', 409, '仅 paid 订单可接单')
    if (order.accept_deadline == null) return fail('SLA_DEADLINE_MISSING', 409, '订单缺 accept_deadline,fail-closed 拒绝执行')
    if (order.accept_expired === 1) return fail('SLA_EXPIRED', 409, '接单窗口已过')
  } else {
    if (order.status !== 'accepted') return fail('WRONG_STATUS', 409, '仅 accepted 订单可发货')
    if (order.ship_deadline == null) return fail('SLA_DEADLINE_MISSING', 409, '订单缺 ship_deadline,fail-closed 拒绝执行')
    if (order.ship_expired === 1) return fail('SLA_EXPIRED', 409, '发货窗口已过')
    // I4(仅 strictTracking=true,即 agent-approve 路径):tracking 内容重校,不信任 request 内容
    if (strictTracking) {
      const v = validateTrackingContent(opts.tracking)
      if (!v.ok) return fail('INVALID_TRACKING', 400, v.error)
    }
  }
  // 核心守卫④:evidence(ship 须证据;transition 内部再校非空 → 保持 api_key "无 evidence 即拒" 现状)
  const evidenceIds: string[] = []
  if (action === 'ship') {
    const desc = strictTracking
      ? `快递单号:${String(opts.tracking)}${opts.evidenceRef ? ` · 凭证:${String(opts.evidenceRef)}` : ''}`
      : (opts.evidenceDescription || null)   // 非严格(api_key):仅当卖家提供 evidence_description 才建;缺则 transition 因证据空而拒(保持现状)
    if (desc) {
      const eid = opts.generateId('evt')
      db.prepare("INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash) VALUES (?,?,?,'description',?,?)").run(eid, orderId, actorId, desc, `h_${nowIso}_${eid}`)
      evidenceIds.push(eid)
    }
  }
  // ⑤ transition(I3:绝不 UPDATE accept_deadline/ship_deadline;transition 只改 status + 事件链)
  const toStatus = action === 'accept' ? 'accepted' : 'shipped'
  const r = transition(db, orderId, toStatus, actorId, evidenceIds, `${action} via executor (${path})`)
  if (!r.success) return fail('TRANSITION_FAILED', 409, r.error)
  return { ok: true, fromStatus: order.status, toStatus }
}

class AlreadyExecErr extends Error {}
class NotPendingErr extends Error {}
class ExecFailErr extends Error { exec: ExecResult; constructor(e: ExecResult) { super(e.error_code); this.exec = e } }

/**
 * approve 路径:CAS pending→approved(若 pending)→ 执行(strictTracking=true)→ executed_at CAS(I5 幂等键)。
 *   执行成功:executed_at + execution_result 写入(与 transition 同一事务,并发只一次)。
 *   执行失败(守卫/transition):【不】写 executed_at,请求保持 approved 可重试;写失败 execution_result(注解)。
 *   executed_at 已置位:幂等直接返回 already_executed。
 * strictTracking=true 硬编码在此(agent 路径),不接受任何外部入参。
 * P1-b 审计 fail-closed:approve / execute 的 agent_grant_auth_log 写入与状态改动【同一事务】—— 审计失败即回滚,
 *   动作不发生(与 PR2 提交侧审计一致,绝不 fail-open 吞异常)。
 */
export function approveAndExecuteOrderAction(db: Database.Database, requestId: string, actorId: string, grantId: string, nowIso: string, generateId: (p: string) => string): { ok: boolean; order_status?: string; already_executed?: boolean; error?: string; error_code?: string; http?: number } {
  const auditRow = (cap: string, outcome: 'allow' | 'deny') => db.prepare('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)').run(grantId, actorId, cap, outcome, null)
  const r = db.prepare("SELECT status, kind, order_id, order_action, action_params, executed_at, expires_at FROM agent_permission_requests WHERE id = ?").get(requestId) as { status: string; kind: string | null; order_id: string; order_action: string; action_params: string | null; executed_at: string | null; expires_at: string } | undefined
  if (!r || r.kind !== 'order_action') return { ok: false, error_code: 'NOT_ORDER_ACTION', http: 404 }
  if (r.executed_at) return { ok: true, already_executed: true }   // 幂等:已执行
  if (r.status !== 'pending' && r.status !== 'approved') return { ok: false, error_code: 'REQUEST_NOT_APPROVABLE', http: 409 }
  // step 1:CAS→approved + 审计,同一事务 fail-closed(仅 pending;单独提交 → 执行失败仍保持 approved 可重试)。expires_at 原子守卫。
  if (r.status === 'pending') {
    try {
      db.transaction(() => {
        const c = db.prepare("UPDATE agent_permission_requests SET status='approved', approved_at=? WHERE id=? AND status='pending' AND expires_at > ?").run(nowIso, requestId, nowIso).changes
        if (c !== 1) throw new NotPendingErr()
        auditRow(`order_action:approve:${r.order_id}:${r.order_action}`, 'allow')   // 审计写失败 → 抛 → 回滚 CAS(未 approve)
      })()
    } catch (e) {
      if (e instanceof NotPendingErr) return { ok: false, error_code: 'REQUEST_NOT_PENDING_OR_EXPIRED', http: 409 }
      return { ok: false, error_code: 'AUDIT_WRITE_FAILED', error: (e as Error).message, http: 500 }   // 审计 fail-closed:保持 pending,未 approve/未执行
    }
  }
  // step 2:执行 + executed_at + 执行审计,同一事务原子 fail-closed(并发/重放/审计失败 → 回滚)
  let params: Record<string, unknown> = {}
  try { params = r.action_params ? JSON.parse(r.action_params) : {} } catch { params = {} }
  try {
    const out = db.transaction((): ExecResult => {
      const cur = db.prepare('SELECT executed_at FROM agent_permission_requests WHERE id = ?').get(requestId) as { executed_at: string | null }
      if (cur.executed_at) throw new AlreadyExecErr()
      const exec = executeSellerOrderAction(db, { orderId: r.order_id, action: r.order_action as OrderExecAction, actorId, nowIso, strictTracking: true, tracking: params.tracking as string | undefined, evidenceRef: params.evidence_ref as string | undefined, generateId, path: 'approve' })
      if (!exec.ok) throw new ExecFailErr(exec)
      const e = db.prepare("UPDATE agent_permission_requests SET executed_at=?, execution_result=? WHERE id=? AND executed_at IS NULL").run(nowIso, JSON.stringify({ ok: true, from: exec.fromStatus, to: exec.toStatus }), requestId).changes
      if (e !== 1) throw new AlreadyExecErr()
      auditRow(`order_action:execute:${r.order_id}:${r.order_action}`, 'allow')   // 审计写失败 → 抛 → 回滚执行 + executed_at(未执行)
      return exec
    })()
    return { ok: true, order_status: out.toStatus }
  } catch (err) {
    if (err instanceof AlreadyExecErr) return { ok: true, already_executed: true }
    if (err instanceof ExecFailErr) {
      try { db.prepare("UPDATE agent_permission_requests SET execution_result=? WHERE id=? AND executed_at IS NULL").run(JSON.stringify({ ok: false, error_code: err.exec.error_code }), requestId) } catch { /* 注解 best-effort */ }
      return { ok: false, error_code: err.exec.error_code, error: err.exec.error, http: err.exec.http }   // 请求保持 approved 可重试
    }
    return { ok: false, error_code: 'EXECUTE_FAILED', error: (err as Error).message, http: 500 }   // 含执行审计写失败 → 已回滚 → 未执行,可重试
  }
}
