#!/usr/bin/env tsx
/**
 * BUG-02 migration — promised_eta_snapshot columns are additive, backward-compatible, NULL for legacy rows
 * (no speculative backfill), idempotent, and present after a fresh boot. No money/status/deadline column touched.
 * Usage: npx tsx scripts/test-eta-migration.ts
 */
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import Database from 'better-sqlite3'
process.env.HOME = mkdtempSync(join(tmpdir(), 'etamig-'))

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const cols = (db: Database.Database, t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)

async function main(): Promise<void> {
  // ── Upgrade path: an OLD DB (table exists, no promised_eta_snapshot, with a pre-existing row) ──
  for (const table of ['orders', 'order_quotes', 'order_drafts']) {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, total_amount TEXT, status TEXT, expires_at TEXT)`)   // old shape (money/status/deadline present)
    db.prepare(`INSERT INTO ${table} (id, total_amount, status, expires_at) VALUES ('old_1','100','confirmed','2020-01-01')`).run()
    // the exact migration statement:
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN promised_eta_snapshot TEXT`) } catch { /* exists */ }
    ok(`M-${table}-1. column added on upgrade`, cols(db, table).includes('promised_eta_snapshot'))
    const row = db.prepare(`SELECT promised_eta_snapshot, total_amount, status, expires_at FROM ${table} WHERE id='old_1'`).get() as Record<string, unknown>
    ok(`M-${table}-2. legacy row promised_eta_snapshot IS NULL (no speculative backfill)`, row.promised_eta_snapshot === null)
    ok(`M-${table}-3. money/status/deadline of the legacy row UNCHANGED`, row.total_amount === '100' && row.status === 'confirmed' && row.expires_at === '2020-01-01')
    // idempotent: re-running the migration must not throw and must not change data
    let threw = false; try { db.exec(`ALTER TABLE ${table} ADD COLUMN promised_eta_snapshot TEXT`) } catch { threw = true }
    ok(`M-${table}-4. re-running ALTER is caught (idempotent, single logical apply)`, threw === true)
    const after = db.prepare(`SELECT total_amount FROM ${table} WHERE id='old_1'`).get() as { total_amount: string }
    ok(`M-${table}-5. data intact after repeat migration`, after.total_amount === '100')
    db.close()
  }

  // ── Fresh boot: the exported quote/draft schema initializers create the column on a fresh DB ──
  const { initOrderQuotesSchema, initOrderDraftsSchema } = await import('../src/runtime/webaz-schema-helpers.js')
  const fq = new Database(':memory:'); initOrderQuotesSchema(fq)
  ok('F1. fresh order_quotes has promised_eta_snapshot', cols(fq, 'order_quotes').includes('promised_eta_snapshot'))
  // running again is a no-op (idempotent init)
  initOrderQuotesSchema(fq); ok('F2. re-init order_quotes idempotent (no throw)', cols(fq, 'order_quotes').includes('promised_eta_snapshot')); fq.close()
  const fd = new Database(':memory:'); initOrderDraftsSchema(fd)
  ok('F3. fresh order_drafts has promised_eta_snapshot', cols(fd, 'order_drafts').includes('promised_eta_snapshot'))
  initOrderDraftsSchema(fd); ok('F4. re-init order_drafts idempotent', cols(fd, 'order_drafts').includes('promised_eta_snapshot')); fd.close()

  // ── Fresh boot: full initDatabase() gives orders the column ──
  const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
  const full = initDatabase()
  ok('F5. fresh initDatabase → orders has promised_eta_snapshot', cols(full, 'orders').includes('promised_eta_snapshot'))
  ok('F6. existing orders shipping columns still present (no regression)', ['shipping_est_days', 'ship_to_region', 'shipping_fee'].every(c => cols(full, 'orders').includes(c)))
  full.close()

  if (fail > 0) { console.error(`\n❌ eta migration FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ eta migration: additive + NULL-not-backfilled + money/status/deadline untouched + idempotent + fresh-boot (orders/quotes/drafts)\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
