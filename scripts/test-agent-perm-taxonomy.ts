#!/usr/bin/env tsx
/**
 * Agent 权限分级 taxonomy(PR-1,纯逻辑无 I/O):新 seller-scoped safe scopes + Permission Bundles +
 *   风险等级→有效期矩阵。安全铁律:bundle 只能全 safe(高风险永不入 bundle);risk 只能 once(永不长期);
 *   never-delegable 完全不可授。为后续 permission-request / grant 流程打地基。
 * Usage: npm run test:agent-perm-taxonomy
 */
import {
  classifyScope, SAFE_SCOPES, validateRequestedCapabilities,
  PERMISSION_BUNDLES, resolveBundle, bundleNonSafeScopes,
  allowedDurationsForScopes, durationAllowedForScopes, suggestedDurationForScopes, durationToSeconds, riskLevelForScopes,
} from '../src/runtime/agent-grant-scopes.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// ── 新 seller-scoped safe scopes ──
for (const s of ['seller_profile_read', 'seller_products_read', 'seller_inventory_read', 'seller_product_draft', 'seller_pricing_suggestion']) {
  ok(`1. ${s} classified safe`, classifyScope(s) === 'safe')
  ok(`1b. ${s} in SAFE_SCOPES`, (SAFE_SCOPES as readonly string[]).includes(s))
}

// ── Catalog Agent bundle ──
const cat = resolveBundle('catalog_agent')
ok('2. catalog_agent bundle resolves', !!cat && cat.label === 'Catalog Agent')
ok('3. bundle has the 9 catalog scopes', !!cat && cat.scopes.length === 9 && cat.scopes.includes('seller_products_read') && cat.scopes.includes('product_publish_request'))
ok('4. bundle EXCLUDES publish/order/money scopes (per spec)', !!cat && !cat.scopes.some(s => ['product_publish_direct', 'order_accept', 'order_ship', 'refund', 'withdraw', 'wallet', 'arbitrate', 'vote', 'api_key_rotate'].includes(s)))
ok('5. bundle is all-safe (INVARIANT: no risk/never in a bundle)', !!cat && bundleNonSafeScopes(cat).length === 0)
ok('6. unknown bundle key → null', resolveBundle('nope') === null && resolveBundle(123) === null)

// ── acceptance #7: a high-risk scope can NEVER enter a bundle ──
ok('7. bundleNonSafeScopes flags an injected risk scope', bundleNonSafeScopes({ key: 'x', label: 'x', scopes: ['seller_products_read', 'order_accept'], human_summary: '', human_summary_en: '' }).join() === 'order_accept')
ok('7b. bundleNonSafeScopes flags a never-delegable scope', bundleNonSafeScopes({ key: 'x', label: 'x', scopes: ['withdraw'], human_summary: '', human_summary_en: '' }).join() === 'withdraw')
// the shipped bundles all passed the load-time all-safe assertion (module imported without throwing) — proven by reaching here.
ok('7c. all shipped bundles loaded (all-safe assertion passed at import)', Object.values(PERMISSION_BUNDLES).every(b => bundleNonSafeScopes(b).length === 0))

// ── duration matrix by risk tier ──
ok('8. safe scopes → once…30d (long-term ok)', allowedDurationsForScopes(['seller_products_read']).join() === 'once,1h,24h,7d,30d')
ok('9. any RISK scope → once ONLY (never long-term)', allowedDurationsForScopes(['seller_products_read', 'order_accept']).join() === 'once')
ok('10. any never-delegable → [] (cannot grant at all)', allowedDurationsForScopes(['withdraw']).length === 0)
ok('11. unknown scope → [] ', allowedDurationsForScopes(['made_up_scope']).length === 0)
ok('12. durationAllowed: safe+7d ok, safe+forever rejected', durationAllowedForScopes(['seller_products_read'], '7d') && !durationAllowedForScopes(['seller_products_read'], 'forever'))
ok('13. durationAllowed: risk+7d REJECTED (high-risk cannot be long-term)', !durationAllowedForScopes(['order_accept'], '7d') && durationAllowedForScopes(['order_accept'], 'once'))
ok('14. suggested default = 7d for safe, once for risk', suggestedDurationForScopes(['seller_products_read']) === '7d' && suggestedDurationForScopes(['order_accept']) === 'once')
ok('15. durationToSeconds: 7d=604800, 30d=2592000, once=0', durationToSeconds('7d') === 604800 && durationToSeconds('30d') === 2592000 && durationToSeconds('once') === 0)

// ── risk level labels ──
ok('16. read/draft scopes → low', riskLevelForScopes(['seller_products_read', 'seller_product_draft']) === 'low')
ok('17. product_publish_request → medium (request-only, still human-gated to publish)', riskLevelForScopes(['product_publish_request']) === 'medium')
ok('18. any risk scope → high', riskLevelForScopes(['order_accept']) === 'high')
ok('19. never-delegable → blocked', riskLevelForScopes(['withdraw']) === 'blocked')
ok('20. catalog bundle overall risk = medium (has publish_request)', riskLevelForScopes(cat!.scopes) === 'medium')

// ── existing validateRequestedCapabilities still fail-closed on the new set ──
ok('21. bundle scopes all pass validateRequestedCapabilities (safe)', validateRequestedCapabilities(cat!.scopes.map(c => ({ capability: c }))).ok)
ok('22. mixing a risk scope still rejects the whole request', !validateRequestedCapabilities([{ capability: 'seller_products_read' }, { capability: 'order_accept' }]).ok)

if (fail > 0) { console.error(`\n❌ agent-perm-taxonomy FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ agent permission taxonomy: seller-scoped safe scopes + Catalog Agent bundle (all-safe invariant, high-risk can never enter) + risk→duration matrix (safe once…30d / risk once-only / never blocked) + risk labels\n  ✅ pass ${pass}`)
