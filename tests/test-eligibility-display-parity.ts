// Codex #64 P2 — 公开 governance onboarding eligibility 展示门槛【绝不能少于】代码实际 enforce 的门槛。
//   病根:server.ts checkVerifierEligibility 实际要求 balance≥200 + reputation≥110,
//   但 public-utils 的 eligibility.verifier 漏了这两条 → 公开页对申请者隐藏了真实门槛(#4 误导)。
//   本测试静态扫两边源码:把 check*Eligibility 里每个数值 required 映射到 public-utils 展示对象的对应键,
//   断言【展示值 >= enforced 值】且布尔门(email/disputes/suspended)都在 —— 防展示再次"少于/低于"真实门槛。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const server = readFileSync(join(__dir, '..', 'src', 'pwa', 'server.ts'), 'utf-8')
const pub = readFileSync(join(__dir, '..', 'src', 'pwa', 'routes', 'public-utils.ts'), 'utf-8')

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// check*Eligibility 的 item key → public-utils 展示对象的键。数值门做 >= 比较;布尔门做"在场+true"。
const NUMERIC: Record<string, string> = { age: 'registration_days', orders: 'completed_orders', balance: 'balance_waz', reputation: 'reputation' }
const FLAGS: Record<string, string> = { email: 'email_verified', no_violations: 'zero_disputes_lost', never_suspended: 'never_suspended' }

function enforcedGates(fnName: string): { numeric: Record<string, number>; flagKeys: string[] } {
  const start = server.indexOf(`function ${fnName}`)
  if (start < 0) throw new Error(`${fnName} not found in server.ts`)
  const body = server.slice(start, server.indexOf('\nfunction ', start + 1))
  const numeric: Record<string, number> = {}
  const flagKeys: string[] = []
  // 每个 items.push 一行:key: 'X' ... required: N(或 '✓')
  const re = /key:\s*'([^']+)'[^\n]*?required:\s*('✓'|\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const key = m[1], reqRaw = m[2]
    if (key in NUMERIC && reqRaw !== "'✓'") numeric[key] = Number(reqRaw)
    else if (key in FLAGS) flagKeys.push(key)
  }
  return { numeric, flagKeys }
}

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

for (const [role, fn] of [['verifier', 'checkVerifierEligibility'], ['arbitrator', 'checkArbitratorEligibility']] as const) {
  const { numeric, flagKeys } = enforcedGates(fn)
  const shown = displayedObj(role)
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
