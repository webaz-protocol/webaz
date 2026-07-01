#!/usr/bin/env tsx
/**
 * Source-contract test — product-type selector in the seller listing form.
 *
 * The create form previously had NO product_type picker (always defaulted to 'retail'), so
 * service / digital / wholesale sellers could not list correctly. This asserts the selector is
 * wired end-to-end: UI <select> → doAddProduct read → POST /products payload → backend enum.
 *
 * Usage: npm run test:listing-product-type
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const CREATE = readFileSync('src/pwa/routes/products-create.ts', 'utf8')
const SERVER = readFileSync('src/pwa/server.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (h: string, n: string) => h.includes(n)

// 1. selector present with all 4 enum options (labels via t())
ok('1. product-type <select id="prd-type"> present', has(APP, 'id="prd-type"'))
for (const [v, label] of [['retail', '零售'], ['wholesale', '批发'], ['service', '服务'], ['digital', '数字']]) {
  ok(`1. option ${v} → t('${label}')`, has(APP, `<option value="${v}">${'$'}{t('${label}')}</option>`))
}

// 2. doAddProduct reads the selected type (fail-safe default retail) and sends it in the payload
ok('2a. doAddProduct reads prd-type (default retail)', has(APP, "document.getElementById('prd-type')?.value || 'retail'"))
ok('2b. payload includes product_type', has(APP, 'product_type: productType,'))

// 3. i18n parity: label + all 4 option labels have EN
for (const k of ['商品类型', '零售', '批发', '服务', '数字']) ok(`3. i18n EN entry: ${k}`, has(I18N, `'${k}':`))

// 4. backend still validates against the same 4-type enum (selector values must be accepted)
ok('4a. products-create validates product_type against VALID_PRODUCT_TYPES', /VALID_PRODUCT_TYPES\.has\(product_type\)/.test(CREATE))
const setDef = /VALID_PRODUCT_TYPES = new Set\(\[([^\]]*)\]\)/.exec(SERVER)?.[1] || ''
for (const v of ['retail', 'wholesale', 'service', 'digital']) ok(`4b. VALID_PRODUCT_TYPES set has ${v}`, setDef.includes(`'${v}'`))

if (fail > 0) { console.error(`\n❌ listing product-type selector FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ listing product-type selector: UI select → doAddProduct → payload → backend enum, bilingual\n  ✅ pass ${pass}`)
