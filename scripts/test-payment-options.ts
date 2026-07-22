#!/usr/bin/env tsx
/**
 * RFC-029 Design A · PR-2 — seller-supported payment-OPTIONS enumerator + shared availability predicate.
 *
 * Proves:
 *  - escrow is ALWAYS offered (universal fallback), first, with an honest sim note.
 *  - direct_p2p options appear ONLY when the product/seller gate passes, and mirror resolveDirectReceive's
 *    universe (legacy instruction + each active account) — multi-account AND legacy-only sellers listed.
 *  - the resolveDirectReceive auto-pick is flagged `recommended` (soft default); a recommendation NEVER
 *    shrinks the menu (MA3): every supported option stays present regardless of the flag.
 *  - directPayProductAvailability is the SAME predicate the availability route uses.
 * Usage: npm run test:payment-options
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-payopts-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { toUnits } = await import('../src/money.js')
const { sellerSupportedPaymentOptions } = await import('../src/direct-pay-payment-options.js')
const { directPayProductAvailability } = await import('../src/direct-pay-availability-check.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)

// direct-pay controls config (enable + generous cap/region) via getProtocolParam stub
const cp: Record<string, unknown> = { 'direct_pay.enabled': true, 'direct_pay.region': 'SG', 'direct_pay.region_allowlist': 'SG', 'direct_pay.per_tx_cap_units': toUnits(1000) }
const gp = <T>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)

// eligible-seller fixtures (mirror test-direct-pay-create seeds)
const seedBond = (s: string) => db.prepare("INSERT INTO direct_receive_deposits (id,user_id,tier,required_amount,amount,currency,deposit_rail,status,production_receipt_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)").run('dep_' + s, s, 'T0', 500, 500, 'usdc', 'manual', 'locked', new Date().toISOString())
const seedSanctions = (s: string) => db.prepare("INSERT INTO sanctions_screening (id, user_id, status) VALUES (?,?,'clear')").run('sc_' + s, s)
const seedKyb = (s: string) => db.prepare("INSERT INTO direct_receive_kyb_reviews (id, user_id, status) VALUES (?,?,'approved')").run('kyb_' + s, s)
const seedProductVerified = (p: string, s: string) => db.prepare("INSERT INTO product_verifications (id, product_id, seller_id, code, status, reviewed_by, reviewed_at) VALUES (?,?,?,?, 'verified', 'admin1', datetime('now'))").run('pvf_' + p, p, s, 'wzv_' + p)
const makeEligible = (s: string, p: string): void => { seedBond(s); seedSanctions(s); seedKyb(s); seedProductVerified(p, s) }
const mkSeller = (id: string): void => { db.prepare("INSERT INTO users (id,name,role,api_key) VALUES (?,?,'seller',?)").run(id, id, 'k_' + id) }
const mkProduct = (id: string, s: string): void => { db.prepare("INSERT INTO products (id, seller_id, title, description, price, stock, status) VALUES (?,?,'T','d',50,10,'active')").run(id, s) }
const acct = (id: string, s: string, method: string, label: string, status = 'active'): void => { db.prepare("INSERT INTO direct_receive_accounts (id, seller_id, method, currency, instruction, label, status) VALUES (?,?,?,?,?,?,?)").run(id, s, method, 'SGD', id + '-INSTR', label, status) }
const legacyInstr = (s: string): void => { db.prepare("INSERT INTO direct_receive_payment_instructions (id, seller_id, instruction, label, status) VALUES (?,?,?,?,'active')").run('pi_' + s, s, 'PayNow +65 9xxx (off-protocol)', 'PayNow-legacy') }

const optsFor = (productId: string, sellerId: string) => sellerSupportedPaymentOptions(db, { productId, sellerId, amountUnits: toUnits(50), getProtocolParam: gp })
const ids = (o: { option_id: string }[]) => o.map(x => x.option_id).sort()
const rec = (o: { option_id: string; recommended: boolean }[]) => o.filter(x => x.recommended).map(x => x.option_id)

// ── Seller A: NOT direct-eligible (no bond/kyb/sanctions) → escrow only ──
mkSeller('sA'); mkProduct('pA', 'sA'); acct('accA', 'sA', 'PayNow', 'A-PayNow')   // has an account, but gate fails
const oA = optsFor('pA', 'sA')
ok('A: not eligible → escrow ONLY (direct gated off even with an account)', ids(oA).join() === 'escrow')
ok('A: escrow is first, rail=escrow, sim note, method null', oA[0].option_id === 'escrow' && oA[0].rail === 'escrow' && /模拟托管/.test(oA[0].settlement_note) && oA[0].method === null)
ok('A: directPayProductAvailability = false for ineligible seller', directPayProductAvailability(db, { productId: 'pA', sellerId: 'sA', amountUnits: toUnits(50), getProtocolParam: gp }).available === false)

// ── Seller B: eligible, legacy instruction + 2 active accounts → escrow + legacy(rec) + 2 accounts ──
mkSeller('sB'); mkProduct('pB', 'sB'); makeEligible('sB', 'pB'); legacyInstr('sB'); acct('accB1', 'sB', 'PayNow', 'B1'); acct('accB2', 'sB', 'Bank', 'B2'); acct('accBoff', 'sB', 'GCash', 'Boff', 'inactive')
const oB = optsFor('pB', 'sB')
ok('B: eligible → escrow + legacy + BOTH active accounts (inactive excluded)', ids(oB).join() === ['escrow', 'direct:legacy', 'direct:accB1', 'direct:accB2'].sort().join())
ok('B: legacy is recommended (resolveDirectReceive prefers legacy); exactly one recommended', rec(oB).join() === 'direct:legacy')
ok('B: direct options carry method+label; non-custodial note', oB.filter(o => o.rail === 'direct_p2p').every(o => /直付/.test(o.settlement_note)) && oB.find(o => o.option_id === 'direct:accB1')!.method === 'PayNow')
ok('B: availability true', directPayProductAvailability(db, { productId: 'pB', sellerId: 'sB', amountUnits: toUnits(50), getProtocolParam: gp }).available === true)

// ── Seller C: eligible, 1 active account, NO legacy → account recommended (sole_active_account) ──
mkSeller('sC'); mkProduct('pC', 'sC'); makeEligible('sC', 'pC'); acct('accC', 'sC', 'USDC', 'C-USDC')
const oC = optsFor('pC', 'sC')
ok('C: one account, no legacy → escrow + that account, account recommended', ids(oC).join() === ['escrow', 'direct:accC'].sort().join() && rec(oC).join() === 'direct:accC')

// ── Seller D: eligible, 2 accounts, NO legacy → both listed, NONE recommended (ambiguous default) ──
mkSeller('sD'); mkProduct('pD', 'sD'); makeEligible('sD', 'pD'); acct('accD1', 'sD', 'PayNow', 'D1'); acct('accD2', 'sD', 'Bank', 'D2')
const oD = optsFor('pD', 'sD')
ok('D: two accounts, no legacy → both listed', ids(oD).join() === ['escrow', 'direct:accD1', 'direct:accD2'].sort().join())
ok('D: MA3 — ambiguous default → NONE recommended, but every supported option still present (recommendation never shrinks menu)', rec(oD).length === 0 && oD.filter(o => o.rail === 'direct_p2p').length === 2)

// ── Seller F: eligible, LEGACY instruction ONLY (no accounts) → escrow + legacy(recommended) ──
mkSeller('sF'); mkProduct('pF', 'sF'); makeEligible('sF', 'pF'); legacyInstr('sF')
const oF = optsFor('pF', 'sF')
ok('F: legacy-only seller → escrow + legacy(recommended), NOT under-listed', ids(oF).join() === ['escrow', 'direct:legacy'].sort().join() && rec(oF).join() === 'direct:legacy')

// ── Seller E: eligible but NO receive method (no legacy, no accounts) → escrow only (honest: direct has no destination) ──
mkSeller('sE'); mkProduct('pE', 'sE'); makeEligible('sE', 'pE')
const oE = optsFor('pE', 'sE')
ok('E: eligible but no receive destination → escrow only (no un-payable direct option surfaced)', ids(oE).join() === 'escrow')

if (fail > 0) { console.error(`\n❌ payment-options FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ payment-options: escrow-always + direct gated by shared availability predicate; mirrors resolveDirectReceive (legacy + active accounts); recommended = auto-pick, never shrinks the menu (MA3)\n  ✅ pass ${pass}`)
