#!/usr/bin/env tsx
/**
 * PR-E 前端仲裁入口跟随后端能力字段:入口/按钮基于 can_arbitrate(active whitelist),不再基于 user.role。
 *   后端权限才是安全边界;此测试只守"前端 UX 跟随、不再用 role 作入口门"。
 * Usage: npm run test:arbitration-entry-frontend
 */
import { readFileSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const ENTRY = readFileSync('src/pwa/public/app-arbitrator-entry.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')
const SERVER = readFileSync('src/pwa/server.ts', 'utf8')
const PROFILE = readFileSync('src/pwa/public/app-profile.js', 'utf8')

// 前端入口/按钮跟随 can_arbitrate
ok('1. isArbitrator (ruling / request-evidence UI gate) follows state.canArbitrate, not user.role', /const isArbitrator = !!state\.canArbitrate/.test(APP) && !/const isArbitrator = user && user\.role === 'arbitrator'/.test(APP))
ok('2. #seller dispute-list entry gated on state.canArbitrate (not role===arbitrator)', /if \(state\.canArbitrate\) return renderDisputeList/.test(APP) && !/role === 'arbitrator'\) return renderDisputeList/.test(APP))
ok('2b. renderDisputeList INTERNAL guard also follows canArbitrate (not user.role)', /function renderDisputeList[\s\S]{0,120}if \(!state\.canArbitrate\)/.test(APP) && !/function renderDisputeList[\s\S]{0,120}state\.user\.role !== 'arbitrator'/.test(APP))
ok('3. bootAuth hydrates arbitration capability (arbEntryHydrate)', /arbEntryHydrate\(\)/.test(APP))

// 能力字段来源:后端 /arbitrator/status
ok('4. entry file fetches /arbitrator/status → sets state.canArbitrate + arbitratorStatus', /arbEntryHydrate = async/.test(ENTRY) && /\/arbitrator\/status/.test(ENTRY) && /can_arbitrate/.test(ENTRY) && /arbitrator_status/.test(ENTRY) && /state\.canArbitrate =/.test(ENTRY))
ok('5. backend getArbitratorState exposes can_arbitrate + arbitrator_status', /can_arbitrate: isEligibleArbitrator\(userId\)\.ok/.test(SERVER) && /arbitrator_status/.test(SERVER))

// 注册
ok('6. entry file registered (index.html + pwa-syntax + ratchet)', HTML.includes('/app-arbitrator-entry.js') && /node --check src\/pwa\/public\/app-arbitrator-entry\.js/.test(PKG) && /'src\/pwa\/public\/app-arbitrator-entry\.js'\s*:/.test(RATCHET))

// 入口卡必须在【买家 + 卖家】两个 #me home 都渲染 —— 白名单仲裁员多为 buyer 角色,曾只在 seller home 出卡 → buyer 仲裁员看不到入口(线上 bug)
ok('7. arbTaishCard rendered in BOTH buyer + seller #me homes (≥2 call sites)', (PROFILE.match(/window\.arbTaishCard\(\)/g) || []).length >= 2)
ok('8. renderBuyerMyHome specifically renders the arbTaishCard entry', /renderBuyerMyHome[\s\S]*?state\.canArbitrate && window\.arbTaishCard/.test(PROFILE))
ok('9. renderMyHome dispatcher re-checks /arbitrator/status → grant propagates without full re-login', /renderMyHome[\s\S]{0,600}\/arbitrator\/status[\s\S]{0,200}state\.canArbitrate =/.test(PROFILE))

if (fail > 0) { console.error(`\n❌ arbitration-entry-frontend FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ arbitration-entry-frontend: entry/button follow backend can_arbitrate (active whitelist), not user.role\n  ✅ pass ${pass}`)
