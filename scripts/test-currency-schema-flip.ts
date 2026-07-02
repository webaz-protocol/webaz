#!/usr/bin/env tsx
/**
 * 币种 schema 翻转 + 回填 (Claim 5 gated) —— 数据层根治,不再依赖展示归一化。
 * 验:① fresh DB 的 products.currency 默认已是 'WAZ';② 依赖默认建行 → WAZ;③ 存量遗留 'DCP' 行经 init 迁移
 *   一次性回填成 'WAZ',且幂等可重跑(再 init 不报错、保持 WAZ)。
 * 注:DCP↔WAZ 同一模拟单位纯改名,金额不变;全仓无 currency='DCP' 筛选逻辑(已核),回填不破坏任何查询。
 * Usage: npm run test:currency-schema-flip
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
const HOME = mkdtempSync(join(tmpdir(), 'cur-flip-'))
process.env.HOME = HOME

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? ` (${d})` : ''}`) } }

// ── ① fresh DB: CREATE default is WAZ ──
const db = initDatabase()
db.pragma('foreign_keys = OFF')
const dflt = (db.prepare("PRAGMA table_info(products)").all() as { name: string; dflt_value: string | null }[]).find(c => c.name === 'currency')?.dflt_value
ok('1. fresh products.currency DEFAULT is WAZ (not DCP)', typeof dflt === 'string' && dflt.includes('WAZ') && !dflt.includes('DCP'), String(dflt))

// ── ② insert relying on the default → WAZ ──
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','S','seller','k1')").run()
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock) VALUES ('p_def','s1','P','d',10,5)").run()
ok('2. new product (default currency) is WAZ', (db.prepare("SELECT currency c FROM products WHERE id='p_def'").get() as { c: string }).c === 'WAZ')

// ── ③ seed a legacy DCP row, re-init → backfilled to WAZ ──
db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, currency) VALUES ('p_legacy','s1','L','d',10,5,'DCP')").run()
ok('3a. legacy row starts as DCP', (db.prepare("SELECT currency c FROM products WHERE id='p_legacy'").get() as { c: string }).c === 'DCP')
db.close()
const db2 = initDatabase()   // same HOME → same file; init runs the idempotent backfill
ok('3b. after re-init: legacy DCP row backfilled to WAZ', (db2.prepare("SELECT currency c FROM products WHERE id='p_legacy'").get() as { c: string }).c === 'WAZ')
ok('3c. no DCP rows remain', (db2.prepare("SELECT COUNT(*) n FROM products WHERE currency='DCP'").get() as { n: number }).n === 0)
db2.close()

// ── ③(cont) idempotent: re-init again is a no-op, no error, stays WAZ ──
const db3 = initDatabase()
ok('4. re-init idempotent (still WAZ, no throw)', (db3.prepare("SELECT COUNT(*) n FROM products WHERE currency='WAZ'").get() as { n: number }).n >= 2 && (db3.prepare("SELECT COUNT(*) n FROM products WHERE currency='DCP'").get() as { n: number }).n === 0)
db3.close()

if (fail > 0) { console.error(`\n❌ currency schema flip FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ currency schema flip: fresh default WAZ · default-insert → WAZ · legacy DCP rows backfilled on init · idempotent re-run\n  ✅ pass ${pass}`)
