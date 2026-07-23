/**
 * Public legal/support page contract.
 * These static documents are plugin-submission URLs and must remain complete, public, and contactable.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
let pass = 0
let fail = 0
const problems: string[] = []
const ok = (name: string, condition: boolean) => {
  if (condition) { pass++; return }
  fail++; problems.push(name)
}
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')
const privacy = read('src/pwa/public/privacy/index.html')
const terms = read('src/pwa/public/terms/index.html')
const support = read('src/pwa/public/support/index.html')

ok('privacy is a complete published policy, not a teaser', /What we collect[\s\S]*Sharing &amp; third parties[\s\S]*Your rights[\s\S]*Cookies &amp; tracking[\s\S]*Children/.test(privacy))
ok('privacy includes the real support contact', privacy.includes('contact@webaz.xyz'))
ok('public pages identify the verified individual publisher consistently', [privacy, terms, support].every(page => page.includes('XU FENGNA')))
ok('privacy does not claim legal review', !/counsel[- ]reviewed|approved by counsel|lawyer[- ]reviewed/i.test(privacy))
ok('terms contains all 15 sections', Array.from({ length: 15 }, (_, i) => terms.includes(`§${i + 1}`)).every(Boolean))
ok('terms retain the source material terms, not only headings', ['Business Source License 1.1', 'L1 70% / L2 20% / L3 10%', 'USD 100', 'Severability'].every(term => terms.includes(term)))
ok('terms describe multi-tier order attribution without the contradictory no-downline claim', terms.includes('No payment for recruitment or headcount') && !terms.includes('No team or downline commission'))
ok('terms honestly disclose Direct Pay and simulated escrow', /non-custodial[\s\S]*escrow rail remains simulated/i.test(terms))
ok('terms link the published privacy page', terms.includes('href="/privacy"'))
ok('support includes the public contact and safety warning', support.includes('mailto:contact@webaz.xyz') && /Do not send passwords/.test(support))
ok('support links all public legal endpoints', support.includes('href="/privacy"') && support.includes('href="/terms"'))
ok('all pages are mobile-aware and static', [privacy, terms, support].every(page => page.includes('width=device-width') && !/<script\b/i.test(page)))

if (fail) {
  console.error(`public-legal-pages FAILED (${pass} pass, ${fail} fail)\n${problems.map(p => `- ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`public-legal-pages passed (${pass} assertions)`)
