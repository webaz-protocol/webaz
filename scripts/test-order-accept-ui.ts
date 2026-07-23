#!/usr/bin/env tsx
/**
 * 接单/运费/询价系列 UI(PR-4)—— 静态接线锚 + 通知模板 key 服务端↔客户端一致 + i18n parity。
 * Usage: npm run test:order-accept-ui
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const TLJS = readFileSync('src/pwa/public/app-order-timeline.js', 'utf8')   // 2026-07:时间线域从 app.js 抽出;banner 以 bannerStatus 喂标签
const UI = readFileSync('src/pwa/public/app-order-accept-ui.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')

// ── ① app.js 接线锚(7 处 hook,全部净零行原位)──
ok('1. badge chain includes dpAcceptBadge', /window\.dpAcceptBadge && window\.dpAcceptBadge\(status\)/.test(APP))
ok('2. label chain includes dpAcceptLabel', /window\.dpAcceptLabel && window\.dpAcceptLabel\(bannerStatus\)/.test(TLJS))
ok('3. buy sheet renders region block after rail selector', /dpRailSelectorHtml\(prod\.id, prod\.price\) : ''\}\$\{window\.shipRegionBlockHtml \? window\.shipRegionBlockHtml\(prod\.id\) : ''\}/.test(APP))
ok('4. buyOrder posts ship_to_region via shipSelectedRegion', /ship_to_region: \(window\.shipSelectedRegion \? window\.shipSelectedRegion\(\) : undefined\)/.test(APP))
ok('5. order detail injects dpPendingAcceptCard', /window\.dpPendingAcceptCard \? window\.dpPendingAcceptCard\(order, isBuyer, isSeller\)/.test(APP))
ok('6. seller settings section chained', /window\.shipSellerSettingsSection \? window\.shipSellerSettingsSection\(\)/.test(APP))
ok('7. seller settings hydrated', /window\.shipHydrateSellerSettings && window\.shipHydrateSellerSettings\(\)/.test(APP))
ok('8. script loaded after NOTIF_TEMPLATES base + before app.js', HTML.indexOf('app-notif-templates.js') < HTML.indexOf('app-order-accept-ui.js') && HTML.indexOf('app-order-accept-ui.js') < HTML.indexOf('"/app.js"'))

// ── ② 通知模板 key:服务端发出的每个 dp_pending/quote key 在客户端注册 ──
const SERVER = ['src/direct-pay-create.ts', 'src/pwa/routes/direct-pay-pending-accept.ts', 'src/pwa/routes/direct-pay-timeouts.ts']
  .map(f => readFileSync(f, 'utf8')).join('\n')
const emitted = [...new Set([...SERVER.matchAll(/templateKey: '(dp_(?:pending_accept|quote)_[a-z_]+)'/g)].map(m => m[1]))]
const registered = new Set([...UI.matchAll(/^\s{4}(dp_\w+):/gm)].map(m => m[1]))
const missing = emitted.filter(k => !registered.has(k))
ok('9. every server-emitted accept/quote templateKey registered client-side', emitted.length >= 9 && missing.length === 0, `emitted=${emitted.length} missing: ${missing.join(',')}`)

// ── ③ i18n parity:模块内 t() 与模板 zh 串全部有 _EN ──
const keys = new Set<string>()
for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
for (const m of UI.matchAll(/P\('[^']*', '([^']*)', '([^']*)'\)/g)) { keys.add(m[1]); keys.add(m[2]) }
const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
ok('10. i18n parity: every UI zh string has _EN', keys.size >= 70 && noEn.length === 0, `missing _EN: ${noEn.slice(0, 3).join(' | ')}`)

// ── ④ 端点存在性:UI 调用的每个 API 在后端有注册 ──
const ROUTES = ['src/pwa/routes/direct-pay-pending-accept.ts', 'src/pwa/routes/shipping-templates.ts'].map(f => readFileSync(f, 'utf8')).join('\n')
for (const ep of ['pending-accept/accept', 'pending-accept/decline', 'pending-accept/cancel', 'pending-accept/quote', 'pending-accept/confirm-quote', 'seller/accept-mode', 'seller/shipping-template', 'seller/shipping-settings', 'shipping-options']) {
  ok(`11. endpoint wired: ${ep}`, UI.includes(ep.replace('seller/shipping-settings', 'seller/shipping-settings')) && ROUTES.includes(ep))
}

// ── ⑤ 行为红线:确认前不出现付款字样按钮;撤单/谢绝文案强调"无责+未付款" ──
ok('12. buyer pending card never shows a pay button (payment only after accept/confirm)', !/dpHandleAction|mark_paid/.test(UI))
ok('13. no-fault + not-paid wording on destructive confirms', /订单将无责取消\(买家尚未付款\)/.test(UI) && /你尚未付款,无需任何操作/.test(UI))

if (fail > 0) { console.error(`\n❌ order-accept-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order accept/shipping/quote UI (PR-4): 7 app.js hooks + notif key coverage (server↔client) + i18n parity + endpoint existence + no-pay-before-accept red line\n  ✅ pass ${pass}`)
