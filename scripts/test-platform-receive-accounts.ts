#!/usr/bin/env tsx
/**
 * 平台(WebAZ)收款方式 admin 管理 —— 真 express + 真 helper + 真 schema。
 * 验:ROOT 门、写操作 Passkey【绑定收款内容】(purpose_data 逐字含 instruction/method/currency/label + qr_mode/qr_sha256;
 *   用批 A 的 token 写 B → 403)、QR 内联校验(png/webp≤64KB、拒 jpeg/oversize)、CRUD、update 缺省保留/显式清 qr、
 *   inactive 排除、审计 detail 记 canonical old/new 摘要(sha256,不含 raw QR)。
 * Usage: npm run test:platform-receive-accounts
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
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
db.prepare('INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_root', 'root1', 'pk')   // root1 has a Passkey (guard hard-rejects users without one)

// canonical gate payload derived from the body (MUST mirror the route's gateContentPayload) — so a token binds the content.
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
function payloadFor(action: string, accountId: string | null, body: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { action }
  if (accountId) p.account_id = accountId
  if (action === 'add' || action === 'update') {
    p.instruction = String(body.instruction ?? ''); p.method = String(body.method ?? ''); p.currency = String(body.currency ?? ''); p.label = String(body.label ?? '')
    if (!('qr_data_uri' in body)) p.qr_mode = 'keep'
    else if (body.qr_data_uri == null || String(body.qr_data_uri).trim() === '') p.qr_mode = 'clear'
    else { p.qr_mode = 'set'; p.qr_sha256 = sha(String(body.qr_data_uri)) }
  }
  return p
}
// sign the SAME body being sent (correct case)
const signed = (action: string, accountId: string | null, body: Record<string, unknown>): Record<string, unknown> => ({ ...body, webauthn_token: JSON.stringify(payloadFor(action, accountId, body)) })

const requireRootAdmin = (req: Request, res: Response): Record<string, unknown> | null => {
  if (req.headers['x-role'] !== 'root') { res.status(403).json({ error: 'root only' }); return null }
  return { id: 'root1', admin_type: 'root' }
}
const consumeGateToken = (_u: string, token: string | undefined, purpose: string, validate: (d: unknown) => boolean): { ok: boolean; reason?: string } => {
  if (!token) return { ok: false, reason: 'missing gate token' }
  if (purpose !== 'platform_receive_account_manage') return { ok: false, reason: 'bad purpose' }
  let d: unknown; try { d = JSON.parse(token) } catch { return { ok: false, reason: 'bad token' } }
  return validate(d) ? { ok: true } : { ok: false, reason: 'purpose_data mismatch' }   // route's validate = canonical-equal vs body
}
const audit: Array<{ action: string; targetId: string | null; detail?: Record<string, unknown> }> = []
const app = express(); app.use(express.json({ limit: '2mb' }))
registerPlatformReceiveAccountsRoutes(app, { db, requireRootAdmin, generateId, consumeGateToken, logAdminAction: (_a, action, _tt, targetId, detail) => audit.push({ action, targetId, detail }) })
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const call = async (method: string, path: string, root: boolean, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(root ? { 'x-role': 'root' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j: any = null; try { j = await r.json() } catch {}
  return { status: r.status, json: j }
}
const png = (fill = 'P'): string => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(fill)]).toString('base64')

try {
  // 1. root gate
  ok('1a. non-root list → 403', (await call('GET', '/api/admin/platform-receive-accounts', false)).status === 403)
  ok('1b. non-root add → 403', (await call('POST', '/api/admin/platform-receive-accounts', false, { instruction: 'x' })).status === 403)

  // 2. add needs Passkey + content-bound token
  ok('2a. add without gate token → 403', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'PayNow UEN 123' })).status === 403)
  const addBody = { instruction: 'PayNow UEN 123', method: 'PayNow', currency: 'SGD', label: 'main' }
  const add = await call('POST', '/api/admin/platform-receive-accounts', true, signed('add', null, addBody))
  ok('2b. add with content-bound token → ok', add.status === 200 && add.json?.ok && !!add.json?.account?.id)
  const id = add.json.account.id
  // P1 core: a token signed for content A must NOT write content B (tampered body / replayed token)
  const tokenForA = JSON.stringify(payloadFor('add', null, { instruction: 'PayNow UEN 123', method: 'PayNow', currency: 'SGD', label: 'main' }))
  ok('2c. token for content A cannot write content B (instruction) → 403', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'HACKER 0xEVIL', method: 'PayNow', currency: 'SGD', label: 'main', webauthn_token: tokenForA })).status === 403)
  ok('2d. wrong action in purpose_data → 403', (await call('POST', '/api/admin/platform-receive-accounts', true, { ...addBody, webauthn_token: JSON.stringify(payloadFor('update', null, addBody)) })).status === 403)

  // 3. QR inline validation
  ok('3a. jpeg rejected', (await call('POST', '/api/admin/platform-receive-accounts', true, signed('add', null, { instruction: 'z', qr_data_uri: 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff]).toString('base64') }))).status === 400)
  ok('3b. oversize rejected', (await call('POST', '/api/admin/platform-receive-accounts', true, signed('add', null, { instruction: 'z', qr_data_uri: png('y'.repeat(65 * 1024)) }))).status === 400)
  const addQrBody = { instruction: 'USDC 0xabc', currency: 'USDC', qr_data_uri: png('QR') }
  const addQr = await call('POST', '/api/admin/platform-receive-accounts', true, signed('add', null, addQrBody))
  ok('3c. valid png inline stored (qr content-bound)', addQr.json?.account?.qr_data_uri === png('QR'))
  const idQr = addQr.json.account.id
  // QR content binding: token bound to QR-A cannot swap in QR-B
  ok('3d. token bound to QR-A cannot store QR-B → 403', (await call('POST', '/api/admin/platform-receive-accounts', true, { instruction: 'USDC 0xabc', currency: 'USDC', qr_data_uri: png('EVIL'), webauthn_token: JSON.stringify(payloadFor('add', null, addQrBody)) })).status === 403)

  // 4. list
  const list = await call('GET', '/api/admin/platform-receive-accounts', true)
  ok('4. list returns accounts incl qr_data_uri', list.json.accounts.length >= 2 && 'qr_data_uri' in list.json.accounts[0])

  // 5. update: qr keep when omitted; clear when empty; content-bound
  const updBody = { instruction: 'USDC 0xabc (edited)', currency: 'USDC' }
  ok('5a. text update ok', (await call('PUT', '/api/admin/platform-receive-accounts/' + idQr, true, signed('update', idQr, updBody))).json?.ok === true)
  ok('5b. qr preserved when omitted', (db.prepare('SELECT qr_data_uri q FROM platform_receive_accounts WHERE id=?').get(idQr) as { q: string }).q === png('QR'))
  await call('PUT', '/api/admin/platform-receive-accounts/' + idQr, true, signed('update', idQr, { instruction: 'USDC 0xabc', qr_data_uri: '' }))
  ok('5c. qr cleared when sent empty', (db.prepare('SELECT qr_data_uri q FROM platform_receive_accounts WHERE id=?').get(idQr) as { q: string | null }).q === null)
  ok('5d. update needs Passkey (no token) → 403', (await call('PUT', '/api/admin/platform-receive-accounts/' + id, true, { instruction: 'x' })).status === 403)
  ok('5e. update nonexistent → 404', (await call('PUT', '/api/admin/platform-receive-accounts/nope', true, signed('update', 'nope', { instruction: 'x' }))).status === 404)

  // 6. deactivate + inactive excluded from active list
  ok('6a. deactivate ok', (await call('DELETE', '/api/admin/platform-receive-accounts/' + id, true, { webauthn_token: JSON.stringify(payloadFor('deactivate', id, {})) })).json?.changed === true)
  const { listActivePlatformAccounts } = await import('../src/platform-receive-accounts.js')
  ok('6b. deactivated excluded from active list', !listActivePlatformAccounts(db).some(a => a.id === id))
  ok('6c. still in admin list (includeInactive)', (await call('GET', '/api/admin/platform-receive-accounts', true)).json.accounts.some((a: any) => a.id === id))

  // 7. audit trail (P2): add=new summary; update=old+new; deactivate=old; hashes not raw QR
  const upAudit = audit.find(a => a.action === 'platform_receive_account_update')
  ok('7a. update audit has old + new canonical summary', !!upAudit?.detail?.old && !!upAudit?.detail?.new)
  ok('7b. audit uses sha256 not raw QR', JSON.stringify(audit).includes('qr_sha256') && !JSON.stringify(audit).includes('data:image'))
  const deAudit = audit.find(a => a.action === 'platform_receive_account_deactivate')
  ok('7c. deactivate audit records old summary', !!deAudit?.detail?.old)

  if (fail > 0) { console.error(`\n❌ platform receive accounts FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ platform receive accounts (admin): ROOT + content-bound Passkey (token for A can't write B) · inline QR png/webp≤64KB · update keep/clear qr · inactive excluded · audit records canonical old/new (sha256, no raw QR)\n  ✅ pass ${pass}`)
} finally {
  server.close()
}
