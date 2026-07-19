#!/usr/bin/env tsx
/** RFC-028 S1c2: production PostgreSQL replay authority and fail-closed config. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import {
  AGENT_GATEWAY_REPLAY_TABLE,
  createPostgresGatewayReplayRuntime,
  openConfiguredGatewayReplayRuntime,
} from '../src/runtime/agent-gateway-replay-pg.js'
import type { GatewayReplayClaim } from '../src/runtime/agent-gateway-proof.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}
const rejects = async (fn: () => Promise<unknown>, text: string): Promise<boolean> => {
  try { await fn(); return false } catch (e) { return e instanceof Error && e.message.includes(text) }
}

const now = new Date()
const runId = randomBytes(8).toString('hex')
const testGatewayId = `agc_test_${runId}`
const claim = (scope = randomBytes(32).toString('hex'), key = randomBytes(32).toString('hex')): GatewayReplayClaim => ({
  proof_kind: 'dpop',
  replay_scope_hash: scope,
  replay_key_hash: key,
  gateway_client_id: testGatewayId,
  grant_id: `grt_test_${runId}`,
  now_iso: now.toISOString(),
  expires_at: new Date(now.getTime() + 360_000).toISOString(),
})

let poolConstructed = false
const off = await openConfiguredGatewayReplayRuntime({
  NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '0',
}, { createPool: () => { poolConstructed = true; throw new Error('must not run') } })
ok('1. default-off returns no runtime', off === undefined)
ok('2. default-off constructs no pool', poolConstructed === false)
ok('3. enabled requires OAuth', await rejects(
  () => openConfiguredGatewayReplayRuntime({ WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1' }), 'WEBAZ_OAUTH=1'))
ok('4. enabled requires explicit postgres backend', await rejects(
  () => openConfiguredGatewayReplayRuntime({ WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1', WEBAZ_OAUTH: '1' }),
  'BACKEND=postgres'))
ok('5. enabled requires dedicated URL', await rejects(
  () => openConfiguredGatewayReplayRuntime({
    WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1', WEBAZ_OAUTH: '1',
    WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND: 'postgres',
  }), 'dedicated replay database URL'))
ok('6. URL-level TLS settings cannot override the pinned CA policy', await rejects(
  () => openConfiguredGatewayReplayRuntime({
    WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1', WEBAZ_OAUTH: '1',
    WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_REPLAY_DATABASE_URL: 'postgresql://user:pass@db.example/replay?sslmode=require',
  }), 'pinned CA setting'))
ok('7. production requires a pinned CA bundle', await rejects(
  () => openConfiguredGatewayReplayRuntime({
    NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1', WEBAZ_OAUTH: '1',
    WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_REPLAY_DATABASE_URL: 'postgresql://user:pass@db.example/replay',
  }), 'base64 CA bundle'))

const unavailablePool = {
  async query(): Promise<never> { throw new Error('offline') },
  async end(): Promise<void> {},
}
ok('8. initialization fails when database is unavailable', await rejects(
  () => createPostgresGatewayReplayRuntime(unavailablePool), 'offline'))

const schemaColumns = [
  ['proof_kind', 'text'], ['replay_scope_hash', 'text'], ['replay_key_hash', 'text'],
  ['gateway_client_id', 'text'], ['grant_id', 'text'],
  ['first_seen_at', 'timestamp with time zone'], ['expires_at', 'timestamp with time zone'],
].map(([column_name, data_type]) => ({ column_name, data_type, is_nullable: 'NO' }))

function fakeReadyResult(text: string): { rowCount: number; rows: Record<string, unknown>[] } | null {
  if (text.includes('information_schema.columns')) return { rowCount: schemaColumns.length, rows: schemaColumns }
  if (text.includes("c.contype='p'")) return { rowCount: 1, rows: [{ columns: ['proof_kind', 'replay_scope_hash', 'replay_key_hash'] }] }
  if (text.includes('has_table_privilege')) return { rowCount: 1, rows: [{
    can_select: true, can_insert: true, can_update: true, can_delete: true, db_now: new Date(),
  }] }
  if (text.includes('pg_indexes')) return { rowCount: 1, rows: [{ present: true }] }
  return null
}

const badSchemaPool = {
  async query(text: string) {
    if (text.includes('information_schema.columns')) return { rowCount: 0, rows: [] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('9. startup rejects a missing or stale schema', await rejects(
  () => createPostgresGatewayReplayRuntime(badSchemaPool), 'column contract mismatch'))

const badPrivilegePool = {
  async query(text: string) {
    if (text.includes('has_table_privilege')) return { rowCount: 1, rows: [{
      can_select: true, can_insert: true, can_update: true, can_delete: false, db_now: new Date(),
    }] }
    return fakeReadyResult(text) ?? { rowCount: 0, rows: [] }
  },
  async end() {},
}
ok('10. startup rejects an under-privileged application role', await rejects(
  () => createPostgresGatewayReplayRuntime(badPrivilegePool), 'lacks required DML privileges'))

const queries: string[] = []
let recordingClosed = false
const recordingPool = {
  async query(text: string) {
    queries.push(text)
    const ready = fakeReadyResult(text)
    if (ready) return ready
    return { rowCount: text.includes('RETURNING 1 AS claimed') ? 1 : 0, rows: [] }
  },
  async end() { recordingClosed = true },
}
const recordingRuntime = await createPostgresGatewayReplayRuntime(recordingPool)
ok('11. valid claim reaches the atomic upsert', await recordingRuntime.store.claim(claim()) === 'claimed')
ok('12. claim is one statement and uses the shared database clock with a database-side TTL cap',
  queries.some(q => q.includes('ON CONFLICT') && q.includes('statement_timestamp()'))
  && queries.some(q => q.includes("INTERVAL '24 hours'"))
  && !queries.some(q => q.trimStart().startsWith('DELETE FROM')))
await recordingRuntime.close()
ok('13. runtime owns and closes its pool', recordingClosed)

let runtimeCalls = 0
const runtimeOutagePool = {
  async query(text: string) {
    const ready = fakeReadyResult(text)
    if (ready) return ready
    runtimeCalls++
    throw new Error('runtime outage')
  },
  async end() {},
}
const outageRuntime = await createPostgresGatewayReplayRuntime(runtimeOutagePool)
ok('14. runtime database outage fails closed', await outageRuntime.store.claim(claim()) === 'unavailable')
ok('15. outage cannot fall back to a local claimant', runtimeCalls === 1)
await outageRuntime.close()

const secret = 'not-a-real-password'
const fakeCa = Buffer.from('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----').toString('base64')
let startupError = '', startupClosed = false
try {
  await openConfiguredGatewayReplayRuntime({
    NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1', WEBAZ_OAUTH: '1',
    WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND: 'postgres',
    WEBAZ_AGENT_GATEWAY_REPLAY_DATABASE_URL: `postgresql://user:${secret}@db.example/replay`,
    WEBAZ_AGENT_GATEWAY_REPLAY_TLS_CA_B64: fakeCa,
  }, { createPool: () => ({
    async query(): Promise<never> { throw new Error(`failed near ${secret}`) },
    async end(): Promise<void> { startupClosed = true },
  }) })
} catch (error) { startupError = error instanceof Error ? error.message : String(error) }
ok('16. startup error is generic and does not disclose the connection secret',
  startupError.includes('replay store initialization failed') && !startupError.includes(secret) && startupClosed)

let configuredClosed = false, configuredCa = ''
const configuredPool = {
  async query(text: string) { return fakeReadyResult(text) ?? { rowCount: 0, rows: [] } },
  async end() { configuredClosed = true },
  on() {},
}
const configured = await openConfiguredGatewayReplayRuntime({
  NODE_ENV: 'production', WEBAZ_AGENT_GATEWAY_DPOP_TOKEN: '1', WEBAZ_OAUTH: '1',
  WEBAZ_AGENT_GATEWAY_REPLAY_BACKEND: 'postgres',
  WEBAZ_AGENT_GATEWAY_REPLAY_DATABASE_URL: 'postgresql://user:pass@db.example/replay',
  WEBAZ_AGENT_GATEWAY_REPLAY_TLS_CA_B64: fakeCa,
}, {
  createPool: (_url, ca) => { configuredCa = ca ?? ''; return configuredPool },
  random: () => 0.5,
})
ok('17. valid production config opens a runtime with the pinned CA', !!configured && configuredCa.includes('BEGIN CERTIFICATE'))
await configured?.close()
ok('18. configured runtime closes cleanly', configuredClosed)

const url = process.env.DATABASE_URL
if (url && process.env.WEBAZ_AGENT_GATEWAY_REPLAY_TEST_ALLOW === '1') {
  const migration = readFileSync('db/agent-gateway-replay.pg.sql', 'utf8')
  const owner = new Pool({ connectionString: url, application_name: `webaz-replay-test-owner-${runId}` })
  await owner.query(migration)
  await owner.end()
  const p1 = new Pool({ connectionString: url, application_name: `webaz-replay-test-a-${runId}` })
  const p2 = new Pool({ connectionString: url, application_name: `webaz-replay-test-b-${runId}` })
  let r1: Awaited<ReturnType<typeof createPostgresGatewayReplayRuntime>> | undefined
  let r2: Awaited<ReturnType<typeof createPostgresGatewayReplayRuntime>> | undefined
  try {
    r1 = await createPostgresGatewayReplayRuntime(p1)
    r2 = await createPostgresGatewayReplayRuntime(p2)
    const same = claim()
    const outcomes = await Promise.all([r1.store.claim(same), r2.store.claim(same)])
    ok('19. two independent instances produce one claimant', outcomes.filter(x => x === 'claimed').length === 1)
    ok('20. two independent instances reject one replay', outcomes.filter(x => x === 'replayed').length === 1)
    const stored = await p1.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${AGENT_GATEWAY_REPLAY_TABLE}
      WHERE proof_kind=$1 AND replay_scope_hash=$2 AND replay_key_hash=$3`, [
      same.proof_kind, same.replay_scope_hash, same.replay_key_hash,
    ])
    ok('21. concurrent claim leaves exactly one row', stored.rows[0]?.count === '1')

    const otherScope = claim(randomBytes(32).toString('hex'), same.replay_key_hash)
    ok('22. same proof key in a distinct scope does not collide', await r2.store.claim(otherScope) === 'claimed')
    ok('23. malformed hashes fail closed without a write', await r1.store.claim({ ...claim(), replay_key_hash: 'raw-jti' }) === 'unavailable')
    ok('24. expired input fails closed', await r1.store.claim({ ...claim(), expires_at: now.toISOString() }) === 'unavailable')

    const expired = claim()
    await p1.query(`INSERT INTO ${AGENT_GATEWAY_REPLAY_TABLE}
      (proof_kind,replay_scope_hash,replay_key_hash,gateway_client_id,grant_id,first_seen_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz)`, [
      expired.proof_kind, expired.replay_scope_hash, expired.replay_key_hash,
      expired.gateway_client_id, expired.grant_id,
      new Date(now.getTime() - 720_000).toISOString(), new Date(now.getTime() - 360_000).toISOString(),
    ])
    const expiredRace = await Promise.all([r1.store.claim(expired), r2.store.claim(expired)])
    ok('25. expired-row replacement plus race has one claimant', expiredRace.filter(x => x === 'claimed').length === 1)
    ok('26. expired-row replacement plus race rejects one replay', expiredRace.filter(x => x === 'replayed').length === 1)

    const closedStore = r2.store
    await r2.close(); r2 = undefined
    ok('27. a closed production pool returns unavailable without fallback', await closedStore.claim(claim()) === 'unavailable')
  } finally {
    await p1.query(`DELETE FROM ${AGENT_GATEWAY_REPLAY_TABLE} WHERE gateway_client_id=$1`, [testGatewayId]).catch(() => undefined)
    await Promise.all([r1?.close(), r2?.close()])
  }
} else {
  console.log('  live PostgreSQL checks 19..27 skipped (DATABASE_URL or explicit test guard not set)')
}

console.log(`\nagent-gateway-replay-pg: ${pass} passed, ${fail} failed`)
if (failures.length) console.error(failures.join('\n'))
process.exit(fail ? 1 : 0)
