import Database from 'better-sqlite3'
import {
  initSnfSchema, snfSend, snfPullInbox, snfPendingCount,
  snfVerify, snfDesignate, snfGetDesignation, snfCleanup,
  snfNack, snfListDeadLetter, snfRevive, SNF_MAX_RETRIES,
} from '../src/layer2-business/L2-7-snf/snf-engine.js'

const db = new Database(':memory:')
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, role TEXT)`)
initSnfSchema(db)
db.prepare(`INSERT INTO users VALUES ('alice', 'KEY_ALICE', 'buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('bob',   'KEY_BOB',   'seller')`).run()
db.prepare(`INSERT INTO users VALUES ('eve',   'KEY_EVE',   'buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('arbi',  'KEY_ARBI',  'arbitrator')`).run()

let pass = 0, fail = 0
const expect = (name: string, cond: boolean, hint?: unknown) => {
  if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗', name, hint !== undefined ? JSON.stringify(hint) : '') }
}

// 1. 基础发送 + 拉取
const m1 = snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'chat', payload: { text: 'hello' } })
expect('send returns id + signature', !!m1.id && !!m1.signature)
expect('pending=1', snfPendingCount(db, 'bob') === 1)
const inbox1 = snfPullInbox(db, 'bob')
expect('inbox 拿到 1 条', inbox1.length === 1 && inbox1[0].payload.text === 'hello')
expect('pull 后 pending=0', snfPendingCount(db, 'bob') === 0)
const inbox1b = snfPullInbox(db, 'bob')
expect('再次 pull 同一条不返回（幂等）', inbox1b.length === 0)

// 2. 多条 + 优先级
snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'chat', payload: { text: 'normal-1' } })
snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'dispute_evidence', payload: { text: 'urgent' }, priority: 1 })
snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'chat', payload: { text: 'normal-2' } })
const inbox2 = snfPullInbox(db, 'bob')
expect('3 条都拿到', inbox2.length === 3)
expect('高优先级排在第一', inbox2[0].message_type === 'dispute_evidence', inbox2.map(m => m.message_type))

// 3. self-send 拒绝
let caught = ''
try { snfSend(db, { senderId: 'alice', recipientId: 'alice', messageType: 'chat', payload: { text: 'self' } }) } catch (e) { caught = (e as Error).message }
expect('self-send disallow', caught === 'snf_self_send_disallowed')

// 4. recipient 不存在
let caught2 = ''
try { snfSend(db, { senderId: 'alice', recipientId: 'ghost', messageType: 'chat', payload: { text: 'x' } }) } catch (e) { caught2 = (e as Error).message }
expect('recipient_not_found', caught2 === 'snf_recipient_not_found')

// 5. 签名验证 — 完整链路
const m5 = snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'chat', payload: { text: 'signed-1' } })
const v5 = snfVerify(db, m5.id)
expect('签名验证通过', v5.ok === true, v5)

// 6. 篡改 payload → 验证失败
db.prepare(`UPDATE snf_messages SET payload='{"text":"hacked"}' WHERE id=?`).run(m5.id)
const v6 = snfVerify(db, m5.id)
expect('payload 篡改 → signature_mismatch', !v6.ok && v6.reason === 'signature_mismatch', v6)

// 7. api_key 轮换后旧签名验证不过
const m7 = snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'chat', payload: { text: 'rot-test' } })
db.prepare(`UPDATE users SET api_key='NEW_KEY_ALICE' WHERE id='alice'`).run()
const v7 = snfVerify(db, m7.id)
expect('key 轮换 → 签名失效', !v7.ok && v7.reason === 'signature_mismatch')
// 还原
db.prepare(`UPDATE users SET api_key='KEY_ALICE' WHERE id='alice'`).run()

// 8. designation
snfDesignate(db, 'bob', ['peer_alice', 'peer_carol'])
expect('designate 写入', snfGetDesignation(db, 'bob').length === 2)
snfDesignate(db, 'bob', ['peer_dan'])
expect('designate 覆盖', snfGetDesignation(db, 'bob').length === 1 && snfGetDesignation(db, 'bob')[0] === 'peer_dan')
snfDesignate(db, 'bob', Array.from({length: 10}, (_, i) => 'p' + i))
expect('designate 上限 5', snfGetDesignation(db, 'bob').length === 5)

// 9. payload 过大拒绝
const huge = 'x'.repeat(40_000)
let caught3 = ''
try { snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'chat', payload: { text: huge } }) } catch (e) { caught3 = (e as Error).message }
expect('payload 过大拒收', caught3 === 'snf_payload_too_large')

// 10. TTL cleanup
const m10 = snfSend(db, { senderId: 'alice', recipientId: 'eve', messageType: 'chat', payload: { text: 'expire-me' }, ttlDays: 0 })
// 手动把 expires_at 设到过去
db.prepare(`UPDATE snf_messages SET expires_at=datetime('now', '-1 hour') WHERE id=?`).run(m10.id)
const cleaned = snfCleanup(db)
expect('cleanup 删过期', cleaned.removed >= 1, cleaned)
expect('过期后 pending=0', snfPendingCount(db, 'eve') === 0)

// 11. 过期消息不出现在 inbox
const m11 = snfSend(db, { senderId: 'alice', recipientId: 'eve', messageType: 'chat', payload: { text: 'will-expire' } })
db.prepare(`UPDATE snf_messages SET expires_at=datetime('now', '-1 minute') WHERE id=?`).run(m11.id)
const expiredInbox = snfPullInbox(db, 'eve')
expect('过期消息不出现在 inbox', expiredInbox.length === 0)

// 12. 回归 ultrareview: ISO 'T' 格式 expires_at（生产实际格式）必须正确识别为未过期
// 之前 SQL 直接 expires_at > datetime('now') 会让 ISO 同日字符串 lex 比较 > 空格格式
const m12 = snfSend(db, { senderId: 'alice', recipientId: 'eve', messageType: 'chat', payload: { text: 'iso-format' } })
const isoFuture = new Date(Date.now() + 60_000).toISOString()   // 1 分钟后 ISO 8601 with T
db.prepare(`UPDATE snf_messages SET expires_at=? WHERE id=?`).run(isoFuture, m12.id)
const isoInbox = snfPullInbox(db, 'eve')
expect('ISO T 格式未过期消息能拉到', isoInbox.length === 1, isoInbox)
// 过去时间的 ISO 格式（包括同日）必须识别为过期
const m13 = snfSend(db, { senderId: 'alice', recipientId: 'eve', messageType: 'chat', payload: { text: 'iso-past' } })
const isoPast = new Date(Date.now() - 60_000).toISOString()
db.prepare(`UPDATE snf_messages SET expires_at=?, delivered_at=NULL WHERE id=?`).run(isoPast, m13.id)
const isoPastInbox = snfPullInbox(db, 'eve')
expect('ISO T 同日已过期不出现', isoPastInbox.length === 0)

// ─── #5 Agent retry + dead-letter 语义 ────────────────────────
// 13. snfNack 回放：处理失败 → delivered_at 清空，下次 pull 再拿到
const m_nack = snfSend(db, { senderId: 'alice', recipientId: 'bob', messageType: 'order_event', payload: { action: 'test' } })
const pulled1 = snfPullInbox(db, 'bob')
expect('nack 测试：第一次 pull 拿到', pulled1.some(m => m.id === m_nack.id))
expect('nack 测试：delivery_attempts=1', pulled1.find(m => m.id === m_nack.id)?.delivery_attempts === 1)
const nack1 = snfNack(db, 'bob', [m_nack.id], 'simulated processing failure')
expect('nack 1 次 → reopened=1, deadLettered=0', nack1.reopened === 1 && nack1.deadLettered === 0)
const pulled2 = snfPullInbox(db, 'bob')
expect('nack 后再 pull 又能拿到', pulled2.some(m => m.id === m_nack.id))
expect('再 pull delivery_attempts=2', pulled2.find(m => m.id === m_nack.id)?.delivery_attempts === 2)
// 验 last_error 持久化
const errRow = db.prepare(`SELECT last_error FROM snf_messages WHERE id=?`).get(m_nack.id) as { last_error: string }
expect('last_error 持久化', errRow.last_error === 'simulated processing failure')

// 14. 累计超 SNF_MAX_RETRIES 自动死信
// 当前 attempts=2 + delivered_at=now（从 pulled2）。snfNack 会先 reopen + 不动 attempts；snfPullInbox 才递增 attempts
// 循环：nack（reopen） → pull（attempts+1） → 重复直到 attempts=5 → nack 触发 dead-letter
for (let i = 0; i < 5; i++) {
  const nr = snfNack(db, 'bob', [m_nack.id], `attempt ${i + 3} fail`)
  if (nr.deadLettered > 0) break  // 已死信
  const p = snfPullInbox(db, 'bob')
  if (!p.some(m => m.id === m_nack.id)) break  // 不在 pull 批次（不会发生 — 没别的人）
}
const dlList = snfListDeadLetter(db, 'bob')
expect('累计达 SNF_MAX_RETRIES (5) → 自动死信', dlList.some(m => m.id === m_nack.id))
const deadRow = db.prepare(`SELECT dead_letter, delivery_attempts FROM snf_messages WHERE id=?`).get(m_nack.id) as { dead_letter: number; delivery_attempts: number }
expect('dead_letter=1', deadRow.dead_letter === 1)
expect('attempts ≥ MAX_RETRIES', deadRow.delivery_attempts >= SNF_MAX_RETRIES)

// 15. 死信不在普通 pull / inbox 出现
const pulledAfterDead = snfPullInbox(db, 'bob')
expect('死信不在 pull 队列', !pulledAfterDead.some(m => m.id === m_nack.id))
const pendingAfterDead = snfPendingCount(db, 'bob')
const pendingTaintless = db.prepare(`SELECT COUNT(*) as n FROM snf_messages WHERE recipient_id='bob' AND delivered_at IS NULL AND dead_letter=0 AND datetime(expires_at) > datetime('now')`).get() as { n: number }
expect('pendingCount 不含死信', pendingAfterDead === pendingTaintless.n)

// 16. snfRevive — 复活死信
const revive1 = snfRevive(db, 'bob', m_nack.id)
expect('snfRevive 成功', revive1.ok === true)
const revivedRow = db.prepare(`SELECT dead_letter, delivery_attempts, last_error, delivered_at FROM snf_messages WHERE id=?`).get(m_nack.id) as { dead_letter: number; delivery_attempts: number; last_error: string | null; delivered_at: string | null }
expect('revive 后 dead_letter=0', revivedRow.dead_letter === 0)
expect('revive 后 attempts=0', revivedRow.delivery_attempts === 0)
expect('revive 后 last_error=null', revivedRow.last_error === null)
expect('revive 后 delivered_at=null（可被重 pull）', revivedRow.delivered_at === null)

// 17. revive 已经不是死信的消息 → not_dead_letter
const revive2 = snfRevive(db, 'bob', m_nack.id)
expect('已 revive 的不能再 revive', revive2.ok === false && revive2.reason === 'not_dead_letter')

// 18. revive 非自己的消息 → not_owner
const eveMsg = snfSend(db, { senderId: 'alice', recipientId: 'eve', messageType: 'chat', payload: { text: 'eve only' } })
db.prepare(`UPDATE snf_messages SET dead_letter=1 WHERE id=?`).run(eveMsg.id)
const revive3 = snfRevive(db, 'bob', eveMsg.id)
expect('revive 别人的死信 → not_owner', revive3.ok === false && revive3.reason === 'not_owner')

// 19. snfNack 空 ids → 0,0
const nackEmpty = snfNack(db, 'bob', [])
expect('nack 空 ids 安全', nackEmpty.reopened === 0 && nackEmpty.deadLettered === 0)

// 20. snfNack 非自己消息 → 忽略（不修改）
const nackOther = snfNack(db, 'bob', [eveMsg.id], 'try to mess with eve')
expect('nack 别人消息 → 跳过', nackOther.reopened === 0 && nackOther.deadLettered === 0)

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
