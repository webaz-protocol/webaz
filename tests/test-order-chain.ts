import Database from 'better-sqlite3'
import {
  initOrderChainSchema, appendOrderEvent, verifyOrderChain, getOrderChain,
  computeEventHash, computeEventSignature, canonicalSerialize,
} from '../src/layer0-foundation/L0-2-state-machine/order-chain.js'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, role TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, buyer_id TEXT, seller_id TEXT);
  CREATE TABLE order_state_history (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT, actor_id TEXT, actor_role TEXT, evidence_ids TEXT, notes TEXT);
`)
initOrderChainSchema(db)
// 测试用：辅助 helper 把每个 chain 事件同步写一条 history（模拟 engine.transition 双写）
function mirrorHistory(orderId: string, fromS: string | null, toS: string, actor: string, role: string) {
  db.prepare(`INSERT INTO order_state_history (id, order_id, from_status, to_status, actor_id, actor_role) VALUES (?,?,?,?,?,?)`)
    .run('h_' + Math.random().toString(36).slice(2), orderId, fromS, toS, actor, role)
}

// Seed actors
db.prepare(`INSERT INTO users VALUES ('u_buyer', 'KEY_BUYER_xxx', 'buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('u_seller', 'KEY_SELLER_yyy', 'seller')`).run()
db.prepare(`INSERT INTO users VALUES ('u_arbi', 'KEY_ARBI_zzz', 'arbitrator')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_t1', 'created', 'u_buyer', 'u_seller')`).run()

let pass = 0, fail = 0
function expect(name: string, cond: boolean, hint?: unknown) {
  if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗', name, hint !== undefined ? JSON.stringify(hint) : '') }
}

// 1. canonical serialize 应该 key 字母序（递归）
const a = canonicalSerialize({ b: 1, a: 2 })
const b = canonicalSerialize({ a: 2, b: 1 })
expect('canonical 顶层顺序无关', a === b, [a, b])
// 1b. 回归 ultrareview bug_012：嵌套对象 / 数组里的对象也要规范化
const nest1 = canonicalSerialize({ x: 1, parties: [{ user_id: 'u1', amount: 10 }, { user_id: 'u2', amount: 5 }] })
const nest2 = canonicalSerialize({ parties: [{ amount: 10, user_id: 'u1' }, { amount: 5, user_id: 'u2' }], x: 1 })
expect('canonical 嵌套对象顺序无关', nest1 === nest2, [nest1, nest2])
// 1c. null / undefined / 标量也能 serialize
expect('canonical 接受 null', canonicalSerialize({ a: null }) === '{"a":null}')
expect('canonical 接受 嵌套数组', canonicalSerialize({ a: [3, 1, 2] }) === '{"a":[3,1,2]}')

// 2. genesis event
const e0 = appendOrderEvent(db, {
  orderId: 'ord_t1', eventType: 'open', fromStatus: null, toStatus: 'created',
  actorId: 'u_buyer', actorRole: 'buyer',
  extra: { product_id: 'prd_x', amount: 280 },
})
expect('genesis seq=0', e0.seq === 0)
expect('genesis prev=null', getOrderChain(db, 'ord_t1')[0].prev_event_hash === null)

// 3. transition events
const e1 = appendOrderEvent(db, {
  orderId: 'ord_t1', eventType: 'transition', fromStatus: 'created', toStatus: 'paid',
  actorId: 'u_buyer', actorRole: 'buyer', extra: { notes: '模拟支付' },
})
mirrorHistory('ord_t1', 'created', 'paid', 'u_buyer', 'buyer')
const e2 = appendOrderEvent(db, {
  orderId: 'ord_t1', eventType: 'transition', fromStatus: 'paid', toStatus: 'accepted',
  actorId: 'u_seller', actorRole: 'seller', extra: { notes: '接单' },
})
mirrorHistory('ord_t1', 'paid', 'accepted', 'u_seller', 'seller')
expect('seq 递增 0/1/2', e1.seq === 1 && e2.seq === 2)
expect('e1.prev=e0.hash', getOrderChain(db, 'ord_t1')[1].prev_event_hash === e0.event_hash)
expect('e2.prev=e1.hash', getOrderChain(db, 'ord_t1')[2].prev_event_hash === e1.event_hash)

// 4. 完整链验证通过
const v1 = verifyOrderChain(db, 'ord_t1')
expect('verify ok 3 events', v1.ok === true && v1.total === 3 && v1.verified === 3, v1)

// 5. 模拟篡改 — 修改第 1 条 event 的 payload，应该 hash 不匹配
db.prepare(`UPDATE order_events SET payload_json = ? WHERE order_id='ord_t1' AND seq=1`).run('{"tampered":true}')
const v2 = verifyOrderChain(db, 'ord_t1')
expect('tamper detected', !v2.ok && v2.reason === 'event_hash_mismatch', v2)
expect('first broken = seq 1', v2.firstBrokenSeq === 1, v2)
// 6. 模拟伪造签名 — actor 没改但 signature 被换
// 先重新建链
db.prepare(`DELETE FROM order_events WHERE order_id='ord_t1'`).run()
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'open', fromStatus: null, toStatus: 'created', actorId: 'u_buyer', actorRole: 'buyer' })
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'transition', fromStatus: 'created', toStatus: 'paid', actorId: 'u_buyer', actorRole: 'buyer' })
db.prepare(`UPDATE order_events SET signature='deadbeef' WHERE order_id='ord_t1' AND seq=1`).run()
const v3 = verifyOrderChain(db, 'ord_t1')
expect('forged signature detected', !v3.ok && v3.reason === 'signature_mismatch', v3)

// 7. 链续断 — 修改 prev_event_hash
db.prepare(`DELETE FROM order_events WHERE order_id='ord_t1'`).run()
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'open', fromStatus: null, toStatus: 'created', actorId: 'u_buyer', actorRole: 'buyer' })
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'transition', fromStatus: 'created', toStatus: 'paid', actorId: 'u_buyer', actorRole: 'buyer' })
db.prepare(`UPDATE order_events SET prev_event_hash='aaa000' WHERE order_id='ord_t1' AND seq=1`).run()
const v4 = verifyOrderChain(db, 'ord_t1')
expect('prev_hash 断链 detected', !v4.ok && v4.reason === 'prev_hash_mismatch', v4)

// 8. 删事件（再后续 hash 链对不上）— 模拟 seq=1 被删
db.prepare(`DELETE FROM order_events WHERE order_id='ord_t1'`).run()
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'open', fromStatus: null, toStatus: 'created', actorId: 'u_buyer', actorRole: 'buyer' })
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'transition', fromStatus: 'created', toStatus: 'paid', actorId: 'u_buyer', actorRole: 'buyer' })
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'transition', fromStatus: 'paid', toStatus: 'accepted', actorId: 'u_seller', actorRole: 'seller' })
db.prepare(`DELETE FROM order_events WHERE order_id='ord_t1' AND seq=1`).run()
const v5 = verifyOrderChain(db, 'ord_t1')
expect('delete middle event detected', !v5.ok, v5)

// 9. Actor api_key 旋转后旧签名应失败（这就是为什么 dispute 要拿到 key 快照）
db.prepare(`DELETE FROM order_events WHERE order_id='ord_t1'`).run()
db.prepare(`DELETE FROM order_state_history WHERE order_id='ord_t1'`).run()
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'open', fromStatus: null, toStatus: 'created', actorId: 'u_buyer', actorRole: 'buyer' })
db.prepare(`UPDATE users SET api_key='NEW_KEY' WHERE id='u_buyer'`).run()
const v6 = verifyOrderChain(db, 'ord_t1')
expect('key rotated → sig fails', !v6.ok && v6.reason === 'signature_mismatch', v6)

// 10. 回归 ultrareview bug_007：silent append failure 必须被 history 计数检测出来
db.prepare(`DELETE FROM order_events WHERE order_id='ord_t1'`).run()
db.prepare(`DELETE FROM order_state_history WHERE order_id='ord_t1'`).run()
// 模拟 engine.transition() 双写场景：3 次 transition，其中第 2 次 chain append 失败但 history 仍写
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'transition', fromStatus: 'created', toStatus: 'paid', actorId: 'u_buyer', actorRole: 'buyer' })
mirrorHistory('ord_t1', 'created', 'paid', 'u_buyer', 'buyer')
// 这次 chain 没 append（模拟 silent failure），但 history 写了
mirrorHistory('ord_t1', 'paid', 'accepted', 'u_seller', 'seller')
appendOrderEvent(db, { orderId: 'ord_t1', eventType: 'transition', fromStatus: 'accepted', toStatus: 'shipped', actorId: 'u_seller', actorRole: 'seller' })
mirrorHistory('ord_t1', 'accepted', 'shipped', 'u_seller', 'seller')
const vIncomplete = verifyOrderChain(db, 'ord_t1')
expect('silent append drop → chain_incomplete', !vIncomplete.ok && vIncomplete.reason === 'chain_incomplete', vIncomplete)
expect('history_count 透传', vIncomplete.history_count === 3, vIncomplete)

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
