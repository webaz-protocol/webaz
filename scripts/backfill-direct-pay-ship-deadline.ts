#!/usr/bin/env tsx
/**
 * Backfill — direct_p2p 存量 accepted 订单补 ship_deadline(RFC-021 PR3 / Codex P1-c(c))。
 *
 * 背景:direct-pay-create 建单从不设 ship_deadline;买家 mark_paid → accepted 后此列历史上一直为 NULL。
 *   PR3 起共享执行器对【需要 SLA 的状态遇 deadline=NULL】做 fail-closed(拒绝放行,防静默绕过判责钟)。
 *   若不补,存量 accepted direct_p2p 订单上线即被 SLA_DEADLINE_MISSING 卡住,卖家无法发货。
 *
 * 策略:给这些单一个【从现在起】的新 ship 窗口(datetime('now','+Nh')),避免用陈旧 accepted 时刻追溯判超时。
 *   WHERE ship_deadline IS NULL 兜死:仅补 NULL 的,绝不覆盖已有值(守 I3)。幂等:重复 --apply 补 0 条。
 *
 * 模式:
 *   --dry-run (默认) : 只列出会补哪些订单,不写任何数据。
 *   --apply          : 真正写 ship_deadline。
 *   --hours=<N>      : ship 窗口小时数(默认读 protocol_params direct_pay.ship_window_hours,再默认 72)。
 *   --db=<path>      : DB 文件(默认 ~/.webaz/webaz.db;prod 容器为 /root/.webaz/webaz.db)。
 *
 * 用法:
 *   npm run backfill:direct-pay-ship-deadline              # dry-run
 *   npm run backfill:direct-pay-ship-deadline -- --apply   # 真正补
 */
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const dbArg = argv.find(a => a.startsWith('--db='))?.slice('--db='.length)
const hoursArg = argv.find(a => a.startsWith('--hours='))?.slice('--hours='.length)
const dbPath = dbArg || path.join(os.homedir(), '.webaz', 'webaz.db')

const db = new Database(dbPath)

let hours = Number(hoursArg) || 0
if (!hours) {
  try { const p = db.prepare("SELECT value FROM protocol_params WHERE key = 'direct_pay.ship_window_hours'").get() as { value: string } | undefined; hours = Math.max(1, Number(p?.value) || 72) } catch { hours = 72 }
}

const candidates = db.prepare(`
  SELECT id, seller_id, buyer_id, updated_at
  FROM orders
  WHERE payment_rail = 'direct_p2p' AND status = 'accepted' AND ship_deadline IS NULL
  ORDER BY updated_at ASC
`).all() as Array<{ id: string; seller_id: string; buyer_id: string; updated_at: string | null }>

console.log(`DB:   ${dbPath}`)
console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}   ship_window=${hours}h`)
console.log(`存量 accepted direct_p2p 且 ship_deadline 为 NULL 的订单: ${candidates.length}`)
for (const c of candidates) console.log(`  - ${c.id}  seller=${c.seller_id}  accepted_around=${c.updated_at || '?'}`)

if (!apply) {
  console.log(`\n(dry-run) 未写入任何数据。确认名单无误后,加 --apply 补齐 ship_deadline。`)
  process.exit(0)
}

// WHERE ship_deadline IS NULL 幂等 + 守 I3(绝不覆盖已有值)。datetime('now','+Nh')= 从现在起的新窗口。
const res = db.prepare("UPDATE orders SET ship_deadline = datetime('now', ?) WHERE payment_rail = 'direct_p2p' AND status = 'accepted' AND ship_deadline IS NULL").run(`+${hours} hours`)
console.log(`\nAPPLY 完成。补齐 ship_deadline 订单数 = ${res.changes}`)
process.exit(0)
