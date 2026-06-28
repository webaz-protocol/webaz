#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 按卖家店铺认证(store-verification)= 逐品验证豁免路径 helper 测试。
 * 验:issued→submitted→verified|rejected;单一活跃 per seller;URL 仅存储;review 时 per_product_exempt 只在 verified 生效;
 *   sellerExemptFromPerProduct = verified && exempt;reject 一律不豁免;DTO 去 reviewed_by/notes、含 exempt 布尔;reject 后可重申。
 * Usage: npm run test:store-verification
 */
import Database from 'better-sqlite3'

const SV = await import('../src/store-verification.js')
const { requestStoreVerification, submitStoreVerificationLink, reviewStoreVerification,
  getStoreVerification, listStoreVerifications, sellerExemptFromPerProduct, toSellerStoreVerificationView } = SV

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
db.exec("CREATE TABLE store_verifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT NOT NULL, platform TEXT, external_url TEXT, status TEXT NOT NULL DEFAULT 'issued', per_product_exempt INTEGER NOT NULL DEFAULT 0, reviewed_by TEXT, reviewed_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))")

// ── 1. request → issued;单一活跃 per seller ──
ok('1. request → issued + code', (() => { const r = requestStoreVerification(db, { id: 'sv1', userId: 'sEx', code: 'wzs_1', platform: 'Taobao' }); return r.ok && r.status === 'issued' && r.code === 'wzs_1' })())
ok('1a. second active request same seller → rejected', requestStoreVerification(db, { id: 'sv1b', userId: 'sEx', code: 'x' }).ok === false)
ok('1b. different seller → ok', requestStoreVerification(db, { id: 'sv2', userId: 'sNo', code: 'wzs_2' }).ok === true)

// ── 2. submit ──
ok('2. submit bad url → rejected', submitStoreVerificationLink(db, { userId: 'sEx', externalUrl: 'data:x' }).ok === false)
ok('2a. submit valid https → submitted', submitStoreVerificationLink(db, { userId: 'sEx', externalUrl: 'https://store.example.com/sEx' }).ok === true)

// ── 3. review verified WITH exempt → 豁免生效 ──
ok('3. verify sEx WITH per_product_exempt → verified + exempt true', (() => { const r = reviewStoreVerification(db, { id: 'sv1', reviewerId: 'admin1', decision: 'verified', perProductExempt: true }); return r.ok && r.status === 'verified' && r.perProductExempt === true })())
ok('3a. sellerExemptFromPerProduct(sEx) → true', sellerExemptFromPerProduct(db, 'sEx') === true)

// ── 4. review verified WITHOUT exempt → 不豁免 ──
submitStoreVerificationLink(db, { userId: 'sNo', externalUrl: 'https://store.example.com/sNo' })
ok('4. verify sNo without exempt → verified + exempt false', (() => { const r = reviewStoreVerification(db, { id: 'sv2', reviewerId: 'admin1', decision: 'verified' }); return r.ok && r.perProductExempt === false })())
ok('4a. sellerExemptFromPerProduct(sNo) → false (verified but NOT exempt)', sellerExemptFromPerProduct(db, 'sNo') === false)
ok('4b. unknown seller → false', sellerExemptFromPerProduct(db, 'nobody') === false)

// ── 5. review guards ──
ok('5. review without reviewerId → rejected', reviewStoreVerification(db, { id: 'sv1', reviewerId: '', decision: 'verified' }).ok === false)
ok('5a. re-verify already verified → idempotent already', (() => { const r = reviewStoreVerification(db, { id: 'sv1', reviewerId: 'admin1', decision: 'verified', perProductExempt: true }); return r.ok && (r as any).already === true })())
// reject path never grants exemption
requestStoreVerification(db, { id: 'sv3', userId: 'sRej', code: 'wzs_3' }); submitStoreVerificationLink(db, { userId: 'sRej', externalUrl: 'https://x.example.com' })
ok('5b. reject WITH exempt arg → rejected, exempt stays false', (() => { const r = reviewStoreVerification(db, { id: 'sv3', reviewerId: 'admin1', decision: 'rejected', perProductExempt: true }); return r.ok && r.status === 'rejected' && r.perProductExempt === false })())
ok('5c. sRej not exempt', sellerExemptFromPerProduct(db, 'sRej') === false)
ok('5d. after reject, sRej may re-request', requestStoreVerification(db, { id: 'sv3b', userId: 'sRej', code: 'wzs_3b' }).ok === true)

// ── 6. DTO 脱敏 ──
db.prepare("UPDATE store_verifications SET reviewed_by='admin1', notes='INTERNAL note' WHERE id='sv1'").run()
const dto = toSellerStoreVerificationView(getStoreVerification(db, 'sEx'))
ok('6. DTO has per_product_exempt boolean + status', dto.per_product_exempt === true && dto.status === 'verified')
ok('6a. DTO OMITS reviewed_by + notes', !('reviewed_by' in dto) && !('notes' in dto))

// ── 7. list ──
ok('7. listStoreVerifications({status:verified}) only verified', listStoreVerifications(db, { status: 'verified' }).every(r => r.status === 'verified') && listStoreVerifications(db, { status: 'verified' }).length >= 2)

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} store-verification tests passed`)
