#!/usr/bin/env tsx
/**
 * admin 争议查看/管理(triage)接线守卫:可【区分】(状态过滤 + rail/verdict/指派/紧急度 badge)+ 可【管理】(钻取查看)。
 *  - 前端 app-admin-disputes.js:window.renderAdminDisputes、isAdmin 门、状态 tab、钻取 #dispute/:id。
 *  - 后端 /admin/disputes:SELECT 含 payment_rail/verdict/ruling_type/assigned_arbitrators + ?status 过滤 + counts。
 *  - app.js 不再自带 renderAdminDisputes(已抽出);注册 index+pwa-syntax+ratchet。
 * Usage: npm run test:admin-dispute-triage
 */
import { readFileSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const UI = readFileSync('src/pwa/public/app-admin-disputes.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const BE = readFileSync('src/pwa/routes/admin-reports.ts', 'utf8')
const DR = readFileSync('src/pwa/routes/disputes-read.ts', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')

ok('1. app-admin-disputes.js registered (index + pwa-syntax + ratchet)', HTML.includes('/app-admin-disputes.js') && /node --check src\/pwa\/public\/app-admin-disputes\.js/.test(PKG) && /'src\/pwa\/public\/app-admin-disputes\.js'\s*:/.test(RATCHET))
ok('2. window.renderAdminDisputes defined + isAdmin guard', /window\.renderAdminDisputes = async function/.test(UI) && /!isAdmin\(\)/.test(UI))
ok('3. app.js no longer defines renderAdminDisputes (moved out)', !/async function renderAdminDisputes\(/.test(APP) && /params\[0\] === 'disputes'\)\s+return renderAdminDisputes\(app\)/.test(APP))
ok('4. 区分: status filter tabs (open/in_review/resolved/dismissed) + passes ?status', /\['open',/.test(UI) && /\['in_review',/.test(UI) && /\['resolved',/.test(UI) && /\['dismissed',/.test(UI) && /\/admin\/disputes' \+ \(status \?/.test(UI))
ok('5. 区分: rail / verdict / assign / urgency badges', /railBadge/.test(UI) && /verdictChip/.test(UI) && /assignChip/.test(UI) && /urgencyChip/.test(UI))
ok('6. 管理: drill-through to #dispute/:id', /navigate\('#dispute\/\$\{escHtml\(d\.id\)\}'\)/.test(UI))
ok('7. backend /admin/disputes returns distinguishing fields', /d\.verdict, d\.ruling_type, d\.assigned_arbitrators/.test(BE) && /o\.payment_rail/.test(BE))
ok('8. backend supports ?status + ?rail filter + status counts', /req\.query\.status/.test(BE) && /req\.query\.rail/.test(BE) && /GROUP BY status/.test(BE) && /counts:/.test(BE))
ok('9. dispute detail admin gate == list authz (isArbitrationAdmin predicate, NOT user.role===admin)', /!isEligibleArbitrator\(user\.id as string\)\.ok && !isArbitrationAdmin\(user\)/.test(DR) && !/user\.role !== 'admin'/.test(DR))

if (fail > 0) { console.error(`\n❌ admin-dispute-triage FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ admin-dispute-triage: distinguish (status filter + rail/verdict/assign/urgency) + manage (drill-through) + admin read-only detail access\n  ✅ pass ${pass}`)
