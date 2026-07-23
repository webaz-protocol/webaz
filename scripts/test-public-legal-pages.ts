#!/usr/bin/env tsx
/**
 * Public legal/support page contract for plugin submission.
 * Locks behavior-level disclosures and rejects previously overbroad promises.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SHOPPING_V1_SURFACE_TOOLS } from '../src/layer1-agent/L1-1-mcp-server/tool-surfaces.js'
import { TOOL_ANNOTATIONS } from '../src/layer1-agent/L1-1-mcp-server/tool-annotations.js'

const ROOT = resolve(import.meta.dirname, '..')
let pass = 0
let fail = 0
const problems: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) { pass++; return }
  fail++
  problems.push(name)
}
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')
const privacy = read('src/pwa/public/privacy/index.html')
const terms = read('src/pwa/public/terms/index.html')
const support = read('src/pwa/public/support/index.html')
const privacyMd = read('docs/PRIVACY-POLICY.md')
const termsMd = read('docs/TERMS-OF-SERVICE.md')
const deletionRoute = read('src/pwa/routes/account-deletion.ts')
const serverSource = read('src/pwa/server.ts')
const loginSource = read('src/pwa/routes/auth-login.ts')
const recoverySource = read('src/pwa/routes/recover-key.ts')
const adminBearerSource = read('src/pwa/admin-bearer-auth.ts')
const deletionFinalizeSource = read('src/pwa/account-deletion-finalize.ts')
const allPublic = [privacy, terms, support]
const privacyMdFlat = privacyMd.replace(/\s+/g, ' ')
const termsMdFlat = termsMd.replace(/\s+/g, ' ')

ok('all pages identify the verified individual publisher',
  allPublic.every(page => page.includes('XU FENGNA')))
ok('all pages publish the support contact',
  allPublic.every(page => page.includes('contact@webaz.xyz')))
ok('all pages are mobile-aware static documents',
  allPublic.every(page => page.includes('width=device-width') && !/<script\b/i.test(page)))

ok('privacy precisely describes the submitted one-tool anonymous read-only surface',
  /shopping_v1[\s\S]*anonymous and read-only[\s\S]*only <code>webaz_search<\/code>/i.test(privacy)
  && /does not connect accounts[\s\S]*create orders[\s\S]*checkout or payment/i.test(privacy))
ok('legal one-tool claim is bound to the runtime surface and annotation',
  JSON.stringify([...SHOPPING_V1_SURFACE_TOOLS]) === JSON.stringify(['webaz_search'])
  && TOOL_ANNOTATIONS.webaz_search?.readOnlyHint === true
  && TOOL_ANNOTATIONS.webaz_search?.destructiveHint === false)
ok('privacy discloses automatic Anthropic feedback and configured comment moderation',
  /Feedback submissions are sent to Anthropic[\s\S]*comments may be sent to Anthropic/i.test(privacy))
ok('comment moderation sanitizes content before the Anthropic call',
  /piiSanitize\(text\)\.slice\(0, 500\)/.test(serverSource))
ok('privacy discloses admin-invoked AI account-risk review and its advisory role',
  /administrator may invoke an Anthropic-assisted account-risk summary/i.test(privacy)
  && /supports human review and does not itself make the final account decision/i.test(privacy))
ok('privacy discloses browser-selected AI provider storage and direct requests',
  /keys, endpoints, and model settings are stored in browser storage/i.test(privacy)
  && /WebAZ authentication API key[\s\S]*IndexedDB/i.test(privacy))
ok('privacy lists financial, location, OAuth and delegation data categories',
  /Wallet, ledger, deposit, withdrawal, collateral, commission/i.test(privacy)
  && /Coarse location coordinates/i.test(privacy)
  && /OAuth grants, delegated-agent permissions/i.test(privacy))
ok('privacy lists email delivery and fulfillment recipients',
  /Resend[\s\S]*verification and service-email delivery/i.test(privacy)
  && /Order counterparties and fulfillment participants[\s\S]*recipient, address, phone/i.test(privacy))
ok('privacy discloses public identifiers without an absolute no-PII promise',
  /Public product results may include product IDs and public seller identifiers/i.test(privacy)
  && /cannot guarantee removal of every identifier/i.test(privacy))
ok('privacy retention and deletion wording matches bounded implementation',
  /does not currently publish or implement one protocol-wide retention period/i.test(privacy)
  && /implemented 14-day job/i.test(privacy)
  && /disables the account's password and API key[\s\S]*revokes active sessions/i.test(privacy)
  && /does not erase every linked order, dispute, KYC, audit, security, or other record/i.test(privacy))
ok('privacy describes bounded JSON export and orders-only CSV',
  /JSON export containing bounded snapshots/i.test(privacy)
  && /CSV export contains orders only/i.test(privacy))
ok('privacy accurately limits Passkey protection to selected high-risk operations',
  /Passkey human-presence gates protect selected high-risk operations/i.test(privacy)
  && /not every profile or address update requires a Passkey/i.test(privacy))
ok('account-deletion API notice matches the bounded anonymization policy',
  /14 天后将停用账户凭证并匿名化选定的档案和地址字段/.test(deletionRoute)
  && /关联订单、争议、KYC、审计及安全记录不会全部删除/.test(deletionRoute)
  && !/PII 永久擦除/.test(deletionRoute))
ok('deleted accounts cannot authenticate through the shared API-key resolver',
  /SELECT \* FROM users WHERE api_key = \? AND deleted_at IS NULL/.test(serverSource))
ok('deleted accounts cannot return through login, recovery, or admin Bearer paths',
  (loginSource.match(/deleted_at IS NULL/g) || []).length === 2
  && /ACCOUNT_MATCH = [^\n]*deleted_at IS NULL/.test(recoverySource)
  && /WHERE id = \? AND deleted_at IS NULL/.test(recoverySource)
  && /api_key = \? AND deleted_at IS NULL/.test(adminBearerSource))
ok('final deletion rechecks commerce responsibilities before revoking access',
  /hasPendingOrders[\s\S]*hasOpenDisputes[\s\S]*wallet\.balance > 0\.01[\s\S]*return false/.test(deletionFinalizeSource))
ok('deleted sellers cannot accept new orders and their active listings are paused',
  /trg_orders_reject_deleted_seller[\s\S]*BEFORE INSERT ON orders[\s\S]*deleted_at IS NOT NULL/.test(deletionFinalizeSource)
  && /UPDATE products SET status = 'paused'/.test(deletionFinalizeSource))
ok('final deletion closes the live client and cannot restore public identity or sponsor eligibility',
  /disconnectDeletedAccountClient\(sseClients, c\.user_id\)/.test(serverSource)
  && /deleted_at IS NULL AND \(permanent_code IS NULL OR handle IS NULL\)/.test(serverSource)
  && /l1_share_override FROM users WHERE id = \? AND deleted_at IS NULL/.test(serverSource))

ok('terms contains all 15 sections',
  Array.from({ length: 15 }, (_, index) => terms.includes(`§${index + 1}`)).every(Boolean))
ok('terms limit the OpenAI app to anonymous read-only product discovery',
  /anonymous, read-only discovery of reviewed physical goods/i.test(terms)
  && /does not create orders, reserve inventory, connect accounts, process checkout, or transfer funds/i.test(terms))
ok('terms state Direct Pay is conditional and cannot refund principal',
  /Direct Pay is available only where deployment controls and seller eligibility gates pass/i.test(terms)
  && /does not receive, route, or hold transaction principal/i.test(terms)
  && /cannot transfer or refund principal/i.test(terms))
ok('terms do not invent an order appeal',
  /No general order-dispute appeal is currently implemented/i.test(terms))
ok('terms do not make an unsupported claim about arbitrator professional credentials',
  /does not require or verify judicial or legal-professional qualifications/i.test(terms)
  && /do not act as a court or as legal counsel/i.test(terms)
  && !/not judges or licensed legal practitioners/i.test(terms))
ok('terms describe the current reward clamp, self-L1, and referral facts',
  /clamps every region to at most L1/i.test(terms)
  && /eligible buyer may be their own L1/i.test(terms)
  && /invitation and referral features exist/i.test(terms))
ok('terms preserve the license, liability amount, and severability',
  ['Business Source License 1.1', 'USD 100', 'Severability'].every(value => terms.includes(value)))
ok('terms avoid undefined exclusive domicile venue',
  /court or forum having jurisdiction/i.test(terms)
  && !/operator'?s domicile|courts of the operator/i.test(terms))

ok('support covers app-search diagnostics and warns against sensitive submissions',
  /app-search problems[\s\S]*search terms, product link, approximate time, platform, and device/i.test(support)
  && /Do not send passwords[\s\S]*KYC material[\s\S]*QR codes[\s\S]*payment proofs/i.test(support))
ok('support states conditional Direct Pay and no principal refund power',
  /only where Direct Pay is enabled/i.test(support)
  && /cannot reverse or refund that principal/i.test(support))
ok('support links both public legal pages',
  support.includes('href="/privacy"') && support.includes('href="/terms"'))

ok('canonical Markdown carries the same critical privacy and terms facts',
  /shopping_v1[\s\S]*anonymous and read-only[\s\S]*webaz_search/i.test(privacyMd)
  && privacyMdFlat.includes('Feedback submissions are sent to Anthropic')
  && privacyMdFlat.includes('administrator may invoke an Anthropic-assisted account-risk summary')
  && privacyMdFlat.includes('WebAZ authentication API key in browser storage, including IndexedDB')
  && privacyMdFlat.includes('Resend** delivers verification and service email')
  && privacyMdFlat.includes('Order counterparties and fulfillment participants')
  && privacyMdFlat.includes("disables the account's password and API key")
  && privacyMdFlat.includes('does not erase every linked order, dispute, KYC, audit, security, or other record')
  && termsMdFlat.includes('Direct Pay is available only where deployment controls and seller eligibility gates pass')
  && termsMdFlat.includes('No general order-dispute appeal is currently implemented')
  && termsMdFlat.includes('does not require or verify judicial or legal-professional qualifications'))

const forbidden = [
  /Direct Pay is (?:live|the current real-payment rail)/i,
  /No PII in the public record/i,
  /personal data is wiped except/i,
  /after exhausting the protocol(?:'s)? appeal mechanism/i,
  /operator'?s domicile/i,
  /operator may unilaterally substitute/i,
]
ok('public and canonical documents reject prior overbroad claims',
  forbidden.every(pattern => !pattern.test([privacy, terms, support, privacyMd, termsMd].join('\n'))))

if (fail) {
  console.error(`public-legal-pages FAILED (${pass} pass, ${fail} fail)\n${problems.map(problem => `- ${problem}`).join('\n')}`)
  process.exit(1)
}
console.log(`public-legal-pages passed (${pass} assertions)`)
