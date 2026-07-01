#!/usr/bin/env tsx
/**
 * Security + contract test — public product thumbnail endpoint GET /api/manifests/:hash/thumb.
 *
 * Public (product-card <img> can't send auth), so it must not trust stored content: raster-only whitelist,
 * FORCED content-type + nosniff, active-only, hash-format guard, size guard, immutable cache. Also asserts
 * the publish side rejects non-image thumbnail data URIs (defense in depth).
 *
 * Usage: npm run test:thumb-endpoint
 */
import { readFileSync } from 'node:fs'

const M = readFileSync('src/pwa/routes/manifests.ts', 'utf8')
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// endpoint block
const blk = (/app\.get\('\/api\/manifests\/:hash\/thumb'[\s\S]*?\n {2}\}\)/.exec(M) || [''])[0]
ok('0. thumb endpoint exists', blk.length > 0)

// 1. BEHAVIORAL — reconstruct the real whitelist regex from source and test it
const reLit = (/const THUMB_DATA_URI_RE = (\/[^\n]+\/)\n/.exec(M) || [])[1]
ok('1-src. THUMB_DATA_URI_RE defined', !!reLit)
// eslint-disable-next-line no-eval
const RE: RegExp = reLit ? eval(reLit) : /$^/
ok('1a. svg data-URI rejected', !RE.test('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='))
ok('1b. text/html data-URI rejected', !RE.test('data:text/html;base64,PHNjcmlwdD4='))
ok('1c. bare/garbage rejected', !RE.test('javascript:alert(1)') && !RE.test('data:;base64,AAAA') && !RE.test('http://x/y.jpg'))
ok('1d. jpeg accepted', RE.test('data:image/jpeg;base64,/9j/4AAQSkZJRg=='))
ok('1e. png accepted', RE.test('data:image/png;base64,iVBORw0KGgo='))
ok('1f. webp accepted', RE.test('data:image/webp;base64,UklGRg=='))

// 2. SECURITY hardening in the endpoint block
ok('2a. PUBLIC (no auth() gate in the block)', !blk.includes('auth(req'))
ok('2b. :hash format guard (64-hex)', /\[0-9a-f\]\{64\}/i.test(blk))
ok('2c. active-only', blk.includes("status !== 'active'"))
ok('2d. whitelist applied to stored value', blk.includes('THUMB_DATA_URI_RE.exec(m.thumbnail_data_uri)'))
ok('2e. Content-Type FORCED from parsed subtype (not echoed)', blk.includes('`image/${parsed[1]}`'))
ok('2f. X-Content-Type-Options: nosniff', blk.includes("'X-Content-Type-Options', 'nosniff'"))
ok('2g. short revalidatable cache — NOT long/immutable (honors takedown)', blk.includes('max-age=300') && blk.includes('must-revalidate') && !blk.includes('immutable') && !blk.includes('31536000'))
ok('2h. size guard', /buf\.length > 64 \* 1024/.test(blk))
ok('2i. only thumbnail column selected (no full-res/metadata leak)', blk.includes('SELECT thumbnail_data_uri, status FROM manifest_registry'))

// 3. publish-side defense in depth: reject non-image thumbnail data URIs on write
ok('3. publish rejects non-whitelisted thumbnail_data_uri', /!THUMB_DATA_URI_RE\.test\(thumbnail_data_uri\)/.test(M))

if (fail > 0) { console.error(`\n❌ product thumb endpoint FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product thumb endpoint: public raster-only, forced content-type + nosniff, active-only, size/format/hash guards, short revalidatable cache\n  ✅ pass ${pass}`)
