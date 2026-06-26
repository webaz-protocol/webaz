/**
 * WebAZ runtime schema composition root.
 *
 * WHY: the PWA server boot creates the full app schema (L0 base tables + ~78
 * pure helper tables + inline column ALTERs), but the MCP sandbox boot only ran
 * the stale L0 base schema + a handful of layer initializers. A fresh
 * MCP-initialized DB therefore lacked tables/columns the MCP tools need
 * (e.g. `product_aliases`, `users.permanent_code`), so a sandbox
 * `webaz_register` / `webaz_list_product` / `webaz_search` failed with schema
 * errors. This composition root lets MCP apply the SAME pure schema the PWA
 * helpers define, WITHOUT booting the PWA server first.
 *
 * LAYERING: this is a NEUTRAL top-level module (src/runtime), deliberately NOT
 * in L0 — it composes pure helpers that live above L0. L0 stays lower-layer and
 * imports nothing from here.
 *
 * SCOPE: this is a fresh-DB schema BRIDGE, not full schema unification. It runs
 * only the pure idempotent DDL helpers in ./webaz-schema-helpers.ts (every
 * exported `init*` function, all pure `CREATE TABLE/INDEX IF NOT EXISTS` /
 * guarded `ALTER`). It performs NO business-row writes, NO bootstrap accounts,
 * NO data migrations/backfills, and touches NO money/order/status path. Safe to
 * call repeatedly. The remaining inline DDL still interleaved with money-path
 * migrations in src/pwa/server.ts is intentionally NOT covered here — that is a
 * later dedicated, money-path-aware extraction phase.
 *
 * USAGE: call AFTER L0 initDatabase() has opened the connection and created the
 * base tables (the helpers ALTER/extend those base tables).
 */
import type Database from 'better-sqlite3'
import * as helpers from './webaz-schema-helpers.js'

export function applyWebazRuntimeSchema(db: Database.Database): void {
  // Call every pure idempotent DDL initializer exported by the shared helpers
  // module (convention: each is named init*Schema / init*Columns and is a
  // side-effect-free `(db) => void`). Order-independent: all statements are
  // CREATE ... IF NOT EXISTS / guarded ALTER, so re-running or reordering is a
  // no-op. New helpers are picked up automatically — no risk of forgetting one
  // (which is exactly how the MCP/PWA schemas drifted apart in the first place).
  for (const [name, fn] of Object.entries(helpers)) {
    if (name.startsWith('init') && typeof fn === 'function') {
      ;(fn as (db: Database.Database) => void)(db)
    }
  }
}
