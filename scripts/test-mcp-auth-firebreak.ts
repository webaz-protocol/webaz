#!/usr/bin/env tsx
/**
 * MCP auth firebreak — a suspended account must fail the api_key path too.
 *   用法:npm run test:mcp-auth-firebreak
 *
 * The PWA session path (server.ts auth()) already blocks suspended accounts; the MCP path authenticates
 * by api_key with no session, so emergency-freeze's session revocation alone didn't cover it. This locks
 * that gap: authenticate()/requireAuth() honor user_moderation.suspended and fail closed.
 *
 * Pure (no express / no listen): authenticate/requireAuth take (db, apiKey) directly.
 */
import Database from 'better-sqlite3'
import { authenticate, requireAuth } from '../src/layer1-agent/L1-1-mcp-server/auth.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function freshDb(): any {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, handle TEXT, role TEXT, roles TEXT, api_key TEXT UNIQUE)`)
  db.exec(`CREATE TABLE user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER, reason TEXT)`)
  db.prepare(`INSERT INTO users (id,name,handle,role,roles,api_key) VALUES
    ('usr_ok','OK','ok','buyer','["buyer"]','k_ok'),
    ('usr_susp','Susp','susp','admin','["admin"]','k_susp'),
    ('usr_nomod','NoMod','nomod','buyer','["buyer"]','k_nomod')`).run()
  // usr_susp is suspended (e.g. emergency-frozen); usr_ok explicitly not; usr_nomod has NO row at all
  db.prepare(`INSERT INTO user_moderation (user_id,suspended,reason) VALUES ('usr_susp',1,'emergency admin freeze'),('usr_ok',0,NULL)`).run()
  return db
}

async function main(): Promise<void> {
  const db = freshDb()

  // ── valid, non-suspended → authenticates ──
  ok('valid non-suspended key → authenticate returns the user', authenticate(db, 'k_ok')?.id === 'usr_ok')
  ok('user with NO moderation row → authenticates (not suspended)', authenticate(db, 'k_nomod')?.id === 'usr_nomod')

  // ── SUSPENDED key → fail closed on the api_key path ──
  ok('suspended account → authenticate returns null (fail-closed)', authenticate(db, 'k_susp') === null)
  { const r = requireAuth(db, 'k_susp')
    ok('suspended account → requireAuth returns an error, not a user', 'error' in r && !('user' in r)) }

  // ── invalid / empty keys still rejected ──
  ok('invalid key → null', authenticate(db, 'nope') === null)
  ok('empty key → null', authenticate(db, '') === null)

  // ── requireAuth happy path unchanged ──
  { const r = requireAuth(db, 'k_ok')
    ok('valid key → requireAuth returns the user', 'user' in r && (r as any).user.id === 'usr_ok') }

  // ── lifting the suspension restores access (firebreak is state-driven, not a key burn) ──
  db.prepare(`UPDATE user_moderation SET suspended = 0 WHERE user_id = 'usr_susp'`).run()
  ok('after unsuspend → authenticate works again', authenticate(db, 'k_susp')?.id === 'usr_susp')

  if (fail === 0) {
    console.log(`\n✅ MCP auth firebreak: suspended account fails the api_key path (authenticate→null, requireAuth→error) · no-moderation-row & valid keys still pass · unsuspend restores access\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ MCP auth firebreak FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
