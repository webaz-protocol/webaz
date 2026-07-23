#!/usr/bin/env tsx
/**
 * P2-E 信誉单一真相源收敛 —— 回归锁。
 *   背景:users.reputation 列自建号静止(默认 100,全仓零写点),但曾被 verifier/arbitrator 资格门
 *   ('reputation ≥ 110/300')与 profile/公开主页/admin 面板消费 —— 真实台账在 reputation_scores.total_points
 *   (事件流维护+衰减)。潜伏失守:违约累累(真值 0)的账号在静止列眼里永远是 100。
 *   本测试锁:① 资格门读真值(静止列被彻底无视);② 三个展示面读真值;③ item 键集/门槛不变(前端契约);
 *   ④ 源码级:废弃列不再被任何被改文件读取。
 * Usage: npm run test:reputation-single-source
 */
import { mkdtempSync, readFileSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'repss-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initReputationSchema } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { checkVerifierEligibility, checkArbitratorEligibility, liveReputationPoints } = await import('../src/pwa/eligibility.js')
const { registerMeDataRoutes } = await import('../src/pwa/routes/me-data.js')
const { registerUsersPublicRoutes } = await import('../src/pwa/routes/users-public.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initReputationSchema(db); initDisputeSchema(db)
db.prepare("CREATE TABLE IF NOT EXISTS user_moderation (user_id TEXT PRIMARY KEY)").run()
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0') } catch { /* 已有 */ }
try { db.exec('ALTER TABLE orders ADD COLUMN payment_rail TEXT') } catch { /* 已有 */ }
db.exec('CREATE TABLE IF NOT EXISTS return_requests (id TEXT PRIMARY KEY, order_id TEXT, status TEXT, refund_amount REAL)')   // genuineSalePredicate 依赖
for (const c of ['handle TEXT', 'email TEXT', 'search_anchor TEXT', 'permanent_code TEXT', 'region TEXT', 'bio TEXT', 'phone TEXT', 'feed_visible INTEGER']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${c}`) } catch { /* 已有 */ } }
// /api/users/:user_id 聚合面依赖表(计数类,空表即可)
db.exec(`CREATE TABLE IF NOT EXISTS follows (follower_id TEXT, followee_id TEXT);
  CREATE TABLE IF NOT EXISTS shareables (id TEXT PRIMARY KEY, owner_id TEXT, like_count INTEGER DEFAULT 0, status TEXT);
  CREATE TABLE IF NOT EXISTS agent_reputation (user_id TEXT, level TEXT, trust_score REAL);
  CREATE TABLE IF NOT EXISTS charity_reputation (user_id TEXT PRIMARY KEY, prestige_score REAL, badge_tier TEXT, wishes_fulfilled INTEGER, wishes_made INTEGER)`)
// 两个账号:users.reputation 静止列都保持默认(或手动置 100);真值只给 usr_real
const mk = (id: string): void => {
  db.prepare("INSERT INTO users (id,name,role,api_key,created_at) VALUES (?,?,'buyer',?,datetime('now','-120 days'))").run(id, 'N_' + id, 'k_' + id)
  db.prepare('UPDATE users SET reputation = 100, email_verified = 1 WHERE id = ?').run(id)   // 静止列:两者相同,证明它不参与判定
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 9999)').run(id)
}
mk('usr_real'); mk('usr_zero')
db.prepare("INSERT INTO reputation_scores (user_id, total_points, transactions_done, disputes_won, disputes_lost, violations, level) VALUES ('usr_real', 350, 60, 0, 0, 0, 'trusted')").run()
// usr_zero:无 reputation_scores 行 → 真值 0

// ═══ ① 资格门读真值 ═══
{
  ok('1a. liveReputationPoints:有行=真值/无行=0', liveReputationPoints(db, 'usr_real') === 350 && liveReputationPoints(db, 'usr_zero') === 0)
  const arbReal = checkArbitratorEligibility(db, 'usr_real')
  const repItemReal = arbReal.items.find(i => i.key === 'reputation')!
  ok('1b. arbitrator 门:真值 350 ≥ 300 → ok', repItemReal.ok === true && repItemReal.current === 350, JSON.stringify(repItemReal))
  const arbZero = checkArbitratorEligibility(db, 'usr_zero')
  const repItemZero = arbZero.items.find(i => i.key === 'reputation')!
  ok('1c. arbitrator 门:静止列 100 被无视,真值 0 → fail', repItemZero.ok === false && repItemZero.current === 0, JSON.stringify(repItemZero))
  const verReal = checkVerifierEligibility(db, 'usr_real')
  const vRepReal = verReal.items.find(i => i.key === 'reputation')!
  ok('1d. verifier 门:真值 350 ≥ 110 → ok', vRepReal.ok === true)
  const vRepZero = checkVerifierEligibility(db, 'usr_zero').items.find(i => i.key === 'reputation')!
  ok('1e. verifier 门:真值 0 < 110 → fail(静止列 100 本可通过——失守面已封)', vRepZero.ok === false && vRepZero.current === 0)
}

// ═══ ② item 键集/门槛不变(前端契约)═══
{
  const keys = checkArbitratorEligibility(db, 'usr_real').items.map(i => i.key)
  ok('2a. arbitrator item 键集不变', JSON.stringify(keys) === JSON.stringify(['age', 'email', 'orders', 'no_violations', 'never_suspended', 'balance', 'reputation']), JSON.stringify(keys))
  const req = Object.fromEntries(checkArbitratorEligibility(db, 'usr_real').items.map(i => [i.key, i.required]))
  ok('2b. arbitrator 门槛不变(90d/50单/500余额/300信誉)', req.age === 90 && req.orders === 50 && req.balance === 500 && req.reputation === 300)
  const vreq = Object.fromEntries(checkVerifierEligibility(db, 'usr_real').items.map(i => [i.key, i.required]))
  ok('2c. verifier 门槛不变(60d/20单/200余额/110信誉)', vreq.age === 60 && vreq.orders === 20 && vreq.balance === 200 && vreq.reputation === 110)
}

// ═══ ③ 展示面读真值(me-data profile + 公开主页)═══
{
  const app = express(); app.use(express.json())
  const authStub = (req: Request, res: Response): Record<string, unknown> | null => {
    const uid = req.headers['x-test-uid'] as string | undefined
    if (!uid) { res.status(401).json({ error: 'login' }); return null }
    return { id: uid, role: 'buyer' }
  }
  registerMeDataRoutes(app, { db, auth: authStub } as never)
  registerUsersPublicRoutes(app, { db, auth: authStub, noteAuthenticityBadges: () => [] } as never)
  let server!: Server
  const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as { port: number }).port)) })
  const get = (path: string, uid: string): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers: { 'x-test-uid': uid } }, res => { let d = ''; res.on('data', ch => d += ch); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: d ? JSON.parse(d) : {} }) } catch { resolve({ status: res.statusCode || 0, json: {} }) } }) })
    rq.on('error', reject); rq.end()
  })
  try {
    const me = await get('/api/me/export', 'usr_real')
    const prof = (me.json as { profile?: { reputation?: number } }).profile
    ok('3a. me export profile.reputation = 真值 350(非静止 100)', me.status === 200 && prof?.reputation === 350, JSON.stringify({ status: me.status, prof }))
    const me0 = await get('/api/me/export', 'usr_zero')
    ok('3b. 无台账行 → profile.reputation = 0', (me0.json as { profile?: { reputation?: number } }).profile?.reputation === 0)
    const pub = await get('/api/users/usr_real', 'usr_zero')
    const badge = (pub.json as { badges?: { commercial?: { score?: number; tier?: number } } }).badges?.commercial
    ok('3c. 公开主页徽章墙用真值(score=350 → tier 4 专家,静止列的假"资深"已消)', pub.status === 200 && badge?.score === 350 && badge?.tier === 4, JSON.stringify({ status: pub.status, badge }))
  } finally { server.close() }
}

// ═══ ④ 源码级:被改文件不再读静止列 ═══
{
  const EL = readFileSync('src/pwa/eligibility.ts', 'utf8')
  ok('4a. eligibility.ts 不读 users.reputation(SELECT 单行无 reputation 列)', !/SELECT[^\n]*\breputation\b[^\n]*FROM users/.test(EL) && EL.includes('reputation_scores'))
  const SV = readFileSync('src/pwa/server.ts', 'utf8')
  ok('4b. server.ts 资格闭包已成薄壳(委托 eligibility.ts)', SV.includes('checkVerifierEligibilityImpl(db, userId)') && SV.includes('checkArbitratorEligibilityImpl(db, userId)'))
  for (const f of ['src/pwa/routes/me-data.ts', 'src/pwa/routes/users-public.ts']) {
    const s = readFileSync(f, 'utf8')
    ok(`4c. ${f} 用 reputation_scores JOIN`, s.includes('LEFT JOIN reputation_scores'))
  }
}

if (fail > 0) { console.error(`\n❌ reputation-single-source FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ reputation single source(P2-E):资格门/三展示面全读 reputation_scores.total_points,静止列 users.reputation 彻底废弃;item 契约与门槛不变\n  ✅ pass ${pass}`)
