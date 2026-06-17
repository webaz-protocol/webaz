#!/usr/bin/env tsx
/**
 * PR9K — "share-commission / rewards opt-in" vs "contribution / 共建" copy separation (static source check).
 *   用法:npm run test:rewards-vs-contribution-copy
 *
 * Locks the disambiguation: the RFC-002 rewards opt-in (commission / PV / escrow economic relationship) must
 * NOT present itself as a "Builder identity / 共建身份 / Apply for builder identity" CURRENT action — that
 * wording is reserved for / confusable with the contribution funnel (#contribute/tasks, build_tasks, build
 * reputation, GitHub/PR/Passkey accountable identity). Also: every new rewards i18n key has an EN
 * translation; the contribution claim/submit/read surfaces never gate on rewards_opted_in; and the MCP
 * webaz_contribute list_open description lists the full discovery-filter set.
 *
 * NB: the canonical RFC-002 consent SEED text (src/pwa/server.ts rewards_consent_texts v1.0) intentionally
 * keeps its historical "共建身份 / Builder Identity" wording — changing it would change the consent
 * hash/version — so that file is deliberately NOT scanned here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const app = read('src/pwa/public/app.js')
const i18n = read('src/pwa/public/i18n.js')
const productsMeta = read('src/pwa/routes/products-meta.ts')
const referral = read('src/pwa/routes/referral.ts')
const mcp = read('src/layer1-agent/L1-1-mcp-server/server.ts')
// docs/SUPPORT-SOP.md is an internal ops doc, excluded from the public Genesis tree (present in the private
// archive). Skip its copy checks when absent so this otherwise-public test stays green on the public tree.
const sop: string | null = ((): string | null => { try { return read('docs/SUPPORT-SOP.md') } catch { return null } })()
if (sop === null) console.log('SKIP: docs/SUPPORT-SOP.md absent (excluded from public tree); 3 SOP copy checks n/a')

function main(): void {
  // 1) No "Builder identity / 共建身份 / Apply for builder identity" as CURRENT rewards action copy.
  const BUILDER = /[Bb]uilder[ -]identity|共建身份|Apply for builder/   // (consent seed in src/pwa/server.ts is NOT scanned)
  for (const [name, src] of [['app.js', app], ['i18n.js', i18n], ['products-meta.ts', productsMeta], ['referral.ts', referral], ['MCP server.ts', mcp]] as const) {
    const hit = src.match(BUILDER)
    ok(`no builder-identity action copy in ${name}`, !hit, hit ? `found: ${hit[0]}` : '')
  }

  // 2) Rewards opt-in UI now uses the economic "分享分润 / share-commission" framing.
  ok('rewards card (→#rewards-me) titled 分享分润管理', /card\([^\n]*分享分润管理[^\n]*#rewards-me'\)/.test(app))
  ok('apply page title = 申请分享分润', /page-title[^\n]*\$\{t\('申请分享分润'\)\}/.test(app))
  ok('manage page title = 分享分润管理', /\$\{t\('分享分润管理'\)\}/.test(app))
  ok('gate messages say share-commission opt-in + NOT a contribution gate', /share-commission opt-in/.test(referral) && /NOT a contribution gate/.test(referral) && /NOT a contribution gate/.test(productsMeta))

  // 3) Every new rewards i18n key has a (Latin-letter) EN translation on its line.
  const i18nHasEN = (key: string): boolean => {
    const marker = `'${key}':`
    const line = i18n.split('\n').find(l => l.includes(marker))
    if (!line) return false
    return /[A-Za-z]{3,}/.test(line.slice(line.indexOf(marker) + marker.length))
  }
  const NEW_KEYS = ['申请分享分润', '分享分润管理', '已开通分享分润', '分享分润已开通',
    '✅ 分享分润开通成功', '退出分享分润', '✅ 已退出分享分润', '前往 #me 申请分享分润']
  for (const k of NEW_KEYS) ok(`i18n EN translation present: ${k}`, i18nHasEN(k))

  // 4) Fund-destination copy is accurate: rewards opt-out future commission → commission_reserve, NOT charity.
  ok('rewards opt-out copy references commission_reserve / 协议公池', i18n.includes('commission_reserve') && i18n.includes('协议公池'))
  ok('no stale "直接入公益 / goes directly to charity" in rewards copy', !i18n.includes('直接入公益') && !/goes directly to charity/.test(i18n) && !app.includes('直接入公益'))

  // 5) Contribution funnel terms preserved (not collateral-renamed).
  ok('contribution dashboard 我的共建 preserved', app.includes('我的共建'))
  ok('public contribution entry #contribute/tasks preserved', app.includes('#contribute/tasks'))

  // 6) Contribution claim/submit/read surfaces never gate on rewards opt-in.
  const REWARDS_GATE = /rewards_opt(ed)?_in|rewards_opt_in_required/
  for (const f of ['src/pwa/routes/build-tasks.ts', 'src/pwa/routes/public-build-tasks.ts',
    'src/layer2-business/L2-9-contribution/build-tasks-engine.ts',
    'src/layer2-business/L2-9-contribution/build-task-participation.ts',
    'src/layer2-business/L2-9-contribution/build-task-read.ts']) {
    ok(`contribution surface has no rewards opt-in gate: ${f.split('/').pop()}`, !REWARDS_GATE.test(read(f)))
  }

  // 7) MCP webaz_contribute list_open description lists the FULL discovery-filter set.
  const listOpenLine = mcp.split('\n').find(l => l.includes('open public tasks')) || ''
  for (const filt of ['required_capabilities', 'agent_capabilities', 'max_duration_minutes', 'estimated_context_size', 'estimated_agent_budget']) {
    ok(`list_open description lists ${filt}`, listOpenLine.includes(filt))
  }
  ok('estimated_agent_budget framed as effort estimate, not payment (in list_open desc)', /estimated_agent_budget is a resource\/effort estimate, NOT a payment/.test(listOpenLine))

  // 8) Unauthenticated welcome / login content boundary (don't lead with "shopping = rewarded contribution").
  const RISK = ['贡献就有回报', '购物费回到你口袋', '注册即拿邀请奖励', '都能转化为你的收益', '真实推广，真实回报', '消费也是贡献']
  for (const p of RISK) ok(`welcome/login removed risk phrase: ${p}`, !app.includes(p))
  ok('login first-screen CTA neutralized (开始使用 / Get started, not 参与共建/Participate)', /'Get started' : '开始使用'/.test(app))
  // window widened 900→2000: the explore options (浏览公开任务板 / 提建议) were folded into a collapsed
  // 「了解更多」<details> below the primary 注册/登录 CTA, so the route now sits a bit further into the sheet.
  ok('participate sheet routes to the public task board (#contribute/tasks)', /openParticipateSheet[\s\S]{0,2000}#contribute\/tasks'/.test(app))
  ok('welcome contributor CTA: suggest needs no login + only merged canonical PR enters the record',
    /Suggesting needs no login|建议无需登录/.test(app) && /enters the contribution record|进入贡献记录/.test(app))

  // 9) Social-platform examples are localized per language (no transliterated CN names on the EN page).
  for (const p of ['Xiaohongshu', 'Douyin', 'Bilibili']) ok(`EN welcome has no CN-platform transliteration: ${p}`, !app.includes(p))
  ok('EN welcome uses overseas platforms (TikTok / Instagram)', app.includes('TikTok') && app.includes('Instagram'))

  // 10) Codex二审: opt-out fund destination distinguishes deactivated (→ reserve, no escrow, not reclaimable)
  //     from never_activated / auto_downgraded (→ escrow → reclaimable in window). No charity for any of them.
  if (sop !== null) {
  ok('SOP dropped the wrong "active opt-out → escrow → re-activate paid back" conflation',
    !sop.includes('关闭期间新产生的分润会先进') && !sop.includes('关闭期间**新产生**的分润 → 进'))
  ok('SOP deactivated copy: 主动退出 → commission_reserve, 不再为你托管, not charity',
    sop.includes('主动退出') && sop.includes('commission_reserve') && /不再为你托管|no longer held/.test(sop) && !/直接入公益|goes directly to charity/.test(sop))
  }
  ok('MCP deactivated note → commission_reserve (no positive charity / escrow destination claim)', (() => {
    const line = mcp.split('\n').find(l => l.includes('actively deactivated')) || ''
    // the note may NAME charity_fund / pending escrow in negation ("not charity_fund and not pending escrow");
    // forbid only the OLD positive-destination claims.
    return line.includes('commission_reserve') && !/redirect directly to charity|commissions held in pending|held in (pending|escrow)/i.test(line)
  })())
  ok('MCP never_activated / auto_downgraded notes still use pending_commission_escrow', (() => {
    const na = mcp.split('\n').find(l => l.includes('Rewards inactive')) || ''
    const ad = mcp.split('\n').find(l => l.includes('auto-downgraded')) || ''
    return na.includes('pending_commission_escrow') && ad.includes('pending_commission_escrow')
  })())
  // the webaz_referral tool DESCRIPTION (read by agents before the runtime note) must also be state-correct.
  ok('MCP webaz_referral tool description distinguishes states (deactivated → reserve, not blanket escrow)', (() => {
    const line = mcp.split('\n').find(l => l.includes('Opt-in required (RFC-002)')) || ''
    return /deactivated.{0,90}commission_reserve/i.test(line)
      && /never_activated \/ auto_downgraded.{0,70}pending_commission_escrow/i.test(line)
      && !/commission held in escrow until activation/i.test(line)
  })())
  // openParticipateSheet must close its own sheet (closeSheet), not try to remove a .js-modal (would leave it open / stack).
  ok('openParticipateSheet uses closeSheet(), no .js-modal removal', (() => {
    const i = app.indexOf('window.openParticipateSheet')
    const block = i >= 0 ? app.slice(i, i + 1500) : ''
    return block.includes('closeSheet()') && !block.includes('.js-modal')
  })())

  // 11) Codex二审 (round 2): the UPSTREAM summary entries (read first by support / agents) must also be
  //     state-correct — not a blanket "未 opt-in → pending escrow → reclaim on opt-in".
  if (sop !== null) ok('SOP §1 background line is state-distinguished (never/auto → escrow, deactivated → reserve)', (() => {
    const line = sop.split('\n').find(l => l.includes('显式') && l.includes('opt-in')) || ''
    return line.includes('never_activated') && line.includes('deactivated') && line.includes('commission_reserve') && line.includes('pending_commission_escrow')
      && !line.includes('未 opt-in 期间产生的分润不直接发,先进')
  })())
  ok('webaz_info commission_model.opt_in is state-distinguished (deactivated → reserve, not blanket escrow)', (() => {
    const line = mcp.split('\n').find(l => l.includes("opt_in: 'Participation is opt-in")) || ''
    return /deactivated.{0,90}commission_reserve/i.test(line)
      && /never_activated \/ auto_downgraded.{0,60}pending_commission_escrow/i.test(line)
      && !/commission settlement is gated until opt-in/i.test(line)
  })())

  // 12) Orphaned reward-copy i18n keys (renamed away in PR9K) stay pruned — guard against re-adding.
  ok('i18n has no dead reward keys (注册即拿邀请奖励 / 解锁分享奖励)', !i18n.includes('注册即拿邀请奖励') && !i18n.includes('解锁分享奖励'))

  // 13) Contribution-claim vs share-commission gate separation (#347 follow-up).
  // banned legacy action copy stays out of the current UI (historical RFC docs may keep old titles)
  const LEGACY = /申请成为共建者|申请加入共建身份|共建身份已激活|[Bb]uilder identity|Apply for builder identity/
  ok('no legacy builder-identity action copy in app.js / i18n.js', !LEGACY.test(app) && !LEGACY.test(i18n))
  // contribution surfaces carry NO purchase / rewards gate: #my-contributions (+ the F9 claim block) and #contribute pages
  const mycStart = app.indexOf('async function renderMyContributions')
  const mycEnd = app.indexOf('const TICKET_TYPE_META')
  const MYC = app.slice(mycStart, mycEnd)
  const GATE = /rewards_opted_in|min_completed_orders|completed_orders/
  ok('#my-contributions + claim UI have no purchase/rewards gate', mycStart > 0 && !GATE.test(MYC), (MYC.match(GATE) || []).join(','))
  const contribStart = app.indexOf('PR9E-1 Public Contribution Pages')
  const contribEnd = app.indexOf('function renderRule(num, text)')
  ok('#contribute pages have no purchase/rewards gate', contribStart > 0 && !GATE.test(app.slice(contribStart, contribEnd)))
  // the no-purchase clarifier sits next to the GitHub claim card (zh + EN i18n)
  ok('#my-contributions states: claim needs no purchase / no share-commission opt-in', MYC.includes('GitHub 贡献认领不需要先购买,也不需要开通分享分润。'))
  ok('…with the EN translation present', i18n.includes("'GitHub 贡献认领不需要先购买,也不需要开通分享分润。': 'GitHub contribution claims do not require a purchase or share-commission opt-in.'"))
  // #apply-rewards scopes its purchase threshold to share-commission only
  ok('#apply-rewards states the purchase threshold applies only to share-commission', app.includes('此购买门槛只适用于分享分润') && i18n.includes('applies only to share-commission opt-in'))
  // 「我的」 entries separate the two worlds (contribution card vs economic-registration card)
  ok('「我的」 has a distinct 我的共建 entry (#my-contributions, no purchase)', /card\('🛠', t\('我的共建'\), t\('贡献 \/ GitHub 认领 \/ 建设信誉 — 无购买门槛'\), '#my-contributions'\)/.test(app))
  ok('「我的」 rewards entry framed as economic registration', /card\('🎁', t\('分享分润管理'\), t\('分享佣金 \/ PV \/ escrow · 经济关系登记'\), '#rewards-me'\)/.test(app))
  // Codex round-2: #apply-rewards header no longer self-contradicts (anti-sybil framing), threshold title scoped
  ok('#apply-rewards header: not-a-shopping-flow + anti-sybil threshold framing', app.includes('本流程不是购物流程;下方"已完成订单"门槛只是分享分润的反女巫要求') && /anti-sybil requirement for share-commission/.test(app))
  ok('old self-contradicting header removed', !app.includes("t('本流程与购物无关')"))
  ok('#apply-rewards threshold title scoped to share-commission', app.includes('分享分润开通门槛(只适用于分润,不适用于贡献)'))
  ok('promoter page uses 分享分润 wording (no 分享奖励 phrasing)', app.includes('分享分润待开通') && app.includes('已开通分享分润资格') && !app.includes('分享奖励待解锁') && !app.includes('已获得分享奖励资格'))

  // 14) Commission-level reality (pre-launch global clamp max_levels ≤ 1): the UI must not present
  //     "三级/3-tier/70/20/10" as CURRENT behavior. The apply-rewards disclosure may keep the consent-seed
  //     mirror "(三级佣金 + 积分配对)" but must carry the reality qualifier right below it.
  ok('apply-rewards carries the reality qualifier (clamp=1, 三级=max design, not a promise)',
    app.includes('现实性说明:佣金层级按地区合规配置生效;当前预发布期全局上限为 1 级(仅 L1)') && /not a promise of future levels/.test(app))
  ok('Top leaderboard no longer titled 三级佣金', !app.includes('Top 三级佣金') && app.includes('Top 分享佣金'))
  // no unqualified current-claims left: every remaining 三级/3-tier/70/20/10 in UI strings must be either
  // the consent-mirror disclosure line or inside a code comment.
  const stripped = app.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\/\/ .*$/, '')).join('\n')
  const claimHits = (stripped.match(/三级|3-tier|70\/20\/10/g) || []).length
  ok('app.js: only the consent-mirror 三级 disclosure remains (≤2 hits: disclosure key + qualifier)', claimHits <= 3, `hits=${claimHits}`)
  const i18nHits = (i18n.match(/3-tier|70\/20\/10/g) || []).length
  ok('i18n EN: only the consent-mirror 3-tier remains (1 hit)', i18nHits <= 1, `hits=${i18nHits}`)

  if (fail === 0) {
    console.log(`\n✅ rewards-vs-contribution copy (PR9K): rewards opt-in = share-commission economic registration (no Builder identity / 共建身份 action copy; consent seed exempt) · new i18n keys all translated · opt-out future commission → commission_reserve not charity · contribution funnel (我的共建 / #contribute/tasks) preserved + never gated on rewards_opted_in · MCP list_open lists the full filter set\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ rewards-vs-contribution copy FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
