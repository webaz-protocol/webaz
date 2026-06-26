#!/usr/bin/env tsx
/**
 * MCP fresh-DB schema bridge regression (#draft mcp-fresh-db-schema-bridge).
 *   用法:npm run test:mcp-fresh-db-schema
 *
 * Reproduces + guards the fix for: a fresh MCP-initialized sandbox DB only ran
 * the stale L0 base schema, so it LACKED tables/columns the MCP tools need
 * (e.g. `product_aliases`, `users.permanent_code`). A sandbox webaz_register /
 * webaz_list_product / webaz_search then failed with "no such column/table".
 *
 * This test initializes through the MCP sandbox SCHEMA path ONLY:
 *     initDatabase()            // L0 base (what MCP used to do)
 *     applyWebazRuntimeSchema() // the new shared pure-schema bridge MCP now calls
 * in an isolated temp HOME (never the real ~/.webaz), then proves the schema is
 * sufficient for the register → list_product → search SQL the handlers run.
 *
 * SCOPE / what this does NOT do (by design):
 *   · It verifies SCHEMA sufficiency (the drift bug), NOT registration business
 *     gates. NETWORK-mode self-registration stays a HARD constraint — a stranger
 *     agent with no invite/referral + no email verification cannot register; that
 *     is enforced by handleRegister's isNetworkMode() guard (delegates to a human
 *     at webaz.xyz) and is untouched here. The register tested below is the
 *     SANDBOX local-only test-account path.
 *   · No money/order/status path is exercised. No real ~/.webaz write.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate BEFORE importing schema.js — initDatabase() resolves ~/.webaz from HOME at module load.
const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-mcp-freshdb-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, cond: boolean, d = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

try {
  // ── 1) Negative control: base-only DB (what MCP did before) is INSUFFICIENT ──
  const db = initDatabase()  // L0 base schema only
  ok('base-only DB lacks users.permanent_code (register would fail)',
    throws(() => db.prepare('SELECT permanent_code FROM users LIMIT 1').run()))
  ok('base-only DB lacks product_aliases table (search would fail)',
    throws(() => db.prepare('SELECT product_id FROM product_aliases LIMIT 1').run()))

  // ── 2) Apply the MCP fresh-DB schema bridge (the actual fix) ──
  applyWebazRuntimeSchema(db)

  // ── 3) Schema shape: the two reported gaps are now present ──
  const userCols = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(c => c.name)
  for (const c of ['permanent_code', 'handle', 'region']) {
    ok(`users.${c} present after bridge`, userCols.includes(c))
  }
  const prodCols = (db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map(c => c.name)
  for (const c of ['specs', 'brand', 'model', 'source_price', 'ship_regions', 'handling_hours', 'estimated_days', 'fragile', 'return_days', 'return_condition', 'warranty_days']) {
    ok(`products.${c} present after bridge`, prodCols.includes(c))
  }
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name))
  ok('product_aliases table present after bridge', tables.has('product_aliases'))

  // ── 4) The real handler SQL now succeeds against the bridged schema ──
  // register (SANDBOX local account): exact INSERTs from handleRegister
  const uid = generateId('usr')
  ok('webaz_register users INSERT succeeds', !throws(() =>
    db.prepare('INSERT INTO users (id, name, role, roles, api_key, permanent_code, handle, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, 'Test Seller', 'seller', JSON.stringify(['seller']), generateId('key'), 'ABC123', 'testseller', 'global', new Date('2026-01-01').toISOString())))
  ok('webaz_register wallets INSERT succeeds', !throws(() =>
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').run(uid, 1000)))

  const buid = generateId('usr')
  ok('webaz_register buyer INSERT succeeds', !throws(() =>
    db.prepare('INSERT INTO users (id, name, role, roles, api_key, permanent_code, handle, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(buid, 'Test Buyer', 'buyer', JSON.stringify(['buyer']), generateId('key'), 'XYZ789', 'testbuyer', 'global', new Date('2026-01-01').toISOString())))

  // list_product: exact 19-column INSERT from handleListProduct
  const pid = generateId('prd')
  ok('webaz_list_product products INSERT succeeds', !throws(() =>
    db.prepare(`INSERT INTO products (
      id, seller_id, title, description, price, stock, category, stake_amount,
      specs, brand, model, source_price,
      ship_regions, handling_hours, estimated_days, fragile,
      return_days, return_condition, warranty_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?)`)
      .run(pid, uid, 'Widget', 'A test widget', 9.99, 5, 'gadgets', 0,
        '{}', 'Acme', 'W-1', 5.00,
        '全国', 24, '3', 0,
        7, '', 0)))

  // search: product_aliases read (the exact table the reported error named) + products read
  ok('webaz_search product_aliases SELECT succeeds (no schema error)', !throws(() =>
    db.prepare('SELECT product_id, alias_value FROM product_aliases WHERE alias_value = ?').all('widget')))
  ok('webaz_search products SELECT succeeds', !throws(() =>
    db.prepare('SELECT id, title, price, brand, specs FROM products WHERE status = ? LIMIT 10').all('active')))

  console.log(`\nMCP fresh-DB schema bridge`)
  console.log(`──────────────────────────`)
  console.log(`  isolated HOME: ${tmpHome}`)
  console.log(`  tables after bridge: ${tables.size}`)
  if (fail === 0) {
    console.log(`\n✅ fresh MCP-init DB is schema-complete for register → list_product → search (sandbox path); base-only DB proven insufficient; product_aliases + users.permanent_code present\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ MCP fresh-DB schema bridge FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
