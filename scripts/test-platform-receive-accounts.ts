#!/usr/bin/env tsx
/**
 * 平台(WebAZ)收款方式 admin 管理 —— 真 express + 真 helper + 真 schema。
 * 验:ROOT 门(非 root 拒)、写操作 Passkey(purpose+action[+account_id] 绑)、QR 内联校验(png/webp≤64KB、拒 svg/jpeg)、
 *   CRUD(add/update/deactivate)、inactive 排除、update 缺省不改 qr / 显式清除。
 * Usage: npm run test:platform-receive-accounts
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'pra-'))

import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { registerPlatformReceiveAccountsRoutes } = await import('../src/pwa/routes/platform-receive-accounts.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
let _n = 0; const generateId = (p: string): string => `${p}_${++_n}`

const db = initDatabase()
db.pragma('foreign_keys = OFF')
db.prepare('CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT, counter INTEGER DEFAULT 0)').run()
db.prepare('INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_root', 'root1', 'pk')

// fake root-admin gate (x-role header) + fake gate: token IS the purpose_data JSON (validate enforces binding)
const requireRootAdmin = (req: Request, res: Response): Record<string, unknown> | null => {
  if (req.headers['x-role'] !== 'root') { res.status(403).json({ error: 'root only' }); return null }
  return { id: 'root1', admin_type: 'root' }
}
const consumeGateToken = (_u: string, token: string | undefined, purpose: string, validate: (d: unknown) => boolean): { ok: boolean; reason?: string } => {
  if (!token) return { ok: false, reason: 'missing gate token' }
  if (purpose !== 'platform_receive_account_manage') return { ok: false, reason: 'bad purpose' }
  let d: unknown; try { d = JSON.parse(token) } catch { return { ok: false, reason: 'bad token' } }
  return validate(d) ? { ok: true } : { ok: false, reason: 'purpose_data mismatch' }
}
const app = express(); app.use(express.json({ limit: '2mb' }))
registerPlatformReceiveAccountsRoutes(app, { db, requireRootAdmin, generateId, consumeGateToken })
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const call = async (method: string, path: string, root: boolean, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(root ? { 'x-role': 'root' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j: any = null; try { j = await r.json() } catch {}
  return { status: r.status, json: j }
}
const tok = (o: object): string => JSON.stringify(o)
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('P')]).toString('base64')

try {
  // 1. root gate
  ok('1a. non-root list → 403', (await call('GET', '/api/admin/platform-receive-accounts', false)).status === 403)
  ok('1b. non-root add → 403', (await call('POST', '/api/admin/platform-receive-accounts', false, { instruction: 'x' })).status === 403)

  // 2. add needs Passkey
  ok('2a. add without gate token → 403', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'PayNow UEN 123' })).status === 403)
  const add = await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'PayNow UEN 123', method: 'PayNow', currency: 'SGD', label: 'main', webauthn_token: tok({ action: 'add' }) })
  ok('2b. add with token → ok', add.status === 200 && add.json?.ok && !!add.json?.account?.id)
  const id = add.json.account.id
  ok('2c. add wrong action purpose_data → 403', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'y', webauthn_token: tok({ action: 'update' }) })).status === 403)

  // 3. QR inline validation
  ok('3a. jpeg rejected (png|webp only)', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'z', qr_data_uri: 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff]).toString('base64'), webauthn_token: tok({ action: 'add' }) })).status === 400)
  ok('3b. oversize rejected', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'z', qr_data_uri: 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('y'.repeat(65 * 1024))]).toString('base64'), webauthn_token: tok({ action: 'add' }) })).status === 400)
  const addQr = await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'USDC 0xabc', currency: 'USDC', qr_data_uri: png, webauthn_token: tok({ action: 'add' }) })
  ok('3c. valid png inline stored', addQr.json?.account?.qr_data_uri === png)
  const idQr = addQr.json.account.id

  // 4. list (root; incl inactive; has qr_data_uri)
  const list = await call('GET', '/api/admin/platform-receive-accounts', true)
  ok('4. list returns accounts incl qr_data_uri field', list.json.accounts.length >= 2 && 'qr_data_uri' in list.json.accounts[0])

  // 5. update: text only (qr omitted → keep); explicit clear
  const upd = await call('PUT', '/api/admin/platform-receive-accounts/' + idQr, true, { instruction: 'USDC 0xabc (edited)', currency: 'USDC', webauthn_token: tok({ action: 'update', account_id: idQr }) })
  ok('5a. text update ok', upd.json?.ok === true)
  ok('5b. qr preserved when omitted', (db.prepare('SELECT qr_data_uri q FROM platform_receive_accounts WHERE id=?').get(idQr) as { q: string }).q === png)
  await call('PUT', '/api/admin/platform-receive-accounts/' + idQr, true, { instruction: 'USDC 0xabc', qr_data_uri: '', webauthn_token: tok({ action: 'update', account_id: idQr }) })
  ok('5c. qr cleared when sent empty', (db.prepare('SELECT qr_data_uri q FROM platform_receive_accounts WHERE id=?').get(idQr) as { q: string | null }).q === null)
  ok('5d. update needs Passkey (no token → 403)', (await call('PUT', '/api/admin/platform-receive-accounts/' + id, true, { instruction: 'x' })).status === 403)
  ok('5e. update nonexistent → 404', (await call('PUT', '/api/admin/platform-receive-accounts/nope', true, { instruction: 'x', webauthn_token: tok({ action: 'update', account_id: 'nope' }) })).status === 404)

  // 6. deactivate + inactive excluded from active list
  ok('6a. deactivate ok', (await call('DELETE', '/api/admin/platform-receive-accounts/' + id, true, { webauthn_token: tok({ action: 'deactivate', account_id: id }) })).json?.changed === true)
  const { listActivePlatformAccounts } = await import('../src/platform-receive-accounts.js')
  ok('6b. deactivated excluded from active list', !listActivePlatformAccounts(db).some(a => a.id === id))
  ok('6c. but still in admin list (includeInactive)', (await call('GET', '/api/admin/platform-receive-accounts', true)).json.accounts.some((a: any) => a.id === id))

  if (fail > 0) { console.error(`\n❌ platform receive accounts FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ platform receive accounts (admin): ROOT + Passkey-gated CRUD · inline QR png/webp≤64KB (jpeg/oversize rejected) · update keeps/clears qr · inactive excluded from seller-facing active list\n  ✅ pass ${pass}`)
} finally {
  server.close()
}
