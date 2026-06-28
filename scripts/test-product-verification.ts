#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 按产品认证(product-verification)helper 测试。
 * 验:issued→submitted→verified|rejected 状态机;单一活跃(per product);URL 仅存储(http(s) 校验,拒危险 scheme);
 *   reviewerId 必填、仅从 submitted 流转;productStoreVerified 【逐产品】(验证 pA 绝不连带 pB);rejected 后可重新申请;纯读列表。
 * Usage: npm run test:product-verification
 */
import Database from 'better-sqlite3'

const PV = await import('../src/product-verification.js')
const { requestProductVerification, submitProductVerificationLink, reviewProductVerification,
  getProductVerification, listSellerProductVerifications, listProductVerifications, productStoreVerified, invalidateProductVerification } = PV

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:')
db.exec("CREATE TABLE product_verifications (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, seller_id TEXT NOT NULL, code TEXT NOT NULL, platform TEXT, external_url TEXT, status TEXT NOT NULL DEFAULT 'issued', reviewed_by TEXT, reviewed_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))")

// ── 1. request → issued;单一活跃(per product)──
ok('1. request → issued + returns code', (() => { const r = requestProductVerification(db, { id: 'v1', productId: 'pA', sellerId: 's1', code: 'wzv_a', platform: 'Taobao' }); return r.ok && r.status === 'issued' && r.code === 'wzv_a' })())
ok('1a. second active request for SAME product → rejected', requestProductVerification(db, { id: 'v1b', productId: 'pA', sellerId: 's1', code: 'wzv_a2' }).ok === false)
ok('1b. request for a DIFFERENT product → ok (per-product)', requestProductVerification(db, { id: 'v2', productId: 'pB', sellerId: 's1', code: 'wzv_b' }).ok === true)
ok('1c. missing fields → rejected', requestProductVerification(db, { id: '', productId: 'pX', sellerId: 's1', code: 'c' }).ok === false)

// ── 2. submit link → submitted;URL 校验 ──
ok('2. submit non-http link → rejected', submitProductVerificationLink(db, { productId: 'pA', externalUrl: 'javascript:alert(1)' }).ok === false)
ok('2a. submit empty → rejected', submitProductVerificationLink(db, { productId: 'pA', externalUrl: '' }).ok === false)
ok('2b. submit valid https → submitted', submitProductVerificationLink(db, { productId: 'pA', externalUrl: 'https://shop.example.com/item/123' }).ok === true)
ok('2c. submit for product without issued record → rejected', submitProductVerificationLink(db, { productId: 'pZ', externalUrl: 'https://x.com' }).ok === false)
ok('2d. submitted row carries the stored url (not fetched)', getProductVerification(db, 'pA')?.external_url === 'https://shop.example.com/item/123')

// ── 3. review:仅从 submitted;reviewerId 必填 ──
ok('3. review without reviewerId → rejected', reviewProductVerification(db, { id: 'v1', reviewerId: '', decision: 'verified' }).ok === false)
ok('3a. review bad decision → rejected', reviewProductVerification(db, { id: 'v1', reviewerId: 'admin1', decision: 'maybe' as never }).ok === false)
ok('3b. review issued (not submitted) → rejected', reviewProductVerification(db, { id: 'v2', reviewerId: 'admin1', decision: 'verified' }).ok === false)
ok('3c. verify submitted → verified', reviewProductVerification(db, { id: 'v1', reviewerId: 'admin1', decision: 'verified', notes: 'looks legit' }).ok === true)
ok('3d. re-verify already verified → idempotent already', (() => { const r = reviewProductVerification(db, { id: 'v1', reviewerId: 'admin1', decision: 'verified' }); return r.ok && (r as any).already === true })())

// ── 4. productStoreVerified 逐产品隔离(核心反作弊不变量)──
ok('4. pA verified → productStoreVerified(pA) true', productStoreVerified(db, 'pA') === true)
ok('4a. pB NOT verified (only issued) → productStoreVerified(pB) false (verifying pA did NOT bless pB)', productStoreVerified(db, 'pB') === false)
ok('4b. unknown product → false', productStoreVerified(db, 'nope') === false)

// ── 5. reject + 重新申请 ──
submitProductVerificationLink(db, { productId: 'pB', externalUrl: 'https://b.example.com' })
ok('5. reject submitted pB → rejected', reviewProductVerification(db, { id: 'v2', reviewerId: 'admin1', decision: 'rejected', notes: 'code not found on page' }).ok === true)
ok('5a. pB still not verified', productStoreVerified(db, 'pB') === false)
ok('5b. after reject, pB may request again (single-active freed)', requestProductVerification(db, { id: 'v2b', productId: 'pB', sellerId: 's1', code: 'wzv_b2' }).ok === true)

// ── 6. lists ──
ok('6. listSellerProductVerifications(s1) returns all rows for seller', listSellerProductVerifications(db, 's1').length >= 3)
ok('6a. listProductVerifications({status:verified}) only verified', listProductVerifications(db, { status: 'verified' }).every(r => r.status === 'verified') && listProductVerifications(db, { status: 'verified' }).some(r => r.product_id === 'pA'))

// ── 7. invalidateProductVerification (PR-⑥ 反作弊:重大编辑后重验)──
// pA 当前 verified(section 3c)。作废 → stale → 不再 verified;active 被清,可重新申领。
const inv = invalidateProductVerification(db, 'pA')
ok('7. invalidate pA → 1 row invalidated', inv.invalidated === 1)
ok('7a. pA no longer verified (hard gate re-blocks)', productStoreVerified(db, 'pA') === false)
ok('7b. pA latest status = stale', getProductVerification(db, 'pA')?.status === 'stale')
ok('7c. after invalidate, pA may re-request (active freed)', requestProductVerification(db, { id: 'v_re', productId: 'pA', sellerId: 's1', code: 'wzv_re' }).ok === true)
ok('7d. invalidate product with no active verification → 0', invalidateProductVerification(db, 'no_such_product').invalidated === 0)
