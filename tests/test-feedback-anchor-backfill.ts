// RFC-004 体验补:无锚点受理 → credit_pending_anchor=1(不记分);绑 Passkey → 追溯补发;幂等。
import Database from 'better-sqlite3'
import { initBuildFeedbackSchema, submitBuildFeedback, adminUpdateBuildFeedback, listMyBuildFeedback, grantPendingAnchorCredits } from '../src/layer2-business/L2-8-feedback/build-feedback-engine.js'
import { initBuildReputationSchema } from '../src/layer2-business/L2-9-contribution/build-reputation-engine.js'

const db = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
         CREATE TABLE webauthn_credentials (id TEXT, user_id TEXT);`)
db.prepare("INSERT INTO users VALUES ('usr_noanchor','N'),('usr_maint','M')").run()
initBuildFeedbackSchema(db); initBuildReputationSchema(db)

let pass = 0, fail = 0
const ok = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, JSON.stringify(h)) } }
const bp = () => (db.prepare(`SELECT build_points FROM build_reputation WHERE user_id='usr_noanchor'`).get() as any)?.build_points || 0
const fbRow = (id: string) => db.prepare('SELECT credited_points,credit_pending_anchor FROM build_feedback WHERE id=?').get(id) as any

// 无锚点提交者: 受理 → 跳过记功 + 标记待补发
const fb = submitBuildFeedback(db, { userId: 'usr_noanchor', type: 'proposal', area: 'governance', body: '[anchor] proposal' }) as any
const r1 = adminUpdateBuildFeedback(db, { id: fb.id, status: 'resolved', credit: true, adminId: 'usr_maint' }) as any
ok('受理跳过记功(credit_skipped_no_anchor)', r1.credit_skipped_no_anchor === true, r1)
ok('credited=0 且 credit_pending_anchor=1', fbRow(fb.id).credited_points === 0 && fbRow(fb.id).credit_pending_anchor === 1, fbRow(fb.id))
ok('build_points 仍 0', bp() === 0)
ok('提交者视图可见 credit_pending_anchor(供前端引导)', (listMyBuildFeedback(db, 'usr_noanchor')[0] as any).credit_pending_anchor === 1)

// 事后绑 Passkey → 追溯补发
db.prepare("INSERT INTO webauthn_credentials VALUES ('cred1','usr_noanchor')").run()
const g = grantPendingAnchorCredits(db, 'usr_noanchor')
ok('补发 granted=1', g.granted === 1, g)
ok('credited>0 且 pending 清零', fbRow(fb.id).credited_points > 0 && fbRow(fb.id).credit_pending_anchor === 0, fbRow(fb.id))
ok('build_points 已发放', bp() > 0, bp())

// 幂等
ok('再扫 granted=0(无 pending)', grantPendingAnchorCredits(db, 'usr_noanchor').granted === 0)
const before = bp(); db.prepare("INSERT INTO webauthn_credentials VALUES ('cred2','usr_noanchor')").run()
grantPendingAnchorCredits(db, 'usr_noanchor')
ok('多设备绑定不重复加分', bp() === before, { before, after: bp() })

// 无锚点用户 grant 不动
const fb2 = submitBuildFeedback(db, { userId: 'usr_maint', type: 'proposal', body: 'x' }) as any
adminUpdateBuildFeedback(db, { id: fb2.id, status: 'resolved', credit: true, adminId: 'usr_maint' })
ok('无锚点用户 grant granted=0', grantPendingAnchorCredits(db, 'usr_maint').granted === 0)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
