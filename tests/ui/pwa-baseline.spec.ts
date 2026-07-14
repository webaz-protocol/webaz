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
  await page.route('**/api/my-products', route => route.fulfill({ json: [] }))
  await page.route('**/api/profile', route => route.fulfill({ json: { wallet: { balance: 0, staked: 0 } } }))
  await page.route('**/api/orders', route => route.fulfill({ json: [] }))
  await page.route('**/api/rfqs?limit=50', route => route.fulfill({ json: { items: [], urgencies: ['now', 'today', 'flex'], categories: [] } }))
  await page.route('**/api/charity/me', route => route.fulfill({ json: { reputation: {}, pending_repayments: [] } }))
  await page.route('**/api/agents/me/reputation', route => route.fulfill({ json: { level: 'new', trust_score: 0 } }))
  await page.route('**/api/claim-tasks/mine', route => route.fulfill({ json: { as_buyer: [], as_verifier: [] } }))
  await page.route('**/api/skills/mine', route => route.fulfill({ json: [] }))
  await page.route('**/api/seller/quota-status', route => route.fulfill({ json: {
    total_used: 0,
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

for (const viewport of DASHBOARD_VIEWPORTS) {
  test(`authenticated buyer account dashboard at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockBuyerSession(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-buyer-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#me')

    await expect(page.locator('#app main')).toContainText(/我的购物|My shopping/i)
    await expect(page.locator('#app .tabbar')).toBeVisible()
    // UI-1 tightens this smoke into overflow + axe gates after fixing the known legacy debt.
    guards.assertClean()
  })

  test(`authenticated seller account dashboard at ${viewport.name}`, async ({ page }) => {
    const guards = installRuntimeGuards(page)
    await mockSellerDashboard(page)
    await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-seller-token'))
    await page.setViewportSize(viewport)
    await page.goto('/#me')

    await expect(page.locator('#app main')).toContainText('UX Seller')
    await expect(page.locator(`[onclick="location.hash='#rfqs'"]`)).toContainText(/抢单|RFQ/)
    await expect(page.locator('#app .tabbar')).toBeVisible()
    // UI-1 tightens this smoke into overflow + axe gates after fixing the known legacy debt.
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

test('authenticated seller baseline uses route-level API mocks', async ({ page }) => {
  const guards = installRuntimeGuards(page)
  await mockSellerDashboard(page)
  await page.addInitScript(() => localStorage.setItem('webaz_key', 'ux-seller-token'))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#seller')

  await assertClassicScriptsLoaded(page)
  await expect(page.locator('#app .navbar')).toBeVisible()
  await expect(page.locator('#app main')).toContainText(/卖家后台|Seller Dashboard/)
  await assertLanguageSync(page)
  await assertNoHorizontalOverflow(page)
  await assertAxeHasNoSeriousOrCriticalViolations(page)
  guards.assertClean()
})
