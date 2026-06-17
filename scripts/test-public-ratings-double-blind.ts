#!/usr/bin/env tsx
/**
 * public rating surfaces honor double-blind — unrevealed ratings must not leak publicly.
 *   用法:npm run test:public-ratings-double-blind
 *
 * 揭晓(blindOpen) = 双方都评过(buyer_ratings 存在) OR 无盲评窗口(hidden_until 空) OR 盲评期已过。
 * 公开面只能展示已揭晓的评价(与 GET /products/:id/ratings 同条件):
 *   - GET /api/sellers/:seller_id/ratings(行为测试)
 *   - 店铺主页 shops.ts rating agg + recent(静态断言 SQL 含 blindOpen)
 * 防:盲评期内、买家先评卖家未回评时,公开店铺/卖家页提前泄露买家评分。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
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
db.exec(`CREATE TABLE order_ratings (order_id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, product_id TEXT, stars INTEGER, comment TEXT, reply TEXT, replied_at TEXT, buyer_followup TEXT, buyer_followup_at TEXT, hidden_until TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE buyer_ratings (order_id TEXT PRIMARY KEY, seller_id TEXT, buyer_id TEXT, stars INTEGER, hidden_until TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.prepare("INSERT INTO users (id,name,handle,role) VALUES ('usr_seller','S','seller','seller'),('usr_buyer','B','buyer','buyer')").run()
db.prepare("INSERT INTO products (id,title) VALUES ('prd1','Widget')").run()
setSeamDb(db)

const future = new Date(Date.now() + 14 * 86400 * 1000).toISOString()
const past = new Date(Date.now() - 86400 * 1000).toISOString()
// o1: 未揭晓(盲评窗口未过 + 无反向评价)→ 公开必须看不到
db.prepare("INSERT INTO order_ratings (order_id,buyer_id,seller_id,product_id,stars,comment,hidden_until) VALUES ('o1','usr_buyer','usr_seller','prd1',1,'BAD-should-be-hidden',?)").run(future)
// o2: 盲评期已过 → 揭晓
db.prepare("INSERT INTO order_ratings (order_id,buyer_id,seller_id,product_id,stars,comment,hidden_until) VALUES ('o2','usr_buyer','usr_seller','prd1',5,'good',?)").run(past)
// o3: 盲评窗口未过,但双方都评了(buyer_ratings 存在)→ 揭晓
db.prepare("INSERT INTO order_ratings (order_id,buyer_id,seller_id,product_id,stars,comment,hidden_until) VALUES ('o3','usr_buyer','usr_seller','prd1',4,'ok',?)").run(future)
db.prepare("INSERT INTO buyer_ratings (order_id,seller_id,buyer_id,stars,hidden_until) VALUES ('o3','usr_seller','usr_buyer',4,?)").run(future)

let server: Server, port = 0
const get = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const r = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.end()
})

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerRatingsRoutes(app, {
    db, generateId: (p: string) => `${p}_x`,
    auth: (() => null) as any, isTrustedRole: (() => false) as any,
    errorRes: ((res: Response, status: number, code: string, msg: string) => res.status(status).json({ error: msg, error_code: code })) as any,
    broadcastSystemEvent: () => {},
  } as any)
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  const r = await get('/api/sellers/usr_seller/ratings')
  const items = r.json?.items || []
  const comments = items.map((x: any) => x.comment)
  ok('public seller ratings EXCLUDES the unrevealed one (o1)', !comments.includes('BAD-should-be-hidden'), JSON.stringify(comments))
  ok('public seller ratings INCLUDES blind-expired (o2)', comments.includes('good'), JSON.stringify(comments))
  ok('public seller ratings INCLUDES reciprocated (o3)', comments.includes('ok'), JSON.stringify(comments))
  ok('public seller agg counts only revealed (cnt=2)', Number(r.json?.agg?.cnt) === 2, JSON.stringify(r.json?.agg))
  ok('public seller agg avg over revealed only (4.5)', Math.abs(Number(r.json?.agg?.avg_stars) - 4.5) < 0.001, JSON.stringify(r.json?.agg))

  server.close()

  // ── static: 店铺主页 shops.ts 两个评价查询都带 blindOpen ──
  const shops = readFileSync('src/pwa/routes/shops.ts', 'utf8')
  const blindRe = /EXISTS \(SELECT 1 FROM buyer_ratings br WHERE br\.order_id = r\.order_id\)/
  ok('shops.ts defines the blindOpen condition', blindRe.test(shops))
  ok('shops.ts rating agg query is filtered (FROM order_ratings r ... blindOpen)', /SELECT COUNT\(\*\) as cnt[\s\S]{0,120}FROM order_ratings r WHERE r\.seller_id = \? AND \$\{blindOpen\}/.test(shops))
  ok('shops.ts recent ratings query is filtered', /FROM order_ratings r[\s\S]{0,160}WHERE r\.seller_id = \? AND \$\{blindOpen\}[\s\S]{0,40}ORDER BY r\.created_at DESC LIMIT 5/.test(shops))
  // ratings.ts public seller endpoint also filtered
  const ratings = readFileSync('src/pwa/routes/ratings.ts', 'utf8')
  const pubEp = ratings.slice(ratings.indexOf("app.get('/api/sellers/:seller_id/ratings'"))
  ok('public /sellers/:id/ratings rows filtered by blindOpen', /WHERE r\.seller_id = \? AND \$\{blindOpen\}/.test(pubEp))
  ok('public /sellers/:id/ratings agg filtered by blindOpen', /FROM order_ratings r WHERE r\.seller_id = \? AND \$\{blindOpen\}/.test(pubEp))

  if (fail === 0) {
    console.log(`\n✅ public ratings double-blind: 公开卖家评价 + 店铺主页 agg/recent 只展示已揭晓评价(双方都评 OR 盲评期过 OR 无窗口);未揭晓不泄露分数/评论\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ public ratings double-blind FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
