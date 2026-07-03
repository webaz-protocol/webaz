#!/usr/bin/env tsx
/**
 * Direct Pay 收款目标披露门 —— reader 守卫(修类别不修实例)。
 *
 * 不变量:direct_p2p 收款目标 —— direct_pay_instruction_snapshot(原文)+ direct_pay_account_snapshot.qr_ref
 *   —— 只有【订单买家】在 D1/D2 both-acked 后可见;非买家第三方一律不可见。这个门原本只活在 orders-read.ts,
 *   任何【另一个】对 orders 取整行(SELECT o.* / SELECT * FROM orders)并回给响应的 route 都会旁路它
 *   (审计实锤:/api/me/export 与 /api/logistics/orders 曾如此泄露)。
 *
 * 规则(#218 审计发现 6 升级):route 层任何文件若含 `SELECT o.*` 或 `SELECT * FROM orders`,必须调用
 *   【按查看者投影器】projectDirectPayTargetForViewer(买家=ack 门/卖家=收款方保留/第三方=剥离,一次分派)。
 *   只认"引用了模块"或只调单个原语都不够 —— 曾经 orders-read 引用了模块、只调 redactUnacked(非买家 no-op),
 *   guard 绿灯下第三方(logistics/仲裁员)照样拿到收款目标。原语仍导出但仅作投影器构件,route 层直用会被本守卫拒。
 *   例外必须在 ALLOWLIST(且经人工确认:只把 order 读入局部变量做逻辑,绝不 res.json 整行)。
 *
 * Usage: npm run guard:direct-pay-order-reader
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const ROUTES = join('src', 'pwa', 'routes')
// 内部读(order 取入局部变量做校验/状态机,绝不回给响应)—— 审计已确认不泄露。新增条目前务必人工核对不 echo 整行。
const ALLOWLIST: Record<string, string> = {
  'claim-verify.ts': 'reads one order for claim validation; never echoes the row',
  'orders-action.ts': 'reads one order for the action state-machine; never echoes the row',
  'disputes-write.ts': 'reads one order for dispute-write validation; never echoes the row',
}
const RISKY = [/SELECT\s+o\.\*/i, /SELECT\s+\*\s+FROM\s+orders\b/i]
const GATE = /projectDirectPayTargetForViewer\(/          // 必须【调用】按查看者投影器(不是仅引用模块)
const RAW_PRIMITIVES = /redactUnackedDirectPayTarget\(|stripDirectPayPaymentTarget\(/  // route 层禁直用原语(组合顺序错=泄露,见 #218)

const fails: string[] = []
for (const f of readdirSync(ROUTES).filter(n => n.endsWith('.ts'))) {
  const src = readFileSync(join(ROUTES, f), 'utf8')
  if (RAW_PRIMITIVES.test(src)) fails.push(`  ✗ ${f}: route 层直用 redact/strip 原语 —— 改用 projectDirectPayTargetForViewer(按查看者一次分派,防组合错序泄露)`)
  if (!RISKY.some(re => re.test(src))) continue
  if (GATE.test(src)) continue          // 调用了按查看者投影器 → ok
  if (f in ALLOWLIST) continue          // 已审计的内部读 → ok
  fails.push(`  ✗ ${f}: 取 orders 整行(SELECT o.* / SELECT * FROM orders)但未调 projectDirectPayTargetForViewer,也不在 ALLOWLIST`)
}
if (fails.length) {
  console.error(`❌ direct-pay order-reader guard 失败:\n${fails.join('\n')}\n\n修法:import { projectDirectPayTargetForViewer } from '../direct-pay-order-redaction.js' 并对每个返回的 order 行调用(买家=ack 门/卖家=收款方保留/第三方=剥离,一次分派);若确为内部读(不 res.json 整行)则加进本守卫 ALLOWLIST 并注明理由。`)
  process.exit(1)
}
console.log('✅ direct-pay order-reader guard: 所有 orders 整行 reader 都调按查看者投影器(projectDirectPayTargetForViewer)或为已审计内部读;route 层无原语直用')
