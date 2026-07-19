#!/usr/bin/env tsx
/**
 * PR-B6a — resolveDirectReceive 单一收款目的地解析真源。
 *   核心回归:新·多账户模型、无 legacy 单条指令的卖家(真实案例 @holden),买家 omit account_id 时
 *   此前被误判"无收款说明";resolver 的 sole-active 回落让其可解析。向后兼容:有 legacy 的卖家逐字不变。
 * Usage: npm run test:direct-receive-resolve
 */
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
// 单测隔离:import schema 会按 HOME 初始化 ~/.webaz/webaz.db —— 先把 HOME 指向临时目录,绝不碰真实本地库。
const __tmpHome = mkdtempSync(join(tmpdir(), 'dr-resolve-')); process.env.HOME = __tmpHome; process.env.USERPROFILE = __tmpHome
const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { addAccount, deactivateAccount } = await import('../src/direct-receive-accounts.js')
const { setActivePaymentInstruction } = await import('../src/direct-receive-payment-instruction.js')
const { resolveDirectReceive } = await import('../src/direct-receive-resolve.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = initDatabase(); setSeamDb(db)
const seller = (id: string) => db.prepare("INSERT INTO users (id,name,role,api_key) VALUES (?,?, 'seller', ?)").run(id, id, 'k_' + id)
const acct = (sellerId: string, label: string) => { const r = addAccount(db, sellerId, { method: 'bank', currency: 'SGD', instruction: 'pay ' + label, label } as never, generateId); if (!r.ok) throw new Error(r.reason); return r.account }

try {
  // ── S1: 只有新账户、无 legacy(@holden 情形)—— omit 应解析到唯一 active 账户 ──
  seller('s_new'); const a1 = acct('s_new', 'PayNow')
  const r1 = resolveDirectReceive(db, 's_new')
  ok('B6a-1 new-model sole active account, NO legacy → omit RESOLVES (fixes @holden)', r1.resolvable === true && r1.source === 'sole_active_account' && r1.account_id === a1.id)
  ok('B6a-1b resolved carries non-sensitive metadata + raw instruction for server snapshot', r1.method === 'bank' && r1.currency === 'SGD' && r1.label === 'PayNow' && r1.instruction === 'pay PayNow')

  // ── S2: 有 legacy 单条指令 —— omit 逐字保留旧行为(legacy 优先,account_id=null)──
  seller('s_leg'); acct('s_leg', 'AcctX'); setActivePaymentInstruction(db, 's_leg', { instruction: 'legacy pay here', label: 'Legacy' }, generateId)
  const r2 = resolveDirectReceive(db, 's_leg')
  ok('B6a-2 legacy instruction present → omit uses LEGACY (backward-compatible, unchanged)', r2.resolvable === true && r2.source === 'legacy_instruction' && r2.account_id === null && r2.instruction === 'legacy pay here')

  // ── S3: 卖家完全没配 —— 不可解析 ──
  seller('s_none')
  const r3 = resolveDirectReceive(db, 's_none')
  ok('B6a-3 no accounts and no legacy → NOT resolvable (omit)', r3.resolvable === false && r3.source === 'none' && r3.instruction === null)

  // ── S4: >1 active 账户且无 legacy —— 目的地不唯一,omit 不可解析(买家必须选)──
  seller('s_multi'); acct('s_multi', 'A'); acct('s_multi', 'B')
  const r4 = resolveDirectReceive(db, 's_multi')
  ok('B6a-4 multiple active accounts, no legacy → omit NOT resolvable (buyer must choose)', r4.resolvable === false)

  // ── S5: chosen 有效 → 用它;chosen 无效/非本卖家/停用 → 不可解析(fail-closed)──
  const r5 = resolveDirectReceive(db, 's_multi', db.prepare("SELECT id FROM direct_receive_accounts WHERE seller_id='s_multi' ORDER BY created_at ASC LIMIT 1").get()!.id as string)
  ok('B6a-5 chosen valid account → source=chosen (buyer explicit pick honored even when multiple)', r5.resolvable === true && r5.source === 'chosen')
  ok('B6a-5b chosen unknown id → NOT resolvable (fail-closed, caller → DIRECT_RECEIVE_ACCOUNT_INVALID)', resolveDirectReceive(db, 's_multi', 'dra_does_not_exist').resolvable === false)
  ok('B6a-5c chosen account of ANOTHER seller → NOT resolvable (cross-seller fail-closed)', resolveDirectReceive(db, 's_new', db.prepare("SELECT id FROM direct_receive_accounts WHERE seller_id='s_multi' LIMIT 1").get()!.id as string).resolvable === false)

  // ── S6: 唯一账户被停用后 → 回到不可解析(不静默用 inactive)──
  deactivateAccount(db, a1.id, 's_new')
  ok('B6a-6 sole account deactivated → omit no longer resolvable (never uses inactive)', resolveDirectReceive(db, 's_new').resolvable === false)
} catch (e) { fail++; fails.push('✗ THREW: ' + ((e as Error).stack || (e as Error).message)) }
try { rmSync(__tmpHome, { recursive: true, force: true }) } catch { /* temp HOME cleanup */ }

if (fail > 0) { console.error(`\n❌ direct-receive-resolve FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-receive-resolve: single source of truth — chosen → legacy → sole-active-account → none; new-model-only sellers (no legacy) now resolve on omit (fixes @holden); legacy sellers unchanged; multi-account requires explicit pick; cross-seller/unknown/inactive fail-closed\n  ✅ pass ${pass}`)
