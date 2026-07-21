# Phase 3B Round-1b — Retest Results (2026-07-21)

> Live production retest on `webaz.xyz`, deployment `e5faeb2c-0169-4d74-8070-c89e8b5e1350`
> (tag `phase3b-round1b-ui-green-5e0dd5d`, commit `5e0dd5d`, now == `main` via PR #471 merge `67cf028`).
> Real ChatGPT Pro host (Developer-mode connector, OAuth), quote + UI only — **no Passkey, no order created**.
> Rollback targets unchanged: near `ce2706f5`, long-term `5daf7d25`.

## Money safety — quote testing changed nothing but quotes

| Metric | BEFORE | AFTER | Δ |
|---|---|---|---|
| orders | 44 | 44 | 0 ✓ |
| order_quotes | 32 | **34** | **+2** (expected: 1 first click + 1 from triple-click burst) |
| order_drafts | 15 | 15 | 0 ✓ |
| agent_permission_requests | 13 | 13 | 0 ✓ |
| Tina wallet balance | 905.18 | 905.18 | 0 ✓ |
| Tina orders | 42 | 42 | 0 ✓ |

Both new quotes: same product `prd_575a5f…`, same `intent_hash a976558a…` (idempotent intent, none consumed).

## Findings status

### B-2 stale-template migration — **root cause reproduced live, then cleared; final acceptance still pending on the A1 deploy**
- New conversation BEFORE any connector refresh → card failed with **「加载应用时出错 / Failed to fetch template」**, retry ineffective.
  Server-side proof: live `tools/list` advertises bare `ui://widget/webaz-products.html` (resolves, 23KB), while the connector's
  cached versioned URI (`webaz-products.c4bd5e13bb.html`, cached at its 2026-07-19 connect — **before** the 07-21 03:30Z round1b
  deploy) now returns `未知资源`.
- **Operational discovery:** ChatGPT settings → 插件 → webaz → **「刷新」** is sufficient to clear the stale cache — no
  delete/re-add, no re-OAuth. After one refresh, a new conversation rendered the card perfectly.
- Status: **migration completed / final acceptance pending** — close condition unchanged: after the NEXT widget-content deploy
  (PR A1), old and new conversations must load cards with **no reconnect and no manual refresh**.
- Hardening queued into PR A1: server-side alias `ui://widget/<name>.<any-stale-hash>.html` → serve current content (unknown
  version falls back instead of 404), so stale caches can never re-create this failure class.

### F4 (one-click quote echo + single-flight) — **PASS**
- 准备下单 ×1 → in-card quote panel within ~2s: 「✓ 已获取报价 … 19.90 USDC · 预计送达 约12天 · 到期 …」 + 复制继续 key
  + honest footer (报价不扣款 · 正式建单需 Passkey). No permanent 「正在获取报价…」 freeze.
- Rapid triple-click → panel updated **once**; server gained exactly **1** quote for the burst (34 total, not 37). Single-flight holds.

### B-1 (ETA JSON-string) — **PASS → CLOSED**
- Quote panel renders 预计送达 **「约12天」**; model narrative also 约12天. No raw region-map JSON, no `[object Object]`
  anywhere in the conversation or the 5.8KB card payload (greppped live).

### B-4 (copy fallback) — **PASS → CLOSED**
- In-card 复制 button → label became **「已复制✓」** (Clipboard/execCommand tier succeeded). The old dead-end
  「复制失败,请手选」 no longer occurs; auto-select tier remains as last resort.

### B-3 (internal-field excise) — **CLOSED (re-confirmed today)**
- Last week: deployed `projectProductDetail` run against real `prd_575a5f` raw specs → FULL_LEAK=[] SUMMARY_LEAK=[].
- Today: live card payload for the 6-product search greppped for
  `agent_source_evidence / agent_package_evidence / source_url / purchase_* / cost_* / 采购/货源 terms` → **NONE**.

### F5 (card count vs narrative) — **PASS**
- Card label: 「精确匹配 · 本卡展示 5 款 —— 模型文字里的"找到/推荐 N 款"可能来自更广候选集,以本卡商品为准」.
- Model text said 展示 5 款; card showed 5 (default limit 5 of 6 matches; 下一页 present). Consistent.

## Discovery-layer data fix (Direction B) — deployed to production data, verified
- Root cause refined: the 6 tissue products already sit on canonical category 「家庭清洁/纸品」; the real gap was an **empty
  `product_aliases` table** — strict search could only match exact-full-title equality.
- Fix: **18 alias rows inserted** (ids `pal_fixb_*`; per product: title_substring 「悬挂式底部抽纸」 + brand externals
  「豪势底部抽纸」「豪势悬挂式底部抽纸」/「心相印底部抽纸」「心相印悬挂式底部抽纸」). No product/category/money fields touched;
  `category_id` (margin tier) untouched. Snapshot saved pre-change; rollback =
  `DELETE FROM product_aliases WHERE id LIKE 'pal_fixb_%'`.
- Acceptance (live, anonymous agent mode): 「悬挂式底部抽纸」→6 · 「豪势底部抽纸」→2 (豪势 only) · 「心相印底部抽纸」→4 ·
  exact full title→6 (family incl. the exact item) · 「锅盖架」/unrelated→0 · 0-hit recovery still guides to webaz_discover ·
  category equality 「家庭清洁/纸品」→6. Real-ChatGPT confirmation: the natural query rendered the 5-card grid this round.
- Note: exact-full-title query now returns the whole 6-item family (alias containment); exact item is included. Exact-first
  ranking would be a strict-semantics code change — deliberately NOT done this round.

## New findings this round
- **R2-1 (medium):** 商品卡「详情」按钮的就地回渲未发生 — sync fail-visible hint (correct) stayed at 「正在载入详情…」;
  the result_handle `callTool` result never replaced the card. Copy-phrase path works. Candidate: consume/route fix in A1/A2.
- **R2-2 (low):** quote panel 到期 time renders raw ISO (`2026-07-21T05:31:51.232Z`) — goes into PR A2 `display_*` scope.
- **R2-3 (cosmetic):** 「库存少」 badge renders twice on the low-stock card.

## Verdict
Round-1b objectives met on live ChatGPT: search→card→quote chain is now zero-typing up to the quote, honest, single-flight,
leak-free, and money-silent. Remaining UX gaps are R2-1/R2-2 (assigned to A1/A2) and the B-2 no-reconnect final acceptance
(gated on the A1 deploy).
