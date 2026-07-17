#!/usr/bin/env tsx
/**
 * RFC-026 PR-4 — webaz_order_chat(订单上下文聊天)。用法:npm run test:order-chat-grant
 *
 * 真实 route(agent-grants + 真实 chat 路由 + 回环)+ 真 oat_ grant。覆盖:scope 双门(read/send 分立)/
 * 非-grandfathering · 参与方绑定(非本单 404,无自由私信面)· 发送走生产路径(反诈 flag 真实触发)·
 * agent 归因标注(meta.agent = sent_by_agent 等价)· 读投影(you/counterparty,无裸 id)· 幂等防重发 ·
 * 资金/订单状态零变化。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-chat-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { registerChatRoutes } = await import('../src/pwa/routes/chat.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { makeApiLoopback } = await import('../src/pwa/order-loopback.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
try { db.exec('ALTER TABLE messages ADD COLUMN kind TEXT') } catch { /* server boot ALTER */ }
try { db.exec('ALTER TABLE messages ADD COLUMN meta TEXT') } catch { /* server boot ALTER */ }

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer1','B','h_b','buyer','k_b'),('seller1','S','h_s','seller','k_s'),('rando','R','h_r','buyer','k_r')").run()
db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES ('buyer1',100,0,30,0),('seller1',100,0,0,0)").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status) VALUES ('prd_c','seller1','Chat Prod','d',30,'WAZ',5,'x','active')").run()
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address) VALUES ('ord_chat','buyer1','seller1','prd_c','paid',1,30,30,30,'escrow','x')").run()
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address) VALUES ('ord_theirs','rando','seller1','prd_c','paid',1,30,30,30,'escrow','y')").run()

// ── ephemeral app:真实 agent-grants + 真实 chat 路由 + 真回环 ──
const auth = (req: Request, res: Response) => {
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''))
  const row = m ? db.prepare('SELECT * FROM users WHERE api_key = ?').get(m[1]) as Record<string, unknown> | undefined : undefined
  if (!row) { res.status(401).json({ error: 'login' }); return null }
  return row
}
const app = express(); app.use(express.json())
registerChatRoutes(app, { db, auth, generateId, rateLimitOk: () => true, notify: () => {} } as never)
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true, apiLoopback: makeApiLoopback(() => port) } as never)
const server = app.listen(0)
const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const useCred = (g: string, b: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [g]: { token: b, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: g, handle: `file:~/.webaz/credentials#${g}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const mkOAuth = (gid: string, oat: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,NULL,'active',?)")
    .run(gid, 'buyer1', 'OAuth: chat-test', JSON.stringify(caps.map(c => ({ capability: c }))), FUTURE)
  db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
    .run(sha(oat), gid, 'cli_t', 'read chat:context', 'https://webaz.xyz/mcp', FUTURE)
}
mkOAuth('grt_chat', 'oat_chat_full', ['order_chat_read', 'order_chat_send'])
mkOAuth('grt_ro', 'oat_chat_ro', ['order_chat_read'])
mkOAuth('grt_old', 'oat_chat_old', ['read_public', 'buyer_orders_read_minimal'])
const CH = (a: Record<string, unknown>) => (mcp as unknown as { handleOrderChat: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleOrderChat(a)
const msgCount = (): number => (db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c
const balOf = (u: string) => (db.prepare('SELECT balance, escrowed FROM wallets WHERE user_id=?').get(u) as { balance: number; escrowed: number })

try {
  clearCred()
  ok('C-1 no grant → GRANT_REQUIRED', (await CH({ action: 'list', order_id: 'ord_chat' })).error_code === 'GRANT_REQUIRED')
  useCred('grt_old', 'oat_chat_old', ['read_public', 'buyer_orders_read_minimal'])
  ok('C-2 NON-GRANDFATHERING: pre-PR grant lacks order_chat_read → PERMISSION_REQUIRED + hint',
    await CH({ action: 'list', order_id: 'ord_chat' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /order_chat_read/.test(String(r.hint))))
  useCred('grt_ro', 'oat_chat_ro', ['order_chat_read'])
  ok('C-3 read-only chat grant: list OK but send → PERMISSION_REQUIRED (order_chat_send is a SEPARATE capability)',
    await CH({ action: 'list', order_id: 'ord_chat' }).then(r => Array.isArray(r.messages))
    && await CH({ action: 'send', order_id: 'ord_chat', body: 'hi' }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /order_chat_send/.test(String(r.hint))))

  useCred('grt_chat', 'oat_chat_full', ['order_chat_read', 'order_chat_send'])
  const balB = balOf('buyer1')
  const s1 = await CH({ action: 'send', order_id: 'ord_chat', body: 'Hello, when will this ship?', idempotency_key: 'k_hello_1' })
  ok('C-4 send over REAL oat_ → real message row via the PRODUCTION chat path, marked agent-sent', s1.sent === true && typeof s1.message_id === 'string' && s1.sent_by_agent === true && msgCount() === 1, JSON.stringify(s1).slice(0, 200))
  const metaRow = db.prepare('SELECT meta FROM messages WHERE id = ?').get(String(s1.message_id)) as { meta: string | null }
  const agentMeta = JSON.parse(String(metaRow.meta)).agent as Record<string, unknown>
  ok('C-5 agent attribution annotated (grant_id + label + content hash + idempotency key)',
    agentMeta.grant_id === 'grt_chat' && String(agentMeta.label).startsWith('OAuth') && agentMeta.body_sha256 === sha('Hello, when will this ship?') && agentMeta.idempotency_key === 'k_hello_1', JSON.stringify(agentMeta))
  // 幂等:同键重试 → 原消息,零重发
  const s2 = await CH({ action: 'send', order_id: 'ord_chat', body: 'Hello, when will this ship?', idempotency_key: 'k_hello_1' })
  ok('C-6 same idempotency_key → original message returned, NO double send', s2.duplicate === true && s2.message_id === s1.message_id && msgCount() === 1, JSON.stringify(s2))
  // 反诈:生产同路真实触发
  const s3 = await CH({ action: 'send', order_id: 'ord_chat', body: 'add my wechat vx: pay-me-offsite' })
  ok('C-7 anti-scam runs UNCHANGED on the production path (wechat lure → flagged)', s3.sent === true && s3.flagged === true && msgCount() === 2, JSON.stringify(s3).slice(0, 200))
  // 读投影
  const L = await CH({ action: 'list', order_id: 'ord_chat' })
  const msgs = L.messages as Array<Record<string, unknown>>
  ok('C-8 list projection: sender you/counterparty (no raw ids), bodies verbatim, flags + agent marks preserved',
    msgs.length === 2 && msgs.every(m => m.sender === 'you' && m.sent_by_agent === true && String(m.agent_label).startsWith('OAuth'))
    && msgs.some(m => m.flagged === true) && !JSON.stringify(msgs).includes('buyer1') && !JSON.stringify(msgs).includes('seller1'), JSON.stringify(msgs).slice(0, 300))
  // 参与方绑定 = 无自由私信面
  ok('C-9 NOT a party → ORDER_NOT_FOUND on read AND send (no free-DM surface exists)',
    (await CH({ action: 'list', order_id: 'ord_theirs' })).error_code === 'ORDER_NOT_FOUND'
    && (await CH({ action: 'send', order_id: 'ord_theirs', body: 'hi' })).error_code === 'ORDER_NOT_FOUND')
  ok('C-10 unknown order → ORDER_NOT_FOUND; bad action → BAD_ACTION; oversize body → CHAT_BODY_INVALID',
    (await CH({ action: 'list', order_id: 'ord_nope' })).error_code === 'ORDER_NOT_FOUND'
    && (await CH({ action: 'zap', order_id: 'ord_chat' })).error_code === 'BAD_ACTION'
    && (await CH({ action: 'send', order_id: 'ord_chat', body: 'x'.repeat(2001) })).error_code === 'CHAT_BODY_INVALID')
  // ══ Codex round-1 盲区 ══
  // 对手方人类消息:不被标 agent;sender=counterparty
  { const conv = db.prepare("SELECT id FROM conversations WHERE kind='order' AND context_id='ord_chat'").get() as { id: string }
    db.prepare("INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ('m_human', ?, 'seller1', 'human reply from seller')").run(conv.id) }
  ok('C-12 counterparty HUMAN message: sender=counterparty, NOT marked agent', await CH({ action: 'list', order_id: 'ord_chat' }).then(r => {
    const ms = r.messages as Array<Record<string, unknown>>
    const h = ms.find(x => x.body === 'human reply from seller')
    return !!h && h.sender === 'counterparty' && h.sent_by_agent === false && !('agent_label' in h)
  }))
  // 同键不同 body → 显式冲突(不静默吞)
  const cf = await CH({ action: 'send', order_id: 'ord_chat', body: 'DIFFERENT body', idempotency_key: 'k_hello_1' })
  ok('C-13 same key + DIFFERENT body → IDEMPOTENCY_CONFLICT (never silently returns the old message)', cf.error_code === 'IDEMPOTENCY_CONFLICT')
  // 跨 grant 同键 = 独立命名空间
  { db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES ('grt_chat2','buyer1','OAuth: second',?,NULL,'active',?)")
      .run(JSON.stringify(['order_chat_read','order_chat_send'].map(c => ({ capability: c }))), FUTURE)
    db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
      .run(sha('oat_chat_second'), 'grt_chat2', 'cli_t', 'read chat:context', 'https://webaz.xyz/mcp', FUTURE)
    useCred('grt_chat2', 'oat_chat_second', ['order_chat_read','order_chat_send'])
    const s4 = await CH({ action: 'send', order_id: 'ord_chat', body: 'from second agent', idempotency_key: 'k_hello_1' })
    ok('C-14 same key under a DIFFERENT grant = separate namespace (sends normally)', s4.sent === true && typeof s4.message_id === 'string' && s4.message_id !== s1.message_id, JSON.stringify(s4).slice(0, 150))
    useCred('grt_chat', 'oat_chat_full', ['order_chat_read','order_chat_send']) }
  // 并发同键 → 恰一条消息(赢家发出,输家拿 in-flight/duplicate,绝无双发)
  { const before = msgCount()
    const hit = () => CH({ action: 'send', order_id: 'ord_chat', body: 'concurrent once', idempotency_key: 'k_conc_1' })
    const [ra, rb] = await Promise.all([hit(), hit()])
    const sent = [ra, rb].filter(r => r.sent === true)
    const safe = [ra, rb].filter(r => r.duplicate === true || r.error_code === 'SEND_IN_FLIGHT')
    ok('C-15 CONCURRENT same-key sends → exactly ONE message; loser converges to duplicate/in-flight', msgCount() === before + 1 && sent.length === 1 && sent.length + safe.length === 2, JSON.stringify({ ra, rb }).slice(0, 250)) }
  // 屏蔽会话:发送被生产路径拒;读(参与方)仍可见历史 —— 与人类行为一致
  { db.prepare("UPDATE conversations SET status='blocked' WHERE kind='order' AND context_id='ord_chat'").run()
    const sb = await CH({ action: 'send', order_id: 'ord_chat', body: 'should not send' })
    const lb = await CH({ action: 'list', order_id: 'ord_chat' })
    ok('C-16 blocked conversation: send REFUSED by the production route; participant read still sees history (matches human behavior)', sb.error_code === 'CHAT_SEND_REJECTED' && Array.isArray(lb.messages) && (lb.messages as unknown[]).length > 0 && lb.conversation_status === 'blocked', JSON.stringify(sb).slice(0, 120))
    db.prepare("UPDATE conversations SET status='active' WHERE kind='order' AND context_id='ord_chat'").run() }
  // 畸形 meta.agent 不冒充归因
  { db.prepare("UPDATE messages SET meta='{\"agent\":\"junk\"}' WHERE id='m_human'").run()
    const lm = await CH({ action: 'list', order_id: 'ord_chat' })
    const h = (lm.messages as Array<Record<string, unknown>>).find(x => x.body === 'human reply from seller')
    ok('C-17 malformed meta.agent (wrong shape) is NOT presented as agent attribution', !!h && h.sent_by_agent === false) }
  // 并发 stale 回收:恰一胜者(owner-CAS)
  { db.prepare("INSERT INTO agent_chat_idem (grant_id, idem_key, body_sha, owner, message_id, created_at) VALUES ('grt_chat','k_stale', ?, 'dead_owner', NULL, datetime('now','-20 minutes'))").run(sha('stale body once'))
    const before = msgCount()
    const hit = () => CH({ action: 'send', order_id: 'ord_chat', body: 'stale body once', idempotency_key: 'k_stale' })
    const [ra, rb] = await Promise.all([hit(), hit()])
    const sent = [ra, rb].filter(r => r.sent === true)
    ok('C-19 CONCURRENT stale reclamation → exactly ONE reclaims and sends (owner-CAS); loser gets in-flight/duplicate', msgCount() === before + 1 && sent.length === 1, JSON.stringify({ ra, rb }).slice(0, 250)) }
  // 干净失败立即释放键(不毒 10 分钟)
  { db.prepare("UPDATE conversations SET status='blocked' WHERE kind='order' AND context_id='ord_chat'").run()
    const f1 = await CH({ action: 'send', order_id: 'ord_chat', body: 'poison probe', idempotency_key: 'k_poison' })
    db.prepare("UPDATE conversations SET status='active' WHERE kind='order' AND context_id='ord_chat'").run()
    const f2 = await CH({ action: 'send', order_id: 'ord_chat', body: 'poison probe', idempotency_key: 'k_poison' })
    ok('C-20 clean failure RELEASES the key immediately — instant retry succeeds (no 10min poisoning)', f1.error_code === 'CHAT_SEND_REJECTED' && f2.sent === true, JSON.stringify({ f1, f2 }).slice(0, 200)) }
  // 人类徽标源码 shape 守卫:必须同时要求 grant_id + body_sha256
  { const APP = (await import('node:fs')).readFileSync('src/pwa/public/app.js', 'utf8')
    ok('C-21 human badge requires grant_id AND body_sha256 (junk meta stays badge-less)', /typeof _a\.grant_id === 'string' && typeof _a\.body_sha256 === 'string'/.test(APP)) }
  // 资金/订单零变化
  ok('C-18 chat moves NO funds and changes NO order state', Math.abs(balOf('buyer1').balance - balB.balance) < 1e-9 && Math.abs(balOf('buyer1').escrowed - balB.escrowed) < 1e-9
    && (db.prepare("SELECT status FROM orders WHERE id='ord_chat'").get() as { status: string }).status === 'paid')
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ order-chat-grant FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order-chat-grant: 上下文聊天 — read/send 双门 · 参与方绑定无私信面 · 生产反诈同路 · agent 归因 · 幂等防重发 · 零资金\n  ✅ pass ${pass}`)
