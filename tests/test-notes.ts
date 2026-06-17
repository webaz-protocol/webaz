// Phase C 笔记系统单测：图片存储 + buyer-only 校验 + 每订单 1 篇 + 字数 + 转发链 + 公开读
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import {
  writeNotePhoto, readNotePhoto, noteBlobExists,
  cleanupOrphanNotePhotos,
  NOTE_PHOTO_MAX_BYTES, NOTE_PHOTO_ALLOWED_MIME,
} from '../src/layer2-business/L2-notes/note-photo-storage.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const NOTE_DIR = path.join(os.homedir(), '.webaz', 'note-photos')

// ─── 1. 图片存储 — 内容寻址 + 重哈希 ────────────────────────────
const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.from('test-note-photo-content-'.repeat(30))])
const jpgHash = createHash('sha256').update(jpg).digest('hex')

const w1 = writeNotePhoto(jpg, jpgHash, 'image/jpeg')
expect('写图片 → hash + dedup=false', w1.hash === jpgHash && w1.dedup === false)
expect('blob 落盘', fs.existsSync(path.join(NOTE_DIR, jpgHash.slice(0,2), jpgHash)))
expect('noteBlobExists 返回 true', noteBlobExists(jpgHash) === true)

const w2 = writeNotePhoto(jpg, jpgHash, 'image/jpeg')
expect('重复写入 → dedup=true', w2.dedup === true)

// hash 不匹配
let e1 = ''
try { writeNotePhoto(jpg, 'a'.repeat(64), 'image/jpeg') } catch (e) { e1 = (e as Error).message }
expect('hash 不匹配 → photo_hash_mismatch', e1 === 'photo_hash_mismatch')

// 空 blob
let e2 = ''
try { writeNotePhoto(Buffer.alloc(0), createHash('sha256').update(Buffer.alloc(0)).digest('hex'), 'image/jpeg') } catch (e) { e2 = (e as Error).message }
expect('空 blob → photo_empty', e2 === 'photo_empty')

// 超大
const big = Buffer.alloc(NOTE_PHOTO_MAX_BYTES + 1)
const bigHash = createHash('sha256').update(big).digest('hex')
let e3 = ''
try { writeNotePhoto(big, bigHash, 'image/jpeg') } catch (e) { e3 = (e as Error).message }
expect('超过 5MB → photo_too_large', e3 === 'photo_too_large')

// 禁用 mime
let e4 = ''
try { writeNotePhoto(jpg, jpgHash, 'application/x-evil') } catch (e) { e4 = (e as Error).message }
expect('禁用 mime → photo_mime_not_allowed', e4 === 'photo_mime_not_allowed')

// ─── 2. 读图片 + 完整性 ────────────────────────────────────────
const r1 = readNotePhoto(jpgHash)
expect('读图片 mime sniff 出 image/jpeg', r1.mime === 'image/jpeg')
expect('读图片 blob 长度一致', r1.blob.length === jpg.length)

// PNG 嗅探
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.from('png-fake-content'.repeat(20))
])
const pngHash = createHash('sha256').update(png).digest('hex')
writeNotePhoto(png, pngHash, 'image/png')
const r2 = readNotePhoto(pngHash)
expect('PNG mime sniff', r2.mime === 'image/png')

// 不存在
let e5 = ''
try { readNotePhoto('0'.repeat(64)) } catch (e) { e5 = (e as Error).message }
expect('不存在 → photo_not_found', e5 === 'photo_not_found')

// bad hash format
let e6 = ''
try { readNotePhoto('not-a-hash') } catch (e) { e6 = (e as Error).message }
expect('bad hash → photo_bad_hash', e6 === 'photo_bad_hash')

// ─── 3. 笔记业务逻辑（复刻 server 校验，验证逻辑正确性）─────
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT, name TEXT, region TEXT, permanent_code TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, product_id TEXT, status TEXT);
  CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, seller_id TEXT);
  CREATE TABLE shareables (
    id TEXT PRIMARY KEY, owner_id TEXT, type TEXT,
    title TEXT, description TEXT, native_text TEXT,
    related_product_id TEXT, related_order_id TEXT, parent_id TEXT,
    photo_hashes TEXT, status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
`)
db.prepare(`INSERT INTO users VALUES ('buyer1','b1','买家A','global','PC_BUYER1')`).run()
db.prepare(`INSERT INTO users VALUES ('buyer2','b2','买家B','global','PC_BUYER2')`).run()
db.prepare(`INSERT INTO users VALUES ('seller1','s1','卖家A','global','PC_SELLER1')`).run()
db.prepare(`INSERT INTO products VALUES ('prd_x','商品A','seller1')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_1','buyer1','seller1','prd_x','completed')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_2','buyer1','seller1','prd_x','completed')`).run()
db.prepare(`INSERT INTO orders VALUES ('ord_3','buyer2','seller1','prd_x','shipped')`).run()  // 未完成

// 复刻 server.ts 笔记校验 + 插入逻辑
type NoteArgs = {
  userId: string; orderId: string; body: string; photoHashes: string[];
  parentId?: string; title?: string;
}
function createNoteAttempt(args: NoteArgs): { ok: boolean; id?: string; error?: string } {
  const order = db.prepare(`SELECT id, buyer_id, status, product_id FROM orders WHERE id = ?`).get(args.orderId) as { id: string; buyer_id: string; status: string; product_id: string } | undefined
  if (!order) return { ok: false, error: 'order_not_found' }
  if (order.buyer_id !== args.userId) return { ok: false, error: 'not_buyer' }
  if (order.status !== 'completed') return { ok: false, error: 'order_not_completed' }
  if (args.body.length < 30) return { ok: false, error: 'body_too_short' }
  if (args.body.length > 1000) return { ok: false, error: 'body_too_long' }
  if (args.photoHashes.length === 0) return { ok: false, error: 'no_photo' }
  if (args.photoHashes.length > 9) return { ok: false, error: 'too_many_photos' }
  // 每订单 1 篇原创
  const dup = db.prepare(`SELECT id FROM shareables WHERE owner_id = ? AND related_order_id = ? AND type = 'note' AND parent_id IS NULL AND status != 'removed' LIMIT 1`).get(args.userId, args.orderId) as { id: string } | undefined
  if (dup && !args.parentId) return { ok: false, error: 'order_already_has_note' }
  // 图 hash 跨笔记唯一
  const usedByOther = db.prepare(`SELECT id, photo_hashes FROM shareables WHERE type = 'note' AND owner_id != ? AND status != 'removed' AND photo_hashes IS NOT NULL`).all(args.userId) as Array<{ id: string; photo_hashes: string }>
  for (const row of usedByOther) {
    try {
      const used: string[] = JSON.parse(row.photo_hashes || '[]')
      const overlap = used.find(h => args.photoHashes.includes(h))
      if (overlap) return { ok: false, error: 'photo_already_used' }
    } catch {}
  }
  const id = 'shr_' + Math.random().toString(36).slice(2, 10)
  db.prepare(`INSERT INTO shareables (id, owner_id, type, native_text, title, related_product_id, related_order_id, parent_id, photo_hashes)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, args.userId, 'note', args.body, args.title || null, order.product_id, args.orderId, args.parentId || null, JSON.stringify(args.photoHashes))
  return { ok: true, id }
}

// 4. buyer-only + completed only
expect('陌生人不能为别人订单发笔记', createNoteAttempt({ userId: 'buyer2', orderId: 'ord_1', body: 'x'.repeat(50), photoHashes: [jpgHash] }).error === 'not_buyer')
expect('未完成订单不能发笔记', createNoteAttempt({ userId: 'buyer2', orderId: 'ord_3', body: 'x'.repeat(50), photoHashes: [pngHash] }).error === 'order_not_completed')

// 5. 字数 + 图片数门禁
expect('正文 < 30 字 → body_too_short', createNoteAttempt({ userId: 'buyer1', orderId: 'ord_1', body: 'short', photoHashes: [jpgHash] }).error === 'body_too_short')
expect('图为空 → no_photo', createNoteAttempt({ userId: 'buyer1', orderId: 'ord_1', body: 'x'.repeat(50), photoHashes: [] }).error === 'no_photo')
expect('图 > 9 → too_many_photos', createNoteAttempt({ userId: 'buyer1', orderId: 'ord_1', body: 'x'.repeat(50), photoHashes: Array(10).fill(jpgHash) }).error === 'too_many_photos')

// 6. 成功创建（body ≥ 30 字）
const validBody = '我用了这个商品三天感觉非常不错推荐购买真心好用值得入手大家可以试试'  // 32 字
const created = createNoteAttempt({ userId: 'buyer1', orderId: 'ord_1', body: validBody, photoHashes: [jpgHash], title: '真实使用感受' })
expect('合规笔记创建成功', created.ok === true && !!created.id, created.error)

// 7. 每订单 1 篇原创
const reBody = '再写一篇看看是否能通过门禁字数也够了应该可以吧再补充几个字凑到三十'
expect('同 order 再发原创 → order_already_has_note', createNoteAttempt({ userId: 'buyer1', orderId: 'ord_1', body: reBody, photoHashes: [pngHash] }).error === 'order_already_has_note')

// 8. 同 order 可以发转发（parent_id 非空）
const repostBody = '转发原帖加上我的补充评价这个商品确实不错值得推荐购买推荐三十字凑齐'
const repost = createNoteAttempt({ userId: 'buyer1', orderId: 'ord_1', body: repostBody, photoHashes: [pngHash], parentId: created.id })
expect('同 order 加 parent_id 可发转发', repost.ok === true, repost.error)

// 9. 图 hash 跨用户唯一
// buyer1 已用 jpgHash，buyer2 来一个新 order 也用 jpgHash → 拒
db.prepare(`INSERT INTO orders VALUES ('ord_4','buyer2','seller1','prd_x','completed')`).run()
const stolen = createNoteAttempt({ userId: 'buyer2', orderId: 'ord_4', body: validBody, photoHashes: [jpgHash] })
expect('剽窃 buyer1 的图 → photo_already_used', stolen.error === 'photo_already_used')

// 10. buyer2 用自己新图 → 通过
const newImg = Buffer.from('buyer2-original-content-' + 'y'.repeat(200))
const newImgHash = createHash('sha256').update(newImg).digest('hex')
writeNotePhoto(newImg, newImgHash, 'image/jpeg')
const b2Body = '我作为另一个买家分享对这个商品的真实使用体验跟前面那位的感受差不多但有些'
const buyer2Note = createNoteAttempt({ userId: 'buyer2', orderId: 'ord_4', body: b2Body, photoHashes: [newImgHash] })
expect('buyer2 用自己新图 → 创建成功', buyer2Note.ok === true, buyer2Note.error)

// 11. 转发链：buyer2 转发 buyer1 的原帖（parent_id 指向 created.id）
db.prepare(`INSERT INTO orders VALUES ('ord_5','buyer2','seller1','prd_x','completed')`).run()
const newImg2 = Buffer.from('buyer2-another-image-content-' + 'z'.repeat(200))
const newImg2Hash = createHash('sha256').update(newImg2).digest('hex')
writeNotePhoto(newImg2, newImg2Hash, 'image/jpeg')
const b2RepostBody = '我也买了这个商品转发买家A的笔记加上自己的体验也很满意推荐给大家'
const buyer2Repost = createNoteAttempt({ userId: 'buyer2', orderId: 'ord_5', body: b2RepostBody, photoHashes: [newImg2Hash], parentId: created.id })
expect('buyer2 转发 buyer1 原帖 → 成功（parent_id 链）', buyer2Repost.ok === true, buyer2Repost.error)

const repostRow = db.prepare(`SELECT parent_id FROM shareables WHERE id = ?`).get(buyer2Repost.id || '') as { parent_id: string } | undefined
expect('转发的 parent_id 链接到原帖', repostRow?.parent_id === created.id)

// ─── 12. cleanupOrphanNotePhotos — 孤儿 blob 清理 ──────────────
// 需要一个有 note_photo_index 表的 db，使用 db 自己（test 上面已建）
db.exec(`CREATE TABLE note_photo_index (hash TEXT PRIMARY KEY, shareable_id TEXT NOT NULL)`)
// 把 jpgHash, pngHash, newImgHash, newImg2Hash 都登记到 index — 它们被 "笔记" 引用
for (const h of [jpgHash, pngHash, newImgHash, newImg2Hash]) {
  db.prepare(`INSERT OR IGNORE INTO note_photo_index VALUES (?, 'shr_test')`).run(h)
}
// 写一个孤儿 blob — 模拟用户上传图但没创建笔记
const orphan = Buffer.from('orphan-content-' + 'q'.repeat(200))
const orphanHash = createHash('sha256').update(orphan).digest('hex')
writeNotePhoto(orphan, orphanHash, 'image/jpeg')
const orphanPath = path.join(NOTE_DIR, orphanHash.slice(0, 2), orphanHash)
expect('orphan blob 已写入', fs.existsSync(orphanPath))

// grace=0 立刻清 — 一般 grace=1h 防 race，但测试设为 0 跳过等待
const cleaned1 = cleanupOrphanNotePhotos(db, 0)
expect('cleanup 扫掉 orphan blob ≥1', cleaned1.swept >= 1)
expect('cleanup 报告字节数 ≥ orphan 大小', cleaned1.bytes >= orphan.length)
expect('orphan blob 已从磁盘删除', !fs.existsSync(orphanPath))

// 已 index 的 blob 保留
for (const h of [jpgHash, pngHash, newImgHash, newImg2Hash]) {
  const p = path.join(NOTE_DIR, h.slice(0, 2), h)
  expect(`已引用 blob ${h.slice(0,8)} 保留`, fs.existsSync(p))
}

// 再次清扫 → 0 个（已扫干净）
const cleaned2 = cleanupOrphanNotePhotos(db, 0)
expect('再次清扫 → 0 swept', cleaned2.swept === 0)

// grace 窗口生效：新孤儿 + grace=1h → 不清
const orphan2 = Buffer.from('orphan2-' + 'r'.repeat(200))
const orphan2Hash = createHash('sha256').update(orphan2).digest('hex')
writeNotePhoto(orphan2, orphan2Hash, 'image/jpeg')
const cleaned3 = cleanupOrphanNotePhotos(db, 60 * 60 * 1000)  // 1 小时 grace
expect('grace 内孤儿 → 不清', cleaned3.swept === 0)
const orphan2Path = path.join(NOTE_DIR, orphan2Hash.slice(0, 2), orphan2Hash)
expect('grace 内孤儿仍在磁盘', fs.existsSync(orphan2Path))

// 清理测试残留 blob
try {
  for (const h of [jpgHash, pngHash, newImgHash, newImg2Hash, orphan2Hash]) {
    const p = path.join(NOTE_DIR, h.slice(0, 2), h)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
} catch {}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
