// Codex #254 follow-up P2 — offer 撤回时钱包释放带 staked>=stake 守卫:
//   若 wallets.staked < products.listing_stake_locked(历史漂移/并发异常),撤回必须整笔回滚,
//   绝不在清零 products.stake 的同时让 staked 变负或丢质押。
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT);
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, staked REAL DEFAULT 0);
    CREATE TABLE products (id TEXT PRIMARY KEY, seller_id TEXT, listing_id TEXT, status TEXT, listing_stake_locked REAL DEFAULT 0, updated_at TEXT);
    CREATE TABLE listings (id TEXT PRIMARY KEY, total_offers INTEGER DEFAULT 0);
    CREATE TABLE orders (id TEXT PRIMARY KEY, product_id TEXT, status TEXT);
  `)
  db.prepare("INSERT INTO users (id, role) VALUES ('seller','seller')").run()
  db.prepare("INSERT INTO listings (id, total_offers) VALUES ('lst1', 1)").run()
  return db
}
const prod = (db: Database.Database) => db.prepare("SELECT status, listing_stake_locked FROM products WHERE id='off1'").get() as { status: string; listing_stake_locked: number }
const wal = (db: Database.Database) => db.prepare("SELECT balance, staked FROM wallets WHERE user_id='seller'").get() as { balance: number; staked: number }
const offers = (db: Database.Database) => (db.prepare("SELECT total_offers AS t FROM listings WHERE id='lst1'").get() as { t: number }).t

async function main(): Promise<void> {
  const express = (await import('express')).default
  const { registerOffersRoutes } = await import('../src/pwa/routes/offers.js')
  const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')

  function server(db: Database.Database) {
    setSeamDb(db)
    const app = express(); app.use(express.json())
    registerOffersRoutes(app, {
      db, auth: () => ({ id: 'seller', role: 'seller' }), VALID_FULFILLMENT_TYPES: new Set(['standard']),
    } as unknown as Parameters<typeof registerOffersRoutes>[1])
    return app
  }
  async function del(app: ReturnType<typeof express>, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const srv = app.listen(0); await new Promise(r => srv.once('listening', r))
    const port = (srv.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' })
      return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
    } finally { srv.close() }
  }

  // ── drift case: staked(50) < listing_stake_locked(100) → 撤回失败,整笔回滚 ──
  {
    const db = freshDb()
    db.prepare("INSERT INTO products (id, seller_id, listing_id, status, listing_stake_locked) VALUES ('off1','seller','lst1','active',100)").run()
    db.prepare("INSERT INTO wallets (user_id, balance, staked) VALUES ('seller', 0, 50)").run()  // 漂移:staked < stake
    const { status, body } = await del(server(db), '/api/offers/off1')
    expect('drift → 非 2xx(500)', status === 500, { status, body })
    expect('drift → error_code=OFFER_STAKE_INVARIANT_VIOLATION', body.error_code === 'OFFER_STAKE_INVARIANT_VIOLATION', body)
    expect('drift → product.listing_stake_locked 未清零(仍 100)', prod(db).listing_stake_locked === 100, prod(db))
    expect('drift → product.status 未变(仍 active)', prod(db).status === 'active')
    expect('drift → listing.total_offers 未递减(仍 1)', offers(db) === 1)
    expect('drift → wallet 未动(balance 0 / staked 50)', wal(db).balance === 0 && wal(db).staked === 50, wal(db))
  }

  // ── normal case: staked(100) >= stake(100) → 成功释放 ──
  {
    const db = freshDb()
    db.prepare("INSERT INTO products (id, seller_id, listing_id, status, listing_stake_locked) VALUES ('off1','seller','lst1','active',100)").run()
    db.prepare("INSERT INTO wallets (user_id, balance, staked) VALUES ('seller', 0, 100)").run()
    const { status, body } = await del(server(db), '/api/offers/off1')
    expect('normal → 200 success', status === 200 && body.success === true, { status, body })
    expect('normal → product warehouse + stake 0', prod(db).status === 'warehouse' && prod(db).listing_stake_locked === 0, prod(db))
    expect('normal → wallet 释放(balance 100 / staked 0)', wal(db).balance === 100 && wal(db).staked === 0, wal(db))
    expect('normal → listing.total_offers 递减(0)', offers(db) === 0)
  }
}

await main()
console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
