#!/usr/bin/env tsx
/**
 * WAZ 退役 PR-A3 — 钱包信息面隐藏回归锁。
 * Proves:
 *   ① /api/wallet:渠道关(默认)→ sunset DTO(waz_sunset:true + 零余额 + 双语 notice),不派生充值地址、
 *     不读钱包行;渠道开 → 原行为。fail-closed。
 *   ② /api/wallet/withdraw + /connect/challenge:渠道关 → 409 RAIL_DISABLED(新申请断供);
 *     confirm/cancel 存量处理路径不门控(源码锁)。
 *   ③ PWA:钱包 tab/快捷钮/抽屉项/profile 余额卡全部下架(源码锁);renderWallet 深链 → 退役说明页。
 *   ④ MCP webaz_wallet:network 转发 /api/wallet(同真值);local 视图直读 param fail-closed(源码锁)。
 *   ⑤ 契约:CONTRACT_VERSION=30 已登记(v30 条目 + LOCK 同步;完整校验在 contract:verify)。
 * Usage: npm run test:waz-sunset-ui
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'wazui-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { registerWalletReadRoutes } = await import('../src/pwa/routes/wallet-read.js')
const { registerWalletWriteRoutes } = await import('../src/pwa/routes/wallet-write.js')
const express = (await import('express')).default

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('w1','w1','buyer','k_w1')").run()
try { db.exec('ALTER TABLE wallets ADD COLUMN deposit_address TEXT') } catch { /* 已存在 */ }
db.prepare("INSERT INTO wallets (user_id, balance, staked, earned, deposit_address) VALUES ('w1', 12.5, 3, 40, '0x' + 'c')").run()

const cp: Record<string, unknown> = {}
const gp = <T>(k: string, fb: T): T => (k in cp ? cp[k] as T : fb)
let derived = 0
const auth = (req: { headers: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }): Record<string, unknown> | null => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.headers['x-test-user'] || '')) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'login required' }); return null }
  return u
}
const app = express(); app.use(express.json())
/* eslint-disable @typescript-eslint/no-explicit-any */
const commonDeps: any = {
  db, auth, isTrustedRole: () => false, generateId: (p: string) => `${p}_x`, verifyPassword: () => true,
  deriveDepositAddress: () => { derived++; return '0x' + 'a'.repeat(40) }, getProtocolParam: gp,
  publicClient: () => null, getIsMainnet: () => false, getActiveChainId: () => 84532, getUsdcContract: () => '0x0', getNetwork: () => 'testnet',
  consumeGateToken: () => ({ ok: true }), sendMail: async () => {}, broadcastSystemEvent: () => {},
}
registerWalletReadRoutes(app, commonDeps)
registerWalletWriteRoutes(app, commonDeps)
const srv = app.listen(0)
const port = (srv.address() as { port: number }).port
const call = async (method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': 'w1' }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  try { return { status: r.status, json: JSON.parse(text) as Record<string, unknown> } } catch { return { status: r.status, json: { _non_json: text.slice(0, 120) } } }
}

// ── ① /api/wallet ──
const off = await call('GET', '/api/wallet')
ok('wallet read: default(off) → sunset DTO with zeroed fields + bilingual notice', off.status === 200 && off.json.waz_sunset === true && off.json.balance === 0 && /退役/.test(String(off.json.notice)) && /retired/.test(String(off.json.notice)), JSON.stringify(off.json))
ok('wallet read: off → no deposit-address derivation, wallet row untouched', derived === 0 && off.json.deposit_address === undefined)
cp['payment_rail_waz_escrow_enabled'] = 1
const on = await call('GET', '/api/wallet')
ok('wallet read: channel on → real balances restored (admin escape hatch)', on.json.waz_sunset === undefined && Number(on.json.balance) === 12.5, JSON.stringify(on.json))
cp['payment_rail_waz_escrow_enabled'] = 0

// ── ② withdraw / connect 断供 ──
const wd = await call('POST', '/api/wallet/withdraw', { to_address: '0x' + 'b'.repeat(40), amount: 50 })
ok('withdraw: off → 409 RAIL_DISABLED', wd.status === 409 && wd.json.error_code === 'RAIL_DISABLED', JSON.stringify(wd))
const cc = await call('POST', '/api/wallet/connect/challenge', {})
ok('connect: off → 409 RAIL_DISABLED', cc.status === 409 && cc.json.error_code === 'RAIL_DISABLED')
cp['payment_rail_waz_escrow_enabled'] = 1
const wdOn = await call('POST', '/api/wallet/withdraw', { to_address: '0x' + 'b'.repeat(40), amount: 50 })
ok('withdraw: on → gate passes (later validation fires instead)', wdOn.json.error_code !== 'RAIL_DISABLED', JSON.stringify(wdOn))
const WW = readFileSync(new URL('../src/pwa/routes/wallet-write.ts', import.meta.url), 'utf8')
const iConfirm = WW.indexOf("app.post('/api/wallet/withdraw/:id/confirm'")
const iCancel = WW.indexOf("app.post('/api/wallet/withdrawals/:id/cancel'")
const gateRe = /payment_rail_waz_escrow_enabled/g
const gates = [...WW.matchAll(gateRe)].map(m => m.index ?? 0)
ok('withdraw confirm/cancel (存量收敛路径) are NOT gated', iConfirm > 0 && iCancel > 0 && gates.every(i => i < iConfirm && i < iCancel))

// ── ③ PWA 源码锁 ──
const APP = readFileSync(new URL('../src/pwa/public/app.js', import.meta.url), 'utf8')
ok('pwa: zero wallet tab entries remain', (APP.match(/id: 'wallet'/g) || []).length === 0)
ok('pwa: seller shell wallet button + drawer item retired', !APP.includes('shell-wallet-btn') && !APP.includes("item('💰', t('钱包')"))
ok('pwa: renderWallet deep-link shows the sunset card', /wallet\?\.waz_sunset/.test(APP) && /WAZ 已退役/.test(APP))
const PROF = readFileSync(new URL('../src/pwa/public/app-profile.js', import.meta.url), 'utf8')
ok('pwa profile: zero #wallet balance cards remain', !PROF.includes('#wallet'))
const I18N = readFileSync(new URL('../src/pwa/public/i18n.js', import.meta.url), 'utf8')
ok('i18n: sunset strings have _EN parity', I18N.includes("'WAZ 已退役':") && I18N.includes("'WAZ 模拟货币已退役,历史余额已按冲正清零;真实交易请使用直付(Direct Pay)。':"))

// ── ④ MCP 面 ──
const MCP = readFileSync(new URL('../src/layer1-agent/L1-1-mcp-server/server.ts', import.meta.url), 'utf8')
const iView = MCP.indexOf("// ─── action === 'view'")
const iMcpGate = MCP.indexOf("payment_rail_waz_escrow_enabled'", iView)
const iWalletSelect = MCP.indexOf('SELECT * FROM wallets WHERE user_id', iView)
ok('mcp local view: sunset gate before the wallet read, fail-closed', iView > 0 && iMcpGate > iView && iWalletSelect > iMcpGate)
ok("mcp network view: forwards /api/wallet (inherits the sunset DTO)", /if \(action === 'view'\)\s+return await apiCall\('\/api\/wallet'/.test(MCP))

// ── ⑤ 契约登记 ──
const VER = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
const FP = readFileSync(new URL('../src/pwa/contract-fingerprint.ts', import.meta.url), 'utf8')
const LOCK = JSON.parse(readFileSync(new URL('../docs/CONTRACT-LOCK.json', import.meta.url), 'utf8')) as { contract_version: number }
ok('contract: v30 bumped + CHANGES entry + LOCK in sync', /CONTRACT_VERSION = 30/.test(VER) && /contract_version: 30/.test(FP) && LOCK.contract_version === 30)

srv.close()
if (fail > 0) { console.error(`\n❌ waz-sunset-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ waz-sunset-ui: wallet info surface retired — API sunset DTO + withdraw/connect refused (existing-request paths ungated) + PWA entries removed + MCP both modes aligned + contract v30 registered\n  ✅ pass ${pass}`)
