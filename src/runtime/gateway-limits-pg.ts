/**
 * RFC-028 S2b: production, cross-replica rate-limit authority for the Agent Gateway (threat-model §8.1).
 *
 * The multi-dimensional limit engine (gateway-limits.ts) is pure logic over a counter store seam. §8.1
 * requires the AUTHORITATIVE store to be DISTRIBUTED — a process-local counter is not cross-replica and is
 * lost on restart, so it cannot bound a fleet. This module is that authoritative store: fixed-window buckets
 * incremented with a single atomic INSERT ... ON CONFLICT statement, so N replicas share one budget.
 *
 * Like the replay authority (agent-gateway-replay-pg.ts) it is a dedicated operational PostgreSQL store,
 * separate from WebAZ's SQLite business database, dormant unless explicitly enabled, and it never falls back
 * to SQLite or process memory. `hit` REJECTS on outage rather than resolving — a silent success would
 * under-count and let traffic slip past its budget; the fail policy (open vs closed) is the caller's, made
 * at wiring time per cost class. Nothing here is wired to production traffic yet.
 */
import type { Pool, QueryResult } from 'pg'
import type { AsyncGatewayLimitStore } from './gateway-limits.js'

const SCHEMA = 'agent_gateway_limits'
const TABLE_NAME = 'counters_v1'
const TABLE = `${SCHEMA}.${TABLE_NAME}`
const MAX_WINDOW_SEC = 86_400
const EXPECTED_COLUMNS = [
  ['limiter_key', 'text'],
  ['window_start', 'timestamp with time zone'],
  ['window_sec', 'integer'],
  ['hit_count', 'bigint'],
  ['expires_at', 'timestamp with time zone'],
] as const

interface LimitsPool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<R>, 'rowCount' | 'rows'>>
  end(): Promise<void>
  on?(event: 'error', listener: (error: Error & { code?: string }) => void): unknown
}

export interface GatewayLimitRuntime {
  store: AsyncGatewayLimitStore
  cleanupExpired(limit?: number): Promise<number>
  close(): Promise<void>
}

/** Fail-closed input guard. Bounds the key LENGTH (matches the DB CHECK) and the window so a bad caller
 *  cannot mint an oversized key or a nonsensical window. Rejected input NEVER touches the database.
 *  NOTE: this bounds each key's size, NOT the NUMBER of distinct keys. Per-key cardinality (e.g. one row
 *  per source IPv6 address per window) is the caller's responsibility to bound by normalizing
 *  high-cardinality dimensions (IPv6→/64, capped anchor/product sets) BEFORE keying — see gateway-limits.ts
 *  gatewayLimitKey. This store additionally drains expired buckets adaptively (see the cleanup scheduler). */
function validLimiterInput(key: string, windowSec: number): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 128
    && Number.isInteger(windowSec) && windowSec >= 1 && windowSec <= MAX_WINDOW_SEC
}

async function assertLimitsSchema(pool: LimitsPool): Promise<void> {
  const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(`
    SELECT column_name,data_type,is_nullable
      FROM information_schema.columns
     WHERE table_schema=$1 AND table_name=$2
     ORDER BY ordinal_position
  `, [SCHEMA, TABLE_NAME])
  const exactColumns = columns.rows.length === EXPECTED_COLUMNS.length
    && EXPECTED_COLUMNS.every(([name, type], i) => columns.rows[i]?.column_name === name
      && columns.rows[i]?.data_type === type && columns.rows[i]?.is_nullable === 'NO')
  if (!exactColumns) throw new Error('limits schema column contract mismatch')

  const pk = await pool.query<{ columns: string[] }>(`
    SELECT array_agg(a.attname ORDER BY keys.ordinality)::text[] AS columns
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=keys.attnum
     WHERE c.conrelid=$1::regclass AND c.contype='p'
     GROUP BY c.oid
  `, [TABLE])
  if (JSON.stringify(pk.rows[0]?.columns) !== JSON.stringify(['limiter_key', 'window_sec', 'window_start'])) {
    throw new Error('limits schema primary-key contract mismatch')
  }

  const readiness = await pool.query<{
    can_schema_usage: boolean; can_schema_create: boolean; can_select: boolean; can_insert: boolean
    can_update: boolean; can_delete: boolean; can_truncate: boolean; db_now: Date | string
  }>(`
    SELECT has_schema_privilege(current_user,$2,'USAGE') AS can_schema_usage,
           has_schema_privilege(current_user,$2,'CREATE') AS can_schema_create,
           has_table_privilege(current_user,$1,'SELECT') AS can_select,
           has_table_privilege(current_user,$1,'INSERT') AS can_insert,
           has_table_privilege(current_user,$1,'UPDATE') AS can_update,
           has_table_privilege(current_user,$1,'DELETE') AS can_delete,
           has_table_privilege(current_user,$1,'TRUNCATE') AS can_truncate,
           clock_timestamp() AS db_now
  `, [TABLE, SCHEMA])
  const ready = readiness.rows[0]
  const dbNow = ready ? new Date(ready.db_now).getTime() : Number.NaN
  if (!ready?.can_schema_usage || !ready.can_select || !ready.can_insert || !ready.can_update || !ready.can_delete
    || ready.can_schema_create || ready.can_truncate) {
    throw new Error('limits database role does not match the least-privilege contract')
  }
  if (!Number.isFinite(dbNow) || Math.abs(dbNow - Date.now()) > 60_000) {
    throw new Error('limits database clock is outside the allowed skew')
  }

  const expiryIndex = await pool.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class idx ON idx.oid=i.indexrelid
        JOIN pg_class tbl ON tbl.oid=i.indrelid
        JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
        JOIN pg_am am ON am.oid=idx.relam
        JOIN pg_attribute a ON a.attrelid=tbl.oid AND a.attnum=i.indkey[0]
       WHERE ns.nspname=$1 AND tbl.relname=$2
         AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
         AND i.indnkeyatts >= 1 AND am.amname='btree' AND a.attname='expires_at'
    ) AS present
  `, [SCHEMA, TABLE_NAME])
  if (!expiryIndex.rows[0]?.present) throw new Error('limits expiry index is missing')
}

/** Schema must already be provisioned by db/agent-gateway-limits.pg.sql. */
export async function createPostgresGatewayLimitStore(pool: LimitsPool): Promise<GatewayLimitRuntime> {
  await assertLimitsSchema(pool)
  const store: AsyncGatewayLimitStore = {
    async hit(key: string, windowSec: number, _nowMs: number): Promise<number> {
      // Fail closed on bad input: reject before any write. The caller must not treat a rejection as
      // "under limit" — an uncounted request is not a permitted one.
      if (!validLimiterInput(key, windowSec)) throw new Error('invalid gateway limiter input')
      // One statement is the cross-replica serialization point. The window boundary is derived from the
      // DATABASE clock (statement_timestamp), never the caller's `now_ms`, so all replicas share bucket
      // edges regardless of local clock skew. ON CONFLICT increments the existing bucket atomically.
      const result = await pool.query<{ hit_count: string }>(`
        WITH w AS (
          SELECT to_timestamp(floor(extract(epoch FROM statement_timestamp()) / $2::int) * $2::int) AS window_start
        )
        INSERT INTO ${TABLE} AS c (limiter_key,window_start,window_sec,hit_count,expires_at)
        SELECT $1::text, w.window_start, $2::int, 1, w.window_start + ($2::int * INTERVAL '1 second')
          FROM w
        ON CONFLICT (limiter_key,window_sec,window_start) DO UPDATE SET hit_count=c.hit_count + 1
        RETURNING hit_count
      `, [key, windowSec])
      const count = Number(result.rows[0]?.hit_count)
      // No row / non-numeric count means the increment did not land — reject, never fabricate a low count.
      if (!Number.isInteger(count) || count < 1) throw new Error('gateway limiter increment failed')
      return count
    },
  }
  let closed = false
  return {
    store,
    async cleanupExpired(limit = 1000): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) throw new Error('invalid limiter cleanup limit')
      // 10s grace: only reclaim buckets expired for a while. A bucket's expires_at is window_start+window_sec;
      // a hit still inside that window has statement_timestamp() < expires_at, which can never be 10s behind a
      // cleanup that (by this predicate) ran at >= expires_at+10s — so cleanup can never race-delete a bucket a
      // late same-window hit would then resurrect from 1 (fail-open sliver closed).
      const result = await pool.query(`
        WITH doomed AS (
          SELECT ctid FROM ${TABLE}
           WHERE expires_at <= statement_timestamp() - INTERVAL '10 seconds'
           ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ${TABLE} live USING doomed
         WHERE live.ctid=doomed.ctid
      `, [limit])
      return result.rowCount ?? 0
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}

function validateConnectionString(raw: string): string {
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('Agent Gateway limits database URL is invalid') }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error('Agent Gateway limits database URL must be PostgreSQL with credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Agent Gateway limits database URL must not contain query parameters or fragments')
  }
  return raw
}

function decodeTlsCa(raw: string | undefined): string {
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('production limits database requires a base64 CA bundle')
  const pem = Buffer.from(raw, 'base64').toString('utf8')
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || !pem.includes('-----END CERTIFICATE-----')) {
    throw new Error('production limits database CA bundle is invalid')
  }
  return pem
}

export interface GatewayLimitsEnvDeps {
  createPool?: (connectionString: string, tlsCa?: string) => LimitsPool
  random?: () => number
}

/**
 * Open the explicitly configured limits store. Default-off returns before importing pg or reading any
 * store secret. Unlike the replay authority, the limiter does NOT require OAuth — it caps unauthenticated
 * (per-IP) traffic too, so coupling it to OAuth would leave the anonymous surface unprotected. Enforcement
 * mode (shadow vs enforce) is a separate wiring concern and is not read here.
 */
export async function openConfiguredGatewayLimitStore(
  env: NodeJS.ProcessEnv = process.env,
  deps: GatewayLimitsEnvDeps = {},
): Promise<GatewayLimitRuntime | undefined> {
  if (env.WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND !== 'postgres') return undefined
  const raw = env.WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL
  if (!raw) throw new Error('Agent Gateway limits activation requires a dedicated limits database URL')
  const connectionString = validateConnectionString(raw)
  const tlsCa = env.NODE_ENV === 'production' ? decodeTlsCa(env.WEBAZ_AGENT_GATEWAY_LIMITS_TLS_CA_B64) : undefined
  let createPool = deps.createPool
  if (!createPool) {
    const pg = await import('pg')
    createPool = (url: string, ca?: string): Pool => new pg.Pool({
      connectionString: url,
      application_name: 'webaz-agent-gateway-limits',
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 3_000,
      ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    })
  }
  const pool = createPool(connectionString, tlsCa)
  pool.on?.('error', error => {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{2,20}$/.test(error.code) ? error.code : 'UNKNOWN'
    console.error(`[agent-gateway-limits] idle PostgreSQL client error (${code})`)
  })
  let runtime: GatewayLimitRuntime
  try {
    runtime = await createPostgresGatewayLimitStore(pool)
  } catch {
    await pool.end().catch(() => undefined)
    throw new Error('Agent Gateway limits store initialization failed')
  }

  const CLEANUP_BATCH = 1000
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const scheduleCleanup = (delay: number): void => {
    timer = setTimeout(async () => {
      let drained = 0
      try { drained = await runtime.cleanupExpired(CLEANUP_BATCH) }
      catch { console.error('[agent-gateway-limits] expired-bucket cleanup failed') }
      // A full batch means backlog remains — drain again in ~1s instead of idling, so a flood of
      // high-cardinality keys (e.g. per-IPv6 buckets) cannot outpace reclamation at a fixed 1000/min.
      // Each statement stays bounded (LIMIT + SKIP LOCKED); only the cadence adapts.
      const next = drained >= CLEANUP_BATCH ? 1_000 : 60_000 + Math.floor((deps.random?.() ?? Math.random()) * 15_000)
      if (!stopped) scheduleCleanup(next)
    }, delay)
    timer.unref()
  }
  scheduleCleanup(Math.floor((deps.random?.() ?? Math.random()) * 60_000))
  const close = runtime.close.bind(runtime)
  runtime.close = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    await close()
  }
  return runtime
}

export const AGENT_GATEWAY_LIMITS_TABLE = TABLE
