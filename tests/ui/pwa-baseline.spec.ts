import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

const DASHBOARD_VIEWPORTS = [VIEWPORTS[0], VIEWPORTS[2]] as const

type RuntimeGuards = {
  assertClean: () => void
}

const LEGACY_AXE_ALLOWLIST = [
  // Existing #welcome markup: keep each exception tied to its exact route and node.
  { route: '#welcome', id: 'color-contrast', target: '.w-lang-inactive', reason: 'inactive language toggle' },
  { route: '#welcome', id: 'color-contrast', target: 'div:nth-child(4) > a[href$="zh-CN"][rel="noopener"][target="_blank"]', reason: 'whitepaper link' },
  { route: '#welcome', id: 'color-contrast', target: 'details[open=""] > .w-cta-wrap > .w-cta[href="#"]', reason: 'role CTA' },
  { route: '#welcome', id: 'color-contrast', target: 'a[href$="#welcome"]', reason: 'join CTA' },
  { route: '#welcome', id: 'color-contrast', target: 'button[onclick="openAuthSheet(\'reg\')"]', reason: 'registration CTA' },
  { route: '#welcome', id: 'color-contrast', target: 'button[onclick="submitWelcomeEmail()"]', reason: 'waitlist CTA' },
  { route: '#welcome', id: 'select-name', target: '#w-role-pref', reason: 'role preference select' },
  { route: '#seller', id: 'color-contrast', target: 'div:nth-child(1) > div > span', reason: 'seller dashboard subtitle' },
  { route: '#seller', id: 'color-contrast', target: 'div:nth-child(3) > strong', reason: 'seller quota value' },
  { route: '#seller', id: 'color-contrast', target: 'div:nth-child(6) > .card', reason: 'seller empty analytics state' },
  { route: '#discover', id: 'color-contrast', target: '.disc-nav > button:nth-child(2) > span:nth-child(2)', reason: 'inactive new-products tab' },
  { route: '#discover', id: 'color-contrast', target: '.disc-nav > button:nth-child(3) > span:nth-child(2)', reason: 'inactive radar tab' },
  { route: '#discover', id: 'color-contrast', target: 'button[onclick="navigate(\'#discover/feed\')"] > span:nth-child(2)', reason: 'inactive activity tab' },
  { route: '#discover', id: 'color-contrast', target: 'div:nth-child(6)', reason: 'recommendation-method note' },
  { route: '#discover', id: 'color-contrast', target: 'button:nth-child(4) > span:nth-child(2)', reason: 'inactive auction tab' },
  { route: '#discover', id: 'color-contrast', target: 'button:nth-child(5) > span:nth-child(2)', reason: 'inactive request tab' },
  { route: '#discover', id: 'color-contrast', target: 'button:nth-child(6) > span:nth-child(2)', reason: 'inactive charity tab' },
] as const

function installRuntimeGuards(page: Page): RuntimeGuards {
  const failures: string[] = []

  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('requestfailed', request => failures.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText || 'unknown'}`))
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  page.on('response', response => {
    const url = new URL(response.url())
    const resourceType = response.request().resourceType()
    const sameOriginApi = url.origin === 'http://127.0.0.1:3173' && url.pathname.startsWith('/api/')
    if (sameOriginApi && response.status() >= 400) {
      failures.push(`${response.status()} ${resourceType}: ${response.url()}`)
    } else if (response.status() === 404 && ['document', 'script', 'stylesheet', 'font'].includes(resourceType)) {
      failures.push(`404 ${resourceType}: ${response.url()}`)
    }
  })

  return {
    assertClean: () => expect(failures, failures.join('\n')).toEqual([]),
  }
}

async function assertClassicScriptsLoaded(page: Page) {
  const scripts = await page.locator('script[src]').evaluateAll(nodes =>
    nodes.map(node => new URL((node as HTMLScriptElement).src).pathname),
  )

  expect(scripts.length).toBeGreaterThan(50)
  expect(scripts).toEqual(expect.arrayContaining([
    '/i18n.js',
    '/app-discover.js',
    '/app-discover-new-filters.js',
    '/app-shop-rulings.js',
    '/app-seller.js',
    '/app.js',
  ]))
  await expect.poll(() => page.evaluate(() => ({
    app: !!document.getElementById('app')?.children.length,
    discover: typeof window.renderDiscover === 'function',
    seller: typeof window.renderSeller === 'function',
    welcome: typeof window.renderWelcome === 'function',
  }))).toEqual({ app: true, discover: true, seller: true, welcome: true })
}

async function assertLanguageSync(page: Page) {
  const initial = await page.evaluate(() => window._lang)
  await expect.poll(() => page.evaluate(() => ({
    lang: document.documentElement.lang,
    uiLang: window._lang,
  }))).toEqual(expect.objectContaining({
    lang: expect.stringMatching(/^(en|zh-CN)$/),
    uiLang: expect.stringMatching(/^(en|zh)$/),
  }))

  await page.evaluate(() => window.toggleLang())
  await expect.poll(() => page.evaluate(() => window._lang)).not.toBe(initial)
  await expect.poll(() => page.evaluate(() => ({
    lang: document.documentElement.lang,
    uiLang: window._lang,
  }))).toEqual(expect.objectContaining({
    lang: expect.stringMatching(/^(en|zh-CN)$/),
    uiLang: expect.stringMatching(/^(en|zh)$/),
  }))
  await expect(page.locator('html')).toHaveAttribute('lang', await page.evaluate(() => window._lang === 'en' ? 'en' : 'zh-CN'))
}

async function assertNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function assertAxeHasNoSeriousOrCriticalViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const route = new URL(page.url()).hash
  const unexpected = results.violations
    .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
    .flatMap(violation => violation.nodes
      .filter(node => !LEGACY_AXE_ALLOWLIST.some(entry =>
        entry.route === route && entry.id === violation.id && entry.target === node.target.join(' '),
      ))
      .map(node => `${violation.id}: ${node.target.join(' ')}\n${node.html}`),
    )
  expect(unexpected, unexpected.join('\n')).toEqual([])
}

async function mockSellerDashboard(page: Page) {
  await page.route('**/api/me', route => route.fulfill({ json: {
    id: 'ux-seller',
    name: 'UX Seller',
    role: 'seller',
    roles: ['seller'],
    region: 'global',
    region_max_levels: 3,
    email_verified: true,
    has_password: true,
    has_passkey: false,
    wallet: { balance: 0, staked: 0, escrowed: 0, earned: 0 },
  } }))
  await page.route('**/api/my-products', route => route.fulfill({ json: [
    { id: 'ux-product-active', title: 'Ceramic travel tea set', status: 'active', price: 34, stock: 2, low_stock_threshold: 3, category: '茶具', completion_count: 7, has_variants: 0 },
    { id: 'ux-product-draft', title: 'Agent prepared draft', status: 'warehouse', price: 21, stock: 4, category: '家居', has_pending_task: 0, all_links_revoked: 0 },
    { id: 'ux-product-deleted', title: 'Retired sample listing', status: 'deleted', price: 13, stock: 0, category: '家居' },
  ] }))
  await page.route('**/api/profile', route => route.fulfill({ json: { wallet: { balance: 0, staked: 0 } } }))
  await page.route('**/api/orders', route => route.fulfill({ json: [
    { id: 'ux-order-paid', seller_id: 'ux-seller', status: 'paid', product_title: 'Ceramic travel tea set', total_amount: 34, payment_rail: 'direct_p2p', created_at: '2026-07-14T08:00:00Z' },
    { id: 'ux-order-accepted', seller_id: 'ux-seller', status: 'accepted', product_title: 'Handmade storage basket', total_amount: 52, payment_rail: 'escrow', created_at: '2026-07-14T07:00:00Z' },
    { id: 'ux-order-disputed', seller_id: 'ux-seller', status: 'disputed', product_title: 'Portable lamp', total_amount: 18, payment_rail: 'direct_p2p', created_at: '2026-07-13T06:00:00Z' },
  ] }))
  await page.route('**/api/rfqs?limit=50', route => route.fulfill({ json: { items: [{ id: 'rfq-ux-1', status: 'open' }], urgencies: ['now', 'today', 'flex'], categories: [] } }))
  await page.route('**/api/charity/me', route => route.fulfill({ json: { reputation: {}, pending_repayments: [] } }))
  await page.route('**/api/agents/me/reputation', route => route.fulfill({ json: { level: 'new', trust_score: 0 } }))
  await page.route('**/api/claim-tasks/mine', route => route.fulfill({ json: { as_buyer: [], as_verifier: [] } }))
  await page.route('**/api/skills/mine', route => route.fulfill({ json: [] }))
  await page.route('**/api/seller/quota-status', route => route.fulfill({ json: {
    total_used: 2,
    max_products: 10,
    daily_used: 0,
    daily_limit: 3,
    listing_paused: false,
    new_user: true,
    next_tier: null,
  } }))
  await page.route('**/api/seller/insights', route => route.fulfill({ json: {} }))
  await page.route('**/api/return-requests?*', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/notifications?unread=1', route => route.fulfill({ json: { unread: 0, notifications: [] } }))
  await page.route('**/api/announcements/active', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/conversations', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/feedback/mine', route => route.fulfill({ json: { unread_reply_count: 0 } }))
  await page.route('**/api/snf/inbox?limit=50', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/snf/pending', route => route.fulfill({ json: { pending: 0 } }))
  await page.route('**/api/arbitrator/status', route => route.fulfill({ json: { can_arbitrate: false, arbitrator_status: 'none' } }))
  await page.route('**/api/signaling/poll', route => route.fulfill({ json: { signals: [] } }))
  await page.route('**/api/notifications/stream?key=ux-seller-token', route => route.fulfill({
    contentType: 'text/event-stream',
    body: 'data: {"type":"init","unread":0}\n\n',
  }))
}

async function mockBuyerSession(page: Page) {
  await page.route('**/api/cart', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/profile', route => route.fulfill({ json: { wallet: { balance: 0, staked: 0 } } }))
  await page.route('**/api/orders', route => route.fulfill({ json: [] }))
  await page.route('**/api/charity/me', route => route.fulfill({ json: { reputation: {}, pending_repayments: [] } }))
  await page.route('**/api/skills/mine', route => route.fulfill({ json: [] }))
  await page.route('**/api/agents/me/reputation', route => route.fulfill({ json: { level: 'new', trust_score: 0 } }))
  await page.route('**/api/verifier/eligibility', route => route.fulfill({ json: { eligible: false } }))
  await page.route('**/api/verifier/status', route => route.fulfill({ json: { state: 'none' } }))
  await page.route('**/api/arbitrator/eligibility', route => route.fulfill({ json: { eligible: false } }))
  await page.route('**/api/claim-tasks/mine', route => route.fulfill({ json: { as_buyer: [], as_verifier: [] } }))
  await page.route('**/api/me/note-prompts', route => route.fulfill({ json: { prompts: [] } }))
  await page.route('**/api/notifications?unread=1', route => route.fulfill({ json: { unread: 0, notifications: [] } }))
  await page.route('**/api/announcements/active', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/me', route => route.fulfill({ json: {
    id: 'ux-buyer',
    name: 'UX Buyer',
    role: 'buyer',
    roles: ['buyer'],
    region: 'global',
    email_verified: true,
    has_password: true,
    has_passkey: false,
    wallet: { balance: 0, staked: 0, escrowed: 0, earned: 0 },
  } }))
  await page.route('**/api/conversations', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/feedback/mine', route => route.fulfill({ json: { unread_reply_count: 0 } }))
  await page.route('**/api/snf/inbox?limit=50', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/snf/pending', route => route.fulfill({ json: { pending: 0 } }))
  await page.route('**/api/arbitrator/status', route => route.fulfill({ json: { can_arbitrate: false, arbitrator_status: 'none' } }))
  await page.route('**/api/signaling/poll', route => route.fulfill({ json: { signals: [] } }))
  await page.route('**/api/notifications/stream?key=ux-buyer-token', route => route.fulfill({
    contentType: 'text/event-stream',
    body: 'data: {"type":"init","unread":0}\n\n',
  }))
}

const BUYER_PRODUCT = {
  id: 'ux-product', seller_id: 'ux-seller', seller_name: 'Verified Studio', seller_created_at: '2025-01-01 00:00:00',
  title: 'Portable ceramic tea set', description: 'A compact, carefully packed tea set for everyday use.', category: '茶具', product_type: 'retail',
  price: 48, stock: 8, low_stock: 0, images: '', rep_level: 'trusted', seller_tx_count: 32, sales_count: 18, recommend_count: 15,
  claim_loss_count: 0, trial_quota_remaining: 0, value_badge: 0, return_days: 7, warranty_days: 30, handling_hours: 24,
  ship_regions: 'global', specs: '{}', i18n_titles: {}, i18n_descs: {}, created_at: '2026-07-01 00:00:00',
}

async function mockBuyerCommerce(page: Page) {
  await page.route('**/api/products?*', route => route.fulfill({ json: [BUYER_PRODUCT] }))
  await page.route('**/api/products', route => route.fulfill({ json: [BUYER_PRODUCT] }))
  await page.route('**/api/products/ux-product', route => route.fulfill({ json: BUYER_PRODUCT }))
  await page.route('**/api/shareables/by-product/ux-product', route => route.fulfill({ json: { shareables: [] } }))
  await page.route('**/api/manifests/by-product/ux-product', route => route.fulfill({ json: { manifests: [] } }))
  await page.route('**/api/products/ux-product/claims', route => route.fulfill({ json: { claims: [] } }))
  await page.route('**/api/wishlist/ux-product/check', route => route.fulfill({ json: { in_wishlist: false } }))
  await page.route('**/api/products/ux-product/qa', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/products/ux-product/waitlist/check', route => route.fulfill({ json: { in_waitlist: false } }))
  await page.route('**/api/products/ux-product/variants', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/addresses', route => route.fulfill({ json: { items: [{ id: 'addr-1', label: 'Home', is_default: 1, text: '1 Market Street, Singapore', region: 'SG' }] } }))
  await page.route('**/api/products/ux-product/ratings?limit=5', route => route.fulfill({ json: { items: [], agg: { cnt: 12, avg_stars: 4.8 } } }))
  await page.route('**/api/products/ux-product/flash-sale', route => route.fulfill({ json: { sale: null } }))
  await page.route('**/api/reputation/ux-seller', route => route.fulfill({ json: { metrics: { is_new_seller: false, sample_size: 32, fulfillment_rate: .97, on_time_rate: .94, dispute_count: 0, refund_rate: .02 } } }))
  await page.route('**/api/disputes/cases?seller_id=ux-seller&limit=5', route => route.fulfill({ json: { summary: { total: 1, seller_wins: 0, seller_losses: 0, split: 0, dismissed: 1 }, items: [] } }))
  await page.route('**/api/disputes/cases/by-product/ux-product', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/products/ux-product/external-links', route => route.fulfill({ json: { links: [] } }))
  await page.route('**/api/products/ux-product/shipping-options*', route => route.fulfill({ json: { sellable: { ok: true, reason: 'ok' }, shipping_templates: [], tax_included_lines: [] } }))
  await page.route('**/api/checkout/tax-preview?*', route => route.fulfill({ json: { is_cross_border: false } }))
}

async function mockPublicShop(page: Page) {
  await page.route('**/api/shops/ux-seller', route => route.fulfill({ json: {
    seller: { id: 'ux-seller', name: 'Verified Studio', handle: 'verified-studio', bio: 'Handmade essentials.', shop_intro: 'Small-batch home goods.', shop_banner_url: '' },
    stats: { products: 1, followers: 12, completed_orders: 32, rating_avg: 4.8, rating_count: 12 },
    products: [{ id: 'ux-product', title: 'Portable ceramic tea set', price: 48, stock: 8, images: '', category: '茶具', sales_count: 18 }],
    recent_ratings: [], is_following: false,
  } }))
  await page.route('**/api/disputes/cases?seller_id=ux-seller&limit=50', route => route.fulfill({ json: {
    summary: { total: 4, seller_wins: 1, seller_losses: 1, split: 1, dismissed: 1 },
    items: [
      { id: 'case-win', product_title: 'Portable ceramic tea set', winner: 'seller', resolution: 'Release to seller', published_at: '2026-07-16T08:00:00Z' },
      { id: 'case-loss', product_title: 'Portable ceramic tea set', winner: 'buyer', resolution: 'Buyer remedy', published_at: '2026-07-15T08:00:00Z' },
      { id: 'case-split', product_title: 'Portable ceramic tea set', winner: 'split', resolution: 'Shared responsibility', published_at: '2026-07-14T08:00:00Z' },
      { id: 'case-dismissed', product_title: 'Portable ceramic tea set', winner: 'dismissed', resolution: 'Withdrawn', published_at: '2026-07-13T08:00:00Z' },
    ],
  } }))
}

for (const viewport of DASHBOARD_VIEWPORTS) {
  test(`authenticated buyer account dashboard at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#me')

    await expect(page.locator('#app main')).toContainText(/我的购物|My shopping/i)
    await expect(page.locator('#app .tabbar')).toBeVisible()
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })

  test(`authenticated buyer AI match entry at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await page.addInitScript(() => {
      localStorage.setItem('webaz_key', 'ux-buyer-token')
      localStorage.setItem('webaz_lang', 'zh')
    })
    await page.setViewportSize(viewport)
    await page.goto('/#buy')

    await expect(page.locator('#app .tabbar')).toContainText('AI找同款')
    await expect(page.locator('#smart-results')).toContainText('先找到同款，再决定是否下单')
    await expect(page.locator('#sbh-search-inp')).toHaveAttribute('placeholder', '输入商品名 / 粘贴链接 / 口令 / 内容指纹')
    await expect(page.locator('#app')).not.toContainText('智能下单')
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)

    await page.evaluate(() => window.toggleLang())
    await expect(page.locator('#app .tabbar')).toContainText('AI Match')
    await assertNoHorizontalOverflow(page)
    guards.assertClean()
  })

  test(`authenticated seller account dashboard at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockSellerDashboard(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-seller-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#me')

    await expect(page.locator('#app main')).toContainText('UX Seller')
    await expect(page.locator('a.hub-action-card[href="#rfqs"]')).toContainText(/1 .*公开求购|1 open RFQ/i)
    expect(await page.locator('a.hub-action-card[href]').count()).toBeGreaterThan(0)
    await expect(page.locator('#app .tabbar')).toBeVisible()
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })
}

for (const viewport of DASHBOARD_VIEWPORTS) {
  test(`public seller rulings at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await mockPublicShop(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#shop/ux-seller?tab=rulings')

    await expect(page.locator('.shop-section-tab[aria-current="page"]')).toContainText(/公开裁决|Public rulings/)
    await expect(page.locator('.shop-ruling-summary')).toContainText(/卖家胜 1|Seller wins 1/)
    await expect(page.locator('.shop-ruling-summary')).toContainText(/买家胜 1|Buyer wins 1/)
    await expect(page.locator('.shop-ruling-summary')).toContainText(/部分责任 1|Partial fault 1/)
    await expect(page.locator('.shop-ruling-summary')).toContainText(/裁决已撤销 1|Dismissed 1/)
    await expect(page.locator('.shop-ruling-row--dismissed')).toContainText(/裁决已撤销|Dismissed/)
    await expect(page.locator('.shop-ruling-list')).toHaveCount(1)
    await expect(page.locator('#app main')).not.toContainText('PRIVATE BUYER')
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    await page.locator('.shop-section-tab').first().click()
    await expect(page).toHaveURL(/#shop\/ux-seller$/)
    await expect(page.locator('#app main')).toContainText('Portable ceramic tea set')
    guards.assertClean()
  })
}

for (const viewport of VIEWPORTS) {
  test(`public welcome baseline at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await page.setViewportSize(viewport)
    await page.goto('/#welcome')

    await assertClassicScriptsLoaded(page)
    await expect(page.locator('#app .w-section').first()).toBeVisible()
    await assertLanguageSync(page)
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })

  test(`authenticated buyer discover baseline at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#discover')

    await assertClassicScriptsLoaded(page)
    await expect(page.locator('#product-list')).toBeVisible()
    await expect(page.locator('#app .navbar')).toBeVisible()
    await expect(page.locator('#app .tabbar')).toBeVisible()
    await assertLanguageSync(page)
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })
}

for (const viewport of DASHBOARD_VIEWPORTS) {
  test(`new arrivals keeps the catalog above the fold at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await mockBuyerCommerce(page)
    await mockPublicShop(page)
    await page.addInitScript(() => {
      localStorage.setItem('webaz_key', 'ux-buyer-token')
      localStorage.setItem('webaz_lang', 'zh')
    })
    await page.setViewportSize(viewport)
    await page.goto('/#discover/new')

    const filters = page.locator('#new-arrivals-filters')
    await expect(filters).toBeVisible()
    await expect(filters).not.toHaveAttribute('open', '')
    await expect(filters.locator('.discover-filter-body')).toBeHidden()
    await expect(filters.locator('summary')).toContainText('全部')
    await expect(filters.locator('summary')).toContainText('最新')
    await expect(filters.locator('summary')).toContainText('零售')
    expect(await page.locator('.new-arrivals-controls').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(100)
    await expect(page.locator('#product-list')).toContainText('Portable ceramic tea set')
    const firstProduct = page.locator('#product-list .product-card').first()
    await expect(firstProduct).toBeVisible()
    expect((await firstProduct.boundingBox())?.y).toBeLessThan(viewport.height)

    await filters.locator('summary').click()
    await expect(filters).toHaveAttribute('open', '')
    await expect(filters.locator('.discover-filter-body')).toBeVisible()
    await expect(filters.locator('.discover-filter-group').nth(0).getByRole('button')).toHaveCount(5)
    await expect(filters.locator('.discover-filter-group').nth(1).locator('.sort-chip')).toHaveCount(7)
    await expect(filters.locator('.discover-filter-group').nth(2).getByRole('button')).toHaveCount(4)

    await filters.getByRole('button', { name: '今日', exact: true }).click()
    await expect(filters).toHaveAttribute('open', '')
    await expect(filters.locator('summary')).toContainText('今日')
    await filters.getByRole('button', { name: /测评免单/ }).click()
    await expect(filters.locator('summary')).toContainText('测评免单')
    await filters.locator('button[onclick="setTypeChip(\'new\',\'wholesale\')"]').click()
    await expect(filters).toHaveAttribute('open', '')
    await expect(filters.locator('summary')).toContainText('批发')
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })

  test(`buyer discovery to checkout journey at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await mockBuyerCommerce(page)
    await mockPublicShop(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#discover')

    const product = page.locator('a.buyer-product-card[href="#order-product/ux-product"]')
    await expect(product).toContainText('Portable ceramic tea set')
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    await product.click()
    await expect(page.locator('.buyer-product-hero')).toContainText('Portable ceramic tea set')
    await expect(page.locator('.buyer-product-hero .product-id-line')).toHaveCount(0)
    const rulingsChip = page.locator('.buyer-product-hero .seller-ruling-neutral-chip')
    await expect(rulingsChip).toBeVisible()
    await expect(rulingsChip).toContainText(/裁决已撤销 1|Dismissed 1/)
    await rulingsChip.click()
    await expect(page).toHaveURL(/#shop\/ux-seller\?tab=rulings$/)
    await expect(page.locator('.shop-section-tab[aria-current="page"]')).toContainText(/公开裁决|Public rulings/)
    await page.goBack()
    await expect(page.locator('.buyer-product-hero')).toContainText('Portable ceramic tea set')
    await expect(page.locator('#btn-openBuy')).toBeVisible()
    await assertAxeHasNoSeriousOrCriticalViolations(page)
	    await page.locator('#btn-openBuy').click()
	    const panel = page.locator('.buyer-checkout-overlay .sheet-panel')
	    await expect(panel.locator('.buyer-checkout-sheet')).toBeVisible()
	    await expect(panel.locator('.buyer-checkout-sheet')).toContainText(/Home|1 Market Street/)
	    const panelBox = await panel.boundingBox()
	    expect(panelBox).not.toBeNull()
	    if (viewport.name === 'mobile') {
	      expect(Math.abs(panelBox!.x)).toBeLessThanOrEqual(1)
	      expect(Math.abs(panelBox!.width - viewport.width)).toBeLessThanOrEqual(2)
	      expect(Math.abs(panelBox!.y + panelBox!.height - viewport.height)).toBeLessThanOrEqual(2)
	    } else {
	      expect(Math.abs(panelBox!.x + panelBox!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2)
	      expect(Math.abs(panelBox!.y + panelBox!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2)
	    }
	    const checkoutCta = panel.locator('#btn-doBuy')
	    await checkoutCta.scrollIntoViewIfNeeded()
	    await expect(checkoutCta).toBeVisible()
	    const ctaBox = await checkoutCta.boundingBox()
	    expect(ctaBox).not.toBeNull()
	    expect(ctaBox!.y).toBeGreaterThanOrEqual(0)
	    expect(ctaBox!.y + ctaBox!.height).toBeLessThanOrEqual(viewport.height)
	    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })
}

for (const viewport of DASHBOARD_VIEWPORTS) {
  test(`authenticated seller workbench at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockSellerDashboard(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-seller-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#seller')

    await assertClassicScriptsLoaded(page)
    await expect(page.locator('#app .navbar')).toBeVisible()
    await expect(page.locator('#app main')).toContainText(/卖家后台|Seller Dashboard/)
    await expect(page.locator('.seller-kpi-card')).toHaveCount(5)
    await expect(page.locator('.seller-subtab[aria-current="page"]')).toContainText(/看板|Board/)
    await expect(page.locator('.seller-subtab[aria-current="page"]')).toHaveCSS('background-color', 'rgb(255, 247, 237)')
    await expect(page.locator('.tabbar .tab-item').nth(1)).toContainText(/抢单|Bid Market/)
    await expect(page.locator('.seller-subnav .seller-subtab').nth(2)).toContainText(/营销|Marketing/)
    await expect(page.locator('.seller-subnav')).toContainText('Skill')
    await expect(page.locator('.seller-subnav')).toContainText(/经营设置|Business Settings/)
    await expect(page.locator('a.seller-order-link[href="#order/ux-order-paid"]')).toBeVisible()
    await expect(page.locator('#seller-task-exceptions')).toContainText('Portable lamp')
    const columns = await page.locator('.seller-kpi-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(viewport.name === 'mobile' ? 2 : 5)
    if (viewport.name === 'mobile') {
      await expect(page.locator('#agent-fab')).toBeHidden()
      await expect(page.locator('#feedback-fab')).toBeHidden()
    }
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    await page.locator('.seller-subtab').filter({ hasText: /营销|Marketing/ }).click()
    await expect(page).toHaveURL(/#seller\/marketing$/)
    await expect(page.locator('.seller-subtab[aria-current="page"]')).toContainText(/营销|Marketing/)
    await expect(page.locator('#app main')).toContainText(/发起拍卖|Start Auction/)
    await expect(page.locator('#app main')).not.toContainText(/普通上架|Standard listing|P2P 上架|P2P Publish/)
    await page.locator('.seller-subtab').filter({ hasText: /商品|Product/ }).click()
    await expect(page.locator('.seller-products-toolbar')).toBeVisible()
    await page.goBack()
    await expect(page.locator('#app main')).toContainText(/发起拍卖|Start Auction/)
    await page.goForward()
    await expect(page.locator('.seller-products-toolbar')).toBeVisible()
    await expect(page.locator('.seller-products-toolbar-actions')).toContainText(/普通上架|Standard listing/)
    await expect(page.locator('.seller-products-toolbar-actions')).toContainText(/P2P 上架|P2P Publish/)
    await expect(page.locator('.seller-products-toolbar-actions')).toContainText(/导入|Import/)
    await expect(page.locator('.seller-product-row')).toContainText('Ceramic travel tea set')
    await expect(page.locator('.seller-product-row .product-id-line code')).toHaveText('ux-product-active')
    await page.locator('.seller-product-row .product-id-copy').click()
    await expect(page).toHaveURL(/#seller\/products$/)
    await expect(page.locator('.toast-message')).toBeVisible()
    await expect(page.locator('.toast-message')).toBeHidden({ timeout: 3000 })
    await page.locator('#seller-product-search').fill('ux-product')
    await expect(page.locator('#seller-product-search-count')).toHaveText('3')
    await expect(page.locator('.prd-tab-count')).toHaveText(['(1)', '(1)', '(1)'])
    await page.locator('#seller-product-search').fill('prepared')
    await expect(page.locator('#prd-tab-warehouse')).toBeVisible()
    await expect(page.locator('#prd-tab-warehouse .seller-product-entry:not([hidden])')).toContainText('Agent prepared draft')
    await page.locator('.prd-tab-btn[data-tab="warehouse"]').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.prd-tab-btn[data-tab="warehouse"]')).toBeFocused()
    await page.locator('#seller-product-search').fill('retired')
    await expect(page.locator('#prd-tab-deleted')).toBeVisible()
    await expect(page.locator('#prd-tab-deleted .seller-product-entry:not([hidden])')).toContainText('Retired sample listing')
    await page.locator('#seller-product-search').fill('missing-product')
    await expect(page.locator('#seller-product-search-empty')).toBeVisible()
    await expect(page.locator('.prd-tab-btn:disabled')).toHaveCount(3)
    await page.locator('#seller-product-search').fill('')
    await expect(page.locator('#seller-product-search-empty')).toBeHidden()
    await expect(page.locator('.prd-tab-btn:enabled')).toHaveCount(3)
    await page.locator('.prd-tab-btn[data-tab="active"]').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.prd-tab-btn[data-tab="warehouse"]')).toBeFocused()
    await expect(page.locator('#prd-tab-warehouse')).toBeVisible()
    await page.keyboard.press('End')
    await expect(page.locator('.prd-tab-btn[data-tab="deleted"]')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.locator('.prd-tab-btn[data-tab="active"]')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('.prd-tab-btn[data-tab="deleted"]')).toBeFocused()
    await page.goto('/#seller/dashboard')
    await page.evaluate(() => (window as any).goCreateListingFromBuy('Prefilled product title'))
    await expect(page).toHaveURL(/#seller\/products$/)
    await expect(page.locator('#add-product-form')).toBeVisible()
    await expect(page.locator('#prd-title')).toHaveValue('Prefilled product title')
    await page.reload()
    await expect(page.locator('#add-product-form')).toBeVisible()
    await expect(page.locator('#prd-title')).toHaveValue('Prefilled product title')
    await page.locator('#add-product-form .btn-gray').last().click()
    await page.reload()
    await expect(page.locator('#add-product-form')).toBeHidden()
    await page.evaluate(() => {
      const proto = Object.getPrototypeOf(sessionStorage), getItem = proto.getItem
      proto.getItem = () => { throw new DOMException('storage read denied') }
      try { (window as any).navigateIntended('#seller/dashboard') } finally { proto.getItem = getItem }
    })
    await expect(page).toHaveURL(/#seller\/dashboard$/)
    await page.evaluate(() => {
      sessionStorage.setItem('webaz_intended_hash', '#seller/products')
      const proto = Object.getPrototypeOf(sessionStorage), removeItem = proto.removeItem
      proto.removeItem = () => { throw new DOMException('storage removal denied') }
      try { (window as any).navigateIntended('#seller/dashboard') } finally { proto.removeItem = removeItem; sessionStorage.removeItem('webaz_intended_hash') }
    })
    await expect(page).toHaveURL(/#seller\/dashboard$/)
    await page.evaluate(() => { (window as any)._sellerAddPrefill = { title: 'stale' }; sessionStorage.setItem('webaz_seller_add_prefill', '{"title":"stale"}'); (window as any).state.user.role = 'admin' })
    page.once('dialog', dialog => dialog.dismiss())
    await page.evaluate(() => (window as any).goCreateListingFromBuy('blocked'))
    expect(await page.evaluate(() => ({ memory: (window as any)._sellerAddPrefill, stored: sessionStorage.getItem('webaz_seller_add_prefill') }))).toEqual({ memory: null, stored: null })
    await page.evaluate(() => { (window as any).state.user.role = 'seller' })
    await page.goto('/#seller/dashboard')
    await page.evaluate(() => {
      const proto = Object.getPrototypeOf(sessionStorage), original = proto.setItem
      proto.setItem = () => { throw new DOMException('storage disabled') }
      try { (window as any).goCreateListingFromBuy('Storage-safe title') } finally { proto.setItem = original }
    })
    await expect(page).toHaveURL(/#seller\/products$/)
    await expect(page.locator('#prd-title')).toHaveValue('Storage-safe title')
    await page.route('**/api/products', route => route.request().method() === 'POST'
      ? route.fulfill({ json: { product_id: 'ux-created-product' } })
      : route.fallback())
    await page.locator('#prd-desc').fill('Created product description')
    await page.locator('#prd-price').fill('10')
    await page.evaluate(() => { (window as any).listingCommerceSave = async () => ({ ok: false, error: 'forced post-create failure' }) })
    await page.evaluate(() => (window as any).doAddProduct())
    await expect(page.locator('#add-msg')).toContainText('forced post-create failure')
    expect(await page.evaluate(() => ({ memory: (window as any)._sellerAddPrefill, stored: sessionStorage.getItem('webaz_seller_add_prefill') }))).toEqual({ memory: null, stored: null })
    await page.reload()
    await expect(page.locator('#add-product-form')).toBeHidden()
    await assertLanguageSync(page)
    await assertNoHorizontalOverflow(page)
    await assertAxeHasNoSeriousOrCriticalViolations(page)
    guards.assertClean()
  })
}

for (const viewport of [
  { name: 'tablet-edge', width: 919, height: 480, desktop: false },
  { name: 'desktop-edge', width: 920, height: 480, desktop: true },
] as const) {
  test(`shell geometry at ${viewport.name}`, async ({ page }) => {
    await mockBuyerSession(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#me')

    const geometry = await page.evaluate(() => {
      const nav = document.querySelector('.tabbar') as HTMLElement
      const main = document.querySelector('.main') as HTMLElement
      const navStyle = getComputedStyle(nav)
      const mainStyle = getComputedStyle(main)
      return {
        direction: navStyle.flexDirection,
        navFits: nav.scrollHeight <= nav.clientHeight && nav.scrollWidth <= nav.clientWidth,
        mainLeft: main.getBoundingClientRect().left,
        mainRight: window.innerWidth - main.getBoundingClientRect().right,
        mainPaddingLeft: Number.parseFloat(mainStyle.paddingLeft),
      }
    })
    expect(geometry.navFits).toBe(true)
    expect(geometry.direction).toBe(viewport.desktop ? 'column' : 'row')
    if (viewport.desktop) {
      expect(geometry.mainLeft).toBe(196)
      expect(geometry.mainPaddingLeft).toBeGreaterThanOrEqual(28)
    } else {
      expect(Math.abs(geometry.mainLeft - geometry.mainRight)).toBeLessThanOrEqual(1)
    }
    await assertNoHorizontalOverflow(page)
  })
}

test('desktop bottom-bar shell has no rail gap or FAB overlap', async ({ page }) => {
  await mockBuyerSession(page)
  await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#discover')
  await page.evaluate(() => {
    const app = document.getElementById('app')
    if (app) app.innerHTML = (window as any).shell('<div>Product detail</div>', 'discover', {
      hideTabbar: true,
      bottomBar: '<button id="test-purchase-cta">Buy now</button>',
    })
  })

  expect(await page.locator('.tabbar').count()).toBe(0)
  const geometry = await page.evaluate(() => {
    const main = document.querySelector('.main') as HTMLElement
    const bar = document.querySelector('.page-bottom-bar') as HTMLElement
    const left = main.getBoundingClientRect().left
    const right = window.innerWidth - main.getBoundingClientRect().right
    return {
      centered: Math.abs(left - right) <= 1,
      barLeft: bar.getBoundingClientRect().left,
      barRight: window.innerWidth - bar.getBoundingClientRect().right,
      agentDisplay: getComputedStyle(document.getElementById('agent-fab')!).display,
      feedbackDisplay: getComputedStyle(document.getElementById('feedback-fab')!).display,
    }
  })
  expect(geometry).toEqual({ centered: true, barLeft: 0, barRight: 0, agentDisplay: 'none', feedbackDisplay: 'none' })
})
