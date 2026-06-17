#!/usr/bin/env tsx
/**
 * schema-verify (#1016): 扫 server.ts / mcp server 中所有 db.prepare() SQL，
 *   + RFC-016 异步 seam 调用 dbOne/dbAll/dbRun(sql, ...) 的 SQL，
 *   在 readonly DB 上逐条 prepare → 列名 / 表名漂移即时抛错。
 *
 * ⚠️ RFC-016 Phase 1 迁移中:SQL 从 db.prepare() 逐批挪到 dbOne/dbAll/dbRun seam。
 *   两类都必须扫,否则迁移会悄悄掏空 schema 守门覆盖率。
 *
 * 防御场景：
 * - notifications 表新增列后忘了同步老 INSERT（曾在 #986 B2 出过：data 列名 → 应是 actions）
 * - 重名变量冲突导致 SELECT 字段错（曾在 EMAIL_RE 出过）
 * - 拆 server.ts 时 import 漏掉 schema 初始化
 *
 * 局限：不能验证 ${...} 动态拼接 SQL（占少数）。
 *
 * 用法：npm run schema:verify
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

const DB_PATH = process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')

if (!existsSync(DB_PATH)) {
  console.error(`❌ DB not found at ${DB_PATH}`)
  console.error(`   先跑 npm run pwa 让 DB 初始化，再跑本脚本`)
  process.exit(2)
}

// readonly：纯 prepare 不执行，不会动数据
const db = new Database(DB_PATH, { readonly: true })

// 包含 server.ts + 所有 routes/*.ts（#1013 拆分后 SQL 会散到各 routes 模块）
const sources = [
  'src/pwa/server.ts',
  'src/layer1-agent/L1-1-mcp-server/server.ts',
  ...(existsSync('src/pwa/routes')
    ? readdirSync('src/pwa/routes')
        .filter(f => f.endsWith('.ts'))
        .map(f => join('src/pwa/routes', f))
    : []),
]

// 抓 db.prepare(...) — 三种引号；允许引号后有逗号 / 空白再 ) 收尾（多行 prepare 常见）
//   + RFC-016 seam: dbOne/dbAll/dbRun<泛型?>(SQL, [params]?) — SQL 是第一个字符串实参,
//     后面可跟 `, [params])`,故只锚定到字符串字面量起始,不要求紧跟 ) 收尾。
//     `(?:<[^>]*>)?` 仅允许紧跟一个可选泛型(如 dbOne<{ n: number }>)再到 `(`;
//     ⚠️ 不能用 `[^(]*` —— 它会跨过散文/注释里出现的 dbX 一直吃到下一个无关 `(`(误抓邻近 SQL)。
const patterns = [
  /\bdb\.prepare\(\s*`([\s\S]*?)`[\s,]*\)/g,
  /\bdb\.prepare\(\s*'((?:\\'|[^'])*?)'[\s,]*\)/g,
  /\bdb\.prepare\(\s*"((?:\\"|[^"])*?)"[\s,]*\)/g,
  /\b(?:dbOne|dbAll|dbRun)\b(?:<[^>]*>)?\s*\(\s*`([\s\S]*?)`/g,
  /\b(?:dbOne|dbAll|dbRun)\b(?:<[^>]*>)?\s*\(\s*'((?:\\'|[^'])*?)'/g,
  /\b(?:dbOne|dbAll|dbRun)\b(?:<[^>]*>)?\s*\(\s*"((?:\\"|[^"])*?)"/g,
]

const seen = new Set<string>()
let totalScanned = 0
let dynamicSkipped = 0
let passed = 0
const errors: Array<{ file: string; sql: string; error: string }> = []

// Unescape JS string literal escapes back to raw chars (for single/double quoted matches)
// 反转 \' → '，\" → "，\\ → \，\n → newline 等。模板字符串里不需要这步。
function unescapeJsString(s: string, kind: 'single' | 'double' | 'tpl'): string {
  if (kind === 'tpl') return s
  return s
    .replace(/\\\\/g, '')         // 先占位 \\ 防双重替换
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(//g, '\\')
}

for (const file of sources) {
  if (!existsSync(file)) continue
  const src = readFileSync(file, 'utf8')
  const kinds: Array<'tpl' | 'single' | 'double'> = ['tpl', 'single', 'double', 'tpl', 'single', 'double']
  patterns.forEach((re, i) => {
    for (const m of src.matchAll(re)) {
      totalScanned++
      const raw = m[1].trim()
      // 动态拼接（${...} 或字符串拼接）跳过 — 无法静态校验
      if (raw.includes('${')) { dynamicSkipped++; continue }
      const sql = unescapeJsString(raw, kinds[i])
      if (seen.has(sql)) continue
      seen.add(sql)
      try {
        db.prepare(sql)
        passed++
      } catch (e) {
        errors.push({ file, sql: sql.slice(0, 220).replace(/\s+/g, ' '), error: (e as Error).message })
      }
    }
  })
}

console.log(`\nschema:verify result`)
console.log(`────────────────────`)
console.log(`  scanned   ${totalScanned} SQL sites (db.prepare + dbOne/dbAll/dbRun seam)`)
console.log(`  unique    ${seen.size} distinct SQL strings`)
console.log(`  dynamic   ${dynamicSkipped} skipped (\${...} interpolation)`)
console.log(`  ✅ passed  ${passed}`)
console.log(`  ❌ failed  ${errors.length}\n`)

if (errors.length > 0) {
  console.error(`failures:`)
  for (const e of errors.slice(0, 30)) {
    console.error(`  • [${e.file}]`)
    console.error(`    error: ${e.error}`)
    console.error(`    sql:   ${e.sql}\n`)
  }
  if (errors.length > 30) console.error(`  ... and ${errors.length - 30} more\n`)
  process.exit(1)
}
console.log(`✅ all SQL prepares pass against current DB schema\n`)
