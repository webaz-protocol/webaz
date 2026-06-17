/**
 * RFC-016 — PostgreSQL seam 后端【骨架】(Phase 2)。
 *
 * 现状(Phase 2 PR2):占位符层【已补全】—— query 路径用 toPgPlaceholders 把 SQLite 风格
 *   匿名 `?` 转成 pg 的 `$1..$n`,再发 pool.query。但本后端【仍未接入启动】:
 *     • SQL 方言(datetime('now') / INSERT OR IGNORE / ON CONFLICT 等)未转换 —— 留 Phase 3;
 *       故即便现在用 DATABASE_URL 选中本后端,查询会在【pg 方言层】真实报错(by design,非静默);
 *     • 事务行锁(dbTx / BEGIN-COMMIT + FOR UPDATE)留 Phase 3;
 *     • dbRun 的 lastInsertRowid:pg 无隐式 rowid,Phase 3 那 2 个用点改 RETURNING(此处暂回 0)。
 *   生产全程跑 SQLite,本文件不在任何启动路径被调用。
 *
 * 接入方式(Phase 3 切换时):`import { setSeamBackend } from '../db.js'` +
 *   `setSeamBackend(createPgBackend())`。Phase 2 不调用。
 *
 * pg 包为纯 JS(无需 libpq/native 编译),且仅在本文件 lazy `import('pg')`,
 *   SQLite 路径永不加载 —— 故添加 pg 依赖对现有运行零影响。
 */
import type { Pool } from 'pg'
import type { SeamBackend, DbRunResult } from '../db.js'
import { toPgPlaceholders } from './sql-placeholders.js'
import { translateDatetimeNow, translateDatetimeInterval, translateDatetimeExprInterval } from './sql-dialect-datetime.js'

export function createPgBackend(
  connectionString: string | undefined = process.env.DATABASE_URL,
): SeamBackend {
  if (!connectionString) {
    throw new Error('createPgBackend: 缺少 DATABASE_URL —— pg 后端需连接串')
  }

  let pool: Pool | null = null

  // lazy 连接池 —— 首次查询时建池(pg 纯 JS,仅本文件加载)。
  async function getPool(): Promise<Pool> {
    if (pool) return pool
    const pg = await import('pg')
    pool = new pg.Pool({ connectionString })
    return pool
  }

  // SQL 文本归一化:先方言译(③a,逐块叠加),再 ?→$n 占位符。
  //   方言译器只动 SQL 文本、不引入/消除 `?`,故不影响占位符对账。
  //   ③a-1 datetime('now') · ③a-2 datetime('now',±N) · ③a-2b datetime(<列>,±N) 已接入;
  //   ③a-3 ON CONFLICT 后续追加。
  //   三个 datetime 译器形态互斥(now-单参 / now-两参 / 非now-两参),顺序无关;
  //   排此序仅为可读。方言译器只动 SQL 文本、不增删 `?`,故占位符对账不受影响。
  function toPg(sql: string, params: readonly unknown[]): string {
    let s = translateDatetimeInterval(sql).text
    s = translateDatetimeExprInterval(s).text
    s = translateDatetimeNow(s).text
    const { text, count } = toPgPlaceholders(s)
    if (count !== params.length) {
      throw new Error(`pg-backend: 占位符个数(${count})与参数个数(${params.length})不符`)
    }
    return text
  }

  return {
    kind: 'pg',
    async one<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T | undefined> {
      const p = await getPool()
      const r = await p.query(toPg(sql, params), params as unknown[])
      return r.rows[0] as T | undefined
    },
    async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]> {
      const p = await getPool()
      const r = await p.query(toPg(sql, params), params as unknown[])
      return r.rows as T[]
    },
    async run(sql: string, params: readonly unknown[]): Promise<DbRunResult> {
      const p = await getPool()
      const r = await p.query(toPg(sql, params), params as unknown[])
      // pg 无隐式 rowid;lastInsertRowid 的 2 个用点 Phase 3 改 RETURNING。changes = 受影响行数。
      return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }
    },
  }
}
