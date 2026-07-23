#!/usr/bin/env tsx
/**
 * Operator entry: WAZ 退役余额清零(PR-A2)。三阶段 fail-closed:盘点 → 清零 → 校验。
 * 引擎:src/waz-sunset-store.ts(append-only 冲正,绝不 DELETE/改历史流水)。
 *
 *   Dry-run(默认 — 零写入,产出盘点+计划报告):
 *     node --import tsx scripts/ops-waz-sunset.ts
 *   Commit(等 Holden 拍板;盘点有任何在途项会硬拒):
 *     node --import tsx scripts/ops-waz-sunset.ts --commit --reason="WAZ sunset 2026-07-23 (Holden approved)"
 *
 * Flags:
 *   --commit           真正写入(默认 dry-run)
 *   --include-funds    连基金池(charity/commission_reserve/global_fund/protocol_reserve_pool/penalty_fund)
 *                      一并清零(默认不动;单独拍板)
 *   --reason="..."     冲正理由(commit 必填)
 *   --db=<path>        SQLite 路径(默认 $WEBAZ_DB_PATH 或 ~/.webaz/webaz.db)
 *
 * 生产:railway ssh --service robust-heart 内跑(容器无 tsx 时用 dist 产物或 base64+node 探针模式)。
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runWazSunsetZeroing, renderSunsetReport } from '../src/waz-sunset-store.js'

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  const eq = hit.indexOf('=')
  return eq < 0 ? '' : hit.slice(eq + 1)
}

const commit = flag('commit') !== undefined
const includeFunds = flag('include-funds') !== undefined
const reason = flag('reason') || (commit ? '' : 'dry-run')
const dbPath = flag('db') || process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')

if (commit && !reason.trim()) { console.error('❌ --commit 需要 --reason="..."'); process.exit(2) }
if (!existsSync(dbPath)) { console.error(`❌ SQLite DB not found at ${dbPath} (set --db= or $WEBAZ_DB_PATH)`); process.exit(2) }

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
const runId = `waz_sunset_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`

try {
  const result = runWazSunsetZeroing(db, { runId, reason, includeFunds, commit })
  console.log(renderSunsetReport(result))
  if (result.committed && result.residual.length > 0) { console.error('❌ commit 后仍有非零残留 — 立即人工核查'); process.exit(1) }
  if (!result.committed) console.log('\n(dry-run:零写入。确认报告后加 --commit --reason="..." 执行。)')
} catch (e) {
  console.error(`❌ ${(e as Error).message}`)
  process.exit(1)
}
