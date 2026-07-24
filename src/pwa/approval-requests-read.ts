/**
 * RFC-026 PR-2 — 审批请求只读投影(safe scope approval_requests_read)。
 *
 * 让 agent 能回答:审批还在吗 / 批了吗 / 生成了哪张订单 / 是不是重复 / 失败了吗 / 该打开哪个页面 ——
 * 而不必再次调用提交工具去猜。只读本人(human_id 绑定);零 PII(投影字段全是状态/时间/哈希/ID,
 * order_submit 的经济摘要复用 submitRowSummary —— 目的地只有 region 标签)。
 *
 * status_view 派生(对 agent 诚实,不暴露内部态机细节):
 *   executed(executed_at 落了,带 executed_order_id)/ pending / needs_reconcile(order_submit
 *   approved+未执行 = 上次执行结果不明,人再次 Passkey 批准即服务端和解)/ failed(干净失败终态,
 *   重试 = 重新提交)/ rejected / expired(含 pending 超时的惰性派生,不写库)。
 */
import type Database from 'better-sqlite3'
import { submitRowSummary } from './order-submit-request.js'

const COLS = 'id, agent_label, status, risk_level, created_at, expires_at, kind, order_id, order_action, params_hash, intent_hash, executed_at, execution_result'

/** 失败注解只回 error_code(服务端写的短码;绝不透传自由文本)。 */
function failureCode(r: Record<string, unknown>): string | null {
  try { const er = r.execution_result ? JSON.parse(String(r.execution_result)) as { ok?: boolean; error_code?: string } : null; return er && er.ok === false ? String(er.error_code ?? 'EXECUTE_FAILED') : null } catch { return null }
}

function statusView(r: Record<string, unknown>, nowIso: string): string {
  if (r.executed_at) return 'executed'
  const s = String(r.status)
  if (s === 'pending') return String(r.expires_at) <= nowIso ? 'expired' : 'pending'
  if (s === 'approved') {
    if (r.kind === 'order_submit') return 'needs_reconcile'
    if (r.kind === 'order_action') {
      // RFC-021 语义:执行失败【不】置 executed_at,请求保持 approved 可重试,失败注解在 execution_result
      try { const er = r.execution_result ? JSON.parse(String(r.execution_result)) as { ok?: boolean } : null; if (er && er.ok === false) return 'execution_failed' } catch { /* 非 JSON 当无注解 */ }
      return 'approved_retryable'
    }
    return 'approved'
  }
  return s   // failed | rejected | expired
}

function project(db: Database.Database, r: Record<string, unknown>, nowIso: string, full: boolean): Record<string, unknown> {
  const view = statusView(r, nowIso)
  let executedOrderId: string | null = null
  try { const er = r.execution_result ? JSON.parse(String(r.execution_result)) as { order_id?: string } : null; executedOrderId = er?.order_id ?? null } catch { /* 非 JSON 结果不回显 */ }
  const out: Record<string, unknown> = {
    request_id: String(r.id),
    kind: String(r.kind ?? 'scope'),
    action_type: r.kind === 'order_submit' ? 'order_create' : r.kind === 'order_action' ? String(r.order_action ?? '') : 'scope_grant',
    status: view,
    display_status: ({ pending: '待批准', approved: '已批准(执行中)', executed: '已执行 — 正式订单已创建', needs_reconcile: '结果待确认(重新 Passkey 可安全对账)', execution_failed: '执行未完成(可重新批准重试)', approved_retryable: '执行未完成(可重新批准重试)', failed: '失败(条款漂移/草稿失效)', rejected: '已拒绝', expired: '已过期' } as Record<string, string>)[view] ?? view,   // A3-3:display_* 纪律 —— widget 只渲染字符串
    ...(executedOrderId ? { order_url: `/#order/${executedOrderId}` } : {}),   // A3-3:executed → 订单深链(相对;MCP 层 A5 绝对化)
    created_at: String(r.created_at), expires_at: String(r.expires_at),
    approval_url: view === 'pending' || view === 'needs_reconcile' || view === 'execution_failed' || view === 'approved_retryable' ? `/#agent-approvals/${String(r.id)}` : null,
    executed_order_id: executedOrderId,
    params_hash: r.params_hash ?? null,
    intent_fingerprint: r.intent_hash ?? null,
    human_confirmation_required: true,
    ...(view === 'needs_reconcile' ? { note: 'Last execution outcome unknown — the human re-approves with a Passkey to reconcile safely (existing order returned, or execution retried; never a duplicate).' } : {}),
    ...(view === 'failed' ? { note: 'Terminal clean failure (terms drifted / draft unavailable / upstream reject). Retry = submit a fresh request; the human approves a fresh card.' } : {}),
    ...(view === 'execution_failed' || view === 'approved_retryable' ? { failure_reason: failureCode(r), note: 'Execution did not complete — the request stays approved and the human can re-approve with a Passkey to retry (never a duplicate).' } : {}),
  }
  if (full && r.kind === 'order_submit') {
    // fail-visible:单行经济摘要组装失败绝不拖死整条响应(审批页据 summary_unavailable 禁用批准按钮)。
    let rail = ''; let haveSummary = false
    try {
      const sum = submitRowSummary(db, String(r.order_id))
      if (sum) { out.submit_summary = sum; rail = String((sum as Record<string, unknown>).payment_rail || ''); haveSummary = true }
      else out.summary_unavailable = true   // 草稿已不存在 → 经济信息不完整
    } catch { out.summary_unavailable = true }
    // P0-C 诚实披露(rail-aware,fail-visible):金额以 USDC 显示为别名,不代表真实 USDC/法币托管;escrow=模拟测试轨。
    //   Codex R2 P1:摘要不可用时 rail 未知,绝不默认成 escrow 语义(否则对 direct_p2p 谎报"模拟托管扣款")→ moves_funds:null。
    //   B6b-1:usdc_escrow 是【真实链上托管】,单独分支(见下);默认分支保留 WAZ 模拟语义(fail-closed)。
    out.economic_effect = !haveSummary
      ? { moves_funds: null, note: 'economic terms unavailable (draft missing/unreadable) — fund movement cannot be stated; do NOT approve until the terms are readable.' }
      : rail === 'deferred'   // RFC-029 Design A:轨道未选 → 不可批准,绝不谎报成 escrow 语义
        ? { moves_funds: null, rail_choice_pending: true, note: 'payment method NOT chosen yet — choose from the seller\'s supported methods on the confirm page before this request can be approved; do NOT approve until a rail is chosen.' }
        : rail === 'direct_p2p'
          ? { moves_funds: false, simulated: false, note: 'approval creates the REAL order; direct_p2p — WebAZ holds no principal, you pay the seller directly. USDC amounts are a display alias, not a WebAZ settlement.' }
          // B6b-1:usdc_escrow = REAL on-chain custody, and approval itself moves NO funds — it only creates the
          //   order (zero wallets writes, order lands in 'created'). The buyer afterwards signs an on-chain deposit
          //   from their OWN wallet; nothing is ever debited from a WebAZ balance. → moves_funds:false, simulated:false.
          //   Explicit branch; the DEFAULT below stays WAZ-simulated so a future rail can never be mislabelled real.
          : rail === 'usdc_escrow'
            ? { moves_funds: false, simulated: false, note: 'approval creates the REAL order; usdc_escrow — approval alone moves NO funds. You then deposit real USDC on Base from your own wallet into the WebAZ escrow contract; WebAZ never holds the principal and never debits a WebAZ balance.' }
            : { moves_funds: true, simulated: true, note: 'approval creates the REAL order; the escrow rail is a SIMULATED test ledger — USDC amounts are a display alias and do NOT represent real USDC or fiat custody/settlement.' }
  }
  return out
}

export function listApprovalRequests(db: Database.Database, humanId: string): Record<string, unknown> {
  const nowIso = new Date().toISOString()
  const rows = db.prepare(`SELECT ${COLS} FROM agent_permission_requests WHERE human_id = ? ORDER BY created_at DESC LIMIT 50`).all(humanId) as Array<Record<string, unknown>>
  return { requests: rows.map(r => project(db, r, nowIso, false)), note: 'Your own approval requests only (newest first, max 50). Use action=get for the full economic summary of one request.' }
}

export function getApprovalRequest(db: Database.Database, humanId: string, requestId: unknown):
  { ok: true; response: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> } {
  if (typeof requestId !== 'string' || !requestId) return { ok: false, status: 400, body: { error_code: 'REQUEST_NOT_FOUND', reason: 'request_id is required', retryable: true } }
  const r = db.prepare(`SELECT ${COLS} FROM agent_permission_requests WHERE id = ? AND human_id = ?`).get(requestId, humanId) as Record<string, unknown> | undefined
  if (!r) return { ok: false, status: 404, body: { error_code: 'REQUEST_NOT_FOUND', reason: 'no such approval request (or not yours)', retryable: false } }
  return { ok: true, response: project(db, r, new Date().toISOString(), true) }
}
