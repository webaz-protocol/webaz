#!/usr/bin/env tsx
/** Buyer product identity / seller-ruling presentation regression contract. */
import { readFileSync } from 'node:fs'

const UI = readFileSync('src/pwa/public/app-product-presentation.js', 'utf8')
const RULINGS = readFileSync('src/pwa/public/app-shop-rulings.js', 'utf8')
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
const w: Record<string, any> = { t: (value: string) => value, publicSellerRulingsHtml: (sellerId: string) => `<span data-public-rulings="${sellerId}"></span>` }
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

const publicChip = w.sellerRulingsHtml({ dispute_won_count: 10, dispute_lost_count: 0 }, 'seller1')
ok('product delegates seller rulings to the public-rulings projection', publicChip.includes('data-public-rulings="seller1"'))
ok('public chip uses a green-red proportion and an accessible destination', RULINGS.includes('--seller-win-share:${winShare}%') && RULINGS.includes('aria-label=') && RULINGS.includes("sellerHref(sellerId, 'rulings')"))
ok('public chip does not disclose open cases or use the obsolete disputes tab', !RULINGS.includes('open_dispute_count') && !RULINGS.includes('tab=disputes'))
ok('split responsibility is presented as neutral rather than a seller loss', RULINGS.includes('seller-rulings-split') && RULINGS.includes('shop-ruling-row--split') && CSS.includes('.seller-rulings-split'))
ok('dismissed rulings stay neutral and keep a seller-rulings destination', RULINGS.includes("winner === 'dismissed'") && RULINGS.includes('seller-ruling-neutral-chip') && CSS.includes('.shop-ruling-row--dismissed'))
ok('item-level case count is neutral, not a false seller-loss signal', APP.includes("t('本商品公开判例')") && !APP.includes("pill.style.color = items.length > 0 ? '#dc2626'"))

const heroStart = APP.indexOf('<div class="buyer-product-page">')
const hero = APP.slice(heroStart, APP.indexOf('const livePrice', heroStart))
ok('buyer hero uses the shared identity renderer and no product-ID renderer', hero.includes('window.productDetailIdentityHtml(p)') && !hero.includes('productIdHtml(p.id)'))
ok('seller management retains its product ID helper', (APP.match(/productIdHtml\(p\.id/g) || []).length >= 3)
ok('all standard discover card renderers use the shared title/meta helpers', (DISCOVER.match(/window\.productCardTitleHtml\(p\)/g) || []).length === 4 && (DISCOVER.match(/window\.productCardMetaHtml\(p\)/g) || []).length === 4)
ok('exact active product-ID lookup is part of list search', SERVER.includes("(id = ? OR title = ?) AND status = 'active'"))
ok('paste/exact search also returns product_id_exact', SERVER.includes("matched_by: 'product_id_exact'") && DISCOVER.includes("m === 'product_id_exact'"))
ok('search route contract explicitly accepts the new exact-ID result', SEARCH.includes("'product_id_exact'"))
ok('presentation modules load before app and have a ratchet/test entry', HTML.indexOf('/app-product-presentation.js') < HTML.indexOf('/app.js') && HTML.indexOf('/app-shop-rulings.js') < HTML.indexOf('/app.js') && PKG.includes('test:product-presentation-ui') && RATCHET.includes("'src/pwa/public/app-product-presentation.js': 56"))
ok('ruling visual is an accessible green-red proportion bar', CSS.includes('linear-gradient(90deg,#15803d 0 var(--seller-win-share),#dc2626') && CSS.includes('.seller-rulings-chip:focus-visible'))

if (fail) {
  console.error(`\nproduct presentation UI FAILED\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`product presentation UI: canonical title, hidden buyer ID, exact-ID search, proportional rulings\n  pass ${pass}`)
