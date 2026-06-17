// 验证仲裁证据 → SNF + 仲裁裁决 → order_chain 这两条新通路
// 用临时 :memory: DB 构造最小场景，直接调底层 helpers 模拟服务层逻辑
import Database from 'better-sqlite3'
import { initOrderChainSchema, appendOrderEvent, getOrderChain } from '../src/layer0-foundation/L0-2-state-machine/order-chain.js'
import { initSnfSchema, snfSend, snfPullInbox } from '../src/layer2-business/L2-7-snf/snf-engine.js'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, role TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, buyer_id TEXT, seller_id TEXT);
  CREATE TABLE disputes (id TEXT PRIMARY KEY, order_id TEXT, initiator_id TEXT, defendant_id TEXT,
                         status TEXT, assigned_arbitrators TEXT);
`)
initOrderChainSchema(db)
initSnfSchema(db)

db.prepare(`INSERT INTO users VALUES ('buyer1', 'KB', 'buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('seller1', 'KS', 'seller')`).run()
db.prepare(`INSERT INTO users VALUES ('arb1', 'KA', 'arbitrator')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_t', 'disputed', 'buyer1', 'seller1')`).run()
db.prepare(`INSERT INTO disputes VALUES ('dsp_t', 'ord_t', 'buyer1', 'seller1', 'open', '["arb1"]')`).run()

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ─── 模拟 add-evidence 流程（路由内的 SNF fanout 逻辑）───
const d = db.prepare(`SELECT order_id, initiator_id, defendant_id, assigned_arbitrators FROM disputes WHERE id = ?`).get('dsp_t') as { order_id: string; initiator_id: string; defendant_id: string; assigned_arbitrators: string }
const sender = 'buyer1'
const recipients = new Set<string>()
if (d.initiator_id !== sender) recipients.add(d.initiator_id)
if (d.defendant_id !== sender) recipients.add(d.defendant_id)
for (const a of JSON.parse(d.assigned_arbitrators)) if (a !== sender) recipients.add(a)
const envelope = { dispute_id: 'dsp_t', evidence_id: 'ev_t', anchor_hash: 'h_t', evidence_type: 'text', description: '货损照片', file_hash: 'sha256_xxx' }
for (const rid of recipients) {
  snfSend(db, { senderId: sender, recipientId: rid, messageType: 'dispute_evidence', payload: envelope, priority: 1, relatedOrderId: d.order_id })
}
const sellerInbox = snfPullInbox(db, 'seller1')
const arbInbox = snfPullInbox(db, 'arb1')
expect('seller 拿到证据信封', sellerInbox.length === 1 && sellerInbox[0].message_type === 'dispute_evidence', sellerInbox)
expect('arb 拿到证据信封',   arbInbox.length === 1 && arbInbox[0].priority === 1, arbInbox)
expect('payload 含 description',  sellerInbox[0].payload.description === '货损照片')
expect('payload 含 file_hash',    sellerInbox[0].payload.file_hash === 'sha256_xxx')
expect('related_order_id 关联',   sellerInbox[0].related_order_id === 'ord_t')

// ─── 模拟仲裁判决流程 ───
// 假设 order chain 已有 open + dispute_open
appendOrderEvent(db, { orderId: 'ord_t', eventType: 'open', fromStatus: null, toStatus: 'created', actorId: 'buyer1', actorRole: 'buyer' })
appendOrderEvent(db, { orderId: 'ord_t', eventType: 'transition', fromStatus: 'paid', toStatus: 'disputed', actorId: 'buyer1', actorRole: 'buyer' })

// 仲裁员裁决签名事件
appendOrderEvent(db, {
  orderId: 'ord_t', eventType: 'transition',
  fromStatus: 'disputed', toStatus: 'disputed',
  actorId: 'arb1', actorRole: 'arbitrator',
  extra: { action: 'arbitration_ruling', dispute_id: 'dsp_t', ruling: 'refund_buyer', reason: '证据充分 - 货损' },
})

const chain = getOrderChain(db, 'ord_t')
expect('chain 含 3 个事件', chain.length === 3)
const rulingEv = chain[2]
expect('裁决事件 actor=arb',     rulingEv.actor_id === 'arb1' && rulingEv.actor_role === 'arbitrator')
expect('裁决事件含 action 标识', (rulingEv.payload.action as string) === 'arbitration_ruling')
expect('裁决事件含 ruling',     (rulingEv.payload.ruling as string) === 'refund_buyer')
expect('prev 指向 dispute_open', rulingEv.prev_event_hash === chain[1].event_hash)

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
