/**
 * Endpoint → action-scope classifier — the WRITE-boundary spine (元规则 #3 + #1115 default-deny).
 * RFC-011 §② (capability matrix): the SAME declarative rules that ENFORCE the boundary at runtime
 * are also SERIALIZED (capabilityMatrix) and published live, so an integrator's agent reads exactly
 * what the protocol enforces — doc=code, zero drift. Extracted from server.ts unchanged in behaviour
 * (locked by tests/test-endpoint-actions.ts, which diffs this against the legacy if-chain).
 *
 * Model: GET reads are open (except the sensitive cross-user read scopes below). Every WRITE either
 * maps to a named action-scope token (agent must declare that scope, or hold a Passkey, or declare '*'),
 * or is on the SAFE list (write allowed without a declared scope — bootstrap/auth/low-value self-state),
 * or falls through to the generic 'write' token (default-deny: new sensitive writes are gated by default).
 */
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'

type MethodMatch = 'POST' | 'POST_PUT' | 'WRITE'   // WRITE = any non-GET method
interface WriteRule { method: MethodMatch; exact?: string; re?: RegExp; action: string }

/** Ordered write-action rules. Order matters (first match wins). Mirrors the legacy if-chain exactly. */
export const WRITE_RULES: WriteRule[] = [
  { method: 'POST',     exact: '/api/orders',                                    action: 'place_order' },
  { method: 'POST',     exact: '/api/cart/checkout',                              action: 'place_order' },
  { method: 'POST_PUT', re: /^\/api\/products(\/[^/]+)?$/,                        action: 'list_product' },
  { method: 'POST',     re: /^\/api\/orders\/[^/]+\/(accept|ship|deliver|pickup|transit)/, action: 'fulfill' },
  { method: 'POST',     re: /^\/api\/orders\/[^/]+\/confirm/,                     action: 'confirm_order' },
  { method: 'POST',     re: /^\/api\/claim-tasks\/[^/]+\/vote/,                   action: 'vote' },
  { method: 'POST',     re: /^\/api\/disputes\/[^/]+\/arbitrate/,                 action: 'arbitrate' },
  { method: 'POST',     re: /^\/api\/disputes\/[^/]+\/respond/,                   action: 'dispute_respond' },
  { method: 'POST',     re: /^\/api\/charity\/fund\/donate/,                      action: 'donate' },
  { method: 'POST',     re: /^\/api\/(wishes|charity)/,                           action: 'charity' },
  { method: 'POST',     re: /^\/api\/shareables/,                                 action: 'share' },
  { method: 'POST',     re: /^\/api\/conversations/,                              action: 'chat' },
  { method: 'POST',     exact: '/api/skills',                                     action: 'list_skill' },
  { method: 'POST',     re: /^\/api\/rfqs/,                                       action: 'rfq' },
  { method: 'POST',     re: /^\/api\/auctions\/[^/]+\/bid/,                       action: 'bid' },
  // #1115 P0:花钱/价值写纳入问责门(与 place_order 同档)
  { method: 'POST',     re: /^\/api\/skill-market\/[^/]+\/purchase/,             action: 'purchase' },
  { method: 'POST',     re: /^\/api\/secondhand\/[^/]+\/order/,                  action: 'buy_secondhand' },
  { method: 'POST',     re: /^\/api\/group-buys\/[^/]+\/join/,                   action: 'group_buy_join' },
  // Direct Pay (Rail 1) = RISK scope:为【未来】/api/direct-pay/* 写面【保留】'direct_pay' 分类(该面尚无路由)。
  //   ⚠️ SCAFFOLD:Passkey/两次披露门当前是 helper,【尚未】接到任何 handler;真实 enforcement 随 create-route/UI/ack 端点在后续 PR 落地。
  { method: 'WRITE',    re: /^\/api\/direct-pay\//,                              action: 'direct_pay' },
  // Codex #98 P1:review claim 锁 5 WAZ stake(扣 balance + escrowed)—— 资金写,绝不能落 SAFE,纳入 default-deny 问责门。
  //   只命中 .../:type/:id/claim;其余 reviews 写无规则 → 落通用 'write'(仍 default-deny),GET reviews 由 endpointToAction(GET) 返回 null。
  { method: 'POST',     re: /^\/api\/reviews\/[^/]+\/[^/]+\/claim$/,             action: 'review_claim' },
  // #1115 P1:写 PII(收货地址)。原为 (addresses OR profile/default-address);拆两条等价规则,顺序保持。
  { method: 'WRITE',    re: /^\/api\/addresses(\/|$)/,                            action: 'set_address' },
  { method: 'WRITE',    exact: '/api/profile/default-address',                    action: 'set_address' },
  // #1115 P2:钱包写统一 'wallet'(withdraw 另在 handler 强制 Passkey 铁律)
  { method: 'WRITE',    re: /^\/api\/wallet\//,                                   action: 'wallet' },
  // #1115 P2:profile PII/身份/接管向量子集 'set_profile'(其余 profile 自助写在 SAFE)
  { method: 'WRITE',    re: /^\/api\/profile\/(bind-email|confirm-email|change-handle|change-name|set-location|clear-location)$/, action: 'set_profile' },
]

/** SAFE writes — allowed without a declared scope (bootstrap/auth/self-bound-gate/low-value self-state). */
export const SAFE_WRITE: RegExp[] = [
  /^\/api\/(login|register)$/, /^\/api\/recover-key/, /^\/api\/webauthn\//,
  /^\/api\/me\/agents\//,
  /^\/api\/profile\/(switch-role|add-role|region|placement-pref|bind-placement|feed-visible|verify-password|set-password|remove-password)$/,
  /^\/api\/build-feedback/, /^\/api\/build-tasks/, /^\/api\/admin\//,
  /^\/api\/(public-ideas|error-report|mcp-telemetry|email-subscriptions|search-by-link|feedback)(\/|$)/,
  /^\/api\/cart$/, /^\/api\/cart\/(?!checkout)[^/]+$/,
  /^\/api\/wishlist/, /^\/api\/products\/[^/]+\/waitlist$/,
  /^\/api\/notifications\/read$/, /^\/api\/announcements\/[^/]+\/read$/,
  /^\/api\/follows\//, /^\/api\/blocklist\//,
  /^\/api\/checkin$/, /^\/api\/growth\/tasks\//, /^\/api\/tasks\/[^/]+\/claim$/,
  /^\/api\/push\//, /^\/api\/auth\//,
  /^\/api\/me\/(delete-cancel|notify-claim-tasks)/,
  /^\/api\/peers\//, /^\/api\/signaling\//,
  /^\/api\/product-share\/touch$/, /^\/api\/anchor\/[^/]+\/touch$/,
  // Codex #98 P1:不再整段放行 /api/reviews/ —— claim 是 5 WAZ 质押资金写,已上提到 WRITE_RULES(review_claim);
  //   GET reviews(recent / :type/:id/claims)无须写 scope(GET 由 endpointToAction 返回 null,不依赖 SAFE)。
]

function methodMatches(m: MethodMatch, method: string): boolean {
  if (m === 'POST') return method === 'POST'
  if (m === 'POST_PUT') return method === 'POST' || method === 'PUT'
  return method !== 'GET'   // WRITE
}

/** Write-boundary classifier. Returns a named action-scope token, or 'write' (generic), or null (open). */
export function endpointToAction(method: string, path: string): string | null {
  if (method === 'GET') return null
  for (const r of WRITE_RULES) {
    if (!methodMatches(r.method, method)) continue
    if (r.exact !== undefined ? path === r.exact : r.re!.test(path)) return r.action
  }
  if (SAFE_WRITE.some(re => re.test(path))) return null
  return 'write'   // 默认拒绝:其余写需问责
}

/** Sensitive cross-user READ scopes (Phase 3b B1) — only constrains *declared* agents; humans/'*'/undeclared exempt. */
export const READ_RULES: Array<{ re: RegExp; scope: string }> = [
  { re: /^\/api\/nearby/,        scope: 'search' },   // 雷达扫描(地理聚合)
  { re: /^\/api\/search/,        scope: 'search' },   // 模糊搜索深翻页
  { re: /^\/api\/users\/[^/]+\//, scope: 'profile' }, // 他人主页/信誉/内容流(枚举剽窃向)
]
export function endpointToReadAction(path: string): string | null {
  for (const r of READ_RULES) if (r.re.test(path)) return r.scope
  return null
}

/** Serialize the live boundary as the agent-readable capability matrix (RFC-011 §②). doc=code. */
export function capabilityMatrix() {
  return {
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    model: 'default-deny writes. GET reads are open except the sensitive cross-user read scopes. Every write either maps to a named action-scope token (the agent must declare that scope on its api_key, OR hold a Passkey, OR declare "*"), or is SAFE (write allowed unscoped), or falls through to the generic "write" token.',
    write_actions: WRITE_RULES.map(r => ({
      action: r.action,
      method: r.method === 'POST' ? 'POST' : r.method === 'POST_PUT' ? 'POST|PUT' : 'POST|PUT|PATCH|DELETE',
      match: r.exact !== undefined ? `=${r.exact}` : r.re!.source,
    })),
    safe_write_unscoped: SAFE_WRITE.map(re => re.source),
    read_scopes: READ_RULES.map(r => ({ scope: r.scope, match: r.re.source })),
    notes: {
      passkey_exempt: 'A Passkey-bound human is exempt from scope-declaration (但仍受铁律真人门约束).',
      iron_rule: 'arbitrate / vote / agent_revoke / delete_passkey / large withdraw require a live WebAuthn ceremony regardless of declared scope (CHARTER §4 iron-rule).',
      undeclared: 'An agent that has NOT declared any actions and has no Passkey is denied any named/ generic write (AGENT_SCOPE_UNDECLARED).',
    },
  }
}
