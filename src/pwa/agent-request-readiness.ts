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
  // R1 — minimally-sufficient decision orchestration (agent behavior; WebAZ only guides).
  decision_orchestration: {
    intents: ['search', 'recommend_one', 'shortlist', 'compare', 'explain', 'spec', 'price', 'final_total', 'delivery', 'returns', 'seller_risk', 'prepare_order', 'open_approval', 'approval_status', 'order_status'],
    steps: ['understand the current question', 'derive the decision dimensions it needs', 'INSPECT facts you already hold (conversation / last result) FIRST', 'assess sufficiency (ready / assume / clarify)', 'request ONLY the missing minimal dimensions', 'compose a minimal-sufficient answer', 'act on important steps only with the buyer\'s Passkey'],
    do_not: 'Do NOT re-search + re-read full detail + re-dump on every follow-up. Answer "why recommend it?" / "which is cheaper?" from facts you already hold; only "final total?" needs a fresh quote.',
    session_context: 'Keep a per-shopping-session context and REUSE it across follow-ups: product_ids, result_handle, retrieval_pool, decision_shortlist, user_visible_set, decision_facts, facts_updated_at, recommended_product_id, quote_id, draft_id, approval_request_id. Re-fetch a dimension only when product / variant / quantity / ship-to region / default address / payment rail / quote expiry / stock / product status changed.',
    data_states: ['confirmed (server-authoritative now)', 'estimated', 'seller_asserted', 'platform_verified', 'recheck_required (re-verified at order creation)', 'stale', 'missing', 'conflicting'],
    data_state_rules: 'Tell the user WHICH state each fact is in. Never present estimated as confirmed, seller_asserted as WebAZ-verified, item price as final payable, "no sales history" as "unreliable", third-party sourcing as "definitely out of stock", or an unconfirmed shipping fee as "free".',
  },
  // R2 — dynamic candidate selection (no fixed 3/5 cap; cover the decision space with the fewest candidates).
  candidate_selection: {
    pools: {
      retrieval_pool: 'lightweight candidates: filter unshippable / out-of-stock / off-spec, dedup, see what main choices exist. Can be larger, but fetch only lightweight fields.',
      decision_shortlist: 'candidates with independent decision value, worth compact decision facts.',
      user_visible_set: 'only the few worth showing, each meaningfully different.',
    },
    dynamic_count: 'No fixed max (drop any "compare at most 3/5" rule). Decide by: question clarity, category complexity, candidate diversity, budget tiers, whether the user asked for several, data sufficiency, whether a lower-risk alternative helps. STOP adding candidates when a new one no longer materially improves the decision.',
    dominance_filter: 'Drop a candidate that is worse on every dimension the CURRENT user cares about with no independent advantage (brand / material / accessory / reliability / use-case). Judge dominance against the current need, not a fixed platform ranking.',
    marginal_gain: 'Keep a candidate only if it adds real value: a new advantage, a new price tier, a different use-case, or a lower-risk / clearly-cheaper-with-tradeoff alternative.',
    user_asked_N: 'If the user asks for N, show N ONLY if N have independent value; else show fewer, say why (the rest are near-duplicates), and offer "view more candidates". Never pad with dominated items to hit a number.',
    selection_rationale: 'Give ONE set-level line (e.g. "kept 4 of 12 shippable: lowest price / balanced / largest / accessory-included; the rest are near-duplicates") + ONE short reason per card.',
  },
  // R1/R2 presentation — minimal sufficient; the agent holds more than it shows.
  user_facing_output: {
    default_show: ['one set-level filter line', 'a few candidate cards', 'one short reason per card', 'one AI 推荐 (if you have one)', 'one key risk / uncertainty', 'one main next action'],
    default_hide: ['the demand-parse process', 'all assumption fields', 'the full filter logic', 'filtered-out products', 'every spec of every product', 'full provenance', 'score formulas', 'your internal reasoning', 'token/tool-call status', 'risks the user did not ask about'],
    price_discipline: 'Search cards show the ITEM price, not the final payable. Only after webaz_quote_order may you state an authoritative final total. Distinguish item price / estimated fees / live quote / final payable.',
    token_framing: 'Reducing tool calls is an internal goal — do not tell users "to save tokens". Frame it as: less repetition, easier to compare, avoid overload, keep only genuinely different choices.',
  },
} as const
