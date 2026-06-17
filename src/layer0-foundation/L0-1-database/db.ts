/**
 * RFC-016 — 异步数据访问 seam(数据库地基迁移的脊柱)。
 *
 * 目的:把全库同步 `db.prepare().get/all/run` 收敛到一个【异步】接口,
 *   现用 better-sqlite3 后端(同步执行,包成 resolved Promise → 行为零变化);
 *   Phase 3 换 PostgreSQL 后端时,**call site 不变**,只换本文件后端实现 + SQL 方言 + 行锁。
 *
 * 参数约定:沿用 `?` 占位符 + 数组传参(`dbOne(sql, [a, b])`)。
 *   sqlite 后端原样用;pg 后端在【后端内部】把 `?`→`$1..$n`(Phase 2 PR2),call site 仍不变。
 *
 * ── Phase 2(本次):后端可切换骨架 ──────────────────────────────────
 *   把 seam 内部从"直接持有 better-sqlite3 连接"改为"持有一个 SeamBackend",
 *   dbOne/dbAll/dbRun 统一委派给当前后端。默认 = sqlite 后端(行为零变化)。
 *   pg 后端骨架在 ./db-backends/pg-backend.ts —— 仅结构存在,【未接入启动】,
 *   其 query 方法当前抛错(占位符转换在 PR2、方言/行锁在 Phase 3 才补全)。
 *   生产仍全程跑 SQLite,注册/运行不受影响。
 *
 * ⚠️ 事务【不】走本 seam:better-sqlite3 事务必须同步(async body 会破坏原子性);
 *   `db.transaction` 留到 Phase 3 与 pg client 事务(BEGIN/COMMIT + FOR UPDATE 行锁)一起改。
 *   本阶段只异步化【非事务】读写。
 */
import type Database from 'better-sqlite3'

export interface DbRunResult { changes: number; lastInsertRowid: number | bigint }

/**
 * 数据库后端契约 —— sqlite / pg 两实现满足同一形状,seam 只依赖本接口。
 * 三方法均 async:sqlite 同步执行包 resolved Promise(行为零变化),pg 天然 async。
 */
export interface SeamBackend {
  readonly kind: 'sqlite' | 'pg'
  one<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]>
  run(sql: string, params: readonly unknown[]): Promise<DbRunResult>
}

let _backend: SeamBackend | null = null
// 原始 better-sqlite3 句柄,仅在 sqlite 后端下持有 —— 供【同步事务】逃生口用(见下 seamSqliteHandle)。
let _sqliteHandle: Database.Database | null = null

/** better-sqlite3 后端 —— 等价于迁移前的 `db.prepare().get/all/run`,逐字保行为。 */
function createSqliteBackend(db: Database.Database): SeamBackend {
  return {
    kind: 'sqlite',
    async one<T>(sql: string, params: readonly unknown[]): Promise<T | undefined> {
      return db.prepare(sql).get(...params) as T | undefined
    },
    async all<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[]
    },
    async run(sql: string, params: readonly unknown[]): Promise<DbRunResult> {
      const r = db.prepare(sql).run(...params)
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    },
  }
}

/**
 * 启动时注入共享 SQLite 连接(PWA 与 MCP 各自进程各注入一次)。
 * 内部包成 sqlite 后端 —— 默认且当前唯一接入启动的后端,行为与迁移前一致。
 */
export function setSeamDb(db: Database.Database): void {
  _backend = createSqliteBackend(db)
  _sqliteHandle = db
}

/**
 * 直接替换 seam 后端(Phase 3 pg 切换的接入钩子)。
 * Phase 2 不在启动路径调用本函数;保留以便 Phase 3 用 `setSeamBackend(createPgBackend())` 切换。
 */
export function setSeamBackend(backend: SeamBackend): void {
  _backend = backend
  _sqliteHandle = null   // 非 sqlite 后端无同步句柄 → 调用方 fail-closed
}

/** 当前后端种类(诊断/守卫用);未初始化返回 null。 */
export function seamBackendKind(): SeamBackend['kind'] | null {
  return _backend ? _backend.kind : null
}

/**
 * 原始 better-sqlite3 句柄 —— 仅供【同步事务】逃生口(seam 三方法是 async,无法承载
 * better-sqlite3 必须同步的 `db.transaction`,见本文件顶部事务说明)。仅当当前后端是 sqlite
 * 时返回句柄;pg 后端 / 未初始化返回 null,调用方据此 fail-closed(PG 同步事务在 RFC-016
 * Phase 3 才接入)。不是给非事务读写用的 —— 那些必须走 dbOne/dbAll/dbRun。
 */
export function seamSqliteHandle(): Database.Database | null {
  return _backend?.kind === 'sqlite' ? _sqliteHandle : null
}

function backend(): SeamBackend {
  if (!_backend) throw new Error('DB seam 未初始化 —— 启动时需先调用 setSeamDb(db)')
  return _backend
}

/** 单行读;无则 undefined。等价 `db.prepare(sql).get(...params)`。 */
export async function dbOne<T = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  return backend().one<T>(sql, params)
}

/** 多行读。等价 `db.prepare(sql).all(...params)`。 */
export async function dbAll<T = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return backend().all<T>(sql, params)
}

/** 写(INSERT/UPDATE/DELETE)。等价 `db.prepare(sql).run(...params)`。 */
export async function dbRun(
  sql: string,
  params: readonly unknown[] = [],
): Promise<DbRunResult> {
  return backend().run(sql, params)
}
