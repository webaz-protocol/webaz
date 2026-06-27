#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) deposit-rail 边界测试 — 生产闸 + manual 非生产。Usage: npm run test:deposit-rails
 * 核心:assertProductionDepositRail 对【所有现有轨】(manual / usdc_onchain / fiat_psp)都抛 ——
 *   在真实 legal-cleared 生产收款实现落地前,没有任何轨能被当成 base bond 到位(防 manual 冒充)。
 */
import { getDepositRail, assertProductionDepositRail } from '../src/deposit-rails.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const throws = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }

// 生产闸:manual / usdc_onchain / fiat_psp 全部过不了(无 legal-cleared 生产实现)
for (const id of ['manual', 'usdc_onchain', 'fiat_psp'] as const) {
  ok(`assertProductionDepositRail('${id}') THROWS (no legal-cleared prod impl yet)`, throws(() => assertProductionDepositRail(getDepositRail(id))))
}
ok('no rail is legalCleared yet', (['manual', 'usdc_onchain', 'fiat_psp'] as const).every(id => getDepositRail(id).legalCleared === false))

// manual = 非生产(受控/测试用);confirm 返回 confirmed 但绝不可当生产到位
ok('manual isProduction=false', getDepositRail('manual').isProduction === false)
ok('manual confirmReceipt returns confirmed (test/admin only)', getDepositRail('manual').confirmReceipt({ depositId: 'd', expectedAmount: 1, currency: 'usdc' }).confirmed === true)

// usdc_onchain / fiat_psp = GATED:confirmReceipt 抛(防真钱误接)
ok('usdc_onchain confirmReceipt THROWS (GATED)', throws(() => getDepositRail('usdc_onchain').confirmReceipt({ depositId: 'd', expectedAmount: 1, currency: 'usdc' })))
ok('fiat_psp confirmReceipt THROWS (GATED)', throws(() => getDepositRail('fiat_psp').confirmReceipt({ depositId: 'd', expectedAmount: 1, currency: 'fiat' })))

if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} deposit-rails tests passed`)
