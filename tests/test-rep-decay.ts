import Database from 'better-sqlite3'
import { initReputationSchema, applyDecayIfDue, recordRepEvent } from '../src/layer4-economics/L4-3-reputation/reputation-engine.js'

// 用临时 in-memory DB（避免污染主库）
const db = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT)`)
initReputationSchema(db)

// 测试集
let pass = 0, fail = 0
function expect(name: string, cond: boolean, hint?: string) {
  if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗', name, hint || '') }
}

// 准备：4 个卖家
const sellers = [
  { id: 'u1', pts: 5000, level: 'legend'  },  // 衰减后 4900 — 仍 legend
  { id: 'u2', pts: 2000, level: 'star'    },  // 衰减后 1960 — 仍 star（hysteresis 保护 1850 阈值）
  { id: 'u3', pts:  200, level: 'trusted' },  // 衰减后 196 — 仍 trusted
  { id: 'u4', pts:    0, level: 'new'     },  // 0 分跳过
]
for (const s of sellers) {
  db.prepare(`INSERT INTO users (id, role) VALUES (?, 'seller')`).run(s.id)
  db.prepare(`INSERT INTO reputation_scores (user_id, total_points, level) VALUES (?, ?, ?)`).run(s.id, s.pts, s.level)
}

// 1. 首次衰减（last_decay_at 全 NULL）
const r1 = applyDecayIfDue(db)
expect('首次衰减触发', r1.applied === true, JSON.stringify(r1))
expect('影响 3 个非零卖家', r1.affected === 3, `affected=${r1.affected}`)
expect('rate 0.02', r1.rate === 0.02)

const after = db.prepare(`SELECT user_id, total_points, level FROM reputation_scores ORDER BY user_id`).all() as Array<{ user_id: string; total_points: number; level: string }>
expect('u1 5000 -> 4900', after[0].total_points === 4900, JSON.stringify(after[0]))
expect('u1 仍 legend (4900 > 4750)', after[0].level === 'legend')
expect('u2 2000 -> 1960', after[1].total_points === 1960)
expect('u2 仍 star (1960 > 1850)', after[1].level === 'star')
expect('u3 200 -> 196', after[2].total_points === 196)
expect('u3 仍 trusted (196 > 150)', after[2].level === 'trusted')
expect('u4 仍 0', after[3].total_points === 0)

// 2. 立刻再次调用 — 应跳过（last_decay_at < 25 天）
const r2 = applyDecayIfDue(db)
expect('25 天内幂等跳过', r2.applied === false, r2.reason)

// 3. force=true 强制再衰减
const r3 = applyDecayIfDue(db, { force: true })
expect('force=true 强制执行', r3.applied === true && r3.affected === 3)
const u1again = db.prepare(`SELECT total_points FROM reputation_scores WHERE user_id='u1'`).get() as { total_points: number }
expect('u1 4900 -> 4802 (二次衰减)', u1again.total_points === Math.floor(4900 * 0.98), `got ${u1again.total_points}`)

// 4. 长期衰减导致掉级测试
// 100 分的 trusted 卖家（hypothetical）— 经多次衰减后应该最终掉到 new
db.prepare(`INSERT INTO users (id, role) VALUES ('u5', 'seller')`).run()
db.prepare(`INSERT INTO reputation_scores (user_id, total_points, level) VALUES ('u5', 200, 'trusted')`).run()
// 模拟 36 个月衰减
for (let i = 0; i < 36; i++) applyDecayIfDue(db, { force: true })
const u5 = db.prepare(`SELECT total_points, level FROM reputation_scores WHERE user_id='u5'`).get() as { total_points: number; level: string }
// 200 * 0.98^36 ≈ 96，Math.floor 每轮额外损耗，实测约 85-100
expect('u5 36 月后 ≤ 105 分', u5.total_points >= 80 && u5.total_points <= 105, `pts=${u5.total_points}`)
expect('u5 已降级到 new (跌破 150)', u5.level === 'new', `level=${u5.level}`)

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
