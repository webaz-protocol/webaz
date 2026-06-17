// L2-5 评价系统：结构化维度 + 反向评价 + 声誉反哺 + 双盲窗口
import Database from 'better-sqlite3'
import {
  initReputationSchema, recordRatingReputation, getReputation,
} from '../src/layer4-economics/L4-3-reputation/reputation-engine.js'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, name TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, status TEXT);
`)
initReputationSchema(db)

// 复制 server.ts 的两张评价表（只挑评价相关列）
db.exec(`
  CREATE TABLE order_ratings (
    order_id     TEXT PRIMARY KEY,
    buyer_id     TEXT NOT NULL,
    seller_id    TEXT NOT NULL,
    product_id   TEXT NOT NULL,
    stars        INTEGER NOT NULL,
    comment      TEXT,
    dim_quality INTEGER,
    dim_speed INTEGER,
    dim_service INTEGER,
    hidden_until TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE buyer_ratings (
    order_id              TEXT PRIMARY KEY,
    seller_id             TEXT NOT NULL,
    buyer_id              TEXT NOT NULL,
    stars                 INTEGER NOT NULL,
    comment               TEXT,
    dim_payment_speed     INTEGER,
    dim_communication     INTEGER,
    dim_responsiveness    INTEGER,
    hidden_until          TEXT,
    created_at            TEXT DEFAULT (datetime('now'))
  );
`)

db.prepare(`INSERT INTO users VALUES ('seller1','seller','卖家A')`).run()
db.prepare(`INSERT INTO users VALUES ('buyer1','buyer','买家A')`).run()
db.prepare(`INSERT INTO users VALUES ('buyer2','buyer','买家B')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_1','buyer1','seller1','completed')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_2','buyer2','seller1','completed')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_3','buyer1','seller1','completed')`).run()

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// 1. 5 星好评 → 卖家 +3
recordRatingReputation(db, { orderId: 'ord_1', revieweeId: 'seller1', revieweeRole: 'seller', stars: 5 })
const r1 = getReputation(db, 'seller1')
expect('5 星 → seller +3', r1.total_points === 3, r1.total_points)

// 2. 4 星仍是好评 → +3
recordRatingReputation(db, { orderId: 'ord_2', revieweeId: 'seller1', revieweeRole: 'seller', stars: 4 })
const r2 = getReputation(db, 'seller1')
expect('4 星仍计 good → +3', r2.total_points === 6, r2.total_points)

// 3. 3 星中评 → 0 (但事件入账)
recordRatingReputation(db, { orderId: 'ord_3', revieweeId: 'seller1', revieweeRole: 'seller', stars: 3 })
const r3 = getReputation(db, 'seller1')
expect('3 星 0 分（无变化）', r3.total_points === 6, r3.total_points)
const neutralEvent = db.prepare(`SELECT event_type FROM reputation_events WHERE order_id='ord_3' AND user_id='seller1'`).get() as { event_type: string }
expect('3 星事件类型 = rating_received_neutral', neutralEvent.event_type === 'rating_received_neutral')

// 4. 1 星差评 → 卖家 -5
db.prepare(`INSERT INTO orders VALUES ('ord_4','buyer2','seller1','completed')`).run()
recordRatingReputation(db, { orderId: 'ord_4', revieweeId: 'seller1', revieweeRole: 'seller', stars: 1 })
const r4 = getReputation(db, 'seller1')
expect('1 星 → seller -5', r4.total_points === 1, r4.total_points)

// 5. 2 星也算差评 → -5
db.prepare(`INSERT INTO orders VALUES ('ord_5','buyer1','seller1','completed')`).run()
recordRatingReputation(db, { orderId: 'ord_5', revieweeId: 'seller1', revieweeRole: 'seller', stars: 2 })
const r5 = getReputation(db, 'seller1')
expect('2 星仍差评 → -5', r5.total_points === 0, r5.total_points) // max(0, 1-5) = 0

// 6. 反向评价：卖家给买家 5 星 → 买家 +3
recordRatingReputation(db, { orderId: 'ord_1', revieweeId: 'buyer1', revieweeRole: 'buyer', stars: 5 })
const r6 = getReputation(db, 'buyer1')
expect('seller→buyer 5 星 → buyer +3', r6.total_points === 3, r6.total_points)

// 7. 同 reviewee 多次评价 → 累计
db.prepare(`INSERT INTO orders VALUES ('ord_6','buyer1','seller1','completed')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_7','buyer1','seller1','completed')`).run()
recordRatingReputation(db, { orderId: 'ord_6', revieweeId: 'buyer1', revieweeRole: 'buyer', stars: 4 })
recordRatingReputation(db, { orderId: 'ord_7', revieweeId: 'buyer1', revieweeRole: 'buyer', stars: 4 })
const r7 = getReputation(db, 'buyer1')
expect('累计 3 次 good 评 → +9', r7.total_points === 9, r7.total_points)

// 8. 评价不会让分数变负
// seller1 当前 0 分；再给个 1 星，仍是 0
db.prepare(`INSERT INTO orders VALUES ('ord_8','buyer2','seller1','completed')`).run()
recordRatingReputation(db, { orderId: 'ord_8', revieweeId: 'seller1', revieweeRole: 'seller', stars: 1 })
const r8 = getReputation(db, 'seller1')
expect('差评打底 0 不会变负', r8.total_points === 0, r8.total_points)

// 9. dim 字段可正确写入 order_ratings
db.prepare(`INSERT INTO order_ratings (order_id, buyer_id, seller_id, product_id, stars, dim_quality, dim_speed, dim_service)
  VALUES ('ord_1','buyer1','seller1','prd_x',5,5,4,5)`).run()
const dim9 = db.prepare(`SELECT dim_quality, dim_speed, dim_service FROM order_ratings WHERE order_id='ord_1'`).get() as { dim_quality: number; dim_speed: number; dim_service: number }
expect('dim 维度持久化', dim9.dim_quality === 5 && dim9.dim_speed === 4 && dim9.dim_service === 5)

// 10. buyer_ratings 反向写入
db.prepare(`INSERT INTO buyer_ratings (order_id, seller_id, buyer_id, stars, dim_payment_speed, dim_communication, dim_responsiveness, hidden_until)
  VALUES ('ord_2','seller1','buyer2',4,5,4,3, datetime('now','+14 days'))`).run()
const dim10 = db.prepare(`SELECT dim_payment_speed, dim_communication, dim_responsiveness, hidden_until FROM buyer_ratings WHERE order_id='ord_2'`).get() as { dim_payment_speed: number; dim_communication: number; dim_responsiveness: number; hidden_until: string }
expect('buyer_ratings 反向 dim 持久化', dim10.dim_payment_speed === 5 && dim10.dim_communication === 4 && dim10.dim_responsiveness === 3)
expect('hidden_until 设到 14 天后', !!dim10.hidden_until)

// 11. 双盲窗口 SQL — 卖家未反向评 + 窗口未到 → 评价应被隐藏
db.prepare(`INSERT INTO order_ratings (order_id, buyer_id, seller_id, product_id, stars, hidden_until)
  VALUES ('ord_blind','buyer1','seller1','prd_x',2, datetime('now','+14 days'))`).run()
const blindHidden = db.prepare(`
  SELECT order_id FROM order_ratings r
  WHERE order_id = 'ord_blind' AND (
    EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id)
    OR r.hidden_until IS NULL
    OR datetime(r.hidden_until) <= datetime('now')
  )
`).get()
expect('双盲未触发条件 → 公开列表中查不到', !blindHidden)

// 12. 卖家反向评后 → 评价立即可见
db.prepare(`INSERT INTO buyer_ratings (order_id, seller_id, buyer_id, stars, hidden_until)
  VALUES ('ord_blind','seller1','buyer1',5, datetime('now','+14 days'))`).run()
const blindUnhidden = db.prepare(`
  SELECT order_id FROM order_ratings r
  WHERE order_id = 'ord_blind' AND (
    EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id)
    OR r.hidden_until IS NULL
    OR datetime(r.hidden_until) <= datetime('now')
  )
`).get()
expect('双方都评后 → 公开列表立即出现', !!blindUnhidden)

// 13. 窗口到期 → 即使单方也可见
db.prepare(`INSERT INTO order_ratings (order_id, buyer_id, seller_id, product_id, stars, hidden_until)
  VALUES ('ord_expire','buyer1','seller1','prd_x',3, datetime('now','-1 day'))`).run()
const expired = db.prepare(`
  SELECT order_id FROM order_ratings r
  WHERE order_id = 'ord_expire' AND (
    EXISTS (SELECT 1 FROM buyer_ratings br WHERE br.order_id = r.order_id)
    OR r.hidden_until IS NULL
    OR datetime(r.hidden_until) <= datetime('now')
  )
`).get()
expect('窗口到期 → 单方评价也可见', !!expired)

// 14. 反向评价：买家给卖家差评后，卖家也回差评 → 双方都被扣分
db.prepare(`INSERT INTO orders VALUES ('ord_revenge','buyer2','seller1','completed')`).run()
const beforeBuyer = getReputation(db, 'buyer2').total_points
recordRatingReputation(db, { orderId: 'ord_revenge', revieweeId: 'seller1', revieweeRole: 'seller', stars: 1 })
recordRatingReputation(db, { orderId: 'ord_revenge', revieweeId: 'buyer2', revieweeRole: 'buyer', stars: 1 })
const afterBuyer = getReputation(db, 'buyer2')
expect('买家收到差评后也扣 5 分', afterBuyer.total_points === Math.max(0, beforeBuyer - 5), { before: beforeBuyer, after: afterBuyer.total_points })

// 15. recent_events 含 rating 类型
const eventsTypes = db.prepare(`SELECT DISTINCT event_type FROM reputation_events WHERE event_type LIKE 'rating_%'`).all() as Array<{ event_type: string }>
const types = new Set(eventsTypes.map(e => e.event_type))
expect('rating_received_good/neutral/bad 三种事件都出现', types.has('rating_received_good') && types.has('rating_received_neutral') && types.has('rating_received_bad'))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
