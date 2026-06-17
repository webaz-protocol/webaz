#!/usr/bin/env tsx
/**
 * 店铺推荐锚定 + 下单懒升级商品三级归因 — behavioral + static.
 *   用法:npm run test:shop-referral-attribution
 *
 * Verifies the two-layer model:
 *   · POST /api/shop-referral/touch anchors ONLY the referral relationship (first-touch 30d, invite-code
 *     refs only — usr_xxx/@handle/handle rejected; self/seller degenerate relations safely skipped;
 *     unexpired rows never overwritten; expired rows refreshable; unaffected by invite_rotation_enabled).
 *   · maybePromoteShopReferralToProductAttribution lazily upgrades a shop referral to ONE product's
 *     product_share_attribution at order time, ONLY when the referrer has a completed purchase of the SAME
 *     product + rewards opt-in + allowed-sponsor; it never overrides a live direct-share attribution;
 *     referrer===seller / expired referral / unqualified referrer never upgrade. Provenance is recorded
 *     (shop_referral_verified_purchase + qualified order) without touching settlement math.
 *   · PWA ShareCtx captures pending_shop_referral from ?ref=CODE + #shop/<seller> and touches after login;
 *     shop page copy is honest (no "share shop = whole-shop commission" implication).
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerShopReferralRoutes } from '../src/pwa/routes/shop-referral.js'
import { maybePromoteShopReferralToProductAttribution } from '../src/pwa/routes/orders-create.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
const INTERNAL_AUDITOR_ID = 'usr_iaudit_001'
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, handle TEXT, permanent_code TEXT, rewards_opted_in INTEGER DEFAULT 0, role TEXT DEFAULT 'buyer')`)
db.prepare(`INSERT INTO users (id,name,handle,permanent_code,rewards_opted_in,role) VALUES
  ('usr_ref','Ref','ref','REF001',1,'buyer'),
  ('usr_buyer','Buyer','buyer','BUY001',0,'buyer'),
  ('usr_seller','Seller','seller','SEL001',1,'seller'),
  ('usr_up','Upstream','up','UPP001',1,'buyer'),
  ('usr_noopt','NoOpt','noopt','NOP001',0,'buyer'),
  ('sys_protocol','sys',NULL,'SYS000',0,'admin'),
  (?, 'aud','aud','AUD000',0,'admin')`).run(INTERNAL_AUDITOR_ID)
// mirror the prod schema (server.ts) incl. the additive provenance columns
db.exec(`CREATE TABLE shop_referral_attribution (
  seller_id TEXT NOT NULL, recipient_id TEXT NOT NULL, referrer_id TEXT NOT NULL, ref_code TEXT NOT NULL,
  side TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
  source TEXT DEFAULT 'shop_referral', PRIMARY KEY (seller_id, recipient_id))`)
db.exec(`CREATE TABLE product_share_attribution (
  product_id TEXT NOT NULL, recipient_id TEXT NOT NULL, sharer_id TEXT NOT NULL, shareable_id TEXT,
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
  source_type TEXT, source_ref TEXT, source_shop_seller_id TEXT, source_qualified_order_id TEXT,
  PRIMARY KEY (product_id, recipient_id))`)
db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, product_id TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`)
db.exec(`CREATE TABLE order_state_history (id TEXT PRIMARY KEY, order_id TEXT, from_status TEXT, to_status TEXT, created_at TEXT DEFAULT (datetime('now')))`)
const completeAt = (orderId: string, when: string) =>
  db.prepare("INSERT INTO order_state_history (id, order_id, from_status, to_status, created_at) VALUES (?,?,?,?,?)").run('h_' + orderId + '_' + Math.random().toString(36).slice(2, 6), orderId, 'shipped', 'completed', when)
db.exec(`CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT)`)
db.prepare("INSERT INTO system_state (key,value) VALUES ('invite_rotation_enabled','0')").run()   // 公开获取邀请码已关闭
setSeamDb(db)

// mirrors of the server resolvers (the routes receive these via deps)
function resolveInviteCodeRef(raw: string | null | undefined): { userId: string; code: string; side: 'left' | 'right' | null } | null {
  if (!raw || typeof raw !== 'string') return null
  const m = raw.trim().match(/^([A-Za-z0-9]{6,7})(?:-([LRlr]))?$/)
  if (!m) return null
  const code = m[1].toUpperCase()
  const side: 'left' | 'right' | null = m[2] ? (m[2].toLowerCase() === 'l' ? 'left' : 'right') : null
  const r = db.prepare("SELECT id FROM users WHERE permanent_code = ? AND id NOT IN ('sys_protocol', ?) LIMIT 1").get(code, INTERNAL_AUDITOR_ID) as { id: string } | undefined
  return r ? { userId: r.id, code, side } : null
}
function resolveUserRef(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const ref = raw.trim()
  if (/^usr_[A-Za-z0-9_]+$/.test(ref)) return (db.prepare('SELECT id FROM users WHERE id = ?').get(ref) as any)?.id || null
  const h = ref.replace(/^@/, '').toLowerCase()
  return (db.prepare('SELECT id FROM users WHERE handle = ?').get(h) as any)?.id || null
}
// mirror of server.ts getProductShareChain (chain walk itself is pre-existing, untouched by this PR)
function chain(productId: string, buyerId: string, depth = 3): (string | null)[] {
  const out: (string | null)[] = []; let rec = buyerId; const seen = new Set([buyerId])
  for (let i = 0; i < depth; i++) {
    const row = db.prepare("SELECT sharer_id FROM product_share_attribution WHERE product_id = ? AND recipient_id = ? AND expires_at > datetime('now')").get(productId, rec) as any
    if (!row?.sharer_id || seen.has(row.sharer_id)) { while (out.length < depth) out.push(null); return out }
    out.push(row.sharer_id); seen.add(row.sharer_id); rec = row.sharer_id
  }
  return out
}

let server: Server, port = 0
let authedAs = 'usr_buyer'
const postJson = (path: string, body: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.write(payload); r.end()
})
const sra = (seller: string, recipient: string) => db.prepare('SELECT * FROM shop_referral_attribution WHERE seller_id = ? AND recipient_id = ?').get(seller, recipient) as any
const psa = (product: string, recipient: string) => db.prepare('SELECT * FROM product_share_attribution WHERE product_id = ? AND recipient_id = ?').get(product, recipient) as any
const promote = (product: string, seller: string, buyer: string, allowed = (_: string) => true) =>
  maybePromoteShopReferralToProductAttribution(db, { internalAuditorId: INTERNAL_AUDITOR_ID, isAllowedSponsor: allowed }, product, seller, buyer)

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerShopReferralRoutes(app, {
    db, auth: (() => ({ id: authedAs })) as any,
    errorRes: ((res: any, status: number, code: string, msg: string, extra: any) => res.status(status).json({ error: msg, error_code: code, ...(extra || {}) })) as any,
    internalAuditorId: INTERNAL_AUDITOR_ID, resolveUserRef, resolveInviteCodeRef,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // ── A) touch endpoint ───────────────────────────────────────────────────────────────────────────────
  { const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: 'REF001' })
    ok('A1 touch CODE → attributed', r.json?.ok === true && r.json?.attributed === true && r.json?.seller_id === 'usr_seller', JSON.stringify(r.json))
    const row = sra('usr_seller', 'usr_buyer')
    ok('A1 row: referrer/ref_code/side/expiry', row?.referrer_id === 'usr_ref' && row?.ref_code === 'REF001' && row?.side === null && row?.expires_at > '2026', JSON.stringify(row)) }
  // 公开获取邀请码关闭(invite_rotation_enabled=0)不影响 touch — A1 已在该状态下成功
  ok('A2 rotation off does not affect touch (A1 succeeded with flag=0)', (db.prepare("SELECT value FROM system_state WHERE key='invite_rotation_enabled'").get() as any).value === '0')
  for (const bad of ['usr_ref', '@ref', 'ref', INTERNAL_AUDITOR_ID]) {
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: bad })
    ok(`A3 ref_code rejects ${bad}`, r.status === 400 && r.json?.error_code === 'INVALID_REF_CODE', JSON.stringify(r.json))
  }
  { const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: 'UPP001' })
    ok('A4 first-touch lock: second referrer → already_locked, row unchanged', r.json?.skipped === 'already_locked' && sra('usr_seller', 'usr_buyer')?.referrer_id === 'usr_ref', JSON.stringify(r.json)) }
  { authedAs = 'usr_ref'
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: 'REF001' })
    ok('A5 self_referral skipped safely', r.json?.skipped === 'self_referral' && !sra('usr_seller', 'usr_ref'), JSON.stringify(r.json)) }
  { authedAs = 'usr_seller'
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: 'REF001' })
    ok('A6 recipient===seller skipped safely', r.json?.skipped === 'recipient_is_seller', JSON.stringify(r.json)) }
  { authedAs = 'usr_buyer'
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: '@seller', ref_code: 'REF001-L' })
    ok('A7 seller_identifier accepts @handle; already_locked (same pair)', r.json?.skipped === 'already_locked', JSON.stringify(r.json)) }
  { db.prepare("UPDATE shop_referral_attribution SET expires_at = datetime('now','-1 day') WHERE seller_id='usr_seller' AND recipient_id='usr_buyer'").run()
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: 'UPP001-R' })
    const row = sra('usr_seller', 'usr_buyer')
    // pre-public 去左右码:CODE-R 后缀仅向后兼容(归一化为基础码),side 一律忽略 → 存 null(不再 right)
    ok('A8 expired row refreshed; CODE-R suffix accepted but side IGNORED → null', r.json?.attributed === true && row?.referrer_id === 'usr_up' && row?.side === null, JSON.stringify(row)) }
  { authedAs = 'usr_up'   // pre-public 去左右码:body.side 也被忽略 → 归属 side null
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_seller', ref_code: 'REF001', side: 'right' })
    const row = sra('usr_seller', 'usr_up')
    ok('A8b body side=right is IGNORED → attribution side null', r.json?.attributed === true && row?.side === null, JSON.stringify(row))
    authedAs = 'usr_buyer' }
  { const r = await postJson('/api/shop-referral/touch', { seller_identifier: 'usr_ghost', ref_code: 'REF001' })
    ok('A9 unknown seller → typed 404', r.status === 404 && r.json?.error_code === 'SELLER_NOT_FOUND', JSON.stringify(r.json)) }
  { // seller_identifier 解析到非 seller 用户(usr_up 是 buyer)→ 拒绝且不落库
    const r = await postJson('/api/shop-referral/touch', { seller_identifier: '@up', ref_code: 'REF001' })
    ok('A10 non-seller as seller_identifier → 404, no row', r.status === 404 && r.json?.error_code === 'SELLER_NOT_FOUND' && !sra('usr_up', 'usr_buyer'), JSON.stringify(r.json)) }
  server.close()

  // reset referral to usr_ref for the promotion tests
  db.prepare('DELETE FROM shop_referral_attribution').run()
  db.prepare("INSERT INTO shop_referral_attribution (seller_id,recipient_id,referrer_id,ref_code,side,expires_at) VALUES ('usr_seller','usr_buyer','usr_ref','REF001',NULL,datetime('now','+30 days'))").run()

  // ── B) lazy upgrade at order time ───────────────────────────────────────────────────────────────────
  // B1: referrer never bought prod_A → no attribution; order L1 would be null
  promote('prod_A', 'usr_seller', 'usr_buyer')
  ok('B1 referrer没买过该商品 → 不写归因', !psa('prod_A', 'usr_buyer'))
  ok('B1 chain L1 = null (不来自店铺推荐)', chain('prod_A', 'usr_buyer')[0] === null)

  // B2: referrer bought a DIFFERENT product in the same shop → still no attribution for prod_A
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status) VALUES ('ord_other','usr_ref','prod_B','completed')").run()
  promote('prod_A', 'usr_seller', 'usr_buyer')
  ok('B2 referrer买过同店另一商品 → 不写当前商品归因', !psa('prod_A', 'usr_buyer'))

  // B3: referrer completed the SAME product BEFORE the shop referral was anchored → upgrade fires
  const dt = (mod: string) => (db.prepare("SELECT datetime('now', ?) t").get(mod) as any).t
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status,created_at) VALUES ('ord_qual','usr_ref','prod_A','completed',datetime('now','-2 days'))").run()
  completeAt('ord_qual', dt('-2 days'))   // 完成时间 -2d < referral.created_at(now)→ 先成交后分享 ✓
  promote('prod_A', 'usr_seller', 'usr_buyer')
  { const row = psa('prod_A', 'usr_buyer')
    ok('B3 同款 completed → 写入归因 sharer=referrer', row?.sharer_id === 'usr_ref' && row?.shareable_id === null, JSON.stringify(row))
    ok('B3 provenance = shop_referral_verified_purchase + ref + seller + qualified order', row?.source_type === 'shop_referral_verified_purchase' && row?.source_ref === 'REF001' && row?.source_shop_seller_id === 'usr_seller' && row?.source_qualified_order_id === 'ord_qual', JSON.stringify(row))
    ok('B3 order chain L1 = referrer', chain('prod_A', 'usr_buyer')[0] === 'usr_ref') }

  // B3b 时间边界反例:店铺推荐先锚定,推荐人【之后】才完成同款 → 不得反向升级
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status) VALUES ('ord_late','usr_ref','prod_C','completed')").run()
  completeAt('ord_late', dt('+1 hour'))   // 完成时间晚于 referral.created_at
  promote('prod_C', 'usr_seller', 'usr_buyer')
  ok('B3b 推荐先于成交(completion AFTER anchor)→ 不升级', !psa('prod_C', 'usr_buyer'))

  // B3c fallback 正例:无 history 行 → 用 orders.updated_at;updated_at 早于锚定 → 升级
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status,updated_at) VALUES ('ord_fb','usr_ref','prod_D','completed',datetime('now','-1 day'))").run()
  promote('prod_D', 'usr_seller', 'usr_buyer')
  ok('B3c 无 history → updated_at fallback,先成交后分享 → 升级', psa('prod_D', 'usr_buyer')?.sharer_id === 'usr_ref' && psa('prod_D', 'usr_buyer')?.source_qualified_order_id === 'ord_fb')

  // B3d fallback 反例:无 history 且 updated_at 晚于锚定 → 不升级
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status,updated_at) VALUES ('ord_fb2','usr_ref','prod_E','completed',datetime('now','+1 hour'))").run()
  promote('prod_E', 'usr_seller', 'usr_buyer')
  ok('B3d 无 history 且 updated_at 晚于锚定 → 不升级', !psa('prod_E', 'usr_buyer'))

  // B4: referrer has his own upstream same-product attribution → buyer gets L1/L2
  db.prepare("INSERT INTO product_share_attribution (product_id,recipient_id,sharer_id,shareable_id,expires_at,source_type) VALUES ('prod_A','usr_ref','usr_up',NULL,datetime('now','+30 days'),'direct_share')").run()
  { const c = chain('prod_A', 'usr_buyer')
    ok('B4 上游同款归因 → L1=referrer, L2=upstream', c[0] === 'usr_ref' && c[1] === 'usr_up', JSON.stringify(c)) }

  // B5: a live DIRECT product attribution is never overridden by a shop referral
  db.prepare("DELETE FROM product_share_attribution WHERE product_id='prod_A' AND recipient_id='usr_buyer'").run()
  db.prepare("INSERT INTO product_share_attribution (product_id,recipient_id,sharer_id,shareable_id,expires_at,source_type) VALUES ('prod_A','usr_buyer','usr_up','sh_x',datetime('now','+10 days'),'direct_share')").run()
  promote('prod_A', 'usr_seller', 'usr_buyer')
  { const row = psa('prod_A', 'usr_buyer')
    ok('B5 有效直接归因不被店铺推荐覆盖', row?.sharer_id === 'usr_up' && row?.source_type === 'direct_share', JSON.stringify(row)) }

  // B6: expired product attribution IS refreshed by the shop-derived one (documented rule)
  db.prepare("UPDATE product_share_attribution SET expires_at = datetime('now','-1 day') WHERE product_id='prod_A' AND recipient_id='usr_buyer'").run()
  promote('prod_A', 'usr_seller', 'usr_buyer')
  { const row = psa('prod_A', 'usr_buyer')
    ok('B6 过期商品归因 → 被店铺懒升级刷新', row?.sharer_id === 'usr_ref' && row?.source_type === 'shop_referral_verified_purchase', JSON.stringify(row)) }

  // B7: referrer === seller → relation may exist but NEVER upgrades to commission attribution
  db.prepare('DELETE FROM product_share_attribution').run()
  db.prepare('DELETE FROM shop_referral_attribution').run()
  db.prepare("INSERT INTO shop_referral_attribution (seller_id,recipient_id,referrer_id,ref_code,expires_at) VALUES ('usr_seller','usr_buyer','usr_seller','SEL001',datetime('now','+30 days'))").run()
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status) VALUES ('ord_s','usr_seller','prod_A','completed')").run()
  promote('prod_A', 'usr_seller', 'usr_buyer')
  ok('B7 referrer===seller → 不升级(防卖家双重获益)', !psa('prod_A', 'usr_buyer'))

  // B8: expired shop referral → no upgrade
  db.prepare('DELETE FROM shop_referral_attribution').run()
  db.prepare("INSERT INTO shop_referral_attribution (seller_id,recipient_id,referrer_id,ref_code,expires_at) VALUES ('usr_seller','usr_buyer','usr_ref','REF001',datetime('now','-1 day'))").run()
  promote('prod_A', 'usr_seller', 'usr_buyer')
  ok('B8 过期店铺推荐 → 不升级', !psa('prod_A', 'usr_buyer'))

  // B9: referrer not rewards-opted-in → no upgrade
  db.prepare('DELETE FROM shop_referral_attribution').run()
  db.prepare("INSERT INTO shop_referral_attribution (seller_id,recipient_id,referrer_id,ref_code,expires_at) VALUES ('usr_seller','usr_buyer','usr_noopt','NOP001',datetime('now','+30 days'))").run()
  db.prepare("INSERT INTO orders (id,buyer_id,product_id,status) VALUES ('ord_n','usr_noopt','prod_A','completed')").run()
  promote('prod_A', 'usr_seller', 'usr_buyer')
  ok('B9 referrer 未 opt-in → 不升级', !psa('prod_A', 'usr_buyer'))

  // B10: isAllowedSponsor=false → no upgrade (economic boundary reused)
  db.prepare('DELETE FROM shop_referral_attribution').run()
  db.prepare("INSERT INTO shop_referral_attribution (seller_id,recipient_id,referrer_id,ref_code,expires_at) VALUES ('usr_seller','usr_buyer','usr_ref','REF001',datetime('now','+30 days'))").run()
  promote('prod_A', 'usr_seller', 'usr_buyer', () => false)
  ok('B10 isAllowedSponsor=false → 不升级', !psa('prod_A', 'usr_buyer'))

  // ── C) PWA + 边界 statics ───────────────────────────────────────────────────────────────────────────
  const app_js = read('src/pwa/public/app.js')
  ok('C ShareCtx captures pending_shop_referral from #shop/ + ref', /pending_shop_referral = \{ seller_identifier: sellerIdent, ref_code: hint\.sponsor_id/.test(app_js))
  ok('C maybeClaimPendingShopReferral validates code-only + clears stale', /maybeClaimPendingShopReferral/.test(app_js) && /\^\[A-Za-z0-9\]\{6,7\}\$\/\.test\(p\.ref_code\)/.test(app_js))
  ok('C claim wired at login/register/boot (≥5 call sites incl. def)', (app_js.match(/maybeClaimPendingShopReferral\(\)/g) || []).length >= 5)
  ok('C shop link = target URL /?ref=CODE#shop/<seller> (query ref + hash target)', /\/\?ref=\$\{code\}#shop\/\$\{sellerId\}/.test(app_js))
  ok('C 推荐店铺 button uses permanent_code (no usr_ fallback)', /copyShopReferralLink/.test(app_js) && !/copyShopReferralLink[^}]*state\.user\.id/.test(app_js))
  ok('C honest copy: 商品分润仍需真实成交同款 + opt-in', /商品分润仍需你真实成交过同款并 opt-in/.test(app_js) && /只有你真实成交过的同款商品/.test(app_js))
  // parse-don't-prose: comments may NAME the forbidden claim in negation — scan comment-stripped code only
  const appCode = app_js.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')
  ok('C no "share shop = whole-shop commission" implication in rendered copy', !/全店佣金|whole-shop commission|分享店铺即可获得/.test(appCode))
  const shopReferral = read('src/pwa/routes/shop-referral.ts')
  ok('C touch endpoint never creates a shareable', !/INSERT INTO shareables/.test(shopReferral))
  const ordersCreate = read('src/pwa/routes/orders-create.ts')
  ok('C lazy upgrade runs BEFORE getProductShareChain in the order tx', (() => {
    const i = ordersCreate.indexOf('maybePromoteShopReferralToProductAttribution(db,')
    const j = ordersCreate.indexOf('const productChain = getProductShareChain')
    return i > 0 && j > i
  })())
  ok('C direct share-link gate unchanged (rewards opt-in still required)', /rewards_opt_in_required/.test(read('src/pwa/routes/products-meta.ts')))
  // i18n parity for the new keys
  const i18n = read('src/pwa/public/i18n.js')
  for (const k of ['推荐店铺', '店铺推荐链接已复制 — 商品分润仍需你真实成交过同款并 opt-in', '邀请码暂不可用，请刷新或联系支持']) {
    ok(`C i18n EN present: ${k.slice(0, 12)}…`, i18n.includes(`'${k}'`))
  }

  if (fail === 0) {
    console.log(`\n✅ shop referral attribution: touch = invite-code-only first-touch anchor (self/seller skip · lock · expired refresh · rotation-independent) · lazy upgrade only on referrer's completed SAME-product purchase + opt-in + allowed-sponsor (never overrides live direct share; refreshes expired; seller-as-referrer / expired / unqualified never upgrade; provenance recorded) · ShareCtx pending_shop_referral + honest shop-page copy\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ shop referral attribution FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
