#!/usr/bin/env tsx
/**
 * RFC-020 PR-C2b — MCP consumes a stored grant on a SAFE route (per-call, audited, server-enforced).
 *   用法:npm run test:agent-grant-mcp-consume
 *
 * End-to-end: the MCP webaz_pair action="verify" resolves the locally-stored grant bearer and calls a
 * SAFE grant-gated PWA route (whoami). The SERVER re-checks active/expiry/revoked/subject + audits on
 * every call (verified against a real ephemeral PWA mounting the actual routes). Proves:
 *   1. resolveGrantCredential round-trips a stored credential (file fallback)
 *   2. verify with NO stored credential → not_paired (no network call)
 *   3. verify with a valid grant → active + grant principal (server-enforced, never prints the token)
 *   4. verify after the grant is revoked → grant_invalid (per-call revocation honored)
 * No business tool and no risk scope consumes the grant; no money path touched.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-c2b-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'                 // verify requires network mode (set BEFORE importing MCP server)
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema } = await import('../src/runtime/webaz-schema-helpers.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase()
setSeamDb(db)
initUserModerationSchema(db)
const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human auth in this test' }); return null }
const app = express()
app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true })
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`   // point MCP at our ephemeral PWA (before MCP import)

// Now import the MCP server (boots against the same temp HOME DB; sets MODE=network).
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

// helpers to plant a stored credential exactly as handlePair("complete") would
const webazDir = join(tmpHome, '.webaz')
const plantCredential = (grantId: string, token: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [grantId]: { token, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: grantId, handle: `file:~/.webaz/credentials#${grantId}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCredential = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }

try {
  // 1) resolver round-trip (file fallback)
  plantCredential('grt_resolve', 'gtk_resolveme', ['read_public'])
  const cred = mcp.resolveGrantCredential()
  ok('1 resolveGrantCredential round-trips the stored token', cred?.grant_id === 'grt_resolve' && cred?.token === 'gtk_resolveme')
  clearCredential()
  ok('1b no pointer → resolveGrantCredential null', mcp.resolveGrantCredential() === null)

  // 2) verify with no stored credential → not_paired (no network)
  const np = await mcp.handlePair({ action: 'verify' })
  ok('2 verify with no credential → not_paired', np.status === 'not_paired' && np.error_code === 'NO_GRANT_CREDENTIAL')

  // fixtures for the live path: a human + an active grant carrying read_public, token = gtk_int
  const human = generateId('usr')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(human, 'Bob', 'buyer', 'key_bob')
  const gid = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(gid, human, 'AgentC2b', JSON.stringify([{ capability: 'read_public', constraints: {} }]), sha('gtk_int'), 'active', new Date(Date.now() + 3600_000).toISOString())
  plantCredential(gid, 'gtk_int', ['read_public'])

  // 3) verify with a valid grant → active + principal (server-enforced; token never printed)
  const active = await mcp.handlePair({ action: 'verify' })
  ok('3 verify valid grant → active', active.status === 'active' && (active.grant as any)?.grant_id === gid && (active.grant as any)?.human_id === human)
  ok('3b verify response does not leak the raw token', !JSON.stringify(active).includes('gtk_int'))
  ok('3c verify returns the FULL authorized scope list (not just one capability)', Array.isArray((active.grant as any)?.scopes) && (active.grant as any).scopes.includes('read_public') && !!active.local_cache)

  // 3c2/3c3 — webaz_connection_status via the grant (read_public): the OAuth-bound identity, MASKED,
  //   with the safe scopes + expiry and NO PII / token / api_key / full account id (RFC-023 E-node).
  db.prepare('UPDATE users SET handle = ? WHERE id = ?').run('bob_b', human)
  const conn = await mcp.handleConnectionStatus({})
  ok('3c2 connection_status via grant → connected + @handle + MASKED account id + scopes + expiry',
    conn.connected === true && conn.handle === '@bob_b'
    && typeof conn.account_id_hint === 'string' && (conn.account_id_hint as string).includes('…')
    && Array.isArray(conn.scopes) && (conn.scopes as string[]).includes('read_public')
    && typeof conn.expires_at === 'string')
  ok('3c3 connection_status leaks NO raw token / api_key / full account id / email / address (E-node no-PII)',
    !JSON.stringify(conn).includes('gtk_int') && !JSON.stringify(conn).includes('key_bob')
    && !JSON.stringify(conn).includes(human) && !/api_key|email|address/i.test(JSON.stringify(conn)))
  ok('3c4 connection_status with NO grant → connected:false + guidance (not a crash/PII)', await (async () => { const c = await mcp.handleConnectionStatus({ __isolated__: true }); return c.connected === false && typeof c.note === 'string' && !JSON.stringify(c).includes('gtk_int') })())
  // 3c5 — a SHORT account id must STILL be redacted, NEVER returned verbatim (defense-in-depth, Codex).
  const shortHuman = 'usr_s'   // 5 chars ≤ 8: the overlap branch
  db.prepare('INSERT INTO users (id, name, role, api_key, handle) VALUES (?,?,?,?,?)').run(shortHuman, 'Sam', 'buyer', 'key_sam', 'sam_s')
  const sgid = generateId('grt')
  db.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(sgid, shortHuman, 'AgentShort', JSON.stringify([{ capability: 'read_public' }]), sha('gtk_short'), 'active', new Date(Date.now() + 3600_000).toISOString())
  plantCredential(sgid, 'gtk_short', ['read_public'])
  const connShort = await mcp.handleConnectionStatus({})
  ok('3c5 SHORT account id is STILL redacted (hint !== full id, id not present verbatim, has ellipsis)',
    connShort.connected === true && connShort.account_id_hint !== shortHuman
    && !JSON.stringify(connShort).includes(shortHuman) && String(connShort.account_id_hint).includes('…'))
  plantCredential(gid, 'gtk_int', ['read_public'])   // restore the primary grant credential for the tests below

  // 3d/3e) agent requests MORE scope via the grant bearer, then lists its OWN requests (grant-authed, no human)
  const reqd = await mcp.handlePair({ action: 'request', bundle: 'catalog_agent', reason: 'read my catalog' })
  ok('3d request → requested + approval_id + approval_url (safe bundle via grant bearer)', reqd.status === 'requested' && String(reqd.approval_id).startsWith('apr_') && String(reqd.approval_url).includes('/#agent-approvals'))
  const listed = await mcp.handlePair({ action: 'requests' })
  ok("3e requests lists this grant's own pending request", Array.isArray(listed.requests) && (listed.requests as Array<any>).some(r => r.id === reqd.approval_id && r.status === 'pending'))
  ok('3f request/list never leak the raw token', !JSON.stringify([reqd, listed]).includes('gtk_int'))

  // 3g/3h/3i) business tool consumes the grant: webaz_list_product action=mine reads the seller catalog.
  //   gid still holds only read_public → PERMISSION_REQUIRED; grant it seller_products_read → returns catalog.
  const gDenied = await mcp.handleListProduct({ action: 'mine' })
  ok('3g list_product action=mine via grant, missing seller_products_read → PERMISSION_REQUIRED + retry', gDenied.error_code === 'PERMISSION_REQUIRED' && gDenied.retry_after_approval === true)
  db.prepare('UPDATE agent_delegation_grants SET capabilities=? WHERE grant_id=?').run(JSON.stringify([{ capability: 'read_public' }, { capability: 'seller_products_read' }]), gid)
  db.prepare("INSERT INTO products (id, seller_id, title, description, price, status) VALUES ('prd_g1',?,'Grant Widget','d',12,'active')").run(human)
  const gMine = await mcp.handleListProduct({ action: 'mine' })
  ok('3h grant now carries seller_products_read → action=mine returns the seller catalog via grant', gMine.via === 'delegation_grant' && Array.isArray(gMine.products) && (gMine.products as Array<Record<string, unknown>>).some(p => p.id === 'prd_g1'))
  ok('3i grant business-read leaks no raw token', !JSON.stringify([gDenied, gMine]).includes('gtk_int'))
  // 3j) a grant can never PUBLISH/ACTIVATE — relist/delist/update/delete via a grant → GRANT_WRITE_NOT_ENABLED
  const gRelist = await mcp.handleListProduct({ action: 'relist', product_id: 'prd_g1' })
  ok('3j action=relist (publish/activate) via grant → GRANT_WRITE_NOT_ENABLED (publish stays human/api_key)', gRelist.error_code === 'GRANT_WRITE_NOT_ENABLED')
  const gDelete = await mcp.handleListProduct({ action: 'delete', product_id: 'prd_g1' })
  ok('3k action=delete via grant → GRANT_WRITE_NOT_ENABLED', gDelete.error_code === 'GRANT_WRITE_NOT_ENABLED')

  // 4) revoke the grant → verify now fails per-call (revocation honored live)
  db.prepare("UPDATE agent_delegation_grants SET status='revoked', revoked_at=datetime('now') WHERE grant_id=?").run(gid)
  const revoked = await mcp.handlePair({ action: 'verify' })
  ok('4 verify after revoke → grant_invalid (per-call revocation honored; agent told to re-pair)', revoked.status === 'grant_invalid' && !!revoked.error_code)

  if (fail === 0) {
    console.log(`\n✅ MCP grant consumption (PR-C2b): resolve stored credential → safe whoami; server enforces active/expiry/revoked per call; token never printed; safe scopes only\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ MCP grant consumption FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  rmSync(tmpHome, { recursive: true, force: true })
}
