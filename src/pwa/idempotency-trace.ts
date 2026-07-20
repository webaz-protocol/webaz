/**
 * BUG-08 §七 — zero-PII idempotency/duplicate diagnostic trace (append-only).
 *
 * Answers "did the user click twice / did the component call twice / did the host or HTTP retry / did the
 * handler run twice / was there a DB unique race / which request did a duplicate reuse / was exactly one
 * order created" WITHOUT any PII. Only hashes + machine codes are stored; the full idempotency_key,
 * addresses, names, phones, cookies, OAuth tokens, Passkey, payment credentials, and chat/NL bodies are
 * NEVER written. FAIL-OPEN: a trace-write error is swallowed — it must never block the trade (§九.13).
 * This table is a diagnostic log, never a money/state authority.
 */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

const keyHash = (k: unknown): string | null => (typeof k === 'string' && k) ? createHash('sha256').update(k).digest('hex').slice(0, 16) : null
const prefix = (h: unknown, n: number): string | null => (typeof h === 'string' && h) ? h.slice(0, n) : null
// Defensive cap: any client-supplied id (trace_id / interaction_id / bridge_type / tool_call_id / …) is
// truncated so the zero-PII diagnostic table can never store unbounded raw text (route validates the
// three identity tokens more strictly; this backstops the rest).
const str = (v: unknown): string | null => v == null ? null : String(v).slice(0, 128)

export interface IdemTraceInput {
  traceId?: unknown; interactionId?: unknown; operationAttemptId?: unknown; widgetSessionId?: unknown
  bridgeType?: unknown; toolCallId?: unknown; mcpRequestId?: unknown; toolName?: unknown; handlerAttempt?: unknown
  idempotencyKey?: unknown; purchaseIntentInstance?: unknown; intentHash?: unknown
  draftId?: unknown; requestId?: unknown; orderId?: unknown
  duplicate?: boolean; duplicateReason?: unknown; duplicateOf?: unknown
  resultStatus?: unknown; retryCount?: unknown; receivedAt?: unknown; completedAt?: unknown
  generateId: (p: string) => string
}

/** Record one trace row. Zero-PII (hashes + machine codes only). Never throws — a diagnostic write must
 *  not affect the transaction result. Returns true if written, false if it fail-opened. */
export function recordIdempotencyTrace(db: Database.Database, t: IdemTraceInput): boolean {
  try {
    db.prepare(`INSERT INTO agent_idempotency_trace
        (id, trace_id, interaction_id, operation_attempt_id, widget_session_id, bridge_type, tool_call_id,
         mcp_request_id, tool_name, handler_attempt, idempotency_key_hash, purchase_intent_instance,
         intent_hash_prefix, draft_id, request_id, order_id, duplicate, duplicate_reason, duplicate_of,
         result_status, retry_count, received_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        t.generateId('idt'), str(t.traceId), str(t.interactionId), str(t.operationAttemptId), str(t.widgetSessionId),
        str(t.bridgeType), str(t.toolCallId), str(t.mcpRequestId), str(t.toolName),
        t.handlerAttempt == null ? null : Number(t.handlerAttempt),
        keyHash(t.idempotencyKey), str(t.purchaseIntentInstance), prefix(t.intentHash, 12),
        str(t.draftId), str(t.requestId), str(t.orderId),
        t.duplicate ? 1 : 0, str(t.duplicateReason), str(t.duplicateOf),
        str(t.resultStatus), t.retryCount == null ? null : Number(t.retryCount),
        str(t.receivedAt), str(t.completedAt),
      )
    return true
  } catch { return false /* fail-open: never block the trade on a diagnostic write */ }
}
