// E1 流量暗号注册中心单测
import Database from 'better-sqlite3'
import {
  initAnchorRegistrySchema,
  generateAnchor, lookupAnchor, retireAnchor, retireAnchorsByTarget, reclaimRetiredAnchors,
  userReferralVolume, computeTierLetter, validateMiddle, validateHandleForAnchor,
  userAnchorQuotaStats,
  ANCHOR_HANDLE_MAX_FOR_USE, TIER_THRESHOLDS,
  ANCHOR_RECLAIM_COOLDOWN_DAYS, ANCHOR_PRIORITY_RECLAIM_DAYS,
} from '../src/layer2-business/L2-anchor-registry/anchor-registry.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT, role TEXT);
  CREATE TABLE products (id TEXT PRIMARY KEY, seller_id TEXT, status TEXT DEFAULT 'active', last_sold_at TEXT);
  CREATE TABLE shareables (id TEXT PRIMARY KEY, owner_id TEXT);
  CREATE TABLE dispute_cases (id TEXT PRIMARY KEY);
  CREATE TABLE commission_records (id TEXT PRIMARY KEY, order_id TEXT, beneficiary_id TEXT, amount REAL);
  CREATE TABLE orders (id TEXT PRIMARY KEY, total_amount REAL, status TEXT);
`)
initAnchorRegistrySchema(db)

db.prepare(`INSERT INTO users VALUES ('u_season','season','seller')`).run()
db.prepare(`INSERT INTO users VALUES ('u_alex','alex','seller')`).run()
db.prepare(`INSERT INTO users VALUES ('u_long','verylongusernamexyz','buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('u_ab','ab','buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('u_arb','referee','arbitrator')`).run()
db.prepare(`INSERT INTO users VALUES ('u_nope','jane','buyer')`).run()
db.prepare(`INSERT INTO products VALUES ('prd_season','u_season','active',null)`).run()
db.prepare(`INSERT INTO products VALUES ('prd_alex','u_alex','active',null)`).run()
db.prepare(`INSERT INTO shareables VALUES ('shr_x','u_season')`).run()
db.prepare(`INSERT INTO dispute_cases VALUES ('case_a')`).run()

// ─── 1. computeTierLetter ──────────────────────────────────────
expect('vol=0 → F', computeTierLetter(0) === 'F')
expect('vol=9999 → F', computeTierLetter(9999) === 'F')
expect('vol=10000 → E', computeTierLetter(10000) === 'E')
expect('vol=100000 → D', computeTierLetter(100000) === 'D')
expect('vol=1000000 → C', computeTierLetter(1000000) === 'C')
expect('vol=10000000 → B', computeTierLetter(10000000) === 'B')
expect('vol=100000000 → A', computeTierLetter(100000000) === 'A')

// ─── 2. validateMiddle ─────────────────────────────────────────
expect('"7798" 合法', validateMiddle('7798').ok === true)
expect('"abcd" 缺数字', validateMiddle('abcd').reason === 'middle_must_contain_digit')
expect('"abc" 长度不足', validateMiddle('abc').reason === 'middle_must_be_4_chars')
expect('"abcde" 长度超', validateMiddle('abcde').reason === 'middle_must_be_4_chars')
expect('"ab-1" 非字母数字', validateMiddle('ab-1').reason === 'middle_alphanumeric_only')
expect('"0000" 顺序串', validateMiddle('0000').reason === 'middle_sequential_forbidden')
expect('"1234" 顺序串', validateMiddle('1234').reason === 'middle_sequential_forbidden')
expect('"admin" 保留词（长度先错）', validateMiddle('admin').reason === 'middle_must_be_4_chars')
expect('"test" 保留词 +缺数字 优先报数字错', validateMiddle('test').reason === 'middle_must_contain_digit')
expect('"ROOT" 大小写 normalize 后', validateMiddle('ROOT').reason === 'middle_must_contain_digit')

// ─── 3. validateHandleForAnchor ────────────────────────────────
expect('valid handle "season"', validateHandleForAnchor('season').ok === true)
expect('null → handle_not_set', validateHandleForAnchor(null).reason === 'handle_not_set')
expect('"ab" 太短', validateHandleForAnchor('ab').reason === 'handle_too_short')
expect('handle > 16 → 太长', validateHandleForAnchor('verylongusernamexyz').reason === 'handle_too_long_for_anchor')

// ─── 4. userReferralVolume ─────────────────────────────────────
db.prepare(`INSERT INTO orders VALUES ('ord_1', 5000, 'completed')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_2', 8000, 'completed')`).run()
db.prepare(`INSERT INTO commission_records VALUES ('c1','ord_1','u_season', 50)`).run()
db.prepare(`INSERT INTO commission_records VALUES ('c2','ord_2','u_season', 80)`).run()
expect('u_season referralVolume = 13000', userReferralVolume(db, 'u_season') === 13000)
expect('u_alex referralVolume = 0', userReferralVolume(db, 'u_alex') === 0)

// 此时 u_season 应该 tier=E（>=10000）
const tierSeason = computeTierLetter(userReferralVolume(db, 'u_season'))
expect('u_season 当前 tier = E', tierSeason === 'E')

// ─── 5. generateAnchor — 主线 ──────────────────────────────────
const r1 = generateAnchor(db, { ownerId: 'u_season', middle: '7798', targetKind: 'product', targetId: 'prd_season' })
expect('generate season+7798(无 tier 后缀)', r1.ok && r1.anchor === 'season7798', r1)
expect('tier_letter=E', r1.tier_letter === 'E')

// 推广员可为他人 product 创建 anchor(2026-05-21:promoter 场景,prefix 由各自 handle 隔离;仅校验商品存在)
const r2 = generateAnchor(db, { ownerId: 'u_season', middle: '8801', targetKind: 'product', targetId: 'prd_alex' })
expect('推广员可锚定他人 product(各自 prefix 命名空间)', r2.ok === true, r2)

// handle 太长 → 拒
const r3 = generateAnchor(db, { ownerId: 'u_long', middle: '8802', targetKind: 'user', targetId: 'u_long' })
expect('handle 太长 → handle_too_long_for_anchor', !r3.ok && r3.reason === 'handle_too_long_for_anchor')

// handle 太短 → 拒
const r4 = generateAnchor(db, { ownerId: 'u_ab', middle: '8803', targetKind: 'user', targetId: 'u_ab' })
expect('handle 太短 → handle_too_short', !r4.ok && r4.reason === 'handle_too_short')

// middle 不合规
const r5 = generateAnchor(db, { ownerId: 'u_season', middle: 'abcd', targetKind: 'user', targetId: 'u_season' })
expect('middle 无数字 → middle_must_contain_digit', !r5.ok && r5.reason === 'middle_must_contain_digit')

// user anchor 只能指向自己
const r6 = generateAnchor(db, { ownerId: 'u_season', middle: '9001', targetKind: 'user', targetId: 'u_alex' })
expect('user anchor 指他人 → user_anchor_must_self', !r6.ok && r6.reason === 'user_anchor_must_self')

// 同 anchor 重复创建 → taken
const r7 = generateAnchor(db, { ownerId: 'u_season', middle: '7798', targetKind: 'product', targetId: 'prd_season' })
expect('同 anchor 重复 → anchor_taken', !r7.ok && r7.reason === 'anchor_taken')

// 不同 user 同 middle 但不同 prefix → 各自命名空间，OK
const r8 = generateAnchor(db, { ownerId: 'u_alex', middle: '7798', targetKind: 'user', targetId: 'u_alex' })
expect('alex 用同 middle 7798 → alex7798', r8.ok && r8.anchor === 'alex7798', r8)

// ─── 6. lookupAnchor ───────────────────────────────────────────
const l1 = lookupAnchor(db, 'season7798')
expect('lookup active anchor', l1.found && l1.status === 'active' && l1.target_kind === 'product' && l1.target_id === 'prd_season')

const l2 = lookupAnchor(db, 'SEASON7798')   // 大写 normalize
expect('lookup 大小写不敏感', l2.found === true)

const l3 = lookupAnchor(db, 'nonexistent')
expect('lookup 不存在 → not found', l3.found === false)

const l4 = lookupAnchor(db, 'season-7798')   // 非法字符
expect('lookup 形态不对 → not found', l4.found === false)

// hits 累加
lookupAnchor(db, 'season7798')
const hitsRow = db.prepare(`SELECT hits FROM anchor_registry WHERE anchor = 'season7798'`).get() as { hits: number }
expect('hits 累加 ≥ 3 (生成 + 3 次 lookup)', hitsRow.hits >= 3)

// ─── 7. retireAnchor ───────────────────────────────────────────
const rt1 = retireAnchor(db, 'u_season', 'season7798')
expect('retire ok', rt1.ok === true)
const lr = lookupAnchor(db, 'season7798')
expect('retired anchor lookup → status=retired', lr.found && lr.status === 'retired')

const rt2 = retireAnchor(db, 'u_alex', 'season7798')
expect('非 owner retire → not_owner', !rt2.ok && rt2.reason === 'not_owner')

const rt3 = retireAnchor(db, 'u_season', 'season7798')
expect('已 retired 再 retire → not_active', !rt3.ok && rt3.reason === 'not_active')

// retired 状态不能再用同名创建
const rGen = generateAnchor(db, { ownerId: 'u_season', middle: '7798', targetKind: 'product', targetId: 'prd_season' })
expect('retired anchor 不能重新创建 → anchor_retired_not_yet_reclaimable', !rGen.ok && rGen.reason === 'anchor_retired_not_yet_reclaimable')

// ─── 8. retireAnchorsByTarget（GC hook 触发）────────────────────
generateAnchor(db, { ownerId: 'u_season', middle: '8810', targetKind: 'product', targetId: 'prd_season' })
generateAnchor(db, { ownerId: 'u_season', middle: '8811', targetKind: 'product', targetId: 'prd_season' })
const beforeCount = (db.prepare(`SELECT COUNT(*) as n FROM anchor_registry WHERE target_kind='product' AND target_id='prd_season' AND status='active'`).get() as { n: number }).n
const gced = retireAnchorsByTarget(db, 'product', 'prd_season')
expect(`批量 retire by target → 影响 ${beforeCount} 行`, gced === beforeCount)
const afterCount = (db.prepare(`SELECT COUNT(*) as n FROM anchor_registry WHERE target_kind='product' AND target_id='prd_season' AND status='active'`).get() as { n: number }).n
expect('GC 后 active 数 = 0', afterCount === 0)

// ─── 9. reclaimRetiredAnchors（cron 模拟）──────────────────────
// 把 season7798 的 retired_at 推到 366 天前
db.prepare(`UPDATE anchor_registry SET retired_at = datetime('now', '-366 days') WHERE anchor = 'season7798'`).run()
const recl = reclaimRetiredAnchors(db)
expect('reclaim ≥ 1 条', recl.reclaimed >= 1)
const status = db.prepare(`SELECT status FROM anchor_registry WHERE anchor = 'season7798'`).get() as { status: string }
expect('season7798 已变 reclaimable', status.status === 'reclaimable')

// reclaimable 状态 lookup → 404 with hint
const lRecl = lookupAnchor(db, 'season7798')
expect('reclaimable lookup → found=true (内部)', lRecl.found === true && lRecl.status === 'reclaimable')

// ─── 10. 优先购窗口 ────────────────────────────────────────────
// reclaimable 且 retired_at + 365 < now < retired_at + 365 + 30 → 只有原 owner 可领
// season7798 现在 retired_at = -366d，所以 reclaimable since 1d, < 30d → in priority window
const otherClaim = generateAnchor(db, { ownerId: 'u_alex', middle: '7798', targetKind: 'user', targetId: 'u_alex' })
// 注意 alex 的 prefix=alex，所以 anchor=alex7798，跟 season7798 完全无关
// 我需要测的是 u_alex 尝试拿 season7798（不可能因为 prefix 锁了）
// 真正测试场景：u_season 自己回购
const ownerReclaim = generateAnchor(db, { ownerId: 'u_season', middle: '7798', targetKind: 'product', targetId: 'prd_season' })
expect('原 owner 在优先购窗口内可回购', ownerReclaim.ok && ownerReclaim.anchor === 'season7798')

// 推时间到 31 天后，看看是否能被任意 owner 拿回（但还是受 prefix 锁）
// 实际场景：原 owner 删了，新人改 handle=season 后想抢——但 handle 唯一约束已经防止改重名
// 所以这个测试场景几乎不存在，跳过

// ─── 11. 配额 ──────────────────────────────────────────────────
const quotaBefore = userAnchorQuotaStats(db, 'u_alex')
expect('u_alex 初始活跃数 ≥ 1', quotaBefore.active_plus_retired >= 1)

// ─── 12. 不限制创建多 anchor 给不同 product 但前缀+middle+tier 必须唯一 ─
db.prepare(`INSERT INTO products VALUES ('prd_alex_b','u_alex','active',null)`).run()
const m1 = generateAnchor(db, { ownerId: 'u_alex', middle: '5501', targetKind: 'product', targetId: 'prd_alex_b' })
expect('alex 给另一个 product 用新 middle 5501', m1.ok === true)

// shareable 目标
const sh1 = generateAnchor(db, { ownerId: 'u_season', middle: '3301', targetKind: 'shareable', targetId: 'shr_x' })
expect('shareable target ok', sh1.ok === true)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
