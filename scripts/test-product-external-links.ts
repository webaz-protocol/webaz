#!/usr/bin/env tsx
/**
 * Source-contract + behavioral test — product detail external-link jump (app-external-links.js).
 *
 * Buyers can jump to the seller's verified source-platform detail page. Security is the point:
 * only http/https URLs are clickable (blocks javascript:/data:), the domain is shown, links open
 * with target=_blank rel="noopener noreferrer". Unverified links render non-clickable.
 *
 * Usage: npm run test:external-links
 */
import { readFileSync } from 'node:fs'

const SRC     = readFileSync('src/pwa/public/app-external-links.js', 'utf8')
const APP     = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N    = readFileSync('src/pwa/public/i18n.js', 'utf8')
const HTML    = readFileSync('src/pwa/public/index.html', 'utf8')
const LINKS   = readFileSync('src/pwa/routes/products-links.ts', 'utf8')
const PKG     = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// 1. BEHAVIORAL — eval the real safeExternalUrl (only needs a fake window + node's URL/setTimeout)
const w: Record<string, (u: unknown) => URL | null> = {} as never
;(new Function('window', SRC))(w)
const safe = w.safeExternalUrl
ok('1a. javascript: URL rejected', safe('javascript:alert(1)') === null)
ok('1b. data: URL rejected', safe('data:text/html,<script>1</script>') === null)
ok('1c. relative/garbage rejected', safe('/foo') === null && safe('not a url') === null && safe('') === null)
ok('1d. http allowed (hostname parsed)', safe('http://shop.example.com/p/1')?.hostname === 'shop.example.com')
ok('1e. https allowed', safe('https://item.taobao.com/x')?.hostname === 'item.taobao.com')

// 2. SECURITY source-contract in the render
ok('2a. protocol allowlist is http/https only', has(SRC, "url.protocol === 'http:' || url.protocol === 'https:'"))
ok('2b. links open with target=_blank rel=noopener noreferrer', has(SRC, 'target="_blank" rel="noopener noreferrer"'))
ok('2c. target domain (hostname) shown to buyer', has(SRC, 'escHtml(url.hostname)') || has(SRC, 'url.hostname'))
ok('2d. non-http(s) links skipped (no button rendered)', has(SRC, "if (!url) return ''"))

// 3. DATA CONTRACT — the buyer-facing read (PR #156 P1 fix): the frontend must call the buyer endpoint that
//    is NOT owner-gated and returns { links } verified+non-revoked (the old owner-only /links returns a bare
//    array and 403s buyers, so it must NOT be used here).
ok('3a. frontend calls the buyer endpoint /:id/external-links', has(SRC, '/products/${productId}/external-links') && !has(SRC, '/products/${productId}/links`'))
ok('3b. frontend reads { links } shape', has(SRC, '(r && r.links) || []'))
// scope backend asserts to the buyer endpoint's own block (avoids matching the neighboring POST)
const extBlock = (/app\.get\('\/api\/products\/:id\/external-links'[\s\S]*?\n {2}\}\)/.exec(LINKS) || [''])[0]
ok('3c-backend. buyer endpoint returns { links }, not owner-only (no "seller_id !== user.id" gate / 403)',
  extBlock.includes('res.json({ links })') && !extBlock.includes('!== user.id') && !extBlock.includes('403'))
ok('3d-backend. buyer endpoint filters verified=1 AND revoked=0', extBlock.includes('verified = 1 AND revoked = 0'))
ok('3f-backend. mirrors product-detail visibility (active OR seller), else 404 (no warehouse leak)',
  extBlock.includes("status = 'active' OR seller_id = ?") && extBlock.includes("error: 'not_found'"))
ok('3e. existing owner-only /links (bare array) left intact for the seller workbench', /app\.get\('\/api\/products\/:id\/links'[\s\S]*?res\.json\(links\)/.test(LINKS))

// 4. wiring: detail page hook + load order + i18n + Guard B (check:pwa-syntax + LOC_CEILINGS)
ok('4-hook. renderBuyPage hooks extLinksBarHtml after the title', has(APP, "</h2>${window.extLinksBarHtml ? window.extLinksBarHtml(productId) : ''}"))
ok('4-load. index.html loads app-external-links.js before app.js', HTML.indexOf('/app-external-links.js') > 0 && HTML.indexOf('/app-external-links.js') < HTML.indexOf('/app.js'))
ok('4-i18n. i18n EN entry: 前往源平台查看详情', has(I18N, "'前往源平台查看详情':"))
ok('4-syntax. app-external-links.js in check:pwa-syntax', has(PKG, 'node --check src/pwa/public/app-external-links.js'))
ok('4-ceiling. app-external-links.js has a LOC ceiling', /'src\/pwa\/public\/app-external-links\.js':/.test(RATCHET))

if (fail > 0) { console.error(`\n❌ product external-links FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product external-links: verified-only jump button, http/https-only sanitizer (js:/data: blocked), domain shown, noopener\n  ✅ pass ${pass}`)
