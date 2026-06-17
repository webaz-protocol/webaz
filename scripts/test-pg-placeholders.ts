#!/usr/bin/env tsx
/**
 * RFC-016 Phase 2 PR2 — toPgPlaceholders 单元测试(独立 tsx,断言失败即非零退出)。
 *   用法:npm run test:pg-placeholders
 *
 * 覆盖:基本定位、IN 列表、字符串字面量内 `?`、转义内嵌引号、双引号标识符、
 *   行/块注释内 `?`、零占位符、参数对账、编号占位符抛错。
 */
import { toPgPlaceholders } from '../src/layer0-foundation/L0-1-database/db-backends/sql-placeholders.js'

let pass = 0
let fail = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++ }
  else { fail++; fails.push(`✗ ${name}\n    got:  ${g}\n    want: ${w}`) }
}

function throws(name: string, fn: () => unknown): void {
  try { fn(); fail++; fails.push(`✗ ${name} — 期望抛错但没抛`) }
  catch { pass++ }
}

// 1) 基本:两个占位符顺序编号
eq('basic two params',
  toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
  { text: 'SELECT * FROM t WHERE a = $1 AND b = $2', count: 2 })

// 2) IN 列表
eq('IN list',
  toPgPlaceholders('SELECT 1 FROM t WHERE id IN (?, ?, ?)'),
  { text: 'SELECT 1 FROM t WHERE id IN ($1, $2, $3)', count: 3 })

// 3) 字符串字面量里的 ? 不转换
eq('? inside string literal',
  toPgPlaceholders("SELECT '?' AS q, a FROM t WHERE x = ?"),
  { text: "SELECT '?' AS q, a FROM t WHERE x = $1", count: 1 })

// 4) 转义内嵌单引号 '' 不破坏字符串边界,内部 ? 仍跳过
eq('escaped quote in string',
  toPgPlaceholders("SELECT a FROM t WHERE name = 'O''Brien?' AND id = ?"),
  { text: "SELECT a FROM t WHERE name = 'O''Brien?' AND id = $1", count: 1 })

// 5) 双引号标识符里的 ? 不转换(罕见但防御)
eq('? inside double-quoted ident',
  toPgPlaceholders('SELECT "we?ird" FROM t WHERE a = ?'),
  { text: 'SELECT "we?ird" FROM t WHERE a = $1', count: 1 })

// 6) 行注释里的 ? 不转换
eq('? inside line comment',
  toPgPlaceholders('SELECT a -- pick? one\nFROM t WHERE a = ?'),
  { text: 'SELECT a -- pick? one\nFROM t WHERE a = $1', count: 1 })

// 7) 块注释里的 ? 不转换
eq('? inside block comment',
  toPgPlaceholders('SELECT a /* a ? b */ FROM t WHERE a = ?'),
  { text: 'SELECT a /* a ? b */ FROM t WHERE a = $1', count: 1 })

// 8) 零占位符:文本原样
eq('no placeholders',
  toPgPlaceholders('SELECT COUNT(*) FROM t'),
  { text: 'SELECT COUNT(*) FROM t', count: 0 })

// 9) 多行真实查询
eq('multiline realistic',
  toPgPlaceholders('UPDATE orders\n  SET status = ?, updated_at = ?\n  WHERE id = ? AND seller_id = ?'),
  { text: 'UPDATE orders\n  SET status = $1, updated_at = $2\n  WHERE id = $3 AND seller_id = $4', count: 4 })

// 10) 编号占位符抛错(本协议不用 ?N)
throws('numbered placeholder rejected', () => toPgPlaceholders('SELECT ?1'))

// 11) 字符串末尾未闭合不崩(防御,尽力而为)
eq('LIKE pattern with ?',
  toPgPlaceholders("SELECT a FROM t WHERE name LIKE '%?%' AND id = ?"),
  { text: "SELECT a FROM t WHERE name LIKE '%?%' AND id = $1", count: 1 })

console.log(`\ntest:pg-placeholders`)
console.log(`────────────────────`)
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) {
  for (const f of fails) console.error(f)
  console.error('')
  process.exit(1)
}
console.log('✅ all placeholder conversion cases pass\n')
