import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import {
  ensureEvidenceColumns, uploadEvidence, readEvidenceBlob, withdrawEvidence,
  listEvidence, verifyEvidenceSig, markEvidenceExpiry, cleanupExpiredEvidence,
} from '../src/layer3-trust/L3-1-dispute-engine/evidence-storage.js'

const db = new Database(':memory:')

// 最小 schema — 复刻 dispute + order + user + evidence 必要列
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, role TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, logistics_id TEXT);
  CREATE TABLE disputes (
    id TEXT PRIMARY KEY, order_id TEXT, initiator_id TEXT, defendant_id TEXT,
    status TEXT DEFAULT 'open', assigned_arbitrators TEXT DEFAULT '[]',
    party_evidence_ids TEXT DEFAULT '[]'
  );
  CREATE TABLE evidence (
    id TEXT PRIMARY KEY, order_id TEXT, uploader_id TEXT, type TEXT,
    description TEXT, file_path TEXT, file_hash TEXT,
    metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
  );
`)
ensureEvidenceColumns(db)

db.prepare(`INSERT INTO users VALUES ('buyer1','KB1','buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('seller1','KS1','seller')`).run()
db.prepare(`INSERT INTO users VALUES ('stranger','KSTR','buyer')`).run()
db.prepare(`INSERT INTO users VALUES ('arb1','KA1','arbitrator')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_1','buyer1','seller1',NULL)`).run()
db.prepare(`INSERT INTO disputes (id, order_id, initiator_id, defendant_id, status, assigned_arbitrators) VALUES ('dsp_1','ord_1','buyer1','seller1','open','["arb1"]')`).run()

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const EVIDENCE_DIR = path.join(os.homedir(), '.webaz', 'evidence')

const fakeJpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.from('test-evidence-content-'.repeat(20))])
const fakeJpgHash = createHash('sha256').update(fakeJpg).digest('hex')

// 1. 基础上传
const r1 = uploadEvidence(db, {
  uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_1',
  blob: fakeJpg, declaredHash: fakeJpgHash, mime: 'image/jpeg',
  description: '收到的破损商品照片', filename: 'damage.jpg',
})
expect('upload returns id+hash+sig', !!r1.id && r1.hash === fakeJpgHash && !!r1.sig)
expect('blob 写入磁盘', fs.existsSync(path.join(EVIDENCE_DIR, fakeJpgHash.slice(0, 2), fakeJpgHash)))
expect('dispute.party_evidence_ids 包含新证据', () => {
  const d = db.prepare(`SELECT party_evidence_ids FROM disputes WHERE id='dsp_1'`).get() as { party_evidence_ids: string }
  return JSON.parse(d.party_evidence_ids).includes(r1.id)
})

// 2. 重复上传 → dedup（同 hash 不重复落盘）
const r2 = uploadEvidence(db, {
  uploaderId: 'seller1', uploaderApiKey: 'KS1', disputeId: 'dsp_1',
  blob: fakeJpg, declaredHash: fakeJpgHash, mime: 'image/jpeg',
  description: '卖家也持有同一张照片做反驳',
})
expect('同 hash 第二次 dedup=true', r2.dedup === true)
expect('两次上传不同 evidence id', r1.id !== r2.id)

// 3. hash 不匹配
let e3 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_1',
    blob: fakeJpg, declaredHash: 'a'.repeat(64), mime: 'image/jpeg',
    description: 'hash 错的 evidence',
  })
} catch (e) { e3 = (e as Error).message }
expect('hash 不匹配 → 拒绝', e3 === 'evidence_hash_mismatch')

// 4. 空 blob
let e4 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_1',
    blob: Buffer.alloc(0), declaredHash: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    mime: 'image/jpeg', description: '空 blob 应被拒',
  })
} catch (e) { e4 = (e as Error).message }
expect('空 blob → 拒绝', e4 === 'evidence_empty')

// 5. 不允许的 mime
let e5 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_1',
    blob: fakeJpg, declaredHash: fakeJpgHash, mime: 'application/x-malware',
    description: '恶意 mime 应被拒',
  })
} catch (e) { e5 = (e as Error).message }
expect('禁用 mime → 拒绝', e5 === 'evidence_mime_not_allowed')

// 6. 描述过短
let e6 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_1',
    blob: fakeJpg, declaredHash: fakeJpgHash, mime: 'image/jpeg',
    description: 'ab',
  })
} catch (e) { e6 = (e as Error).message }
expect('描述<4字符 → 拒绝', e6 === 'evidence_description_too_short')

// 7. 非参与方
let e7 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'stranger', uploaderApiKey: 'KSTR', disputeId: 'dsp_1',
    blob: fakeJpg, declaredHash: fakeJpgHash, mime: 'image/jpeg',
    description: '陌生人想上传证据',
  })
} catch (e) { e7 = (e as Error).message }
expect('非参与方 → 拒绝', e7 === 'not_dispute_party')

// 8. 仲裁员可以上传
const r8 = uploadEvidence(db, {
  uploaderId: 'arb1', uploaderApiKey: 'KA1', disputeId: 'dsp_1',
  blob: Buffer.from('arbitrator notes ' + 'x'.repeat(100)),
  declaredHash: createHash('sha256').update(Buffer.from('arbitrator notes ' + 'x'.repeat(100))).digest('hex'),
  mime: 'text/plain',
  description: '仲裁员补充的查证记录',
})
expect('仲裁员上传成功', !!r8.id)

// 9. 读取 — 参与方可读
const blob9 = readEvidenceBlob(db, r1.id, 'seller1')
expect('参与方读取 ok 且 hash 一致', blob9.hash === fakeJpgHash && blob9.blob.length === fakeJpg.length)

// 10. 读取 — 非参与方拒绝
let e10 = ''
try { readEvidenceBlob(db, r1.id, 'stranger') } catch (e) { e10 = (e as Error).message }
expect('非参与方读取 → 拒绝', e10 === 'not_dispute_party')

// 11. 撤回 — 上传者可撤
withdrawEvidence(db, r2.id, 'seller1')
const w11 = db.prepare(`SELECT withdrawn_at FROM evidence WHERE id=?`).get(r2.id) as { withdrawn_at: string | null }
expect('撤回写入 withdrawn_at', !!w11.withdrawn_at)
expect('撤回后从 party_evidence_ids 移除', () => {
  const d = db.prepare(`SELECT party_evidence_ids FROM disputes WHERE id='dsp_1'`).get() as { party_evidence_ids: string }
  return !JSON.parse(d.party_evidence_ids).includes(r2.id)
})

// 12. 撤回 — 非上传者拒绝
let e12 = ''
try { withdrawEvidence(db, r1.id, 'seller1') } catch (e) { e12 = (e as Error).message }
expect('非上传者撤回 → 拒绝', e12 === 'not_uploader')

// 13. 撤回后读取
let e13 = ''
try { readEvidenceBlob(db, r2.id, 'buyer1') } catch (e) { e13 = (e as Error).message }
expect('已撤回 evidence 读取 → 拒绝', e13 === 'evidence_withdrawn')

// 14. 签名验证
const v14 = verifyEvidenceSig(db, r1.id)
expect('正确 sig 验证通过', v14.ok === true)

// 15. 签名验证 — description 被改 → sig 不匹配
db.prepare(`UPDATE evidence SET description='被仿造的描述' WHERE id=?`).run(r1.id)
const v15 = verifyEvidenceSig(db, r1.id)
expect('description 改 → sig_mismatch', v15.ok === false && v15.reason === 'sig_mismatch')

// 恢复 description
db.prepare(`UPDATE evidence SET description='收到的破损商品照片' WHERE id=?`).run(r1.id)

// 16. 已结案争议不能上传
db.prepare(`UPDATE disputes SET status='resolved' WHERE id='dsp_1'`).run()
let e16 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_1',
    blob: Buffer.from('post-close attempt'),
    declaredHash: createHash('sha256').update(Buffer.from('post-close attempt')).digest('hex'),
    mime: 'text/plain', description: '已结案后想补提交',
  })
} catch (e) { e16 = (e as Error).message }
expect('已结案上传 → 拒绝', e16 === 'dispute_already_closed')

// 17. 已结案不能撤回
let e17 = ''
try { withdrawEvidence(db, r1.id, 'buyer1') } catch (e) { e17 = (e as Error).message }
expect('已结案撤回 → 拒绝', e17 === 'dispute_closed_cannot_withdraw')

// 18. markEvidenceExpiry — 给争议下未过期证据打 expires_at
markEvidenceExpiry(db, 'dsp_1')
const exp18 = db.prepare(`SELECT expires_at FROM evidence WHERE id=?`).get(r1.id) as { expires_at: string | null }
expect('markEvidenceExpiry 设置 expires_at', !!exp18.expires_at)

// 19. listEvidence
const list19 = listEvidence(db, 'dsp_1', 'arb1') as Array<{ id: string; withdrawn_at: string | null }>
expect('listEvidence 返回 3 条（含已撤回）', list19.length === 3)

// 20. listEvidence — 非参与方
let e20 = ''
try { listEvidence(db, 'dsp_1', 'stranger') } catch (e) { e20 = (e as Error).message }
expect('listEvidence 非参与方 → 拒绝', e20 === 'not_dispute_party')

// 21. cleanupExpiredEvidence — 强制把 r1 的 expires_at 改成过去时间
db.prepare(`UPDATE evidence SET expires_at = datetime('now','-1 day') WHERE id=?`).run(r1.id)
// r1 和 r2 共用 fakeJpgHash，但 r2 已 withdrawn 也不算 live
// arb 上传的 r8 是不同 hash，与 fakeJpg 共存
const clean21 = cleanupExpiredEvidence(db)
expect('cleanup 扫除了 fakeJpg blob', clean21.swept >= 1)
expect('fakeJpg blob 已不在磁盘', !fs.existsSync(path.join(EVIDENCE_DIR, fakeJpgHash.slice(0, 2), fakeJpgHash)))

// 22. r8 blob 未过期 → 仍在磁盘
const r8Hash = createHash('sha256').update(Buffer.from('arbitrator notes ' + 'x'.repeat(100))).digest('hex')
expect('arb blob 未过期保留', fs.existsSync(path.join(EVIDENCE_DIR, r8Hash.slice(0, 2), r8Hash)))

// 23. 读取 — blob 已被 cleanup 但 row 还在 → 报错 blob_missing
// 需要先让争议重新开放才能读（withdrawn_at 检查在前）
db.prepare(`UPDATE disputes SET status='open' WHERE id='dsp_1'`).run()
let e23 = ''
try { readEvidenceBlob(db, r1.id, 'buyer1') } catch (e) { e23 = (e as Error).message }
expect('blob 缺失 → evidence_blob_missing', e23 === 'evidence_blob_missing')

// 24. 不存在的 dispute
let e24 = ''
try {
  uploadEvidence(db, {
    uploaderId: 'buyer1', uploaderApiKey: 'KB1', disputeId: 'dsp_nonexistent',
    blob: Buffer.from('test'),
    declaredHash: createHash('sha256').update(Buffer.from('test')).digest('hex'),
    mime: 'text/plain', description: '指向不存在的 dispute',
  })
} catch (e) { e24 = (e as Error).message }
expect('不存在 dispute → 拒绝', e24 === 'dispute_not_found')

// 清理测试残留 blob
try {
  const r8Path = path.join(EVIDENCE_DIR, r8Hash.slice(0, 2), r8Hash)
  if (fs.existsSync(r8Path)) fs.unlinkSync(r8Path)
} catch {}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
