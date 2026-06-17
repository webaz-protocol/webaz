#!/usr/bin/env tsx
/**
 * RFC-016 Phase 3 ③a-1 — translateDatetimeNow 单元测试(独立 tsx,失败即非零退出)。
 *   用法:npm run test:pg-datetime
 *
 * 覆盖:裸 datetime('now') 转换、计数、多处、空白变体、函数名大小写、
 *   带参 datetime('now','+N')【放过】、字符串/标识符/注释内【放过】、词界【放过】、
 *   与 `?` 共存(不动 `?`)、产出与 PG_NOW 逐字一致。
 */
import { translateDatetimeNow, translateDatetimeInterval, translateDatetimeExprInterval, PG_NOW } from '../src/layer0-foundation/L0-1-database/db-backends/sql-dialect-datetime.js'

let pass = 0
let fail = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++ }
  else { fail++; fails.push(`✗ ${name}\n    got:  ${g}\n    want: ${w}`) }
}

const NOW = PG_NOW

// 1) 裸 datetime('now') → PG_NOW,count 1
eq('bare datetime(now)',
  translateDatetimeNow("INSERT INTO t(created_at) VALUES (datetime('now'))"),
  { text: `INSERT INTO t(created_at) VALUES (${NOW})`, count: 1 })

// 2) 多处
eq('two occurrences',
  translateDatetimeNow("SELECT datetime('now'), datetime('now')"),
  { text: `SELECT ${NOW}, ${NOW}`, count: 2 })

// 3) 空白变体
eq('whitespace variant',
  translateDatetimeNow("WHERE a < datetime(  'now'  )"),
  { text: `WHERE a < ${NOW}`, count: 1 })

// 4) 函数名大小写不敏感
eq('uppercase func name',
  translateDatetimeNow("SELECT DATETIME('now')"),
  { text: `SELECT ${NOW}`, count: 1 })

// 5) 带修饰参 → 放过(③a-2 处理),count 0
eq('interval form left untouched',
  translateDatetimeNow("WHERE expires_at < datetime('now', '+7 days')"),
  { text: "WHERE expires_at < datetime('now', '+7 days')", count: 0 })

// 6) 字符串字面量内 → 放过
eq('inside string literal',
  translateDatetimeNow("SELECT 'datetime(''now'')' AS lit, datetime('now')"),
  { text: `SELECT 'datetime(''now'')' AS lit, ${NOW}`, count: 1 })

// 7) 双引号标识符内 → 放过
eq('inside double-quoted ident',
  translateDatetimeNow('SELECT "datetime(\'now\')" FROM t'),
  { text: 'SELECT "datetime(\'now\')" FROM t', count: 0 })

// 8) 行注释内 → 放过
eq('inside line comment',
  translateDatetimeNow("SELECT 1 -- datetime('now') here\n, datetime('now')"),
  { text: `SELECT 1 -- datetime('now') here\n, ${NOW}`, count: 1 })

// 9) 块注释内 → 放过
eq('inside block comment',
  translateDatetimeNow("SELECT /* datetime('now') */ datetime('now')"),
  { text: `SELECT /* datetime('now') */ ${NOW}`, count: 1 })

// 10) 词界:mydatetime('now') 不动
eq('identifier prefix not matched',
  translateDatetimeNow("SELECT mydatetime('now'), datetime('now')"),
  { text: `SELECT mydatetime('now'), ${NOW}`, count: 1 })

// 11) 与 `?` 共存:不动 `?`(留给占位符阶段)
eq('coexists with ? placeholder',
  translateDatetimeNow("UPDATE t SET updated_at = datetime('now') WHERE id = ?"),
  { text: `UPDATE t SET updated_at = ${NOW} WHERE id = ?`, count: 1 })

// 12) 无 datetime:原样
eq('no datetime',
  translateDatetimeNow('SELECT 1 FROM t WHERE a = ?'),
  { text: 'SELECT 1 FROM t WHERE a = ?', count: 0 })

// 13) PG_NOW 与 gen-pg-schema 的列默认值逐字一致(防漂移)
eq('PG_NOW canonical form',
  PG_NOW,
  "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')")

// 14) 后缀邻接标识符 → 放过(Codex P3:datetime('now')x 不应转换)
eq('trailing ident suffix x not matched',
  translateDatetimeNow("SELECT datetime('now')x"),
  { text: "SELECT datetime('now')x", count: 0 })

// 15) 后缀下划线标识符 → 放过
eq('trailing ident suffix _x not matched',
  translateDatetimeNow("SELECT datetime('now')_x"),
  { text: "SELECT datetime('now')_x", count: 0 })

// 16) `::text` cast → 仍转换(`:` 非标识符)
eq('cast ::text still converts',
  translateDatetimeNow("SELECT datetime('now')::text"),
  { text: `SELECT ${NOW}::text`, count: 1 })

// 17) 外层括号 → 仍转换(`)` 非标识符)
eq('wrapping parens still converts',
  translateDatetimeNow("SELECT (datetime('now'))"),
  { text: `SELECT (${NOW})`, count: 1 })

// ───────────────────────── ③a-2 interval translator ─────────────────────────
const IV = (expr: string) => `to_char((now() AT TIME ZONE 'UTC') + (${expr})::interval, 'YYYY-MM-DD HH24:MI:SS')`

// 18) 字面量 -30 days
eq('interval literal -30 days',
  translateDatetimeInterval("WHERE x < datetime('now', '-30 days')"),
  { text: `WHERE x < ${IV("'-30 days'")}`, count: 1 })

// 19) 无逗号后空格变体
eq('interval no-space comma',
  translateDatetimeInterval("WHERE x < datetime('now','-1 day')"),
  { text: `WHERE x < ${IV("'-1 day'")}`, count: 1 })

// 20) 正号 +7 days
eq('interval +7 days',
  translateDatetimeInterval("SET deadline = datetime('now', '+7 days')"),
  { text: `SET deadline = ${IV("'+7 days'")}`, count: 1 })

// 21) hour 单位
eq('interval -1 hour',
  translateDatetimeInterval("datetime('now', '-1 hour')"),
  { text: IV("'-1 hour'"), count: 1 })

// 22) 拼接参数 '-' || ? || ' days' —— 原样保留(? 留给占位符阶段),pg || 兼容
eq('interval concat param',
  translateDatetimeInterval("WHERE x < datetime('now', '-' || ? || ' days')"),
  { text: `WHERE x < ${IV("'-' || ? || ' days'")}`, count: 1 })

// 23) 裸参数 ? 作整个修饰
eq('interval bare param',
  translateDatetimeInterval("WHERE x < datetime('now', ?)"),
  { text: `WHERE x < ${IV("?")}`, count: 1 })

// 24) interval 译器【放过】单参 datetime('now')(留 ③a-1)
eq('interval leaves bare datetime(now)',
  translateDatetimeInterval("SELECT datetime('now')"),
  { text: "SELECT datetime('now')", count: 0 })

// 25) 字符串字面量内 → 放过
eq('interval inside string literal',
  translateDatetimeInterval("SELECT 'datetime(''now'', ''-1 day'')', datetime('now', '-1 day')"),
  { text: `SELECT 'datetime(''now'', ''-1 day'')', ${IV("'-1 day'")}`, count: 1 })

// 26) 后缀邻接标识符 → 放过(同 ③a-1 P3 守卫)
eq('interval trailing ident suffix not matched',
  translateDatetimeInterval("SELECT datetime('now', '-1 day')x"),
  { text: "SELECT datetime('now', '-1 day')x", count: 0 })

// 27) 修饰前后空白 → 表达式 trim,字符串内容不变
eq('interval trims expr whitespace',
  translateDatetimeInterval("WHERE x < datetime('now',   '-1 day'  )"),
  { text: `WHERE x < ${IV("'-1 day'")}`, count: 1 })

// 28) 链式(pg-backend 同序:interval → now)处理混合两形态 + 保留 `?`
{
  const mixed = "WHERE a < datetime('now', '-7 days') AND b = datetime('now') AND id = ?"
  const chained = translateDatetimeNow(translateDatetimeInterval(mixed).text).text
  eq('chained interval→now on mixed',
    chained,
    `WHERE a < ${IV("'-7 days'")} AND b = ${NOW} AND id = ?`)
}

// ──────────────────── ③a-2b datetime(<expr>, interval) translator ────────────────────
const EV = (e: string, m: string) => `to_char((${e})::timestamp + (${m})::interval, 'YYYY-MM-DD HH24:MI:SS')`

// 29) 真实 call site:follows restock 窗口 datetime(p.created_at, '+1 days')
eq('expr-interval p.created_at +1 days',
  translateDatetimeExprInterval("AND p.updated_at > datetime(p.created_at, '+1 days')"),
  { text: `AND p.updated_at > ${EV('p.created_at', "'+1 days'")}`, count: 1 })

// 30) 真实 call site:auction 反狙击续期 datetime(deadline_at, '+' || ? || ' minutes')(? 原样保留)
eq('expr-interval deadline_at concat param',
  translateDatetimeExprInterval("SET deadline_at = datetime(deadline_at, '+' || ? || ' minutes')"),
  { text: `SET deadline_at = ${EV('deadline_at', "'+' || ? || ' minutes'")}`, count: 1 })

// 31) 裸列名首参
eq('expr-interval bare column',
  translateDatetimeExprInterval("WHERE expires_at < datetime(expires_at, '-1 hour')"),
  { text: `WHERE expires_at < ${EV('expires_at', "'-1 hour'")}`, count: 1 })

// 32) 首参 'now' → 放过(归 ③a-2,本译器互斥不动)
eq('expr-interval leaves now-form untouched',
  translateDatetimeExprInterval("WHERE x < datetime('now', '-30 days')"),
  { text: "WHERE x < datetime('now', '-30 days')", count: 0 })

// 33) 单参 datetime(<expr>) 归一化(无顶层逗号)→ 放过(不在本子块)
eq('expr-interval leaves single-arg normalization',
  translateDatetimeExprInterval("WHERE datetime(decline_contest_deadline) < datetime(?)"),
  { text: "WHERE datetime(decline_contest_deadline) < datetime(?)", count: 0 })

// 34) 单参 datetime('now') → 放过(留 ③a-1)
eq('expr-interval leaves bare datetime(now)',
  translateDatetimeExprInterval("SELECT datetime('now')"),
  { text: "SELECT datetime('now')", count: 0 })

// 35) 字符串字面量内 → 放过
eq('expr-interval inside string literal',
  translateDatetimeExprInterval("SELECT 'datetime(col, ''+1 days'')', datetime(col, '+1 days')"),
  { text: `SELECT 'datetime(col, ''+1 days'')', ${EV('col', "'+1 days'")}`, count: 1 })

// 36) 词界:mydatetime(col,…) 不动
eq('expr-interval identifier prefix not matched',
  translateDatetimeExprInterval("SELECT mydatetime(col, '+1 days'), datetime(col, '+1 days')"),
  { text: `SELECT mydatetime(col, '+1 days'), ${EV('col', "'+1 days'")}`, count: 1 })

// 37) 后缀邻接标识符 → 放过(同 ③a-1/③a-2 守卫)
eq('expr-interval trailing ident suffix not matched',
  translateDatetimeExprInterval("SELECT datetime(col, '+1 days')x"),
  { text: "SELECT datetime(col, '+1 days')x", count: 0 })

// 38) 嵌套括号首参(函数调用)→ 顶层逗号正确识别
eq('expr-interval nested-paren first arg',
  translateDatetimeExprInterval("SELECT datetime(coalesce(a, b), '+1 days')"),
  { text: `SELECT ${EV('coalesce(a, b)', "'+1 days'")}`, count: 1 })

// 39) pg-backend 链式同序(interval → expr-interval → now)处理三形态混合
{
  const mixed = "WHERE a < datetime('now', '-7 days') AND b > datetime(p.created_at, '+1 days') AND c = datetime('now') AND id = ?"
  let s = translateDatetimeInterval(mixed).text
  s = translateDatetimeExprInterval(s).text
  s = translateDatetimeNow(s).text
  eq('chained 3-translator on mixed',
    s,
    `WHERE a < ${IV("'-7 days'")} AND b > ${EV('p.created_at', "'+1 days'")} AND c = ${NOW} AND id = ?`)
}

console.log(`\ntest:pg-datetime`)
console.log(`────────────────`)
console.log(`  ✅ pass  ${pass}`)
console.log(`  ❌ fail  ${fail}\n`)
if (fails.length) {
  for (const f of fails) console.error(f)
  console.error('')
  process.exit(1)
}
console.log('✅ all datetime dialect cases pass (③a-1 now · ③a-2 now-interval · ③a-2b expr-interval)\n')
