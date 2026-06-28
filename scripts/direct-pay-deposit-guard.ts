#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — base-bond deposit write-boundary guard (PR-4b-1).
 *
 * direct_receive_deposits 是【商家履约担保物】台账,production_receipt_confirmed_at(+ PR-4b-1 的 production_* 快照)
 *   是 Direct Pay 生产硬门的【唯一真相】。本 guard 静态守住三条边界,防止任何 PR 误开"绕过门"或"manual 冒充生产":
 *
 *   1. routes/** 绝不 raw INSERT/UPDATE direct_receive_deposits(必须经域 helper)。
 *   2. 对 direct_receive_deposits 的 INSERT/UPDATE 只允许出现在 src/direct-receive-deposits.ts(单一写入文件)。
 *   3. production_receipt_confirmed_at 的【写赋值】(SQL SET)只允许出现在 allowlist 文件(单一未来 production-confirm helper)。
 *      —— 当前 allowlist=src/direct-receive-deposits.ts;本 PR 后该列仍【无任何写入方】(读除外)。
 *
 * 纯静态文本扫描;无 DB、无 boot。失败即 exit 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const ROUTES = join(SRC, 'pwa', 'routes')

// 对 direct_receive_deposits 的写入只允许这一个文件(域 helper)。production_receipt_confirmed_at 的写赋值同此 allowlist。
const DEPOSIT_WRITER_ALLOWLIST = new Set(['src/direct-receive-deposits.ts'])

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (e.endsWith('.ts')) out.push(p)
  }
  return out
}
const rel = (p: string) => relative(ROOT, p).split('\\').join('/')

const DEPOSIT_WRITE_RE = /\b(INSERT\s+INTO|UPDATE)\s+direct_receive_deposits\b/i
const PROD_RECEIPT_SET_RE = /production_receipt_confirmed_at\s*=/   // SQL SET 赋值(读如 `!= null` / `IS NOT NULL` 不匹配)

let failed = false
const fail = (m: string) => { failed = true; console.error(`❌ ${m}`) }

// ── guard 1: routes/** 无 raw INSERT/UPDATE direct_receive_deposits ──
for (const f of tsFiles(ROUTES)) {
  if (DEPOSIT_WRITE_RE.test(readFileSync(f, 'utf8'))) {
    fail(`${rel(f)}: raw INSERT/UPDATE direct_receive_deposits in a route — must go through src/direct-receive-deposits.ts helpers (no route-level deposit writes).`)
  }
}

// ── guard 2: 对 direct_receive_deposits 的写入只在 allowlist 文件 ──
// ── guard 3: production_receipt_confirmed_at 的写赋值只在 allowlist 文件 ──
for (const f of tsFiles(SRC)) {
  const r = rel(f)
  const src = readFileSync(f, 'utf8')
  if (DEPOSIT_WRITE_RE.test(src) && !DEPOSIT_WRITER_ALLOWLIST.has(r)) {
    fail(`${r}: writes direct_receive_deposits outside the single writer module — only ${[...DEPOSIT_WRITER_ALLOWLIST].join(', ')} may INSERT/UPDATE it.`)
  }
  if (PROD_RECEIPT_SET_RE.test(src) && !DEPOSIT_WRITER_ALLOWLIST.has(r)) {
    fail(`${r}: assigns production_receipt_confirmed_at outside the allowlisted helper — this column is the sole production go-live gate; its writer must be a single legal-cleared, assertProductionDepositRail-guarded helper.`)
  }
}

if (failed) {
  console.error('\nDirect Pay deposit write-boundary guard FAILED — see above. These boundaries keep the base-bond production gate fail-closed and un-bypassable.')
  process.exit(1)
}
console.log('✅ direct-pay deposit write-boundary guard: no route raw-writes; direct_receive_deposits writes confined to the domain helper; production_receipt_confirmed_at has no out-of-allowlist writer.')
