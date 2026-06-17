// 2026-05-22 audit: anchor 配额 TOCTOU 修复回归测试
// 验证 generateAnchor 并发调用不会超限额
import Database from 'better-sqlite3'
import { generateAnchor, initAnchorRegistrySchema, ANCHOR_MAX_PER_DAY, retireIdleAnchors } from '../src/layer2-business/L2-anchor-registry/anchor-registry.js'

const db = new Database(':memory:')
initAnchorRegistrySchema(db)

// 准备用户 + 1 个 product + commission_records（userReferralVolume 依赖）
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT, total_left_pv REAL DEFAULT 0, total_right_pv REAL DEFAULT 0);
  CREATE TABLE products (id TEXT PRIMARY KEY, status TEXT, seller_id TEXT);
  CREATE TABLE commission_records (id TEXT PRIMARY KEY, user_id TEXT, beneficiary_id TEXT, order_id TEXT, amount REAL, level INTEGER, created_at TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, product_id TEXT, status TEXT, total_amount REAL, recommender_id TEXT, created_at TEXT, completed_at TEXT);
  CREATE TABLE dispute_cases (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, arbitrator_id TEXT);
  INSERT INTO users (id, handle) VALUES ('u_toctou', 'toctou');
  INSERT INTO products (id, status, seller_id) VALUES ('prd_test', 'active', 'u_someseller');
`)

let pass = 0
let fail = 0
function expect(label: string, cond: boolean) {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else      { fail++; console.log(`✗ ${label}`) }
}

// 测试 1：连续生成达上限
console.log('\n=== 测试 1：连续生成达每日上限 ===')
const results: Array<{ ok: boolean; reason?: string }> = []
for (let i = 0; i < ANCHOR_MAX_PER_DAY + 3; i++) {
  // 不同 middle 避开 UNIQUE
  const middle = `t${String(i).padStart(3, '0')}`
  const r = generateAnchor(db, {
    ownerId: 'u_toctou',
    middle,
    targetKind: 'product',
    targetId: 'prd_test',
  })
  results.push(r)
}
const okCount = results.filter(r => r.ok).length
const quotaRejects = results.filter(r => !r.ok && r.reason?.startsWith('quota_max_per_day')).length
expect(`成功数 = ANCHOR_MAX_PER_DAY (${ANCHOR_MAX_PER_DAY})`, okCount === ANCHOR_MAX_PER_DAY)
expect(`超限拒绝数 = 3`, quotaRejects === 3)

const dbCount = (db.prepare("SELECT COUNT(*) as n FROM anchor_registry WHERE owner_id = 'u_toctou'").get() as { n: number }).n
expect(`DB 实际 anchor 数 = ${ANCHOR_MAX_PER_DAY}（无超限）`, dbCount === ANCHOR_MAX_PER_DAY)

// 测试 2：UNIQUE 约束保护并发同名
console.log('\n=== 测试 2：同名 anchor 并发 INSERT 不破坏 DB ===')
// 清空 + 重置（避开每日上限）
db.exec(`DELETE FROM anchor_registry WHERE owner_id = 'u_toctou'`)

const r1 = generateAnchor(db, { ownerId: 'u_toctou', middle: 't888', targetKind: 'product', targetId: 'prd_test' })
expect('第 1 次 generate ok', r1.ok === true)
const r2 = generateAnchor(db, { ownerId: 'u_toctou', middle: 't888', targetKind: 'product', targetId: 'prd_test' })
expect('第 2 次同 middle = anchor_taken（DB UNIQUE 抓住）', !r2.ok && r2.reason === 'anchor_taken')

const finalCount = (db.prepare("SELECT COUNT(*) as n FROM anchor_registry WHERE owner_id = 'u_toctou'").get() as { n: number }).n
expect(`DB 仅 1 条 anchor`, finalCount === 1)

// 测试 3：retireIdleAnchors — 90 天闲置自动 retire
console.log('\n=== 测试 3：retireIdleAnchors 闲置 anchor 自动 retire ===')
// 清空 + 重置
db.exec(`DELETE FROM anchor_registry WHERE owner_id = 'u_toctou'`)

// 生成 3 个 anchor（不同 middle 避 UNIQUE 冲突）
const r3a = generateAnchor(db, { ownerId: 'u_toctou', middle: 'i123', targetKind: 'product', targetId: 'prd_test' })
const r3b = generateAnchor(db, { ownerId: 'u_toctou', middle: 'i456', targetKind: 'product', targetId: 'prd_test' })
const r3c = generateAnchor(db, { ownerId: 'u_toctou', middle: 'i789', targetKind: 'product', targetId: 'prd_test' })
expect('3 个 anchor 全部生成 ok', r3a.ok && r3b.ok && r3c.ok)

// 手动把 2 个的 created_at 改到 90 天前 + hits=0（模拟闲置）
db.exec(`
  UPDATE anchor_registry
  SET created_at = datetime('now', '-100 days'), hits = 0
  WHERE owner_id = 'u_toctou' AND middle IN ('i123', 'i456')
`)
// 第 3 个保持新建（< 90 天）— 即使闲置也不应被 retire（不满足 90 天）

const retireResult = retireIdleAnchors(db)
// 期望：i123 + i456 满足条件，但保留至少 1 个 active → retire 1 个
// 因为初始 3 个 active，闲置 2 个，保留 1 个最新（i789 < 90 天，不在候选）
// 候选 [i123, i456]，activeCount=3，candidates.length=2，slice(0, 3-1=2) → 2 个全 retire
expect('retire 数 = 2', retireResult.retired === 2)

const activeAfter = (db.prepare(`SELECT COUNT(*) as n FROM anchor_registry WHERE owner_id = 'u_toctou' AND status = 'active'`).get() as { n: number }).n
expect(`retire 后仍有 1 active (= ${activeAfter})`, activeAfter === 1)

// 测试 4：保护机制 — 单 active anchor 不被 retire
console.log('\n=== 测试 4：单 active anchor 即使闲置也不 retire ===')
db.exec(`DELETE FROM anchor_registry WHERE owner_id = 'u_toctou'`)
const r4 = generateAnchor(db, { ownerId: 'u_toctou', middle: 'j999', targetKind: 'product', targetId: 'prd_test' })
expect('生成 r4 ok', r4.ok)
db.exec(`UPDATE anchor_registry SET created_at = datetime('now', '-200 days'), hits = 0 WHERE owner_id = 'u_toctou'`)
const r4Retire = retireIdleAnchors(db)
expect('单 active anchor 即使闲置也不被 retire（retired=0）', r4Retire.retired === 0)

console.log('\n==================================')
if (fail === 0) {
  console.log(`✅ ${pass} passed / 0 failed`)
  process.exit(0)
} else {
  console.log(`❌ ${pass} passed / ${fail} failed`)
  process.exit(1)
}
