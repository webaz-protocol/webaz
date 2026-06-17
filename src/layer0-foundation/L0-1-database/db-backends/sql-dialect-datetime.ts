/**
 * RFC-016 Phase 3 ③a-1 — `datetime('now')` → PostgreSQL 方言译器。
 *
 * 中心化方言转换的第一块(延续 sql-placeholders 的设计):转换【只在 pg 后端内部】跑,
 * call site 全不动、SQLite 路径不经过这里 = 对 SQLite 行为零影响。
 *
 * 仅匹配【裸】`datetime('now')`(单参)。带修饰参的 `datetime('now', '+7 days')` 留给
 * ③a-2(interval 译器),本译器明确放过(`'now'` 后紧跟 `)`,跟逗号的不匹配)。
 *
 * 产出表达式与 scripts/gen-pg-schema.ts 的列默认值【逐字一致】——
 *   `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
 *   (UTC、秒级、'YYYY-MM-DD HH:MM:SS' 字符串),保证运行时写入的时间戳与 schema
 *   默认值同格式,全仓 `datetime('now')` 比较语义在 pg 上不变。
 *
 * 字符串/标识符/注释感知(同 sql-placeholders):`'...'` / `"..."` / `-- …` / `/* … *​/`
 * 里的 `datetime('now')` 不动;`mydatetime('now')`(标识符一部分)不动(词界检查)。
 */

/** 与 gen-pg-schema.ts 的 PG_NOW 逐字一致 —— 改一处必须同改另一处。 */
export const PG_NOW = `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`

// 锚定匹配:datetime ( 'now' ) —— 函数名大小写不敏感,'now' 小写(全仓用法),单参(后跟 `)`)。
const DT_NOW = /datetime\s*\(\s*'now'\s*\)/iy

// ③a-2:datetime('now', <modifier>) 前缀 —— 'now' 后跟逗号(与 ③a-1 的单参形态互斥)。
const DT_NOW_INTERVAL_PREFIX = /datetime\s*\(\s*'now'\s*,\s*/iy

// ③a-2b:datetime( 通用开括号锚 —— 首参为列/表达式(非 'now')的两参 interval 形态入口。
const DT_OPEN = /datetime\s*\(/iy

export interface DialectResult {
  /** 转换后的 SQL。 */
  text: string
  /** 被替换的 `datetime('now')` 个数。 */
  count: number
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

export function translateDatetimeNow(sql: string): DialectResult {
  let out = ''
  let count = 0
  let i = 0
  const len = sql.length

  while (i < len) {
    const c = sql[i]

    // 单引号字符串字面量
    if (c === "'") {
      out += c; i++
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += "''"; i += 2; continue }
          out += "'"; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }

    // 双引号标识符
    if (c === '"') {
      out += c; i++
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { out += '""'; i += 2; continue }
          out += '"'; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }

    // 行注释 -- … 到行尾
    if (c === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') { out += sql[i]; i++ }
      continue
    }

    // 块注释 /* … */
    if (c === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++ }
      if (i < len) { out += '*/'; i += 2 }
      continue
    }

    // datetime('now') —— 仅在词界处尝试:
    //   前置:前一字符非标识符,避免 mydatetime('now');
    //   后置:闭括号后一字符非标识符,避免 datetime('now')x / datetime('now')_x(贴标识符后缀)。
    //         `)::text`(`:`)、`))`、行尾等非标识符后缀仍正常转换。
    if ((c === 'd' || c === 'D') && !isIdentChar(sql[i - 1])) {
      DT_NOW.lastIndex = i
      const m = DT_NOW.exec(sql)
      if (m && m.index === i && !isIdentChar(sql[i + m[0].length])) {
        out += PG_NOW
        i += m[0].length
        count++
        continue
      }
    }

    out += c
    i++
  }

  return { text: out, count }
}

/**
 * ③a-2:`datetime('now', <modifier>)` → pg interval 算术。
 *
 * 统一变换(不解析符号/数值/单位):
 *   datetime('now', X)
 *     → to_char((now() AT TIME ZONE 'UTC') + (X)::interval, 'YYYY-MM-DD HH24:MI:SS')
 *
 * 为什么恒用 `+`:SQLite 修饰串自带符号('-30 days' / '+7 days'),pg `(X)::interval`
 * 解析同样的串,符号在 interval 内部 ——`now() + '-30 days'::interval` = now-30天。
 * 故对所有形态一致成立:
 *   - 字面量:datetime('now', '-30 days')        → (… + ('-30 days')::interval …)
 *   - 拼接参数:datetime('now', '-' || ? || ' days') → (… + ('-' || ? || ' days')::interval …)
 *     (pg 原生支持 `||`;其中 `?` 由后续占位符阶段统一转 `$n`,本译器原样保留)
 *   - 裸参数:datetime('now', ?)                  → (… + (?)::interval …)
 *
 * ⚠️ 仅处理第一参为 `'now'` 的形态。`datetime(<列>, <修饰>)`(如 datetime(expires_at,…))
 *    的 pg 译法不同(列::timestamp + interval),【不在本译器范围】,见 ③a-2b
 *    `translateDatetimeExprInterval`。
 * ⚠️ 全仓审计确认无多修饰(datetime('now', A, B))、无非 interval 修饰
 *    (start of / weekday / localtime / unixepoch),故 `::interval` 强转安全。
 *
 * 字符串/标识符/注释感知 + 前后词界守卫(同 ③a-1)。
 */
export function translateDatetimeInterval(sql: string): DialectResult {
  let out = ''
  let count = 0
  let i = 0
  const len = sql.length

  while (i < len) {
    const c = sql[i]

    // 单引号字符串
    if (c === "'") {
      out += c; i++
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += "''"; i += 2; continue }
          out += "'"; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }
    // 双引号标识符
    if (c === '"') {
      out += c; i++
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { out += '""'; i += 2; continue }
          out += '"'; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }
    // 行注释
    if (c === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') { out += sql[i]; i++ }
      continue
    }
    // 块注释
    if (c === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++ }
      if (i < len) { out += '*/'; i += 2 }
      continue
    }

    // datetime('now', <modifier>) —— 前置词界 + 前缀匹配
    if ((c === 'd' || c === 'D') && !isIdentChar(sql[i - 1])) {
      DT_NOW_INTERVAL_PREFIX.lastIndex = i
      const pm = DT_NOW_INTERVAL_PREFIX.exec(sql)
      if (pm && pm.index === i) {
        // 从前缀(含逗号后空白)之后,扫描修饰表达式到 datetime 的配对 `)`(尊重字符串/嵌套括号)。
        const mod = scanToMatchingParen(sql, i + pm[0].length)
        // 后置词界:闭括号后紧贴标识符字符(datetime('now','-1 day')x)→ 不转换(同 ③a-1 P3 守卫)。
        if (mod && !isIdentChar(sql[mod.endIndex + 1])) {
          const expr = mod.text.trim()
          out += `to_char((now() AT TIME ZONE 'UTC') + (${expr})::interval, 'YYYY-MM-DD HH24:MI:SS')`
          i = mod.endIndex + 1   // 跳过闭括号
          count++
          continue
        }
      }
    }

    out += c
    i++
  }

  return { text: out, count }
}

/**
 * ③a-2b:`datetime(<列|表达式>, <interval 修饰>)` → pg 列时间戳 + interval 算术。
 *
 * 与 ③a-2(首参 'now')互补 —— 首参是【已存储的时间戳文本列/表达式】(如 deadline_at、
 * p.created_at),pg 译法是把该文本 cast 成 timestamp 再加 interval:
 *   datetime(EXPR, MOD)
 *     → to_char((EXPR)::timestamp + (MOD)::interval, 'YYYY-MM-DD HH24:MI:SS')
 *
 * 与 ③a-2 一致:恒用 `+` —— SQLite 修饰串自带符号('+1 days' / '-' || ? || ' minutes'),
 *   pg `(MOD)::interval` 解析同串、符号在 interval 内部;`||` 拼接与 `?` 占位原样保留。
 *   输出 to_char 回 'YYYY-MM-DD HH:MM:SS' 字符串(同 PG_NOW 格式)→ 时间戳列在 pg 上仍存
 *   文本,全仓字符串比较语义(`>` / `=`)不变。
 *
 * 严格只转【确认的两参 interval 形态】:
 *   • 首参为 'now' 字面量 → 跳过(归 ③a-2,与本译器互斥);
 *   • 单参 datetime(<expr>)(无顶层逗号,如 datetime(col) 归一化比较)→ 跳过(不在本子块,
 *     由后续单参归一化子项处理);
 *   • 闭括号后紧贴标识符 → 跳过(词界守卫,同 ③a-1/③a-2)。
 * 全仓盘点(RFC-016 §5)确认仅 2 处命中:auction.deadline_at 反狙击续期、follows restock
 *   窗口(updated_at > created_at + 1 day),均为干净两参 interval。
 *
 * 字符串/标识符/注释感知 + 前后词界守卫(同 ③a-1/③a-2)。
 */
export function translateDatetimeExprInterval(sql: string): DialectResult {
  let out = ''
  let count = 0
  let i = 0
  const len = sql.length

  while (i < len) {
    const c = sql[i]

    // 单引号字符串
    if (c === "'") {
      out += c; i++
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += "''"; i += 2; continue }
          out += "'"; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }
    // 双引号标识符
    if (c === '"') {
      out += c; i++
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { out += '""'; i += 2; continue }
          out += '"'; i++; break
        }
        out += sql[i]; i++
      }
      continue
    }
    // 行注释
    if (c === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') { out += sql[i]; i++ }
      continue
    }
    // 块注释
    if (c === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i++ }
      if (i < len) { out += '*/'; i += 2 }
      continue
    }

    // datetime( —— 前置词界 + 通用开括号匹配,再扫两参
    if ((c === 'd' || c === 'D') && !isIdentChar(sql[i - 1])) {
      DT_OPEN.lastIndex = i
      const om = DT_OPEN.exec(sql)
      if (om && om.index === i) {
        const argsStart = i + om[0].length          // datetime( 之后(首参起点)
        const comma = scanToTopLevelComma(sql, argsStart)
        if (comma !== null) {                        // 有顶层逗号 = 两参形态
          const arg1 = sql.slice(argsStart, comma).trim()
          // 首参 'now' 字面量归 ③a-2;单参(无逗号)上面已 null 跳过。
          if (arg1.toLowerCase() !== "'now'") {
            const mod = scanToMatchingParen(sql, comma + 1)
            // 后置词界:闭括号后紧贴标识符 → 不转换(同 ③a-1/③a-2 守卫)。
            if (mod && !isIdentChar(sql[mod.endIndex + 1])) {
              const modExpr = mod.text.trim()
              out += `to_char((${arg1})::timestamp + (${modExpr})::interval, 'YYYY-MM-DD HH24:MI:SS')`
              i = mod.endIndex + 1   // 跳过闭括号
              count++
              continue
            }
          }
        }
      }
    }

    out += c
    i++
  }

  return { text: out, count }
}

/**
 * 从 `start`(datetime 开括号之内)扫描首参,直到 datetime 内的【顶层逗号】(深度=1)。
 * 尊重单引号字符串('' 转义)与嵌套括号;若先遇配对 `)`(深度归 0,单参形态)返回 null。
 * 返回顶层逗号下标。
 */
function scanToTopLevelComma(sql: string, start: number): number | null {
  let depth = 1
  let j = start
  const len = sql.length
  while (j < len) {
    const ch = sql[j]
    if (ch === "'") {
      j++
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          j++; break
        }
        j++
      }
      continue
    }
    if (ch === '(') { depth++; j++; continue }
    if (ch === ')') {
      depth--
      if (depth === 0) return null   // 单参:配对 ) 先于顶层逗号
      j++
      continue
    }
    if (ch === ',' && depth === 1) return j   // 顶层逗号 = 两参分隔
    j++
  }
  return null
}

/**
 * 从 `start`(datetime 开括号之内、第一参逗号之后)扫描修饰表达式,直到 datetime 的配对 `)`。
 * 已在 datetime 括号内,深度从 1 起;尊重单引号字符串('' 转义),计配对括号。
 * 返回修饰原文 + 闭括号下标;不配对返回 null(留原文不动)。
 */
function scanToMatchingParen(sql: string, start: number): { text: string; endIndex: number } | null {
  let depth = 1
  let j = start
  const len = sql.length
  while (j < len) {
    const ch = sql[j]
    if (ch === "'") {
      j++
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          j++; break
        }
        j++
      }
      continue
    }
    if (ch === '(') { depth++; j++; continue }
    if (ch === ')') {
      depth--
      if (depth === 0) return { text: sql.slice(start, j), endIndex: j }
      j++
      continue
    }
    j++
  }
  return null
}
