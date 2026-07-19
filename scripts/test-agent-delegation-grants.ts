#!/usr/bin/env tsx
/**
 * RFC-020 PR-B — agent delegation grants: schema + scope policy + revoke + expiry.
 *   用法:npm run test:agent-delegation-grants
 *
 * Verifies (no payment/order/wallet code touched anywhere):
 *   · scope taxonomy: safe accepted; RISK default-hard-reject; NEVER_DELEGABLE
 *     hard-reject; unknown reject; a mixed request rejects as a whole (fail-closed).
 *   · schema: agent_delegation_grants exists with the expected columns and NO
 *     money/order/status columns; PoP/human_confirm fields reserved.
 *   · revoke: flips status→revoked + stamps revoked_at; grantIsActive() → false.
 *   · expiry: grantIsActive() false once expires_at is in the past.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-grants-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initAgentDelegationGrantsSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const scopes = await import('../src/runtime/agent-grant-scopes.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, cond: boolean, d = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

try {
  // ── 1) scope classification ──
  ok('classify safe (search)', scopes.classifyScope('search') === 'safe')
  ok('classify risk (place_order)', scopes.classifyScope('place_order') === 'risk')
  ok('classify never_delegable (withdraw)', scopes.classifyScope('withdraw') === 'never_delegable')
  ok('classify unknown (foo)', scopes.classifyScope('foo') === 'unknown')

  // ── 2) validateRequestedCapabilities — the issue-endpoint gate ──
  const safeReq = scopes.validateRequestedCapabilities([{ capability: 'search' }, { capability: 'read_public' }, { capability: 'draft_order' }])
  ok('all-safe request accepted', safeReq.ok && safeReq.safe.length === 3 && safeReq.rejected.length === 0)

  const riskReq = scopes.validateRequestedCapabilities([{ capability: 'place_order' }])
  ok('risk scope hard-rejected', !riskReq.ok && riskReq.rejected[0]?.error_code === 'RISK_SCOPE_NOT_ENABLED')

  const neverReq = scopes.validateRequestedCapabilities([{ capability: 'withdraw' }])
  ok('never-delegable hard-rejected', !neverReq.ok && neverReq.rejected[0]?.error_code === 'NEVER_DELEGABLE')

  // every never-delegable scope rejects
  ok('ALL never-delegable scopes reject', scopes.NEVER_DELEGABLE_SCOPES.every(s =>
    scopes.validateRequestedCapabilities([{ capability: s }]).rejected[0]?.error_code === 'NEVER_DELEGABLE'))
  // every risk scope rejects
  ok('ALL risk scopes reject', scopes.RISK_SCOPES.every(s =>
    scopes.validateRequestedCapabilities([{ capability: s }]).rejected[0]?.error_code === 'RISK_SCOPE_NOT_ENABLED'))

  const mixed = scopes.validateRequestedCapabilities([{ capability: 'search' }, { capability: 'withdraw' }])
  ok('mixed safe+never rejects whole request (fail-closed)', !mixed.ok)
  ok('empty request rejected', !scopes.validateRequestedCapabilities([]).ok)

  // ── 3) ttl clamp ──
  ok('ttl default when missing', scopes.clampTtlSeconds(undefined) === scopes.GRANT_TTL_DEFAULT_SEC)
  ok('ttl clamped to max', scopes.clampTtlSeconds(999999) === scopes.GRANT_TTL_MAX_SEC)

  // ── 4) schema shape (no money columns) ──
  const db = initDatabase()
  initAgentDelegationGrantsSchema(db)
  const cols = (db.prepare('PRAGMA table_info(agent_delegation_grants)').all() as Array<{ name: string }>).map(c => c.name)
  for (const c of ['grant_id', 'human_id', 'capabilities', 'token_hash', 'agent_pubkey', 'pkce_challenge', 'human_confirm_required', 'status', 'expires_at', 'revoked_at']) {
    ok(`column ${c} present`, cols.includes(c))
  }
  const MONEY = /amount|balance|escrow|wallet|payout|refund|commission|fund|price|stake|order/i
  ok('NO money/order columns in grant table', !cols.some(c => MONEY.test(c)), `offending: ${cols.filter(c => MONEY.test(c)).join(',')}`)

  // ── 5) insert + revoke + expiry via grantIsActive ──
  const now = new Date().toISOString()
  const future = new Date(Date.now() + 3600_000).toISOString()
  const past = new Date(Date.now() - 1000).toISOString()
  const gid = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?)')
    .run(gid, 'usr_test', JSON.stringify([{ capability: 'search', constraints: {} }]), 'deadbeef', 'active', future)

  const active = db.prepare('SELECT status, expires_at, revoked_at FROM agent_delegation_grants WHERE grant_id = ?').get(gid) as any
  ok('fresh active grant is active', scopes.grantIsActive(active, now))
  ok('active grant with past expiry is inactive', !scopes.grantIsActive({ status: 'active', expires_at: past, revoked_at: null }, now))
  ok('SQLite UTC datetime future is active', scopes.grantIsActive({
    status: 'active', expires_at: '2099-01-01 00:00:00', revoked_at: null,
  }, now))
  ok('malformed expiry fails closed', !scopes.grantIsActive({
    status: 'active', expires_at: 'not-a-time', revoked_at: null,
  }, now))
  ok('date-only expiry fails closed', !scopes.grantIsActive({ status: 'active', expires_at: '2099', revoked_at: null }, now))
  ok('invalid calendar date fails closed', !scopes.grantIsActive({ status: 'active', expires_at: '2099-02-30T00:00:00Z', revoked_at: null }, now))
  ok('timezone-less ISO expiry fails closed', !scopes.grantIsActive({ status: 'active', expires_at: '2099-01-01T00:00:00', revoked_at: null }, now))

  db.prepare("UPDATE agent_delegation_grants SET status='revoked', revoked_at=? WHERE grant_id=?").run(now, gid)
  const revoked = db.prepare('SELECT status, expires_at, revoked_at FROM agent_delegation_grants WHERE grant_id = ?').get(gid) as any
  ok('revoke set status=revoked + revoked_at', revoked.status === 'revoked' && !!revoked.revoked_at)
  ok('revoked grant is inactive even if unexpired', !scopes.grantIsActive(revoked, now))

  if (fail === 0) {
    console.log(`\n✅ agent delegation grants: safe-only issuance gate (risk + never-delegable hard-reject), schema has no money columns, revoke + expiry deactivate\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ agent delegation grants FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true })
}
