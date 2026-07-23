// A1 — strict ACP export 回归。诚实门逐一锁死(Codex #513 R1 后与真实建单门对齐):
//   1. 卖家未过 Rail 1 门禁 → 整店剔除;逐品再过【与买家 availability 路由同源】的
//      directPayProductAvailability(逐品验证/豁免+单笔帽+缓交额度)+ 简单商品 + 有库存。
//      判定者全部真实实现,不桩(feedback_no_stub_subject_under_test)。
//   2. price = USD 表示的 USDC 结算值,经 live waz_usdc_rate 换算(rate=2 → WAZ 10 = "5.00 USD");
//      rate 非法 / 平台 blocklist 配置坏 → fail-closed 拒绝导出。
//   3. spec 必填缺失(无公网图 / 目标国推导不出或全被平台 blocklist 扣掉)→ 整条剔除并计数,绝不用假值凑。
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'acpstrict-'))
import { gzipSync, gunzipSync } from 'node:zlib'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { requestDeferral, approveDeferral } = await import('../src/direct-receive-deferral.js')
const { toUnits } = await import('../src/money.js')
const { buildStrictAcpExport } = await import('../src/pwa/acp-strict-export.js')

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown): void => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
try { db.exec('ALTER TABLE products ADD COLUMN sale_regions TEXT') } catch { /* 已有 */ }
try { db.exec('ALTER TABLE users ADD COLUMN store_sale_regions TEXT') } catch { /* 已有 */ }
// 缓交额度窗口统计要读的订单列(生产由 server 启动迁移补;fresh fixture 手补)
try { db.exec('ALTER TABLE orders ADD COLUMN settled_fault_at TEXT') } catch { /* 已有 */ }
try { db.exec('ALTER TABLE orders ADD COLUMN payment_rail TEXT') } catch { /* 已有 */ }

let cp: Record<string, unknown> = {}
const gp = <T,>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)

const HASH = 'b569fecf0f5998fbea7a61c20ec627891e448d79a43e066d97cc6a514a6dad47'
for (const u of ['seller_rdy', 'seller_raw']) db.prepare("INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'seller', 'k_' + u)
const insP = db.prepare('INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,images,sale_regions,brand,model,has_variants) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
const IMG = JSON.stringify([HASH])
insP.run('prd_ok', 'seller_rdy', '可成交品', '<b>desc</b>', 10, 'WAZ', 5, 'cat', 'active', JSON.stringify([HASH, 'https://cdn.example/b.jpg']), null, 'BrandX', 'M-1', 0)
insP.run('prd_ok2', 'seller_rdy', '可成交品2', 'd', 20, 'WAZ', 3, 'cat', 'active', IMG, null, null, null, 0)
insP.run('prd_regions', 'seller_rdy', '跨境品', 'd', 10, 'WAZ', 5, 'cat', 'active', IMG, JSON.stringify({ mode: 'list', include: ['SG', 'US'] }), null, null, 0)
insP.run('prd_unver', 'seller_rdy', '未验证品', 'd', 10, 'WAZ', 5, 'cat', 'active', IMG, null, null, null, 0)
insP.run('prd_var', 'seller_rdy', '有规格品', 'd', 10, 'WAZ', 5, 'cat', 'active', IMG, null, null, null, 1)
insP.run('prd_out', 'seller_rdy', '无库存品', 'd', 20, 'WAZ', 0, 'cat', 'active', IMG, null, null, null, 0)
insP.run('prd_noimg', 'seller_rdy', '缺图品', 'd', 10, 'WAZ', 5, 'cat', 'active', '[]', null, null, null, 0)
insP.run('prd_notc', 'seller_rdy', '无目标国品', 'd', 10, 'WAZ', 5, 'cat', 'active', IMG, JSON.stringify({ mode: 'all', exclude: ['SG'] }), null, null, 0)
insP.run('prd_raw', 'seller_raw', '未就绪店的品', 'd', 10, 'WAZ', 5, 'cat', 'active', IMG, null, null, null, 0)
// 逐品验证(真实谓词 productStoreVerified;seller_rdy 不给店铺豁免,逐品门真实生效)
for (const pid of ['prd_ok', 'prd_ok2', 'prd_regions', 'prd_out', 'prd_noimg', 'prd_notc', 'prd_var']) {
  db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES (?,?,?,?, 'verified','admin1',datetime('now'))").run('pv_' + pid, pid, 'seller_rdy', 'wzv_' + pid)
}

// ── 1. 全局门未开 → fail-closed 空导出 ──
cp = {}
const r0 = buildStrictAcpExport(db, { getProtocolParam: gp })
expect('全局门未开 → ok=false 空导出(fail-closed)', r0.ok === false && r0.items.length === 0 && !!r0.reason, r0.reason)

// ── seller_rdy 过全套门禁(KYB/制裁/无AML/缓交/收款说明);seller_raw 不动 ──
cp = { 'direct_pay.enabled': true, 'direct_pay.rail_breaker_tripped': false, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG', 'direct_pay.per_tx_cap_units': toUnits(1000), 'waz_usdc_rate': 2 }
db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES ('kyb1','seller_rdy','approved')").run()
db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES ('sc1','seller_rdy','clear')").run()
db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES ('pi1','seller_rdy','PayNow +65 9xxx','PayNow','active')").run()
const nowIso = new Date().toISOString()
requestDeferral(db, { deferralId: 'dfr1', userId: 'seller_rdy', periodDays: 30, nowIso })
approveDeferral(db, { deferralId: 'dfr1', adminId: 'admin1', nowIso })

const r = buildStrictAcpExport(db, { getProtocolParam: gp })
const by = (id: string): Record<string, unknown> => r.items.find((i) => i.item_id === id) || {}

expect('全局开放后 ok=true', r.ok === true, r.reason)
expect('入选 = 3 条(prd_ok/prd_ok2/prd_regions)', r.items.length === 3 && ['prd_ok', 'prd_ok2', 'prd_regions'].every((id) => r.items.some((i) => i.item_id === id)), r.items.map((i) => i.item_id))
expect('未过门禁的店整店剔除,计数=1', r.stats.excluded_seller_not_ready === 1, r.stats)
expect('无库存剔除,计数=1(不再当 out_of_stock 导出)', r.stats.excluded_out_of_stock === 1 && !r.items.some((i) => i.item_id === 'prd_out'), r.stats)
expect('有规格品剔除(SIMPLE_PRODUCT_ONLY),计数=1', r.stats.excluded_variant_product === 1, r.stats)
expect('未验证品被逐品可用性谓词剔除,计数=1', r.stats.excluded_direct_pay_unavailable === 1 && !r.items.some((i) => i.item_id === 'prd_unver'), r.stats)
expect('缺图剔除,计数=1', r.stats.excluded_no_image === 1, r.stats)
expect('推导不出目标国剔除,计数=1', r.stats.excluded_no_target_countries === 1, r.stats)

// ── 2. 价格口径:USD = WAZ / waz_usdc_rate ──
expect('rate=2:WAZ 10 → "5.00 USD"', by('prd_ok').price === '5.00 USD', by('prd_ok').price)
expect('rate=2:WAZ 20 → "10.00 USD"', by('prd_ok2').price === '10.00 USD', by('prd_ok2').price)
cp['waz_usdc_rate'] = 0
const rBad = buildStrictAcpExport(db, { getProtocolParam: gp })
expect('rate<=0 → fail-closed 拒绝导出错误价格', rBad.ok === false && rBad.items.length === 0, rBad.reason)
cp['waz_usdc_rate'] = 2

// ── 3. spec 必填字段与诚实硬约束 ──
const REQUIRED = ['item_id', 'title', 'description', 'url', 'brand', 'image_url', 'price', 'availability', 'seller_name', 'seller_url', 'is_eligible_search', 'is_eligible_checkout', 'store_country', 'target_countries']
expect('每条 item 必填字段齐全', r.items.every((i) => REQUIRED.every((k) => k in i && i[k] !== null && i[k] !== '')), r.items[0])
expect('is_eligible_checkout 恒 false(ACP checkout 未接)', r.items.every((i) => i.is_eligible_checkout === false))
expect('availability 恒 in_stock(不可成交的已整条剔除)', r.items.every((i) => i.availability === 'in_stock'))
expect('hash 图 → thumb?format=jpeg 公网 URL', String(by('prd_ok').image_url).endsWith(`/api/manifests/${HASH}/thumb?format=jpeg`), by('prd_ok').image_url)
expect('余图进 additional_image_urls', by('prd_ok').additional_image_urls === 'https://cdn.example/b.jpg')
expect('无 brand → Unbranded 兜底;有 brand 原样', by('prd_ok').brand === 'BrandX' && by('prd_ok2').brand === 'Unbranded')
expect('description 去 HTML', by('prd_ok').description === 'desc', by('prd_ok').description)
expect('store_country=SG + 默认 target_countries=[SG];list 规则原样', JSON.stringify(by('prd_ok').target_countries) === '["SG"]' && JSON.stringify(by('prd_regions').target_countries) === '["SG","US"]')

// ── 4. 平台合规 blocklist(与建单门同一真相源)──
cp['trade.platform_region_blocklist'] = '["US"]'
const rB1 = buildStrictAcpExport(db, { getProtocolParam: gp })
const rgB1 = rB1.items.find((i) => i.item_id === 'prd_regions') || {}
expect('blocklist ["US"] → prd_regions 目标国扣成 ["SG"]', JSON.stringify((rgB1 as Record<string, unknown>).target_countries) === '["SG"]', rgB1)
cp['trade.platform_region_blocklist'] = '["SG","US"]'
const rB2 = buildStrictAcpExport(db, { getProtocolParam: gp })
expect('blocklist 扣光所有目标国 → 全部剔除,items=0', rB2.ok === true && rB2.items.length === 0, rB2.stats)
cp['trade.platform_region_blocklist'] = '{broken'
const rB3 = buildStrictAcpExport(db, { getProtocolParam: gp })
expect('blocklist 配置坏 → fail-closed(镜像建单 503)', rB3.ok === false && rB3.items.length === 0, rB3.reason)
delete cp['trade.platform_region_blocklist']

// ── 5. jsonl.gz 往返 + 纯读 ──
const jsonl = r.items.map((i) => JSON.stringify(i)).join('\n') + '\n'
const back = gunzipSync(gzipSync(Buffer.from(jsonl, 'utf-8'))).toString('utf-8').trim().split('\n').map((l) => JSON.parse(l))
expect('jsonl.gz 往返:行数与 item_id 一致', back.length === r.items.length && back.every((b, i) => b.item_id === r.items[i].item_id))
const counts = (): string => JSON.stringify({
  p: (db.prepare('SELECT COUNT(*) n FROM products').get() as { n: number }).n,
  o: (db.prepare('SELECT COUNT(*) n FROM orders').get() as { n: number }).n,
  w: (db.prepare('SELECT COUNT(*) n FROM wallets').get() as { n: number }).n,
})
const before = counts(); buildStrictAcpExport(db, { getProtocolParam: gp }); const after = counts()
expect('纯读:products/orders/wallets 零写', before === after, { before, after })

console.log(`\n${pass} pass · ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
