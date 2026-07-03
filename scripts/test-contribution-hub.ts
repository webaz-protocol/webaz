#!/usr/bin/env tsx
/**
 * 共建运营 admin hub 接线守卫(纯 UI 归类;只链接既有路由,不改后端/权限)。
 *  - 注册:index.html + pwa-syntax + ratchet。
 *  - app.js:路由 #admin/contribution-ops → renderAdminContributionHub;主面板有单张入口卡。
 *  - hub 归入全部 5 个既有子面(task-proposals / public-ideas / quota-requests / operator-claims 审批 + #me 自助)。
 *  - root-only 子区(建任务额度、操作席位关联审批)在 hub 内 root 门控;hub 页 isAdmin 守卫。
 *  - 主面板不再直接散列这些卡(已收进 hub)。
 * Usage: npm run test:contribution-hub
 */
import { readFileSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const HUB = readFileSync('src/pwa/public/app-contribution-hub.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

ok('1. registered (index + pwa-syntax + ratchet)', HTML.includes('/app-contribution-hub.js') && /node --check src\/pwa\/public\/app-contribution-hub\.js/.test(PKG) && /'src\/pwa\/public\/app-contribution-hub\.js'\s*:/.test(RATCHET))
ok('2. app.js routes #admin/contribution-ops → renderAdminContributionHub', /params\[0\] === 'contribution-ops'\) return renderAdminContributionHub\(app\)/.test(APP))
ok('3. app.js main panel has single hub entry card → #admin/contribution-ops', /adminLinkCard\('🌱', t\('共建运营'\)[\s\S]{0,120}'#admin\/contribution-ops'\)/.test(APP))
ok('4. hub renders + isAdmin guard', /renderAdminContributionHub = function/.test(HUB) && /!isAdmin\(\)/.test(HUB))
const targets = ['#admin/task-proposals', '#admin/public-ideas', '#admin/quota-requests', '#me/operator-claims', '#admin/operator-claims']
ok('5. hub groups all 5 existing surfaces', targets.every(t => HUB.includes(t)), 'missing: ' + targets.filter(t => !HUB.includes(t)).join(', '))
ok('6. root-only sections gated inside hub (quota-requests + operator-claims 审批)', /root \? grp\(t\('建任务治理'\)[\s\S]{0,180}quota-requests/.test(HUB) && /root \? adminLinkCard\('🪪'[\s\S]{0,140}operator-claims/.test(HUB))
// 主面板已把这些卡收进 hub:主面板正文不再直接出现这些子面链接(仅 hub 文件里有)
for (const t of ['#admin/task-proposals', '#admin/public-ideas', '#admin/quota-requests'])
  ok(`7. main panel no longer directly lists ${t} (moved into hub)`, !APP.includes(`'${t}'`))

if (fail > 0) { console.error(`\n❌ contribution-hub FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ contribution-hub: single entry card + route + groups 5 surfaces + root-gating + isAdmin + main-panel decluttered\n  ✅ pass ${pass}`)
