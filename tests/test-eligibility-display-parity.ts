// Codex #64 P2 — 公开 governance onboarding eligibility 展示门槛【绝不能少于】代码实际 enforce 的门槛。
//   病根:checkVerifierEligibility 实际要求 balance≥200 + reputation≥110,
//   但 public-utils 的 eligibility.verifier 漏了这两条 → 公开页对申请者隐藏了真实门槛(#4 误导)。
//
// P2-E 升级(2026-07-23,Codex #508 R2):资格谓词从 server.ts 闭包抽到 src/pwa/eligibility.ts 后,
//   旧的"解析 server.ts 源码"实现静默失效(0 匹配也过 = 守卫被架空)。现在改为【运行时真值】:
//   直接调用真实 checkVerifierEligibility/checkArbitratorEligibility 拿 items[](required/键集),
//   与 public-utils 展示对象比对 —— 不再解析源码,重构永不再架空本守卫;若函数被移走/改签名,直接 throw 红。
import { mkdtempSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'elig-parity-'))

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { initReputationSchema } = await import('../src/layer4-economics/L4-3-reputation/reputation-engine.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { checkVerifierEligibility, checkArbitratorEligibility } = await import('../src/pwa/eligibility.js')

const __dir = dirname(fileURLToPath(import.meta.url))
const pub = readFileSync(join(__dir, '..', 'src', 'pwa', 'routes', 'public-utils.ts'), 'utf-8')

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown): void => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ── enforced 侧:真实函数跑最小 fixture,读 items[](单一真相,零源码解析)──
const db = initDatabase(); db.pragma('foreign_keys = OFF')
initReputationSchema(db); initDisputeSchema(db)
db.exec(`CREATE TABLE IF NOT EXISTS user_moderation (user_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS return_requests (id TEXT PRIMARY KEY, order_id TEXT, status TEXT, refund_amount REAL)`)
try { db.exec('ALTER TABLE orders ADD COLUMN payment_rail TEXT') } catch { /* 已有 */ }
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0') } catch { /* 已有 */ }
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('u1','U','buyer','k1')").run()
db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('u1', 0)").run()

const NUMERIC: Record<string, string> = { age: 'registration_days', orders: 'completed_orders', balance: 'balance_waz', reputation: 'reputation' }
const FLAGS: Record<string, string> = { email: 'email_verified', no_violations: 'zero_disputes_lost', never_suspended: 'never_suspended' }

type EligFn = (db2: unknown, uid: string) => { items: Array<{ key: string; required: number | string }> }
function enforcedGates(fn: EligFn, name: string): { numeric: Record<string, number>; flagKeys: string[] } {
  const r = fn(db as unknown, 'u1')
  if (!r.items.length) throw new Error(`${name} 返回空 items —— 守卫失效,检查函数是否被移动/改签名`)
  const numeric: Record<string, number> = {}
  const flagKeys: string[] = []
  for (const it of r.items) {
    if (it.key in NUMERIC && typeof it.required === 'number') numeric[it.key] = it.required
    else if (it.key in FLAGS) flagKeys.push(it.key)
  }
  return { numeric, flagKeys }
}

// ── displayed 侧:public-utils 的字面量对象(保持静态解析,它就是字面量)──
function displayedObj(role: 'verifier' | 'arbitrator'): Record<string, number | boolean> {
  const m = pub.match(new RegExp(`${role}:\\s*\\{([^}]*)\\}`))
  if (!m) throw new Error(`${role} eligibility object not found in public-utils.ts`)
  const obj: Record<string, number | boolean> = {}
  for (const part of m[1].split(',')) {
    const kv = part.split(':').map(s => s.trim())
    if (kv.length < 2) continue
    obj[kv[0]] = kv[1] === 'true' ? true : kv[1] === 'false' ? false : Number(kv[1])
  }
  return obj
}

for (const [role, fn, name] of [
  ['verifier', checkVerifierEligibility as unknown as EligFn, 'checkVerifierEligibility'],
  ['arbitrator', checkArbitratorEligibility as unknown as EligFn, 'checkArbitratorEligibility'],
] as const) {
  const { numeric, flagKeys } = enforcedGates(fn, name)
  const shown = displayedObj(role)
  expect(`${role}: enforced 数值门齐全(age/orders/balance/reputation)`, ['age', 'orders', 'balance', 'reputation'].every(k => k in numeric), numeric)
  // 每个数值门:展示对象必须有对应键,且展示值 >= enforced(绝不少于)
  for (const [ek, dk] of Object.entries(NUMERIC)) {
    if (!(ek in numeric)) continue
    const enf = numeric[ek]
    const dv = shown[dk]
    expect(`${role}: 展示含 ${dk} 且 >= enforced ${ek}(${enf})`, typeof dv === 'number' && dv >= enf, { displayed: dv, enforced: enf })
  }
  // 布尔门:展示对象必须把对应 flag 标为 true
  for (const ek of flagKeys) {
    const dk = FLAGS[ek]
    expect(`${role}: 展示含布尔门 ${dk}=true`, shown[dk] === true, { key: dk, value: shown[dk] })
  }
}

// 显式钉死 Codex #64 关注的两条(verifier 漏掉的)——展示值必须正好覆盖 enforced。
const ver = displayedObj('verifier')
expect('verifier 展示 reputation=110(对齐 enforced)', ver.reputation === 110, ver)
expect('verifier 展示 balance_waz=200(对齐 enforced)', ver.balance_waz === 200, ver)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
