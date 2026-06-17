// #7 Commission source_type — 验证 settleCommission 正确写入 note/link/sponsor
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, region TEXT);
  CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, earned REAL DEFAULT 0);
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, buyer_id TEXT, product_id TEXT, total_amount REAL,
    snapshot_commission_rate REAL, buyer_region TEXT,
    l1_uid TEXT, l2_uid TEXT, l3_uid TEXT, settled_commission_at TEXT
  );
  CREATE TABLE products (id TEXT, seller_id TEXT);
  CREATE TABLE region_config (region TEXT PRIMARY KEY, max_levels INTEGER, mlm_ui_visible INTEGER DEFAULT 1);
  CREATE TABLE product_share_attribution (
    product_id TEXT, recipient_id TEXT, sharer_id TEXT, shareable_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (product_id, recipient_id)
  );
  CREATE TABLE shareables (
    id TEXT PRIMARY KEY, owner_id TEXT, type TEXT,
    related_product_id TEXT, status TEXT DEFAULT 'active'
  );
  CREATE TABLE commission_records (
    id TEXT PRIMARY KEY, order_id TEXT, beneficiary_id TEXT, source_buyer_id TEXT,
    level INTEGER, amount REAL, rate REAL, region TEXT,
    source TEXT DEFAULT 'static', source_type TEXT DEFAULT 'sponsor',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(order_id, level)
  );
`)
db.prepare(`INSERT INTO region_config VALUES ('global', 3, 1)`).run()
for (const u of ['buyer', 'l1_note', 'l1_link', 'l1_sponsor', 'seller']) {
  db.prepare(`INSERT INTO users VALUES (?, 'global')`).run(u)
  db.prepare(`INSERT INTO wallets VALUES (?, 0, 0)`).run(u)
}
db.prepare(`INSERT INTO products VALUES ('prd_x', 'seller')`).run()

// 创建 3 个 shareable —— note / link / 无 attribution
db.prepare(`INSERT INTO shareables VALUES ('shr_note',  'l1_note',  'note', 'prd_x', 'active')`).run()
db.prepare(`INSERT INTO shareables VALUES ('shr_link',  'l1_link',  'native_text', 'prd_x', 'active')`).run()

// attribution: l1_note 把 prd_x 分享给 buyer_note; l1_link → buyer_link
db.prepare(`INSERT INTO product_share_attribution VALUES ('prd_x', 'b_note', 'l1_note', 'shr_note', datetime('now'))`).run()
db.prepare(`INSERT INTO product_share_attribution VALUES ('prd_x', 'b_link', 'l1_link', 'shr_link', datetime('now'))`).run()
// b_sponsor 没有 attribution 行 → source_type='sponsor'

// 复刻 server settleCommission 的核心逻辑（只测 source_type 部分）
function resolveSourceType(productId: string, uid: string | null): 'note' | 'link' | 'sponsor' {
  if (!uid) return 'sponsor'
  const attr = db.prepare(`SELECT shareable_id FROM product_share_attribution WHERE product_id = ? AND sharer_id = ? AND shareable_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(productId, uid) as { shareable_id: string } | undefined
  if (!attr) return 'sponsor'
  const sh = db.prepare(`SELECT type FROM shareables WHERE id = ?`).get(attr.shareable_id) as { type: string } | undefined
  if (!sh) return 'sponsor'
  return sh.type === 'note' ? 'note' : 'link'
}

// 1. note 类型
expect('note shareable → source_type=note', resolveSourceType('prd_x', 'l1_note') === 'note')

// 2. link/native_text 类型
expect('普通 shareable → source_type=link', resolveSourceType('prd_x', 'l1_link') === 'link')

// 3. 无 attribution → sponsor
expect('无 attribution → source_type=sponsor', resolveSourceType('prd_x', 'l1_sponsor') === 'sponsor')

// 4. null uid → sponsor
expect('null uid → sponsor', resolveSourceType('prd_x', null) === 'sponsor')

// 5. attribution 指向已删除 shareable → sponsor (broken attribution)
db.prepare(`INSERT INTO users VALUES ('l1_broken', 'global')`).run()
db.prepare(`INSERT INTO product_share_attribution VALUES ('prd_x', 'b_broken', 'l1_broken', 'shr_does_not_exist', datetime('now'))`).run()
expect('attribution 指向已删 shareable → sponsor', resolveSourceType('prd_x', 'l1_broken') === 'sponsor')

// 6. 模拟 INSERT commission_records 实际写入
const insComm = db.prepare(`INSERT INTO commission_records (id, order_id, beneficiary_id, source_buyer_id, level, amount, rate, region, source, source_type) VALUES (?,?,?,?,?,?,?,?,?,?)`)
insComm.run('c1', 'ord_a', 'l1_note', 'b_note', 1, 7.0, 0.1, 'global', 'static', resolveSourceType('prd_x', 'l1_note'))
insComm.run('c2', 'ord_b', 'l1_sponsor', 'b_sponsor', 1, 5.0, 0.1, 'global', 'static', resolveSourceType('prd_x', 'l1_sponsor'))

const r1 = db.prepare(`SELECT source_type FROM commission_records WHERE id='c1'`).get() as { source_type: string }
expect('c1 source_type=note', r1.source_type === 'note')
const r2 = db.prepare(`SELECT source_type FROM commission_records WHERE id='c2'`).get() as { source_type: string }
expect('c2 source_type=sponsor', r2.source_type === 'sponsor')

// 7. 聚合：按 source_type 分组求和（驱动 /api/creator/stats）
const agg = db.prepare(`SELECT source_type, SUM(amount) as total, COUNT(*) as cnt FROM commission_records WHERE beneficiary_id IN ('l1_note','l1_sponsor') GROUP BY source_type ORDER BY source_type`).all() as Array<{ source_type: string; total: number; cnt: number }>
expect('聚合 2 行（note + sponsor）', agg.length === 2)
const noteAgg = agg.find(a => a.source_type === 'note')
const sponsorAgg = agg.find(a => a.source_type === 'sponsor')
expect('note 累计 7.0', noteAgg?.total === 7.0)
expect('sponsor 累计 5.0', sponsorAgg?.total === 5.0)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
