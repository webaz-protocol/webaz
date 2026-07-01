#!/usr/bin/env tsx
/**
 * Direct Pay — 卖家多收款账号(direct_receive_accounts) schema + domain helper 测试 (Phase B)。
 * 验:表/列存在、normalizeAccountInput 校验(必填/长度/币种格式)、多个 active 可共存、owner-scoped
 *   update/deactivate、getAccount/list、以及【非托管边界】——helper 只写本表,绝不碰 wallet/escrow/settlement。
 * Usage: npm run test:direct-receive-accounts
 */
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dr-acct-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const {
  normalizeAccountInput, listSellerAccounts, getAccount, addAccount, updateAccount, deactivateAccount,
} = await import('../src/direct-receive-accounts.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
let _n = 0; const genId = (p: string): string => `${p}_${++_n}`

const db = initDatabase()
db.pragma('foreign_keys = OFF')
for (const [u, role] of [['seller1', 'seller'], ['seller2', 'seller']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)

// 1. schema — table + columns present
const cols = (db.prepare("PRAGMA table_info(direct_receive_accounts)").all() as Array<{ name: string }>).map(c => c.name)
ok('1a. table exists with expected columns', ['id', 'seller_id', 'method', 'currency', 'instruction', 'label', 'qr_image_ref', 'status', 'created_at', 'updated_at'].every(c => cols.includes(c)), 'got: ' + cols.join(','))

// 2. normalizeAccountInput — validation (pure)
ok('2a. instruction required', normalizeAccountInput({ instruction: '   ' }).ok === false)
ok('2b. instruction length capped', normalizeAccountInput({ instruction: 'x'.repeat(501) }).ok === false)
const norm = normalizeAccountInput({ instruction: '  PayNow 91234567 ', label: ' 主账户 ', method: ' PayNow ', currency: ' thb ', qrImageRef: ' abc ' })
ok('2c. valid input normalizes (trim + currency uppercased)', norm.ok === true && norm.ok && norm.value.instruction === 'PayNow 91234567' && norm.value.currency === 'THB' && norm.value.method === 'PayNow' && norm.value.label === '主账户' && norm.value.qr_image_ref === 'abc')
ok('2d. bad currency format rejected', normalizeAccountInput({ instruction: 'x', currency: 'not a code!' }).ok === false)
ok('2e. currency optional (omitted → null)', (() => { const r = normalizeAccountInput({ instruction: 'x' }); return r.ok && r.value.currency === null })())
// P3: over-length label/method/qr = REJECT, not silent slice/truncation
ok('2f. over-length label rejected (not truncated)', normalizeAccountInput({ instruction: 'x', label: 'L'.repeat(41) }).ok === false)
ok('2g. over-length method rejected (not truncated)', normalizeAccountInput({ instruction: 'x', method: 'M'.repeat(41) }).ok === false)
ok('2h. over-length qr ref rejected (not truncated)', normalizeAccountInput({ instruction: 'x', qrImageRef: 'q'.repeat(201) }).ok === false)
ok('2i. at-limit label accepted (boundary)', (() => { const r = normalizeAccountInput({ instruction: 'x', label: 'L'.repeat(40) }); return r.ok && r.value.label === 'L'.repeat(40) })())

// 3. addAccount — MULTIPLE active allowed (the whole point vs single-instruction)
const a1 = addAccount(db, 'seller1', { instruction: 'Kasikorn 123-4-56789', method: 'Bank', currency: 'THB', label: 'K-Bank' }, genId)
const a2 = addAccount(db, 'seller1', { instruction: 'GCash 0917-xxx', method: 'GCash', currency: 'PHP' }, genId)
ok('3a. addAccount ok', a1.ok === true && a2.ok === true)
ok('3b. two ACTIVE accounts coexist for one seller', listSellerAccounts(db, 'seller1').length === 2)
ok('3c. addAccount rejects invalid (empty instruction)', addAccount(db, 'seller1', { instruction: '' }, genId).ok === false)
ok('3d. stored fields round-trip (currency/method/qr)', (() => { const acc = a1.ok && getAccount(db, a1.account.id); return !!acc && acc.currency === 'THB' && acc.method === 'Bank' && acc.status === 'active' })())

// 4. owner scoping — seller2 cannot update/deactivate seller1's account
const id1 = a1.ok ? a1.account.id : ''
ok('4a. update is owner-scoped (wrong seller → no change)', (() => { const r = updateAccount(db, id1, 'seller2', { instruction: 'HACKED' }); return r.ok && r.changed === false })())
ok('4b. deactivate is owner-scoped (wrong seller → false)', deactivateAccount(db, id1, 'seller2') === false)
ok('4c. owner update changes fields', (() => { const r = updateAccount(db, id1, 'seller1', { instruction: 'Kasikorn 999', method: 'Bank', currency: 'THB' }); const acc = getAccount(db, id1); return r.ok && r.changed && !!acc && acc.instruction === 'Kasikorn 999' })())

// 5. deactivate → active list shrinks, includeInactive still shows it
ok('5a. owner deactivate returns true', deactivateAccount(db, id1, 'seller1') === true)
ok('5b. active list now excludes it', listSellerAccounts(db, 'seller1').length === 1)
ok('5c. includeInactive shows all', listSellerAccounts(db, 'seller1', { includeInactive: true }).length === 2)

// 6. non-custodial boundary — the domain module never touches money/state tables
const src = readFileSync('src/direct-receive-accounts.ts', 'utf8')
ok('6a. helper touches only direct_receive_accounts (no wallet/escrow/settlement/order writes)',
  !/\b(wallets|escrow|settlement|orders|order_events|penalt|balance)\b/i.test(src.replace(/^\s*\*.*$/gm, '')))

if (fail > 0) { console.error(`\n❌ direct-receive-accounts FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-receive-accounts (Phase B): multi-active accounts + per-account currency + qr_image_ref stored; validated; owner-scoped; non-custodial (store-only)\n  ✅ pass ${pass}`)
