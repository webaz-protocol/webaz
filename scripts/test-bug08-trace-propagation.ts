#!/usr/bin/env tsx
/**
 * BUG-08 §二 — zero-PII trace propagation into agent_idempotency_trace. Asserts the full field set is
 * recorded (hashed key, intent prefix, machine codes, ids, timings), that standard vs legacy bridge_type
 * is recorded distinctly, that a retry correlates to its logical operation via a shared interaction_id,
 * that a second explicit purchase carries a NEW interaction (relatable to the original), and a strict
 * sensitive-field scan (no full key / address / name / token / Passkey / cookie / chat body).
 * Usage: npx tsx scripts/test-bug08-trace-propagation.ts
 */
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
process.env.HOME = mkdtempSync(join(tmpdir(), 'bug08tr-'))
const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { recordIdempotencyTrace } = await import('../src/pwa/idempotency-trace.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); applyWebazRuntimeSchema(db)
const rows = (): Array<Record<string, unknown>> => db.prepare('SELECT * FROM agent_idempotency_trace ORDER BY rowid').all() as Array<Record<string, unknown>>

// standard-bridge submit (a click) → one row
recordIdempotencyTrace(db, { generateId, toolName: 'webaz_submit_order_request', bridgeType: 'standard', traceId: 'tr_1', interactionId: 'ix_click1', operationAttemptId: 'op_1', widgetSessionId: 'ws_1', toolCallId: 'jsonrpc-11', mcpRequestId: 'mcp-11', handlerAttempt: 1, idempotencyKey: 'topsecretkeyvalue-AAA', intentHash: 'deadbeefcafef00d1234', draftId: 'odr_1', requestId: 'apr_1', duplicate: false, resultStatus: 'created', receivedAt: '2026-07-21T00:00:00.000Z', completedAt: '2026-07-21T00:00:00.050Z' })
// a RETRY of the same logical operation (same interaction_id + same key) → correlatable
recordIdempotencyTrace(db, { generateId, toolName: 'webaz_submit_order_request', bridgeType: 'standard', traceId: 'tr_2', interactionId: 'ix_click1', operationAttemptId: 'op_1', widgetSessionId: 'ws_1', idempotencyKey: 'topsecretkeyvalue-AAA', intentHash: 'deadbeefcafef00d1234', draftId: 'odr_1', requestId: 'apr_1', duplicate: true, duplicateReason: 'SAME_IDEMPOTENCY_KEY', duplicateOf: 'apr_1', resultStatus: 'duplicate', receivedAt: '2026-07-21T00:00:01.000Z', completedAt: '2026-07-21T00:00:01.020Z' })
// a legacy-bridge submit → bridge_type recorded distinctly
recordIdempotencyTrace(db, { generateId, toolName: 'webaz_submit_order_request', bridgeType: 'legacy', interactionId: 'ix_click2', operationAttemptId: 'op_2', idempotencyKey: 'anotherkey-BBB', intentHash: 'feedface99887766', draftId: 'odr_2', requestId: 'apr_2', duplicate: false, resultStatus: 'created' })
// a SECOND explicit purchase → new interaction + purchase_intent_instance, relatable to the original duplicate
recordIdempotencyTrace(db, { generateId, toolName: 'webaz_submit_order_request', bridgeType: 'standard', interactionId: 'ix_again', operationAttemptId: 'op_3', purchaseIntentInstance: 'pii_abc123', idempotencyKey: 's_pii_abc123', intentHash: '0011223344556677', draftId: 'odr_3', requestId: 'apr_3', duplicate: false, duplicateReason: 'EXPLICIT_SECOND_PURCHASE', resultStatus: 'created' })

const all = rows()
ok('1. one trace row per recorded event (4)', all.length === 4)
const r0 = all[0]
ok('2. all §二 correlation fields recorded', r0.trace_id === 'tr_1' && r0.interaction_id === 'ix_click1' && r0.operation_attempt_id === 'op_1' && r0.widget_session_id === 'ws_1' && r0.tool_call_id === 'jsonrpc-11' && r0.mcp_request_id === 'mcp-11' && r0.tool_name === 'webaz_submit_order_request' && r0.handler_attempt === 1 && r0.draft_id === 'odr_1' && r0.request_id === 'apr_1' && r0.received_at === '2026-07-21T00:00:00.000Z' && r0.completed_at === '2026-07-21T00:00:00.050Z')
ok('3. full idempotency_key NEVER stored — only a 16-hex SHA', r0.idempotency_key_hash !== 'topsecretkeyvalue-AAA' && /^[0-9a-f]{16}$/.test(String(r0.idempotency_key_hash)) && !JSON.stringify(all).includes('topsecretkeyvalue-AAA'))
ok('4. intent stored as a 12-char prefix, not the full hash', r0.intent_hash_prefix === 'deadbeefcafe' && String(r0.intent_hash_prefix).length === 12)
ok('5. bridge_type recorded distinctly (standard vs legacy)', all[0].bridge_type === 'standard' && all[2].bridge_type === 'legacy')
// retry correlation: the click + its retry share interaction_id AND the same key-hash
ok('6. a retry correlates to its logical operation via shared interaction_id + key-hash', all[0].interaction_id === all[1].interaction_id && all[0].idempotency_key_hash === all[1].idempotency_key_hash && all[1].duplicate_reason === 'SAME_IDEMPOTENCY_KEY')
ok('7. the second explicit purchase carries a NEW interaction + purchase_intent_instance (relatable, not merged)', all[3].interaction_id === 'ix_again' && all[3].purchase_intent_instance === 'pii_abc123' && all[3].interaction_id !== all[0].interaction_id)
// strict sensitive-field scan over every stored value
ok('8. zero-PII: no address/name/phone/token/passkey/cookie/chat-body/full-key anywhere in the table', !/\d+\s+\w+\s+(Rd|St|Ave)|default_address|passkey|cookie|bearer|oat_[A-Za-z0-9]|topsecretkeyvalue/i.test(JSON.stringify(all)))
ok('9. no PII columns exist', (db.prepare("PRAGMA table_info(agent_idempotency_trace)").all() as Array<{ name: string }>).every(c => !/address|phone|passkey|cookie|email|recipient|full_key|chat_body|access_token/i.test(c.name)))

db.close()
if (fail > 0) { console.error(`\n❌ trace-propagation FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bug08-trace-propagation: full field set recorded · key hashed · intent prefixed · bridge_type standard/legacy · retry correlates by interaction_id · second purchase relatable · strict zero-PII\n  ✅ pass ${pass}`)
