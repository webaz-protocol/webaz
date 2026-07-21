/**
 * MCP UI PR-4..6 + PR-A — MCP App widgets(双轨:ChatGPT legacy skybridge + 标准 MCP Apps)。
 *
 * 纪律(spike 定稿 + PR-A):自包含单文件(宿主 CSP 内零外联);一切文本经 textContent(卖家可控标题,
 * 绝不 innerHTML);本地交互(展开/排序/选择/比较)零模型调用;跨 MCP 动作只走宿主桥且逐个能力探测,
 * 缺失即优雅降级为提示文案;经济动作(报价→草稿→提交)只提交审批请求,正式建单永远发生在
 * webaz.xyz 的 Passkey(widget 绝不直达钱路)。v1 无商品图(CSP deny-by-default,图片面另开任务)。
 *
 * PR-A 双轨(capability-driven,零 host 名判断):
 *   - legacy HTML(*.html,text/html+skybridge):window.openai 直连 —— 与 PR-4..6 生产行为一致,
 *     仅两处外科变更:①sendFollowUpCompat(sendFollowUpMessage 优先、sendFollowupTurn 降级、单发)
 *     ②openWebaz(URL 解析后 https + 精确主机 webaz.xyz + 默认端口 + 无 userinfo 才放行)。
 *   - standard HTML(*-mcp.html,text/html;profile=mcp-app):标准 ui/* postMessage JSON-RPC 桥
 *     (SEP-1865 spec 2026-01-26:ui/initialize 三步握手 → ui/notifications/tool-result 携带
 *     CallToolResult 渲染;tools/call / ui/open-link {url} / ui/message {role:'user',content});
 *     握手超时则降级 window.openai(覆盖"宿主用标准键指到本资源但只提供 openai 桥"的过渡态),
 *     两者皆无 → 只读渲染。单桥原则:握手成败一次定桥,绝不双桥同听。
 *   - 两个资源共享同一 render 体(同一份组件业务代码),只有 boot 不同。
 */

// ─── A1 widget sourcing:运行时 JS 字符串来自真实源码文件(widgets/src/*.ts,可 typecheck/lint/import 单测),
//     经 scripts/gen-widget-js.ts 确定性生成(字节级等于 pre-A1 字面量 —— 内容 hash 在 A1 不变)。 ───
import {
  WIDGET_THEME_JS, WIDGET_COMPAT_CORE_JS, WIDGET_COMPAT_LINK_JS, WIDGET_BOOT_LEGACY_JS,
  WIDGET_BRIDGE_STANDARD_JS, WIDGET_BOOT_STANDARD_JS,
  PRODUCT_RESULTS_BODY_JS, QUOTE_APPROVAL_BODY_JS, ORDER_TIMELINE_BODY_JS,
} from './widgets/widget-js.generated.js'
export { PRODUCT_RESULTS_BODY_JS, QUOTE_APPROVAL_BODY_JS, ORDER_TIMELINE_BODY_JS } from './widgets/widget-js.generated.js'

// ─── 共享主题 tokens(PR-0 深色修复)──────────────────────────────────────────────────────────
// 生产事故(2026-07-18 截图):ChatGPT 深色主题下 UA 把 form 控件按 color-scheme:dark 渲染成浅色字,
// 而我们只写了浅色背景没写字色 → 排序按钮白底白字不可见;.note/.meta 深灰字打在深色页面上不可辨。
// 修法:全部颜色 token 化 + 三层主题信号(prefers-color-scheme 媒体查询为默认;宿主可经
// window.openai.theme / 标准桥宿主上下文盖 data-theme,两方向都赢);按钮显式 color 永不依赖 UA。
const WIDGET_THEME_CSS = `
:root{color-scheme:light dark;
 --bg:#fff;--line:#d6dae2;--ink:#1c2330;--sub:#5b6472;--ok:#0a7d4f;--warn:#a15c00;--price:#0a7d4f;
 --chip-bg:#eef1f6;--chip-warn-bg:#fff3e0;--btn-bg:#f7f8fa;--btn-ink:#1c2330;
 --accent-bg:#eef2ff;--accent-line:#93a3f5;--accent-ink:#2b3a8f;
 --warnbox-bg:#fff7e0;--warnbox-line:#e5c268;--warnbox-ink:#7a5200;--row-ink:#374151}
@media (prefers-color-scheme: dark){:root{
 --bg:#1d232e;--line:#3a4150;--ink:#e8ebf0;--sub:#a3adbb;--ok:#4cc38a;--warn:#e0a458;--price:#4cc38a;
 --chip-bg:#2a3140;--chip-warn-bg:#3d3322;--btn-bg:#262d3a;--btn-ink:#e8ebf0;
 --accent-bg:#232b45;--accent-line:#5b6bd6;--accent-ink:#aab6ff;
 --warnbox-bg:#332b18;--warnbox-line:#6b5a2a;--warnbox-ink:#e5c268;--row-ink:#c6cdd8}}
:root[data-theme="dark"]{
 --bg:#1d232e;--line:#3a4150;--ink:#e8ebf0;--sub:#a3adbb;--ok:#4cc38a;--warn:#e0a458;--price:#4cc38a;
 --chip-bg:#2a3140;--chip-warn-bg:#3d3322;--btn-bg:#262d3a;--btn-ink:#e8ebf0;
 --accent-bg:#232b45;--accent-line:#5b6bd6;--accent-ink:#aab6ff;
 --warnbox-bg:#332b18;--warnbox-line:#6b5a2a;--warnbox-ink:#e5c268;--row-ink:#c6cdd8}
:root[data-theme="light"]{
 --bg:#fff;--line:#d6dae2;--ink:#1c2330;--sub:#5b6472;--ok:#0a7d4f;--warn:#a15c00;--price:#0a7d4f;
 --chip-bg:#eef1f6;--chip-warn-bg:#fff3e0;--btn-bg:#f7f8fa;--btn-ink:#1c2330;
 --accent-bg:#eef2ff;--accent-line:#93a3f5;--accent-ink:#2b3a8f;
 --warnbox-bg:#fff7e0;--warnbox-line:#e5c268;--warnbox-ink:#7a5200;--row-ink:#374151}
button{color:var(--btn-ink)}
`
// 宿主主题探测(能力探测,零 host 名):ChatGPT 暴露只读 window.openai.theme('light'|'dark')。

// ─── 共享运行时片段(注入两轨)────────────────────────────────────────────────────────────────

// compat 分两片按需注入:CORE(会话流兼容 + 防重)所有组件都要;LINK(deep-link 安全)只给有
// openExternal 面的组件 —— ProductResults 保持"零 URL/零 href 词元"的最强自包含锁不被稀释。
// openExternal 安全:仅放行 https + 精确主机 webaz.xyz + 默认端口 + 无 userinfo(URL 解析后逐字段
// 比较,拒 javascript:/data:/协议相对/用户名注入);deep link 只由调用点从服务端权威字段构造。

// legacy boot:与 PR-4..6 生产行为逐语义一致(window.openai 同步读 toolOutput)。

// standard boot:SEP-1865 ui/* 桥。握手成功 → 标准 facade(oai 形状兼容 render 体);
// 超时/失败 → window.openai;再无 → 只读(空 facade,能力探测全 false)。

function buildWidgetHtml(opts: { style: string; loading: string; bodyJs: string; standard: boolean; link: boolean }): string {
  const compat = WIDGET_COMPAT_CORE_JS + (opts.link ? WIDGET_COMPAT_LINK_JS : '')
  const bridge = opts.standard ? WIDGET_BRIDGE_STANDARD_JS : ''
  const boot = opts.standard ? WIDGET_BOOT_STANDARD_JS : WIDGET_BOOT_LEGACY_JS
  return `<!doctype html><html><head><meta charset="utf-8"><style>${WIDGET_THEME_CSS}${opts.style}</style></head><body>
<div id="root">${opts.loading}</div>
<script>
(function(){
  'use strict'
${WIDGET_THEME_JS}
${compat}
${bridge}
${opts.bodyJs}
${boot}
})();
</script></body></html>`
}

// ─── ProductResults ───────────────────────────────────────────────────────────────────────────
// 渲染 webaz_search 的三种 structuredContent 形态:①搜索/浏览页(webaz.product_search.model.v1:
// products+sellers+next_cursor+result_handle)②0 命中(found:0 + recovery.catalog_sample)
// ③按需详情(webaz.product_detail.model.v1)。

const PRODUCT_RESULTS_STYLE = `
body{font-family:system-ui,sans-serif;margin:0;padding:10px;color:var(--ink);background:transparent}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.bar button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.bar button.on{background:var(--accent-bg);border-color:var(--accent-line);color:var(--accent-ink)}
.grid{display:flex;gap:10px;flex-wrap:wrap}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;width:210px;background:var(--bg);display:flex;flex-direction:column;gap:6px}
.card.rec{border:2px solid #4f46e5;box-shadow:0 0 0 1px #4f46e5}
.recbadge{align-self:flex-start;font-size:10px;font-weight:600;color:#fff;background:#4f46e5;border-radius:6px;padding:1px 7px}
.recreason{font-size:11px;color:var(--ink);line-height:1.5}
.card b{font-size:13px;line-height:1.35;display:block;min-height:2.6em}
.price{color:var(--price);font-weight:700;font-size:15px}
.chips{display:flex;gap:4px;flex-wrap:wrap}
.chip{font-size:10px;border-radius:6px;padding:1px 6px;background:var(--chip-bg);color:var(--sub)}
.chip.warn{background:var(--chip-warn-bg);color:var(--warn)}
.meta{font-size:11px;color:var(--sub)}
.card .more{font-size:11px;color:var(--sub);display:none;border-top:1px dashed var(--line);padding-top:6px}
.card.open .more{display:block}
.row{display:flex;gap:6px;margin-top:auto}
.row button{flex:1;border:1px solid var(--line);background:var(--btn-bg);color:var(--btn-ink);border-radius:8px;padding:4px 6px;font-size:11px;cursor:pointer}
.row button.primary{background:#4f46e5;color:#fff;border-color:transparent;font-weight:600}
.row button:disabled{opacity:.6;cursor:default}
.cmp{margin-top:12px;border-top:1px solid var(--line);padding-top:8px;font-size:12px;display:none}
.cmp table{border-collapse:collapse;width:100%}
.cmp td,.cmp th{border:1px solid var(--line);padding:3px 6px;text-align:left;font-size:11px}
.hint{margin-top:10px;font-size:12px;color:var(--warnbox-ink);background:var(--warnbox-bg);border:1px solid var(--warnbox-line);border-radius:10px;padding:8px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;line-height:1.5}
button.mini{border:1px solid var(--accent-line);background:var(--accent-bg);color:var(--accent-ink);border-radius:8px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
.note{font-size:11px;color:var(--sub);margin-top:10px}`


// ─── QuoteAndApproval ─────────────────────────────────────────────────────────────────────────
// 渲染 quote / draft / approval 三形态(webaz.order_quote|order_draft|order_approval .model — v1 旧卡 + BUG-06 v2 均兼容)。
// 创建草稿与提交审批 = callTool(不扣款/不锁库存/幂等 + 重复购买保护);正式建单只发生在 webaz.xyz
// 的 Passkey 批准。duplicate_warning 渲染为显式警告卡,绝不静默二次创建。

const QUOTE_APPROVAL_STYLE = `
body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:var(--ink);background:transparent}
.box{border:1px solid var(--line);border-radius:12px;padding:14px 16px;max-width:420px;background:var(--bg)}
.h{font-size:14px;font-weight:700;margin-bottom:8px}
.price{color:var(--price);font-weight:800;font-size:20px}
.fiat{color:var(--sub);font-size:13px}
.row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;color:var(--row-ink)}
.sec{border-top:1px dashed var(--line);margin-top:8px;padding-top:8px}
.meta{font-size:11px;color:var(--sub)}
.warn{background:var(--warnbox-bg);border:1px solid var(--warnbox-line);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--warnbox-ink);margin-top:10px}
.btn{display:block;width:100%;margin-top:10px;border:1px solid var(--accent-line);background:var(--accent-bg);border-radius:10px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;color:var(--accent-ink)}
.toggle{font-size:11px;color:var(--sub);cursor:pointer;text-decoration:underline;margin-top:6px;display:inline-block}
.hide{display:none}
.disc{font-size:11px;color:var(--warnbox-ink);margin-top:10px;line-height:1.5}
.ok{color:var(--ok)}`


// ─── OrderTimeline ────────────────────────────────────────────────────────────────────────────
// 渲染 webaz.order_timeline.model.v1(单订单履约时间线)与 webaz.order_status.model.v1(列表/最小单/
// up_to_date)。deadline 在组件端按【观看者本地时区】渲染;刷新走 callTool;联系商家回会话流(上下文
// 绑定订单聊天,无自由私信;无订单上下文不启用);高风险动作回订单页。

const ORDER_TIMELINE_STYLE = `
body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:var(--ink);background:transparent}
.box{border:1px solid var(--line);border-radius:12px;padding:14px 16px;max-width:430px;background:var(--bg)}
.h{font-size:14px;font-weight:700;margin-bottom:4px}
.price{color:var(--price);font-weight:800;font-size:18px}
.fiat{color:var(--sub);font-size:12px}
.badge{display:inline-block;font-size:10px;border-radius:99px;padding:2px 8px;background:var(--chip-warn-bg);color:var(--warn);margin:6px 0}
.st{font-size:13px;font-weight:700;color:var(--accent-ink)}
.row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;color:var(--row-ink)}
.tl{border-left:2px solid var(--line);margin:10px 0 4px 6px;padding-left:12px}
.tl div{font-size:11px;color:var(--sub);padding:3px 0;position:relative}
.tl div:before{content:'';position:absolute;left:-17px;top:8px;width:8px;height:8px;border-radius:99px;background:var(--accent-line)}
.warn{background:var(--warnbox-bg);border:1px solid var(--warnbox-line);border-radius:10px;padding:8px 10px;font-size:11px;color:var(--warnbox-ink);margin-top:8px}
.rowbtn{display:flex;gap:6px;margin-top:10px}
.rowbtn button{flex:1;border:1px solid var(--accent-line);background:var(--accent-bg);border-radius:10px;padding:6px;font-size:12px;font-weight:600;cursor:pointer;color:var(--accent-ink)}
.meta{font-size:11px;color:var(--sub)}
.chatpanel{margin-top:10px;border-top:1px dashed var(--line);padding-top:8px}
.chatmsgs{max-height:160px;overflow-y:auto;font-size:12px;color:var(--row-ink)}
.chatinput{width:100%;box-sizing:border-box;margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:6px;font-size:12px;background:var(--bg);color:var(--ink)}
.chatpanel .btn{display:block;width:100%;margin-top:8px;border:1px solid var(--accent-line);background:var(--accent-bg);border-radius:10px;padding:6px;font-size:12px;font-weight:600;cursor:pointer;color:var(--accent-ink)}`


// ─── 导出:每组件 legacy(skybridge)+ standard(profile=mcp-app)双 HTML,共享同一 render 体 ──

export const PRODUCT_RESULTS_WIDGET_HTML = buildWidgetHtml({ style: PRODUCT_RESULTS_STYLE, loading: 'WebAZ ProductResults — loading…', bodyJs: PRODUCT_RESULTS_BODY_JS, standard: false, link: false })
export const PRODUCT_RESULTS_WIDGET_MCP_HTML = buildWidgetHtml({ style: PRODUCT_RESULTS_STYLE, loading: 'WebAZ ProductResults — loading…', bodyJs: PRODUCT_RESULTS_BODY_JS, standard: true, link: false })

export const QUOTE_APPROVAL_WIDGET_HTML = buildWidgetHtml({ style: QUOTE_APPROVAL_STYLE, loading: 'WebAZ QuoteAndApproval — loading…', bodyJs: QUOTE_APPROVAL_BODY_JS, standard: false, link: true })
export const QUOTE_APPROVAL_WIDGET_MCP_HTML = buildWidgetHtml({ style: QUOTE_APPROVAL_STYLE, loading: 'WebAZ QuoteAndApproval — loading…', bodyJs: QUOTE_APPROVAL_BODY_JS, standard: true, link: true })

export const ORDER_TIMELINE_WIDGET_HTML = buildWidgetHtml({ style: ORDER_TIMELINE_STYLE, loading: 'WebAZ OrderTimeline — loading…', bodyJs: ORDER_TIMELINE_BODY_JS, standard: false, link: true })
export const ORDER_TIMELINE_WIDGET_MCP_HTML = buildWidgetHtml({ style: ORDER_TIMELINE_STYLE, loading: 'WebAZ OrderTimeline — loading…', bodyJs: ORDER_TIMELINE_BODY_JS, standard: true, link: true })

// 测试专用导出(scripts/test-mcp-apps-standard.ts 在 node:vm 里驱动真实桥逻辑)—— 非运行时 API。
export const __WIDGET_COMPAT_JS = WIDGET_COMPAT_CORE_JS + WIDGET_COMPAT_LINK_JS
export const __WIDGET_BRIDGE_STANDARD_JS = WIDGET_BRIDGE_STANDARD_JS
export const __WIDGET_BOOT_STANDARD_JS = WIDGET_BOOT_STANDARD_JS
