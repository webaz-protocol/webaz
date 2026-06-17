#!/usr/bin/env tsx
/**
 * seller store-reviews double-blind — GET /sellers/me/ratings + reply must honor the reveal rule.
 *   用法:npm run test:seller-ratings-double-blind
 *
 * 铁律(与 GET /orders/:id/rating 一致):卖家看 buyer→seller 评价,必须【自己也评过买家】(buyer_ratings 存在)
 * 或【盲评期已过】(hidden_until 到期);否则遮蔽 + 不能回复。防卖家看了买家评分再反向报复。
 * Codex 复审回归点:hidden_until 在未来 + 无 seller→buyer 评价 → 必须遮蔽 + reply 403。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerRatingsRoutes } from '../src/pwa/routes/ratings.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, handle TEXT, role TEXT)`)
db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT)`)
db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, product_id TEXT, status TEXT)`)
db.exec(`CREATE TABLE order_ratings (order_id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, product_id TEXT, stars INTEGER, comment TEXT, reply TEXT, replied_at TEXT, buyer_followup TEXT, buyer_followup_at TEXT, dim_quality INTEGER, dim_speed INTEGER, dim_service INTEGER, hidden_until TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE buyer_ratings (order_id TEXT PRIMARY KEY, seller_id TEXT, buyer_id TEXT, stars INTEGER, comment TEXT, dim_payment_speed INTEGER, dim_communication INTEGER, dim_responsiveness INTEGER, hidden_until TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.prepare("INSERT INTO users (id,name,handle,role) VALUES ('usr_seller','Seller','seller','seller'),('usr_buyer','Buyer','buyer','buyer')").run()
db.prepare("INSERT INTO products (id,title) VALUES ('prd1','Widget')").run()
setSeamDb(db)

const future = new Date(Date.now() + 14 * 86400 * 1000).toISOString()
const past = new Date(Date.now() - 86400 * 1000).toISOString()
// O1: blind window open (hidden_until future), no seller→buyer rating → must be masked
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status) VALUES ('o1','usr_buyer','usr_seller','prd1','completed')").run()
db.prepare("INSERT INTO order_ratings (order_id,buyer_id,seller_id,product_id,stars,comment,hidden_until) VALUES ('o1','usr_buyer','usr_seller','prd1',2,'slow shipping',?)").run(future)
// O2: blind expired → revealed even without seller→buyer rating
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status) VALUES ('o2','usr_buyer','usr_seller','prd1','completed')").run()
db.prepare("INSERT INTO order_ratings (order_id,buyer_id,seller_id,product_id,stars,comment,hidden_until) VALUES ('o2','usr_buyer','usr_seller','prd1',5,'great',?)").run(past)

let server: Server, port = 0
const call = (method: string, path: string, uid: string, body?: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = body ? JSON.stringify(body) : ''
  const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'x-test-uid': uid, 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); if (p) r.write(p); r.end()
})
const itemFor = (items: any[], oid: string) => items.find(x => x.order_id === oid)

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerRatingsRoutes(app, {
    db,
    generateId: (p: string) => `${p}_x`,
    auth: ((req: Request) => { const id = req.headers['x-test-uid'] as string; return id ? (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any) : null }) as any,
    isTrustedRole: (() => false) as any,
    errorRes: ((res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, error_code: code })) as any,
    broadcastSystemEvent: () => {},
  } as any)
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) blind open + no seller→buyer rating → masked (no stars/comment)
  { const r = await call('GET', '/api/sellers/me/ratings', 'usr_seller')
    const o1 = itemFor(r.json?.items || [], 'o1')
    ok('O1 (blind open, no reciprocal) → masked', !!o1 && o1.masked === true, JSON.stringify(o1))
    ok('O1 masked row leaks NO stars/comment/reply', !!o1 && o1.stars === undefined && o1.comment === undefined && o1.reply === undefined, JSON.stringify(o1)) }

  // 2) reply blocked while blind
  { const r = await call('POST', '/api/orders/o1/rating/reply', 'usr_seller', { reply: 'thanks' })
    ok('O1 reply blocked → 403 RATING_STILL_BLIND', r.status === 403 && r.json?.error_code === 'RATING_STILL_BLIND', JSON.stringify(r.json)) }

  // 3) O2 (blind expired) → revealed even without reciprocal rating
  { const r = await call('GET', '/api/sellers/me/ratings', 'usr_seller')
    const o2 = itemFor(r.json?.items || [], 'o2')
    ok('O2 (blind expired) → revealed with stars/comment', !!o2 && o2.masked === false && o2.stars === 5 && o2.comment === 'great', JSON.stringify(o2)) }
  { const r = await call('POST', '/api/orders/o2/rating/reply', 'usr_seller', { reply: 'cheers' })
    ok('O2 reply allowed after blind expired', r.json?.success === true, JSON.stringify(r.json)) }

  // 4) seller rates the buyer on O1 → O1 now revealed + reply allowed
  db.prepare("INSERT INTO buyer_ratings (order_id,seller_id,buyer_id,stars,hidden_until) VALUES ('o1','usr_seller','usr_buyer',4,?)").run(future)
  { const r = await call('GET', '/api/sellers/me/ratings', 'usr_seller')
    const o1 = itemFor(r.json?.items || [], 'o1')
    ok('O1 revealed after seller rates the buyer', !!o1 && o1.masked === false && o1.stars === 2 && o1.comment === 'slow shipping', JSON.stringify(o1)) }
  { const r = await call('POST', '/api/orders/o1/rating/reply', 'usr_seller', { reply: 'sorry, improving' })
    ok('O1 reply allowed once revealed', r.json?.success === true, JSON.stringify(r.json)) }

  // 5) unreplied count only counts revealed+unreplied (O1/O2 now replied → 0)
  { const r = await call('GET', '/api/sellers/me/ratings', 'usr_seller')
    ok('unreplied agg counts only revealed-unreplied', Number(r.json?.agg?.unreplied) === 0, JSON.stringify(r.json?.agg)) }

  // 6) agg 双盲铁律:某卖家只有【一条 hidden 低分】→ cnt/avg 不得包含它(否则均分泄露买家评分)。
  db.prepare("INSERT INTO users (id,name,handle,role) VALUES ('usr_seller2','S2','seller2','seller')").run()
  db.prepare("INSERT INTO order_ratings (order_id,buyer_id,seller_id,product_id,stars,comment,hidden_until) VALUES ('ox','usr_buyer','usr_seller2','prd1',1,'hidden-low',?)").run(future)
  { const r = await call('GET', '/api/sellers/me/ratings', 'usr_seller2')
    const a = r.json?.agg || {}
    ok('me agg: only-hidden seller → cnt 0 (no leak)', Number(a.cnt) === 0, JSON.stringify(a))
    ok('me agg: only-hidden seller → avg_stars 0 (hidden 1★ NOT averaged in)', Number(a.avg_stars) === 0, JSON.stringify(a))
    ok('me agg: masked_count = 1 (knows a hidden review exists, without its score)', Number(a.masked_count) === 1, JSON.stringify(a))
    const items = r.json?.items || []
    ok('me agg: the only row is masked (no stars exposed)', items.length === 1 && items[0].masked === true && items[0].stars === undefined, JSON.stringify(items)) }

  server.close()

  if (fail === 0) {
    console.log(`\n✅ seller ratings double-blind: /sellers/me/ratings 遮蔽未揭晓评价(无 stars/comment) + reply 403;盲评期过 OR 卖家已反向评价 → 揭晓 + 可回复;unreplied + agg(cnt/avg_stars) 仅计已揭晓(hidden 分不进均分,只回 masked_count)\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ seller ratings double-blind FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
