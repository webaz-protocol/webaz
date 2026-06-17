import Database from 'better-sqlite3'
import {
  initExternalAnchorSchema, createAnchor, verifyAnchorSignature,
  revokeAnchor, issueOwnershipToken, submitVerification,
  getAnchor, listAnchorsByProduct, listAnchorsBySeller, sha256Hex,
  distributeAnchorRewards, ANCHOR_VERIFICATION_FEE_RECOMMENDED,
} from '../src/layer1-agent/L1-2-external-anchor/anchor-engine.js'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, role TEXT);
  CREATE TABLE products (id TEXT PRIMARY KEY, seller_id TEXT);
  CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, earned REAL DEFAULT 0);
`)
initExternalAnchorSchema(db)
db.prepare(`INSERT INTO users VALUES ('seller1','KS1','seller')`).run()
db.prepare(`INSERT INTO users VALUES ('seller2','KS2','seller')`).run()
db.prepare(`INSERT INTO users VALUES ('buyer1','KB','buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('verif1','KV1','verifier')`).run()
db.prepare(`INSERT INTO users VALUES ('verif2','KV2','verifier')`).run()
// 测试用 products — seller1 拥有 prd_x，seller2 拥有 prd_y
db.prepare(`INSERT INTO products VALUES ('prd_x','seller1')`).run()
db.prepare(`INSERT INTO products VALUES ('prd_y','seller2')`).run()

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const canonical = {
  title: '手工竹编收纳篮',
  price_yuan: 88,
  images: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
  description_excerpt: '匠人 30 年手作 · 适合茶具收纳',
  seller_handle: 'taobao:zhulanjia',
  stock_status: 'in_stock',
}

// 1. 基础创建 + 签名
const a1 = createAnchor(db, { sellerId: 'seller1', productId: 'prd_x', platform: 'taobao', externalUrl: 'https://item.taobao.com/item.htm?id=123', canonical, sellerNodeUrl: 'https://seller1-pc.local/anchors/prd_x' })
expect('create returns id + hash + sig', !!a1.id && !!a1.content_hash && !!a1.signature)
expect('verify-sig ok', verifyAnchorSignature(db, a1.id).ok === true)

// 2. 同 seller 同 URL 重复创建 → 旧的自动 superseded
const a2 = createAnchor(db, { sellerId: 'seller1', productId: 'prd_x', platform: 'taobao', externalUrl: 'https://item.taobao.com/item.htm?id=123', canonical: { ...canonical, price_yuan: 99 } })
const old = db.prepare('SELECT revoked, revoked_reason FROM external_anchors WHERE id = ?').get(a1.id) as { revoked: number; revoked_reason: string }
expect('旧 anchor 被自动 superseded', old.revoked === 1 && old.revoked_reason === 'superseded')
expect('新 anchor 不同 hash', a2.content_hash !== a1.content_hash)

// 3. 非卖家不能创建
let caught = ''
try { createAnchor(db, { sellerId: 'buyer1', platform: 'taobao', externalUrl: 'https://x.com', canonical }) } catch (e) { caught = (e as Error).message }
expect('非 seller 拒绝', caught === 'anchor_only_seller_can_anchor')

// 4. 未知 platform
let c2 = ''
try { createAnchor(db, { sellerId: 'seller1', platform: 'mystery', externalUrl: 'https://x.com', canonical }) } catch (e) { c2 = (e as Error).message }
expect('未知 platform 拒绝', c2.startsWith('anchor_unknown_platform'))

// 5. 签名篡改检测
db.prepare(`UPDATE external_anchors SET canonical_json='{"hacked":true}' WHERE id=?`).run(a2.id)
const v5 = verifyAnchorSignature(db, a2.id)
expect('canonical 篡改 → content_hash_mismatch', !v5.ok && v5.reason === 'content_hash_mismatch')

// 重建一个干净 anchor 给后续测试
const a3 = createAnchor(db, { sellerId: 'seller2', productId: 'prd_y', platform: 'jd', externalUrl: 'https://item.jd.com/y.html', canonical })

// 6. revoke
const rev = revokeAnchor(db, a3.id, 'seller2', 'no_longer_selling')
expect('revoke ok', rev.ok === true)
const a3row = db.prepare('SELECT revoked FROM external_anchors WHERE id = ?').get(a3.id) as { revoked: number }
expect('revoked=1', a3row.revoked === 1)
// 别人不能 revoke
const a4 = createAnchor(db, { sellerId: 'seller2', productId: 'prd_y', platform: 'jd', externalUrl: 'https://item.jd.com/y2.html', canonical })
const r2 = revokeAnchor(db, a4.id, 'seller1', 'malicious')
expect('非主人 revoke 拒绝', !r2.ok && r2.reason === 'not_owner')

// 7. ownership token issuance
const tok = issueOwnershipToken(db, a4.id, 'seller2')
expect('issue token ok', tok.ok === true && !!tok.token && tok.token!.startsWith('WAZ-V-'))
const rowT = db.prepare('SELECT ownership_token, ownership_verified FROM external_anchors WHERE id=?').get(a4.id) as { ownership_token: string; ownership_verified: string }
expect('token 存入 + self_claimed', rowT.ownership_token === tok.token && rowT.ownership_verified === 'self_claimed')

// 8. verifier 提交 — 内容一致 + token found → 第 1 票（不足以 community）
const v1 = submitVerification(db, { anchorId: a4.id, verifierId: 'verif1', verifierRole: 'verifier', submittedCanonical: canonical, tokenFoundInExternal: true })
expect('verif1 提交 matches', v1.ok === true && v1.matches === true)
expect('1 verifier 票不够 community', v1.ownership_level === 'self_claimed')

// 9. 第 2 个 verifier — 仍未达到 community 门槛（需要 3 verifier 票）
const v2 = submitVerification(db, { anchorId: a4.id, verifierId: 'verif2', verifierRole: 'verifier', submittedCanonical: canonical, tokenFoundInExternal: true })
expect('2 verifier 票仍 self_claimed', v2.ok === true && v2.ownership_level === 'self_claimed', v2)

// 9b. 第 3 个 verifier → community 升级
db.prepare(`INSERT INTO users VALUES ('verif3','KV3','verifier')`).run()
const v2b = submitVerification(db, { anchorId: a4.id, verifierId: 'verif3', verifierRole: 'verifier', submittedCanonical: canonical, tokenFoundInExternal: true })
expect('3 verifier 票 → community 升级', v2b.ok === true && v2b.ownership_level === 'community', v2b)

// 10. 单个 buyer 提交不一致 — 现在要求至少 2 票 mismatch + ratio < 67% 才 disputed
//     单票 mismatch 应保持 community（多数仍是 match）
const v3 = submitVerification(db, { anchorId: a4.id, verifierId: 'seller1', verifierRole: 'seller', submittedCanonical: { ...canonical, price_yuan: 999 }, tokenFoundInExternal: false })
expect('单票 mismatch 不足以 disputed', v3.ok === true && v3.matches === false && v3.ownership_level === 'community', v3)

// 10b. ultrareview bug_008 回归：2 个 sockpuppet buyer 角色不能伪造 community
const aSock = createAnchor(db, { sellerId: 'seller1', platform: 'taobao', externalUrl: 'https://item.taobao.com/sockpuppet-test', canonical })
issueOwnershipToken(db, aSock.id, 'seller1')
db.prepare(`INSERT INTO users VALUES ('sock1','KSOCK1','buyer'),('sock2','KSOCK2','buyer')`).run()
submitVerification(db, { anchorId: aSock.id, verifierId: 'sock1', verifierRole: 'buyer', submittedCanonical: canonical, tokenFoundInExternal: true })
submitVerification(db, { anchorId: aSock.id, verifierId: 'sock2', verifierRole: 'buyer', submittedCanonical: canonical, tokenFoundInExternal: true })
const sockState = db.prepare('SELECT ownership_verified FROM external_anchors WHERE id=?').get(aSock.id) as { ownership_verified: string }
expect('2 buyer sockpuppet 不足以 community', sockState.ownership_verified === 'self_claimed', sockState)

// 10c. Sybil 防护：5 honest verifier + 2 sybil mismatch — 5/7 = 71% > 67% → 仍 community
//      （3 honest + 2 sybil = 60% < 67% 协议会保守 disputed；要稳住需要更多 honest 票）
db.prepare(`INSERT INTO users VALUES ('h1','KH1','verifier'),('h2','KH2','verifier'),('h3','KH3','verifier'),('h4','KH4','verifier'),('h5','KH5','verifier'),('s1','KS1','buyer'),('s2','KS2','buyer')`).run()
const aSybil = createAnchor(db, { sellerId: 'seller1', platform: 'taobao', externalUrl: 'https://item.taobao.com/sybil-test', canonical })
issueOwnershipToken(db, aSybil.id, 'seller1')
for (const h of ['h1','h2','h3','h4','h5']) {
  submitVerification(db, { anchorId: aSybil.id, verifierId: h, verifierRole: 'verifier', submittedCanonical: canonical, tokenFoundInExternal: true })
}
expect('5 honest verifier → community', (db.prepare('SELECT ownership_verified FROM external_anchors WHERE id=?').get(aSybil.id) as { ownership_verified: string }).ownership_verified === 'community')
submitVerification(db, { anchorId: aSybil.id, verifierId: 's1', verifierRole: 'buyer', submittedCanonical: { hacked: true }, tokenFoundInExternal: false })
submitVerification(db, { anchorId: aSybil.id, verifierId: 's2', verifierRole: 'buyer', submittedCanonical: { hacked: true }, tokenFoundInExternal: false })
const afterSybil = db.prepare('SELECT ownership_verified FROM external_anchors WHERE id=?').get(aSybil.id) as { ownership_verified: string }
expect('5/7 ≈ 71% > 67% → 多数 honest 防住 2 sybil', afterSybil.ownership_verified === 'community', afterSybil)

// 10d. ultrareview bug_013 回归：anchor 在 disputed 状态时不能重新声明洗票
// 制造一个 disputed anchor
const aDisp = createAnchor(db, { sellerId: 'seller1', platform: 'taobao', externalUrl: 'https://item.taobao.com/disputed-test', canonical })
issueOwnershipToken(db, aDisp.id, 'seller1')
db.prepare(`INSERT INTO users VALUES ('dh1','KDH1','verifier'),('dh2','KDH2','verifier')`).run()
submitVerification(db, { anchorId: aDisp.id, verifierId: 'dh1', verifierRole: 'verifier', submittedCanonical: { hacked: true }, tokenFoundInExternal: false })
submitVerification(db, { anchorId: aDisp.id, verifierId: 'dh2', verifierRole: 'verifier', submittedCanonical: { hacked: true }, tokenFoundInExternal: false })
const dispState = db.prepare('SELECT ownership_verified FROM external_anchors WHERE id=?').get(aDisp.id) as { ownership_verified: string }
expect('2 mismatch → disputed', dispState.ownership_verified === 'disputed')
// 同 seller + 同 URL 重新声明 — 应被拒绝
let recreateErr = ''
try { createAnchor(db, { sellerId: 'seller1', platform: 'taobao', externalUrl: 'https://item.taobao.com/disputed-test', canonical }) } catch (e) { recreateErr = (e as Error).message }
expect('disputed 状态下不能重新声明', recreateErr === 'anchor_disputed_must_clear_first', recreateErr)

// 10e. ultrareview bug_003 回归：anchor 不能绑到别人的 product 上
// (prd_y 属于 seller2，seller1 来锚应被拒)
let ownErr = ''
try { createAnchor(db, { sellerId: 'seller1', productId: 'prd_y', platform: 'taobao', externalUrl: 'https://item.taobao.com/squat', canonical }) } catch (e) { ownErr = (e as Error).message }
expect('不能锚到他人 product', ownErr === 'anchor_not_product_owner', ownErr)
// 不存在的 product
let nfErr = ''
try { createAnchor(db, { sellerId: 'seller1', productId: 'prd_ghost', platform: 'taobao', externalUrl: 'https://item.taobao.com/ghost', canonical }) } catch (e) { nfErr = (e as Error).message }
expect('不存在 product → not_found', nfErr === 'anchor_product_not_found', nfErr)
// 自己的 product 可锚（prd_x 属于 seller1）
const ownAnchor = createAnchor(db, { sellerId: 'seller1', productId: 'prd_x', platform: 'taobao', externalUrl: 'https://item.taobao.com/own-prod', canonical })
expect('自己 product 可锚', !!ownAnchor.id)

// 11. 重复 verifier 提交拒绝
const dup = submitVerification(db, { anchorId: a4.id, verifierId: 'verif1', verifierRole: 'verifier', submittedCanonical: canonical, tokenFoundInExternal: true })
expect('重复 verifier 拒绝', !dup.ok && dup.reason === 'already_verified')

// 12. 卖家不能给自己投票
const selfv = submitVerification(db, { anchorId: a4.id, verifierId: 'seller2', verifierRole: 'seller', submittedCanonical: canonical, tokenFoundInExternal: true })
expect('self-verify 拒绝', !selfv.ok && selfv.reason === 'self_verify_disallowed')

// 13. 列表查询
const byProd = listAnchorsByProduct(db, 'prd_y') as Array<{ id: string }>
expect('by-product 列表（已 revoked a3 不返回）', byProd.length === 1 && byProd[0].id === a4.id, byProd.map(x => x.id))

const bySeller = listAnchorsBySeller(db, 'seller2') as Array<{ id: string; revoked: number }>
expect('by-seller 列表全返（含 revoked，revoked 排后面）', bySeller.length === 2)
expect('bySeller 按 revoked ASC', bySeller[0].revoked === 0 && bySeller[1].revoked === 1)

// 14. canonical 确定性 — 顺序不同字段同 → 同 hash
const c1 = { title: 'a', price: 1, images: ['x', 'y'] }
const c2obj = { images: ['x', 'y'], price: 1, title: 'a' }
const ax = createAnchor(db, { sellerId: 'seller1', platform: 'shopee', externalUrl: 'https://shopee.tw/p/1', canonical: c1 })
const ay = createAnchor(db, { sellerId: 'seller1', platform: 'shopee', externalUrl: 'https://shopee.tw/p/2', canonical: c2obj })
expect('canonical 同内容 → 同 hash（顺序无关）', ax.content_hash === ay.content_hash, [ax.content_hash, ay.content_hash])

// ─── #6 验证激励 — 付费 + community 升级时均分给 matching verifier ──
// 准备：seller3 + 复用已有 verifier + 新增 verif4 + 钱包
// 注意：verif1/verif2/verif3 在前面 test 已 INSERT，这里只新增没用过的
db.prepare(`INSERT INTO users VALUES ('seller3','KS3','seller')`).run()
db.prepare(`INSERT INTO users VALUES ('verif4','KV4','verifier')`).run()
db.prepare(`INSERT INTO users VALUES ('arbi1','KA1','arbitrator')`).run()
db.prepare(`INSERT INTO products VALUES ('prd_reward','seller3')`).run()
db.prepare(`INSERT INTO wallets VALUES ('seller3', 100, 0)`).run()
for (const u of ['verif1', 'verif2', 'verif3', 'verif4', 'arbi1']) {
  db.prepare(`INSERT INTO wallets VALUES (?, 0, 0)`).run(u)
}

// 15. 创建 anchor 付 fee → seller 余额扣
const rewardCanonical = { title: 'reward-test', price: 200, images: ['x'] }
const rw1 = createAnchor(db, { sellerId: 'seller3', productId: 'prd_reward', platform: 'taobao', externalUrl: 'https://item.taobao.com/reward.htm', canonical: rewardCanonical, verificationFee: 6 })
expect('createAnchor with fee=6 返回 verification_fee=6', rw1.verification_fee === 6)
const sellerW1 = db.prepare(`SELECT balance FROM wallets WHERE user_id='seller3'`).get() as { balance: number }
expect('seller3 余额从 100 扣到 94', sellerW1.balance === 94)

// 16. 余额不足拒绝
let feeErr = ''
try { createAnchor(db, { sellerId: 'seller3', platform: 'taobao', externalUrl: 'https://item.taobao.com/x.htm', canonical: rewardCanonical, verificationFee: 1000 }) } catch (e) { feeErr = (e as Error).message }
expect('fee > 余额 → anchor_insufficient_balance_for_fee', feeErr === 'anchor_insufficient_balance_for_fee')

// 17. issue ownership token（升级 community 必需）
// token 不在 canonical_json 里 — 它是 anchor 表的独立列；verifier 提交 canonical 不应加它
const tk = issueOwnershipToken(db, rw1.id, 'seller3')
expect('issue token ok', tk.ok === true && !!tk.token)
const matchingCanonical = rewardCanonical

// 18. 3 verifier 都投 match + token_found=true → community
const rv1 = submitVerification(db, { anchorId: rw1.id, verifierId: 'verif1', verifierRole: 'verifier', submittedCanonical: matchingCanonical, tokenFoundInExternal: true })
expect('rv1 match', rv1.ok === true)
const rv2 = submitVerification(db, { anchorId: rw1.id, verifierId: 'verif2', verifierRole: 'verifier', submittedCanonical: matchingCanonical, tokenFoundInExternal: true })
expect('rv2 match — 此时仅 2 票 trusted match + 2 token，还差 1 票', rv2.ownership_level !== 'community')
const rv3 = submitVerification(db, { anchorId: rw1.id, verifierId: 'verif3', verifierRole: 'verifier', submittedCanonical: matchingCanonical, tokenFoundInExternal: true })
expect('rv3 达到 3 trusted match + 2+ token → community 触发', rv3.ownership_level === 'community')
expect('rv3 返回 reward_paid > 0', (rv3.reward_paid || 0) > 0)

// 19. 三个 verifier 均分 6 WAZ → 每人 2 WAZ
for (const u of ['verif1', 'verif2', 'verif3']) {
  const w = db.prepare(`SELECT balance, earned FROM wallets WHERE user_id=?`).get(u) as { balance: number; earned: number }
  expect(`${u} 各得 2 WAZ`, w.balance === 2 && w.earned === 2)
}

// 20. anchor 标记 fee_paid_out
const anchorAfter = getAnchor(db, rw1.id) as { fee_paid_out: number; verification_fee: number }
expect('fee_paid_out=1', anchorAfter.fee_paid_out === 1)

// 21. 幂等 — 再调 distribute 不再付款
const sw2 = db.prepare(`SELECT balance FROM wallets WHERE user_id='verif1'`).get() as { balance: number }
const paid2 = distributeAnchorRewards(db, rw1.id)
expect('重复 distribute → 返 0', paid2 === 0)
const sw3 = db.prepare(`SELECT balance FROM wallets WHERE user_id='verif1'`).get() as { balance: number }
expect('verif1 余额未变（幂等）', sw3.balance === sw2.balance)

// 22. arbitrator 票也算 — 用 a4 测：a4 已被 verif1/verif2 投过 match（前面 test 7-10）
// 添加 fee + arbitrator 投票 → 但 anchor 已是 community 应该不重新分（wasCommunity 守门）
// 跳过：和现有 a4 state 耦合，单测覆盖见 21 已足

// 23. 无 fee 的 anchor → community 升级不分账
const noFeeAnchor = createAnchor(db, { sellerId: 'seller3', productId: 'prd_reward', platform: 'jd', externalUrl: 'https://item.jd.com/free.htm', canonical: rewardCanonical })
expect('无 fee → verification_fee=0', noFeeAnchor.verification_fee === 0)
const tk2 = issueOwnershipToken(db, noFeeAnchor.id, 'seller3')
expect('issue token for noFee anchor ok', tk2.ok === true)
const matchNoFee = rewardCanonical
submitVerification(db, { anchorId: noFeeAnchor.id, verifierId: 'verif1', verifierRole: 'verifier', submittedCanonical: matchNoFee, tokenFoundInExternal: true })
submitVerification(db, { anchorId: noFeeAnchor.id, verifierId: 'verif2', verifierRole: 'verifier', submittedCanonical: matchNoFee, tokenFoundInExternal: true })
const v_nofee = submitVerification(db, { anchorId: noFeeAnchor.id, verifierId: 'verif3', verifierRole: 'verifier', submittedCanonical: matchNoFee, tokenFoundInExternal: true })
expect('无 fee anchor 也能升 community', v_nofee.ownership_level === 'community')
expect('无 fee → reward_paid = 0', (v_nofee.reward_paid || 0) === 0)
const noFeeAnchor_after = getAnchor(db, noFeeAnchor.id) as { fee_paid_out: number }
expect('无 fee anchor 自动 fee_paid_out=1（防重扫）', noFeeAnchor_after.fee_paid_out === 1)

// 24. ANCHOR_VERIFICATION_FEE_RECOMMENDED 暴露
expect('推荐 fee 常量 > 0', ANCHOR_VERIFICATION_FEE_RECOMMENDED > 0)

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
