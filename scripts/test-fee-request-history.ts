#!/usr/bin/env tsx
/**
 * Fix B — 平台服务费预充值申请:管理页可查历史(已入账/已驳回),不再只看 pending。
 *  ① afprTabs 提供 pending/approved/rejected/all 四个筛选;afprHydrate 按状态拉数据(all → 无 status 参数)。
 *  ② 非 pending 走只读 afprHistoryCard(显审核人/时间/备注/入账流水);pending 仍走可操作 afprCard。
 *  ③ 后端 listAllRequests 已支持按状态或全部(无新后端改)。④ 新增中文均有 _EN。
 * Usage: npm run test:fee-request-history
 */
import { readFileSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const H = readFileSync('src/pwa/public/app-direct-pay-fee-history.js', 'utf8')
const ADMIN = readFileSync('src/pwa/public/app-direct-pay-fee-requests-admin.js', 'utf8')
const HTML = readFileSync('src/pwa/public/index.html', 'utf8')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const REQSRC = readFileSync('src/direct-pay-fee-prepay-request.ts', 'utf8')

// ① registration + tabs
ok('1a. fee-history file registered (index.html + pwa-syntax + ratchet)', HTML.includes('/app-direct-pay-fee-history.js') && /node --check src\/pwa\/public\/app-direct-pay-fee-history\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-fee-history\.js'\s*:/.test(RATCHET))
for (const s of ['pending', 'approved', 'rejected', 'all']) ok(`1b. afprTabs offers ${s} filter`, new RegExp(`'${s}'`).test(H) && /afprTabs = \(\)/.test(H))

// ② status-driven hydrate + history routing
ok('2a. afprHydrate takes a status and queries by it (all → no status param)', /afprHydrate = async \(status\)/.test(ADMIN) && /st === 'all' \? '' : '\?status=' \+ st/.test(ADMIN))
ok('2b. non-pending rows route to read-only afprHistoryCard; pending keeps afprCard', /x\.status === 'pending' \? window\.afprCard\(x\) : \(window\.afprHistoryCard/.test(ADMIN))
ok('2c. afprHistoryCard shows reviewer + review note + resulting payment', /afprHistoryCard = \(r\)/.test(H) && /reviewed_by/.test(H) && /review_note/.test(H) && /resulting_payment_id/.test(H))
ok('2d. history card has NO approve/reject buttons (read-only)', !/afprApprove|afprReject/.test(H))
ok('2e. active tab highlight remembered for approve/reject re-hydrate', /afprSetActiveTab = \(status\)/.test(H) && /window\.afprStatusFilter = status/.test(H))

// ③ backend already supports status filter + all (no backend change needed)
ok('3a. listAllRequests filters by status or returns all', /listAllRequests\(db: Database\.Database, status\?: string\)/.test(REQSRC) && /WHERE status = \?/.test(REQSRC))

// ④ bilingual parity for new strings
for (const zh of ['申请时间', '审核人', '审核时间', '审核备注', '入账流水']) ok(`4-i18n EN: ${zh}`, new RegExp(`'${zh}'\\s*:`).test(I18N))

if (fail > 0) { console.error(`\n❌ fee-request-history FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fee-request-history: admin status tabs (pending/approved/rejected/all) + read-only history cards + bilingual\n  ✅ pass ${pass}`)
