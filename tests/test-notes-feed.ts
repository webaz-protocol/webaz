// Phase D 笔记 feed/list API 单测：sort + cursor + following + 转发链识别
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT, name TEXT, region TEXT, permanent_code TEXT);
  CREATE TABLE follows (follower_id TEXT, followee_id TEXT, PRIMARY KEY (follower_id, followee_id));
  CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, price REAL);
  CREATE TABLE shareables (
    id TEXT PRIMARY KEY, owner_id TEXT, owner_code TEXT, type TEXT, status TEXT DEFAULT 'active',
    title TEXT, native_text TEXT, photo_hashes TEXT,
    related_product_id TEXT, parent_id TEXT,
    click_count INTEGER DEFAULT 0, like_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`)
db.prepare(`INSERT INTO users VALUES ('u1','u1','买家1','global','PC_U1')`).run()
db.prepare(`INSERT INTO users VALUES ('u2','u2','买家2','global','PC_U2')`).run()
db.prepare(`INSERT INTO users VALUES ('u3','u3','买家3','global','PC_U3')`).run()
db.prepare(`INSERT INTO products VALUES ('prd_a','商品A',99)`).run()
db.prepare(`INSERT INTO follows VALUES ('u3','u1')`).run()  // u3 关注 u1
db.prepare(`INSERT INTO follows VALUES ('u3','u2')`).run()  // u3 关注 u2

const insNote = db.prepare(`INSERT INTO shareables (id, owner_id, owner_code, type, title, native_text, photo_hashes, related_product_id, parent_id, click_count, like_count, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
// 5 篇笔记（不同时间 + 不同 likes + 1 篇转发）
insNote.run('n1', 'u1', 'PC_U1', 'note', '笔记一', '正文1', '["h1"]', 'prd_a', null, 100, 50, '2025-01-01 10:00:00')
insNote.run('n2', 'u2', 'PC_U2', 'note', '笔记二', '正文2', '["h2"]', 'prd_a', null, 50, 200, '2025-01-02 10:00:00')
insNote.run('n3', 'u1', 'PC_U1', 'note', '笔记三', '正文3', '["h3"]', 'prd_a', null, 10, 5, '2025-01-05 10:00:00')
insNote.run('n4', 'u2', 'PC_U2', 'note', '笔记四(转发)', '正文4', '["h4"]', 'prd_a', 'n1', 30, 20, '2025-01-06 10:00:00')
insNote.run('n5', 'u3', 'PC_U3', 'note', '笔记五', '正文5', '["h5"]', 'prd_a', null, 5, 1, '2025-01-07 10:00:00')
// 1 篇 status='removed' 应该被过滤
insNote.run('n_removed', 'u1', 'PC_U1', 'note', '已删', '已删', '["h_d"]', 'prd_a', null, 999, 999, '2025-01-08 10:00:00')
db.prepare(`UPDATE shareables SET status='removed' WHERE id='n_removed'`).run()

// 复刻 /api/notes 查询逻辑（不依赖 server.ts）
function listNotes(opts: { sort: 'newest' | 'trending' | 'following'; limit: number; cursor?: string; userId?: string }): { items: Array<{ id: string }>; nextCursor: string | null } {
  let where = `s.type = 'note' AND s.status = 'active'`
  const args: unknown[] = []
  if (opts.cursor) { where += ` AND s.created_at < ?`; args.push(opts.cursor) }
  let orderBy = `s.created_at DESC`
  if (opts.sort === 'trending') {
    orderBy = `(COALESCE(s.like_count,0)*2 + COALESCE(s.click_count,0)/10.0 - (julianday('now') - julianday(s.created_at))*0.5) DESC, s.created_at DESC`
  } else if (opts.sort === 'following') {
    if (!opts.userId) throw new Error('auth_required_for_following')
    where += ` AND s.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)`
    args.push(opts.userId)
  }
  args.push(opts.limit + 1)
  const rows = db.prepare(`
    SELECT s.id, s.created_at FROM shareables s WHERE ${where} ORDER BY ${orderBy} LIMIT ?
  `).all(...args) as Array<{ id: string; created_at: string }>
  const hasMore = rows.length > opts.limit
  const items = rows.slice(0, opts.limit)
  return { items: items.map(r => ({ id: r.id })), nextCursor: hasMore ? items[items.length - 1].created_at : null }
}

// ─── 1. newest 排序 ─────────────────────────────────────────
const r1 = listNotes({ sort: 'newest', limit: 10 })
expect('newest 第一个是最新的 n5', r1.items[0].id === 'n5')
expect('newest 不包括 removed', !r1.items.find(i => i.id === 'n_removed'))
expect('newest 5 条', r1.items.length === 5)

// ─── 2. trending 排序（likes×2 主导）────────────────────────
const r2 = listNotes({ sort: 'trending', limit: 10 })
// n2 likes=200 应该靠前；n1 likes=50 也较前；n5 likes=1 最末
const trendOrder = r2.items.map(i => i.id)
const idx_n2 = trendOrder.indexOf('n2')
const idx_n5 = trendOrder.indexOf('n5')
expect('trending: 高赞 n2 排在低赞 n5 前面', idx_n2 < idx_n5)

// ─── 3. cursor 分页 ──────────────────────────────────────────
const page1 = listNotes({ sort: 'newest', limit: 2 })
expect('page1 limit=2 返回 2 条', page1.items.length === 2)
expect('page1 有 nextCursor', !!page1.nextCursor)
const page2 = listNotes({ sort: 'newest', limit: 2, cursor: page1.nextCursor || undefined })
expect('page2 不与 page1 重叠', !page2.items.find(i => page1.items.find(p => p.id === i.id)))
expect('page2 有 nextCursor', !!page2.nextCursor)
const page3 = listNotes({ sort: 'newest', limit: 2, cursor: page2.nextCursor || undefined })
expect('page3 拿到最后 1 条', page3.items.length === 1)
expect('page3 nextCursor=null（无更多）', page3.nextCursor === null)

// ─── 4. following 模式 ─────────────────────────────────────
const r4 = listNotes({ sort: 'following', limit: 10, userId: 'u3' })
const followingIds = new Set(r4.items.map(i => i.id))
expect('u3 follows u1+u2 → 见到 n1/n2/n3/n4', followingIds.has('n1') && followingIds.has('n2') && followingIds.has('n3') && followingIds.has('n4'))
expect('u3 follows 不含 u3 自己 → 不见 n5', !followingIds.has('n5'))

// ─── 5. following 模式 — 未登录拒绝 ────────────────────────
let e5 = ''
try { listNotes({ sort: 'following', limit: 10 }) } catch (e) { e5 = (e as Error).message }
expect('未登录 following → auth_required_for_following', e5 === 'auth_required_for_following')

// ─── 6. 转发链 — n4 有 parent_id 指向 n1 ─────────────────
const repost = db.prepare(`SELECT parent_id FROM shareables WHERE id='n4'`).get() as { parent_id: string }
expect('n4 是转发，parent_id=n1', repost.parent_id === 'n1')

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
