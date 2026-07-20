# RESOURCE_REGISTRATION_MATRIX

> **Code-generated** by `scripts/diagnose-mcp-card-matrix.ts` from the live `buildMcpServer({surface:'full'})`. Do not hand-edit.
> Generated against commit HEAD on the audit branch. Every row is what `resources/list` + `resources/read` actually return.

## All registered resources (10)

| URI | name | ListResources MIME | kind |
|---|---|---|---|
| `webaz://protocol/manifest` | WebAZ Protocol Manifest | `application/json` | guide (json) |
| `ui://widget/webaz-products.c4bd5e13bb.html` | WebAZ ProductResults widget | `text/html+skybridge` | UI widget |
| `ui://widget/webaz-quote-approval.4770e0569f.html` | WebAZ QuoteAndApproval widget | `text/html+skybridge` | UI widget |
| `ui://widget/webaz-order-timeline.1422dd6d4b.html` | WebAZ OrderTimeline widget | `text/html+skybridge` | UI widget |
| `ui://widget/webaz-products-mcp.859d24466f.html` | WebAZ ProductResults (MCP Apps) | `text/html;profile=mcp-app` | UI widget |
| `ui://widget/webaz-quote-approval-mcp.0d157bb047.html` | WebAZ QuoteAndApproval (MCP Apps) | `text/html;profile=mcp-app` | UI widget |
| `ui://widget/webaz-order-timeline-mcp.af0f70edba.html` | WebAZ OrderTimeline (MCP Apps) | `text/html;profile=mcp-app` | UI widget |
| `webaz://guide/categories` | WebAZ category registry (for webaz_discover) | `application/json` | guide (json) |
| `webaz://guide/info` | WebAZ full onboarding guide (long form) | `application/json` | guide (json) |
| `webaz://guide/request-readiness` | WebAZ request-readiness gate (agent orchestration) | `application/json` | guide (json) |

## UI widget resources — read-back verification

| ListResources URI | ReadResource contents[].uri | ListMIME | ReadMIME | uri==uri | mime==mime | component | bridge | CSP key | bytes |
|---|---|---|---|---|---|---|---|---|---|
| `ui://widget/webaz-products.c4bd5e13bb.html` | `ui://widget/webaz-products.c4bd5e13bb.html` | `text/html+skybridge` | `text/html+skybridge` | ✅ | ✅ | ProductResults | legacy(window.openai) | `openai/widgetCSP` | 16983 |
| `ui://widget/webaz-quote-approval.4770e0569f.html` | `ui://widget/webaz-quote-approval.4770e0569f.html` | `text/html+skybridge` | `text/html+skybridge` | ✅ | ✅ | QuoteAndApproval | legacy(window.openai) | `openai/widgetCSP` | 11249 |
| `ui://widget/webaz-order-timeline.1422dd6d4b.html` | `ui://widget/webaz-order-timeline.1422dd6d4b.html` | `text/html+skybridge` | `text/html+skybridge` | ✅ | ✅ | OrderTimeline | legacy(window.openai) | `openai/widgetCSP` | 8627 |
| `ui://widget/webaz-products-mcp.859d24466f.html` | `ui://widget/webaz-products-mcp.859d24466f.html` | `text/html;profile=mcp-app` | `text/html;profile=mcp-app` | ✅ | ✅ | ProductResults | standard(+legacy fallback) | `_meta.ui.csp` | 19616 |
| `ui://widget/webaz-quote-approval-mcp.0d157bb047.html` | `ui://widget/webaz-quote-approval-mcp.0d157bb047.html` | `text/html;profile=mcp-app` | `text/html;profile=mcp-app` | ✅ | ✅ | QuoteAndApproval | standard(+legacy fallback) | `_meta.ui.csp` | 13882 |
| `ui://widget/webaz-order-timeline-mcp.af0f70edba.html` | `ui://widget/webaz-order-timeline-mcp.af0f70edba.html` | `text/html;profile=mcp-app` | `text/html;profile=mcp-app` | ✅ | ✅ | OrderTimeline | standard(+legacy fallback) | `_meta.ui.csp` | 11260 |

## Cross-wiring checks (Phase-2 §III, 1–10)

| # | check | result | detail |
|---|---|---|---|
| 1 | tool resourceUri/outputTemplate exists in ListResources | ✅ pass | all 5 UI tools resolve |
| 2 | ui.resourceUri === openai/outputTemplate | ⚠️ FLAG | webaz_search: std=ui://widget/webaz-products-mcp.859d24466f.html vs openai=ui://widget/webaz-products.c4bd5e13bb.html; webaz_buyer_orders: std=ui://widget/webaz-order-timeline-mcp.af0f70edba.html vs openai=ui://widget/webaz-order-timeline.1422dd6d4b.html; webaz_quote_order: std=ui://widget/webaz-quote-approval-mcp.0d157bb047.html vs openai=ui://widget/webaz-quote-approval.4770e0569f.html; webaz_order_draft: std=ui://widget/webaz-quote-approval-mcp.0d157bb047.html vs openai=ui://widget/webaz-quote-approval.4770e0569f.html; webaz_submit_order_request: std=ui://widget/webaz-quote-approval-mcp.0d157bb047.html vs openai=ui://widget/webaz-quote-approval.4770e0569f.html |
| 3 | ListResources uri/mime === ReadResource contents[].uri/mime | ✅ pass | all 6 UI resources consistent |
| 4 | each component has BOTH a legacy(skybridge) + standard(mcp-app) variant, same component (no UNKNOWN) | ✅ pass | ProductResults=L1/S1 QuoteAndApproval=L1/S1 OrderTimeline=L1/S1 |
| 5 | no UNEXPECTED many-tools→one-resource (quote/draft/submit sharing QuoteAndApproval is BY DESIGN) | ✅ pass | webaz-quote-approval-mcp.0d157bb047.html ← {webaz_quote_order, webaz_order_draft, webaz_submit_order_request} |
| 6 | each URI maps to exactly one HTML body (no same-URI/two-bodies) | ✅ pass | webaz-products.c4bd5e13bb.html:16983B webaz-quote-approval.4770e0569f.html:11249B webaz-order-timeline.1422dd6d4b.html:8627B webaz-products-mcp.859d24466f.html:19616B webaz-quote-approval-mcp.0d157bb047.html:13882B webaz-order-timeline-mcp.af0f70edba.html:11260B |
| 7 | widget URIs are content-versioned (hash segment before .html — busts host cache on change) | ✅ pass | all 6 versioned (e.g. webaz-products.c4bd5e13bb.html) |
| 8 | no array-index / order-derived resource binding | ✅ pass | ReadResource dispatches by explicit `request.params.uri ===` / STANDARD_WIDGETS[uri] map — NOT by array index; ListResources is a static literal array. No index-derived binding. |
| 9 | quote/draft/submit bind to QuoteAndApproval (not to each other/product/timeline) | ✅ pass | quote→QuoteAndApproval \| draft→QuoteAndApproval \| submit→QuoteAndApproval |
| 10 | no duplicate resource URIs (cache-key collision) | ✅ pass | 6 distinct URIs |
| 11 | DIRECT_TOOL card tools are app-visible (widget calls them directly; quote_order app-visible after Phase-3A) | ✅ pass | search=app buyer_orders=app order_draft=app submit_order_request=app quote_order=app |
