#!/usr/bin/env tsx
/** RFC-028 S1c0 schema contract: refresh-token families preserve DPoP key binding. */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { initOAuthSchema } from '../src/runtime/webaz-schema-helpers.js'

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}
const throws = (fn: () => void): boolean => { try { fn(); return false } catch { return true } }

const fresh = new Database(':memory:')
initOAuthSchema(fresh)
const freshCols = new Set((fresh.prepare('PRAGMA table_info(oauth_refresh_tokens)').all() as Array<{ name: string }>).map(c => c.name))
ok('1. fresh refresh-token table has dpop_jkt', freshCols.has('dpop_jkt'))
ok('2. canonical RFC 7638 thumbprint is accepted', !throws(() => fresh.prepare(`INSERT INTO oauth_refresh_tokens
  (token_hash,grant_id,client_id,family_id,scope,aud,expires_at,dpop_jkt)
  VALUES ('t1','g1','c1','f1','read','https://webaz.xyz/mcp','2099-01-01T00:00:00.000Z',?)`).run('A'.repeat(43))))
ok('3. 43-character illegal alphabet is rejected', throws(() => fresh.prepare(`INSERT INTO oauth_refresh_tokens
  (token_hash,grant_id,client_id,family_id,scope,aud,expires_at,dpop_jkt)
  VALUES ('t2','g1','c1','f1','read','https://webaz.xyz/mcp','2099-01-01T00:00:00.000Z',?)`).run(`${'A'.repeat(42)}!`)))
ok('4. non-canonical final base64url character is rejected', throws(() => fresh.prepare(`INSERT INTO oauth_refresh_tokens
  (token_hash,grant_id,client_id,family_id,scope,aud,expires_at,dpop_jkt)
  VALUES ('t3','g1','c1','f1','read','https://webaz.xyz/mcp','2099-01-01T00:00:00.000Z',?)`).run(`${'A'.repeat(42)}B`)))
ok('5. ordinary bearer refresh family remains nullable', !throws(() => fresh.prepare(`INSERT INTO oauth_refresh_tokens
  (token_hash,grant_id,client_id,family_id,scope,aud,expires_at)
  VALUES ('t4','g1','c1','f1','read','https://webaz.xyz/mcp','2099-01-01T00:00:00.000Z')`).run()))
fresh.close()

const legacy = new Database(':memory:')
legacy.exec(`CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  family_id TEXT NOT NULL, scope TEXT NOT NULL, aud TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
  rotated_at TEXT, revoked_at TEXT, replaced_by TEXT
)`)
initOAuthSchema(legacy)
initOAuthSchema(legacy)
const legacyCols = (legacy.prepare('PRAGMA table_info(oauth_refresh_tokens)').all() as Array<{ name: string }>).map(c => c.name)
ok('6. existing table gains dpop_jkt', legacyCols.includes('dpop_jkt'))
ok('7. repeated init never duplicates the binding column', legacyCols.filter(c => c === 'dpop_jkt').length === 1)
legacy.close()

const pg = readFileSync('db/schema.pg.sql', 'utf8')
const createAt = pg.indexOf('CREATE TABLE IF NOT EXISTS oauth_refresh_tokens')
const nextCreateAt = pg.indexOf('\nCREATE TABLE IF NOT EXISTS ', createAt + 1)
const refreshCreate = pg.slice(createAt, nextCreateAt < 0 ? pg.length : nextCreateAt)
const alterAt = pg.indexOf('ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS dpop_jkt TEXT')
ok('8. PostgreSQL fresh table itself includes dpop_jkt', /dpop_jkt\s+TEXT CHECK/.test(refreshCreate))
ok('9. PostgreSQL upgrade migration runs after table creation', createAt >= 0 && alterAt > createAt)
ok('10. PostgreSQL binding constraint keeps NULL-compatible canonical shape', /ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS dpop_jkt TEXT[\s\S]*?length\(dpop_jkt\) = 43/.test(pg))

if (fail) {
  console.error(`agent gateway S1c0 schema: ${pass} pass / ${fail} fail\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`agent gateway S1c0 schema: ${pass} pass`)
