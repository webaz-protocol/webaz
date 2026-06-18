#!/usr/bin/env tsx
/**
 * Invite-code narrowing — registration sponsor + /i short links accept ONLY a permanent_code.
 *   用法:npm run test:invite-code-narrowing
 *
 * pre-public 去左右码:旧的 -L/-R 侧别后缀仍被接受(向后兼容),但归一化为基础码 —— 不再有 side 选择。
 * Verifies: the dedicated invite resolver accepts ABC123 / abc123, and ABC123-L / ABC123-R normalize to
 * ABC123 (same inviter, side dropped); rejects usr_xxx / @handle / bare handle; /i/CODE and the legacy
 * /i/CODE-L、/i/CODE-R all redirect to /?ref=CODE (no &side param); /i/@handle, /i/handle, /i/usr_xxx → 404;
 * /s/<shareable> emits ?ref=<permanent_code> (backfilling from the owner when owner_code is missing) and
 * NEVER ?ref=usr_xxx; invite_rotation_enabled has no effect on /i; and no link generator anywhere still
 * builds ?ref=${userId} / /i/${userId} or any -L/-R side link.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerShareRedirectsRoutes } from '../src/pwa/routes/share-redirects.js'
import { registerProfilePlacementRoutes } from '../src/pwa/routes/profile-placement.js'
import { registerAuthRegisterRoutes } from '../src/pwa/routes/auth-register.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
const INTERNAL_AUDITOR_ID = 'usr_iaudit_001'
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, handle TEXT, permanent_code TEXT, placement_id TEXT, placement_side TEXT, placement_path TEXT, left_child_id TEXT, right_child_id TEXT, placement_pref TEXT)`)
db.prepare(`INSERT INTO users (id,name,handle,permanent_code) VALUES ('usr_alice','Alice','alice','ABC123'),('usr_bob','Bob','bob','XYZ789'),('usr_nocode','NoCode','nocode',NULL),('usr_new','New','new','NEW123'),('sys_protocol','sys',NULL,'SYS000'),(?,?,?,?)`).run(INTERNAL_AUDITOR_ID, 'aud', 'aud', 'AUD000')
db.exec(`CREATE TABLE shareables (id TEXT PRIMARY KEY, owner_id TEXT, owner_code TEXT, type TEXT, external_url TEXT, related_product_id TEXT, related_anchor TEXT, status TEXT, click_count INTEGER DEFAULT 0, unique_click_count INTEGER DEFAULT 0)`)
db.exec(`CREATE TABLE shareable_click_log (id INTEGER PRIMARY KEY AUTOINCREMENT, shareable_id TEXT, ip_hash TEXT, ua_hash TEXT, ref_path TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.prepare(`INSERT INTO shareables (id,owner_id,owner_code,type,related_product_id,status) VALUES ('sh_code','usr_alice','ABC123','product','prod_1','active')`).run()
db.prepare(`INSERT INTO shareables (id,owner_id,owner_code,type,related_product_id,status) VALUES ('sh_nocode','usr_bob',NULL,'product','prod_2','active')`).run()
db.prepare(`INSERT INTO shareables (id,owner_id,owner_code,type,related_product_id,status) VALUES ('sh_ownerless','usr_nocode',NULL,'product','prod_3','active')`).run()
db.exec(`CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance INTEGER)`)
db.exec(`CREATE TABLE registration_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ip_hash TEXT, ua_hash TEXT, sponsor_id TEXT, created_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT)`)
db.exec(`ALTER TABLE users ADD COLUMN role TEXT`); db.exec(`ALTER TABLE users ADD COLUMN roles TEXT`); db.exec(`ALTER TABLE users ADD COLUMN api_key TEXT`); db.exec(`ALTER TABLE users ADD COLUMN sponsor_id TEXT`); db.exec(`ALTER TABLE users ADD COLUMN sponsor_path TEXT`); db.exec(`ALTER TABLE users ADD COLUMN region TEXT`); db.exec(`ALTER TABLE users ADD COLUMN created_at TEXT`); db.exec(`ALTER TABLE users ADD COLUMN updated_at TEXT`)
// 邮箱验证优先注册:users 需 email/email_verified 列 + verification_codes 表(register 消费注册码)
db.exec(`ALTER TABLE users ADD COLUMN email TEXT`); db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`)
db.exec(`CREATE TABLE verification_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, target TEXT, code TEXT, purpose TEXT, attempts INTEGER DEFAULT 0, expires_at TEXT, used_at TEXT, created_at TEXT DEFAULT (datetime('now')))`)
setSeamDb(db)

// the dedicated resolver — same logic as server.ts resolveInviteCodeRef (the routes are given this).
function resolveInviteCodeRef(raw: string | null | undefined): { userId: string; code: string; side: 'left' | 'right' | null } | null {
  if (!raw || typeof raw !== 'string') return null
  const m = raw.trim().match(/^([A-Za-z0-9]{6,7})(?:-([LRlr]))?$/)
  if (!m) return null
  const code = m[1].toUpperCase()
  const side: 'left' | 'right' | null = m[2] ? (m[2].toLowerCase() === 'l' ? 'left' : 'right') : null
  const r = db.prepare("SELECT id FROM users WHERE permanent_code = ? AND id NOT IN ('sys_protocol', ?) LIMIT 1").get(code, INTERNAL_AUDITOR_ID) as { id: string } | undefined
  return r ? { userId: r.id, code, side } : null
}

const req = (method: string, path: string): Promise<{ status: number; location: string | null; raw: string }> => new Promise((resolve, reject) => {
  const r = httpRequest({ host: '127.0.0.1', port, method, path }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, raw }))
  }); r.on('error', reject); r.end()
})
const postJson = (path: string, body: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.write(payload); r.end()
})
let server: Server, port = 0
let placementThrows = true

async function main(): Promise<void> {
  // ── A) resolver accept/reject matrix ──────────────────────────────────────────────────────────────
  ok('A accepts ABC123', resolveInviteCodeRef('ABC123')?.userId === 'usr_alice')
  ok('A accepts abc123 (case-insensitive → ABC123)', resolveInviteCodeRef('abc123')?.code === 'ABC123')
  // pre-public 去左右码:-L/-R 后缀仍被接受用于解析(向后兼容旧链接),但归一化为基础码 — side 不再是用户选择
  ok('A accepts ABC123-L → usr_alice, normalized to ABC123', resolveInviteCodeRef('ABC123-L')?.userId === 'usr_alice' && resolveInviteCodeRef('ABC123-L')?.code === 'ABC123')
  ok('A accepts ABC123-R → usr_alice, normalized to ABC123', resolveInviteCodeRef('ABC123-R')?.userId === 'usr_alice' && resolveInviteCodeRef('ABC123-R')?.code === 'ABC123')
  ok('A rejects usr_xxx', resolveInviteCodeRef('usr_alice') === null)
  ok('A rejects @handle', resolveInviteCodeRef('@alice') === null)
  ok('A rejects bare handle', resolveInviteCodeRef('alice') === null)
  ok('A rejects unknown code', resolveInviteCodeRef('ZZZ999') === null)
  ok('A excludes sys_protocol / auditor codes', resolveInviteCodeRef('SYS000') === null && resolveInviteCodeRef('AUD000') === null)

  // ── B) /i and /s behavior (real express) ──────────────────────────────────────────────────────────
  const app = express()
  app.use(express.json())
  registerShareRedirectsRoutes(app, {
    db, auth: (() => null) as any,
    clientIpHash: () => 'ip', clientUaHash: () => 'ua',
    resolveInviteCodeRef,
  })
  // bind-placement is a binary-tree binding entry — must reject usr_xxx / @handle / handle too.
  registerProfilePlacementRoutes(app, {
    db, auth: (() => ({ id: 'usr_new' })) as any, internalAuditorId: INTERNAL_AUDITOR_ID,
    resolveUserRef: (() => 'usr_alice') as any,   // backdoor would resolve handle/usr_xxx — must NOT be used
    resolveInviteCodeRef, pickPreferredSide: () => 'left', joinPowerLeg: () => ({ depth: 1 }),
  })
  // register route — to prove placement failure rolls back the whole registration (no orphan, P1).
  let n = 0
  registerAuthRegisterRoutes(app, {
    db, errorRes: ((res: any, status: number, code: string, msg: string, extra: any) => res.status(status).json({ error: msg, error_code: code, ...(extra || {}) })) as any,
    INTERNAL_AUDITOR_ID, isAllowedSponsor: () => true, resolveUserRef: (() => null) as any, resolveInviteCodeRef,
    generateId: ((p: string) => `${p}_t${++n}`) as any, generateSecureKey: ((p: string) => `${p}_k${n}`) as any,
    generatePermanentCode: (() => `PC${1000 + n}`) as any, deriveHandle: ((s: string) => 'h' + n) as any,
    clientIpHash: () => 'ipreg', clientUaHash: () => 'uareg',
    VALID_REGIONS: new Set(['global']) as any, pickPreferredSide: (() => 'left') as any,
    joinPowerLeg: (() => { if (placementThrows) throw new Error('tree corrupt'); return { tail: 't', depth: 1 } }) as any,
    // 邮箱验证优先注册:固定有效码 '111111';consume UPDATE 命中空表(0 行)无碍。
    issueCode: (async () => ({ ok: true, code: '111111', expires_at: '', provider: 'dev_console' })) as any,
    findActiveCode: (() => ({ id: 'vc_fixed', code: '111111', attempts: 0 })) as any,
    canDeliverCodes: () => true,
    emailDeliveryNotConfigured: (() => ({ ok: false, status: 503, error_code: 'EMAIL_DELIVERY_NOT_CONFIGURED', error: 'x' })) as any,
    CODE_TTL_MIN: 10, MAX_CODE_ATTEMPTS: 5,
    recordSession: () => {}, broadcastSystemEvent: () => {},
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  { const r = await req('GET', '/i/ABC123'); ok('B /i/ABC123 → 302 /?ref=ABC123', r.status === 302 && r.location === '/?ref=ABC123', r.location || '') }
  { const r = await req('GET', '/i/abc123'); ok('B /i/abc123 (lower) → /?ref=ABC123', r.location === '/?ref=ABC123', r.location || '') }
  // pre-public 去左右码:旧 -L/-R 链接归一化重定向到 /?ref=CODE(不再带 side)
  { const r = await req('GET', '/i/ABC123-L'); ok('B /i/ABC123-L → /?ref=ABC123 (normalized, no side)', r.location === '/?ref=ABC123', r.location || '') }
  { const r = await req('GET', '/i/ABC123-R'); ok('B /i/ABC123-R → /?ref=ABC123 (normalized, no side)', r.location === '/?ref=ABC123', r.location || '') }
  for (const bad of ['/i/@alice', '/i/alice', '/i/usr_alice', '/i/ZZZ999', '/i/sys_protocol']) {
    const r = await req('GET', bad); ok(`B ${bad} → 404`, r.status === 404, `status=${r.status} loc=${r.location}`)
  }
  // invite_rotation has no bearing on /i (no such flag consulted) — /i/ABC123 still redirects.
  { const r = await req('GET', '/i/ABC123'); ok('B /i still works regardless of invite_rotation', r.status === 302 && r.location === '/?ref=ABC123') }

  // /s with owner_code present → ?ref=CODE
  { const r = await req('GET', '/s/sh_code'); ok('B /s (owner_code present) → ?ref=ABC123, no usr_', r.location?.includes('ref=ABC123') === true && !r.location?.includes('usr_'), r.location || '') }
  // /s with owner_code missing but owner has permanent_code → backfill + ?ref=CODE
  { const r = await req('GET', '/s/sh_nocode'); ok('B /s (owner_code missing, owner has code) → ?ref=XYZ789', r.location?.includes('ref=XYZ789') === true && !r.location?.includes('usr_'), r.location || '')
    const bf = db.prepare("SELECT owner_code FROM shareables WHERE id='sh_nocode'").get() as any
    ok('B /s backfilled owner_code', bf.owner_code === 'XYZ789') }
  // /s where owner has NO permanent_code → NO ref at all (never ?ref=usr_xxx)
  { const r = await req('GET', '/s/sh_ownerless'); ok('B /s (owner has no code) → emits NO ref, never usr_', !r.location?.includes('ref=') && !r.location?.includes('usr_'), r.location || '') }

  // bind-placement (login-after binary-tree bind): reject usr_xxx / @handle / handle; accept CODE / CODE-L/R
  for (const bad of ['usr_alice', '@alice', 'alice']) {
    const r = await postJson('/api/profile/bind-placement', { inviter_id: bad })
    ok(`B bind-placement rejects ${bad}`, typeof r.json?.error === 'string' && r.json.error.includes('邀请码无效'), JSON.stringify(r.json))
  }
  { const r = await postJson('/api/profile/bind-placement', { inviter_id: 'ABC123' }); ok('B bind-placement accepts ABC123 → usr_alice', r.json?.success === true && r.json?.inviter_id === 'usr_alice', JSON.stringify(r.json)) }
  // pre-public 去左右码:bind 时 -L/-R 后缀被忽略,侧别永远由系统自动决定(mock pickPreferredSide='left')
  { const r = await postJson('/api/profile/bind-placement', { inviter_id: 'ABC123-L' }); ok('B bind-placement CODE-L → success, side auto (suffix ignored)', r.json?.success === true && r.json?.side === 'left', JSON.stringify(r.json)) }
  { const r = await postJson('/api/profile/bind-placement', { inviter_id: 'ABC123-R' }); ok('B bind-placement CODE-R → side STILL auto=left (suffix ignored, not right)', r.json?.success === true && r.json?.side === 'left', JSON.stringify(r.json)) }

  // P1: placement failure during registration must roll back the whole tx — no orphan account.
  const cnt = () => ({ u: (db.prepare("SELECT COUNT(*) n FROM users WHERE name='Zoe'").get() as any).n, w: (db.prepare("SELECT COUNT(*) n FROM wallets").get() as any).n, a: (db.prepare("SELECT COUNT(*) n FROM registration_audit_log").get() as any).n })
  { placementThrows = true
    const before = cnt()
    const r = await postJson('/api/register', { name: 'Zoe', role: 'buyer', sponsor_id: 'ABC123', region: 'global', email: 'zoe@example.com', code: '111111' })
    const after = cnt()
    ok('B register w/ failing placement → typed PLACEMENT_FAILED', r.status === 409 && r.json?.error_code === 'PLACEMENT_FAILED', JSON.stringify(r.json))
    ok('B register failure rolled back users/wallet/audit (no orphan)', after.u === before.u && after.w === before.w && after.a === before.a, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`) }
  { placementThrows = false   // control: working placement → registration succeeds + rows land
    const r = await postJson('/api/register', { name: 'Zoe', role: 'buyer', sponsor_id: 'ABC123', region: 'global', email: 'zoe@example.com', code: '111111' })
    ok('B register w/ working placement → success + placed', r.json?.success === true && r.json?.placement?.side === 'left', JSON.stringify(r.json))
    ok('B register success persisted the account', (db.prepare("SELECT COUNT(*) n FROM users WHERE name='Zoe'").get() as any).n === 1) }
  server.close()

  // ── C) static guards: app.js readShareHint narrowed + no usr_xxx link generation anywhere ───────────
  const app_js = read('src/pwa/public/app.js')
  const authReg = read('src/pwa/routes/auth-register.ts')
  ok('C readShareHint refPattern is invite-code-only', /const refPattern\s*=\s*\/\^\[A-Za-z0-9\]\{6,7\}\$\//.test(app_js))
  ok('C share-UI no longer falls back to user_id', !/data\.permanent_code \|\| myId/.test(app_js) && !/permanent_code \|\| state\.user/.test(app_js))
  ok('C readShareHint sanitizes stale non-code hints', /sanitizeHint/.test(app_js) && /okCode/.test(app_js))
  ok('C auth-register uses resolveInviteCodeRef for sponsor (INVALID_SPONSOR_REF)', /resolveInviteCodeRef\(sponsorRawRef\)/.test(authReg) && /INVALID_SPONSOR_REF/.test(authReg))
  ok('C auth-register no longer resolveUserRef the sponsor', !/resolveUserRef\(sponsorRawRef\)/.test(authReg))
  // P1: the order-time first-order sponsor bind resolves sponsor_hint as an invite code (not WHERE id=hint).
  const ordersCreate = read('src/pwa/routes/orders-create.ts')
  ok('C orders-create resolves sponsor_hint via resolveInviteCodeRef', /resolveInviteCodeRef\(sponsorHintRaw\)/.test(ordersCreate) && !/\.get\(sponsorHint, INTERNAL_AUDITOR_ID\)/.test(ordersCreate))
  // P2: bind-placement resolves invite code only (not resolveUserRef)
  const profPlace = read('src/pwa/routes/profile-placement.ts')
  ok('C profile-placement bind uses resolveInviteCodeRef (not resolveUserRef)', /resolveInviteCodeRef\(inviter_id\)/.test(profPlace) && !/resolveUserRef\(inviter_id\)/.test(profPlace))
  // pre-public 去左右码:不再生成 -L/-R 侧链(sharePlatformLink/copyPlacementLink 已移除),且仍不暴露 user_id
  ok('C no -L/-R side-link generation + no state.user.id in placement links', !/placement=\$\{state\.user\.id\}/.test(app_js) && !/\/i\/\$\{code\}-\$\{side/.test(app_js))
  // no link generator emits a raw user id as ?ref / placement / /i (permanent_code only)
  const SRC = ['src/pwa/public/app.js', 'src/pwa/routes/referral.ts', 'src/pwa/routes/promoter.ts', 'src/pwa/routes/share-redirects.ts', 'src/pwa/routes/orders-create.ts', 'src/pwa/routes/profile-placement.ts', 'src/layer1-agent/L1-1-mcp-server/server.ts']
  const BADGEN = /[?&](ref|placement)=\$\{(userId|user_id|myId|user\.id|state\.user\.id|owner_id|id)\}|\/i\/\$\{(userId|myId|user\.id|state\.user\.id|owner_id)\}/
  for (const f of SRC) { const m = read(f).match(BADGEN); ok(`C no usr_xxx link generation in ${f.split('/').pop()}`, !m, m ? m[0] : '') }

  if (fail === 0) {
    console.log(`\n✅ invite-code narrowing: resolver accepts permanent_code [+-L/-R] only (rejects usr_xxx/@handle/handle) · /i redirects + 404s · /s emits permanent_code ref (backfill) never usr_xxx · /i unaffected by invite_rotation · readShareHint narrowed + sanitizes stale hints · no usr_xxx link generation anywhere\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ invite-code narrowing FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
