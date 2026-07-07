#!/usr/bin/env tsx
/**
 * Backfill — 统一仲裁台历史补救。
 *
 * 为并入统一仲裁台【之前】就卡住的"卖家客观拒单举证"订单(RFC-007:status=fault_seller +
 * decline_objective_pending=1 + decline_contested=1 + 未结算,但还没有 decline_contest dispute 行,
 * 例如 ord_54fa...)补建 disputes 行,让它们进入统一仲裁台。
 *
 * 单一真相源:复用 createDeclineContestDispute —— 不复制任何 INSERT 逻辑。
 * 模式:
 *   --dry-run (默认)  : 只列出会补哪些订单,【不写任何数据】。
 *   --apply           : 真正建 dispute 行。
 *   --db=<path>       : DB 文件(默认 ~/.webaz/webaz.db;prod 容器为 /root/.webaz/webaz.db)。
 * 幂等:重复 --apply 建 0 条新行(存在性检查 + 部分唯一索引 ux_disputes_decline_contest_order)。
 *
 * 用法:
 *   npm run backfill:decline-contest              # dry-run,先确认 ord_54fa... 在名单里
 *   npm run backfill:decline-contest -- --apply   # 真正补建
 */
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDisputeSchema, createDeclineContestDispute } from '../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const dbArg = argv.find(a => a.startsWith('--db='))?.slice('--db='.length)
const dbPath = dbArg || path.join(os.homedir(), '.webaz', 'webaz.db')

const db = new Database(dbPath)
// 确保 dispute_type 列 + 部分唯一索引存在(幂等;prod 部署后 boot 已建,此处为 no-op)。
initDisputeSchema(db)

const candidates = db.prepare(`
  SELECT o.id, o.decline_reason_code, o.decline_contest_deadline, o.seller_id, o.buyer_id
  FROM orders o
  WHERE o.status = 'fault_seller'
    AND COALESCE(o.decline_objective_pending, 0) = 1
    AND COALESCE(o.decline_contested, 0) = 1
    AND o.settled_fault_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id AND d.dispute_type = 'decline_contest')
  ORDER BY o.declined_at ASC
`).all() as Array<{ id: string; decline_reason_code: string | null; decline_contest_deadline: string | null; seller_id: string; buyer_id: string }>

console.log(`DB:   ${dbPath}`)
console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`)
console.log(`卡住的【已举证客观拒单】订单(尚无 decline_contest dispute 行): ${candidates.length}`)
for (const c of candidates) {
  console.log(`  - ${c.id}  reason=${c.decline_reason_code || '?'}  contest_deadline=${c.decline_contest_deadline || '?'}`)
}

if (!apply) {
  console.log(`\n(dry-run) 未写入任何数据。确认名单无误后,加 --apply 补建。`)
  process.exit(0)
}

let created = 0, existing = 0, failed = 0
for (const c of candidates) {
  const r = createDeclineContestDispute(db, c.id)
  if (!r.success) { failed++; console.error(`  ✗ ${c.id}: ${r.error}`) }
  else if (r.existing) { existing++; console.log(`  = ${c.id}: 已存在 ${r.disputeId}(幂等,跳过)`) }
  else { created++; console.log(`  ✓ ${c.id}: 已建 ${r.disputeId}`) }
}
console.log(`\nAPPLY 完成。created=${created} existing=${existing} failed=${failed}`)
process.exit(failed ? 1 : 0)
