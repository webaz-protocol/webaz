// RFC-011 §⑥ 事件游标流单测(真实 appendOrderEvent + listOrderEventsSince)。
// 验证不变量 2(活性 ≤ 读边界):只见自己当事订单的事件;+ 游标分页完备(不重不漏)+ 哈希链字段在。
import Database from 'better-sqlite3'
import { initOrderChainSchema, appendOrderEvent, listOrderEventsSince } from '../src/layer0-foundation/L0-2-state-machine/order-chain.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
initOrderChainSchema(db)
// listOrderEventsSince join orders(party 门);api_keys 表给 appendOrderEvent 签名取 key 用(可空)
db.exec(`
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, logistics_id TEXT);
  CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, role TEXT);
`)
db.prepare("INSERT INTO users (id, api_key, role) VALUES ('alice','k_alice','buyer'),('bob','k_bob','seller'),('carol','k_carol','buyer'),('dave','k_dave','logistics')").run()
// 两个订单:o1(buyer=alice, seller=bob),o2(buyer=carol, seller=bob)
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,logistics_id) VALUES ('o1','alice','bob',NULL),('o2','carol','bob','dave')").run()

// 造事件:o1 三条(open→paid→accepted),o2 两条(open→paid)。appendOrderEvent 用 actor 私钥 HMAC,key 缺省空也能写。
function ev(orderId: string, from: string | null, to: string, actor: string, role: string) {
  appendOrderEvent(db, { orderId, eventType: from === null ? 'open' : 'transition', fromStatus: from, toStatus: to, actorId: actor, actorRole: role })
}
ev('o1', null, 'created', 'alice', 'buyer'); ev('o1', 'created', 'paid', 'alice', 'buyer'); ev('o1', 'paid', 'accepted', 'bob', 'seller')
ev('o2', null, 'created', 'carol', 'buyer'); ev('o2', 'created', 'paid', 'carol', 'buyer')

// ── 不变量 2:party 门 —— alice 只见 o1(3 条),不见 o2 ──
{
  const r = listOrderEventsSince(db, 'alice', undefined, 50)
  expect('alice 见 3 条(仅 o1)', r.events.length === 3, r.events.length)
  expect('alice 不见 o2 任何事件', r.events.every(e => e.order_id === 'o1'))
}
// carol 只见 o2(2 条)
{
  const r = listOrderEventsSince(db, 'carol', undefined, 50)
  expect('carol 见 2 条(仅 o2)', r.events.length === 2 && r.events.every(e => e.order_id === 'o2'), r.events.map(e => e.order_id))
}
// bob 是两单 seller → 见全部 5 条
{
  const r = listOrderEventsSince(db, 'bob', undefined, 50)
  expect('bob(两单卖家)见 5 条', r.events.length === 5, r.events.length)
}
// dave 是 o2 logistics → 见 o2 的 2 条
{
  const r = listOrderEventsSince(db, 'dave', undefined, 50)
  expect('dave(o2 物流)见 2 条(仅 o2)', r.events.length === 2 && r.events.every(e => e.order_id === 'o2'))
}
// 无关 eve → 0
{
  const r = listOrderEventsSince(db, 'eve', undefined, 50)
  expect('无关方 eve 见 0 条', r.events.length === 0 && r.next_cursor === null)
}

// ── 游标分页完备(不重不漏)——bob 5 条,limit=2 翻页 ──
{
  const seen: string[] = []
  let cursor: string | undefined = undefined
  let guard = 0
  for (;;) {
    const r: ReturnType<typeof listOrderEventsSince> = listOrderEventsSince(db, 'bob', cursor, 2)
    for (const e of r.events) seen.push(`${e.order_id}#${e.seq}`)
    if (!r.has_more || r.events.length === 0) break
    cursor = r.next_cursor as string
    if (++guard > 10) break
  }
  expect('分页拿全 5 条', seen.length === 5, seen.length)
  expect('分页无重复', new Set(seen).size === 5, seen)
  expect('分页含 o1#0..2 + o2#0..1', ['o1#0','o1#1','o1#2','o2#0','o2#1'].every(k => seen.includes(k)), seen)
}

// ── 哈希链字段在(验链防篡改)+ cursor 自洽 ──
{
  const r = listOrderEventsSince(db, 'alice', undefined, 50)
  const e0 = r.events[0]
  expect('事件带 event_hash', typeof e0.event_hash === 'string' && e0.event_hash.length > 0)
  expect('genesis prev_event_hash 为 null', e0.prev_event_hash === null, e0.prev_event_hash)
  expect('第二条 prev = 第一条 hash(链连续)', r.events[1].prev_event_hash === r.events[0].event_hash)
  expect('cursor = rowid(纯数字,插入单调)', /^\d+$/.test(e0.cursor))
  expect('不暴露 HMAC signature 字段', !('signature' in (e0 as Record<string, unknown>)))
}

// ── 增量:消费到末尾后,新事件用 next_cursor 能拿到且只拿新的 ──
{
  const r1 = listOrderEventsSince(db, 'alice', undefined, 50)
  const cur = r1.next_cursor as string
  ev('o1', 'accepted', 'shipped', 'bob', 'seller')   // 新事件
  const r2 = listOrderEventsSince(db, 'alice', cur, 50)
  expect('增量只拿到新 1 条', r2.events.length === 1 && r2.events[0].to_status === 'shipped', r2.events.length)
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
