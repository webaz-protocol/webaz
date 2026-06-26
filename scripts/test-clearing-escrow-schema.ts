#!/usr/bin/env tsx
/**
 * RFC-018 PR1 schema contract: initPendingCommissionEscrowSchema must build the table — with the new
 * `matures_at` column and an insertable `reversed` status — identically on a FRESH DB and after
 * migrating an EXISTING (pre-RFC-018) DB. 用法: npm run test:clearing-escrow-schema
 *
 * Why both paths, asserting the column actually lands: `matures_at` is the accrue-then-mature clock.
 * If it silently fails to materialize on any path, the consequence is not a build error — it is wrong
 * settle-time math (PR2 reads matures_at). That is far harder to catch, so we assert the column on
 * every path and that existing rows survive the rebuild.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-clr-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initPendingCommissionEscrowSchema } = await import('../src/runtime/webaz-schema-helpers.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const colInfo = (db: any): Array<{ name: string; notnull: number }> =>
  db.prepare('PRAGMA table_info(pending_commission_escrow)').all() as Array<{ name: string; notnull: number }>
const hasCol = (db: any, name: string): boolean => colInfo(db).some(c => c.name === name)
const orderIdNullable = (db: any): boolean => { const c = colInfo(db).find(x => x.name === 'order_id'); return !!c && c.notnull === 0 }

const db = initDatabase()
db.prepare("INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)").run('usr_a', 'A', 'buyer', 'key_a')

try {
  // ── FRESH DB ────────────────────────────────────────────────────────────────
  initPendingCommissionEscrowSchema(db)
  ok('fresh: matures_at column present', hasCol(db, 'matures_at'))
  ok('fresh: order_id is NULLable (pv_pair)', orderIdNullable(db))
  // `reversed` status value + matures_at must both round-trip (proves they actually persist)
  db.prepare(`INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at, matures_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('usr_a', null, 10, 'pv_pair', 'reversed', 1000, 2000, 1500)
  const r = db.prepare(`SELECT status, matures_at, order_id FROM pending_commission_escrow WHERE recipient_user_id='usr_a'`).get() as any
  ok('fresh: status="reversed" persists', r?.status === 'reversed', JSON.stringify(r))
  ok('fresh: matures_at value persists', r?.matures_at === 1500, JSON.stringify(r))
  ok('fresh: order_id NULL accepted (pv_pair)', r?.order_id === null, JSON.stringify(r))

  // ── EXISTING DB (pre-RFC-018: order_id nullable but NO matures_at) = the prod migration path ──
  db.exec('DROP TABLE pending_commission_escrow')
  db.exec(`CREATE TABLE pending_commission_escrow (
    id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_user_id TEXT NOT NULL, order_id TEXT,
    amount REAL NOT NULL, attribution_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, expired_to_charity_at INTEGER,
    FOREIGN KEY (recipient_user_id) REFERENCES users(id), FOREIGN KEY (order_id) REFERENCES orders(id))`)
  db.prepare(`INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run('usr_a', null, 7, 'L1', 'pending', 100, 200)
  ok('existing(no matures_at): precondition — column absent', !hasCol(db, 'matures_at'))
  initPendingCommissionEscrowSchema(db)   // migration should add matures_at, preserve the row
  ok('existing(no matures_at): matures_at added by migration', hasCol(db, 'matures_at'))
  const m = db.prepare(`SELECT amount, status, matures_at FROM pending_commission_escrow WHERE attribution_path='L1'`).get() as any
  ok('existing(no matures_at): legacy row preserved', m?.amount === 7 && m?.status === 'pending', JSON.stringify(m))
  ok('existing(no matures_at): legacy matures_at backfilled NULL', m?.matures_at === null, JSON.stringify(m))

  // ── EXISTING DB (older: order_id NOT NULL, no matures_at) — both triggers at once ──
  db.exec('DROP TABLE pending_commission_escrow')
  db.exec(`CREATE TABLE pending_commission_escrow (
    id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_user_id TEXT NOT NULL, order_id TEXT NOT NULL,
    amount REAL NOT NULL, attribution_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, expired_to_charity_at INTEGER,
    FOREIGN KEY (recipient_user_id) REFERENCES users(id), FOREIGN KEY (order_id) REFERENCES orders(id))`)
  db.pragma('foreign_keys = OFF')   // test-only: legacy row has a dangling order_id FK; migration copies it with FK off
  db.prepare(`INSERT INTO pending_commission_escrow (recipient_user_id, order_id, amount, attribution_path, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run('usr_a', 'ord_legacy', 5, 'L2', 'settled', 50, 150)
  db.pragma('foreign_keys = ON')
  ok('existing(order_id NOT NULL): precondition — order_id NOT NULL + no matures_at', !orderIdNullable(db) && !hasCol(db, 'matures_at'))
  initPendingCommissionEscrowSchema(db)   // both triggers: nullable order_id + add matures_at
  ok('existing(order_id NOT NULL): order_id now NULLable', orderIdNullable(db))
  ok('existing(order_id NOT NULL): matures_at added', hasCol(db, 'matures_at'))
  const o = db.prepare(`SELECT amount, status, order_id, matures_at FROM pending_commission_escrow WHERE attribution_path='L2'`).get() as any
  ok('existing(order_id NOT NULL): legacy row preserved with order_id', o?.amount === 5 && o?.order_id === 'ord_legacy', JSON.stringify(o))
  ok('foreign_keys restored ON after migration', (db.pragma('foreign_keys', { simple: true }) as number) === 1)

  if (fail === 0) {
    console.log(`\n✅ clearing escrow schema: matures_at + reversed land on fresh + both migration paths; rows preserved\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ clearing escrow schema FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
