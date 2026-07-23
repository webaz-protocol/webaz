// A0 — ACP feed 图片链接回归 + 公开缩略图 JPEG 转码。
//   病根(生产 108/108 坏图链):旧 absolutizeImg 对 64-hex content hash 拼 https://webaz.xyz/<hash>,
//   返回的是 SPA 壳 HTML 而非图片。修法 = 与前端 productThumbSrc 同规则:hash → /api/manifests/<hash>/thumb?format=jpeg。
//   铁则:feed 只发可公网 GET 的图片 URL(hash/http(s)/根相对);data:/未知形状 → 不发,绝不拼域名造坏链。
//   thumb 端点:?format=jpeg 按需转码(ACP 只收 JPEG/PNG),Content-Type 永远反映实际字节,绝不假报。
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'acpfeed-'))
import express, { type Request, type Response } from 'express'
import { createServer, type Server } from 'node:http'
import sharp from 'sharp'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initManifestRegistrySchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { buildAcpProductFeed } = await import('../src/pwa/acp-feed.js')
const { registerManifestsRoutes } = await import('../src/pwa/routes/manifests.js')

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown): void => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = initDatabase()
setSeamDb(db)
initManifestRegistrySchema(db)
try { db.exec('ALTER TABLE products ADD COLUMN sale_regions TEXT') } catch { /* 已有 */ }
try { db.exec('ALTER TABLE users ADD COLUMN store_sale_regions TEXT') } catch { /* 已有 */ }

const HASH = 'B569FECF0F5998FBEA7A61C20EC627891E448D79A43E066D97CC6A514A6DAD47'  // 大写喂入,断言输出已归一小写
const HASH_LC = HASH.toLowerCase()

db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('usr_s1','S1','seller','k1')").run()
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('usr_s2','S2','seller','k2')").run()
const insP = db.prepare('INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,images,sale_regions) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
insP.run('prd_hash', 'usr_s1', 'Hash 图', 'd', 10, 'WAZ', 5, 'x', 'active', JSON.stringify([HASH]), null)
insP.run('prd_http', 'usr_s1', '外链图', 'd', 10, 'WAZ', 5, 'x', 'active', JSON.stringify(['https://cdn.example/x.jpg']), null)
insP.run('prd_rel', 'usr_s1', '根相对图', 'd', 10, 'WAZ', 5, 'x', 'active', JSON.stringify(['/static/a.png']), null)
insP.run('prd_data', 'usr_s1', 'dataURI 图', 'd', 10, 'WAZ', 5, 'x', 'active', JSON.stringify(['data:image/png;base64,AAAA']), null)
insP.run('prd_junk', 'usr_s1', '垃圾引用', 'd', 10, 'WAZ', 5, 'x', 'active', JSON.stringify(['not-a-url-or-hash']), null)
insP.run('prd_multi', 'usr_s1', '多图', 'd', 10, 'WAZ', 5, 'x', 'active', JSON.stringify([HASH_LC, 'https://cdn.example/y.jpg']), null)
insP.run('prd_regions', 'usr_s2', '跨境规则', 'd', 10, 'WAZ', 5, 'x', 'active', '[]', JSON.stringify({ mode: 'list', include: ['SG', 'US', 'MY', 'SEA'], exclude: ['MY'] }))
insP.run('prd_excl_sg', 'usr_s2', '排除SG', 'd', 10, 'WAZ', 5, 'x', 'active', '[]', JSON.stringify({ mode: 'all', exclude: ['SG'] }))
insP.run('prd_no_iso', 'usr_s2', '无ISO目标', 'd', 10, 'WAZ', 5, 'x', 'active', '[]', JSON.stringify({ mode: 'list', include: ['SEA'] }))

const feed = buildAcpProductFeed(db) as { products: Array<Record<string, unknown>>; compatibility: { non_compliant_points: string[] } }
const by = (id: string): Record<string, unknown> => feed.products.find((p) => p.item_id === id) || {}

// ── 图片引用 → URL 映射(与前端 productThumbSrc 同规则)──
expect('hash → 公开缩略图端点(?format=jpeg,hash 归一小写)', by('prd_hash').image_url === `https://webaz.xyz/api/manifests/${HASH_LC}/thumb?format=jpeg`, by('prd_hash').image_url)
expect('http(s) → 原样透传', by('prd_http').image_url === 'https://cdn.example/x.jpg')
expect('根相对路径 → 绝对化', by('prd_rel').image_url === 'https://webaz.xyz/static/a.png')
expect('data: URI → 不发 image_url(非公网 URL)', !('image_url' in by('prd_data')), by('prd_data').image_url)
expect('未知形状 → 不发 image_url(绝不拼域名造坏链)', !('image_url' in by('prd_junk')), by('prd_junk').image_url)
expect('多图:首图 hash → thumb,余图进 additional_image_urls', by('prd_multi').image_url === `https://webaz.xyz/api/manifests/${HASH_LC}/thumb?format=jpeg` && by('prd_multi').additional_image_urls === 'https://cdn.example/y.jpg', by('prd_multi'))

// ── merchant-level 必填字段 ──
expect('每个 item 发 store_country=SG', feed.products.every((p) => p.store_country === 'SG'))
expect('无跨境规则 → target_countries 保守 [SG]', JSON.stringify(by('prd_hash').target_countries) === '["SG"]', by('prd_hash').target_countries)
expect('list 规则 → include−exclude,非 ISO alpha-2(SEA)过滤', JSON.stringify(by('prd_regions').target_countries) === '["SG","US"]', by('prd_regions').target_countries)
expect('all 模式且 exclude SG → 省略字段,不虚报 SG', !('target_countries' in by('prd_excl_sg')), by('prd_excl_sg').target_countries)
expect('list 过滤后无 ISO 目标 → 省略字段,不虚报', !('target_countries' in by('prd_no_iso')), by('prd_no_iso').target_countries)
expect('non_compliant_points 不再声明缺 merchant 字段', !feed.compatibility.non_compliant_points.some((s) => s.includes('target_countries')), feed.compatibility.non_compliant_points)

// ── 前端/后端映射关系锁定(防两侧漂移;差异是刻意的:BASE 前缀 + hash 小写 + ?format=jpeg)──
const { readFileSync } = await import('fs')
const w = { productThumbSrc: undefined as unknown as (i: unknown) => string }
;(globalThis as Record<string, unknown>).__paw = w
;(0, eval)(readFileSync(new URL('../src/pwa/public/app-product-media.js', import.meta.url), 'utf-8').replace(/window\./g, '__paw.'))
const feUrl = w.productThumbSrc(JSON.stringify([HASH]))
expect('前端 hash → /api/manifests/<hash>/thumb(同一端点)', feUrl === `/api/manifests/${HASH}/thumb`, feUrl)
expect('feed URL = BASE + 前端路径(hash 归一小写)+ ?format=jpeg', by('prd_hash').image_url === `https://webaz.xyz${feUrl.replace(HASH, HASH_LC)}?format=jpeg`, { fe: feUrl, feed: by('prd_hash').image_url })

// ── 公开缩略图端点:?format=jpeg 转码,Content-Type 诚实 ──
const webpBuf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toBuffer()
db.prepare(`INSERT INTO manifest_registry (hash, owner_id, content_type, byte_size, title, thumbnail_data_uri, signature, signed_at, status)
  VALUES (?, 'usr_s1', 'image/webp', ?, 't', ?, 'sig', datetime('now'), 'active')`)
  .run(HASH_LC, webpBuf.length, `data:image/webp;base64,${webpBuf.toString('base64')}`)

const app = express()
app.use(express.json())
registerManifestsRoutes(app, {
  db,
  auth: () => ({ id: 'usr_s1', role: 'seller' }),
  safeRoles: () => ['seller'],
})
const server: Server = createServer(app)
await new Promise<void>((r) => server.listen(0, r))
const port = (server.address() as { port: number }).port
const get = async (path: string): Promise<{ status: number; type: string; buf: Buffer }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, type: res.headers.get('content-type') || '', buf: Buffer.from(await res.arrayBuffer()) }
}

const plain = await get(`/api/manifests/${HASH_LC}/thumb`)
expect('无 format:原格式原样(webp)', plain.status === 200 && plain.type === 'image/webp', { s: plain.status, t: plain.type })
const jpeg = await get(`/api/manifests/${HASH_LC}/thumb?format=jpeg`)
expect('format=jpeg:转码为 JPEG(Content-Type 与字节一致)', jpeg.status === 200 && jpeg.type === 'image/jpeg' && jpeg.buf[0] === 0xff && jpeg.buf[1] === 0xd8, { s: jpeg.status, t: jpeg.type, magic: jpeg.buf.subarray(0, 2).toString('hex') })
const png = await get(`/api/manifests/${HASH_LC}/thumb?format=png`)
expect('不支持的 format 值:忽略,发原格式', png.status === 200 && png.type === 'image/webp', { s: png.status, t: png.type })
expect('feed 首图 URL 与端点行为闭环(同一 hash 可加载 JPEG)', by('prd_hash').image_url === `https://webaz.xyz/api/manifests/${HASH_LC}/thumb?format=jpeg` && jpeg.type === 'image/jpeg')

server.close()
console.log(`\n${pass} pass · ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
