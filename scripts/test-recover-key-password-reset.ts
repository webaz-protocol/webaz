#!/usr/bin/env tsx
/**
 * recover-key/confirm — code + optional new_password reset (behavioral, real express + node:http).
 *   用法:npm run test:recover-key-password-reset
 *
 * The confirm endpoint already returns the full api_key after a verified code; this adds an OPTIONAL
 * new_password that resets users.password_hash under the SAME gate (no extra power). Verifies: without
 * new_password the api_key is returned and password_hash is untouched; with a valid new_password the hash
 * is set + password_reset:true; an invalid new_password is rejected WITHOUT consuming the code (retryable);
 * a wrong code never sets a password; the code is single-use.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerRecoverKeyRoutes } from '../src/pwa/routes/recover-key.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, handle TEXT, role TEXT DEFAULT 'buyer', email TEXT, email_verified INTEGER DEFAULT 0, phone TEXT, api_key TEXT, password_hash TEXT, failed_attempts INTEGER DEFAULT 0, locked_until TEXT, deleted_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`)
db.exec(`CREATE TABLE verification_codes (id TEXT PRIMARY KEY, user_id TEXT, channel TEXT, target TEXT, code TEXT, purpose TEXT, attempts INTEGER DEFAULT 0, expires_at TEXT, used_at TEXT)`)
db.prepare("INSERT INTO users (id,name,handle,email,email_verified,api_key) VALUES ('usr_alice','Alice','holden','alice@example.com',1,'key_alice_secret')").run()
setSeamDb(db)

// stub hashPassword: prefix marker (the real one is scrypt; we only assert it was applied + input flows)
const hashPassword = (plain: string) => 'scrypt$' + Buffer.from(plain).toString('hex').slice(0, 16)
const findActiveCode = (channel: string, target: string, purpose: string) =>
  db.prepare("SELECT * FROM verification_codes WHERE channel=? AND target=? AND purpose=? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(channel, target, purpose)
const seedCode = (code: string) => { db.prepare("DELETE FROM verification_codes").run(); db.prepare("INSERT INTO verification_codes (id,user_id,channel,target,code,purpose,expires_at) VALUES ('vc1','usr_alice','email','alice@example.com',?,'recover_key',datetime('now','+10 minutes'))").run(code) }
const pwHash = () => (db.prepare("SELECT password_hash p FROM users WHERE id='usr_alice'").get() as any).p
const codeUsed = () => !!(db.prepare("SELECT used_at u FROM verification_codes WHERE id='vc1'").get() as any)?.u
const lockState = () => db.prepare("SELECT failed_attempts a, locked_until l FROM users WHERE id='usr_alice'").get() as any
const issueCalls: string[] = []   // records userIds issueCode was called for

let server: Server, port = 0
const post = (path: string, body: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = JSON.stringify(body)
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.write(p); r.end()
})

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerRecoverKeyRoutes(app, {
    db, internalAuditorId: 'usr_iaudit_001',
    issueCode: (async (userId: string) => { issueCalls.push(userId); return { ok: true, code: '000000', expires_at: '', provider: 'dev_console' } }) as any,
    findActiveCode, canDeliverCodes: () => true, emailDeliveryNotConfigured: (() => ({ ok: false, status: 503, error_code: 'EMAIL_DELIVERY_NOT_CONFIGURED', error: 'x' })) as any,
    hashPassword, CODE_TTL_MIN: 10, MAX_CODE_ATTEMPTS: 5,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) no new_password → api_key returned, password_hash untouched (backward compatible)
  seedCode('123456')
  { const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '123456' })
    ok('no new_password → api_key returned, no password_reset flag', r.json?.success === true && r.json?.api_key === 'key_alice_secret' && !r.json?.password_reset, JSON.stringify(r.json))
    ok('password_hash untouched when not requested', pwHash() == null)
    ok('code consumed (single-use)', codeUsed()) }

  // 2) invalid new_password (too short) → rejected WITHOUT consuming the code (retryable)
  seedCode('222222')
  { const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '222222', new_password: 'short' })
    ok('short new_password → error', /至少 8 字符/.test(r.json?.error || ''))
    ok('code NOT consumed on password-format reject (retryable)', !codeUsed())
    ok('no password set on reject', pwHash() == null) }

  // 3) valid new_password → password_hash set + password_reset:true + api_key still returned
  { const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '222222', new_password: 'a-strong-passphrase' })
    ok('valid new_password → success + password_reset:true + api_key', r.json?.success === true && r.json?.password_reset === true && r.json?.api_key === 'key_alice_secret', JSON.stringify(r.json))
    ok('password_hash now set via hashPassword', typeof pwHash() === 'string' && pwHash().startsWith('scrypt$'))
    ok('code consumed after successful reset', codeUsed()) }

  // 4) wrong code never sets a password
  db.prepare("UPDATE users SET password_hash=NULL WHERE id='usr_alice'").run()
  seedCode('333333')
  { const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '999999', new_password: 'another-strong-pass' })
    ok('wrong code → error, no password set', /验证码错误/.test(r.json?.error || '') && pwHash() == null) }

  // 5) over-long new_password rejected
  seedCode('444444')
  { const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '444444', new_password: 'x'.repeat(201) })
    ok('>200-char new_password → error, code not consumed', /密码过长/.test(r.json?.error || '') && !codeUsed()) }

  // 6) P1 — account resolved by @handle / bare handle (login parity), not just name
  { const a = await post('/api/recover-key', { name: '@holden' })
    const b = await post('/api/recover-key', { name: 'holden' })
    ok('hint: @holden and holden both find the account (handle resolution)', a.json?.found === 1 && b.json?.found === 1, JSON.stringify([a.json?.found, b.json?.found])) }
  { issueCalls.length = 0
    const r = await post('/api/recover-key/start', { name: '@holden', email: 'alice@example.com' })
    ok('start: @holden + email → issues code for the handle-resolved user', r.json?.success === true && issueCalls.includes('usr_alice'), JSON.stringify(issueCalls)) }
  { seedCode('555555'); db.prepare("UPDATE users SET password_hash=NULL WHERE id='usr_alice'").run()
    const r = await post('/api/recover-key/confirm', { name: '@holden', email: 'alice@example.com', code: '555555', new_password: 'handle-resolved-pass' })
    ok('confirm: @holden matches the code user → success + password set', r.json?.success === true && r.json?.password_reset === true && typeof pwHash() === 'string') }

  // 7) P2 — password reset clears lock state (failed_attempts=0, locked_until=NULL)
  { db.prepare("UPDATE users SET failed_attempts=3, locked_until=datetime('now','+30 minutes'), password_hash=NULL WHERE id='usr_alice'").run()
    seedCode('666666')
    const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '666666', new_password: 'unlock-me-please' })
    const ls = lockState()
    ok('reset clears lock state (failed_attempts=0, locked_until=NULL)', r.json?.password_reset === true && ls.a === 0 && ls.l == null, JSON.stringify(ls)) }

  // 8) deleted accounts cannot use a code issued before deletion or start a new recovery
  { seedCode('777777'); db.prepare("UPDATE users SET deleted_at=datetime('now'), password_hash=NULL WHERE id='usr_alice'").run()
    const r = await post('/api/recover-key/confirm', { name: 'Alice', email: 'alice@example.com', code: '777777', new_password: 'must-not-return' })
    ok('deleted account cannot confirm a pre-issued recovery code', !r.json?.success && pwHash() == null, JSON.stringify(r.json))
    const hint = await post('/api/recover-key', { name: '@holden' })
    ok('deleted account is absent from recovery hints', hint.json?.found === undefined && /未找到/.test(hint.json?.error || ''), JSON.stringify(hint.json))
    issueCalls.length = 0
    await post('/api/recover-key/start', { name: '@holden', email: 'alice@example.com' })
    ok('deleted account cannot receive a new recovery code', issueCalls.length === 0, JSON.stringify(issueCalls)) }
  server.close()

  if (fail === 0) {
    console.log(`\n✅ recover-key password reset: optional new_password under the same code gate — backward-compatible (api_key only); valid → password_hash set + password_reset:true; invalid/over-long rejected WITHOUT consuming the code; wrong code never sets a password; single-use\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ recover-key password reset FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
