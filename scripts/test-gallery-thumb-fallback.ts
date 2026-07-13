#!/usr/bin/env tsx
/**
 * Detail-gallery thumbnail fallback test (app-product-gallery.js + app.js hydrate wiring) — pt.4 of the
 * list-image fix.
 *
 * Bug: the detail gallery resolved a hash ONLY via GET /manifests/by-product/:pid. manifest_registry.hash is
 * globally UNIQUE with a single related_product_id, so a listing that reuses an image hash first registered
 * under another product got 0 manifests → "图片暂不可达（卖家节点离线）" although the thumbnail exists and the
 * public by-hash endpoint /api/manifests/:hash/thumb serves it (product cards already resolve this way).
 *
 * Fix: resolveGalleryUrls (extracted to app-product-gallery.js) falls back to window.productThumbSrc([h])
 * (same resolver as cards) when the by-product lookup misses; a 404 (truly unregistered hash) degrades via
 * the main <img> onerror → galleryMainImgFail.
 *
 * Usage: npm run test:gallery-thumb-fallback
 */
import { readFileSync } from 'node:fs'

const APPJS = readFileSync('src/pwa/public/app.js', 'utf8')
const MEDIA = readFileSync('src/pwa/public/app-product-media.js', 'utf8')
const GALLERY = readFileSync('src/pwa/public/app-product-gallery.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// 1. behavioral — eval the real resolveGalleryUrls with fake window/p2pGetContent
const H_LOCAL = 'a'.repeat(64)   // buyer already holds the blob locally
const H_LINKED = 'b'.repeat(64)  // manifest linked to THIS product (by-product lookup hits)
const H_SHARED = 'c'.repeat(64)  // hash registered under ANOTHER product (by-product misses) → by-hash /thumb
const w: Record<string, any> = {}
;(new Function('window', MEDIA))(w)
const fakeBlobUrl = 'blob:fake-object-url'
const sandbox = {
  window: w,
  p2pGetContent: async (h: string) => (h === H_LOCAL ? { blob: {} } : null),
  URL: { createObjectURL: () => fakeBlobUrl },
}
;(new Function('window', 'p2pGetContent', 'URL', GALLERY))(sandbox.window, sandbox.p2pGetContent, sandbox.URL)
const byHash = { [H_LINKED]: { thumbnail_data_uri: 'data:image/jpeg;base64,LINKED' } }
const urls = await w.resolveGalleryUrls([H_LOCAL, H_LINKED, H_SHARED], byHash)
ok('1a. local IDB blob wins → object URL', urls[0] === fakeBlobUrl)
ok('1b. by-product manifest thumbnail second', urls[1] === 'data:image/jpeg;base64,LINKED')
ok('1c. by-product miss → shared by-hash /thumb fallback (cross-product image reuse)',
  urls[2] === `/api/manifests/${H_SHARED}/thumb`)

// 2. app.js hydrate wiring routes through the extracted resolver
const hydrate = APPJS.slice(APPJS.indexOf('async function hydrateProductGallery'), APPJS.indexOf('window.switchGalleryImage'))
ok('2a. hydrateProductGallery delegates to window.resolveGalleryUrls', has(hydrate, 'window.resolveGalleryUrls(hashes, byHash)'))
ok('2b. no leftover inline by-product-only resolution in hydrate', !has(hydrate, 'thumbnail_data_uri'))

// 3. 404 degrade path: main <img> onerror → unavailable notice (truly unregistered hash)
ok('3a. gallery main img has onerror → galleryMainImgFail', has(APPJS, `onerror="galleryMainImgFail('\${pid}')"`))
ok('3b. galleryMainImgFail defined and shows the unavailable notice', has(GALLERY, 'window.galleryMainImgFail =') && has(GALLERY, "loading.textContent = '🌐 ' + t('图片暂不可达（卖家节点离线）')"))
ok('3c. switchGalleryImage re-hides the notice when a good image is selected',
  APPJS.slice(APPJS.indexOf('window.switchGalleryImage'), APPJS.indexOf('window.openImageLightbox')).includes("loading.style.display = 'none'"))

// 4. new file wired: load order + Guard B (check:pwa-syntax + LOC ceiling)
ok('4a. index.html loads app-product-gallery.js after media, before app.js',
  HTML.indexOf('/app-product-media.js') < HTML.indexOf('/app-product-gallery.js') && HTML.indexOf('/app-product-gallery.js') < HTML.indexOf('/app.js'))
ok('4b. app-product-gallery.js in check:pwa-syntax', has(PKG, 'node --check src/pwa/public/app-product-gallery.js'))
ok('4c. app-product-gallery.js has a LOC ceiling', /'src\/pwa\/public\/app-product-gallery\.js':/.test(RATCHET))

if (fail > 0) { console.error(`\n❌ gallery thumb fallback FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ gallery thumb fallback: by-product miss → shared by-hash /thumb resolver + onerror degrade\n  ✅ pass ${pass}`)
