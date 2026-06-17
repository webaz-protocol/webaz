/**
 * RFC-016 — `?` → `$1..$n` 占位符转换(Phase 2 PR2)。
 *
 * 全仓 SQL 用 SQLite 风格匿名 `?` 占位符 + 数组传参(seam 约定)。pg 用 `$1..$n`。
 * 本转换【只在 pg 后端内部】跑(见 pg-backend.ts);SQLite 路径不经过这里,仍原样收 `?`。
 * 故对 SQLite 行为零影响 —— 纯增量,集中一处。
 *
 * 必须感知字符串/标识符/注释,不能把字面量里的 `?` 误当占位符:
 *   • 单引号字符串 `'...'`(SQLite/pg 同用 `''` 转义内嵌单引号,无反斜杠转义)
 *   • 双引号标识符 `"..."`(`""` 转义内嵌双引号)
 *   • 行注释 `-- ... \n`、块注释 `/* ... *​/`
 * 遇到编号占位符 `?1`(better-sqlite3 支持但本协议不用)直接抛错,绝不静默错配。
 */

export interface PgSqlResult {
  /** 转换后的 pg SQL(`?` → `$1..$n`)。 */
  text: string
  /** 占位符个数 —— 调用方可与 params.length 对账。 */
  count: number
}

export function toPgPlaceholders(sql: string): PgSqlResult {
  let out = ''
  let n = 0
  let i = 0
  const len = sql.length

  while (i < len) {
    const c = sql[i]

    // 单引号字符串字面量
    if (c === "'") {
      out += c
      i++
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += "''"; i += 2; continue } // 转义的内嵌单引号
          out += "'"; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }

    // 双引号标识符
    if (c === '"') {
      out += c
      i++
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { out += '""'; i += 2; continue } // 转义的内嵌双引号
          out += '"'; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }

    // 行注释 -- ... 到行尾
    if (c === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') { out += sql[i]; i++ }
      continue
    }

    // 块注释 /* ... */
    if (c === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++ }
      if (i < len) { out += '*/'; i += 2 }
      continue
    }

    // 占位符
    if (c === '?') {
      const next = sql[i + 1]
      if (next >= '0' && next <= '9') {
        throw new Error(
          `toPgPlaceholders: 不支持编号占位符 "?${next}…" —— 本协议仅用匿名 "?" 定位参数`,
        )
      }
      n++
      out += '$' + n
      i++
      continue
    }

    out += c
    i++
  }

  return { text: out, count: n }
}
