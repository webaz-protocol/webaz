# RESOURCE_REGISTRATION_MATRIX

> **Code-generated** by `scripts/diagnose-mcp-card-matrix.ts` from the live `buildMcpServer({surface:'full'})`. Do not hand-edit.
> Generated against commit HEAD on the audit branch. Every row is what `resources/list` + `resources/read` actually return.

## All registered resources (10)

| URI | name | ListResources MIME | kind |
|---|---|---|---|
| `webaz://protocol/manifest` | WebAZ Protocol Manifest | `application/json` | guide (json) |
| `ui://widget/webaz-products.html` | WebAZ ProductResults widget | `text/html+skybridge` | UI widget |
| `ui://widget/webaz-quote-approval.html` | WebAZ QuoteAndApproval widget | `text/html+skybridge` | UI widget |
| `ui://widget/webaz-order-timeline.html` | WebAZ OrderTimeline widget | `text/html+skybridge` | UI widget |
| `ui://widget/webaz-products-mcp.html` | WebAZ ProductResults (MCP Apps) | `text/html;profile=mcp-app` | UI widget |
| `ui://widget/webaz-quote-approval-mcp.html` | WebAZ QuoteAndApproval (MCP Apps) | `text/html;profile=mcp-app` | UI widget |
| `ui://widget/webaz-order-timeline-mcp.html` | WebAZ OrderTimeline (MCP Apps) | `text/html;profile=mcp-app` | UI widget |
| `webaz://guide/categories` | WebAZ category registry (for webaz_discover) | `application/json` | guide (json) |
| `webaz://guide/info` | WebAZ full onboarding guide (long form) | `application/json` | guide (json) |
| `webaz://guide/request-readiness` | WebAZ request-readiness gate (agent orchestration) | `application/json` | guide (json) |

## UI widget resources — read-back verification

| ListResources URI | ReadResource contents[].uri | ListMIME | ReadMIME | uri==uri | mime==mime | component | bridge | CSP key | bytes |
|---|---|---|---|---|---|---|---|---|---|
| `ui://widget/webaz-products.html` | `ui://widget/webaz-products.html` | `text/html+skybridge` | `text/html+skybridge` | ✅ | ✅ | ProductResults | legacy(window.openai) | `openai/widgetCSP` | 16695 |
| `ui://widget/webaz-quote-approval.html` | `ui://widget/webaz-quote-approval.html` | `text/html+skybridge` | `text/html+skybridge` | ✅ | ✅ | QuoteAndApproval | legacy(window.openai) | `openai/widgetCSP` | 11249 |
| `ui://widget/webaz-order-timeline.html` | `ui://widget/webaz-order-timeline.html` | `text/html+skybridge` | `text/html+skybridge` | ✅ | ✅ | OrderTimeline | legacy(window.openai) | `openai/widgetCSP` | 8627 |
| `ui://widget/webaz-products-mcp.html` | `ui://widget/webaz-products-mcp.html` | `text/html;profile=mcp-app` | `text/html;profile=mcp-app` | ✅ | ✅ | ProductResults | standard(+legacy fallback) | `_meta.ui.csp` | 19328 |
| `ui://widget/webaz-quote-approval-mcp.html` | `ui://widget/webaz-quote-approval-mcp.html` | `text/html;profile=mcp-app` | `text/html;profile=mcp-app` | ✅ | ✅ | QuoteAndApproval | standard(+legacy fallback) | `_meta.ui.csp` | 13882 |
| `ui://widget/webaz-order-timeline-mcp.html` | `ui://widget/webaz-order-timeline-mcp.html` | `text/html;profile=mcp-app` | `text/html;profile=mcp-app` | ✅ | ✅ | OrderTimeline | standard(+legacy fallback) | `_meta.ui.csp` | 11260 |

## Cross-wiring checks (Phase-2 §III, 1–10)

| # | check | result | detail |
|---|---|---|---|
| 1 | tool resourceUri/outputTemplate exists in ListResources | ✅ pass | all 5 UI tools resolve |
| 2 | ui.resourceUri === openai/outputTemplate | ⚠️ FLAG | webaz_search: std=ui://widget/webaz-products-mcp.html vs openai=ui://widget/webaz-products.html; webaz_buyer_orders: std=ui://widget/webaz-order-timeline-mcp.html vs openai=ui://widget/webaz-order-timeline.html; webaz_quote_order: std=ui://widget/webaz-quote-approval-mcp.html vs openai=ui://widget/webaz-quote-approval.html; webaz_order_draft: std=ui://widget/webaz-quote-approval-mcp.html vs openai=ui://widget/webaz-quote-approval.html; webaz_submit_order_request: std=ui://widget/webaz-quote-approval-mcp.html vs openai=ui://widget/webaz-quote-approval.html |
| 3 | ListResources uri/mime === ReadResource contents[].uri/mime | ✅ pass | all 6 UI resources consistent |
| 4 | legacy + standard variant bind to the SAME correct component | ✅ pass | webaz-products.html=ProductResults, webaz-quote-approval.html=QuoteAndApproval, webaz-order-timeline.html=OrderTimeline |
| 5 | no UNEXPECTED many-tools→one-resource (quote/draft/submit sharing QuoteAndApproval is BY DESIGN) | ✅ pass | webaz-quote-approval-mcp.html ← {webaz_quote_order, webaz_order_draft, webaz_submit_order_request} |
| 6 | each URI maps to exactly one HTML body (no same-URI/two-bodies) | ✅ pass | webaz-products.html:16695B webaz-quote-approval.html:11249B webaz-order-timeline.html:8627B webaz-products-mcp.html:19328B webaz-quote-approval-mcp.html:13882B webaz-order-timeline-mcp.html:11260B |
| 7 | widget URIs are content-versioned | ⚠️ FLAG | ALL six widget URIs are unversioned (…-products.html / …-products-mcp.html etc.) — no hash/version segment. Host caching keys on the URI, so a redeploy that changes the HTML body reuses the old cache entry until the host TTL expires. [see BRIDGE/REMEDIATION] |
| 8 | no array-index / order-derived resource binding | ✅ pass | ReadResource dispatches by explicit `request.params.uri ===` / STANDARD_WIDGETS[uri] map — NOT by array index; ListResources is a static literal array. No index-derived binding. |
| 9 | quote/draft/submit bind to QuoteAndApproval (not to each other/product/timeline) | ✅ pass | quote→QuoteAndApproval \| draft→QuoteAndApproval \| submit→QuoteAndApproval |
| 10 | no duplicate resource URIs (cache-key collision) | ✅ pass | 6 distinct URIs |
| 11 | DIRECT_TOOL card tools are app-visible (widget calls them directly; quote_order app-visible after Phase-3A) | ✅ pass | search=app buyer_orders=app order_draft=app submit_order_request=app quote_order=app |
