#!/usr/bin/env tsx
/**
 * Product-image UI test (app-product-image-ui.js) — pt.5 of the list-image fix + gallery swipe nav.
 *
 * Bug: the 新品发现 grid (renderNewArrivals), the plain products grid, the trending grid and
 * renderSearchResults still rendered `class="product-img">${getCategoryIcon(...)}` — category emoji
 * only, ignoring p.images although the payload carries the hashes (missed by the pt.2 card fix).
 * Feature: the detail gallery main image had no touch navigation — buyers could not swipe
 * left/right to move between photos (only the thumb strip switched images).
 *
 * Usage: npm run test:product-image-ui
 */
import { readFileSync } from 'node:fs'

const UI = readFileSync('src/pwa/public/app-product-image-ui.js', 'utf8')
const MEDIA = readFileSync('src/pwa/public/app-product-media.js', 'utf8')
const DISCOVER = readFileSync('src/pwa/public/app-discover.js', 'utf8')
const APPJS = readFileSync('src/pwa/public/app.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// 1. behavioral — productCardImg routes through the shared resolver
const w: Record<string, any> = {}
;(new Function('window', MEDIA))(w)
const escAttr = (x: unknown) => String(x || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;')
;(new Function('window', 'getCategoryIcon', 'escAttr', UI))(w, () => '🧲', escAttr)
const H = 'd'.repeat(64)
const withImg = w.productCardImg({ images: `["${H}"]`, category: 'digital' })
ok('1a. product with hash → <img> via public /thumb', withImg.includes(`/api/manifests/${H}/thumb`) && withImg.startsWith('<img'))
ok('1b. card img keeps the onerror → 📦 degrade idiom', withImg.includes(`onerror="this.outerHTML='📦'"`))
ok('1c. no image → category icon fallback', w.productCardImg({ images: '[]', category: 'digital' }) === '🧲')
const evil = w.productCardImg({ images: ['/x" onerror="alert(document.domain)'], category: 'digital' })
ok('1d. seller-controlled URI cannot break out of src (escAttr)', !evil.includes('src="/x" onerror="alert') && evil.includes('&quot;'))

// 2. all four missed grid sites now route through productCardImg; none left on icon-only
ok('2a. discover grids use productCardImg', (DISCOVER.match(/class="product-img">\$\{window\.productCardImg\(p\)\}/g) || []).length === 4)
ok('2b. no icon-only product-img cell remains in discover', !has(DISCOVER, 'class="product-img">${getCategoryIcon'))

// 3. behavioral — swipe nav: threshold + direction + wrap-around via switchGalleryImage
const calls: number[][] = []
const wrapEl = { dataset: { galIdx: '0' }, querySelectorAll: () => [{}, {}, {}] }  // 3 张图
const doc = { getElementById: () => wrapEl }
const w2: Record<string, any> = {}
;(new Function('window', 'getCategoryIcon', 'document', 'escAttr', UI))(w2, () => '', doc, escAttr)
w2.switchGalleryImage = (pid: string, idx: number) => calls.push([idx])
w2.galleryTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
w2.galleryTouchEnd('p1', { changedTouches: [{ clientX: 100, clientY: 105 }] })   // 左滑 100px → 下一张
ok('3a. left swipe → next image', calls.length === 1 && calls[0][0] === 1)
w2.galleryTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
w2.galleryTouchEnd('p1', { changedTouches: [{ clientX: 220, clientY: 100 }] })   // 20px 轻点 → 不动
ok('3b. small movement ignored (threshold)', calls.length === 1)
w2.galleryTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
w2.galleryTouchEnd('p1', { changedTouches: [{ clientX: 140, clientY: 300 }] })   // 垂直为主 → 不动
ok('3c. vertical scroll not hijacked', calls.length === 1)
wrapEl.dataset.galIdx = '0'
w2.galleryTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })
w2.galleryTouchEnd('p1', { changedTouches: [{ clientX: 250, clientY: 100 }] })   // 右滑 → 上一张(wrap 到末张)
ok('3d. right swipe wraps to last image', calls.length === 2 && calls[1][0] === 2)
wrapEl.querySelectorAll = () => [{}]                                              // 单图商品
w2.galleryTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
w2.galleryTouchEnd('p1', { changedTouches: [{ clientX: 100, clientY: 100 }] })
ok('3e. single-image product: swipe is a no-op', calls.length === 2)

// 4. app.js wiring: touch handlers on the gallery container + galIdx maintained + lightbox opens at current
ok('4a. gallery container has ontouchstart/ontouchend', has(APPJS, `ontouchstart="galleryTouchStart(event)"`) && has(APPJS, `ontouchend="galleryTouchEnd('\${pid}', event)"`))
ok('4b. switchGalleryImage maintains wrap.dataset.galIdx', has(APPJS, 'wrap.dataset.galIdx = idx'))
ok('4c. main-img click opens lightbox at current index', has(APPJS, "openImageLightbox('${pid}', Number(this.closest('[data-hashes]').dataset.galIdx||0))"))

// 5. new file wired: load order + Guard B
ok('5a. index.html loads app-product-image-ui.js after media/gallery, before app.js',
  HTML.indexOf('/app-product-gallery.js') < HTML.indexOf('/app-product-image-ui.js') && HTML.indexOf('/app-product-image-ui.js') < HTML.indexOf('/app.js'))
ok('5b. app-product-image-ui.js in check:pwa-syntax', has(PKG, 'node --check src/pwa/public/app-product-image-ui.js'))
ok('5c. app-product-image-ui.js has a LOC ceiling', /'src\/pwa\/public\/app-product-image-ui\.js':/.test(RATCHET))

if (fail > 0) { console.error(`\n❌ product image UI FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product image UI: 4 missed grids → real thumbnails + gallery swipe nav (threshold/wrap/no-op)\n  ✅ pass ${pass}`)
