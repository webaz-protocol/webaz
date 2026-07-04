#!/usr/bin/env tsx
/**
 * Agent 封禁:真人豁免 + 申诉/审批 UI(Tina 案修复)—— 静态接线锚 + i18n parity。
 * Usage: npm run test:agent-strike-ui
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const SRV = readFileSync('src/pwa/server.ts', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const UI = readFileSync('src/pwa/public/app-agent-appeal.js', 'utf8')
const GOV = readFileSync('src/pwa/routes/agent-governance.ts', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')

// ── A. 真人豁免 rate-strike(根因)──
ok('1. Passkey-bound humans exempt from the agent rate bucket (before repRow/cap logic)',
  /if \(riskInfo\.hasPasskey \|\| req\.path === '\/api\/signaling\/poll' \|\| req\.path === '\/api\/snf\/pending'\) return next\(\)/.test(SRV))
ok('2. exemption sits BEFORE the rate bucket (strike can no longer fire for humans)',
  SRV.indexOf("riskInfo.hasPasskey || req.path === '/api/signaling/poll'") < SRV.indexOf('agentRateBuckets.get(apiKey)'))
ok('3. blocked-user escape hatch unchanged (GET /api/me/agents + appeal POST bypass the block)',
  /\/api\\\/me\\\/agents\(\\\/\|\$\)\//.test(SRV) && /strikes\\\/\\d\+\\\/appeal\$/.test(SRV))

// ── B. 被封申诉页 ──
ok('4. doLogin forks AGENT_BLOCKED → appeal page (key retained, not cleared)',
  /user\.error_code === 'AGENT_BLOCKED' && window\.renderAgentBlockedAppeal/.test(APP))
ok('5. blocked page only calls exempt endpoints', /GET\('\/me\/agents'\)/.test(UI) && /\/me\/agents\/strikes\/\$\{strikeId\}\/appeal/.test(UI)
  && !/GET\('\/me'\)/.test(UI))
ok('6. exempt GET now returns strike id + detail (appeal form needs them)', /SELECT id, severity, reason_code, reason_detail/.test(GOV))
ok('7. appeal ≥10 chars enforced client-side too', /reason\.length < 10/.test(UI))

// ── C. admin 审批页 ──
ok('8. admin route + hub card wired', /params\[0\] === 'agent-strikes'\) return renderAdminAgentStrikes\(app\)/.test(APP)
  && /#admin\/agent-strikes/.test(APP))
ok('9. admin page: pending queue + decide + manual issue', /\/admin\/agent-strikes\/pending/.test(UI)
  && /adminStrikeDecide\(/.test(UI) && /\/admin\/agent-strikes\/issue/.test(UI))
ok('10. script loaded before app.js', HTML.indexOf('app-agent-appeal.js') < HTML.indexOf('"/app.js"') && HTML.indexOf('app-agent-appeal.js') > 0)

// ── A2. 风险闸真人豁免(Tina 案二连)──
ok('12. write risk-throttle exempts Passkey humans', /if \(agentRisk >= 70 && !riskInfo\.hasPasskey\)/.test(SRV))
ok('13. risk-suspend (>=100) exempts Passkey humans too', /if \(agentRisk >= 100 && !riskInfo\.hasPasskey\)/.test(SRV))
ok('14. read risk-throttle exemption unchanged', /riskInfo\.risk >= 70 && !riskInfo\.hasPasskey/.test(SRV))

// ── i18n parity ──
const keys = new Set<string>()
for (const m of UI.matchAll(/(?<![\w$])t\('([^']+)'\)/g)) keys.add(m[1])
const noEn = [...keys].filter(k => !I18N.includes(`'${k}':`))
ok('11. i18n parity', keys.size >= 25 && noEn.length === 0, noEn.slice(0, 3).join(' | '))

if (fail > 0) { console.error(`\n❌ agent-strike-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent strike human-exemption + appeal/admin UI: exemption placement + blocked-page exempt-endpoints-only + admin queue/decide/issue + i18n\n  ✅ pass ${pass}`)
