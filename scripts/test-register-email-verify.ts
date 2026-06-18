#!/usr/bin/env tsx
/**
 * register — email-verified-first onboarding (behavioral, real express + node:http).
 *   用法:npm run test:register-email-verify
 *
 * 注册改为"邮箱验证优先":/register/send-code 发码到邮箱(purpose='register'),/register 必须带 email + code,
 * 校验通过才建号并 email_verified=1。验证:无 email/code → 拒;错码不建号;有效码 → 建号 + email_verified=1 +
 * 码被消费(单次);重复已验证邮箱 → 拒;send-code 未配置投递 → 503;send-code 重复邮箱 → 409。
 * agent/MCP 注册走 handleRegister 直插库,不经此端点,不在本测试范围(本测试只覆盖 PWA 人类路径)。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerAuthRegisterRoutes } from '../src/pwa/routes/auth-register.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, roles TEXT, api_key TEXT, sponsor_id TEXT, sponsor_path TEXT, region TEXT, permanent_code TEXT, handle TEXT, email TEXT, email_verified INTEGER DEFAULT 0, password_hash TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`)
db.exec(`CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0)`)
db.exec(`CREATE TABLE verification_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, target TEXT, code TEXT, purpose TEXT, attempts INTEGER DEFAULT 0, expires_at TEXT, used_at TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE registration_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ip_hash TEXT, ua_hash TEXT, sponsor_id TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT)`)
db.prepare("INSERT INTO users (id,name,role,api_key,email,email_verified) VALUES ('sys_protocol','sys','admin','k_sys',NULL,0)").run()
setSeamDb(db)

let n = 0
const issueCalls: Array<{ userId: string; target: string; purpose: string }> = []
let deliveryConfigured = true
const errorRes = (res: Response, status: number, code: string, msg: string, extra?: Record<string, unknown>) =>
  res.status(status).json({ error: msg, error_code: code, ...(extra || {}) })

// 模拟 issueCode:写真实 verification_codes 行(用一个可预测的固定码),便于后续 /register 校验。
const FIXED_CODE = '424242'
const issueCode = async (userId: string, channel: string, target: string, purpose: string) => {
  issueCalls.push({ userId, target, purpose })
  if (!deliveryConfigured) return { ok: false as const, status: 503, error_code: 'EMAIL_DELIVERY_NOT_CONFIGURED', error: 'x' }
  db.prepare("INSERT INTO verification_codes (id,user_id,channel,target,code,purpose,expires_at) VALUES (?,?,?,?,?,?,datetime('now','+10 minutes'))")
    .run('vc_' + (++n), userId, channel, target, FIXED_CODE, purpose)
  return { ok: true as const, code: FIXED_CODE, expires_at: '', provider: 'dev_console' as const }
}
const findActiveCode = (channel: string, target: string, purpose: string) =>
  db.prepare("SELECT * FROM verification_codes WHERE channel=? AND target=? AND purpose=? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(channel, target, purpose)

let server: Server, port = 0
const post = (path: string, body: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = JSON.stringify(body)
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.write(p); r.end()
})
const userByEmail = (e: string) => db.prepare("SELECT id, email, email_verified FROM users WHERE lower(email)=?").get(e.toLowerCase()) as any
const codeUsed = (target: string) => !!(db.prepare("SELECT used_at u FROM verification_codes WHERE target=? ORDER BY id DESC LIMIT 1").get(target) as any)?.u

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerAuthRegisterRoutes(app, {
    db, errorRes, INTERNAL_AUDITOR_ID: 'usr_iaudit_001',
    isAllowedSponsor: () => true,
    resolveUserRef: () => null,
    resolveInviteCodeRef: () => null,
    generateId: (p: string) => `${p}_${++n}_${Date.now()}`,
    generateSecureKey: (p: string) => `${p}_secret_${++n}`,
    generatePermanentCode: () => `PC${++n}`,
    deriveHandle: (nm: string) => nm.toLowerCase().replace(/\s+/g, ''),
    clientIpHash: () => 'iphash', clientUaHash: () => 'uahash',
    VALID_REGIONS: new Set(['china', 'us', 'global']),
    pickPreferredSide: () => 'left',
    joinPowerLeg: () => ({ tail: 't', depth: 1 }),
    INVITE_ROTATION_HANDLES: [],
    inviteRotationLookup: () => null,
    issueCode: issueCode as any, findActiveCode,
    canDeliverCodes: () => deliveryConfigured,
    emailDeliveryNotConfigured: () => ({ ok: false, status: 503, error_code: 'EMAIL_DELIVERY_NOT_CONFIGURED', error: '邮件投递未配置' }) as any,
    CODE_TTL_MIN: 10, MAX_CODE_ATTEMPTS: 5,
    recordSession: () => {}, broadcastSystemEvent: () => {},
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) send-code:投递未配置 → 503
  deliveryConfigured = false
  { const r = await post('/api/register/send-code', { email: 'alice@example.com' })
    ok('send-code: delivery not configured → 503', r.status === 503 && r.json?.error_code === 'EMAIL_DELIVERY_NOT_CONFIGURED', JSON.stringify(r.json)) }
  deliveryConfigured = true

  // 2) send-code:无效邮箱 → 400
  { const r = await post('/api/register/send-code', { email: 'not-an-email' })
    ok('send-code: invalid email → 400', r.status === 400 && r.json?.error_code === 'EMAIL_INVALID') }

  // 3) send-code:有效 → 发码(issueCode 被调用,user_id 为空注册占位)
  { issueCalls.length = 0
    const r = await post('/api/register/send-code', { email: 'alice@example.com' })
    ok('send-code: ok → success + code issued for register', r.json?.success === true && issueCalls.some(c => c.target === 'alice@example.com' && c.purpose === 'register' && c.userId === ''), JSON.stringify([r.json, issueCalls])) }

  // 4) register:缺 code → EMAIL_VERIFICATION_REQUIRED,不建号
  { const r = await post('/api/register', { name: 'Alice', role: 'buyer', region: 'china', email: 'alice@example.com' })
    ok('register: missing code → EMAIL_VERIFICATION_REQUIRED', r.json?.error_code === 'EMAIL_VERIFICATION_REQUIRED')
    ok('register: no user created on missing code', !userByEmail('alice@example.com')) }

  // 5) register:错码 → CODE_INVALID,不建号
  { const r = await post('/api/register', { name: 'Alice', role: 'buyer', region: 'china', email: 'alice@example.com', code: '000000' })
    ok('register: wrong code → CODE_INVALID', r.json?.error_code === 'CODE_INVALID', JSON.stringify(r.json))
    ok('register: no user created on wrong code', !userByEmail('alice@example.com')) }

  // 6) register:有效码 → 建号 + email_verified=1 + 码被消费 + 响应回 email
  { const r = await post('/api/register', { name: 'Alice', role: 'buyer', region: 'china', email: 'alice@example.com', code: FIXED_CODE })
    ok('register: valid → success + email + email_verified', r.json?.success === true && r.json?.email === 'alice@example.com' && r.json?.email_verified === true, JSON.stringify(r.json))
    const u = userByEmail('alice@example.com')
    ok('register: user row has email_verified=1', !!u && Number(u.email_verified) === 1)
    ok('register: register code consumed (single-use)', codeUsed('alice@example.com')) }

  // 7) 重复已验证邮箱 → send-code 409 + register 409
  { const r1 = await post('/api/register/send-code', { email: 'alice@example.com' })
    ok('send-code: duplicate verified email → 409 EMAIL_TAKEN', r1.status === 409 && r1.json?.error_code === 'EMAIL_TAKEN')
    // 给第二个邮箱发码,但注册时冒用已占用邮箱(直接构造场景:bob 拿到自己邮箱的码,却用 alice 邮箱注册被占用拦截)
    await post('/api/register/send-code', { email: 'bob@example.com' })
    const r2 = await post('/api/register', { name: 'Bob', role: 'buyer', region: 'us', email: 'alice@example.com', code: FIXED_CODE })
    ok('register: duplicate verified email → 409 EMAIL_TAKEN', r2.status === 409 && r2.json?.error_code === 'EMAIL_TAKEN', JSON.stringify(r2.json)) }

  // 8) 不同邮箱正常注册第二个账号
  { const r = await post('/api/register', { name: 'Bob', role: 'seller', region: 'us', email: 'bob@example.com', code: FIXED_CODE })
    ok('register: second distinct verified email → success', r.json?.success === true && r.json?.email === 'bob@example.com', JSON.stringify(r.json)) }

  // 9) invite gate (#420 pre-registration hardening): when system_state require_ref_to_register=1, a
  //    verified email + valid code is NOT sufficient — registration without an invite (sponsor_id) is
  //    refused 403 INVITE_REQUIRED and no user is created; the email-verification gate still runs first
  //    (no silent bypass); with an invite present the gate passes. Locks the invite-only constraint against
  //    accidental bypass / refactor regression (the branch was previously untested).
  db.prepare("INSERT OR REPLACE INTO system_state (key,value) VALUES ('require_ref_to_register','1')").run()
  { // 9a: require_ref=1 + verified code, NO invite → 403 INVITE_REQUIRED, no user created
    await post('/api/register/send-code', { email: 'carol@example.com' })
    const r = await post('/api/register', { name: 'Carol', role: 'buyer', region: 'china', email: 'carol@example.com', code: FIXED_CODE })
    ok('invite gate: require_ref=1 + verified code + no sponsor → 403 INVITE_REQUIRED', r.status === 403 && r.json?.error_code === 'INVITE_REQUIRED', JSON.stringify(r.json))
    ok('invite gate: no user created when invite missing', !userByEmail('carol@example.com')) }
  { // 9b: email-verification gate still composes first (no code → email error, NOT a silent invite bypass)
    const r = await post('/api/register', { name: 'Dave', role: 'buyer', region: 'china', email: 'dave@example.com' })
    ok('invite gate: email verification still enforced first (no code → not bypassed)', r.json?.error_code === 'EMAIL_VERIFICATION_REQUIRED' || r.json?.error_code === 'CODE_EXPIRED', JSON.stringify(r.json))
    ok('invite gate: no user created without code', !userByEmail('dave@example.com')) }
  { // 9c: require_ref=1 + verified code + invite present → gate passes (not INVITE_REQUIRED)
    await post('/api/register/send-code', { email: 'erin@example.com' })
    const r = await post('/api/register', { name: 'Erin', role: 'buyer', region: 'china', email: 'erin@example.com', code: FIXED_CODE, sponsor_id: 'INVITE_X' })
    ok('invite gate: with sponsor_id present → gate passes (not INVITE_REQUIRED)', r.json?.error_code !== 'INVITE_REQUIRED', JSON.stringify(r.json)) }
  db.prepare("DELETE FROM system_state WHERE key='require_ref_to_register'").run()

  server.close()

  if (fail === 0) {
    console.log(`\n✅ register email-verify: send-code 投递闸门/查重/发码;register 强制 email+code,错码不建号,有效码 → email_verified=1 + 单次消费;重复邮箱 409;invite gate(require_ref=1 → 无邀请 403 INVITE_REQUIRED + 不建号,email 验证仍先于邀请,有邀请放行);agent 路径不受影响\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ register email-verify FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
