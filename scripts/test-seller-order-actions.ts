#!/usr/bin/env tsx
/**
 * Seller order-action UI contract (static, over app.js + MCP server.ts) — the PWA entries for the
 * already-implemented backend decline / contest_decline (RFC-007). Backend guards (non-seller / non-paid /
 * no-reason / provisional / contest / conservation) are owned by tests/test-decline-action.ts; this locks
 * the FRONT-END exposure + honest copy + MCP description parity.
 *   用法:npm run test:seller-order-actions
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = readFileSync(join(ROOT, 'src', 'pwa', 'public', 'app.js'), 'utf8')
const i18n = readFileSync(join(ROOT, 'src', 'pwa', 'public', 'i18n.js'), 'utf8')
const mcp = readFileSync(join(ROOT, 'src', 'layer1-agent', 'L1-1-mcp-server', 'server.ts'), 'utf8')

function main(): void {
  // A — seller paid exposes BOTH accept and decline
  const paidActions = app.slice(app.indexOf("if (isSeller && s === 'paid')"), app.indexOf("if (isSeller && s === 'accepted'"))
  ok('seller paid getActions returns accept', /action: 'accept'/.test(paidActions))
  ok('seller paid getActions returns decline (custom modal, not direct POST)', /action: 'decline'[\s\S]*custom: 'decline'/.test(paidActions))
  ok('renderActions routes custom decline → openDeclineModal (no direct handleAction POST)', /a\.custom === 'decline'[\s\S]{0,160}openDeclineModal\('\$\{orderId\}'\)/.test(app))

  // decline modal requires a reason code + posts the correct body
  const dm = app.slice(app.indexOf('window.openDeclineModal'), app.indexOf('function sellerDeclineContestPanel'))
  ok('decline modal: reason-code select present', /id="decline-reason"/.test(dm))
  for (const code of ['stock_consumed_concurrent', 'stale_price_snapshot', 'force_majeure', 'price_regret', 'cherry_pick', 'other']) {
    ok(`decline reason offered: ${code}`, app.includes(`code: '${code}'`))
  }
  ok('submitDecline requires a reason (guards empty)', /if \(!code\) \{[\s\S]{0,80}请选择拒单理由/.test(dm))
  ok('submitDecline posts {action:decline, decline_reason_code, notes}', /POST\(`\/orders\/\$\{orderId\}\/action`, \{ action: 'decline', decline_reason_code: code, notes \}\)/.test(dm))

  // objective vs subjective consequence copy — objective must NOT read as auto-exemption
  ok('objective reason copy = provisional + must contest (NOT auto-exemption)',
    /客观理由:[\s\S]{0,200}临时判责[\s\S]{0,200}举证窗口[\s\S]{0,80}这不是自动免责/.test(app))
  ok('subjective reason copy = immediate seller-fault + buyer refund', /主观理由:[\s\S]{0,80}卖家违约[\s\S]{0,40}买家全额退款/.test(app))

  // B — provisional-fault contest panel
  const cp = app.slice(app.indexOf('function sellerDeclineContestPanel'), app.indexOf('window.submitContestDecline'))
  ok('contest panel gated: seller + fault_seller + decline_objective_pending=1 + not settled',
    /!isSeller \|\| order\.status !== 'fault_seller' \|\| Number\(order\.decline_objective_pending\) !== 1 \|\| order\.settled_fault_at/.test(cp))
  ok('contest panel shows the contest deadline', /decline_contest_deadline/.test(cp) && /举证截止/.test(cp))
  ok('contest panel honest: provisional, not auto-exemption, window-expiry → fault', /这不是自动免责/.test(cp) && /过期未举证将按违约终结/.test(cp))
  ok('already-contested branch shows arbitration-in-progress', /decline_contested\) === 1/.test(cp) && /等待仲裁员裁决/.test(cp))
  ok('submitContestDecline posts {action:contest_decline, evidence_description}', /POST\(`\/orders\/\$\{orderId\}\/action`, \{ action: 'contest_decline', evidence_description: evid \}\)/.test(app))
  ok('contest requires evidence (guards empty)', /if \(!evid\) \{[\s\S]{0,80}请填写举证说明/.test(app))
  ok('panel wired into the order-detail action area', /sellerDeclineContestPanel\(order, orderId, isSeller\)/.test(app))

  // C — seller self-fulfill exposure: backend allows seller pickup/transit/deliver when logistics_id is empty;
  // lock the order-detail UI so the seller can actually drive those transitions without pretending to be logistics.
  const actionsFn = app.slice(app.indexOf('function getActions'), app.indexOf('function renderActions'))
  ok('seller self-fulfill flag = isSeller && !order.logistics_id', /const isSelfFulfillSeller = isSeller && !order\.logistics_id/.test(actionsFn))
  ok('seller self-fulfill exposes pickup from shipped', /\(isLogistic \|\| isSelfFulfillSeller\) && s === 'shipped'[\s\S]{0,160}action: 'pickup'/.test(actionsFn))
  ok('seller self-fulfill exposes transit from picked_up', /\(isLogistic \|\| isSelfFulfillSeller\) && s === 'picked_up'[\s\S]{0,120}action: 'transit'/.test(actionsFn))
  ok('seller self-fulfill exposes deliver from in_transit', /\(isLogistic \|\| isSelfFulfillSeller\) && s === 'in_transit'[\s\S]{0,160}action: 'deliver'/.test(actionsFn))
  ok('seller self-fulfill helper copy states seller responsibility, not logistics-only',
    /自履约订单：你负责回传揽收\/单号，超时仍按卖家责任处理。/.test(app) &&
    /自履约投递需留存签收\/门牌\/交付说明，买家确认后才结算。/.test(app))
  ok('dangerous order writes require confirmation prompts',
    /ship: t\('确认已经发货？/.test(app) &&
    /pickup: t\('确认已揽收并回传凭证？/.test(app) &&
    /deliver: t\('确认已投递？/.test(app) &&
    /if \(confirmText && !confirm\(confirmText\)\) return/.test(app))

  // D — seller dashboard information architecture
  const dashboard = app
  ok('seller dashboard splits paid vs accepted counts', /const kpiPaid\s+= paidOrders\.length/.test(dashboard) && /const kpiAccepted\s+= acceptedOrders\.length/.test(dashboard))
  ok('seller dashboard has exceptions bucket: disputes + provisional declines + returns',
    /const kpiDisputes/.test(dashboard) && /const kpiProvisionalDeclines/.test(dashboard) && /const kpiReturnExceptions/.test(dashboard))
  ok('seller dashboard renders sections for accept / ship / returns-disputes-exceptions',
    /📬 \$\{t\('待接单'\)\}/.test(dashboard) &&
    /📦 \$\{t\('待发货'\)\}/.test(dashboard) &&
    /⚠ \$\{t\('退货 · 争议 · 异常'\)\}/.test(dashboard))

  // E — MCP webaz_update_order Seller bullet documents decline + contest_decline + self-fulfill
  const sellerBullet = (mcp.split('\n').find(l => l.includes('**Seller**')) || '')
  ok('MCP Seller bullet includes decline', /\bdecline\b/.test(sellerBullet))
  ok('MCP Seller bullet includes contest_decline', /contest_decline/.test(sellerBullet))
  ok('MCP Seller bullet keeps the honest objective→provisional/NOT-auto-cleared framing', /provisional/i.test(sellerBullet) && /NOT auto-cleared|not auto-cleared/i.test(sellerBullet))
  ok('MCP Seller bullet documents Phase-1 self-fulfill pickup/transit/deliver', /pickup\/transit\/deliver ONLY when order\.logistics_id is empty/.test(sellerBullet) && /self-fulfill/.test(sellerBullet))

  // F — i18n parity for the key new seller strings
  for (const k of [
    '拒绝接单', '拒单理由', '确认拒单', '提交举证 / 发起仲裁', '临时判责 — 举证窗口开放',
    '退货 · 争议 · 异常', '自履约订单：你负责回传揽收/单号，超时仍按卖家责任处理。',
    '确认已经发货？发货后买家将看到物流信息，超时/虚假发货可能进入争议或判责。',
  ]) {
    ok(`i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
  }

  if (fail === 0) {
    console.log(`\n✅ seller order actions: paid → accept + decline(modal); 6 reason codes; objective→provisional+contest (not auto-exemption) / subjective→fault+refund; contest panel gated on provisional-seller-fault with honest copy; seller self-fulfill pickup/transit/deliver exposed in order detail with confirmations; dashboard splits accept/ship/exceptions; MCP Seller bullet documents decline + contest_decline + self-fulfill; i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ seller order actions FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}

main()
