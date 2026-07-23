#!/usr/bin/env tsx
/**
 * A1 — strict ACP feed 导出 CLI(批准后经 SFTP 提交用;spec 推荐 jsonl.gz 全量快照,日更覆盖)。
 *
 * 用法:npm run export:acp-strict-feed [-- <out.jsonl.gz>]
 *   - 读 $HOME/.webaz/webaz.db(与服务器同一 DATA_DIR 约定)+ live protocol_params(waz_usdc_rate 等)。
 *   - 产出 <out>.jsonl.gz(gzip 的 JSON Lines,每行一个商品)+ stdout 摘要(含各类剔除计数)。
 *   - 纯读;全局门未开 / 汇率非法 → 退出码 1 且不写文件(fail-closed,绝不带病导出)。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { buildStrictAcpExport } from '../src/pwa/acp-strict-export.js'

const out = process.argv[2] || 'acp-strict-feed.jsonl.gz'
const dbPath = process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz', 'webaz.db')
const db = new Database(dbPath, { readonly: true, fileMustExist: true })

const gp = <T,>(key: string, fallback: T): T => {
  const row = db.prepare('SELECT value, type FROM protocol_params WHERE key = ?').get(key) as { value: string; type: string } | undefined
  if (!row) return fallback
  if (row.type === 'number') return Number(row.value) as unknown as T
  if (row.type === 'boolean') return (row.value === 'true' || row.value === '1') as unknown as T
  return row.value as unknown as T
}

const r = buildStrictAcpExport(db, { getProtocolParam: gp })
console.log(`db: ${dbPath}`)
console.log(`stats: ${JSON.stringify(r.stats)}`)
if (!r.ok) {
  console.error(`✗ fail-closed,不导出:${r.reason}`)
  process.exit(1)
}
const jsonl = r.items.map((i) => JSON.stringify(i)).join('\n') + (r.items.length ? '\n' : '')
writeFileSync(out, gzipSync(Buffer.from(jsonl, 'utf-8')))
console.log(`✓ ${r.items.length} items → ${out}(${r.stats.excluded_seller_not_ready} 店未过 Rail1 门禁剔除 / ${r.stats.excluded_no_image} 缺图剔除 / ${r.stats.excluded_no_target_countries} 缺目标国剔除)`)
