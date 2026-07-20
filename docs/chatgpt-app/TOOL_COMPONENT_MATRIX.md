# TOOL_COMPONENT_MATRIX

> **Code-generated** by `scripts/diagnose-mcp-card-matrix.ts` from the live `buildMcpServer({surface:'full'})`. Do not hand-edit.
> 55 tools total; 5 declare a UI template. "annR" = RO(readOnly)/W(write)/D(destructive)/OW(openWorld). Handler/structuredContent/_meta runtime shape is verified separately by the contract tests (see TOOL_OUTPUT_CONTRACT_AUDIT.md) — this table is registration-truth only.

## UI-bearing tools (the card surface)

| tool | annR | securitySchemes | outputSchema | schema_version(s) | _meta.ui.resourceUri | openai/outputTemplate | widgetAccessible | visibility | bound component | exists |
|---|---|---|---|---|---|---|---|---|---|---|
| `webaz_search` | RO/OW | — | ✅ | webaz.product_search.model.v1 \| webaz.product_detail.model.v1 | `ui://widget/webaz-products-mcp.html` | `ui://widget/webaz-products.html` | true | model,app | ProductResults | ✅ |
| `webaz_buyer_orders` | RO/OW | — | ✅ | webaz.order_status.model.v1 \| webaz.order_timeline.model.v1 | `ui://widget/webaz-order-timeline-mcp.html` | `ui://widget/webaz-order-timeline.html` | true | model,app | OrderTimeline | ✅ |
| `webaz_quote_order` | W/OW | — | ✅ | webaz.order_quote.model.v1 | `ui://widget/webaz-quote-approval-mcp.html` | `ui://widget/webaz-quote-approval.html` | — | model | QuoteAndApproval | ✅ |
| `webaz_order_draft` | W/D/OW | — | ✅ | webaz.order_draft.model.v1 | `ui://widget/webaz-quote-approval-mcp.html` | `ui://widget/webaz-quote-approval.html` | true | model,app | QuoteAndApproval | ✅ |
| `webaz_submit_order_request` | W/OW | — | ✅ | webaz.order_approval.model.v1 | `ui://widget/webaz-quote-approval-mcp.html` | `ui://widget/webaz-quote-approval.html` | true | model,app | QuoteAndApproval | ✅ |

## All tools — output-schema / annotation / security summary (55)

| tool | annR | securitySchemes | outputSchema | schema_version(s) | UI template? |
|---|---|---|---|---|---|
| `webaz_info` | RO | — | — |  | — |
| `webaz_pair` | W/OW | — | — |  | — |
| `webaz_register` | W/OW | — | — |  | — |
| `webaz_search` | RO/OW | — | ✅ | webaz.product_search.model.v1 \| webaz.product_detail.model.v1 | ✅ |
| `webaz_verify_price` | W/OW | — | — |  | — |
| `webaz_list_product` | W/D/OW | — | — |  | — |
| `webaz_upload_product_image` | W/D | — | — |  | — |
| `webaz_place_order` | W/D/OW | — | — |  | — |
| `webaz_update_order` | W/D/OW | — | — |  | — |
| `webaz_get_status` | RO/OW | — | — |  | — |
| `webaz_wallet` | RO | — | — |  | — |
| `webaz_notifications` | W/D | — | — |  | — |
| `webaz_dispute` | W/D/OW | — | — |  | — |
| `webaz_claim_verify` | W/D/OW | — | — |  | — |
| `webaz_skill` | W/D/OW | — | — |  | — |
| `webaz_mykey` | RO | — | — |  | — |
| `webaz_profile` | W/D/OW | — | — |  | — |
| `webaz_revoke_key` | RO | — | — |  | — |
| `webaz_rotate_key` | RO | — | — |  | — |
| `webaz_referral` | RO/OW | — | — |  | — |
| `webaz_share_link` | RO/OW | — | — |  | — |
| `webaz_blocklist` | W/D/OW | — | — |  | — |
| `webaz_follows` | W/D/OW | — | — |  | — |
| `webaz_nearby` | W/D/OW | — | — |  | — |
| `webaz_default_address` | W/D | — | — |  | — |
| `webaz_shareables` | W/D/OW | — | — |  | — |
| `webaz_rfq` | W/D/OW | — | — |  | — |
| `webaz_bid` | W/D/OW | — | — |  | — |
| `webaz_chat` | W/D/OW | — | — |  | — |
| `webaz_price_history` | RO/OW | — | — |  | — |
| `webaz_charity` | W/D/OW | — | — |  | — |
| `webaz_p2p_product` | W/D/OW | — | — |  | — |
| `webaz_like` | W/D/OW | — | — |  | — |
| `webaz_leaderboard` | RO/OW | — | — |  | — |
| `webaz_auction` | W/D/OW | — | — |  | — |
| `webaz_auto_bid` | W/D/OW | — | — |  | — |
| `webaz_skill_market` | W/D/OW | — | — |  | — |
| `webaz_secondhand` | W/D/OW | — | — |  | — |
| `webaz_trial` | W/D/OW | — | — |  | — |
| `webaz_feedback` | W/OW | — | — |  | — |
| `webaz_contribute` | W/D/OW | — | — |  | — |
| `webaz_get_agent_order` | RO/OW | — | — |  | — |
| `webaz_order_action_request` | W/OW | — | — |  | — |
| `webaz_connection_status` | RO | — | — |  | — |
| `webaz_buyer_orders` | RO/OW | — | ✅ | webaz.order_status.model.v1 \| webaz.order_timeline.model.v1 | ✅ |
| `webaz_discover` | W/OW | — | — |  | — |
| `webaz_quote_order` | W/OW | — | ✅ | webaz.order_quote.model.v1 | ✅ |
| `webaz_order_draft` | W/D/OW | — | ✅ | webaz.order_draft.model.v1 | ✅ |
| `webaz_submit_order_request` | W/OW | — | ✅ | webaz.order_approval.model.v1 | ✅ |
| `webaz_prepare_case` | RO/OW | — | — |  | — |
| `webaz_approval_requests` | RO | — | — |  | — |
| `webaz_buyer_action_request` | W/OW | — | — |  | — |
| `webaz_address` | W | — | — |  | — |
| `webaz_order_chat` | W/OW | — | — |  | — |
| `webaz_wallet_view` | RO | — | — |  | — |

## Notable

- Tools WITH outputSchema but NO UI template: (none)
- UI-template tools WITHOUT an outputSchema: (none)
