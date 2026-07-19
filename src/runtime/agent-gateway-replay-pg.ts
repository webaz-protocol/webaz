/**
 * RFC-028 S1c2: production, cross-replica replay authority for Agent Gateway proofs.
 *
 * This operational PostgreSQL store is separate from WebAZ's SQLite business
 * database. It is dormant unless DPoP token issuance is explicitly enabled.
 * Production never falls back to SQLite or process memory.
 */
import type { Pool, QueryResult } from 'pg'
import type { GatewayReplayClaim, GatewayReplayStore } from './agent-gateway-proof.js'

const SCHEMA = 'agent_gateway_replay'
const TABLE_NAME = 'claims_v1'
const TABLE = `${SCHEMA}.${TABLE_NAME}`
const HASH_RE = /^[0-9a-f]{64}$/
const EXPECTED_COLUMNS = [
  ['proof_kind', 'text'],
  ['replay_scope_hash', 'text'],
  ['replay_key_hash', 'text'],
  ['gateway_client_id', 'text'],
  ['grant_id', 'text'],
  ['first_seen_at', 'timestamp with time zone'],
  ['expires_at', 'timestamp with time zone'],
] as const

interface ReplayPool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<R>, 'rowCount' | 'rows'>>
  end(): Promise<void>
  on?(event: 'error', listener: (error: Error & { code?: string }) => void): unknown
}

export interface GatewayReplayRuntime {
  store: GatewayReplayStore
  cleanupExpired(limit?: number): Promise<number>
  close(): Promise<void>
}

function validClaim(input: GatewayReplayClaim): boolean {
  const now = Date.parse(input.now_iso)
  const expires = Date.parse(input.expires_at)
  return input.proof_kind === 'dpop'
    && HASH_RE.test(input.replay_scope_hash)
    && HASH_RE.test(input.replay_key_hash)
    && input.gateway_client_id.length > 0 && input.gateway_client_id.length <= 200
    && input.grant_id.length > 0 && input.grant_id.length <= 200
    && Number.isFinite(now) && Number.isFinite(expires) && expires > now
    && expires - now <= 24 * 60 * 60 * 1000
}

async function assertReplaySchema(pool: ReplayPool): Promise<void> {
  const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(`
    SELECT column_name,data_type,is_nullable
      FROM information_schema.columns
     WHERE table_schema=$1 AND table_name=$2
     ORDER BY ordinal_position
  `, [SCHEMA, TABLE_NAME])
  const exactColumns = columns.rows.length === EXPECTED_COLUMNS.length
    && EXPECTED_COLUMNS.every(([name, type], i) => columns.rows[i]?.column_name === name
      && columns.rows[i]?.data_type === type && columns.rows[i]?.is_nullable === 'NO')
  if (!exactColumns) throw new Error('replay schema column contract mismatch')

  const pk = await pool.query<{ columns: string[] }>(`
    SELECT array_agg(a.attname ORDER BY keys.ordinality)::text[] AS columns
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=keys.attnum
     WHERE c.conrelid=$1::regclass AND c.contype='p'
     GROUP BY c.oid
  `, [TABLE])
  if (JSON.stringify(pk.rows[0]?.columns) !== JSON.stringify(['proof_kind', 'replay_scope_hash', 'replay_key_hash'])) {
    throw new Error('replay schema primary-key contract mismatch')
  }

  const readiness = await pool.query<{
    can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; db_now: Date | string
  }>(`
    SELECT has_table_privilege(current_user,$1,'SELECT') AS can_select,
           has_table_privilege(current_user,$1,'INSERT') AS can_insert,
           has_table_privilege(current_user,$1,'UPDATE') AS can_update,
           has_table_privilege(current_user,$1,'DELETE') AS can_delete,
           clock_timestamp() AS db_now
  `, [TABLE])
  const ready = readiness.rows[0]
  const dbNow = ready ? new Date(ready.db_now).getTime() : Number.NaN
  if (!ready?.can_select || !ready.can_insert || !ready.can_update || !ready.can_delete) {
    throw new Error('replay database role lacks required DML privileges')
  }
  if (!Number.isFinite(dbNow) || Math.abs(dbNow - Date.now()) > 60_000) {
    throw new Error('replay database clock is outside the allowed skew')
  }

  const expiryIndex = await pool.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname=$1 AND tablename=$2 AND indexdef ~ '\\(expires_at\\)'
    ) AS present
  `, [SCHEMA, TABLE_NAME])
  if (!expiryIndex.rows[0]?.present) throw new Error('replay expiry index is missing')
}

/** Schema must already be provisioned by db/agent-gateway-replay.pg.sql. */
export async function createPostgresGatewayReplayRuntime(pool: ReplayPool): Promise<GatewayReplayRuntime> {
  await assertReplaySchema(pool)
  const store: GatewayReplayStore = {
    async claim(input): Promise<'claimed' | 'replayed' | 'unavailable'> {
      if (!validClaim(input)) return 'unavailable'
      try {
        // One statement is the cross-replica serialization point. An active
        // conflict returns no row (replayed); an expired conflict is replaced
        // atomically, so cleanup is never part of correctness.
        const result = await pool.query<{ claimed: number }>(`
          INSERT INTO ${TABLE} AS current
            (proof_kind,replay_scope_hash,replay_key_hash,gateway_client_id,grant_id,first_seen_at,expires_at)
          SELECT $1,$2,$3,$4,$5,statement_timestamp(),$6::timestamptz
          WHERE $6::timestamptz > statement_timestamp()
            AND $6::timestamptz <= statement_timestamp() + INTERVAL '24 hours'
          ON CONFLICT (proof_kind,replay_scope_hash,replay_key_hash) DO UPDATE SET
            gateway_client_id=EXCLUDED.gateway_client_id,
            grant_id=EXCLUDED.grant_id,
            first_seen_at=EXCLUDED.first_seen_at,
            expires_at=EXCLUDED.expires_at
          WHERE current.expires_at <= statement_timestamp()
          RETURNING 1 AS claimed
        `, [
          input.proof_kind,
          input.replay_scope_hash,
          input.replay_key_hash,
          input.gateway_client_id,
          input.grant_id,
          input.expires_at,
        ])
        return result.rowCount === 1 ? 'claimed' : 'replayed'
      } catch {
        return 'unavailable'
      }
    },
  }
  let closed = false
  return {
    store,
    async cleanupExpired(limit = 500): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error('invalid replay cleanup limit')
      const result = await pool.query(`
        WITH doomed AS (
          SELECT ctid FROM ${TABLE}
           WHERE expires_at <= statement_timestamp()
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
  try { parsed = new URL(raw) } catch { throw new Error('Agent Gateway replay database URL is invalid') }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error('Agent Gateway replay database URL must be PostgreSQL with credentials')
  }
  for (const forbidden of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    if (parsed.searchParams.has(forbidden)) {
      throw new Error('Agent Gateway replay TLS is configured only through the pinned CA setting')
    }
  }
  return raw
}

function decodeTlsCa(raw: string | undefined): string {
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('production replay database requires a base64 CA bundle')
  const pem = Buffer.from(raw, 'base64').toString('utf8')
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || !pem.includes('-----END CERTIFICATE-----')) {
    throw new Error('production replay database CA bundle is invalid')
  }
  return pem
}

export interface GatewayReplayEnvDeps {
  createPool?: (connectionString: string, tlsCa?: string) => ReplayPool
  random?: () => number
}

/**
 * Open the explicitly configured runtime. Default-off returns before importing
 * pg or reading any replay-store secret.
 */
export async function openConfiguredGatewayReplayRuntime(
  env: NodeJS.ProcessEnv = process.env,
  deps: GatewayReplayEnvDeps = {},
): Promise<GatewayReplayRuntime | undefined> {
  if (env.WEBAZ_AGENT_GATEWAY_DPOP_TOKEN !== '1') return undefined
  if (env.WEBAZ_OAUTH !== '1') throw new Error('DPoP token activation requires WEBAZ_OAUTH=1')
  if (env.WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND !== 'postgres') {
    throw new Error('DPoP token activation requires WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND=postgres')
  }
  const raw = env.WEBAZ_AGENT_GATEWAY_REPLAY_DATABASE_URL
  if (!raw) throw new Error('DPoP token activation requires a dedicated replay database URL')
  const connectionString = validateConnectionString(raw)
  const tlsCa = env.NODE_ENV === 'production' ? decodeTlsCa(env.WEBAZ_AGENT_GATEWAY_REPLAY_TLS_CA_B64) : undefined
  let createPool = deps.createPool
  if (!createPool) {
    const pg = await import('pg')
    createPool = (url: string, ca?: string): Pool => new pg.Pool({
      connectionString: url,
      application_name: 'webaz-agent-gateway-replay',
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
    console.error(`[agent-gateway-replay] idle PostgreSQL client error (${code})`)
  })
  let runtime: GatewayReplayRuntime
  try {
    runtime = await createPostgresGatewayReplayRuntime(pool)
  } catch {
    await pool.end().catch(() => undefined)
    throw new Error('Agent Gateway replay store initialization failed')
  }

  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const scheduleCleanup = (delay: number): void => {
    timer = setTimeout(async () => {
      try { await runtime.cleanupExpired() }
      catch { console.error('[agent-gateway-replay] expired-row cleanup failed') }
      if (!stopped) scheduleCleanup(60_000 + Math.floor((deps.random?.() ?? Math.random()) * 15_000))
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

export const AGENT_GATEWAY_REPLAY_TABLE = TABLE
