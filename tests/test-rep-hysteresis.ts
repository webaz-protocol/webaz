import { getLevelWithHysteresis } from '../src/layer4-economics/L4-3-reputation/reputation-engine.js'

const cases: Array<[string, number, string, string]> = [
  ['新手升可信',             201, 'new',     'trusted'],
  ['可信掉到 199 — 缓冲内',   199, 'trusted', 'trusted'],
  ['可信掉到 150 — 临界',     150, 'trusted', 'trusted'],
  ['可信掉到 149 — 落新手',   149, 'trusted', 'new'],
  ['明星掉 1850 — 临界',      1850,'star',    'star'],
  ['明星掉 1849 — 落优质',    1849,'star',    'quality'],
  ['传奇掉 4750 — 临界',      4750,'legend',  'legend'],
  ['传奇掉 4749 — 落明星',    4749,'legend',  'star'],
  ['优质 → 升明星 2000',      2000,'quality', 'star'],
  ['新手 0 分',               0,   'new',     'new'],
  ['传奇暴跌到 0 — 直降新手', 0,   'legend',  'new'],
]
let pass = 0, fail = 0
for (const [name, pts, cur, exp] of cases) {
  const got = getLevelWithHysteresis(pts, cur as never).key
  if (got === exp) { pass++; console.log('✓', name) } else { fail++; console.log('✗', name, '— got', got, 'expected', exp) }
}
console.log(`${pass} passed / ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
