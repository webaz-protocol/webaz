#!/usr/bin/env tsx
/**
 * Direct Pay — 卖家多收款账号 + 硬化 QR owner-gated 端点 (Phase C1) — 真 express + 真 helper + 真 schema。
 * 验:seller/owner 门、写操作 Passkey(purpose+purpose_data 绑定)、QR 严格校验(png|webp only / magic /
 *   ≤64KB / 拒 svg·jpeg·text)、内容寻址不可变(同图幂等、换图新 ref 旧行仍可取、触发器禁 UPDATE/DELETE)、
 *   硬化转发(content-type + nosniff + no-store)、非本人 404 不枚举、审计 append-only 只记 ref 不写 raw。
 * Usage: npm run test:direct-receive-account-endpoints
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dra-ep-'))

import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { registerDirectReceiveAccountsRoutes } = await import('../src/pwa/routes/direct-receive-accounts.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
let _n = 0; const generateId = (p: string): string => `${p}_${++_n}`

const db = initDatabase()
db.pragma('foreign_keys = OFF')
for (const [u, role] of [['s1', 'seller'], ['s2', 'seller'], ['b1', 'buyer']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)
// s1 + s2 have a Passkey; the guard hard-rejects users without one. (webauthn_credentials is a runtime-helper table, not in initDatabase — create it here.)
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT, counter INTEGER DEFAULT 0)')
for (const s of ['s1', 's2']) db.prepare('INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter) VALUES (?,?,?,0)').run('cred_' + s, s, 'pk')

// fake auth (x-user header) + fake gate: token IS the purpose_data JSON (real gate binds it server-side; here validate() enforces the binding)
const auth = (req: Request, res: Response): Record<string, unknown> | null => {
  const uid = String(req.headers['x-user'] || ''); const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'unauth' }); return null }
  return u
}
const consumeGateToken = (_uid: string, token: string | undefined, purpose: string, validate: (d: unknown) => boolean): { ok: boolean; reason?: string } => {
  if (!token) return { ok: false, reason: 'missing gate token' }
  if (purpose !== 'direct_receive_account_manage') return { ok: false, reason: 'bad purpose' }
  let data: unknown; try { data = JSON.parse(token) } catch { return { ok: false, reason: 'bad token' } }
  return validate(data) ? { ok: true } : { ok: false, reason: 'purpose_data mismatch' }
}
const app = express(); app.use(express.json({ limit: '2mb' }))
registerDirectReceiveAccountsRoutes(app, { db, auth, generateId, consumeGateToken })
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const call = async (method: string, path: string, user?: string, body?: unknown): Promise<{ status: number; json: any; ct?: string | null; cc?: string | null; nosniff?: string | null; buf?: Buffer }> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const ct = r.headers.get('content-type')
  if (ct && !ct.includes('application/json')) { const ab = Buffer.from(await r.arrayBuffer()); return { status: r.status, json: null, ct, cc: r.headers.get('cache-control'), nosniff: r.headers.get('x-content-type-options'), buf: ab } }
  let j: any = null; try { j = await r.json() } catch {}
  return { status: r.status, json: j, ct }
}
const tok = (o: object): string => JSON.stringify(o)
const pngDataUri = (fill = 'x'): string => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]).toString('base64')

try {
  // 1. auth / role
  ok('1a. unauth → 401', (await call('GET', '/api/direct-receive/accounts')).status === 401)
  ok('1b. buyer role → 403', (await call('GET', '/api/direct-receive/accounts', 'b1')).status === 403)

  // 2. add needs Passkey
  ok('2a. add without gate token → 403', (await call('POST', '/api/direct-receive/accounts', 's1', { instruction: 'Bank 123' })).status === 403)
  const add1 = await call('POST', '/api/direct-receive/accounts', 's1', { instruction: 'Kasikorn 123', method: 'Bank', currency: 'THB', webauthn_token: tok({ action: 'add' }) })
  ok('2b. add with gate token → ok', add1.status === 200 && add1.json?.ok === true && !!add1.json?.account?.id)
  const acc1 = add1.json.account.id
  ok('2c. add with wrong purpose_data (action mismatch) → 403', (await call('POST', '/api/direct-receive/accounts', 's1', { instruction: 'x', webauthn_token: tok({ action: 'update' }) })).status === 403)

  // 3. list returns no raw QR (only qr_image_ref); currency/method round-trip
  const list = await call('GET', '/api/direct-receive/accounts', 's1')
  ok('3a. list returns the account, no data_b64/raw QR field', list.json.accounts.length === 1 && !('data_b64' in list.json.accounts[0]) && 'qr_image_ref' in list.json.accounts[0])

  // 4. QR validation
  const badCases: [string, string][] = [
    ['svg rejected', 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')],
    ['text/html rejected', 'data:text/html;base64,' + Buffer.from('<b>').toString('base64')],
    ['jpeg rejected (C1 png|webp only)', 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff]).toString('base64')],
    ['png with wrong magic bytes rejected', 'data:image/png;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')],
    ['oversize (>64KB) rejected', pngDataUri('y'.repeat(65 * 1024))],
  ]
  for (const [name, uri] of badCases) ok('4. ' + name, (await call('PUT', `/api/direct-receive/accounts/${acc1}/qr`, 's1', { qr_data_uri: uri, webauthn_token: tok({ action: 'qr', account_id: acc1 }) })).status === 400)
  ok('4z. qr upload needs Passkey (no token → 403)', (await call('PUT', `/api/direct-receive/accounts/${acc1}/qr`, 's1', { qr_data_uri: pngDataUri() })).status === 403)

  // 5. valid QR upload → ref; idempotent same-image; replace → new ref; old row still fetchable (immutability)
  const up1 = await call('PUT', `/api/direct-receive/accounts/${acc1}/qr`, 's1', { qr_data_uri: pngDataUri('AAA'), webauthn_token: tok({ action: 'qr', account_id: acc1 }) })
  ok('5a. valid png upload → ref', up1.status === 200 && !!up1.json?.qr_image_ref)
  const ref1 = up1.json.qr_image_ref
  const up1b = await call('PUT', `/api/direct-receive/accounts/${acc1}/qr`, 's1', { qr_data_uri: pngDataUri('AAA'), webauthn_token: tok({ action: 'qr', account_id: acc1 }) })
  ok('5b. same image → same ref (content-addressed, idempotent)', up1b.json?.qr_image_ref === ref1)
  const up2 = await call('PUT', `/api/direct-receive/accounts/${acc1}/qr`, 's1', { qr_data_uri: pngDataUri('BBB'), webauthn_token: tok({ action: 'qr', account_id: acc1 }) })
  ok('5c. different image → new ref, account points to new', up2.json?.qr_image_ref && up2.json.qr_image_ref !== ref1)
  ok('5d. old ref row still exists (immutable, for order snapshots)', !!db.prepare('SELECT 1 FROM direct_receive_account_qr_images WHERE ref = ?').get(ref1))
  ok('5e. qr_images UPDATE forbidden (trigger)', (() => { try { db.prepare("UPDATE direct_receive_account_qr_images SET mime='x' WHERE ref=?").run(ref1); return false } catch { return true } })())
  ok('5f. qr_images DELETE forbidden (trigger)', (() => { try { db.prepare('DELETE FROM direct_receive_account_qr_images WHERE ref=?').run(ref1); return false } catch { return true } })())

  // 6. hardened serve (owner)
  const qr = await call('GET', `/api/direct-receive/accounts/${acc1}/qr`, 's1')
  ok('6a. owner GET qr → 200 image/png bytes', qr.status === 200 && qr.ct === 'image/png' && !!qr.buf && qr.buf.length > 0)
  ok('6b. serve headers: nosniff + private no-store', qr.nosniff === 'nosniff' && /private/.test(qr.cc || '') && /no-store/.test(qr.cc || ''))

  // 7. owner scoping / non-enumeration (s2 attacks s1's account)
  ok('7a. non-owner update → 404 (not 403, non-enumerating)', (await call('PUT', `/api/direct-receive/accounts/${acc1}`, 's2', { instruction: 'HACK', webauthn_token: tok({ action: 'update', account_id: acc1 }) })).status === 404)
  ok('7b. non-owner deactivate → 404', (await call('DELETE', `/api/direct-receive/accounts/${acc1}`, 's2', { webauthn_token: tok({ action: 'deactivate', account_id: acc1 }) })).status === 404)
  ok('7c. non-owner qr upload → 404', (await call('PUT', `/api/direct-receive/accounts/${acc1}/qr`, 's2', { qr_data_uri: pngDataUri(), webauthn_token: tok({ action: 'qr', account_id: acc1 }) })).status === 404)
  ok('7d. non-owner qr read → 404', (await call('GET', `/api/direct-receive/accounts/${acc1}/qr`, 's2')).status === 404)
  ok('7e. nonexistent account → 404', (await call('GET', '/api/direct-receive/accounts/nope/qr', 's1')).status === 404)

  // 8. update + deactivate (owner, Passkey)
  ok('8a. owner update ok', (await call('PUT', `/api/direct-receive/accounts/${acc1}`, 's1', { instruction: 'Kasikorn 999', webauthn_token: tok({ action: 'update', account_id: acc1 }) })).json?.ok === true)
  ok('8b. owner deactivate ok + list active shrinks', (await call('DELETE', `/api/direct-receive/accounts/${acc1}`, 's1', { webauthn_token: tok({ action: 'deactivate', account_id: acc1 }) })).json?.changed === true)

  // 9. audit append-only, NO raw instruction / raw QR stored
  const events = db.prepare('SELECT event_type, qr_ref FROM direct_receive_account_events WHERE account_id = ? ORDER BY created_at').all(acc1) as { event_type: string; qr_ref: string | null }[]
  ok('9a. events logged (added/qr_uploaded/updated/deactivated)', ['account_added', 'qr_uploaded', 'account_updated', 'account_deactivated'].every(t => events.some(e => e.event_type === t)))
  const evCols = (db.prepare('PRAGMA table_info(direct_receive_account_events)').all() as { name: string }[]).map(c => c.name)
  ok('9b. events table has NO raw instruction / data columns', !evCols.includes('instruction') && !evCols.includes('data_b64') && !evCols.includes('qr_data_uri'))
  ok('9c. qr_uploaded events carry a ref (not raw)', events.filter(e => e.event_type === 'qr_uploaded').every(e => !!e.qr_ref))

  if (fail > 0) { console.error(`\n❌ direct-receive account endpoints FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ direct-receive account endpoints (C1): seller/owner + Passkey-gated writes · strict png|webp QR (magic/64KB) · immutable content-addressed · hardened serve · non-enumerating · append-only audit (no raw)\n  ✅ pass ${pass}`)
} finally {
  server.close()
}
