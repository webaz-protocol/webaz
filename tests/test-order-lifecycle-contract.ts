// RFC-011 §① 实体字典 coverage/lock 测试 —— 状态机 doc=code 不漂移 + 无 PII 泄漏。
import { VALID_TRANSITIONS, ORDER_STATE_MEANINGS, orderLifecycleContract } from '../src/layer0-foundation/L0-2-state-machine/transitions.js'
import { buildEntityDictionary } from '../src/pwa/entity-dictionary.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const contract = orderLifecycleContract()
const meaningKeys = new Set(Object.keys(ORDER_STATE_MEANINGS))

// ── 覆盖:转移里出现的每个状态都必须有含义(防"暴露了状态却没含义")──
const statesInTransitions = new Set<string>()
for (const key of Object.keys(VALID_TRANSITIONS)) {
  const a = key.indexOf('→'); statesInTransitions.add(key.slice(0, a)); statesInTransitions.add(key.slice(a + 1))
}
{
  const missing = [...statesInTransitions].filter(s => !meaningKeys.has(s))
  expect('每个转移涉及的状态都有含义(coverage)', missing.length === 0, missing)
}
// 含义表覆盖 23 个 OrderStatus(防遗漏;2026-06-27 +2 Direct Pay: direct_pay_window / direct_expired_unconfirmed;2026-07-03 +1 payment_query 货款协商)
expect('ORDER_STATE_MEANINGS 含 26 状态', meaningKeys.size === 26, meaningKeys.size)   // v16 +pending_accept;PR-B +delivery_failed;B3b +return_pending

// ── 锁定:契约转移数 == VALID_TRANSITIONS(doc=code,生成不漏)──
expect('契约转移数 == VALID_TRANSITIONS', contract.transitions.length === Object.keys(VALID_TRANSITIONS).length, { c: contract.transitions.length, v: Object.keys(VALID_TRANSITIONS).length })
{
  const contractKeys = new Set(contract.transitions.map(t => `${t.from}→${t.to}`))
  const allPresent = Object.keys(VALID_TRANSITIONS).every(k => contractKeys.has(k))
  expect('每条 VALID_TRANSITIONS 都在契约里', allPresent)
}
// 转移带 allowed_roles + description(集成方需要的)
expect('转移带 allowed_roles + description', contract.transitions.every(t => Array.isArray(t.allowed_roles) && t.allowed_roles.length > 0 && typeof t.description === 'string' && t.description.length > 0))

// ── 终态正确(无出边)──
const stMap = new Map(contract.states.map(s => [s.state, s]))
expect('completed 是终态', stMap.get('completed')?.terminal === true)
expect('declined_nofault 非终态(→completed 结算)', stMap.get('declined_nofault')?.terminal === false)
expect('fault_seller 非终态(→declined_nofault/completed)', stMap.get('fault_seller')?.terminal === false)
expect('refunded_full 是终态', stMap.get('refunded_full')?.terminal === true)
expect('paid 非终态', stMap.get('paid')?.terminal === false)
expect('disputed 非终态', stMap.get('disputed')?.terminal === false)
// responsible 注入(paid 等卖家)
expect('paid responsible = seller', stMap.get('paid')?.responsible === 'seller')

// ── 安全:实体字典无 PII / 身份字段泄漏 ──
const dict = buildEntityDictionary()
const orderFields = new Set(dict.entities.order.public_fields.map(f => f.field))
for (const pii of ['shipping_address', 'recipient_code', 'buyer_id', 'seller_id', 'logistics_id', 'escrow_amount']) {
  expect(`公开字段不含 PII/身份/内部:${pii}`, !orderFields.has(pii))
}
expect('字典声明 pii_excluded(让集成方知道边界)', Array.isArray(dict.entities.order.pii_excluded) && dict.entities.order.pii_excluded.length > 0)
expect('字典含 lifecycle(状态机)', dict.entities.order.lifecycle.transitions.length === Object.keys(VALID_TRANSITIONS).length)
expect('字典带版本双轴', typeof dict.software_version === 'string' && typeof dict.contract_version === 'number')
expect('字典标可验证(指 ⑤⑥)', /agent\/events/.test(dict.entities.order.verifiable.state_changes) && /chain/.test(dict.entities.order.verifiable.state_changes))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
