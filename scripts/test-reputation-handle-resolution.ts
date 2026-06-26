#!/usr/bin/env tsx
/**
 * Contract: GET /api/users/:id/reputation must resolve the ref three ways (usr_xxx / permanent_code /
 *   @handle) to the SAME canonical level — like every sibling endpoint in users-public.ts.
 *   用法:npm run test:reputation-handle-resolution
 *
 * Kills the silent-wrong bug where /reputation alone skipped resolveUserId() and queried the raw
 * param as a user_id, so @handle / permanent_code always fell through to the default level:'new'
 * while the same account by usr_id returned its real level. Public read, no auth, no money path.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-rep-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { registerUsersPublicRoutes } = await import('../src/pwa/routes/users-public.js')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
setSeamDb(db)
applyWebazRuntimeSchema(db)

const app = express()
registerUsersPublicRoutes(app, {
  db,
  auth: () => null,                          // these endpoints don't need an authed caller
  noteAuthenticityBadges: () => ({ verified_buyer: false, original_photos: false }),
})
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const get = async (ref: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/api/users/${encodeURIComponent(ref)}/reputation`)
  let body: any = null; try { body = JSON.parse(await r.text()) } catch { /* */ }
  return { status: r.status, body }
}

try {
  // a user reachable by all three ref forms, with a real (non-'new') agent level
  const uid = generateId('usr')
  db.prepare("INSERT INTO users (id, name, role, api_key, handle, permanent_code, region) VALUES (?,?,?,?,?,?,?)")
    .run(uid, 'Holden', 'buyer', 'key_' + uid, 'holden', 'NFTH2E', 'singapore')
  db.prepare('INSERT INTO agent_reputation (api_key, user_id, trust_score, level) VALUES (?,?,?,?)')
    .run('key_' + uid, uid, 21.62, 'trusted')

  const byId     = await get(uid)
  const byHandle = await get('@holden')
  const byCode   = await get('NFTH2E')

  ok('by usr_id → 200 + real level', byId.status === 200 && byId.body?.level === 'trusted', JSON.stringify(byId.body))
  ok('by @handle → SAME level as usr_id (the bug)', byHandle.status === 200 && byHandle.body?.level === 'trusted', JSON.stringify(byHandle.body))
  ok('by permanent_code → SAME level as usr_id', byCode.status === 200 && byCode.body?.level === 'trusted', JSON.stringify(byCode.body))
  ok('@handle resolves to canonical usr_id (not echoed raw)', byHandle.body?.user_id === uid, JSON.stringify(byHandle.body))

  // unresolvable ref → 404 (honest, consistent with sibling endpoints) — no fake 'new'
  const ghost = await get('@nobody_xyz')
  ok('unknown @handle → 404 (not fake level:new)', ghost.status === 404, JSON.stringify(ghost.body))

  // well-formed-but-unknown usr_id keeps the existing "exists-or-not, no agent rep = new" semantic
  const unknownUsr = await get('usr_doesnotexist000')
  ok('unknown usr_id → level:new (behavior unchanged)', unknownUsr.status === 200 && unknownUsr.body?.level === 'new', JSON.stringify(unknownUsr.body))

  if (fail === 0) {
    console.log(`\n✅ /reputation resolves usr_id / @handle / permanent_code to one canonical level; unknown ref 404s\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ /reputation handle-resolution FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  server.close()
  rmSync(tmpHome, { recursive: true, force: true })
}
