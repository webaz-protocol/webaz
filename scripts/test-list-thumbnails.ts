#!/usr/bin/env tsx
/**
 * List/card thumbnail resolver test (app-product-media.js) — pt.2 of the list-image fix.
 *
 * Cards rendered a raw content hash as <img src> (broken 📦). productThumbSrc maps a stored image ref to a
 * loadable src (hash → the public /api/manifests/:hash/thumb endpoint; data:/http(s) passthrough), and card
 * <img>s pair it with onerror → 📦 for the missing-manifest (404) fallback.
 *
 * Usage: npm run test:list-thumbnails
 */
import { readFileSync } from 'node:fs'

const MEDIA = readFileSync('src/pwa/public/app-product-media.js', 'utf8')
const SHOP = readFileSync('src/pwa/public/app-shop.js', 'utf8')
const DISCOVER = readFileSync('src/pwa/public/app-discover.js', 'utf8')
const APPJS = readFileSync('src/pwa/public/app.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// 1. BEHAVIORAL — eval the real productThumbSrc (pure: only needs a fake window)
const w: Record<string, (i: unknown) => string> = {} as never
;(new Function('window', MEDIA))(w)
const src = w.productThumbSrc
const H = 'a'.repeat(64)
ok('1a. 64-hex hash → public /thumb endpoint', src(`["${H}"]`) === `/api/manifests/${H}/thumb`)
ok('1b. array input works', src([H]) === `/api/manifests/${H}/thumb`)
ok('1c. CSV legacy string works', src(`${H},somethingelse`) === `/api/manifests/${H}/thumb`)
ok('1d. http(s) URL passthrough', src('["https://cdn.example.com/a.jpg"]') === 'https://cdn.example.com/a.jpg')
ok('1e. data: URL passthrough', src(['data:image/png;base64,iVBORw0KGgo=']) === 'data:image/png;base64,iVBORw0KGgo=')
ok('1f. empty / garbage → ""', src('') === '' && src('[]') === '' && src(null) === '' && src(['   ']) === '')
ok('1g. non-hash non-url token → "" (not rendered as a bare hash-looking src)', src(['not-a-hash-or-url']) === '')

// 2. card sites route through the resolver + have the onerror → 📦 fallback
ok('2a. app-shop uses window.productThumbSrc', has(SHOP, 'window.productThumbSrc(p.images)') && has(SHOP, 'window.productThumbSrc(it.images)'))
ok('2b. app-shop no longer renders a raw imgs[0] hash', !has(SHOP, 'if (Array.isArray(imgs) && imgs[0]) imageUrl = imgs[0]'))
ok('2c. app-shop img has onerror fallback', has(SHOP, `onerror="this.outerHTML='📦'"`))
ok('2d. app-discover feed card uses window.productThumbSrc', has(DISCOVER, 'window.productThumbSrc(p.images)'))
ok('2e. app-discover feed img has onerror fallback', has(DISCOVER, `onerror="this.outerHTML='📦'"`))

// 2b (pt.3). app.js personal-list / feed cards routed through the resolver
ok('2f. buildProductImg delegates to productThumbSrc', has(APPJS, 'const buildProductImg = (images) => window.productThumbSrc'))
ok('2g. app.js inline cards use the resolver (it.images / prod.images)', has(APPJS, 'window.productThumbSrc(it.images)') && has(APPJS, 'window.productThumbSrc(prod.images)'))
ok('2h. app.js no longer renders a raw ${img} without escHtml', !has(APPJS, '<img src="${img}"'))
ok('2i. app.js no leftover inline hash-first resolution (imageUrl = imgs[0])', !has(APPJS, 'imageUrl = imgs[0]'))
ok('2j. app.js card imgs have onerror → 📦 fallback', has(APPJS, `onerror="this.outerHTML='📦'"`))
ok('2k. app.js P2P cards route thumbnail_json (aliased p.images) through resolver', has(APPJS, 'window.productThumbSrc(it.thumbnail_json)') && has(APPJS, 'window.productThumbSrc(p.thumbnail_json)'))
ok('2l. no leftover raw thumb/img = imgs[0] hash render in app.js', !has(APPJS, 'thumb = imgs[0]') && !has(APPJS, 'img = String(imgs[0])'))
// JSON-LD image (structured data / SEO) is intentionally left on the absolute-URL-only filter — a relative
// /thumb URL is not appropriate for schema.org image; the visible card fix is the resolver above.
ok('2m. discover JSON-LD image keeps the absolute-url-only filter (not the relative /thumb)', has(DISCOVER, "filter(s => /^(https?:|\\/|data:)/.test(s))"))

// 3. helper wired: load order + Guard B (check:pwa-syntax + LOC_CEILINGS)
ok('3a. index.html loads app-product-media.js before app.js', HTML.indexOf('/app-product-media.js') > 0 && HTML.indexOf('/app-product-media.js') < HTML.indexOf('/app.js'))
ok('3b. app-product-media.js in check:pwa-syntax', has(PKG, 'node --check src/pwa/public/app-product-media.js'))
ok('3c. app-product-media.js has a LOC ceiling', /'src\/pwa\/public\/app-product-media\.js':/.test(RATCHET))

if (fail > 0) { console.error(`\n❌ list thumbnails FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ list thumbnails: hash→/thumb resolver (behavioral) + shop/discover cards routed through it with onerror→📦 fallback\n  ✅ pass ${pass}`)
