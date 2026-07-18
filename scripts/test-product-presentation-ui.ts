#!/usr/bin/env tsx
/** Buyer product identity / seller-ruling presentation regression contract. */
import { readFileSync } from 'node:fs'

const UI = readFileSync('src/pwa/public/app-product-presentation.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const DISCOVER = readFileSync('src/pwa/public/app-discover.js', 'utf8')
const SERVER = readFileSync('src/pwa/server.ts', 'utf8')
const SEARCH = readFileSync('src/pwa/routes/search.ts', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const CSS = readFileSync('src/pwa/public/style.css', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

let pass = 0, fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => { if (condition) pass++; else { fail++; failures.push(`x ${name}`) } }
const w: Record<string, any> = { t: (value: string) => value }
;(new Function('window', UI))(w)

const product = { id: 'prd_internal_123', title: 'Aurora travel mug with ceramic lining', brand: 'Aurora', model: 'T-400', specs: JSON.stringify({ color: 'Black', capacity: '400ml' }) }
const detail = w.productDetailIdentityHtml(product)
const card = w.productCardTitleHtml(product) + w.productCardMetaHtml(product)
ok('detail keeps the seller canonical title', detail.includes(product.title))
ok('detail does not render the internal product ID', !detail.includes(product.id))
ok('card retains the canonical title and caps metadata at two tokens', card.includes(product.title) && (card.match(/<span>/g) || []).length <= 3)
ok('brand is not repeated as a card token when already in title', !card.includes('>Aurora<'))
const escaped = w.productDetailIdentityHtml({ title: '<img src=x onerror=alert(1)>', specs: { size: '<b>x</b>' } })
ok('seller-controlled title and specs are HTML escaped', !escaped.includes('<img') && !escaped.includes('<b>'))

const allWin = w.sellerRulingsHtml({ dispute_won_count: 10, dispute_lost_count: 0 }, 'seller1')
const mixed = w.sellerRulingsHtml({ dispute_won_count: 5, dispute_lost_count: 5 }, 'seller1')
const allLoss = w.sellerRulingsHtml({ dispute_won_count: 0, dispute_lost_count: 4 }, 'seller1')
const openOnly = w.sellerRulingsHtml({ open_dispute_count: 2 }, 'seller1')
ok('all seller wins render a full-green 100% share', allWin.includes('--seller-win-share:100%') && allWin.includes('data-ruling-wins="10"'))
ok('mixed rulings render an exact 50/50 green-red share with both counts', mixed.includes('--seller-win-share:50%') && mixed.includes('胜 5') && mixed.includes('负 5'))
ok('all seller losses render a full-red 0% win share', allLoss.includes('--seller-win-share:0%') && allLoss.includes('负 4'))
ok('open cases remain a separate neutral status, never a loss result', openOnly.includes('处理中 2') && !openOnly.includes('data-ruling-losses'))
ok('ruling control keeps an accessible description and dispute-desk link', mixed.includes('aria-label=') && mixed.includes("navigate('#shop/seller1?tab=disputes')"))

const heroStart = APP.indexOf('<div class="buyer-product-page">')
const hero = APP.slice(heroStart, APP.indexOf('const livePrice', heroStart))
ok('buyer hero uses the shared identity renderer and no product-ID renderer', hero.includes('window.productDetailIdentityHtml(p)') && !hero.includes('productIdHtml(p.id)'))
ok('seller management retains its product ID helper', (APP.match(/productIdHtml\(p\.id/g) || []).length >= 3)
ok('all standard discover card renderers use the shared title/meta helpers', (DISCOVER.match(/window\.productCardTitleHtml\(p\)/g) || []).length === 4 && (DISCOVER.match(/window\.productCardMetaHtml\(p\)/g) || []).length === 4)
ok('exact active product-ID lookup is part of list search', SERVER.includes("(id = ? OR title = ?) AND status = 'active'"))
ok('paste/exact search also returns product_id_exact', SERVER.includes("matched_by: 'product_id_exact'") && DISCOVER.includes("m === 'product_id_exact'"))
ok('search route contract explicitly accepts the new exact-ID result', SEARCH.includes("'product_id_exact'"))
ok('presentation module loads before discovery/app and has a ratchet/test entry', HTML.indexOf('/app-product-presentation.js') < HTML.indexOf('/app-discover.js') && HTML.indexOf('/app-product-presentation.js') < HTML.indexOf('/app.js') && PKG.includes('test:product-presentation-ui') && RATCHET.includes("'src/pwa/public/app-product-presentation.js': 70"))
ok('ruling visual is an accessible green-red proportion bar', CSS.includes('linear-gradient(90deg,#15803d 0 var(--seller-win-share),#dc2626') && CSS.includes('.seller-rulings-chip:focus-visible'))

if (fail) {
  console.error(`\nproduct presentation UI FAILED\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`product presentation UI: canonical title, hidden buyer ID, exact-ID search, proportional rulings\n  pass ${pass}`)
