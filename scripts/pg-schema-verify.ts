#!/usr/bin/env tsx
/**
 * RFC-016 Phase 2 PR3 — PostgreSQL schema 校验(db/schema.pg.sql)。
 *   用法:npm run pg:verify
 *
 * 三层校验,逐层尽力而为(缺依赖则跳过并明确报告,绝不假阳/假阴):
 *
 *   ① 静态 lint(始终跑,无需任何外部依赖)——
 *      扫 db/schema.pg.sql 找【方言泄漏】(SQLite-ism 漏转 = 导入 pg 时必炸):
 *        datetime()/date() · AUTOINCREMENT · INTEGER/REAL/BLOB 裸类型 ·
 *        DEFAULT "双引号串"(pg 当标识符) · 裸 CURRENT_TIMESTAMP · `?` 占位符;
 *      + 结构:每个 CREATE TABLE/INDEX 必须 IF NOT EXISTS(幂等) · BEGIN/COMMIT 配平;
 *      + PG 保留字裸列/表名(import 时需引号)。
 *
 *   ② parity(SQLite DB 存在时)——
 *      内省 live SQLite 的表/索引数,与 schema.pg.sql 中的 CREATE 计数对账;
 *      不等 = 产物 stale,提示重跑 npm run pg:schema。
 *
 *   ③ live-connect smoke(DATABASE_URL 存在时)——
 *      连真实 pg,在事务里执行整份 DDL 再 ROLLBACK(非持久),证明真能 parse+执行。
 *      无 DATABASE_URL 时跳过并报告(这一步等用户开 Railway PG 后才能跑)。
 *
 * 退出码:0 通过 · 1 静态/ parity 失败 · 2 产物缺失 · 3 live smoke 失败。
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'

const PG_SQL_PATH = join('db', 'schema.pg.sql')
const SQLITE_DB_PATH = process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')

if (!existsSync(PG_SQL_PATH)) {
  console.error(`❌ 找不到 ${PG_SQL_PATH} —— 先跑 npm run pg:schema 生成`)
  process.exit(2)
}

const raw = readFileSync(PG_SQL_PATH, 'utf8')
if (raw.trim().length === 0) {
  console.error(`❌ ${PG_SQL_PATH} 为空`)
  process.exit(2)
}

/** 去 `--` 行注释(本产物无块注释),避免注释里的词触发方言泄漏误报。 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}
const body = stripComments(raw)

const failures: string[] = []

// ── ① 静态方言泄漏 lint ──
interface Leak { name: string; re: RegExp }
const leaks: Leak[] = [
  { name: "datetime()/date() 未转 PG", re: /\b(?:datetime|date)\s*\(/gi },
  { name: 'strftime() 未转 PG', re: /\bstrftime\s*\(/gi },
  { name: 'AUTOINCREMENT 残留', re: /\bAUTOINCREMENT\b/gi },
  { name: 'INTEGER 裸类型(应 BIGINT)', re: /\bINTEGER\b/gi },
  { name: 'REAL 裸类型(应 DOUBLE PRECISION)', re: /\bREAL\b/gi },
  { name: 'BLOB 裸类型(应 BYTEA)', re: /\bBLOB\b/gi },
  { name: 'DEFAULT "双引号串"(pg 当标识符)', re: /\bDEFAULT\s+"/gi },
  { name: '裸 CURRENT_TIMESTAMP(应转 PG now)', re: /\bCURRENT_TIMESTAMP\b/gi },
  { name: '`?` 占位符出现在 DDL', re: /\?/g },
  { name: 'GLOB(SQLite-ism,应由 gen-pg-schema 转 PG ~/!~ 正则)', re: /\bGLOB\b/gi },
]
for (const { name, re } of leaks) {
  const hits = [...body.matchAll(re)]
  if (hits.length) failures.push(`方言泄漏:${name} ×${hits.length}`)
}

// ── ① 结构:IF NOT EXISTS 幂等 ──
const createTableTotal = (body.match(/\bCREATE\s+TABLE\b/gi) || []).length
const createTableIne = (body.match(/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/gi) || []).length
if (createTableTotal !== createTableIne) {
  failures.push(`CREATE TABLE 未全部 IF NOT EXISTS(${createTableIne}/${createTableTotal})`)
}
const createIdxTotal = (body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi) || []).length
const createIdxIne = (body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi) || []).length
if (createIdxTotal !== createIdxIne) {
  failures.push(`CREATE INDEX 未全部 IF NOT EXISTS(${createIdxIne}/${createIdxTotal})`)
}

// ── ① 结构:BEGIN/COMMIT 配平 ──
const beginN = (body.match(/^\s*BEGIN;\s*$/gim) || []).length
const commitN = (body.match(/^\s*COMMIT;\s*$/gim) || []).length
if (beginN !== 1 || commitN !== 1) {
  failures.push(`事务包裹不配平:BEGIN×${beginN} / COMMIT×${commitN}(应各 1)`)
} else if (body.search(/\bBEGIN;/i) > body.search(/\bCOMMIT;/i)) {
  failures.push('BEGIN 出现在 COMMIT 之后')
}

// ── ① PG 保留字裸列/表名 ──
const PG_RESERVED = new Set([
  'user', 'order', 'group', 'references', 'check', 'default', 'table',
  'column', 'select', 'where', 'from', 'to', 'desc', 'asc', 'limit',
  'offset', 'primary', 'foreign', 'constraint', 'window', 'end', 'all',
])
const reservedHits = new Set<string>()
// 列定义行首裸 token(去引号后)落在保留字集合 → import 需引号
for (const line of body.split('\n')) {
  const m = line.trim().match(/^["`]?([a-z_]+)["`]?\s+(TEXT|BIGINT|DOUBLE\s+PRECISION|BYTEA|DECIMAL|NUMERIC|BOOLEAN)/i)
  if (m && !line.includes('"' + m[1] + '"') && PG_RESERVED.has(m[1].toLowerCase())) {
    reservedHits.add(m[1].toLowerCase())
  }
}
const tableNameRe = /\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi
for (const m of body.matchAll(tableNameRe)) {
  if (PG_RESERVED.has(m[1].toLowerCase())) reservedHits.add(m[1].toLowerCase())
}
if (reservedHits.size) {
  failures.push(`PG 保留字裸名(需加双引号):${[...reservedHits].join(', ')}`)
}

console.log(`\npg:verify`)
console.log(`─────────`)
console.log(`  产物        ${PG_SQL_PATH}`)
console.log(`  CREATE TABLE ${createTableTotal}(全 IF NOT EXISTS: ${createTableTotal === createTableIne ? '✅' : '❌'})`)
console.log(`  CREATE INDEX ${createIdxTotal}(全 IF NOT EXISTS: ${createIdxTotal === createIdxIne ? '✅' : '❌'})`)
console.log(`  事务包裹     BEGIN×${beginN} / COMMIT×${commitN}`)

// ── ② parity(需 SQLite DB)──
// 解析 pg 产物每张表的列名集合(深度感知逗号切分;跳过表级约束行)。
//   为什么逐列:计数 parity 抓不住"列漏同步"(#250 审计:S0 12 列只进了 SQLite,表数/索引数照样相等)。
function pgTableColumns(sql: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?([a-zA-Z_]+)"?\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    let depth = 1; let i = re.lastIndex
    for (; i < sql.length && depth > 0; i++) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth-- }
    const inner = sql.slice(re.lastIndex, i - 1)
    const parts: string[] = []
    let d = 0; let start = 0
    for (let j = 0; j < inner.length; j++) {
      const ch = inner[j]
      if (ch === '(') d++
      else if (ch === ')') d--
      else if (ch === ',' && d === 0) { parts.push(inner.slice(start, j)); start = j + 1 }
    }
    parts.push(inner.slice(start))
    const cols = new Set<string>()
    for (const part of parts) {
      const tok = part.trim().match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?/)
      if (!tok) continue
      if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'].includes(tok[1].toUpperCase())) continue
      cols.add(tok[1].toLowerCase())
    }
    map.set(m[1].toLowerCase(), cols)
    re.lastIndex = i
  }
  return map
}

function pgTablePositions(sql: string): Map<string, number> {
  const positions = new Map<string, number>()
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/g
  for (const match of sql.matchAll(re)) positions.set(match[1].toLowerCase(), match.index)
  return positions
}

if (existsSync(SQLITE_DB_PATH)) {
  const sdb = new Database(SQLITE_DB_PATH, { readonly: true })
  const sdbTriggers = (): { tbl: string; op: string }[] =>
    (sdb.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' AND (name LIKE '%_no_update' OR name LIKE '%_no_delete')`).all() as { name: string; tbl_name: string }[])
      .map(r => ({ tbl: r.tbl_name.toLowerCase(), op: r.name.endsWith('_no_update') ? 'UPDATE' : 'DELETE' }))
  const t = sdb.prepare(
    `SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`,
  ).get() as { n: number }
  const ix = sdb.prepare(
    `SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`,
  ).get() as { n: number }
  console.log(`  parity      SQLite 表 ${t.n} / pg 表 ${createTableTotal} · SQLite 索引 ${ix.n} / pg 索引 ${createIdxTotal}`)
  if (t.n !== createTableTotal) failures.push(`表数不匹配:SQLite ${t.n} vs pg ${createTableTotal} —— 产物 stale,重跑 npm run pg:schema`)
  if (ix.n !== createIdxTotal) failures.push(`索引数不匹配:SQLite ${ix.n} vs pg ${createIdxTotal} —— 产物 stale,重跑 npm run pg:schema`)
  // 逐表逐列 parity(#250 审计根治)
  const pgCols = pgTableColumns(body)
  const tables = sdb.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`).all() as { name: string; sql: string }[]
  const colDiffs: string[] = []
  for (const { name } of tables) {
    const sCols = new Set((sdb.prepare(`PRAGMA table_info(${JSON.stringify(name).replace(/"/g, '')})`).all() as { name: string }[]).map(c => c.name.toLowerCase()))
    const pCols = pgCols.get(name.toLowerCase())
    if (!pCols) continue   // 表数 parity 已另报
    const missing = [...sCols].filter(c => !pCols.has(c))
    const extra = [...pCols].filter(c => !sCols.has(c))
    if (missing.length) colDiffs.push(`${name}: pg 缺列 [${missing.join(', ')}]`)
    if (extra.length) colDiffs.push(`${name}: pg 多列 [${extra.join(', ')}](SQLite 已删?)`)
  }
  if (colDiffs.length) {
    failures.push(`列 parity 不匹配 ×${colDiffs.length} —— 产物 stale,重跑 npm run pg:schema:`)
    for (const dLine of colDiffs.slice(0, 12)) failures.push(`    ${dLine}`)
    if (colDiffs.length > 12) failures.push(`    …及另外 ${colDiffs.length - 12} 张表`)
  } else {
    console.log(`  列 parity   ✅ 全部 ${tables.length} 张表列集合一致`)
  }
  // PostgreSQL resolves an inline REFERENCES target at CREATE TABLE time.
  // SQLite allows forward references, so verify the generated artifact has
  // every referenced table earlier than its dependent table.
  const tablePositions = pgTablePositions(body)
  const orderDiffs: string[] = []
  for (const table of tables) {
    const tableName = table.name.toLowerCase()
    const tablePosition = tablePositions.get(tableName)
    if (tablePosition === undefined) continue
    for (const match of table.sql.matchAll(/\bREFERENCES\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi)) {
      const dependencyName = match[1].toLowerCase()
      if (dependencyName === tableName) continue
      const dependencyPosition = tablePositions.get(dependencyName)
      if (dependencyPosition !== undefined && dependencyPosition > tablePosition) {
        orderDiffs.push(`${table.name}: REFERENCES ${match[1]} before target exists`)
      }
    }
  }
  if (orderDiffs.length) {
    failures.push(`PG 外键建表顺序错误 ×${orderDiffs.length} —— gen-pg-schema 必须按 REFERENCES 拓扑排序:`)
    for (const dLine of orderDiffs.slice(0, 12)) failures.push(`    ${dLine}`)
  } else {
    console.log(`  FK order    ✅ 所有 REFERENCES 目标先于依赖表创建`)
  }
  // 不可变性 trigger parity(#252 审计):SQLite 里有 *_no_update/*_no_delete 触发器的表,
  //   PG 产物必须有对应 BEFORE UPDATE/DELETE 守卫 —— 否则 PG 导入后 append-only/immutable 审计不变量静默消失。
  //   以 sqlite_master 内省为准(不靠 gen 白名单自证),表名从 tbl_name 取(trigger 名不含全表名,如 trg_dr_qr_no_update)。
  const sTrigs = sdbTriggers()
  const trigDiffs: string[] = []
  for (const { tbl, op } of sTrigs) {
    const re = new RegExp(`CREATE\\s+TRIGGER\\s+\\S+\\s+BEFORE\\s+${op}\\s+ON\\s+"?${tbl}"?\\b`, 'i')
    if (!re.test(body)) trigDiffs.push(`${tbl}: 缺 BEFORE ${op} 守卫`)
  }
  if (trigDiffs.length) {
    failures.push(`不可变性 trigger parity 不匹配 ×${trigDiffs.length} —— 把表加进 gen-pg-schema APPEND_ONLY_TABLES 再重跑:`)
    for (const dLine of trigDiffs) failures.push(`    ${dLine}`)
  } else {
    console.log(`  trigger     ✅ ${sTrigs.length} 条不可变性守卫全部有 PG 对应`)
  }
  sdb.close()
} else {
  console.log(`  parity      ⏭  跳过(无 SQLite DB at ${SQLITE_DB_PATH})`)
}

if (failures.length) {
  console.error(`\n❌ 静态/parity 校验失败(${failures.length}):`)
  for (const f of failures) console.error(`  • ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`\n✅ 静态 + parity 校验通过`)

// ── ③ live-connect smoke(需 DATABASE_URL)──
if (!process.env.DATABASE_URL) {
  console.log(`⏭  live-connect smoke 跳过 —— 设 DATABASE_URL 后跑真实 pg(在事务里执行 DDL 再 ROLLBACK,非持久)。`)
  console.log(`   (Railway PG 就绪前,这是预期状态:静态层已能挡住绝大多数方言漂移。)\n`)
  process.exit(0)
}

await (async () => {
  console.log(`\nlive-connect smoke → ${process.env.DATABASE_URL!.replace(/:[^:@/]+@/, ':****@')}`)
  const pg = await import('pg')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  // 去掉产物自带的 BEGIN;/COMMIT;,改用我们自己的 BEGIN … ROLLBACK 包裹(非持久 smoke)
  const ddl = raw
    .split('\n')
    .filter(l => !/^\s*(BEGIN|COMMIT);\s*$/i.test(l))
    .join('\n')
  try {
    await client.connect()
    await client.query('BEGIN')
    await client.query(ddl)
    await client.query('ROLLBACK')
    console.log(`✅ live smoke 通过 —— 整份 DDL 在真实 pg parse + 执行成功(已 ROLLBACK,未持久)`)

    // RFC-028 S1b/S1c0: prove both additive DPoP binding migrations work on
    // OLD token tables, are idempotent, preserve NULL bearer rows, and enforce
    // canonical RFC 7638 thumbprints in a real PostgreSQL parser/runtime.
    const dpopTables = ['oauth_access_tokens', 'oauth_refresh_tokens'] as const
    await client.query('BEGIN')
    for (const [i, table] of dpopTables.entries()) {
      const dpopUpgrade = ddl.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS dpop_jkt TEXT\\s+CHECK\\([\\s\\S]*?\\);`))?.[0]
      if (!dpopUpgrade) throw new Error(`missing ${table} dpop_jkt additive migration`)
      await client.query(`CREATE TEMP TABLE ${table} (token_hash TEXT PRIMARY KEY) ON COMMIT DROP`)
      await client.query(dpopUpgrade)
      await client.query(dpopUpgrade)
      const columns = await client.query<{ n: string }>(`
        SELECT COUNT(*)::text AS n FROM pg_attribute
         WHERE attrelid=$1::regclass AND attname='dpop_jkt' AND NOT attisdropped`, [table])
      if (columns.rows[0]?.n !== '1') throw new Error(`${table} dpop_jkt migration is not idempotent`)
      await client.query(`INSERT INTO ${table}(token_hash,dpop_jkt) VALUES ($1,$2),($3,NULL)`, [`valid_${i}`, 'A'.repeat(43), `bearer_${i}`])
      for (const [caseName, invalidJkt] of [['bad_char', `${'A'.repeat(42)}!`], ['bad_tail', `${'A'.repeat(42)}B`]] as const) {
        const savepoint = `invalid_jkt_${i}_${caseName}`
        await client.query(`SAVEPOINT ${savepoint}`)
        let invalidRejected = false
        try {
          await client.query(`INSERT INTO ${table}(token_hash,dpop_jkt) VALUES ($1,$2)`, [`${caseName}_${i}`, invalidJkt])
        } catch {
          invalidRejected = true
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }
        if (!invalidRejected) throw new Error(`${caseName} dpop_jkt passed ${table} PostgreSQL CHECK`)
      }
    }
    await client.query('ROLLBACK')
    console.log(`✅ additive upgrade smoke 通过 —— 旧 access+refresh token 表补列幂等 + nullable canonical JKT CHECK 生效\n`)
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    console.error(`❌ live smoke 失败:${(e as Error).message}\n`)
    await client.end()
    process.exit(3)
  }
  await client.end()
})()
