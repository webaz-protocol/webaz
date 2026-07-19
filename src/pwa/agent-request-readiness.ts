/**
 * R0 请求就绪门 —— agent 编排指引(单一真相源)。
 *
 * 三层保证之①(编排提示)经【资源通道】下发(webaz://guide/request-readiness + GET /api/agent/request-readiness),
 * 不占 buyer tools/list 44000B 预算;层③(服务端校验)见 server_guards 映射的既有守卫。
 * WebAZ 保持中立事实层:本指引只教 agent【何时该问、何时可直接取数、如何最小取数】,不替 agent 做推荐判断(§15)。
 */
export const REQUEST_READINESS_GUIDE = {
  schema_version: 'webaz.request_readiness.v1',
  principle: 'Form a clear goal + hard constraints (+ soft preferences) BEFORE a broad product request. Ask at most ONE combined question, and only when a missing field would materially change the candidate set or purchase risk. Reuse conversation context; fetch only the missing dimensions.',
  readiness_tiers: {
    ready: 'Category/goal clear + key hard constraints present + remaining unknowns will not change the candidate set → act now (lightweight discover/search). Example: "底部抽纸, ship SG".',
    assume: 'Info incomplete but a low-risk default is safe → act WITH a one-line stated assumption and let the user correct. Example: "普通桌面手机支架" → assume desktop use, qty 1, balanced pick.',
    clarify: 'A missing field would produce a different product TYPE or material purchase risk → ask ONE combined question first. Example: "recommend a laptop" without usage + budget.',
  },
  clarify_rules: [
    'Ask ONE question that resolves the biggest candidate fork (combine 2 tightly-related fields if needed, e.g. usage + budget).',
    'Offer 2-4 natural options, never a form; do not interrogate field-by-field.',
    'If the user says 你帮我决定 / 随便 / 普通用 / 你看着办 → use a balanced default, state the assumption in one line, lower the recommendation confidence, and give an easy way to adjust. Do NOT keep asking.',
    'While the user is still adding constraints across messages (collecting_constraints), merge them; do not re-search after every message — act once the intent is minimally sufficient.',
  ],
  hard_vs_soft: {
    hard_constraints_filter: ['ship_to_region', 'budget/max_price', 'required feature/spec', 'quantity', 'deadline'],
    soft_preferences_rank: ['brand', 'cheaper', 'larger capacity', 'seller reliability', 'faster delivery'],
    rule: 'Filter on hard constraints; rank on soft preferences. Never turn a soft preference into a hard filter (empties the set), and never drop a hard constraint into recommendation prose only.',
  },
  friction_budget: {
    typical_recommendation: '0-1 clarify + 1 lightweight discovery + 0-1 decision fetch + 1 minimal result',
    purchase: '1 quote + 1 draft/submit + 1 human Passkey approval',
    note: 'Not a hard cap, but exceeding it needs a real reason. Prefer "make a good pick, let the user correct" over "collect a full spec first".',
  },
  minimal_fetch: [
    'Request only the dimensions the current question needs.',
    'Reuse product_id / result_handle; never re-search by title for the same batch.',
    'Do not re-quote unless the user is buying or explicitly comparing final payable.',
    'Write timeouts (quote/draft/submit/order-action): the outcome is unknown, NOT un-executed — reconcile via a status read, never blind-retry.',
  ],
  server_guards: {
    discover: 'requires a category OR ≥1 keyword; else 400 EMPTY_INTENT with missing_fields + recommended_question + safe_next_action. Category = registry key (webaz://guide/categories).',
    search: 'strict-match only; 0 hits → recovery points to webaz_discover (not a browse). Unconstrained browse (no query/category/filter) caps at 8, else 400 UNBOUNDED_CATALOG_BROWSE.',
    quote: 'requires product_id (quantity defaults to 1); variant products fail closed with VARIANT_REQUIRED — never guess a variant.',
    detail: 'result_handle + selected_ids (1..5 ids from that page) — a targeted fetch, never a broad re-scan.',
  },
  recommendation_note: 'WebAZ returns FACTS only and never authors a "best buy". The recommendation is YOURS (the assistant): pass recommend_id + recommend_reason to webaz_search to highlight one card, shown as "AI 推荐" (non-authoritative, display-only).',
} as const
