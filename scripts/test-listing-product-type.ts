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

// 5. brand / model in create form (backend already inserted them; this wires the UI)
ok('5a. brand/model inputs present', has(APP, 'id="prd-brand"') && has(APP, 'id="prd-model"'))
ok('5b. doAddProduct reads brand/model', has(APP, "document.getElementById('prd-brand')?.value") && has(APP, "document.getElementById('prd-model')?.value"))
ok('5c. payload includes brand, model', has(APP, 'product_type: productType, brand, model,'))
for (const k of ['品牌', '型号']) ok(`5d. i18n EN entry: ${k}`, has(I18N, `'${k}':`))

// 6. low-stock threshold + auto-delist in create form (UI + backend create-route insert)
ok('6a. low-stock inputs present', has(APP, 'id="prd-low-stock"') && has(APP, 'id="prd-auto-delist"'))
ok('6b. doAddProduct reads low-stock/auto-delist', has(APP, "const lowStock = document.getElementById('prd-low-stock')?.value") && has(APP, "document.getElementById('prd-auto-delist')?.checked ? 1 : 0"))
// P2-1: 0 is a valid value ("0 = no alert"). Frontend must NOT coerce 0→3 (no `|| 3`); empty → undefined so
// the backend default (3) applies, but an explicit 0 is preserved end-to-end (aligns with update route).
ok('6b-1. low-stock read does NOT force 0→3 (no "|| 3")', !has(APP, "prd-low-stock')?.value) || 3"))
ok('6b-2. payload preserves 0, sends undefined only when empty', has(APP, "low_stock_threshold: lowStock === '' || lowStock == null ? undefined : Number(lowStock),"))
ok('6c. payload includes auto_delist_on_zero', has(APP, ' auto_delist_on_zero: autoDelist,'))
ok('6d. create route destructures low_stock_threshold/auto_delist_on_zero (default 3/1)', /low_stock_threshold = 3, auto_delist_on_zero = 1,/.test(CREATE))
ok('6e. create INSERT columns include low_stock_threshold + auto_delist_on_zero', /low_stock_threshold, auto_delist_on_zero,/.test(CREATE))
ok('6e-1. create normalizes low_stock like update route (Math.max(0, floor), preserves 0)', has(CREATE, 'Math.max(0, Math.floor(Number(low_stock_threshold) || 0))'))
// behavioral: the two transforms preserve an explicit 0 (and only default when empty/missing)
const payloadLS = (v: string | null) => v === '' || v == null ? undefined : Number(v)   // mirrors app.js payload
const createNorm = (v: number) => Math.max(0, Math.floor(Number(v) || 0))               // mirrors products-create.ts
ok('6e-2. payload keeps 0, sends undefined only when empty', payloadLS('0') === 0 && payloadLS('') === undefined && payloadLS('5') === 5)
ok('6e-3. create normalize keeps 0 (0→0, 3→3, negative→0)', createNorm(0) === 0 && createNorm(3) === 3 && createNorm(-5) === 0)
for (const k of ['低库存阈值', '售罄自动下架']) ok(`6f. i18n EN entry: ${k}`, has(I18N, `'${k}':`))

if (fail > 0) { console.error(`\n❌ listing create-form contract FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ listing create form: product-type selector + brand/model + low-stock/auto-delist wired UI→payload→backend, bilingual\n  ✅ pass ${pass}`)
