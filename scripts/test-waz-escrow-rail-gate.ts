#!/usr/bin/env tsx
/**
 * WAZ 退役(2026-07-23)PR-A1 — 模拟托管轨渠道开关(payment_rail_waz_escrow_enabled,默认关)。
 *
 * Proves(fail-closed 三层同真值):
 *  1. 菜单层:sellerSupportedPaymentOptions 渠道关 → 无 escrow 选项(详见 test-payment-options)。
 *  2. 建单层:cart-checkout 渠道关 → 一切都没碰就抛 RAIL_DISABLED 409(行为测试);
 *     orders-create escrow 路径硬闸位于 direct_p2p 分叉之后、钱包预检之前(源码锁)。
 *  3. 报价层:buyer-quote 显式 escrow 在 quote 即拒(不冻结死路草稿);escrow next_steps 建议只在渠道开时给(源码锁)。
 *  4. 双语:RAIL_DISABLED 进 orderErrorLookup + i18n _EN;param 已注册进 DEFAULT_PARAMS(默认 '0')。
 * Usage: npm run test:waz-escrow-rail-gate
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-wazgate-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { checkoutSelectedCart, CartCheckoutError } = await import('../src/cart-checkout.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)

const cp: Record<string, unknown> = {}
const gp = <T>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
const noTouch = (): never => { throw new Error('must not be reached while channel is off') }

// ── 1. cart-checkout:渠道关(默认)→ 第一动作即抛 RAIL_DISABLED,不 normalize、不进事务 ──
const cartArgs = {
  db, buyerId: 'buyer1', selectedItems: undefined as unknown,   // 故意非法:若 gate 不在最前,会先抛 CART_SELECTION_REQUIRED
  shippingAddress: 'addr', generateId: noTouch, checkStockAndMaybeDelist: noTouch as unknown as (p: string) => void,
  addHours: noTouch as unknown as (d: Date, h: number) => string, getProtocolParam: gp,
}
try { checkoutSelectedCart(cartArgs); ok('cart: off → throws', false) } catch (e) {
  ok('cart: default(off) → RAIL_DISABLED 409 before anything else (even before selection validation)',
    e instanceof CartCheckoutError && e.errorCode === 'RAIL_DISABLED' && e.status === 409, String(e))
}
cp['payment_rail_waz_escrow_enabled'] = 1
try { checkoutSelectedCart(cartArgs); ok('cart: on → proceeds past gate', false) } catch (e) {
  ok('cart: param=1 → gate passes (next validation fires instead)',
    e instanceof CartCheckoutError && e.errorCode === 'CART_SELECTION_REQUIRED', String(e))
}
cp['payment_rail_waz_escrow_enabled'] = 0
try { checkoutSelectedCart(cartArgs); ok('cart: 0 → throws', false) } catch (e) {
  ok('cart: explicit 0 → RAIL_DISABLED (same as absent)', e instanceof CartCheckoutError && e.errorCode === 'RAIL_DISABLED')
}

// ── 2. orders-create:escrow 硬闸源码锁(位置 = direct_p2p 分叉之后、钱包预检之前;fail-closed !== 1) ──
const OC = readFileSync(new URL('../src/pwa/routes/orders-create.ts', import.meta.url), 'utf8')
const iDirect = OC.indexOf("=== 'direct_p2p') return void createDirectPayResponse")
const iGate = OC.indexOf("getProtocolParam('payment_rail_waz_escrow_enabled', 0)) !== 1")
const iWallet = OC.indexOf('SELECT balance FROM wallets WHERE user_id = ?')
ok('orders-create: gate exists, fail-closed (!== 1), fallback 0', iGate > 0)
ok('orders-create: gate sits AFTER direct_p2p fork and BEFORE the escrow wallet precheck', iDirect > 0 && iWallet > iGate && iGate > iDirect,
  `direct=${iDirect} gate=${iGate} wallet=${iWallet}`)
ok('orders-create: gate returns 409 RAIL_DISABLED', /payment_rail_waz_escrow_enabled', 0\)\) !== 1\) return void res\.status\(409\)\.json\(\{[^}]*RAIL_DISABLED/.test(OC))

// ── 3. buyer-quote:显式 escrow 在 quote 即拒;escrow 建议(next_steps)只在渠道开时给 ──
const BQ = readFileSync(new URL('../src/pwa/buyer-quote.ts', import.meta.url), 'utf8')
ok('buyer-quote: explicit escrow rejected at quote when channel off', /rail === 'escrow' && !wazEscrowOn/.test(BQ) && /PAYMENT_RAIL_DISABLED/.test(BQ))
ok('buyer-quote: wazEscrowOn reads the channel param fail-closed', /payment_rail_waz_escrow_enabled', 0\)\) === 1/.test(BQ))
ok('buyer-quote: escrowAlt suggestion is conditional on the channel', /const escrowAlt = wazEscrowOn \?/.test(BQ))
ok('buyer-quote: no unconditional "use payment_rail=escrow" hint remains', !/next_steps: \[[^\]]*'use payment_rail=escrow'/.test(BQ))

// ── 4. param 注册 + 双语错误码 ──
const SV = readFileSync(new URL('../src/pwa/server.ts', import.meta.url), 'utf8')
ok("server: DEFAULT_PARAMS registers payment_rail_waz_escrow_enabled with default '0', min 0 max 1",
  /key: 'payment_rail_waz_escrow_enabled', value: '0'[^}]*min: 0, max: 1/.test(SV))
const OE = readFileSync(new URL('../src/pwa/public/app-order-errors.js', import.meta.url), 'utf8')
ok('order-errors: RAIL_DISABLED mapped bilingual', /RAIL_DISABLED: t\('WAZ 模拟托管轨已下架/.test(OE))
const I18N = readFileSync(new URL('../src/pwa/public/i18n.js', import.meta.url), 'utf8')
ok('i18n: RAIL_DISABLED zh string has _EN entry', I18N.includes("'WAZ 模拟托管轨已下架,请选择直付方式下单':"))
// 菜单层与选择层同闸:choose-payment 复用 sellerSupportedPaymentOptions(菜单源头即真值)
const CPY = readFileSync(new URL('../src/pwa/order-submit-choose-payment.ts', import.meta.url), 'utf8')
ok('choose-payment: re-validates against sellerSupportedPaymentOptions (menu gate covers the choose path)', /sellerSupportedPaymentOptions\(db, \{/.test(CPY))
const DPO = readFileSync(new URL('../src/direct-pay-payment-options.ts', import.meta.url), 'utf8')
ok('payment-options: escrow push is channel-gated fail-closed', /payment_rail_waz_escrow_enabled', 0\)\) === 1/.test(DPO))

if (fail > 0) { console.error(`\n❌ waz-escrow-rail-gate FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ waz-escrow-rail-gate: channel switch default OFF — menu delisted + quote rejects + create/cart 409 RAIL_DISABLED, bilingual mapped, param registered\n  ✅ pass ${pass}`)
