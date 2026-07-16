// RFC-015 P0 — ACP product feed 单测:投影正确性 + 两个诚实硬约束(checkout=false / currency=WAZ 声明)。
import Database from 'better-sqlite3'
import { buildAcpProductFeed } from '../src/pwa/acp-feed.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE products (
    id TEXT PRIMARY KEY, seller_id TEXT, title TEXT, description TEXT, price REAL,
    currency TEXT DEFAULT 'WAZ', stock INTEGER DEFAULT 1, category TEXT, images TEXT DEFAULT '[]',
    brand TEXT, model TEXT, return_days INTEGER DEFAULT 7, product_type TEXT DEFAULT 'retail',
    status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now'))
  );
`)
db.prepare("INSERT INTO users (id,name) VALUES ('usr_s1','Alice Store')").run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,images,brand,model,return_days,product_type,status)
  VALUES ('prd_1','usr_s1','Widget','<b>Great</b>   widget\n\nbuy now',12.5,'WAZ',3,'tools','["/uploads/a.jpg","https://cdn.x/b.jpg"]','Acme','M-9',14,'retail','active')`).run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,stock,status) VALUES ('prd_2','usr_s1','OOS item','x',5,0,'active')`).run()
db.prepare(`INSERT INTO products (id,seller_id,title,description,price,stock,status) VALUES ('prd_hidden','usr_s1','Paused','x',5,1,'paused')`).run()

const feed = buildAcpProductFeed(db) as any
const items: any[] = feed.products
const p1 = items.find(i => i.item_id === 'prd_1')
const p2 = items.find(i => i.item_id === 'prd_2')

// 基本投影
expect('只投影 active(paused 不出现)', items.length === 2 && !items.find(i => i.item_id === 'prd_hidden'), { count: items.length })
expect('item_id / title 正确', p1.item_id === 'prd_1' && p1.title === 'Widget')
expect('description plain text(去 HTML + 折叠空白)', p1.description === 'Great widget buy now', { d: p1.description })
expect('url = SPA 商品详情 hash', p1.url === 'https://webaz.xyz/#order-product/prd_1')
expect('price = {amount,currency}', p1.price.amount === 12.5 && p1.price.currency === 'WAZ')
expect('availability in_stock / out_of_stock', p1.availability === 'in_stock' && p2.availability === 'out_of_stock')
expect('image 相对路径绝对化 + 保留绝对 URL', p1.image_url === 'https://webaz.xyz/uploads/a.jpg' && p1.additional_image_urls === 'https://cdn.x/b.jpg')
expect('seller_name join users', p1.seller_name === 'Alice Store')
expect('seller_url = #u hash', p1.seller_url === 'https://webaz.xyz/#u/usr_s1')
expect('brand / mpn 映射', p1.brand === 'Acme' && p1.mpn === 'M-9')
expect('return 字段', p1.accepts_returns === true && p1.return_deadline_in_days === 14)

// 诚实硬约束(RFC-015)
expect('【诚实】is_eligible_search = true', p1.is_eligible_search === true)
expect('【诚实】is_eligible_checkout = false(全部)', items.every(i => i.is_eligible_checkout === false))
expect('【诚实】_disclosures.currency 标明模拟币', /SIMULATED/.test(feed._disclosures.currency) && /ISO 4217/.test(feed._disclosures.currency))
expect('【诚实】_disclosures.checkout 标明 ACP 不能完成购买,但 WebAZ Direct Pay 可真实付款', /ACP cannot complete the purchase/i.test(feed._disclosures.checkout) && /Direct Pay supports real/i.test(feed._disclosures.checkout))
expect('phase = launched', feed._disclosures.phase === 'launched')
expect('spec 引用真 spec + api_version', feed.spec.api_version_observed === '2025-09-12' && /openai\.com\/commerce\/specs\/feed/.test(feed.spec.reference))
expect('product_count 一致', feed.product_count === items.length)

// 空 feed(0 商品)不崩
const empty = new Database(':memory:')
empty.exec("CREATE TABLE users(id TEXT,name TEXT); CREATE TABLE products(id TEXT PRIMARY KEY,seller_id TEXT,title TEXT,description TEXT,price REAL,currency TEXT,stock INTEGER,category TEXT,images TEXT,brand TEXT,model TEXT,return_days INTEGER,product_type TEXT,status TEXT,created_at TEXT)")
const ef = buildAcpProductFeed(empty) as any
expect('空目录 → product_count 0 + 不崩', ef.product_count === 0 && Array.isArray(ef.products))

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
