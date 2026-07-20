#!/usr/bin/env tsx
/** RFC-028 S2b: production PostgreSQL rate-limit authority and fail-closed config. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import {
  AGENT_GATEWAY_LIMITS_TABLE,
  createPostgresGatewayLimitStore,
  openConfiguredGatewayLimitStore,
} from '../src/runtime/gateway-limits-pg.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}
const rejects = async (fn: () => Promise<unknown>, text: string): Promise<boolean> => {
  try { await fn(); return false } catch (e) { return e instanceof Error && e.message.includes(text) }
}

const runId = randomBytes(8).toString('hex')
const KEY = `gl:ip:public_low:${randomBytes(12).toString('hex')}`

// --- default-off + config validation (no pool constructed) ---
let poolConstructed = false
const off = await openConfiguredGatewayLimitStore(
  { NODE_ENV: 'production' },
  { createPool: () => { poolConstructed = true; throw new Error('must not run') } })
ok('1. default-off returns no store', off === undefined)
ok('2. default-off constructs no pool', poolConstructed === false)
ok('3. enabled requires a dedicated URL', await rejects(
  () => openConfiguredGatewayLimitStore({ WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND: 'postgres' }),
  'dedicated limits database URL'))
ok('4. URL query parameters cannot override the pinned CA policy', await rejects(
  () => openConfiguredGatewayLimitStore({
    WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL: 'postgresql://user:pass@db.example/limits?sslmode=require',
  }), 'must not contain query parameters'))
ok('5. node-postgres ssl aliases cannot disable pinned-CA verification', await rejects(
  () => openConfiguredGatewayLimitStore({
    WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL: 'postgresql://user:pass@db.example/limits?ssl=0',
  }), 'must not contain query parameters'))
ok('6. production requires a pinned CA bundle', await rejects(
  () => openConfiguredGatewayLimitStore({
    NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL: 'postgresql://user:pass@db.example/limits',
  }), 'base64 CA bundle'))

const unavailablePool = {
  async query(): Promise<never> { throw new Error('offline') },
  async end(): Promise<void> {},
}
ok('7. initialization fails when database is unavailable', await rejects(
  () => createPostgresGatewayLimitStore(unavailablePool), 'offline'))

// --- schema-contract assertion against a fake ready pool ---
const schemaColumns = [
  ['limiter_key', 'text'], ['window_start', 'timestamp with time zone'], ['window_sec', 'integer'],
  ['hit_count', 'bigint'], ['expires_at', 'timestamp with time zone'],
].map(([column_name, data_type]) => ({ column_name, data_type, is_nullable: 'NO' }))

function fakeReadyResult(text: string): { rowCount: number; rows: Record<string, unknown>[] } | null {
  if (text.includes('information_schema.columns')) return { rowCount: schemaColumns.length, rows: schemaColumns }
  if (text.includes("c.contype='p'")) return { rowCount: 1, rows: [{ columns: ['limiter_key', 'window_sec', 'window_start'] }] }
  if (text.includes('has_table_privilege')) return { rowCount: 1, rows: [{
    can_schema_usage: true, can_schema_create: false,
    can_select: true, can_insert: true, can_update: true, can_delete: true, can_truncate: false,
    db_now: new Date(),
  }] }
  if (text.includes('i.indisvalid')) return { rowCount: 1, rows: [{ present: true }] }
  return null
}

const badSchemaPool = {
  async query(text: string) {
    if (text.includes('information_schema.columns')) return { rowCount: 0, rows: [] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('8. startup rejects a missing or stale schema', await rejects(
  () => createPostgresGatewayLimitStore(badSchemaPool), 'column contract mismatch'))

const badPkPool = {
  async query(text: string) {
    if (text.includes("c.contype='p'")) return { rowCount: 1, rows: [{ columns: ['limiter_key'] }] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('9. startup rejects a wrong primary key', await rejects(
  () => createPostgresGatewayLimitStore(badPkPool), 'primary-key contract mismatch'))

const badPrivilegePool = {
  async query(text: string) {
    if (text.includes('has_table_privilege')) return { rowCount: 1, rows: [{
      can_schema_usage: true, can_schema_create: false,
      can_select: true, can_insert: true, can_update: true, can_delete: false, can_truncate: false,
      db_now: new Date(),
    }] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('10. startup rejects an under-privileged application role', await rejects(
  () => createPostgresGatewayLimitStore(badPrivilegePool), 'least-privilege contract'))

const owningRolePool = {
  async query(text: string) {
    if (text.includes('has_table_privilege')) return { rowCount: 1, rows: [{
      can_schema_usage: true, can_schema_create: true,   // migration-owner rights must be refused
      can_select: true, can_insert: true, can_update: true, can_delete: true, can_truncate: true,
      db_now: new Date(),
    }] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('11. startup refuses an over-privileged (CREATE/TRUNCATE) role', await rejects(
  () => createPostgresGatewayLimitStore(owningRolePool), 'least-privilege contract'))

const skewedClockPool = {
  async query(text: string) {
    if (text.includes('has_table_privilege')) return { rowCount: 1, rows: [{
      can_schema_usage: true, can_schema_create: false,
      can_select: true, can_insert: true, can_update: true, can_delete: true, can_truncate: false,
      db_now: new Date(Date.now() + 120_000),   // 2 min ahead — outside allowed skew
    }] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('12. startup rejects a database clock outside the allowed skew', await rejects(
  () => createPostgresGatewayLimitStore(skewedClockPool), 'clock is outside the allowed skew'))

const badIndexPool = {
  async query(text: string) {
    if (text.includes('i.indisvalid')) return { rowCount: 1, rows: [{ present: false }] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('13. startup rejects a missing expiry index', await rejects(
  () => createPostgresGatewayLimitStore(badIndexPool), 'expiry index is missing'))

// --- hit path against a recording pool ---
const queries: string[] = []
let recordingClosed = false
const recordingPool = {
  async query(text: string) {
    queries.push(text)
    const ready = fakeReadyResult(text)
    if (ready) return ready
    return text.includes('RETURNING hit_count')
      ? { rowCount: 1, rows: [{ hit_count: '7' }] }
      : { rowCount: 0, rows: [] }
  },
  async end() { recordingClosed = true },
}
const recordingRuntime = await createPostgresGatewayLimitStore(recordingPool)
ok('14. hit returns the authoritative in-window count', await recordingRuntime.store.hit(KEY, 60, Date.now()) === 7)
ok('15. hit is one atomic upsert keyed on the database clock, not the caller clock',
  queries.some(q => q.includes('ON CONFLICT') && q.includes('DO UPDATE SET hit_count=c.hit_count + 1')
    && q.includes('statement_timestamp()'))
  && !queries.some(q => q.trimStart().startsWith('DELETE FROM')))

// invalid input must fail closed WITHOUT a database write
const beforeInvalid = queries.length
ok('16. invalid window fails closed without a write', await rejects(
  () => recordingRuntime.store.hit(KEY, 0, Date.now()), 'invalid gateway limiter input'))
ok('17. oversized window fails closed without a write', await rejects(
  () => recordingRuntime.store.hit(KEY, 86_401, Date.now()), 'invalid gateway limiter input'))
ok('18. empty key fails closed without a write', await rejects(
  () => recordingRuntime.store.hit('', 60, Date.now()), 'invalid gateway limiter input'))
ok('19. oversized key fails closed without a write', await rejects(
  () => recordingRuntime.store.hit('x'.repeat(129), 60, Date.now()), 'invalid gateway limiter input'))
ok('20. rejected input issued no additional query', queries.length === beforeInvalid)
await recordingRuntime.close()
ok('21. runtime owns and closes its pool', recordingClosed)

// missing/garbled count row → reject, never fabricate a low count
const noCountPool = {
  async query(text: string) {
    const ready = fakeReadyResult(text)
    if (ready) return ready
    return { rowCount: 0, rows: [] }
  },
  async end() {},
}
const noCountRuntime = await createPostgresGatewayLimitStore(noCountPool)
ok('22. a missing count row fails closed (no fabricated low count)', await rejects(
  () => noCountRuntime.store.hit(KEY, 60, Date.now()), 'increment failed'))
await noCountRuntime.close()

// runtime outage on hit must reject (fail closed) — never resolve a silent success
let hitCalls = 0
const outagePool = {
  async query(text: string) {
    const ready = fakeReadyResult(text)
    if (ready) return ready
    hitCalls++
    throw new Error('runtime outage')
  },
  async end() {},
}
const outageRuntime = await createPostgresGatewayLimitStore(outagePool)
ok('23. runtime database outage rejects (fails closed)', await rejects(
  () => outageRuntime.store.hit(KEY, 60, Date.now()), 'runtime outage'))
ok('24. outage cannot fall back to a local counter', hitCalls === 1)
await outageRuntime.close()

// startup error must be generic and must not leak the connection secret
const secret = 'not-a-real-password'
const fakeCa = Buffer.from('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----').toString('base64')
let startupError = '', startupClosed = false
try {
  await openConfiguredGatewayLimitStore({
    NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL: `postgresql://user:${secret}@db.example/limits`,
    WEBAZ_AGENT_GATEWAY_LIMITS_TLS_CA_B64: fakeCa,
  }, { createPool: () => ({
    async query(): Promise<never> { throw new Error(`failed near ${secret}`) },
    async end(): Promise<void> { startupClosed = true },
  }) })
} catch (error) { startupError = error instanceof Error ? error.message : String(error) }
ok('25. startup error is generic and does not disclose the connection secret',
  startupError.includes('limits store initialization failed') && !startupError.includes(secret) && startupClosed)

let configuredClosed = false, configuredCa = ''
const configuredPool = {
  async query(text: string) { return fakeReadyResult(text) ?? { rowCount: 0, rows: [] } },
  async end() { configuredClosed = true },
  on() {},
}
const configured = await openConfiguredGatewayLimitStore({
  NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_LIMITS_BACKEND: 'postgres',
  WEBAZ_AGENT_GATEWAY_LIMITS_DATABASE_URL: 'postgresql://user:pass@db.example/limits',
  WEBAZ_AGENT_GATEWAY_LIMITS_TLS_CA_B64: fakeCa,
}, {
  createPool: (_url, ca) => { configuredCa = ca ?? ''; return configuredPool },
  random: () => 0.5,
})
ok('26. valid production config opens a store with the pinned CA', !!configured && configuredCa.includes('BEGIN CERTIFICATE'))
await configured?.close()
ok('27. configured runtime closes cleanly', configuredClosed)

// --- live PostgreSQL: real atomic increment, cross-instance convergence, window rollover, cleanup ---
const url = process.env.DATABASE_URL
if (url && process.env.WEBAZ_AGENT_GATEWAY_LIMITS_TEST_ALLOW === '1') {
  const migration = readFileSync('db/agent-gateway-limits.pg.sql', 'utf8')
  const owner = new Pool({ connectionString: url, application_name: `webaz-limits-test-owner-${runId}` })
  const roleName = `webaz_limits_test_${runId}`
  const rolePassword = randomBytes(24).toString('hex')
  const quotedRole = `"${roleName}"`
  const appUrl = new URL(url)
  appUrl.username = roleName
  appUrl.password = rolePassword
  const liveKey = `gl:ip:public_low:${runId}`
  let roleCreated = false
  let p1: Pool | undefined
  let p2: Pool | undefined
  let r1: Awaited<ReturnType<typeof createPostgresGatewayLimitStore>> | undefined
  let r2: Awaited<ReturnType<typeof createPostgresGatewayLimitStore>> | undefined
  try {
    await owner.query(migration)
    await owner.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD '${rolePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`)
    roleCreated = true
    await owner.query(`GRANT USAGE ON SCHEMA agent_gateway_limits TO ${quotedRole}`)
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${AGENT_GATEWAY_LIMITS_TABLE} TO ${quotedRole}`)
    p1 = new Pool({ connectionString: appUrl.toString(), application_name: `webaz-limits-test-a-${runId}` })
    p2 = new Pool({ connectionString: appUrl.toString(), application_name: `webaz-limits-test-b-${runId}` })
    r1 = await createPostgresGatewayLimitStore(p1)
    r2 = await createPostgresGatewayLimitStore(p2)

    const privileges = await p1.query<{ can_usage: boolean; can_create: boolean; can_truncate: boolean }>(
      `SELECT has_schema_privilege(current_user,'agent_gateway_limits','USAGE') AS can_usage,
              has_schema_privilege(current_user,'agent_gateway_limits','CREATE') AS can_create,
              has_table_privilege(current_user,$1,'TRUNCATE') AS can_truncate`, [AGENT_GATEWAY_LIMITS_TABLE])
    ok('28. live adapters use a non-owner role with only the required privileges',
      privileges.rows[0]?.can_usage === true && privileges.rows[0]?.can_create === false
      && privileges.rows[0]?.can_truncate === false)

    // 100 concurrent hits across TWO independent instances must converge to exactly 100 (shared budget).
    const hits = await Promise.all(
      Array.from({ length: 100 }, (_v, i) => (i % 2 === 0 ? r1! : r2!).store.hit(liveKey, 3600, Date.now())))
    const distinct = new Set(hits)
    ok('29. concurrent cross-instance hits produce no duplicate counts', distinct.size === 100)
    ok('30. concurrent cross-instance hits reach exactly the total', Math.max(...hits) === 100)
    const stored = await p1.query<{ hit_count: string; buckets: string }>(
      `SELECT MAX(hit_count)::text AS hit_count, COUNT(*)::text AS buckets FROM ${AGENT_GATEWAY_LIMITS_TABLE}
        WHERE limiter_key=$1 AND window_sec=3600`, [liveKey])
    ok('31. one shared bucket holds the authoritative count', stored.rows[0]?.hit_count === '100' && stored.rows[0]?.buckets === '1')

    // A different window_sec is an independent budget (its own bucket edge), even for the same key.
    const shortWin = await r1.store.hit(liveKey, 60, Date.now())
    ok('32. a distinct window is an independent bucket', shortWin === 1)

    // Cleanup reclaims only buckets expired past the 10s grace; the live bucket and a within-grace bucket survive.
    const expiredKey = `gl:ip:public_low:expired_${runId}`
    const graceKey = `gl:ip:public_low:grace_${runId}`
    await owner.query(`INSERT INTO ${AGENT_GATEWAY_LIMITS_TABLE}
      (limiter_key,window_start,window_sec,hit_count,expires_at)
      VALUES ($1, now() - INTERVAL '2 hours', 3600, 5, now() - INTERVAL '1 hour'),
             ($2, now() - INTERVAL '61 seconds', 60, 3, now() - INTERVAL '1 second')`, [expiredKey, graceKey])
    const removed = await r1.cleanupExpired(1000)
    ok('33. cleanup removes fully-expired buckets', removed >= 1)
    const expiredGone = await p1.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${AGENT_GATEWAY_LIMITS_TABLE} WHERE limiter_key=$1`, [expiredKey])
    ok('34. the fully-expired bucket is gone', expiredGone.rows[0]?.count === '0')
    const graceSurvives = await p1.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${AGENT_GATEWAY_LIMITS_TABLE} WHERE limiter_key=$1`, [graceKey])
    ok('35. a bucket expired within the 10s grace is NOT reclaimed (F3 race closed)', graceSurvives.rows[0]?.count === '1')
    const liveSurvives = await p1.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${AGENT_GATEWAY_LIMITS_TABLE} WHERE limiter_key=$1 AND window_sec=3600`, [liveKey])
    ok('36. cleanup leaves the live bucket intact', liveSurvives.rows[0]?.count === '1')

    const closedStore = r2.store
    await r2.close(); r2 = undefined; p2 = undefined
    ok('37. a closed production pool rejects without fallback', await rejects(
      () => closedStore.hit(liveKey, 3600, Date.now()), ''))
  } finally {
    await Promise.all([r1?.close() ?? p1?.end(), r2?.close() ?? p2?.end()])
    await owner.query(`DELETE FROM ${AGENT_GATEWAY_LIMITS_TABLE} WHERE limiter_key LIKE $1`, [`gl:ip:public_low:%${runId}%`]).catch(() => undefined)
    if (roleCreated) {
      await owner.query(`DROP OWNED BY ${quotedRole}`).catch(() => undefined)
      await owner.query(`DROP ROLE ${quotedRole}`).catch(() => undefined)
    }
    await owner.end()
  }
} else {
  console.log('  live PostgreSQL checks 28..37 skipped (DATABASE_URL or explicit test guard not set)')
}

console.log(`\ngateway-limits-pg: ${pass} passed, ${fail} failed`)
if (failures.length) console.error(failures.join('\n'))
process.exit(fail ? 1 : 0)
