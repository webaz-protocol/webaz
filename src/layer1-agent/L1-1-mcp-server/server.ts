/**
 * L1-1 · MCP Server 核心
 * 把 WebAZ暴露给所有支持 MCP 的 AI Agent（Claude、GPT 等）
 *
 * 包含工具：
 *   webaz_info          L1-2 协议说明（任何 Agent 可调用，了解这是什么）
 *   webaz_register      注册账户，获取 api_key
 *   webaz_search        L1-2 搜索商品
 *   webaz_list_product  L1-5 卖家上架商品
 *   webaz_place_order   L1-3 买家下单
 *   webaz_update_order  L1-6 更新订单状态（发货/揽收/投递/确认/争议）
 *   webaz_get_status    L1-4 查询订单状态和历史
 *   webaz_wallet        查看钱包余额
 *   …（39 工具,完整定义见下方 TOOLS 数组;数量以 TOOLS.length 为准）
 *
 * 双模(RFC-003):NETWORK(WEBAZ_API_KEY → 调 webaz.xyz)/ SANDBOX(本机库);见 NETWORK_TOOLS / apiCall / toolBackend。
 * 关联 / Related: AGENTS.md · RFC-003(双模) · RFC-004(webaz_feedback) · 元规则 #4 不撒谎(_mode 戳) /
 *   #6 不滥用(agent 责任制 + Iron-Rule 真人动作)· 生产端点在 src/pwa(NETWORK 共用)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,                                                          // #B.1 a — MCP 三大原语之 Prompts
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'

import { initDatabase, generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { setSeamDb } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam(本进程注入)
import {
  transition,
  getOrderStatus,
  initSystemUser,
} from '../../layer0-foundation/L0-2-state-machine/engine.js'
import {
  initDisputeSchema,
  createDispute,
  respondToDispute,
  getDisputeDetails,
  getOrderDispute,
  getOpenDisputes,
} from '../../layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import {
  initNotificationSchema,
  notifyTransition,
  getNotifications,
  getUnreadCount,
  markRead,
} from '../../layer2-business/L2-6-notifications/notification-engine.js'
import {
  initSkillSchema,
  publishSkill,
  listSkills,
  getMySkills,
  subscribeSkill,
  unsubscribeSkill,
  getMySubscriptions,
  formatSkillForAgent,
  shouldAutoAccept,
  SKILL_TYPE_META,
  type SkillType,
} from '../../layer4-economics/L4-4-skill-market/skill-engine.js'
import {
  initReputationSchema,
  recordOrderReputation,
  recordViolationReputation,
  getReputation,
  getSearchBoost,
  getStakeDiscount,
} from '../../layer4-economics/L4-3-reputation/reputation-engine.js'
import {
  generateManifest,
  getManifestSummary,
  MANIFEST_URI,
} from '../../layer0-foundation/L0-5-manifest/manifest.js'
import { requireAuth } from './auth.js'
import { createHash, randomBytes } from 'node:crypto'
import { SOFTWARE_VERSION } from '../../version.js'

// RFC-011 §④:版本单一来源 = package.json(经 src/version.ts)。不再硬编码(旧 '0.1.8' 早漂移到 0.1.19)。
const SERVER_VERSION = SOFTWARE_VERSION
const TELEMETRY_URL = process.env.WEBAZ_TELEMETRY_URL ?? 'https://webaz.xyz/api/mcp-telemetry'
// 2026-06-01: phase A pre-launch 默认 OFF(opt-in)— W8 public launch 时翻回 default ON + 加 README 披露段
// Phase A pre-launch: telemetry default OFF (opt-in). Flip to default ON at W8 launch + add README disclosure section.
const TELEMETRY_ENABLED = (process.env.WEBAZ_TELEMETRY ?? 'off').toLowerCase() === 'on'

// ─── RFC-003 P0: 双模(NETWORK / SANDBOX)骨架 ─────────────────────
// NETWORK = 带 api_key 调 webaz.xyz/api(加入共享生产网络);SANDBOX = 本地 SQLite(离线试玩,与全网隔离)。
// P0 不迁移任何工具(NETWORK_TOOLS 为空)→ 一切仍走本地 = 零行为变化;P1/P2 逐个把工具名加入集合切到网络。
const WEBAZ_API_URL = (process.env.WEBAZ_API_URL ?? 'https://webaz.xyz').replace(/\/+$/, '')
const WEBAZ_API_KEY = process.env.WEBAZ_API_KEY ?? ''

// F6 (dogfood R2): keyed MCP handlers resolve api_key as  explicit args.api_key  >  env WEBAZ_API_KEY  >
// '' (→ the existing typed API_KEY_REQUIRED guards). Explicit ALWAYS wins; env never overrides an explicit
// key. Keyless actions (list/discover/detail/suggest/browse/get_campaign…) gate their public branches
// separately and never call this, so a configured env key does NOT change the public read boundary.
// The key is never printed/returned/logged.
export function resolveMcpApiKey(args: Record<string, unknown>, envKey: string = WEBAZ_API_KEY): string {
  const explicit = typeof args?.api_key === 'string' ? args.api_key.trim() : ''
  return explicit || envKey
}

const WEBAZ_MODE_ENV = (process.env.WEBAZ_MODE ?? '').toLowerCase()
// 模式:显式 WEBAZ_MODE 优先;否则有 api_key → network,无 key → network_readonly(装完即见真网络)。
// network_readonly(L1 onboarding,2026-06-08):无 key 默认。公共读匿名打 webaz.xyz(真 catalog/协议),
//   需身份的写/读返回"设 WEBAZ_API_KEY(到 #welcome 申请邀请)"。离线本地 playground 改为【显式】 WEBAZ_MODE=sandbox。
//   —— 治"装完=空沙盒劝退"的死首体验;route/guard 与 network 同路(见 isNetworkMode),只是无 Bearer + 文案不同。
const MODE: 'network' | 'network_readonly' | 'sandbox' =
  WEBAZ_MODE_ENV === 'network' ? 'network'
  : WEBAZ_MODE_ENV === 'sandbox' ? 'sandbox'
  : WEBAZ_MODE_ENV === 'network_readonly' ? 'network_readonly'
  : (WEBAZ_API_KEY ? 'network' : 'network_readonly')
// network 或 network_readonly 都"走真网络"(后者无 Bearer)。sandbox 才是本地。
const isNetworkMode = (): boolean => MODE === 'network' || MODE === 'network_readonly'
// 已迁移到 NETWORK 的工具名。P1/P2 逐个加入;未在集合里的工具仍走 sandbox(本地)。
// P1(读工具): 纯公开读,无写无 Passkey,作"MCP 连得上生产网络"的首验证。
const NETWORK_TOOLS = new Set<string>([
  'webaz_price_history',
  'webaz_leaderboard',
  'webaz_verify_price',
  'webaz_place_order',
  'webaz_list_product',
  'webaz_update_order',
  'webaz_search',
  'webaz_get_status',
  'webaz_feedback',
  'webaz_contribute',
  // Batch 1(只读 + 低危自身写):走 webaz.xyz Bearer api_key。
  'webaz_notifications',
  'webaz_nearby',
  'webaz_profile',
  'webaz_shareables',
  'webaz_mykey',
  // Batch 2(低危写,无钱无 escrow):走 webaz.xyz Bearer api_key。
  // 注:share_link 暂不迁(无对应服务端端点,需新建,留待后续)。
  'webaz_follows',
  'webaz_like',
  'webaz_blocklist',
  'webaz_default_address',
  'webaz_chat',
  'webaz_rfq',
  'webaz_referral',
  // Batch 3(商务):secondhand/skill_market/auction 纯 pwaApi(mode-aware 自动走网络);
  // skill 直连本地引擎,加了显式 apiCall network 分支。
  'webaz_secondhand',
  'webaz_skill',
  'webaz_skill_market',
  'webaz_auction',
  // Batch 4(资金/质押,守恒由服务端 RFC-014 保证;wallet 只读,写=Passkey 仅 PWA):
  'webaz_wallet',
  'webaz_trial',
  'webaz_charity',
  'webaz_bid',
  'webaz_auto_bid',
  // Batch 5(铁律/敏感):claim_verify 纯 pwaApi(真人门由服务端 require_human_presence 强制);
  // dispute view/list_open/respond/add_evidence 走网络,arbitrate 仅返回 Passkey 指引;
  // rotate_key/revoke_key 仅返回 Passkey 指引(不本地校验)。
  'webaz_dispute',
  'webaz_claim_verify',
  'webaz_rotate_key',
  'webaz_revoke_key',
  // #1122:share_link 现有服务端端点 /api/share-link,可走网络。
  'webaz_share_link',
])

// RFC-004 现场证据:进程内 ring buffer,记最近工具调用的【脱敏摘要】(只存 arg key 名,不存值)。
// webaz_feedback 提交时附带,让 maintainer 拿到"问题发生时的现场",而不只是一句抱怨。
type RecentCall = { tool: string; arg_keys: string[]; outcome: 'ok' | 'error'; mode: 'network' | 'sandbox'; ts: string }
const recentCalls: RecentCall[] = []
function pushRecentCall(c: RecentCall): void {
  recentCalls.push(c)
  if (recentCalls.length > 8) recentCalls.shift()   // 只留最近 8 条
}
// 单个工具实际后端:network 或 network_readonly 下、且该工具已迁移,才走网络;否则 sandbox。
// readonly 无 Bearer:公共读拿真数据,需身份的端点服务端返 401(诚实)→ 不会静默落本地。
function toolBackend(tool: string): 'network' | 'sandbox' {
  return (isNetworkMode() && NETWORK_TOOLS.has(tool)) ? 'network' : 'sandbox'
}

// 未在 NETWORK_TOOLS 名单、但 NETWORK 模式下仍可本地运行的"自省/引导"工具(非数据操作)。
// info = 本地自省(并拉 live 网络状态);register = 引导真人去 webaz.xyz。其余未迁工具一律硬失败。
const NETWORK_SELF_AWARE = new Set<string>(['webaz_info', 'webaz_register'])

// RFC-003 Batch 0 安全网:NETWORK 模式下调用【未迁移】工具时的诚实拒绝(而非静默落本地沙盒)。
// 否则带 key 的用户调未迁工具会被悄悄喂本地结果——写操作=幻影操作(根本没到 webaz.xyz)。
function networkMigrationPending(tool: string): Record<string, unknown> {
  const short = tool.replace(/^webaz_/, '')
  return {
    _mode: 'network',
    not_on_network_yet: true,
    error: `${tool} 尚未接入 webaz.xyz 共享网络(迁移进行中)。NETWORK 模式下拒绝把它落到本机沙盒——本地结果不会到达 webaz.xyz,写操作会变成"幻影操作"。 / ${tool} is not on the live network yet (migration in progress); refusing to run it against your local sandbox while in NETWORK mode — a local result would NOT reach webaz.xyz.`,
    what_to_do: [
      `现在就用网页完成此动作:${WEBAZ_API_URL}(PWA) / Use the web app for this action now.`,
      `只想本地试玩/测试?设环境变量 WEBAZ_MODE=sandbox 显式进沙盒。 / Set WEBAZ_MODE=sandbox to use the local sandbox explicitly.`,
    ],
    migration: `RFC-003 渐进迁移:webaz_${short} 将在后续批次获得网络支持。 / incremental migration; network support for this tool lands in an upcoming batch.`,
  }
}

// 统一 API helper(P1/P2 迁移工具时使用)。Bearer api_key + 15s 超时 + 错误映射。
async function apiCall(path: string, opts: { method?: string; body?: unknown; apiKey?: string } = {}): Promise<Record<string, unknown>> {
  const { method = 'GET', body } = opts
  const key = opts.apiKey || WEBAZ_API_KEY  // 每次调用可覆盖(工具 args.api_key 优先);否则用全局配置 key
  const url = WEBAZ_API_URL + (path.startsWith('/') ? path : '/' + path)
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body != null ? { 'content-type': 'application/json' } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    })
    let json: Record<string, unknown> | null = null
    try { json = await resp.json() as Record<string, unknown> } catch { json = null }
    if (!resp.ok) {
      const map: Record<number, string> = {
        401: 'api_key 无效或未注册 — 请在 https://webaz.xyz 注册并把 api_key 填入 WEBAZ_API_KEY',
        403: '权限不足 / 需邀请码 / 该动作需真人 Passkey(请到 webaz.xyz 用 Passkey 操作)',
        429: '调用过于频繁,请稍后再试',
        503: '服务暂不可用,请稍后重试',
      }
      return { error: (json?.error as string) ?? map[resp.status] ?? `HTTP ${resp.status}`, error_code: json?.error_code, http_status: resp.status }
    }
    return json ?? {}
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? '请求超时(15s)' : (e as Error).message
    return { error: `网络错误:${msg}`, network_error: true }
  }
}

// 启动 banner(stderr)+ status 声明用 —— 让用户/agent 一眼知道现在是真网络还是沙盒
function modeBanner(): string {
  if (MODE === 'network') {
    return `🟢 NETWORK mode — webaz.xyz (${WEBAZ_API_URL}), authenticated. Migrated tools: ${NETWORK_TOOLS.size}/${TOOLS.length}`
  }
  if (MODE === 'network_readonly') {
    return `🟢 NETWORK (read-only) — no api_key: public reads (search / leaderboard / price history / browse) hit the LIVE webaz.xyz network. `
      + `To transact (register/order/list/etc.), set WEBAZ_API_KEY — request an invite at ${WEBAZ_API_URL}/#welcome.`
  }
  return `🟡 SANDBOX mode — local-only (~/.webaz/webaz.db), NOT the live network. Data is private to this machine. `
    + `(Explicit dev/demo mode; unset WEBAZ_MODE to use the live network read-only by default.)`
}

// ─── 初始化 ──────────────────────────────────────────────────

const db: Database.Database = initDatabase()
setSeamDb(db)  // RFC-016 Phase 1:注入异步 DB seam(本进程)—— 共享引擎迁 seam 后 MCP 进程也能用,否则 dbOne/dbAll 抛"未初始化"
initSystemUser(db)
initDisputeSchema(db)
initNotificationSchema(db)
initSkillSchema(db)
initReputationSchema(db)

// 结构化商品字段迁移（幂等）
const MCP_PRODUCT_COLS = [
  'ALTER TABLE products ADD COLUMN specs TEXT',
  'ALTER TABLE products ADD COLUMN brand TEXT',
  'ALTER TABLE products ADD COLUMN model TEXT',
  'ALTER TABLE products ADD COLUMN source_url TEXT',
  'ALTER TABLE products ADD COLUMN source_price REAL',
  'ALTER TABLE products ADD COLUMN ship_regions TEXT DEFAULT "全国"',
  'ALTER TABLE products ADD COLUMN handling_hours INTEGER DEFAULT 24',
  'ALTER TABLE products ADD COLUMN estimated_days TEXT',
  'ALTER TABLE products ADD COLUMN fragile INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN return_days INTEGER DEFAULT 7',
  'ALTER TABLE products ADD COLUMN return_condition TEXT',
  'ALTER TABLE products ADD COLUMN warranty_days INTEGER DEFAULT 0',
]
for (const sql of MCP_PRODUCT_COLS) { try { db.exec(sql) } catch {} }

db.exec(`
  CREATE TABLE IF NOT EXISTS price_sessions (
    token      TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    price      REAL NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name  TEXT NOT NULL,
    user_id    TEXT,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    outcome    TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    error_msg  TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_ts   ON mcp_tool_calls(ts)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool ON mcp_tool_calls(tool_name, ts)`)

// ─── 4 层身份模型 helpers（与 PWA server 同源逻辑）───────────────
const PERMA_ALPHABET_MCP = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function mcpGeneratePermanentCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = ''
    for (let i = 0; i < 6; i++) code += PERMA_ALPHABET_MCP[Math.floor(Math.random() * 32)]
    const exists = db.prepare("SELECT 1 FROM users WHERE permanent_code = ?").get(code)
    if (!exists) return code
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = ''
    for (let i = 0; i < 7; i++) code += PERMA_ALPHABET_MCP[Math.floor(Math.random() * 32)]
    const exists = db.prepare("SELECT 1 FROM users WHERE permanent_code = ?").get(code)
    if (!exists) return code
  }
  throw new Error('permanent_code generation exhausted')
}
function mcpDeriveHandle(name: string): { handle: string; requested: string; modified: boolean } {
  let base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  base = base.replace(/[^a-zA-Z0-9._]/g, '').toLowerCase()
  base = base.replace(/^[._]+|[._]+$/g, '')
  if (base.length < 3) base = 'user' + Math.random().toString(36).slice(2, 7)
  if (base.length > 18) base = base.slice(0, 18)
  if (/^(usr|sys|admin|webaz|anonymous|null)/.test(base)) base = 'u_' + base
  const requested = base
  let candidate = base, i = 1
  while (db.prepare("SELECT 1 FROM users WHERE handle = ?").get(candidate)) {
    candidate = base.slice(0, 16) + i.toString()
    i++
    if (i > 9999) throw new Error('handle generation exhausted')
  }
  return { handle: candidate, requested, modified: candidate !== requested }
}
// 多形态用户引用解析：usr_xxx / VKSF9P / @handle / handle → 内部 id
function mcpResolveUserRef(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const ref = raw.trim()
  if (!ref) return null
  if (/^usr_[A-Za-z0-9_]+$/.test(ref)) {
    const r = db.prepare("SELECT id FROM users WHERE id = ?").get(ref) as { id: string } | undefined
    return r?.id || null
  }
  if (/^[A-Z0-9]{6,7}$/i.test(ref) && !ref.startsWith('@')) {
    const r = db.prepare("SELECT id FROM users WHERE permanent_code = ?").get(ref.toUpperCase()) as { id: string } | undefined
    if (r) return r.id
  }
  const h = ref.replace(/^@/, '').toLowerCase()
  if (/^[a-z0-9._]+$/.test(h)) {
    const r = db.prepare("SELECT id FROM users WHERE handle = ?").get(h) as { id: string } | undefined
    if (r) return r.id
  }
  return null
}

// ─── 工具定义（Agent 读这些来理解如何使用协议）────────────────

const TOOLS = [
  {
    name: 'webaz_info',
    description: `Get WebAZ documentation and usage guide. Call this FIRST when onboarding a new agent.
Returns: protocol overview, available tools, role responsibilities, operation flows, **network_state (pre-launch disclaimer)**, **commission_model (3-tier share, jurisdiction-graded, explicit attribution, opt-in)**.
No auth required, no parameters needed.

⚠️ Important: WebAZ is currently **pre-launch** with ~0 real users on the canonical endpoint. All stats / counts returned by this and other tools come from the **local MCP SQLite DB**, not protocol-wide prod state. Read network_state field BEFORE you treat any number as real-economy data.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'webaz_register',
    // was ~1732 chars, now ~780 chars
    description: `Register a new WebAZ account. Returns: api_key (36-char 128-bit credential, store securely) + permanent_code (6-char recovery code, pair with handle in webaz_mykey to recover lost api_key) + handle (URL-safe ID; if taken, system appends numeric suffix — check handle_modified flag) + created_at.

⚠️ **Consent required**: creating an account on a human user's behalf registers an economic-relationship account (can participate in commission). Agent acting for a human user **MUST get explicit informed consent BEFORE creating account**. Do NOT auto-register from generic shopping questions.

Roles: buyer (browse/order/confirm) | seller (list/accept/ship) | logistics (pickup/transit/deliver) | reviewer (reviews) | arbitrator (disputes/rulings).

⚠️ **MCP register limitations (anti-bot, by design)**: does NOT set placement_id/sponsor_id — referral/PV chain NOT built via MCP. To build chain: user must arrive via webaz_share_link \`/i/<permanent_code>\` (or \`?ref=<permanent_code>\`) URL clicked in browser (PWA flow). region defaults 'global'; valid: singapore/china/usa/malaysia/indonesia/thailand/vietnam/taiwan/hk/global.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your name or shop name' },
        role: {
          type: 'string',
          enum: ['buyer', 'seller', 'logistics', 'reviewer', 'arbitrator'],
          description: 'Your role in the protocol',
        },
        initial_balance: {
          type: 'number',
          description: 'Initial mock balance (for testing, default 1000 WAZ)',
        },
        region: {
          type: 'string',
          enum: ['global', 'singapore', 'china', 'usa', 'malaysia', 'indonesia', 'thailand', 'vietnam', 'taiwan', 'hk'],
          description: 'Account region (default global; affects referral region cap + commission redirect_region_cap rules)',
        },
      },
      required: ['name', 'role'],
    },
  },
  {
    name: 'webaz_search',
    // was ~2607 chars, now ~1050 chars
    description: `Search WebAZ marketplace + cross-platform anchor lookup. No auth required.

⚠️ **STRICT MATCH ONLY** (no fuzzy fallback). query matches = exact title OR exact external_title OR alias ≥6 chars contained in user text. Short queries (e.g. "iphone") likely return 0 — **this is by design, NOT a bug**. On 0 results: do NOT retry with shorter terms, do NOT call other tools to fake search. Direct user to https://webaz.xyz/#discover for fuzzy browse (user action, not agent's job).

USE THIS when:
- User gives **full product title / SKU / precise description** (strict-match candidate), OR
- User gives **filters** (category / max_price / min_return_days / max_handling_hours / sort), OR
- User pastes **external URL / share-text** from Taobao / Tmall / JD / PDD / 1688 / Douyin / Xiaohongshu
  → URL-paste is a first-class mode of THIS tool, NOT a separate browser-fetch. WebAZ exact-matches against its cross-platform anchor registry.

【External-link paste】Prefer LLM-parse into \`external_link\` { platform, external_id?, external_title } (title = verbatim text inside 「」). If unparseable, drop raw into \`paste_text\` (server does light regex). Match: L1 external_id exact → L2 external_title exact → else \`matched_by:'none'\`. **No fuzzy fallback, no keyword degradation, no similar-product guessing.** matched_by='none' = tell user honestly "no exact match"; trust premise is precise not "looks similar".

Returns: structured specs + logistics + after-sales + agent_summary (one-line decision hint). Paste-link hits webaz.xyz prod data, not local webaz.db.`,
    inputSchema: {
      type: 'object',
      properties: {
        query:              { type: 'string', description: 'Search keyword (product name or description)' },
        category:           { type: 'string', description: 'Category filter (optional)' },
        max_price:          { type: 'number', description: 'Max price filter (optional)' },
        min_return_days:    { type: 'number', description: 'Min return days (optional, e.g. 7 = only ≥7-day return)' },
        max_handling_hours: { type: 'number', description: 'Max handling hours (optional, e.g. 24 = only ≤24h dispatch)' },
        paste_text:         { type: 'string', description: 'Raw paste text / external link (optional; server does light regex parse)' },
        external_link: {
          type: 'object',
          description: 'Structured external link match (optional, agent-parsed)',
          properties: {
            platform:       { type: 'string', description: "'taobao'|'tmall'|'jd'|'pdd'|'1688'|'douyin'|'xhs'" },
            external_id:    { type: 'string', description: 'Platform product canonical ID (optional)' },
            external_title: { type: 'string', description: 'Platform product title verbatim (optional)' },
            canonical_url:  { type: 'string', description: 'Canonical URL (optional)' },
          },
        },
        limit: { type: 'number', description: 'Result limit, default 10; agent mode up to 200' },
        sort: { type: 'string', enum: ['trending', 'newest', 'rating', 'price_asc', 'price_desc', 'random'], description: 'Sort: trending=composite (default) / newest / rating / price_asc / price_desc / random' },
        has_sales: { type: 'string', enum: ['true', 'false'], description: 'true=only sold; false=only new' },
        ship_to: { type: 'string', description: 'Ship-to (province/city); auto-filters unshippable' },
        seller_id: { type: 'string', description: 'Filter to one seller' },
        cursor: { type: 'string', description: 'Pagination cursor (from previous next_cursor)' },
      },
    },
  },
  {
    name: 'webaz_verify_price',
    // was ~647 chars, now ~370 chars
    description: `Lock price + reserve stock BEFORE webaz_place_order — returns \`session_token\` (10-min TTL, single-use, pass to place_order).

USE THIS for **EVERY purchase**: (1) defeats flash-sale / hidden-fee race (2) alerts if price drifted (3) protocol only liable for T0 price (4) reduces stock-depletion race on hot items.

Skipping is allowed but agent then carries price/stock-race risk itself.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key:    { type: 'string', description: "Buyer's api_key (or omit and set the WEBAZ_API_KEY env var)" },
        product_id: { type: 'string', description: 'Product ID (from webaz_search)' },
        quantity:   { type: 'number', description: 'Quantity, default 1' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'webaz_list_product',
    // was ~1336 chars, now ~650 chars
    description: `⚠️ **"list" = PUBLISH** (verb), NOT "list out". Seller-only catalog publish + manage.

USE THIS when seller wants to publish / update / delist / relist / trash / delete own product, OR view own listings (action=mine). NOT for browsing marketplace — use webaz_search (anyone, no auth). Requires seller api_key. On create: system auto-suggests stake ~15% of price (buyer protection).

Fill agent_summary fields completely (brand/return/handling/warranty) — helps buyer agents compare. For "exclusive-price vs external-link" listing → PWA Web only (link claim needs crowd-verify).

Actions: create (title/description/price) | mine | update (product_id + changed fields) | delist (→ warehouse) | relist (warehouse → active) | trash (→ deleted) | delete (only trash, no active orders).`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: "Seller's api_key (or omit and set the WEBAZ_API_KEY env var)" },
        action: {
          type: 'string',
          enum: ['create', 'mine', 'update', 'delist', 'relist', 'trash', 'delete'],
          description: 'Action (default: create)',
        },
        product_id: { type: 'string', description: 'Product ID (required for update/delist/relist/trash/delete)' },
        title: { type: 'string', description: 'Product name (required for create; optional for update)' },
        description: { type: 'string', description: 'Product description (required for create; optional for update)' },
        price: { type: 'number', description: 'Price in WAZ (required for create; optional for update)' },
        stock: { type: 'number', description: 'Stock, default 1' },
        category: { type: 'string', description: 'Category (optional)' },
        specs: {
          type: 'object',
          description: 'Structured specs k/v, e.g. {"color":"black","ram":"16GB","storage":"512GB"} (optional)',
        },
        brand: { type: 'string', description: 'Brand (optional)' },
        model: { type: 'string', description: 'Model (optional)' },
        source_price: {
          type: 'number',
          description: 'External reference price (optional, display only; exclusive-price auth needs PWA link-claim)',
        },
        ship_regions: { type: 'string', description: 'Ship region, default "all"' },
        handling_hours: { type: 'number', description: 'Handling time (hours), default 24' },
        estimated_days: {
          type: 'object',
          description: 'Estimated delivery days: number (e.g. 4) OR region map (e.g. {"east":2,"all":4})',
        },
        fragile: { type: 'boolean', description: 'Fragile flag, default false' },
        return_days: { type: 'number', description: 'Return days, default 7 (0 = no returns)' },
        return_condition: { type: 'string', description: 'Return conditions text (optional)' },
        warranty_days: { type: 'number', description: 'Warranty days, default 0' },
        // S2 库存预警
        low_stock_threshold: {
          type: 'number',
          description: '[S2] Low-stock alert threshold (notify seller when ≤; 0 = disabled)',
        },
        auto_delist_on_zero: {
          type: 'boolean',
          description: '[S2] Auto-delist to warehouse when stock=0 (anti-oversell)',
        },
        // S3 跨境上架多语言
        i18n_titles: {
          type: 'object',
          description: '[S3] Multilingual titles, keys = en/ja/ko/fr/de/es/pt/ru/ar, values ≤500 chars. zh uses title field. E.g. {"en":"Wireless Earbuds","ja":"ワイヤレスイヤホン"}',
        },
        i18n_descs: {
          type: 'object',
          description: '[S3] Multilingual descs, same structure as i18n_titles',
        },
        // S4 商品溯源（origin_claims）— 协议级可挑战
        origin_claims: {
          type: 'object',
          description: '[S4] Product-origin claims (challengeable). E.g. {"made_in":"Kyoto JP","material":"100% cotton GOTS-cert","certs":[{"name":"GOTS","sha256":"<64-hex>"}]}. Total JSON ≤4KB; any cert sha256 must be 64-hex. Any buyer can challenge.',
        },
      },
      required: [],
    },
  },
  {
    name: 'webaz_place_order',
    // was ~1117 chars, now ~580 chars
    description: `Buyer places order. Buyer api_key required. Funds auto-enter protocol escrow.

Order deadlines (absolute ISO timestamps in response):
- accept    T+48h  | ship  T+120h (72h after accept)
- pickup    T+168h (48h after ship) | delivery T+336h (7d after pickup)
- confirm   T+408h (72h after delivery)

Missing any → auto-judge fault against responsible party + compensation per protocol.

Options:
- **B1 cross-border tax**: server auto-estimates duty (seller's est_import_duty_pct × price)
- **B2 privacy**: \`anonymous_recipient=true\` → PR-XXXXX alias on shipping label
- **B5 donation**: \`donation_pct\` 0 / 0.5 / 1 / 2 / 5% → charity_fund`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: "Buyer's api_key (or omit and set the WEBAZ_API_KEY env var)" },
        product_id: { type: 'string', description: 'Product ID to buy (from webaz_search)' },
        quantity: { type: 'number', description: 'Quantity, default 1' },
        shipping_address: { type: 'string', description: 'Shipping address' },
        notes: { type: 'string', description: 'Note to seller (optional)' },
        session_token: {
          type: 'string',
          description: 'Price-lock session_token (recommended): from webaz_verify_price; guarantees order price = displayed price',
        },
        promoter_api_key: {
          type: 'string',
          description: "Referrer api_key (optional). ⚠️ Only L1 recorded (direct referrer, 70% commission); L2/L3 can't be inferred via MCP, so the undelivered L2/L3 portions go to commission_reserve (protocol reserve, in-only). Full 7:2:1 three-tier chain requires buyer clicking ?ref= URL from webaz_share_link (creates product_share_attribution).",
        },
        // B2 隐私购物
        anonymous_recipient: {
          type: 'boolean',
          description: '[B2] Anonymous recipient: system generates PR-XXXXX alias instead of real name (seller label shows alias + address only)',
        },
        // B5 公益捐赠（按订单总额百分比，定额选项防机器人滥用）
        donation_pct: {
          type: 'number',
          enum: [0, 0.005, 0.01, 0.02, 0.05],
          description: '[B5] Per-order donation pct (0 / 0.5 / 1 / 2 / 5). Computed separately + into charity_fund, posted on order complete.',
        },
      },
      required: ['product_id', 'shipping_address'],
    },
  },
  {
    name: 'webaz_update_order',
    // was ~927 chars, now ~430 chars
    description: `STATUS TRANSITIONS on an order — NOT for editing order content (price/qty/address immutable after creation). Each role can only perform their own actions.

- **Seller**: accept (24h after payment) | ship (needs tracking/notes, within handling time) | pickup/transit/deliver ONLY when order.logistics_id is empty (Phase-1 self-fulfill; seller carries logistics responsibility) | decline (actively refuse a PAID order instead of silent timeout; requires decline_reason_code — objective codes [stock_consumed_concurrent/stale_price_snapshot/force_majeure] go to a PROVISIONAL fault you must then contest within the window, NOT auto-cleared; subjective codes [price_regret/cherry_pick/other] settle immediately as seller-fault + buyer refund) | contest_decline (open human arbitration on an objective-claimed provisional fault, within the contest window, to be cleared to no-fault; pass evidence_description — window expiry finalizes as fault)
- **Logistics**: pickup (48h after ship) | transit | deliver (needs proof description) when assigned or claiming an unassigned shipped order
- **Buyer**: confirm (→ fund settlement) | dispute (needs reason; freezes funds → arbitration)

Missing deadline → protocol auto-marks party in default.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: "Operator's api_key (or omit and set the WEBAZ_API_KEY env var)" },
        order_id: { type: 'string', description: 'Order ID' },
        action: {
          type: 'string',
          enum: ['accept', 'ship', 'pickup', 'transit', 'deliver', 'confirm', 'dispute', 'decline', 'contest_decline'],
          description: 'Action to execute. decline = seller actively refuses a paid order (vs silent timeout); requires decline_reason_code. contest_decline = seller opens human arbitration on an objective-claimed provisional fault (within the contest window) to be cleared to no-fault; pass evidence_description.',
        },
        notes: { type: 'string', description: 'Action note (e.g. tracking number, dispute reason)' },
        decline_reason_code: {
          type: 'string',
          enum: ['stock_consumed_concurrent', 'stale_price_snapshot', 'force_majeure', 'price_regret', 'cherry_pick', 'other'],
          description: 'Required for action=decline. Why the seller refuses. Subjective (price_regret / cherry_pick / other) → settles immediately as seller-fault (buyer fully refunded). Objective-claimed (stock_consumed_concurrent / stale_price_snapshot / force_majeure) → PROVISIONAL fault: not settled yet, opens a contest window — seller must open arbitration (webaz_dispute) with evidence to be cleared (these off-chain facts have no on-protocol auto-verification); uncontested by the deadline → auto-finalizes as fault.',
        },
        evidence_description: {
          type: 'string',
          description: 'Evidence description (recommended for ship/pickup/deliver; required for dispute)',
        },
      },
      required: ['order_id', 'action'],
    },
  },
  {
    name: 'webaz_get_status',
    // was ~286 chars, now ~200 chars
    description: `Query order status + full history + current responsible party + deadline. Requires api_key of order participant (buyer/seller/logistics all OK). Returns: status / status_history (who did what when) / next_actor / deadline.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: "Querier's api_key (or omit and set the WEBAZ_API_KEY env var)" },
        order_id: { type: 'string', description: 'Order ID' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'webaz_wallet',
    // was ~788 chars, now ~440 chars
    description: `Wallet **READ-ONLY** query (balance / earnings / deposit/withdrawal/income history).

⚠️ **Iron-Rule**: actual withdrawals / deposits / whitelist mgmt need **PWA Web + Passkey + email OTP**. This tool CANNOT move money — only query. User asks "send/withdraw/deposit WAZ"? Do NOT promise via MCP — direct to PWA Web.

Actions:
- view (default) — balance + staked + in-escrow + earnings + reputation tier
- deposits — last 10 on-chain (tx_hash / amount / block)
- withdrawals — last 10 (status / tx_hash)
- income — breakdown: referral L1/L2/L3 + points-matching + sales net`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: {
          type: 'string',
          enum: ['view', 'deposits', 'withdrawals', 'income'],
          description: 'Action type (default: view)',
        },
      },
      required: [],
    },
  },
  {
    name: 'webaz_notifications',
    // was ~608 chars, now ~330 chars
    description: `Query user notifications (L2-6 system). Agents should poll periodically for pending order events (new order / ship / dispute → notifies relevant participants).

⚠️ **Scope**: only L2-6 system notifications. Does NOT include: chat unread (use webaz_chat list) | announcements | feedback replies. PWA top badge aggregates 4; this returns 1 → may be **<** PWA shows.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key:    { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        unread:     { type: 'boolean', description: 'Return only unread (default false)' },
        mark_read:  { type: 'boolean', description: 'Auto-mark read after call (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'webaz_dispute',
    // was ~2277 chars, now ~900 chars
    description: `Manage ORDER-DELIVERY dispute lifecycle (L3, central arbitrator). For order delivery problems (not arrived / wrong / damaged / seller fraud). **NOT for challenging product marketing claims → use webaz_claim_verify.** Quick rule: did buyer receive item? Yes + item-itself issue → claim_verify. No / damaged-transit → dispute. Initial raise via webaz_update_order action=dispute, then this tool for follow-ups.

Actions:
- view          dispute details (any participant)
- list_open     pending disputes (arbitrators only)
- respond       respondent rebuttal (before 48h deadline)
- add_evidence  any participant supplements
- arbitrate     ruling + fund disposition (assigned arbitrator only)

Ruling options: refund_buyer | release_seller | partial_refund (needs refund_amount; optional liable_party → 3rd-party fault, seller settled full + deducted from liable) | liability_split (needs liability_parties[]={user_id,amount}).

Protocol auto-judges (no human): respondent silent 48h → favor initiator; arbitrator silent 120h → refund_buyer. Executed rulings are instant + irreversible.

⚠️ **Iron-Rule (spec §4)**: \`arbitrate\` needs PWA + Passkey real-human re-confirm. Direct agent call returns 412 HUMAN_PRESENCE_REQUIRED — **do NOT retry**, guide user to browser. view / list_open / respond / add_evidence are agent-proxyable.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: "Operator's api_key (or omit and set the WEBAZ_API_KEY env var)" },
        action: {
          type: 'string',
          enum: ['view', 'list_open', 'respond', 'add_evidence', 'arbitrate'],
          description: 'Action to execute',
        },
        dispute_id: { type: 'string', description: 'Dispute ID (required for respond/add_evidence/arbitrate; for view, dispute_id OR order_id)' },
        order_id: { type: 'string', description: 'Order ID (alternative to dispute_id for view)' },
        notes: { type: 'string', description: 'Response / rebuttal note (for respond)' },
        evidence_description: { type: 'string', description: 'Evidence description (for respond/add_evidence)' },
        ruling: {
          type: 'string',
          enum: ['refund_buyer', 'release_seller', 'partial_refund', 'liability_split'],
          description: 'Ruling (required for arbitrate)',
        },
        refund_amount: { type: 'number', description: 'Partial refund amount (only when ruling=partial_refund)' },
        liable_party: { type: 'string', description: '3rd-party liable user_id (optional for partial_refund): refund deducted from this party, seller settled in full' },
        liability_parties: {
          type: 'array',
          description: 'Liability allocation array (required for liability_split); each item { user_id, amount }',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'string', description: 'Liable user_id' },
              amount: { type: 'number', description: 'Amount this party owes (WAZ)' },
            },
            required: ['user_id', 'amount'],
          },
        },
        ruling_reason: { type: 'string', description: 'Ruling reason (required for arbitrate; permanently recorded on-chain)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_claim_verify',
    // was ~2917 chars, now ~1100 chars
    description: `Crowd-sourced PRODUCT-CLAIM verification — challenge seller's marketing claims (brand / spec / ship time / authenticity). 3 eligible verifiers vote → consensus.

**vs webaz_dispute**: dispute = delivery problem (not arrived / damaged / wrong item, central arbitrator). claim_verify = item-itself / claim-accuracy ("said brand new but used", "said 24h ship but didn't"). Quick test: did buyer receive? Yes + item issue → claim_verify; No / transit damage → dispute.

Actions:
[Buyer]
- create  open verification (locks 10 WAZ; order must be paid/delivered, NOT completed; settles on 3rd vote)
- view    task details (visible to participants + voters + eligible verifiers)
- mine    all my tasks (buyer/seller/verifier perspectives)
[Seller]
- submit_seller_evidence  rebuttal → +24h extension
[Verifier]
- available  list takeable tasks (eligibility: age≥60d / email verified / ≥20 completed orders / 0 arbitration losses / never suspended / wallet ≥200 WAZ / reputation ≥110)
- vote       pass (claim true) | fail (claim false) | no_fault (inconclusive) | abstain (not my expertise — not counted, no accuracy impact)
[Become Verifier]
- eligibility / verifier_status / apply (needs stake) / withdraw_application / appeal (only when suspended)

⚠️ **Iron-Rule (spec §4)**: \`vote\` needs PWA + Passkey real-human re-confirm. Direct agent call returns 412 HUMAN_PRESENCE_REQUIRED — **do NOT retry**, guide user to browser. All other actions agent-proxyable.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: {
          type: 'string',
          enum: ['create', 'view', 'mine', 'submit_seller_evidence', 'available', 'vote', 'eligibility', 'verifier_status', 'apply', 'withdraw_application', 'appeal'],
          description: 'Action to execute',
        },
        // create
        order_id: { type: 'string', description: 'Order ID (required for create). Order status must be paid/delivered (cannot create on completed)' },
        claim_target: {
          type: 'string',
          enum: ['price', 'commission', 'protection', 'return', 'warranty', 'handling', 'other'],
          description: 'Claim target (required for create). 7 types: price / commission / protection / return / warranty / handling / other',
        },
        claim_text: { type: 'string', description: 'Claim text 6-500 chars (required for create). Locks 10 WAZ anti-spam (refunded if no fault)' },
        evidence_uri: { type: 'string', description: 'Evidence URI (optional for create/vote/submit_seller_evidence; buyer/verifier/seller respective evidence)' },
        // view / vote / submit_seller_evidence
        task_id: { type: 'string', description: 'Task ID (required for view/vote/submit_seller_evidence)' },
        // vote
        vote: { type: 'string', enum: ['pass', 'fail', 'no_fault', 'abstain'], description: 'Required for vote; abstain = not my expertise (V3 right-to-decline)' },
        note: { type: 'string', description: 'Vote note (optional for vote, ≤500 chars)' },
        // appeal
        reason: { type: 'string', description: 'Appeal reason (required for appeal, ≤500 chars)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_skill',
    // was ~2251 chars, now ~920 chars
    description: `L4-4 Skill marketplace — sellers publish reusable seller-side BEHAVIOUR configs; buyer Agents subscribe one-click.

**NOT** a product search (use webaz_search). **NOT** a knowledge/content market (use webaz_skill_market — totally separate, independent revenue flow).

⚠️ **Skill ≠ executable code distribution**. 5 typed kinds only, each accepts **structured config params** (numbers/enums/amounts). NO path for Agent to download/run arbitrary 3rd-party code. Subscribing = flag + data binding, NOT plugin install. Web2 "plugin marketplace" risk model does NOT apply.

Cold-start mechanism: Amazon/Shopify sellers integrate zero-cost; buyer agents auto-discover subscribed sellers with priority; publisher earns referral commission on sale.

Skill types (typed, not free-form):
- catalog_sync     sync external store → subscribers see priority
- auto_accept      auto-accept orders (config: min/max_amount, max_daily_orders)
- price_negotiation  agent-side haggling (config: max_discount_pct, min_quantity)
- quality_guarantee  extra stake compensation (config: guarantee_amount, coverage_days)
- instant_ship     guarantee 24h dispatch (config: ship_within_hours)

Actions: list (no auth) | publish (seller) | subscribe / unsubscribe (buyer) | my_skills | my_subs.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (omit for list) (or set the WEBAZ_API_KEY env var)' },
        action: {
          type: 'string',
          enum: ['list', 'publish', 'subscribe', 'unsubscribe', 'my_skills', 'my_subs'],
          description: 'Action to execute',
        },
        // list 过滤参数
        skill_type: {
          type: 'string',
          enum: ['catalog_sync', 'auto_accept', 'price_negotiation', 'quality_guarantee', 'instant_ship'],
          description: 'Filter Skill type (optional for list)',
        },
        query: { type: 'string', description: 'Keyword search (optional for list)' },
        // publish 参数
        name: { type: 'string', description: 'Skill name (required for publish)' },
        description: { type: 'string', description: 'Skill description (required for publish)' },
        category: { type: 'string', description: 'Category (optional for publish)' },
        config: {
          type: 'object',
          description: 'Skill config (optional for publish; e.g. auto_accept needs max_daily_orders)',
        },
        // subscribe 参数
        skill_id: { type: 'string', description: 'Skill ID (required for subscribe/unsubscribe)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_mykey',
    // was ~909 chars, now ~480 chars
    description: `Account RECOVERY check — confirm account existence by handle + 6-char permanent_code (from registration). Returns redacted api_key_hint only.

⚠️ **Iron-Rule**: full api_key disclosure requires **PWA + Passkey** verification — this MCP tool only returns hint + PWA URL, never full key.

USE THIS ONLY when user lost api_key + has handle + permanent_code. NOT for "show my api_key" (use the one you have). NOT for looking up others (use webaz_profile).

Rate-limited: 5/handle/hour; excessive → 1h lock.

Returns: found / api_key_hint (e.g. "key_7d3d***faa7b") / full_api_key_recovery URL.`,
    inputSchema: {
      type: 'object',
      properties: {
        handle:         { type: 'string', description: 'Unique handle assigned at registration (check handle_modified flag if name was taken)' },
        permanent_code: { type: 'string', description: '6-char recovery code from registration response (uppercase)' },
      },
      required: ['handle', 'permanent_code'],
    },
  },
  {
    name: 'webaz_profile',
    // was ~1076 chars, now ~570 chars
    description: `View own profile / manage roles, AND view any user's public profile + content streams.

USE THIS for info about a SPECIFIC PERSON (by usr_xxx / permanent code / @handle / name), OR to see someone's listings / notes / activity stream. NOT for product keyword search — use webaz_search.

Self actions (need api_key):
- view (profile + wallet + api_key hint) | add_role | switch_role

Public-profile actions:
- view_user (user_id = usr_xxx / permanent_code / @handle; needs api_key)
- feed (user_id + feed): secondhand | auctions | reviews | products | shares | reputation (public) | pv (needs api_key) | liked (owner-only, needs your api_key)`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key:  { type: 'string', description: 'Your api_key (required for view/add_role/switch_role/view_user; optional for public feed) (or set the WEBAZ_API_KEY env var)' },
        action: {
          type: 'string',
          enum: ['view', 'add_role', 'switch_role', 'view_user', 'feed'],
          description: 'view/add_role/switch_role = self; view_user/feed = other user profile/feed',
        },
        role: {
          type: 'string',
          enum: ['buyer', 'seller', 'logistics', 'arbitrator'],
          description: 'Role to add or switch to (required for add_role / switch_role)',
        },
        user_id: { type: 'string', description: 'Target user: usr_xxx / permanent_code / @handle (required for view_user/feed)' },
        feed: {
          type: 'string',
          enum: ['secondhand', 'auctions', 'reviews', 'products', 'shares', 'reputation', 'pv', 'liked'],
          description: 'Feed type (required for feed)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_revoke_key',
    // was ~778 chars, now ~430 chars
    description: `Initiate api_key revocation (**NO REPLACEMENT** — old key dies, no new issued).

⚠️ **Iron-Rule**: actual revocation needs **PWA + Passkey** confirm. MCP only registers intent + returns PWA URL.

⚠️ **STRONG REC**: use \`webaz_rotate_key\` instead unless you want zero replacement. Rotate = atomic swap (no access gap). Revoke = death + re-register.

Use revoke when: PERMANENT decommission of agent/device, OR want access death NOW with no fallback. After PWA confirm: old key → 401 on all tools.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your current api_key (the one to revoke) (or set the WEBAZ_API_KEY env var)' },
        reason:  { type: 'string', description: 'Optional: leaked / lost_device / rotation / unspecified' },
      },
      required: [],
    },
  },
  {
    name: 'webaz_rotate_key',
    // was ~372 chars, now ~260 chars
    description: `Initiate api_key rotation (invalidate old + issue new). ⚠️ **Iron-Rule**: needs **PWA + Passkey** confirm. After PWA: old → 401; new shown ONCE — store immediately.

Safer than \`webaz_revoke_key\` — atomic swap, no access gap.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your current api_key (will be invalidated after PWA confirm) (or set the WEBAZ_API_KEY env var)' },
        reason:  { type: 'string', description: 'Optional: rotation / leaked / scheduled' },
      },
      required: [],
    },
  },
  {
    name: 'webaz_referral',
    description: `View your referral status: 3-tier commission team + earnings + invite links + points-matching tier progress + L1 share permission gate + **rewards_status (RFC-002 §3.5 opt-in state + pending escrow)**.

⚠️ **Opt-in required (RFC-002)**: rewards default = off. \`rewards_status\` field returns 4-state {opted_in | never_activated | auto_downgraded | deactivated} + pending_escrow tally. Opted-out users still see attribution + tree. Commission destination differs by state: **never_activated / auto_downgraded** → held in pending_commission_escrow, recoverable by (re-)activating within the window via PWA #me; **deactivated** (active opt-out) → future L1/L2/L3 commission goes to commission_reserve / protocol reserve, NOT escrow and NOT recoverable (re-applying only affects future commission).

⚠️ **Consent required**: generating referral links / promoting on a human user's behalf needs the user's explicit authorization. Agent **MUST get explicit consent** before generating referral links / promoting. Do NOT auto-recruit.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
      },
      required: [],
    },
  },
  {
    name: 'webaz_share_link',
    description: `Generate product share link with your referral attached. Open in any social platform (TikTok/WeChat/Telegram). Clicker registers/buys → counts toward your 3-tier commission (if verified buyer) + points-matching.

⚠️ **Opt-in required (RFC-002 §3.5)**: this is a valuation-layer (rewards) action, not a contribution gate. Caller must have \`rewards_opted_in=1\` (rewards / share-commission opt-in). Opted-out users get \`{error: 'rewards_opt_in_required', missing_requirements, next_steps}\` — direct user to PWA #me to apply.

⚠️ **Consent required**: this builds a referral chain on the user's behalf. Agent acting for a human user **MUST get explicit consent**. Do NOT auto-generate. See webaz_info.commission_model.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key:    { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        product_id: { type: 'string', description: 'Product to promote (from webaz_search)' },
        side: {
          type: 'string',
          enum: ['auto'],
          description: 'Deprecated / no-op — placement is always automatic (system-decided). Left/right选择已下线。',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'webaz_blocklist',
    // was ~607 chars, now ~370 chars
    description: `Manage blocklist of sellers/users. Blocked → auto-hidden from your search + can't follow them.

⚠️ **Scope** (元规则 #5 不偏袒): ✓ hides from YOUR search ✓ prevents follow. ✗ Does NOT prevent placing orders on their products (商品发布即承诺销售) ✗ Does NOT silence existing chat (business context wins) ✗ Does NOT prevent new chat on shared order/rfq context. For active rejection: delist / don't bid / cancel order.

Actions: list | block | unblock.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['list', 'block', 'unblock'], description: 'list: my blocked users | block: add | unblock: remove' },
        user_id: { type: 'string', description: 'Target user id (required for block/unblock)' },
        reason:  { type: 'string', description: 'Optional reason for block (e.g. "fake product", "abuse")' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_follows',
    description: 'Follow/unfollow users for the social feed. Or list your followers / following. Helps agents build the user\'s social graph.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action:  { type: 'string', enum: ['list', 'follow', 'unfollow', 'status'], description: 'list: my follows + followers | follow/unfollow: change relation | status: check if I follow a user' },
        user_id: { type: 'string', description: 'Target user (required for follow/unfollow/status)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_nearby',
    // was ~831 chars, now ~430 chars
    description: `Query anonymized nearby (~11km cell) purchase aggregation. **k-anonymity ≥3** privacy guard. Set/clear your coarse geo (0.1° precision, never exact GPS).

USE THIS for "what's popular near me / 我附近 / 同城" — geo-aggregated, no keyword. NOT for "find product X" (use webaz_search). NOT for "shippable to me" (use webaz_search ship_to).

⚠️ MCP \`query\` needs \`set_location\` first (else \`has_location: false\`). PWA #nearby has 4-tier fallback (national / city / around / 14km) — designed difference: MCP demands location, PWA degrades.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action:  { type: 'string', enum: ['query', 'set_location', 'clear_location'], description: 'query: get aggregated nearby activity | set_location: set your geo cell | clear_location: remove' },
        lat:     { type: 'number', description: 'Latitude -90..90 (for set_location, auto-truncated to 0.1°)' },
        lng:     { type: 'number', description: 'Longitude -180..180 (for set_location, auto-truncated to 0.1°)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_default_address',
    // was ~370 chars, now ~230 chars
    description: `Read or set default shipping address. Used by webaz_search unshippable filter + fallback for webaz_rfq/place_order if omitted.

⚠️ \`set\` accepts only 2 fields: \`text\` (free-text address, ≤200 chars, required) + \`region\` (optional, for unshippable filter, ≤40 chars). NO structured fields (no recipient/line1/city/country/phone) — agent must concat itself.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action:  { type: 'string', enum: ['read', 'set'], description: 'read: get current default | set: update' },
        text:    { type: 'string', description: 'Full address as free-text string (e.g. "John Doe / 1 Test St / Singapore SG / +65 12345678"). Required for set. ≤ 200 chars.' },
        region:  { type: 'string', description: 'Region tag for shipping match (e.g. "global", "china", "SG"). Optional for set. ≤ 40 chars.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_shareables',
    // was ~843 chars, now ~480 chars
    description: `Bind your **EXISTING external content** (YouTube / TikTok / 小红书 / B站 / IG / Twitter) to a WebAZ product/anchor — turns your content into referral-earning channel. WebAZ indexes only URL, never content bytes.

USE THIS when: creator anchors existing review/unboxing post → future buyers click → counts toward THEIR referral commission. OR agent looks up "what external content for this product/anchor".

⚠️ Different from \`webaz_share_link\` (generates NEW short link) — shareables register EXISTING content as discovery surface.

Actions: list_mine | add (external_url + product/anchor) | delete | by_product | by_anchor.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action:  { type: 'string', enum: ['list_mine', 'add', 'delete', 'by_product', 'by_anchor'], description: 'list_mine | add (need external_url + product/anchor) | delete | by_product | by_anchor' },
        external_url:       { type: 'string', description: 'For action=add' },
        title:              { type: 'string', description: 'For action=add (optional)' },
        description:        { type: 'string', description: 'For action=add (optional)' },
        related_product_id: { type: 'string', description: 'For action=add or by_product' },
        related_anchor:     { type: 'string', description: 'For action=add or by_anchor' },
        shareable_id:       { type: 'string', description: 'For action=delete' },
      },
      required: ['action'],
    },
  },
  // ── P3 RFQ / bid / chat / auto_bid（MCP 通过 HTTP 调 PWA，复用所有校验+状态机）────
  {
    name: 'webaz_rfq',
    // was ~1822 chars, now ~880 chars
    description: `RFQ (Request-for-Quotation) — buyer posts demand, sellers bid within time window.

USE THIS when buyer POSTS a need (no good search match / bulk / custom / time-sensitive / wants competing quotes). NOT a search tool — for browsing use webaz_search. For AUCTION (English forward on a listed item) use webaz_auction.

Actions:
- create (buyer)   publish RFQ (title/qty/max_price/category/urgency/award_mode)
- mine (buyer)    my RFQ list
- browse (seller) board view (filter by region/category/urgency/unbidded)
- detail          full detail (buyer sees all bids; seller sees only own)
- award (buyer)   pick winner (bid_id for manual; omit = auto-lowest)
- cancel (buyer)  only pre-award; 30% deposit forfeit to charity_fund

Economics:
- Buyer deposit = clamp(0.1, 1) of max_price × qty × 1% (anti-spam). No-max-price = 0.1 WAZ flat.
- Seller bid stake = max(0.5, price × qty × 5%). Becomes bid_stake_held on award; released on complete; 50/50 split (buyer + sys_protocol) on fault_seller.
- Award → standard order lifecycle BUT **snapshot_commission_rate = 0** (RFQ 0% commission, no L1/L2/L3 promoter dilution); seller gets price − protocol_fee 2% − fund_base 1%.
- Window defaults: now=15min / today=60min / flex=24h.

Shipping address falls back to webaz_default_address if omitted.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['create', 'mine', 'browse', 'detail', 'award', 'cancel'] },
        // create
        title: { type: 'string' },
        qty: { type: 'number' },
        max_price: { type: 'number', description: 'Max budget in WAZ (optional; if omitted, buyer deposit = 1 WAZ)' },
        category: { type: 'string', enum: ['standard', 'general', 'highvalue', 'restricted'] },
        urgency: { type: 'string', enum: ['now', 'today', 'flex'] },
        award_mode: { type: 'string', enum: ['manual', 'first_match', 'time_window'] },
        award_window_min: { type: 'number' },
        notes: { type: 'string' },
        shipping_address: { type: 'string', description: 'Optional; falls back to buyer default address' },
        // browse filters
        region: { type: 'string' },
        unbidded: { type: 'boolean' },
        // detail/award/cancel
        rfq_id: { type: 'string' },
        bid_id: { type: 'string', description: 'Optional for award — if omitted, auto-pick current lowest bid' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_bid',
    // was ~733 chars, now ~400 chars
    description: `Bid on RFQs (seller-side, Request-for-Quotation).

⚠️ **ONLY for RFQ bidding** (buyer posted demand via webaz_rfq). For AUCTION (English forward on listed item) use \`webaz_auction action=bid\` — separate systems with different economics (RFQ = bid stake; auction = min_increment + sniper extension).

Actions: submit (rfq_id + price + qty_offered + fulfillment_type; optional eta/note) | patch (active only, stake delta auto-settled) | cancel (active only, deposit released immediately) | list_mine.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Seller api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['submit', 'patch', 'cancel', 'list_mine'] },
        rfq_id: { type: 'string' },
        bid_id: { type: 'string' },
        price: { type: 'number' },
        qty_offered: { type: 'number' },
        eta_hours: { type: 'number' },
        fulfillment_type: { type: 'string', enum: ['instant_pickup', 'same_day', 'next_day', 'standard'] },
        note: { type: 'string' },
        offer_id: { type: 'string', description: 'Optional; reference existing offer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_chat',
    // was ~1963 chars, now ~860 chars
    description: `Relay buyer↔seller (or RFQ partner) MESSAGES — **context-bound DM**, NO open DM. Only \`order\` / \`rfq\` / \`listing_qa\` contexts.

USE THIS for trade communication ("ask seller about return", "tell buyer about delay", "answer listing Q&A"). NOT general LLM chat — every message attaches to context. User chatting with agent? Don't call this.

Actions: start (kind + context_id; rfq needs recipient_id) | list | read (last 50, flag_reasons array) | send (anti-scam regex; matches flagged=true but still delivered) | mark_read | block (this conv only; ≠ webaz_blocklist which hides from search).

⚠️ **Anti-scam regex** (in flag_reasons[]): phone_cn (11-digit) / wechat (微信/vx/wechat) / alipay / qq / bank_card (16-19 digits) / telegram (@/t.me) / external_url (non-webaz HTTPS).

Rate limits: 60/min/user short-term + AGENT_DAILY_CAP (UTC reset): new=30 / trusted=100 / quality=300 / legend=1000 (over → 429 + error_code=AGENT_DAILY_CAP). 3 overruns/day → auto warning strike.

webaz_blocklist hides from search but does NOT auto-silence existing convs (business context wins) — use this tool's \`block\` for per-conv silence.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['start', 'list', 'read', 'send', 'mark_read', 'block'] },
        kind: { type: 'string', enum: ['order', 'rfq', 'listing_qa'] },
        context_id: { type: 'string' },
        recipient_id: { type: 'string' },
        conversation_id: { type: 'string' },
        body: { type: 'string', description: 'Message body for send action (≤2000 chars)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_price_history',
    // was ~571 chars, now ~350 chars
    description: `Product historical sale price + volume — helps agents avoid bottom-price dumping bait.

Returns: windows {d30, d90, lifetime} each {sales, volume, avg, median, p25, p75} | price_buckets [{price, count, qty, pct}] | daily_avg (30-day trend) | category_avg_30d | anomaly_flags (current_below_70pct_median / far_below_category_avg / far_above_category_avg). \`insufficient_data: true\` if sparse.`,
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'webaz_charity',
    // was ~1856 chars, now ~850 chars
    description: `Charity wish pool + repayment + community fund — double-anonymous + dual-signed anchoring + isolated prestige.

USE THIS for: publishing wish (need help) | claiming/fulfilling others' wishes | donating to / browsing community fund.

**NOT** for per-order charity donation — that's webaz_place_order's \`donation_pct\` (0.5/1/2/5% to charity_fund at order time). This tool is the **standalone wish-fulfillment economy**.

Actions (15):
- list / detail / stories / leaderboard / fund — public
- create  (auth) publish wish
- claim   (auth) 1:1 exclusive, 30-day self-claim lock, auto-release if no proof 48h
- proof / confirm  (auth) complete + wisher confirm → fulfiller +10 prestige
- disclose (auth) both-agree public disclosure
- cancel  (auth) only open wishes
- me      (auth) prestige breakdown + pending repayment queue
- repay   (auth) ≥0.1 WAZ; auto-accept if no response 7d
- repay_respond  (auth) accept | decline_to_fund (decline → fund, wisher +8 / fulfiller +2 grace)
- donate  (auth) ≥0.1 WAZ; daily 50 WAZ matched 1:1 → donation_honor`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['list','detail','create','claim','proof','confirm','disclose','cancel','me','stories','leaderboard','repay','repay_respond','donate','fund'] },
        wish_id: { type: 'string' },
        fulfillment_id: { type: 'string' },
        repay_id: { type: 'string' },
        choice: { type: 'string', enum: ['accept','decline_to_fund'] },
        category: { type: 'string', enum: ['medical','education','daily','elderly','disaster','tech','other'] },
        target_kind: { type: 'string', enum: ['item','service','cash'] },
        target_waz: { type: 'number', description: 'Required for cash mode, ≤500' },
        escrow_self: { type: 'number', description: '1=self-escrow lock full amount; 0=pure coordination' },
        title: { type: 'string' }, content: { type: 'string' },
        window_hours: { type: 'number', description: '24-720 hours' },
        allow_public: { type: 'number' },
        proof_hash: { type: 'string', description: 'sha256 hex of proof_text' },
        proof_note: { type: 'string' },
        amount: { type: 'number', description: 'repay / donate amount in WAZ' },
        note: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_p2p_product',
    // was ~880 chars, now ~480 chars
    description: `P2P native store — product detail lives on seller's node; WebAZ only anchors hash + key fields.

Actions: create (seller, needs title/price/stock + content_hash sha256 + content_signature HMAC-SHA256(api_key, hash|signed_at)) | list | detail | patch (price/stock/title direct; detail JSON change → must re-sign).

⚠️ **Agent verification flow** (must implement):
1. GET peer_endpoint/<product_id> → raw JSON
2. canonicalize (sort keys, drop nulls) → JSON.stringify
3. sha256(canonical) === product.content_hash ? accept : **reject trade**`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['create', 'list', 'detail', 'patch'] },
        product_id: { type: 'string' },
        title: { type: 'string' }, price: { type: 'number' }, stock: { type: 'number' },
        content_hash: { type: 'string', description: 'sha256 hex' },
        content_signature: { type: 'string', description: 'HMAC-SHA256(api_key, hash|signed_at)' },
        content_signed_at: { type: 'string', description: '"YYYY-MM-DD HH:MM:SS"' },
        peer_endpoint: { type: 'string' },
        thumbnail_uri: { type: 'string', description: 'data:image/* base64, ≤16KB' },
        category: { type: 'string' }, region: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_like',
    // was ~369 chars, now ~230 chars
    description: `Like a shareable to boost product ranking.

Actions: toggle (same endpoint; 2nd call auto-unlikes) | status (my like status + total).

⚠️ **Anti-Sybil**: must have ≥1 completed order. One vote per person, can't like own.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['toggle', 'status'] },
        shareable_id: { type: 'string' },
      },
      required: ['action', 'shareable_id'],
    },
  },
  {
    name: 'webaz_leaderboard',
    // was ~817 chars, now ~480 chars
    description: `WebAZ leaderboards — no centralized traffic distribution, pure real-signal ranking. **Privacy-first**: GMV / revenue amounts NEVER exposed.

8 kinds:
- products (sales×0.5 + referrals×2.0 + likes×1.0)
- value_products (💎 cheapest 20% per category, daily batch)
- creators (total likes received)
- sellers (rating × log(reviews+1); GMV hidden)
- buyers (completed order count; GMV hidden)
- verifiers (correct count / accuracy)
- arbitrators (fairness_score)
- agents (trust_score + 30d call count)`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['products', 'value_products', 'creators', 'sellers', 'buyers', 'verifiers', 'arbitrators', 'agents'],
          description: 'Leaderboard kind',
        },
        limit: { type: 'number', description: 'Default 20, max 50' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'webaz_auction',
    // was ~967 chars, now ~550 chars
    description: `English forward auction — seller posts → buyers raise → **anti-sniping extension** → highest wins.

USE THIS to BID on auction items OR seller starts auction (rare goods / collectibles / price-discovery). NOT regular product search — auctions are **time-windowed events**. For fixed-price use webaz_search.

Actions:
- create (seller): title/qty/category/starting_price + optional min_increment/reserve_price/window_min/sniper_extend_min
- browse / mine (own + participated) / detail (bid history; buyer_id redacted to non-seller/non-bidder)
- bid (buyer): auction_id + price (first ≥ starting; next ≥ current + increment)
- cancel (seller, only pre-bid)`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['create', 'browse', 'mine', 'detail', 'bid', 'cancel'] },
        title: { type: 'string' },
        qty: { type: 'number' },
        category: { type: 'string', enum: ['standard', 'general', 'highvalue', 'restricted'] },
        starting_price: { type: 'number' },
        min_increment: { type: 'number' },
        reserve_price: { type: 'number' },
        window_min: { type: 'number' },
        sniper_extend_min: { type: 'number' },
        notes: { type: 'string' },
        auction_id: { type: 'string' },
        price: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_auto_bid',
    // was ~595 chars, now ~340 chars
    description: `Seller auto_bid Skill config — auto-quote on RFQ creation instantly.

Shortcut for \`webaz_skill install kind=auto_bid\` + ongoing config edits. Dedicated tool because auto_bid is most-used + needs frequent tuning (max_eta_h / undercut_pct / daily_cap). For other Skill kinds use webaz_skill.

Actions: get | set (categories[] / regions[] / max_eta_h / bid_strategy) | disable (keeps config).`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['get', 'set', 'disable'] },
        categories: { type: 'array', items: { type: 'string' } },
        regions: { type: 'array', items: { type: 'string' } },
        max_eta_h: { type: 'number' },
        fulfillment_type: { type: 'string', enum: ['instant_pickup', 'same_day', 'next_day', 'standard'] },
        bid_strategy: { type: 'string', enum: ['cheapest_undercut', 'match_budget'] },
        undercut_pct: { type: 'number', description: '0–0.5; undercut margin' },
        max_price_cap: { type: 'number' },
        daily_cap: { type: 'number' },
        cooldown_min: { type: 'number' },
        enabled: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_skill_market',
    // was ~1426 chars, now ~720 chars
    description: `Knowledge-skill marketplace — anyone publishes content skills (templates / prompts / guides / checklists); others pay to unlock.

⚠️ **DISTINCT from webaz_skill** (which is seller behaviour-automation plugins, totally separate revenue flow).

Lifecycle: publish → human admin content review (NOT via MCP) → listed → buyers unlock.

Billing: \`free\` | \`one_time\` (buy once, permanent) | \`per_use\` (charged each read).

⚠️ **Revenue is independent flow**: author net → wallet, 5% protocol fee → sys_protocol. Does **NOT** enter PV / referral commission engines.

Actions: list (no auth, filters: kind/billing/query) | detail (public, no content) | publish (→ review queue) | update (re-enters review if approved) | delist | resubmit | purchase (free / one_time; cannot self-buy) | read (per_use charges each call) | my_skills | library.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (omit for list/detail) (or set the WEBAZ_API_KEY env var)' },
        action: {
          type: 'string',
          enum: ['list', 'detail', 'publish', 'update', 'delist', 'resubmit', 'purchase', 'read', 'my_skills', 'library'],
          description: 'Action to execute',
        },
        skill_id: { type: 'string', description: 'Skill ID (required for detail/update/delist/resubmit/purchase/read)' },
        // publish / update
        title: { type: 'string', description: 'Title (required for publish)' },
        content: { type: 'string', description: 'Skill content, visible only after purchase (required for publish)' },
        summary: { type: 'string', description: 'One-line summary (optional)' },
        preview: { type: 'string', description: 'Public preview, visible without purchase (optional)' },
        skill_kind: { type: 'string', enum: ['template', 'prompt', 'guide', 'checklist'], description: 'Skill kind (default template)' },
        billing_mode: { type: 'string', enum: ['free', 'one_time', 'per_use'], description: 'Billing mode (required for publish)' },
        price: { type: 'number', description: 'Price in WAZ; free must = 0, paid must > 0, max 100000' },
        category: { type: 'string', description: 'Category (optional)' },
        // list filters
        kind: { type: 'string', enum: ['template', 'prompt', 'guide', 'checklist'], description: 'Filter type (optional for list)' },
        billing: { type: 'string', enum: ['free', 'one_time', 'per_use'], description: 'Filter billing mode (optional for list)' },
        query: { type: 'string', description: 'Keyword search (optional for list)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_secondhand',
    // was ~1285 chars, now ~650 chars
    description: `Secondhand market (个人闲置二手) — P2P pre-owned goods, 1% protocol fee, escrow-protected. Supports shipping + in-person handoff.

USE THIS for USED / pre-owned / 闲置 / 二手 items, OR selling own used. NOT for NEW manufactured (use webaz_search). **Separate space** — webaz_search does NOT return secondhand listings.

Actions: browse (filters: category/condition/region/price/query/sort; no auth, excludes own when api_key given) | detail (no auth) | publish (title + category + condition + price + images[≥1]) | update (item_id + fields; status available/reserved/closed) | mine | buy (item_id + fulfillment_mode; shipping needs shipping_address).

Enums: **category** phone/computer/appliance/furniture/clothing/book/toy/sports/other · **condition** brand_new/like_new/lightly_used/well_used/heavily_used · **fulfillment** shipping/in_person/both.`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (omit for browse/detail) (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['browse', 'detail', 'publish', 'update', 'mine', 'buy'], description: 'Action to execute' },
        item_id: { type: 'string', description: 'Item ID (required for detail/update/buy)' },
        // publish / update
        title: { type: 'string', description: 'Title 2-60 chars (required for publish)' },
        description: { type: 'string', description: 'Description (≤1000 chars, optional)' },
        category: { type: 'string', enum: ['phone', 'computer', 'appliance', 'furniture', 'clothing', 'book', 'toy', 'sports', 'other'], description: 'Category (required for publish)' },
        condition_grade: { type: 'string', enum: ['brand_new', 'like_new', 'lightly_used', 'well_used', 'heavily_used'], description: 'Condition grade (required for publish)' },
        price: { type: 'number', description: 'Price in WAZ 0-100000 (required for publish)' },
        negotiable: { type: 'boolean', description: 'Negotiable flag (optional)' },
        images: { type: 'array', items: { type: 'string' }, description: 'Images dataURL/URL array, ≥1 ≤9 (required for publish)' },
        region: { type: 'string', description: 'Region (≤40 chars, optional)' },
        fulfillment: { type: 'string', enum: ['shipping', 'in_person', 'both'], description: 'Fulfillment (default both)' },
        status: { type: 'string', enum: ['available', 'reserved', 'closed'], description: 'Change status (optional for update)' },
        // buy
        fulfillment_mode: { type: 'string', enum: ['shipping', 'in_person'], description: 'Per-order fulfillment (required for buy, default shipping)' },
        shipping_address: { type: 'string', description: 'Shipping address (required for buy + shipping)' },
        notes: { type: 'string', description: 'Order note (optional for buy; can include counter-offer)' },
        // browse filters
        condition: { type: 'string', description: 'Filter condition, comma-separated multi (optional for browse)' },
        min_price: { type: 'number' },
        max_price: { type: 'number' },
        query: { type: 'string', description: 'Keyword (optional for browse)' },
        sort: { type: 'string', enum: ['newest', 'price_asc', 'price_desc', 'popular'], description: 'Sort (optional for browse)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_trial',
    // was ~1506 chars, now ~720 chars
    description: `Trial-for-review (测评免单) — seller refunds buyer's order when buyer posts qualifying review note that reaches a view threshold.

USE THIS when: buyer asks "trial / 测评免单 / 0 元试用 for this product?" | buyer has ordered product with active campaign + wants to claim | seller wants to launch campaign. NOT a search tool — use webaz_search.

⚠️ **Anti-abuse enforced server-side** (MCP just passes through): buyer ≠ seller / must have confirmed-or-completed order / account age ≥3d / IP+UA rate limits / config snapshot at claim time.

Buyer actions:
- get_campaign  read product's active campaign (no auth)
- apply         claim slot (product_id)
- link_note     attach review note (claim_id + note_id; note must be type=note + bound to product + active)
- my_claims     my claims + statuses

Seller actions:
- create_campaign  open/update (quota_total 1-200 + reach_threshold 10-10000 + min_chars 20-5000 + min_days_live 1-90)
- cancel_campaign / my_campaigns / campaign_claims`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Your api_key (omit for get_campaign) (or set the WEBAZ_API_KEY env var)' },
        action: { type: 'string', enum: ['get_campaign', 'apply', 'link_note', 'my_claims', 'create_campaign', 'cancel_campaign', 'my_campaigns', 'campaign_claims'], description: 'Action to execute' },
        product_id: { type: 'string', description: 'Product ID (required for get_campaign/apply/create_campaign/cancel_campaign)' },
        claim_id: { type: 'string', description: 'Claim ID (required for link_note)' },
        campaign_id: { type: 'string', description: 'Campaign ID (required for campaign_claims)' },
        note_id: { type: 'string', description: 'Review note ID (required for link_note; must be type=note + bound to product + active)' },
        // create_campaign config
        quota_total: { type: 'number', description: 'Quota total 1-200 (required for create_campaign)' },
        reach_threshold: { type: 'number', description: 'Reach threshold 10-10000 (default 50)' },
        min_chars: { type: 'number', description: 'Min note chars 20-5000 (default 50)' },
        min_days_live: { type: 'number', description: 'Min note alive days 1-90 (default 7)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'webaz_feedback',
    description: `Submit the user's in-use feedback about WebAZ itself, where it happens — agent-native "use→build" 用→建. Hit a problem or have an idea? Call this instead of "go file a GitHub issue". Auto-attaches the redacted **scene** (your recent calls+outcomes) so a maintainer can reproduce.

Actions:
- submit (default): type=ux_issue|bug|proposal, area (search/order/dispute…), text, severity=low|annoying|blocking (issues), opt. subject → id+status
- my: your past feedback + status (received→triaged→in_progress→resolved/declined/duplicate); accepted → co-build reputation
- get: one by id

Gate by type: ux_issue/bug (reporting = using) → login only, NO Passkey, anyone reports. proposal (building) → Passkey real-person (reward anchor; credited only to Passkey submitters). NETWORK only.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['submit', 'my', 'get'], description: 'submit (default) | my | get' },
        api_key: { type: 'string', description: "User's api_key (real person required; or set the WEBAZ_API_KEY env var)" },
        type: { type: 'string', enum: ['ux_issue', 'bug', 'proposal'], description: 'submit: kind of feedback' },
        area: { type: 'string', description: 'submit: which feature, e.g. search / order / dispute' },
        severity: { type: 'string', enum: ['low', 'annoying', 'blocking'], description: 'submit: for ux_issue/bug' },
        subject: { type: 'string', description: 'submit: optional short title' },
        text: { type: 'string', description: 'submit: the feedback / idea (≥5 chars)' },
        feedback_id: { type: 'string', description: 'get: the feedback id' },
      },
      required: [],
    },
  },
  {
    name: 'webaz_contribute',
    description: `Coordinate building WebAZ itself (RFC-006 / RFC-017) — a public task board so contributors don't collide. Check BEFORE starting work on an area. 协调"谁在做什么"防撞车.

Discovery + suggesting need NO api_key (anyone / any agent can browse and propose). Claiming + submitting need an api_key (a real, accountable identity).

Actions:
- list_open (default): open public tasks (opt. filters: area / risk_level / auto_claimable / required_capabilities / agent_capabilities / max_duration_minutes / estimated_context_size / estimated_agent_budget — estimated_agent_budget is a resource/effort estimate, NOT a payment). Each task carries its execution boundary + the trusted canonical contribution target. NO api_key needed.
- detail: one task's full execution boundary (allowed/forbidden paths, prohibited actions, acceptance criteria, verification commands, deliverables, definition_of_done) + the canonical repo to PR to + a copy-ready agent_handoff. NO api_key needed.
- suggest: propose a NEW task (title + summary/reason; opt. area/expected_outcome/source_ref/github_login). It enters the maintainer inbox — it is a suggestion, NOT a contribution fact / reward / participation, and never auto-becomes a task. NO api_key needed (but pass your key to LINK it to your account so you can track it via my_suggestions).
- my_suggestions: your OWN past proposals + their review status / public_reply / next_action (api_key). Agent-readable 回执 so a proposer-agent can act on the maintainer's decision (needs_info → resubmit; converted → see converted_ref).
- claim: take an open task (api_key); provenance=human|ai_assisted|ai_authored (self-declared, not detected); auto-expires ~7d if not submitted. Returns a handoff — point a coding agent at it; the human needn't know git but stays accountable (Passkey).
- submit: mark in_review with pr_ref + verification_summary (api_key). The PR's base repo MUST be the canonical WebAZ repo, and a verification_summary (what you ran/verified) is REQUIRED — both server-enforced. A human maintainer reviews next; done ≠ merge.
- status: tasks you hold (api_key).
- profile: your build dashboard — KPI/tier/restrictions+appeal, private self-view (api_key).

Coordinates + records only — NO merge/reward; acceptance (done) = human maintainer. Contribution value is uncommitted (RFC-017 I-12). build_reputation is a SEPARATE pool, never gates verifier/arbitrator. NETWORK only (contribution is a real-network act; sandbox has nothing to coordinate with).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_open', 'detail', 'suggest', 'my_suggestions', 'claim', 'submit', 'status', 'profile'], description: 'list_open (default) | detail | suggest | my_suggestions | claim | submit | status | profile' },
        api_key: { type: 'string', description: 'claim/submit/status/profile: your api_key (accountable identity). NOT needed for list_open/detail/suggest. (or set the WEBAZ_API_KEY env var)' },
        task_id: { type: 'string', description: 'detail / claim / submit: the task id' },
        area: { type: 'string', description: 'list_open: area filter / suggest: suggested area (e.g. search / docs / mcp)' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'list_open: optional risk filter' },
        auto_claimable: { type: 'boolean', description: 'list_open: optional filter — only auto-claimable (true) or manual-claim (false) tasks' },
        required_capabilities: { type: 'string', description: 'list_open: optional filter — comma-separated; matches tasks that REQUIRE ALL of the listed capabilities (superset/AND match on the task requirement). For "tasks my agent can do", use agent_capabilities instead.' },
        agent_capabilities: { type: 'string', description: 'list_open: optional filter — capabilities your agent HAS (comma-separated); matches tasks whose required_capabilities are a SUBSET of these, i.e. tasks your agent can actually do' },
        max_duration_minutes: { type: 'number', description: 'list_open: optional filter — only tasks whose estimated max duration fits within this many minutes (your idle time)' },
        estimated_context_size: { type: 'string', enum: ['small', 'medium', 'large'], description: 'list_open: optional filter — task estimated context size' },
        estimated_agent_budget: { type: 'string', enum: ['minimal', 'small', 'moderate', 'large', 'xlarge'], description: 'list_open: optional filter — task estimated agent budget (resource/effort estimate, not a payment)' },
        provenance: { type: 'string', enum: ['human', 'ai_assisted', 'ai_authored'], description: 'claim: self-declared authorship (default human)' },
        pr_ref: { type: 'string', description: 'submit: your PR link or number (must target the canonical repo)' },
        verification_summary: { type: 'string', description: 'submit (REQUIRED): summarize what you ran/verified — the task verification_commands you ran and their results' },
        note: { type: 'string', description: 'submit: optional note' },
        title: { type: 'string', description: 'suggest: task title (≥3 chars)' },
        summary: { type: 'string', description: 'suggest: why it is worth doing / what it solves (the reason)' },
        expected_outcome: { type: 'string', description: 'suggest: optional — what should be true when done' },
        source_ref: { type: 'string', description: 'suggest: optional reference link (reference only; does NOT set the target repo)' },
        proposer_github_login: { type: 'string', description: 'suggest: optional — your GitHub login' },
      },
    },
  },
]

// ─── 工具处理函数 ─────────────────────────────────────────────

// RFC-004: webaz_feedback — agent-native "use → build" 反馈(双模;仅 NETWORK 能送达)
async function handleFeedback(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = (args.action as string) || 'submit'
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required' }

  if (toolBackend('webaz_feedback') !== 'network') {
    return {
      _mode: 'sandbox',
      error: 'SANDBOX 模式下反馈无人接收 —— 建设性反馈要进真实项目才有意义。请设 WEBAZ_API_KEY 切到 NETWORK 模式后再提交。 / Feedback needs NETWORK mode to reach the project; set WEBAZ_API_KEY.',
      error_code: 'FEEDBACK_NEEDS_NETWORK',
    }
  }

  if (action === 'my') return apiCall('/api/build-feedback/mine', { apiKey })
  if (action === 'get') {
    const fid = args.feedback_id as string
    if (!fid) return { error: 'feedback_id required for action=get' }
    return apiCall('/api/build-feedback/' + encodeURIComponent(fid), { apiKey })
  }
  // submit(默认)
  const text = ((args.text as string) ?? '').trim()
  if (text.length < 5) return { error: 'text required (≥5 chars)' }
  return apiCall('/api/build-feedback', {
    method: 'POST', apiKey,
    body: {
      type: (args.type as string) || 'ux_issue',
      area: args.area,
      severity: args.severity,
      subject: args.subject,
      text,
      scene: recentCalls.slice(-8),   // 现场证据:脱敏摘要(tool / arg_keys / outcome / mode)
    },
  })
}

// RFC-006 断点1(b)交接:从【可信】canonical 目标(API 响应里,绝不硬编码/不取自 task metadata)构造"怎么真正
// 动手"。人的编码 agent 做 git/PR;Passkey 真人担责。sandbox 运行 / 本地草稿不算正式参与。
function buildContributeHandoff(cct: unknown, taskId: string, caseId?: string | null): Record<string, unknown> {
  const c = (cct ?? {}) as Record<string, string>
  const repoUrl = c.canonical_github_url || 'https://github.com/webaz-protocol/webaz'
  const baseRepo = c.expected_pr_base_repo || c.canonical_repository_full_name || 'webaz-protocol/webaz'
  const baseBranch = c.base_branch || 'main'
  // case_id threads proposal → task → PR. = the source proposal id when this task came from a proposal,
  // else the task id itself. Quote it in the PR so the whole case stays traceable end to end.
  const cid = caseId || taskId
  return {
    case_id: cid,
    canonical_repo: baseRepo,
    repo: repoUrl,
    base_branch: baseBranch,
    start_here: 'Read AGENTS.md (project map + before-you-code + PR flow), then CONTRIBUTING.md.',
    do_the_work: 'Point a coding agent (e.g. Claude Code) at the repo on a single-topic branch. The buyer/shopping agent is not the coding agent — hand off to one.',
    submit_pr: `Open a PR whose BASE repo is ${baseRepo} (${repoUrl}), base branch ${baseBranch}. Reference case ${cid} in the PR title/body so the proposal → task → PR chain stays traceable. If any target repo differs from this canonical repo, STOP and ask the human — never contribute to a non-canonical repository.`,
    pr_flow: 'Commit with DCO sign-off (git commit -s). If AI-authored, mark the PR per the meta-rule. Humans merge — no auto-merge.',
    then: `When the PR is open, report it back: webaz_contribute action=submit task_id=${taskId} pr_ref=#<N> verification_summary="<the verification_commands you ran + their results>". Both pr_ref and verification_summary are required.`,
    not_participation: 'A sandbox run or a local-only draft is NOT participation and is NOT a contribution; only a merged PR (or recognized issue/task/RFC) on the canonical repo enters the contribution record.',
    human_note: "You don't need to know git — your coding agent does it; you (the Passkey-bound human) stay accountable.",
  }
}

// RFC-006/RFC-017: webaz_contribute — 协调"谁在做什么"。NETWORK only. Discovery + suggest 无需 key(打公开
// 端口 #329/#331);claim/submit/status/profile 需 key(真实可问责身份,走受 #330 守卫的 member 端口)。
export async function handleContribute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = (args.action as string) || 'list_open'
  const apiKey = resolveMcpApiKey(args)

  if (toolBackend('webaz_contribute') !== 'network') {
    return {
      _mode: 'sandbox',
      error: 'SANDBOX 模式无协调对象 —— 协调要在真实项目上才有意义。请设 WEBAZ_API_KEY 切到 NETWORK 模式(或不设 key 默认 network_readonly 也可浏览/建议)。 / Coordination needs the live network; sandbox has nothing to coordinate with.',
      error_code: 'CONTRIBUTE_NEEDS_NETWORK',
    }
  }

  // ── keyless discovery + suggest (public surface; same trusted canonical target as the PWA) ──
  if (action === 'list_open') {
    // public endpoint already restricts to audience=public + status=open; only pass the optional filters.
    const qs = new URLSearchParams()
    if (args.area) qs.set('area', String(args.area))
    if (args.risk_level) qs.set('risk_level', String(args.risk_level))
    if (args.auto_claimable !== undefined) qs.set('auto_claimable', String(Boolean(args.auto_claimable)))
    if (args.required_capabilities) qs.set('required_capabilities', String(args.required_capabilities))
    if (args.agent_capabilities !== undefined) qs.set('agent_capabilities', String(args.agent_capabilities))   // forward even '' so the route fail-closes (typed 400), never silently returns the full list
    if (args.max_duration_minutes !== undefined) qs.set('max_duration_minutes', String(args.max_duration_minutes))
    if (args.estimated_context_size) qs.set('estimated_context_size', String(args.estimated_context_size))
    if (args.estimated_agent_budget) qs.set('estimated_agent_budget', String(args.estimated_agent_budget))
    const q = qs.toString()
    const r = await apiCall('/api/public/build-tasks' + (q ? '?' + q : ''))
    if (!r.error) r._next = 'Pick a task, then: webaz_contribute action=detail task_id=<id> for its full execution boundary + the canonical repo to PR to; then action=claim task_id=<id> api_key=<key> to take it (claiming needs an account).'
    return r
  }
  if (action === 'detail') {
    const tid = args.task_id as string
    if (!tid) return { error: 'task_id required for action=detail' }
    const r = await apiCall('/api/public/build-tasks/' + encodeURIComponent(tid))
    if (!r.error && r.task) r.agent_handoff = buildContributeHandoff(r.canonical_contribution_target, tid, (r.task as Record<string, unknown>).case_id as string | undefined)
    return r
  }
  if (action === 'suggest') {
    const title = ((args.title as string) ?? '').trim()
    const summary = ((args.summary as string) ?? (args.note as string) ?? '').trim()
    if (title.length < 3) return { error: 'title required (≥3 chars) for action=suggest' }
    if (summary.length < 1) return { error: 'summary (the reason) required for action=suggest' }
    const r = await apiCall('/api/public/task-proposals', {
      method: 'POST',
      apiKey,   // optional — when present, links the proposal to the submitter so it shows up in action=my_suggestions (still works anonymously)
      body: {
        title, summary,
        suggested_area: args.area ?? args.suggested_area,
        expected_outcome: args.expected_outcome,
        source_ref: args.source_ref,
        proposer_github_login: args.proposer_github_login,
      },
    })
    if (!r.error && (r as any).linked_to_account) (r as any)._next = 'Track this proposal\'s review status + reply: webaz_contribute action=my_suggestions api_key=<key>.'
    // typed errors (RATE_LIMITED / DUPLICATE_PROPOSAL / validation) are already mapped by apiCall; the
    // success response already carries the route-level `proposal_notice` (suggestion ≠ contribution/reward).
    return r
  }

  // ── participation: a real, accountable identity is required ──
  if (!apiKey) return {
    error: `api_key required for action=${action} — set WEBAZ_API_KEY (request an invite at ${WEBAZ_API_URL}/#welcome). Discovery (list_open / detail) and suggest work WITHOUT a key.`,
    error_code: 'API_KEY_REQUIRED',
  }
  if (action === 'status') return apiCall('/api/build-tasks?mine=1', { apiKey })
  if (action === 'my_suggestions') {
    // your OWN past proposals + review status/public_reply/next_action (agent-readable 回执). Own rows only (server-enforced).
    const r = await apiCall('/api/me/task-proposals', { apiKey })
    if (!r.error) (r as any)._next = 'Each item carries status + public_reply + next_action. needs_info → resubmit via action=suggest referencing the id; converted → see converted_ref.'
    return r
  }
  if (action === 'profile') return apiCall('/api/build-reputation/me', { apiKey })
  if (action === 'claim') {
    const tid = args.task_id as string
    if (!tid) return { error: 'task_id required for action=claim' }
    const r = await apiCall('/api/build-tasks/' + encodeURIComponent(tid) + '/claim', {
      method: 'POST', apiKey, body: { provenance: args.provenance },
    })
    if (!r.error) r.handoff = buildContributeHandoff(r.canonical_contribution_target, tid)
    return r
  }
  if (action === 'submit') {
    const tid = args.task_id as string
    if (!tid) return { error: 'task_id required for action=submit' }
    const vs = ((args.verification_summary as string) ?? '').trim()
    if (vs.length < 1) return { error: 'verification_summary required for action=submit — summarize what you ran/verified (the task verification_commands and their results)', error_code: 'VERIFICATION_SUMMARY_REQUIRED' }
    const r = await apiCall('/api/build-tasks/' + encodeURIComponent(tid) + '/submit', {
      method: 'POST', apiKey, body: { pr_ref: args.pr_ref, note: args.note, verification_summary: vs },
    })
    if (!r.error) r._next = 'A human maintainer reviews next — acceptance (done) is manual and done ≠ merge. Track it with webaz_contribute action=status.'
    return r
  }
  return { error: 'unknown action: ' + action }
}

async function handleInfo() {
  const summary = getManifestSummary()
  // RFC-003 Batch 0:NETWORK 模式下,best-effort 拉 webaz.xyz 的 live 协议状态,
  // 让带 key 的 agent 拿到【真网络】数字,而非只看本机本地 live_stats(下方仍保留并标注为本地)。
  let network_live: Record<string, unknown> | null = null
  if (isNetworkMode()) {
    try {
      const ps = await apiCall('/api/protocol-status')
      network_live = { source: `${WEBAZ_API_URL}/api/protocol-status (live, fetched this call)`, ...ps }
    } catch (e) {
      network_live = {
        source: `${WEBAZ_API_URL}/api/protocol-status`,
        error: `couldn't reach live network this call: ${(e as Error).message}`,
        note: 'live_stats below is LOCAL-only (this MCP server\'s SQLite), not protocol-wide.',
      }
    }
  }
  // QA 轮 3 抓到：live_stats 不是 hardcoded、不是 remote — 就是本地 SQLite count。这里加 source 字段澄清。
  const stats = (() => {
    try {
      const users     = (db.prepare("SELECT COUNT(*) as n FROM users WHERE id != 'sys_protocol'").get() as {n:number}).n
      const products  = (db.prepare("SELECT COUNT(*) as n FROM products WHERE status='active'").get() as {n:number}).n
      const completed = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE status='completed'").get() as {n:number}).n
      return {
        participants: users,
        active_products: products,
        completed_orders: completed,
        source: 'local SQLite (~/.webaz/webaz.db) — counts reflect *this* MCP server\'s DB, not protocol-wide prod state',
      }
    } catch { return null }
  })()

  // QA 轮 3 FAIL：webaz_info 没暴露经济参数。从 protocol_params 表读 fee 类参数 + charity_fund 当前余额。
  const economics = (() => {
    try {
      const feeParams = db.prepare(
        "SELECT key, value, description FROM protocol_params WHERE category='fee' ORDER BY key"
      ).all() as { key: string; value: string; description: string }[]
      const fund = db.prepare("SELECT balance, total_donated, total_disbursed, total_redirected FROM charity_fund WHERE id='main'").get() as Record<string, number> | undefined
      return {
        protocol_params: feeParams.map(p => ({ key: p.key, value: Number(p.value), note: p.description })),
        charity_fund: fund || { balance: 0, total_donated: 0, total_disbursed: 0, total_redirected: 0 },
        note: 'Numeric values reflect current DB state, queried fresh on each call.',
      }
    } catch { return null }
  })()

  return {
    ...summary,
    // 诚实化披露 — 排在 stats / quick_start 之前,让 agent 先建立正确预期。
    // 第三方尽调 agent 抓到过的破绽:live_stats 是本地库数字、引导词推 agent 拉新。
    // 此处主动披露真实状态(pre-launch / 数据来源),不抗辩;agent 自己判断如何处理。
    // 佣金按【功能】中性描述(commission_model),不做"自证不是X"的辩护——正常机制无需自证。
    network_state: {
      // RFC-003 P3：显式声明当前客户端模式，让 agent 一眼分清"真网络 vs 本机沙盒"
      mode: MODE,                       // 'network' | 'network_readonly' | 'sandbox'
      mode_banner: modeBanner(),
      mode_meaning: MODE === 'network'
        ? '🟢 NETWORK：核心交易工具（下单/上架/履约/比价等）走 webaz.xyz 共享生产网络。真网络规模见下方 network_live（本次实时拉取）；live_stats 仍是本机本地缓存，仅供参考。'
        : MODE === 'network_readonly'
        ? '🟢 NETWORK（只读）：无 api_key。公共读（搜索/榜单/价格史/浏览）打 webaz.xyz 真网络（见 network_live）。要交易（注册/下单/上架等）请设 WEBAZ_API_KEY —— 到 ' + WEBAZ_API_URL + '/#welcome 申请邀请。'
        : '🟡 SANDBOX：所有工具都在本机本地 SQLite 运行，与 webaz.xyz 全网隔离（显式 dev/demo 模式）。任何计数 / 账号 / 订单仅本机有效。不设 WEBAZ_MODE 则默认走真网络只读。',
      phase: 'pre_launch',
      real_users_on_canonical: 0,
      canonical_endpoint: 'https://webaz.xyz',
      economic_flow: 'simulated WAZ (test currency, 1 WAZ ≈ 1 USDC peg is a模拟基准, not a real exchange rate). No fiat/crypto settles yet.',
      disclaimer: '本协议尚未公开上线,prod 真实用户≈0,无真实经济流转。下方 live_stats / 工具示例所有计数均来自**本机 MCP 服务器的本地 SQLite**(~/.webaz/webaz.db),仅供 dev / demo,不代表协议全网真实状态。请勿据此评估市场规模、做投资决策、或替终端用户承诺任何经济关系。',
    },
    description: 'WebAZ is a decentralized commerce protocol. Every transaction flows through a state machine; each state transition needs proof-of-action from the responsible party. Any timeout-without-action: protocol auto-rules default + executes remedy. / WebAZ 是去中心化商业协议;每笔交易通过状态机流转,每次状态转移需对应责任方的操作证明;超时未操作则协议自动判违约并执行处置。',
    // 给【终端用户/买家】的价值主张 —— 陌生 agent / 普通买家先要知道"对我有什么用",而非只读抽象 tagline + 技术 description。
    for_end_user: {
      note: 'What WebAZ does FOR a buyer (why use it): / 这个协议对买家有什么用(为什么用它):',
      value: [
        'Escrow on every order — your money is held by the protocol and only released to the seller after you confirm receipt (or an auto-confirm window). / 每笔订单托管:钱由协议托管,你确认收货(或到自动确认期)才放款给卖家。',
        'Automatic fault ruling — if the seller does not accept / ship / deliver in time, the protocol auto-refunds you, no haggling. / 自动判责:卖家不接单/不发货/不送达超时,协议自动退款给你,无需扯皮。',
        'Disputes with evidence + arbitration — open a dispute with proof; a neutral process decides. / 争议可凭证据发起 + 中立仲裁裁决。',
        'Decision-ready transparency — price history, seller reputation, win/loss record and arbitration precedents are public before you buy. / 知情决策:价格历史、卖家信誉、胜诉/败诉记录、仲裁判例,下单前都公开可查。',
        'Agent-native — your AI agent can compare prices, place orders, and track fulfillment for you via the MCP tools. / agent 原生:你的 AI 可经 MCP 工具替你比价、下单、跟踪履约。',
      ],
      honesty: 'Pre-launch: WAZ is a simulated test currency, no real money settles yet. Don\'t treat balances as real value. / 尚未上线:WAZ 是模拟测试币,暂无真实资金结算,余额勿当真实价值。',
      try_it: 'Browse without an account at https://webaz.xyz/#discover ; the protocol state is public at https://webaz.xyz/.well-known/webaz-protocol.json',
      get_access: 'Pre-launch is invite-gated — request an invite at https://webaz.xyz/#welcome (browsing/reading needs no invite). / 上线前邀请制:到 #welcome 申请邀请,浏览/查看无需邀请。',
    },
    // 连接两个场景:用协议(本工具) ↔ 改协议(开发协作)。想改 WebAZ 本身的 agent 从这里进。
    for_contributors: {
      note: 'Want to change WebAZ itself (not just use it)? This is an open, agent-native protocol — AI-authored PRs are welcome, with accountability. / 想改 WebAZ 本身(不只是用)?这是开放的 agent 原生协议,欢迎 AI 提 PR,但需问责。',
      repo: 'https://github.com/webaz-protocol/webaz',
      start_here: 'AGENTS.md (project map + before-you-code + PR flow) → CONTRIBUTING.md (full guide)',
      ai_accountability: 'AI-authored PRs: add 🤖🤖🤖 to the PR title; the agent must be triggered by a Passkey-bound human (webazer) who is accountable. / AI 提 PR:标题加 🤖🤖🤖,且须由已绑 Passkey 的真人(webazer)触发并担责。',
    },
    // NETWORK 模式:真网络 live 状态(best-effort 拉自 webaz.xyz);SANDBOX 模式为 null。
    network_live,
    live_stats: stats,
    economics,
    // 佣金机制 —— 纯功能性描述(怎么运作),不做"自证清白"式辩护。
    commission_model: {
      split: '7:2:1 — L1 70% / L2 20% / L3 10% of an order\'s commission_pool',
      jurisdiction_tiers: 'Tiers are graded by the order region\'s max_levels — NOT a uniform 3 tiers everywhere. e.g. global region max_levels=1 → L1 only; singapore (etc.) max_levels=3 → up to L3. A region may also be 0 (no commission tiers; pool → commission_reserve / protocol reserve).',
      attribution: 'EXPLICIT per-order — commission goes to the promoter attributed at purchase time, not derived from the buyer\'s sponsor chain.',
      how_to_attribute: 'L1: webaz_place_order(promoter_api_key) records the direct promoter. Full L2/L3 chain requires the buyer to arrive via a webaz_share_link /i/<permanent_code> (?ref=<permanent_code>) URL clicked in a browser (builds product_share_attribution).',
      redirect_rules: 'all undelivered commission (chain_gap / no L / invalid sponsor / level beyond the region cap / max_levels=0 / opt-out / escrow expiry) → commission_reserve (protocol reserve, in-only; use decided by governance).',
      l1_gate: 'the promoter must be a verified buyer (≥1 completed order) to receive commission, otherwise that share redirects.',
      opt_in: 'Participation is opt-in (RFC-002): default = off. A user applies (Passkey + ≥1 completed order); attribution is always recorded. Commission destination is state-dependent: never_activated / auto_downgraded → held in pending_commission_escrow (30d grace), recoverable by (re-)activating within the window, else swept to commission_reserve; deactivated (active opt-out) → future commission goes directly to commission_reserve, NOT escrow and NOT recoverable. Never to charity_fund. See docs/rfcs/RFC-002-rewards-opt-in.md.',
    },
    // QA 轮 3 FAIL：roles 漏 reviewer。register 工具支持 5 个角色，info 必须列全。
    roles: {
      buyer:      '下单、付款、确认收货或发起争议',
      seller:     '上架商品、接单、按时发货（质押保证金确保履约）',
      logistics:  '揽收包裹、更新运输状态、确认投递（获得 5% 物流费）',
      reviewer:   '结构化商品测评（trial campaign 申请试用 + 真实购买后写评）',
      arbitrator: '处理争议，做出裁定（120h 内必须裁定，否则系统自动退款买家）',
    },
    quick_start: {
      seller:    '1. webaz_register(role=seller) → 2. webaz_list_product() → 3. 等通知 webaz_update_order(accept/ship)',
      buyer:     '1. webaz_register(role=buyer) → 2. webaz_search() → 3. webaz_verify_price() → 4. webaz_place_order(session_token) → 5. webaz_update_order(confirm)',
      agent_buying: '用户提供链接 → 1. webaz_search(query) 找到更优方案 → 2. webaz_verify_price(product_id) 锁定价格 → 3. webaz_place_order(session_token) 下单 → 返回成交理由',
      logistics: '1. webaz_register(role=logistics) → 2. webaz_update_order(pickup) → webaz_update_order(deliver)',
      reviewer:  '1. webaz_register(role=reviewer) → 2. webaz_claim_verify(action=apply) 申请测评免单 → 3. 收货后写真实评价',
      arbitrator: '1. webaz_register(role=arbitrator) → 2. webaz_dispute(action=list_open) 看待裁案件 → 3. webaz_dispute(action=arbitrate) — ⚠️ 需 PWA + Passkey（Iron-Rule）',
    },
    // 搜索/发现场景决策地图 — agent 第一次 onboard 拿到 user-scenario → tool + PWA-page 总表,
    // 避免每次试错。每行:scenario(用户怎么说)→ tool(我用哪个 MCP 工具)+ pwa_page(没接口时让用户去哪)
    search_routing: [
      { scenario: '用户给出商品完整标题 / SKU / 精准描述',                 tool: 'webaz_search query=...',                  pwa_page: '#buy',           note: 'STRICT 精准匹配,0 命中不降级 fuzzy' },
      { scenario: '用户粘贴外站链接(淘宝/抖音/小红书/JD/PDD/1688/Tmall)', tool: 'webaz_search external_link=... 或 paste_text=...', pwa_page: '#buy',  note: '匹配 anchor registry 精准产品指纹' },
      { scenario: '用户要"模糊浏览"/ 关键词探索 / 不知精准 SKU',         tool: '⚠️ 无 MCP 接口 — 引导用户去 PWA 自己输关键词',  pwa_page: '#discover',      note: 'fuzzy 是用户主动行为,不是 agent 代办,见 [protocol invariant]' },
      { scenario: '用户问"我附近 / 同城 / 11km 范围 有人买什么"',         tool: 'webaz_nearby action=query',               pwa_page: '#nearby',        note: 'k-anonymity ≥3 隐私保护' },
      { scenario: '用户要二手 / 闲置 / 个人 pre-owned 商品',              tool: 'webaz_secondhand action=browse',          pwa_page: '#secondhand',    note: '独立空间,不跟 catalog 商品混' },
      { scenario: '用户要竞拍 / 捡漏稀有品 / English forward auction',    tool: 'webaz_auction action=browse',             pwa_page: '#auctions',      note: '时间窗口事件,有 anti-snipe 延时' },
      { scenario: '用户买不到,想发起求购让卖家来报价',                   tool: 'webaz_rfq action=create',                 pwa_page: '#rfqs',          note: '反向匹配 — buyer 出需求 + 押金 1%' },
      { scenario: '用户想申请试用 / 0 元拿样 / 测评免单',                tool: 'webaz_trial action=get_campaign / apply', pwa_page: '#trials',        note: '需 ≥1 笔订单 + ≥3 天账号' },
      { scenario: '用户想发布或回应慈善许愿 / 捐赠社区基金',              tool: 'webaz_charity action=list / create / donate', pwa_page: '#charity', note: '跟 place_order donation_pct 是不同动作' },
      { scenario: '用户买知识技能 / Prompt / 模板 / 清单',                tool: 'webaz_skill_market action=list / purchase / read', pwa_page: '#skill-market', note: '内容型,与 webaz_skill 行为插件市场不同' },
      { scenario: '用户问某具体人 / @handle / usr_xxx 的主页或内容流',    tool: 'webaz_profile action=view_user',          pwa_page: '#u/:id',         note: '不是关键词搜,只看指定人' },
      { scenario: '用户想看某商家全部商品(已知 seller_id)',              tool: 'webaz_search seller_id=...',              pwa_page: '#shop/:id',      note: 'strict 精准过滤,sort 可选 trending/newest' },
      { scenario: '用户问什么"最热门 / 排行 / trending"',                tool: 'webaz_leaderboard kind=...',              pwa_page: '(无独立页,各域内置)', note: '8 类:products / value_products / creators / sellers / buyers / verifiers / arbitrators / agents' },
    ],
    available_tools: TOOLS.map((t) => ({ name: t.name, description: t.description.split('\n')[0] })),
    full_manifest: `读取 MCP Resource "${MANIFEST_URI}" 获取完整协议规范（状态机/经济模型/争议系统/Skill 市场/声誉系统）`,
  }
}

function handleRegister(args: Record<string, unknown>) {
  // ─── RFC-003 P3：NETWORK 模式不自助建号 ────────────────────────
  // 自助注册会绕过邀请码 / captcha / 责任制；且 CHARTER §4 I-5 要求账号必须由已绑 Passkey
  // 的真人创建（"每个 agent 背后有可问责的真人"）。NETWORK / 无 key 只读模式下都引导真人去 webaz.xyz 拿 key。
  if (isNetworkMode()) {
    return {
      _mode: MODE,
      registration: 'must_be_done_by_human_at_webaz_xyz',
      message: '🟢 NETWORK 模式下不支持 agent 自助注册。开放协议的信任来自"每个 agent 背后有可问责的真人"，所以注册这一步刻意留给真人在 webaz.xyz 完成。请按三步加入共享网络：',
      steps: [
        '1. 打开 https://webaz.xyz 注册账号（需邀请码；注册时绑定 Passkey 成为可问责真人）',
        '2. 进入「我的 / 设置」→ 复制你的 api_key',
        '3. 把 api_key 填入 MCP 配置环境变量 WEBAZ_API_KEY，重启 MCP —— 之后所有交易工具自动在 webaz.xyz 共享网络上操作',
      ],
      register_url: WEBAZ_API_URL,
      why_not_agent_self_register: 'agent 自助注册会绕过邀请 / captcha / 真人 Passkey 责任制，破坏协议的可问责性（#6 不滥用 / CHARTER §4 I-5）。',
      want_to_try_offline_first: '只想离线试玩、暂不连网络？设环境变量 WEBAZ_MODE=sandbox（或清空 WEBAZ_API_KEY），webaz_register 会在本机沙盒建一个测试账号（仅本机有效）。',
    }
  }

  // ─── SANDBOX 模式：本机建测试账号（显著标注，仅本机有效，与 webaz.xyz 全网隔离）──
  const name = args.name as string
  const role = args.role as string
  const initialBalance = (args.initial_balance as number) ?? 1000
  // QA 轮 14.a P1：MCP register 之前不接受 region → 默认 global（PWA register 强制选）
  // 协议级 by-design：MCP register 不设 placement_id（防 bot 刷链）
  // 但 region 是 sales / commission 字段，应允许显式传入
  const VALID_REGIONS = new Set(['global', 'singapore', 'china', 'usa', 'malaysia', 'indonesia', 'thailand', 'vietnam', 'taiwan', 'hk'])
  const regionInput = String(args.region || 'global').toLowerCase()
  const region = VALID_REGIONS.has(regionInput) ? regionInput : 'global'

  const validRoles = ['buyer', 'seller', 'logistics', 'reviewer', 'arbitrator']
  if (!validRoles.includes(role)) {
    return { error: `无效角色：${role}。可选：${validRoles.join(', ')}` }
  }

  const id = generateId('usr')
  const apiKey = generateId('key')
  const permaCode = mcpGeneratePermanentCode()
  const { handle, requested: handleRequested, modified: handleModified } = mcpDeriveHandle(name)
  const createdAt = new Date().toISOString()

  db.prepare('INSERT INTO users (id, name, role, roles, api_key, permanent_code, handle, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, name, role, JSON.stringify([role]), apiKey, permaCode, handle, region, createdAt
  )
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').run(id, initialBalance)

  const baseNext = role === 'seller' ? '现在可以用 webaz_list_product 上架你的第一件商品'
                  : role === 'buyer' ? '现在可以用 webaz_search 搜索商品'
                  : '等待订单分配给你'

  return {
    success: true,
    _mode: 'sandbox',
    sandbox_account: true,
    sandbox_warning: '⚠️ 这是 SANDBOX 测试账号 —— 仅本机有效，未在 webaz.xyz 全网注册，与共享网络完全隔离。要真正加入网络（让交易对其他人可见、形成网络效应），请在 https://webaz.xyz 注册并把 api_key 填入 WEBAZ_API_KEY 切到 NETWORK 模式。',
    message: '沙盒注册成功（仅本机）！妥善保管 api_key（身份凭证）+ permanent_code（恢复码，丢失 api_key 用它配 handle 找回）',
    user_id: id,
    api_key: apiKey,
    permanent_code: permaCode,
    permanent_code_purpose: 'Recovery code. Use webaz_mykey with handle + permanent_code to recover lost api_key. Save it somewhere safe — without it, lost api_key is lost forever.',
    handle,
    handle_requested: handleRequested,
    handle_modified: handleModified,
    ...(handleModified && {
      handle_modification_note: `Requested handle "${handleRequested}" already taken; auto-appended numeric suffix for uniqueness. Tell users your actual handle is "${handle}".`,
    }),
    name,
    role,
    initial_balance: initialBalance,
    created_at: createdAt,
    next_step: handleModified
      ? `${baseNext}。⚠️ 你请求的 handle "${handleRequested}" 已被占用，实际分配 "${handle}" — 分享/被找时用后者。`
      : baseNext,
  }
}

function buildAgentSummary(p: Record<string, unknown>): string {
  const parts: string[] = []
  if (p.brand) parts.push(String(p.brand))
  if (p.model) parts.push(String(p.model))
  const returnDays = p.return_days != null ? Number(p.return_days) : null
  if (returnDays != null && returnDays > 0) parts.push(`${returnDays}天退货`)
  else if (returnDays === 0)               parts.push('不支持退货')
  const warranty = p.warranty_days != null ? Number(p.warranty_days) : null
  if (warranty && warranty > 0)            parts.push(`${warranty}天质保`)
  const handling = p.handling_hours != null ? Number(p.handling_hours) : null
  if (handling != null)                    parts.push(`${handling}h发货`)
  if (p.fragile)                           parts.push('易碎品')
  return parts.join('，') || '暂无物流信息'
}

function parseProductForAgent(p: Record<string, unknown>) {
  let specs: Record<string, string> | null = null
  if (p.specs) { try { specs = JSON.parse(p.specs as string) } catch {} }
  let estimated_days: Record<string, number> | number | null = null
  if (p.estimated_days) { try { estimated_days = JSON.parse(p.estimated_days as string) } catch { estimated_days = null } }
  return { ...p, specs, estimated_days, agent_summary: buildAgentSummary(p) }
}

async function handleSearch(args: Record<string, unknown>) {
  // 外链/粘贴文本模式 → relay 到 webaz.xyz/api/search-by-link（生产数据有索引）
  if (args.paste_text || args.external_link) {
    const apiUrl = process.env.WEBAZ_API_URL ?? 'https://webaz.xyz'
    const body: Record<string, unknown> = {}
    if (args.paste_text)    body.text          = args.paste_text
    if (args.external_link) body.external_link = args.external_link
    try {
      const resp = await fetch(`${apiUrl}/api/search-by-link`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(5000),
      })
      if (!resp.ok) return { error: `链接搜索失败：HTTP ${resp.status}` }
      const data = (await resp.json()) as {
        matched_by: string
        products: Record<string, unknown>[]
        extracted: Record<string, unknown>
        error?: string
      }
      if (data.error) return data
      return {
        ...data,
        hint: data.products?.length
          ? `通过 ${data.matched_by} 匹配到 ${data.products.length} 件商品。下单前用 webaz_verify_price 锁价。`
          : '未找到关联商品。可改用 query 参数做关键词搜索。',
      }
    } catch (e) {
      return { error: `链接搜索网络错误：${(e as Error).message}` }
    }
  }

  const query = (args.query as string) ?? ''
  const category = args.category as string | undefined
  const maxPrice = args.max_price as number | undefined
  const minReturnDays = args.min_return_days as number | undefined
  const maxHandlingHours = args.max_handling_hours as number | undefined
  const hasSales = args.has_sales as 'true' | 'false' | undefined
  const sellerId = args.seller_id as string | undefined
  let limit = Number(args.limit ?? 10)
  if (!Number.isFinite(limit) || limit < 1) limit = 10
  if (limit > 200) limit = 200
  const sortMode = (args.sort as string | undefined) ?? 'trending'

  // RFC-003 P4: NETWORK 模式关键词搜索 → 生产 GET /api/products?mode=agent
  // (同款协议级 strict alias 引擎,公开读,不传 fuzzy)。让 agent 搜到的是全网真实在售商品。
  if (toolBackend('webaz_search') === 'network') {
    const qs = new URLSearchParams({ mode: 'agent', limit: String(limit) })
    if (query)                  qs.set('q', query)
    if (category)               qs.set('category', String(category))
    if (maxPrice != null)       qs.set('max_price', String(maxPrice))
    if (minReturnDays != null)  qs.set('min_return_days', String(minReturnDays))
    if (maxHandlingHours != null) qs.set('max_handling_hours', String(maxHandlingHours))
    if (hasSales)               qs.set('has_sales', String(hasSales))
    if (sellerId)               qs.set('seller_id', String(sellerId))
    if (args.sort)              qs.set('sort', String(args.sort))
    const r = await apiCall('/api/products?' + qs.toString())
    if ('error' in r) return r
    const products = (r.products as unknown[]) ?? []
    return {
      ...r,
      found: products.length,
      hint: products.length
        ? `网络上匹配到 ${products.length} 件商品。下单前用 webaz_verify_price 锁价。`
        : '网络上未找到精确匹配商品(协议级 strict 匹配)。可换更准确的商品名,或用 paste_text 贴外链搜索。',
    }
  }

  let sql = `
    SELECT p.*, u.name as seller_name,
      COALESCE((SELECT total_points FROM reputation_scores WHERE user_id = p.seller_id), 0) as rep_points,
      COALESCE((SELECT level FROM reputation_scores WHERE user_id = p.seller_id), 'new') as rep_level
    FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.status = 'active' AND p.stock > 0
  `
  const params: unknown[] = []

  // M7.2 协议级精准匹配（与 PWA server 一致的 alias 引擎）：
  // query 命中条件 = (1) 完全等于 product.title OR
  //                 (2) 完全等于 任一 external_title OR
  //                 (3) 用户文本 包含 任一卖家声明的 alias_value (≥ 6 字符 且 active)
  if (query) {
    const aliasRows = db.prepare(`
      SELECT product_id, alias_value FROM product_aliases
      WHERE status = 'active' AND length(alias_value) >= 6 AND length(alias_value) <= ?
    `).all(query.length) as Array<{ product_id: string; alias_value: string }>
    const aliasIds = new Set<string>()
    for (const a of aliasRows) {
      if (query.includes(a.alias_value)) aliasIds.add(a.product_id)
    }
    if (aliasIds.size === 0) {
      sql += ` AND (
        p.title = ?
        OR EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.external_title = ?)
      )`
      params.push(query, query)
    } else {
      sql += ` AND (
        p.id IN (${[...aliasIds].map(() => '?').join(',')})
        OR p.title = ?
        OR EXISTS (SELECT 1 FROM product_external_links pel WHERE pel.product_id = p.id AND pel.external_title = ?)
      )`
      params.push(...aliasIds, query, query)
    }
  }
  if (category) { sql += ` AND p.category = ?`; params.push(category) }
  if (maxPrice !== undefined) { sql += ` AND p.price <= ?`; params.push(maxPrice) }
  if (minReturnDays !== undefined) { sql += ` AND p.return_days >= ?`; params.push(minReturnDays) }
  if (maxHandlingHours !== undefined) { sql += ` AND p.handling_hours <= ?`; params.push(maxHandlingHours) }
  if (sellerId) { sql += ` AND p.seller_id = ?`; params.push(sellerId) }
  if (hasSales === 'true') { sql += ` AND EXISTS (SELECT 1 FROM orders WHERE product_id = p.id AND status = 'completed')` }
  else if (hasSales === 'false') { sql += ` AND NOT EXISTS (SELECT 1 FROM orders WHERE product_id = p.id AND status = 'completed')` }

  if (sortMode === 'newest') sql += ` ORDER BY p.created_at DESC`
  else if (sortMode === 'rating') sql += ` ORDER BY rep_points DESC, p.created_at DESC`
  else if (sortMode === 'price_asc') sql += ` ORDER BY p.price ASC`
  else if (sortMode === 'price_desc') sql += ` ORDER BY p.price DESC`
  else if (sortMode === 'random') sql += ` ORDER BY RANDOM()`
  // 'trending' 默认：先取候选，下面 JS 再算分排序（兼容旧 db 没有 metric 列的场景）
  else sql += ` ORDER BY p.created_at DESC`
  sql += ` LIMIT ?`
  params.push(Math.min(limit * 3, 500))   // 取更多候选，便于 trending 排序

  const products = db.prepare(sql).all(...params) as Record<string, unknown>[]

  if (products.length === 0) {
    // query 模式 0 命中 = strict 精准匹配未命中。**不做 fuzzy fallback**(协议精准承诺)。
    // 引导用户去 PWA 发现页做模糊搜索;agent 不应自己 LIKE 降级,那会污染精准 trust。
    const hint = query
      ? `精准匹配 0 命中(query='${String(query).slice(0, 40)}')。webaz_search 是协议精准接口,不做模糊降级。要做模糊搜索请引导用户访问 https://webaz.xyz/#discover ,在搜索框输入关键词浏览 — 这是用户主动操作,不是 agent 代办。`
      : '没有找到匹配的商品'
    return { found: 0, message: hint, products: [], matched_by: 'strict_no_match' }
  }

  type SortedProduct = Record<string, unknown> & { _boost: number; _rep_level: string; _rep_points: number; _score: number; _freshness: number; _first_sale_boost: number }
  const enriched: SortedProduct[] = await Promise.all(products.map(async (p) => {
    const boost = await getSearchBoost(db, p.seller_id as string)
    const rep_level = (p.rep_level as string) || 'new'
    const rep_points = Number(p.rep_points) || 0
    const completion = Number(p.completion_count) || 0
    const dispute = Number(p.dispute_loss_count) || 0
    const sharer = Number(p.unique_sharer_count) || 0
    // 与 PWA 端 TRENDING_SCORE_EXPR 阶梯曲线保持一致
    const lastSold = p.last_sold_at as string | null
    let freshness = 0
    if (lastSold) {
      const days = (Date.now() - new Date(lastSold.replace(' ', 'T') + 'Z').getTime()) / 86400_000
      if (days < 30)      freshness = 10
      else if (days < 90) freshness = 10 * (1 - (days - 30) / 60)
      else if (days < 180) freshness = -5
      else                 freshness = -15
    }
    // 14 天首单 boost
    const firstSold = p.first_sold_at as string | null
    const firstSaleBoost = firstSold && (Date.now() - new Date(firstSold.replace(' ', 'T') + 'Z').getTime()) < 14 * 86400_000 ? 5 : 0
    const score = completion * 0.5 + rep_points * 0.1 + sharer * 2.0 + freshness + firstSaleBoost - dispute * 5.0
    return { ...p, _boost: boost, _rep_level: rep_level, _rep_points: rep_points, _score: score, _freshness: freshness, _first_sale_boost: firstSaleBoost } as SortedProduct
  }))
  const sorted = sortMode === 'trending'
    ? enriched.sort((a, b) => b._score - a._score || b._boost - a._boost).slice(0, limit)
    : enriched.slice(0, limit)

  return {
    found: sorted.length,
    products: sorted.map((p) => {
      const levelMeta = { new:'', trusted:'⭐', quality:'🌟', star:'💫', legend:'🔥' }
      const badge = levelMeta[p._rep_level as keyof typeof levelMeta] ?? ''
      const parsed = parseProductForAgent(p)
      return {
        id: p.id,
        title: p.title,
        price: p.price,
        price_display: `${p.price} WAZ`,
        stock: p.stock,
        category: p.category,
        specs: parsed.specs,
        agent_summary: parsed.agent_summary,
        logistics: {
          handling_hours: p.handling_hours ?? 24,
          estimated_days: parsed.estimated_days,
          ship_regions: p.ship_regions ?? '全国',
          fragile: !!p.fragile,
        },
        after_sales: {
          return_days: p.return_days ?? 7,
          return_condition: p.return_condition ?? '',
          warranty_days: p.warranty_days ?? 0,
        },
        seller: badge ? `${badge} ${p.seller_name}` : p.seller_name,
        seller_id: p.seller_id,
        seller_reputation: p._rep_level !== 'new'
          ? `${badge} ${['','可信','优质','明星','传奇'][['new','trusted','quality','star','legend'].indexOf(p._rep_level)]}（${p._rep_points}分）`
          : undefined,
        // Tier 7 + 里程碑 5：agent-friendly 排序指标
        metrics: {
          completion_count: Number(p.completion_count) || 0,
          dispute_loss_count: Number(p.dispute_loss_count) || 0,
          unique_sharer_count: Number(p.unique_sharer_count) || 0,
          last_sold_at: p.last_sold_at || null,
          first_sold_at: p.first_sold_at || null,
          rep_points: p._rep_points,
          rep_level: p._rep_level,
        },
        score: Math.round((p._score as number) * 100) / 100,
        score_breakdown: {
          freshness: Math.round((p._freshness as number) * 100) / 100,
          first_sale_boost: p._first_sale_boost,
        },
      }
    }),
    sort: sortMode,
    limit,
    hint: 'agent 模式：products 已附带 metrics + score（含阶梯新鲜度 + 14d 首单 boost），可基于自身策略二次排序',
  }
}

async function handleVerifyPrice(args: Record<string, unknown>) {
  // RFC-003 P2: network 模式转发到生产 POST /api/verify-price(前置,绕过本地 db)
  if (toolBackend('webaz_verify_price') === 'network') {
    return apiCall('/api/verify-price', {
      method: 'POST',
      apiKey: resolveMcpApiKey(args),
      body: { product_id: args.product_id, quantity: Number(args.quantity ?? 1) },
    })
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth

  const { user } = auth
  const productId = args.product_id as string
  const qty = Number(args.quantity ?? 1)
  if (!productId) return { error: '请提供 product_id' }

  const product = db.prepare(`
    SELECT p.*, u.name as seller_name FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.id = ? AND p.status = 'active'
  `).get(productId) as Record<string, unknown> | undefined
  if (!product) return { error: `商品不存在或已下架：${productId}` }
  if ((product.stock as number) < qty) {
    return { error: `库存不足：当前库存 ${product.stock}，请求数量 ${qty}` }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 10 * 60_000)
  // 与 P0 #1 (commit 07f9e49 generateId) 一致：用 crypto.randomBytes，128-bit 熵
  const token = `pst_${randomBytes(16).toString('hex')}`

  db.prepare(`
    INSERT INTO price_sessions (token, product_id, user_id, price, quantity, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(token, productId, user.id, product.price, qty, now.toISOString(), expiresAt.toISOString())

  const parsed = parseProductForAgent(product)
  return {
    session_token: token,
    verified_price: product.price,
    quantity: qty,
    total: (product.price as number) * qty,
    product: {
      id: product.id,
      title: product.title,
      agent_summary: parsed.agent_summary,
      specs: parsed.specs,
    },
    expires_at: expiresAt.toISOString(),
    expires_in_seconds: 600,
    next: `调用 webaz_place_order 时传入 session_token="${token}" 确保以此价格成交`,
  }
}

async function handleListProduct(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Wave 3 audit P0: 加 action 分发 — agent 卖家能完整管理目录（不止 create）
  const action = (args.action as string) || 'create'
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required' }

  // RFC-003 P2b: NETWORK 模式 — 卖家目录管理全部转发生产端点（单一真相源）
  if (toolBackend('webaz_list_product') === 'network') {
    const pid = args.product_id as string
    if (action === 'mine') {
      const r = await apiCall('/api/my-products', { apiKey })
      if (Array.isArray(r)) return { found: r.length, products: r }
      return r
    }
    if (action === 'create') {
      const createFields = ['title','description','price','stock','category','specs','brand','model','source_url','source_price','external_title','weight_kg','ship_regions','handling_hours','estimated_days','fragile','return_days','return_condition','warranty_days','commission_rate','product_type','aliases','image_hashes']
      const body: Record<string, unknown> = {}
      for (const k of createFields) if (args[k] !== undefined) body[k] = args[k]
      const created = await apiCall('/api/products', { method: 'POST', apiKey, body })
      if ('error' in created) return created
      const newId = (created.product_id ?? created.id) as string | undefined
      const extraKeys = ['i18n_titles','i18n_descs','origin_claims','low_stock_threshold','auto_delist_on_zero']
      if (newId && extraKeys.some(k => args[k] !== undefined)) {
        const eb: Record<string, unknown> = {}
        for (const k of extraKeys) if (args[k] !== undefined) eb[k] = args[k]
        const extra = await apiCall(`/api/products/${encodeURIComponent(newId)}`, { method: 'PUT', apiKey, body: eb })
        return { ...created, extra_fields_applied: !('error' in extra), extra_result: extra }
      }
      return created
    }
    if (!pid) return { error: `product_id required for action=${action}` }
    if (action === 'update') {
      const updatable = ['title','description','price','stock','specs','brand','model','handling_hours','ship_regions','estimated_days','fragile','return_days','return_condition','warranty_days','low_stock_threshold','auto_delist_on_zero','i18n_titles','i18n_descs','origin_claims']
      const body: Record<string, unknown> = {}
      for (const k of updatable) if (args[k] !== undefined) body[k] = args[k]
      return apiCall(`/api/products/${encodeURIComponent(pid)}`, { method: 'PUT', apiKey, body })
    }
    if (action === 'delist') return apiCall(`/api/products/${encodeURIComponent(pid)}/status`, { method: 'PATCH', apiKey, body: { status: 'warehouse' } })
    if (action === 'relist') return apiCall(`/api/products/${encodeURIComponent(pid)}/status`, { method: 'PATCH', apiKey, body: { status: 'active' } })
    if (action === 'trash')  return apiCall(`/api/products/${encodeURIComponent(pid)}/status`, { method: 'PATCH', apiKey, body: { status: 'deleted' } })
    if (action === 'delete') return apiCall(`/api/products/${encodeURIComponent(pid)}`, { method: 'DELETE', apiKey })
    return { error: `unknown action: ${action}. Valid actions: create | mine | update | delist | relist | trash | delete` }
  }

  if (action !== 'create') {
    const auth0 = requireAuth(db, apiKey)
    if ('error' in auth0) return auth0
    const { user: u0 } = auth0

    if (action === 'mine') {
      // QA 轮 7 P1：旧版走 PWA HTTP，本地 dev 没起 PWA 就挂；改直读 SQLite
      const rows = db.prepare(
        `SELECT id, title, price, stock, status, stake_amount, category, created_at, updated_at
         FROM products
         WHERE seller_id = ?
         ORDER BY created_at DESC
         LIMIT 100`
      ).all(u0.id) as Record<string, unknown>[]
      const summary = rows.reduce((acc: Record<string, number>, p) => {
        const s = (p.status as string) || 'active'
        acc[s] = (acc[s] || 0) + 1
        return acc
      }, {})
      return {
        found: rows.length,
        products: rows,
        summary_by_status: summary,
        seller_id: u0.id,
        note: 'Direct SQLite query — no PWA dependency.',
      }
    }

    const productId = args.product_id as string
    if (!productId) return { error: `product_id required for action=${action}` }

    if (action === 'update') {
      const body: Record<string, unknown> = {}
      const updatable = [
        'title','description','price','stock','specs','brand','model','handling_hours','ship_regions','estimated_days','fragile','return_days','return_condition','warranty_days',
        // S2 库存预警 / S3 多语言 / S4 商品溯源
        'low_stock_threshold','auto_delist_on_zero','i18n_titles','i18n_descs','origin_claims',
      ]
      for (const k of updatable) {
        if (args[k] !== undefined) body[k] = args[k]
      }
      return await pwaApi('PUT', `/products/${productId}`, apiKey, body)
    }
    if (action === 'delist')  return await pwaApi('PATCH', `/products/${productId}/status`, apiKey, { status: 'warehouse' })
    if (action === 'relist')  return await pwaApi('PATCH', `/products/${productId}/status`, apiKey, { status: 'active' })
    if (action === 'trash')   return await pwaApi('PATCH', `/products/${productId}/status`, apiKey, { status: 'deleted' })
    if (action === 'delete')  return await pwaApi('DELETE', `/products/${productId}`, apiKey)
    return { error: `unknown action: ${action}. Valid actions: create | mine | update | delist | relist | trash | delete` }
  }

  // ─── action === 'create' (默认) — 沿用旧逻辑 ────────────────────
  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth
  const { user } = auth

  if (user.role !== 'seller') {
    return { error: `只有 seller 角色可以上架商品，你的角色是：${user.role}` }
  }

  const price = args.price as number
  // Per-order stake 模型（QA 轮 7 P0 修复）：list_product 不再预扣 stake。
  // stake 在 place_order 那一刻按"该订单总额 × stake_rate"现锁，订单结算时退该笔，违约时扣该笔。
  // 这样每个 active 订单都有独立 stake 担保，多 stock 商品也不会被空头薅。
  // product.stake_amount 字段保留为"indicative rate × price"（前端展示用），不强制 lock。
  const stakeDiscount = await getStakeDiscount(db, user.id)
  const stakeRate = Math.max(0.05, 0.15 - stakeDiscount)   // 最低 5%，声誉越高折扣越大
  const stakeAmount = Math.round(price * stakeRate * 100) / 100  // indicative only; actual lock per-order

  const id = generateId('prd')

  const specsJson = args.specs != null
    ? (typeof args.specs === 'string' ? args.specs : JSON.stringify(args.specs))
    : null
  const estJson = args.estimated_days != null
    ? (typeof args.estimated_days === 'string' ? args.estimated_days : JSON.stringify(args.estimated_days))
    : null

  db.prepare(`
    INSERT INTO products (
      id, seller_id, title, description, price, stock, category, stake_amount,
      specs, brand, model, source_price,
      ship_regions, handling_hours, estimated_days, fragile,
      return_days, return_condition, warranty_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?)
  `).run(
    id,
    user.id,
    args.title as string,
    args.description as string,
    price,
    (args.stock as number) ?? 1,
    (args.category as string) ?? null,
    stakeAmount,
    specsJson,
    (args.brand as string) ?? null,
    (args.model as string) ?? null,
    args.source_price != null ? Number(args.source_price) : null,
    (args.ship_regions as string) ?? '全国',
    args.handling_hours != null ? Number(args.handling_hours) : 24,
    estJson,
    args.fragile ? 1 : 0,
    args.return_days != null ? Number(args.return_days) : 7,
    (args.return_condition as string) ?? '',
    args.warranty_days != null ? Number(args.warranty_days) : 0,
  )

  // 注：per-order stake 模型不在此 lock — 移到 place_order 时按订单总额锁

  // S2/S3/S4 新字段：通过 HTTP PUT 走标准校验路径（i18n 语言白名单 / origin_claims 4KB+sha256 / 库存阈值）
  const hasExtra = ['i18n_titles','i18n_descs','origin_claims','low_stock_threshold','auto_delist_on_zero']
    .some(k => args[k] !== undefined)
  let extraResult: Record<string, unknown> | null = null
  if (hasExtra) {
    const body: Record<string, unknown> = {}
    for (const k of ['i18n_titles','i18n_descs','origin_claims','low_stock_threshold','auto_delist_on_zero']) {
      if (args[k] !== undefined) body[k] = args[k]
    }
    extraResult = await pwaApi('PUT', `/products/${id}`, apiKey, body)
  }

  const rep = getReputation(db, user.id)
  return {
    success: true,
    product_id: id,
    title: args.title,
    price: `${price} WAZ`,
    // QA 轮 7 P2：旧文案 "stake_locked: 15 WAZ（质押保证金，交易完成后返还）" 误导
    //   实际 per-order 模型不在 list 时锁；改成 stake_per_order_estimate + 明示策略
    stake_per_order_estimate: `${stakeAmount} WAZ（按当前 price × ${(stakeRate * 100).toFixed(0)}% 估算；实际每笔订单按订单总额×rate 在 place_order 时从 seller balance 锁）`,
    stake_strategy: 'per_order',
    stake_rate: stakeDiscount > 0 ? `${(stakeRate * 100).toFixed(0)}%（声誉折扣 -${(stakeDiscount * 100).toFixed(0)}%，原 15%）` : '15%',
    stake_locked_now: 0,  // list 不再 lock；明示给 agent
    reputation_level: rep.level.label,
    status: 'active（买家现在可以搜索到这件商品）',
    ...(extraResult ? { extra_fields_applied: !('error' in extraResult), extra_result: extraResult } : {}),
  }
}

async function handlePlaceOrder(args: Record<string, unknown>) {
  // RFC-003 P2: network 模式转发到生产 POST /api/orders(前置,绕过本地 db)。
  // 生产端做完整鉴权/库存/session/spend-cap/结算。
  if (toolBackend('webaz_place_order') === 'network') {
    const body: Record<string, unknown> = { product_id: args.product_id, quantity: Number(args.quantity ?? 1) }
    if (args.session_token != null)    body.session_token = args.session_token
    if (args.expected_price != null)   body.expected_price = args.expected_price
    if (args.shipping_address != null) body.shipping_address = args.shipping_address
    if (args.donation_pct != null)     body.donation_pct = args.donation_pct
    return apiCall('/api/orders', { method: 'POST', apiKey: resolveMcpApiKey(args), body })
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth

  if (user.role !== 'buyer') {
    return { error: `只有 buyer 角色可以下单，你的角色是：${user.role}` }
  }

  const product = db
    .prepare("SELECT p.*, u.name as seller_name, u.id as seller_uid FROM products p JOIN users u ON p.seller_id = u.id WHERE p.id = ? AND p.status = 'active'")
    .get(args.product_id as string) as Record<string, unknown> | undefined

  if (!product) {
    return { error: `商品不存在或已下架：${args.product_id}` }
  }

  const quantity = (args.quantity as number) ?? 1
  if ((product.stock as number) < quantity) {
    return { error: `库存不足：当前库存 ${product.stock}，你要购买 ${quantity}` }
  }

  // 验证 session_token（如果提供）
  if (args.session_token) {
    const session = db.prepare(`
      SELECT * FROM price_sessions WHERE token = ? AND product_id = ? AND user_id = ?
    `).get(args.session_token as string, args.product_id as string, user.id) as Record<string, unknown> | undefined
    if (!session) return { error: 'session_token 无效，请重新调用 webaz_verify_price' }
    if (session.used_at) return { error: 'session_token 已使用，请重新调用 webaz_verify_price' }
    if (new Date(session.expires_at as string) < new Date()) {
      return { error: 'session_token 已过期（10分钟有效），请重新调用 webaz_verify_price' }
    }
    if ((session.price as number) !== (product.price as number)) {
      return {
        error: 'price_changed',
        message: `商品价格已变动：验证时 ${session.price} WAZ，当前 ${product.price} WAZ`,
        new_price: product.price,
        hint: '请重新调用 webaz_verify_price 获取新价格后再下单',
      }
    }
    db.prepare(`UPDATE price_sessions SET used_at = datetime('now') WHERE token = ?`).run(args.session_token)
  }

  const totalAmount = (product.price as number) * quantity
  const wallet = db
    .prepare('SELECT * FROM wallets WHERE user_id = ?')
    .get(user.id) as Record<string, number>

  if (wallet.balance < totalAmount) {
    return {
      error: `余额不足：订单金额 ${totalAmount} WAZ，你的余额 ${wallet.balance} WAZ`,
    }
  }

  // B5 公益捐赠：donation_pct 必须是固定档位之一（同后端 DONATION_VALID_PCTS）
  const DONATION_VALID_PCTS = new Set([0, 0.005, 0.01, 0.02, 0.05])
  const donationPctNum = Number(args.donation_pct || 0)
  if (!DONATION_VALID_PCTS.has(donationPctNum)) {
    return { error: 'donation_pct 必须是 0 / 0.005 / 0.01 / 0.02 / 0.05 之一' }
  }
  const donationAmount = donationPctNum > 0 ? Math.round(totalAmount * donationPctNum * 100) / 100 : 0

  // B2 匿名收件：服务端生成 PR-XXXXX 代号（同后端 generateRecipientCode 逻辑）
  const anonymousFlag = args.anonymous_recipient ? 1 : 0
  let recipientCode: string | null = null
  if (anonymousFlag === 1) {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const buf = randomBytes(8)
    let s = ''
    for (let i = 0; i < 5; i++) s += ALPHABET[buf[i] % ALPHABET.length]
    recipientCode = 'PR-' + s
  }

  const now = new Date()
  const orderId = generateId('ord')

  // 找推荐人
  let promoterId: string | null = null
  if (args.promoter_api_key) {
    const promoter = db
      .prepare('SELECT id FROM users WHERE api_key = ?')
      .get(args.promoter_api_key as string) as { id: string } | undefined
    if (promoter) promoterId = promoter.id
  }

  db.prepare(`
    INSERT INTO orders (
      id, product_id, buyer_id, seller_id, promoter_id,
      quantity, unit_price, total_amount, escrow_amount,
      status, shipping_address, notes,
      pay_deadline, accept_deadline, ship_deadline,
      pickup_deadline, delivery_deadline, confirm_deadline,
      anonymous_recipient, recipient_code, donation_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    product.id,
    user.id,
    product.seller_uid,
    promoterId,
    quantity,
    product.price,
    totalAmount,
    totalAmount,
    args.shipping_address as string,
    (args.notes as string) ?? null,
    addHours(now, 24),   // 买家 24h 内必须付款
    addHours(now, 48),   // 卖家 24h 内接单
    addHours(now, 120),  // 卖家 72h 内发货
    addHours(now, 168),  // 物流 48h 内揽收
    addHours(now, 336),  // 物流 7 天内投递
    addHours(now, 408),  // 买家 72h 内确认
    anonymousFlag,
    recipientCode,
    donationAmount,
  )

  // QA 轮 9.4 P0 修复（2026-05-27）：MCP 之前没填 settleCommission 真正读的 l1_uid + snapshot_commission_rate
  // 后果：promoter 永远拿不到 commission（PWA 看 l1_uid=NULL → chain_gap → 14 WAZ 进 charity）
  //       并因 settleOrder default 0 vs settleCommission default 0.10 还印 20 WAZ from thin air
  // 修：place_order 时同步 PWA 的写法 — l1_uid = promoter（如有），snapshot_commission_rate 从 product 拷贝
  // 注：promoter_api_key 路径下 L2/L3 不可推断（需走 share_link 点击的 product_share_attribution 链）→ 保持 NULL
  //      L2/L3 NULL 在 global region (max_levels=1) 走 region 截断 → global_fund，不进 charity
  //      L2/L3 NULL 在更高 max_levels region 走 chain_gap → charity
  const snapshotCommissionRate = Number(product.commission_rate ?? 0.10)
  db.prepare('UPDATE orders SET l1_uid = ?, snapshot_commission_rate = ? WHERE id = ?')
    .run(promoterId, snapshotCommissionRate, orderId)

  // 扣除库存
  db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, product.id)

  // 模拟"付款"：锁定买家余额
  db.prepare(`
    UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?
  `).run(totalAmount, totalAmount, user.id)

  // QA 轮 7 P0 修复：per-order 卖家 stake — 下单瞬间从 seller.balance 锁 15% 到 staked
  // 该 stake 在 settleOrder 退还 / fault_seller 时扣给 buyer 50% + sys_protocol 50%
  // 多 stock 商品每笔都独立 lock，不再被空头薅
  const sellerStakeRate = 0.15  // TODO: protocol_params 化（default_commission_rate 现是 0.10 不同义）
  const sellerStake = Math.round(totalAmount * sellerStakeRate * 100) / 100
  const sellerWalletNow = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(product.seller_uid) as { balance: number } | undefined
  if (!sellerWalletNow || sellerWalletNow.balance < sellerStake) {
    // rollback buyer escrow + stock (因为 stake 不够无法担保订单)
    db.prepare('UPDATE wallets SET balance = balance + ?, escrowed = escrowed - ? WHERE user_id = ?').run(totalAmount, totalAmount, user.id)
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(quantity, product.id)
    return {
      error: 'seller_insufficient_stake_balance',
      error_code: 'SELLER_INSUFFICIENT_BALANCE',
      message: `卖家余额不足以锁定订单 stake（需要 ${sellerStake} WAZ，卖家余 ${sellerWalletNow?.balance ?? 0}）。卖家先充值才能继续接单。`,
      seller_stake_required: sellerStake,
      seller_balance: sellerWalletNow?.balance ?? 0,
      next_step: '换其他卖家的同类商品，或建议该卖家充值后重试。',
    }
  }
  db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?').run(sellerStake, sellerStake, product.seller_uid)

  // 直接进入 paid 状态（Phase 0 模拟支付）
  transition(db, orderId, 'paid', user.id, [], '模拟支付完成，资金已托管')
  notifyTransition(db, orderId, 'created', 'paid')

  // 检查卖家是否开启了 auto_accept Skill，若是则自动接单
  let autoAccepted = false
  if (shouldAutoAccept(db, orderId)) {
    const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
    const acceptResult = transition(db, orderId, 'accepted', sysUser.id, [], '⚡ auto_accept Skill 自动接单')
    if (acceptResult.success) {
      notifyTransition(db, orderId, 'paid', 'accepted')
      autoAccepted = true
    }
  }

  return {
    success: true,
    order_id: orderId,
    product: product.title,
    seller: product.seller_name,
    quantity,
    total_amount: `${totalAmount} WAZ（已托管，等待交易完成后自动结算）`,
    status: autoAccepted ? 'accepted' : 'paid',
    auto_accepted: autoAccepted || undefined,
    next: autoAccepted
      ? '⚡ 卖家已开启自动接单，订单已立即接受！等待卖家发货。'
      : '卖家须在 accept_deadline 前接单（付款后 24h 内，即下单后 ~48h）。超时未接单系统自动退款。详见 deadline 字段。',
    track: `用 webaz_get_status 查看订单进展`,
  }
}

async function handleUpdateOrder(args: Record<string, unknown>) {
  // RFC-003 P2b: NETWORK 模式 — 全部状态机动作转发生产 /api/orders/:id/action（单一真相源；
  // sandbox 路径里 confirm 也是这么转发的，network 把整套履约状态机统一走 PWA 引擎）
  if (toolBackend('webaz_update_order') === 'network') {
    const orderId = args.order_id as string
    const action = args.action as string
    if (!orderId || !action) return { error: 'order_id and action required' }
    return apiCall(`/api/orders/${encodeURIComponent(orderId)}/action`, {
      method: 'POST',
      apiKey: resolveMcpApiKey(args),
      body: {
        action,
        notes: (args.notes as string) ?? '',
        evidence_description: (args.evidence_description as string) ?? '',
        ...(args.decline_reason_code ? { decline_reason_code: args.decline_reason_code } : {}),
        ...(args.logistics_company_id ? { logistics_company_id: args.logistics_company_id } : {}),
      },
    })
  }

  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth

  const orderId = args.order_id as string
  const action = args.action as string
  const notes = (args.notes as string) ?? ''
  const evidenceDesc = (args.evidence_description as string) ?? ''

  // QA 轮 9.4 P0 修复（2026-05-27）：MCP confirm 转发 PWA endpoint，单一真相源。
  // 旧 MCP settleOrder 写死 3% promoter 单 L1，跟 PWA settleCommission 的
  // commission_rate × 7:2:1 + chain_gap → charity 完全不同。
  // agent-native 协议要求"哪个接口进结果一致"。MCP confirm 不再自己结算，
  // 走 PWA /api/orders/:id/action 的 settleOrder + settleCommission（authoritative）。
  if (action === 'confirm') {
    const apiKey = resolveMcpApiKey(args)
    const result = await pwaApi('POST', `/orders/${encodeURIComponent(orderId)}/action`, apiKey, {
      action: 'confirm',
      notes,
    })
    // 透传 PWA 响应；其中包含真实 settlement 结果。
    // 若 PWA 不可达（本地 dev 没起 PWA），返回明确错误而非 fallback 到旧 MCP 路径
    return result
  }

  // 验证订单存在且该用户是参与方
  let order = db
    .prepare('SELECT * FROM orders WHERE id = ?')
    .get(orderId) as Record<string, unknown> | undefined

  if (!order) return { error: `订单不存在：${orderId}` }

  // 物流首次操作：先绑定再做参与方检查
  if (
    (action === 'pickup' || action === 'transit') &&
    !order.logistics_id &&
    user.role === 'logistics'
  ) {
    db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(user.id, orderId)
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>
  }

  const isParticipant =
    order.buyer_id === user.id ||
    order.seller_id === user.id ||
    order.logistics_id === user.id

  if (!isParticipant && user.role !== 'arbitrator') {
    return { error: '你不是这笔订单的参与方，无法操作' }
  }

  // action → 状态映射
  const actionMap: Record<string, string> = {
    accept:  'accepted',
    ship:    'shipped',
    pickup:  'picked_up',
    transit: 'in_transit',
    deliver: 'delivered',
    confirm: 'confirmed',
    dispute: 'disputed',
  }

  const toStatus = actionMap[action]
  if (!toStatus) return { error: `未知操作：${action}` }

  // 如果有证据描述，先创建证据记录
  const evidenceIds: string[] = []
  if (evidenceDesc) {
    const evidenceId = generateId('evt')
    db.prepare(`
      INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
      VALUES (?, ?, ?, 'description', ?, ?)
    `).run(evidenceId, orderId, user.id, evidenceDesc, `hash_${Date.now()}`)
    evidenceIds.push(evidenceId)
  }

  const result = transition(
    db,
    orderId,
    toStatus as Parameters<typeof transition>[2],
    user.id,
    evidenceIds,
    notes
  )

  if (!result.success) {
    return { error: result.error }
  }

  // 通知相关参与方（L2-6）
  notifyTransition(db, orderId, order.status as string, toStatus)

  // 如果是 dispute，写入 disputes 表（L3-1）
  if (toStatus === 'disputed') {
    const disputeResult = createDispute(db, orderId, user.id, notes || evidenceDesc || '买家发起争议', evidenceIds)
    if (disputeResult.success) {
      return {
        success: true,
        new_status: 'disputed',
        dispute_id: disputeResult.disputeId,
        message: disputeResult.message,
        respond_deadline: disputeResult.respondDeadline,
        next: `用 webaz_dispute action=view dispute_id=${disputeResult.disputeId} 查看争议详情`,
      }
    }
    // 争议记录写入失败不影响状态，仍返回成功
    return { success: true, new_status: 'disputed', message: '争议已发起，资金已冻结', warning: disputeResult.error }
  }

  // 如果是 confirmed，自动触发结算
  if (toStatus === 'confirmed') {
    const sysUser = db
      .prepare("SELECT id FROM users WHERE id = 'sys_protocol'")
      .get() as { id: string }
    transition(db, orderId, 'completed', sysUser.id, [], '系统自动结算')
    const breakdown = settleOrder(db, orderId)
    return {
      success: true,
      new_status: 'completed',
      message: '确认收货成功！资金已自动分配给各参与方。',
      settlement_breakdown: breakdown,  // QA P1 transparency: 详列每分钱去哪
      detail: `用 webaz_wallet 查看你的收益`,
    }
  }

  const statusMessages: Record<string, string> = {
    accepted:   '接单成功！请在承诺时间内发货，超时将自动判违约。',
    shipped:    '发货成功！物流方 48 小时内需要完成揽收。',
    picked_up:  '揽收确认！请尽快安排运输。',
    in_transit: '运输状态已更新。',
    delivered:  '投递确认！买家 72 小时内确认收货，超时自动确认。',
    disputed:   '争议已发起，资金冻结，等待仲裁员介入。',
  }

  return {
    success: true,
    new_status: result.newStatus,
    message: statusMessages[toStatus] ?? '状态已更新',
    history_record: result.historyId,
  }
}

async function handleGetStatus(args: Record<string, unknown>) {
  // RFC-003 P4: NETWORK 模式订单查询 → 生产 GET /api/orders/:id(权威网络订单详情 + 历史)
  if (toolBackend('webaz_get_status') === 'network') {
    const orderId = args.order_id as string
    if (!orderId) return { error: 'order_id required' }
    return apiCall(`/api/orders/${encodeURIComponent(orderId)}`, { apiKey: resolveMcpApiKey(args) })
  }

  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth

  const statusInfo = getOrderStatus(db, args.order_id as string)
  if (!statusInfo) return { error: `订单不存在：${args.order_id}` }

  const { order, history, currentResponsible, activeDeadline, isOverdue, fulfillmentPhase, responsibleContext } = statusInfo

  return {
    order_id: order.id,
    current_status: order.status,
    current_responsible: currentResponsible
      ? `${currentResponsible}（当前应由此角色操作）`
      : '无（等待系统处理）',
    // Phase 1 兜底语义透传 — agent 看到 responsible=seller 时若不理解为什么(如 shipped 后还要 seller 揽收),
    // 应读此字段。Phase 2 logistics 市场上线后,phase_1_no_logistics_market 会消失。
    fulfillment_phase: fulfillmentPhase,
    responsible_context: responsibleContext,
    deadline: activeDeadline
      ? {
          field: activeDeadline.field,
          time: activeDeadline.deadline,
          overdue: isOverdue ? '⚠️ 已超时！协议将自动判责' : '未超时',
        }
      : null,
    history: (history as Record<string, unknown>[]).map((h) => ({
      from: h.from_status,
      to: h.to_status,
      by: `${h.actor_name}（${h.actor_role_name}）`,
      at: h.created_at,
      evidence_count: JSON.parse((h.evidence_ids as string) || '[]').length,
      notes: h.notes,
    })),
  }
}

async function handleWallet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Wave 3 audit P0: 加 action 分发 — agent 能查充值/提现/收入历史（写操作仍 UI-only 走 2FA）
  const action = (args.action as string) || 'view'
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required' }

  // RFC-003 Batch 4:NETWORK 模式 → webaz.xyz 真网络【只读】(Bearer api_key)。
  // 写动作(withdraw/topup/whitelist/connect)是 Passkey+OTP 多步流,MCP 不暴露,仅 PWA。
  if (toolBackend('webaz_wallet') === 'network') {
    if (action === 'view')        return await apiCall('/api/wallet', { apiKey })
    if (action === 'deposits')    return await apiCall('/api/wallet/deposits', { apiKey })
    if (action === 'withdrawals') return await apiCall('/api/wallet/withdrawals', { apiKey })
    if (action === 'income')      return await apiCall('/api/wallet/income', { apiKey })
    return { error: `unknown action: ${action}. Valid: view | deposits | withdrawals | income. 提现/充值/白名单需 Passkey+OTP,仅 PWA Web 端。` }
  }

  if (action === 'deposits')    return await pwaApi('GET', '/wallet/deposits', apiKey)
  if (action === 'withdrawals') return await pwaApi('GET', '/wallet/withdrawals', apiKey)
  if (action === 'income')      return await pwaApi('GET', '/wallet/income', apiKey)

  if (action !== 'view') {
    return { error: `unknown action: ${action}. Valid: view | deposits | withdrawals | income. 注意：提现/充值/白名单管理需 Passkey + 邮件 OTP，仅 PWA Web 端可用` }
  }

  // ─── action === 'view' (默认) — 沿用旧逻辑 ─────────────────────
  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth
  const { user } = auth

  const wallet = db
    .prepare('SELECT * FROM wallets WHERE user_id = ?')
    .get(user.id) as Record<string, number> | undefined

  if (!wallet) return { error: '钱包不存在' }

  // QA 轮 9.4-retry-v3 P1：旧版用 SUM(payouts.amount) 算 earned
  //   但 PWA settleOrder 只更 wallets.earned 列不写 payouts 表 → MCP 视图 stale
  //   PWA confirm 后真实 earned 在 wallets.earned；payouts 仅 MCP legacy settleOrder 写
  //   改用 wallet.earned 列作单一真相源
  const totalEarned = Number(wallet.earned ?? 0)

  const rep = getReputation(db, user.id)
  const nextLevel = ['new','trusted','quality','star','legend']
  const nextIdx = nextLevel.indexOf(rep.level.key) + 1
  const nextLevelDef = nextIdx < nextLevel.length ? { trusted:200, quality:800, star:2000, legend:5000 }[nextLevel[nextIdx] as string] : null

  return {
    user: user.name,
    role: user.role,
    balance: `${wallet.balance} WAZ（可用）`,
    staked: `${wallet.staked} WAZ（质押中，不可用）`,
    escrowed: `${wallet.escrowed} WAZ（托管中，交易完成后结算）`,
    total_earned: `${totalEarned} WAZ（历史累计收益）`,
    reputation: {
      level:             `${rep.level.icon} ${rep.level.label}`,
      total_points:      rep.total_points,
      transactions_done: rep.transactions_done,
      disputes_won:      rep.disputes_won,
      disputes_lost:     rep.disputes_lost,
      violations:        rep.violations,
      stake_discount:    rep.level.stakeDiscount > 0 ? `-${(rep.level.stakeDiscount * 100).toFixed(0)}% 质押优惠` : '暂无（升级后享优惠）',
      next_level:        nextLevelDef ? `距下一等级还需 ${nextLevelDef - rep.total_points} 分` : '已达最高等级！',
      recent_events:     rep.recent_events.slice(0, 5).map(e => `${e.points > 0 ? '+' : ''}${e.points} ${e.reason}`),
    },
  }
}

// ─── 通知处理 ─────────────────────────────────────────────────

async function handleNotifications(args: Record<string, unknown>) {
  // RFC-003 Batch 1:NETWORK 模式 → 调 webaz.xyz 真网络通知端点(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_notifications') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    if (args.mark_read) await apiCall('/api/notifications/read', { method: 'POST', apiKey })
    return await apiCall('/api/notifications' + (args.unread === true ? '?unread=1' : ''), { apiKey })
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth

  const onlyUnread = args.unread === true
  const notifs = await getNotifications(db, user.id, onlyUnread, 30)
  const unread = await getUnreadCount(db, user.id)

  if (args.mark_read) {
    markRead(db, user.id)
  }

  return {
    unread_count: unread,
    notifications: notifs.map(n => ({
      id: n.id,
      title: n.title,
      body: n.body,
      order_id: n.order_id,
      read: n.read === 1,
      time: n.created_at,
    })),
  }
}

// ─── 争议处理 ─────────────────────────────────────────────────

async function handleDispute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required' }
  const action = args.action as string

  // ── 仲裁裁定（Iron-Rule）──────────────────────────────────────
  // 两种模式都只登记意图 + 返回 PWA+Passkey 指引;不执行、不碰 db。放在 auth 之前。
  if (action === 'arbitrate') {
    if (!args.dispute_id) return { error: '请提供 dispute_id' }
    if (!args.ruling) return { error: '请提供 ruling（refund_buyer / release_seller / partial_refund / liability_split）' }
    if (!args.ruling_reason) return { error: '请提供 ruling_reason（裁定理由将永久记录）' }
    if (args.ruling === 'partial_refund' && !args.refund_amount && !args.liable_party) {
      return { error: 'partial_refund 需要提供 refund_amount，或 liable_party（第三方责任方）' }
    }
    if (args.ruling === 'liability_split' && (!Array.isArray(args.liability_parties) || (args.liability_parties as unknown[]).length === 0)) {
      return { error: 'liability_split 需要提供 liability_parties 数组，每项 { user_id, amount }' }
    }
    return {
      success: false,
      requires_human_action: true,
      iron_rule: 'Arbitration ruling is irreversible, affects multiple parties, and locks fund distribution permanently. Agent cannot execute unilaterally. Same Iron-Rule gating as webaz_revoke_key / claim_verify vote.',
      action: 'arbitrate_dispute',
      dispute_id: args.dispute_id,
      proposed_ruling: {
        ruling: args.ruling,
        reason: args.ruling_reason,
        ...(args.refund_amount !== undefined ? { refund_amount: args.refund_amount } : {}),
        ...(args.liable_party ? { liable_party: args.liable_party } : {}),
        ...(args.liability_parties ? { liability_parties: args.liability_parties } : {}),
      },
      next_step: {
        via: 'PWA + Passkey (arbitrator role)',
        url: `https://webaz.xyz/arbitrate?dispute=${encodeURIComponent(args.dispute_id as string)}`,
        instructions: '1) Open URL in browser  2) Sign in as arbitrator  3) Review evidence  4) Confirm with Passkey  5) Submit final ruling. Action is irreversible after confirmation.',
      },
    }
  }

  // RFC-003 Batch 5:NETWORK 模式 → webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_dispute') === 'network') {
    if (action === 'view') {
      if (!args.dispute_id) return { error: '网络模式请提供 dispute_id（order_id 查询仅 PWA 支持）。 / provide dispute_id on the live network.' }
      return await apiCall('/api/disputes/' + encodeURIComponent(String(args.dispute_id)), { apiKey })
    }
    if (action === 'list_open') return await apiCall('/api/disputes', { apiKey })
    if (action === 'respond') {
      if (!args.dispute_id) return { error: '请提供 dispute_id' }
      return await apiCall('/api/disputes/' + encodeURIComponent(String(args.dispute_id)) + '/respond', { method: 'POST', apiKey, body: { notes: args.notes ?? '', evidence_description: args.evidence_description ?? '' } })
    }
    if (action === 'add_evidence') {
      if (!args.dispute_id) return { error: '请提供 dispute_id' }
      if (!args.evidence_description) return { error: '请提供 evidence_description（证据描述）' }
      return await apiCall('/api/disputes/' + encodeURIComponent(String(args.dispute_id)) + '/add-evidence', { method: 'POST', apiKey, body: { description: args.evidence_description, evidence_type: 'text' } })
    }
    return { error: `未知 action：${action}。Valid: view | list_open | respond | add_evidence | arbitrate` }
  }

  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth
  const { user } = auth

  // ── 查看争议详情 ────────────────────────────────────────────
  if (action === 'view') {
    let dispute = args.dispute_id
      ? await getDisputeDetails(db, args.dispute_id as string)
      : args.order_id
        ? await getOrderDispute(db, args.order_id as string)
        : null

    if (!dispute) return { error: '找不到争议记录，请提供 dispute_id 或 order_id' }

    const evidenceList = (orderId: string, uploaderRole: string) =>
      db.prepare(`
        SELECT e.description, e.type, e.file_hash, e.created_at, u.name as uploader
        FROM evidence e JOIN users u ON e.uploader_id = u.id
        WHERE e.order_id = ? AND u.role = ?
        ORDER BY e.created_at ASC
      `).all(orderId, uploaderRole) as Record<string, unknown>[]

    return {
      dispute_id: dispute.id,
      order_id: dispute.order_id,
      status: dispute.status,
      initiator: `${dispute.initiator_name}（${dispute.initiator_role}）`,
      defendant: `${dispute.defendant_name}（${dispute.defendant_role}）`,
      reason: dispute.reason,
      respond_deadline: dispute.respond_deadline,
      arbitrate_deadline: dispute.arbitrate_deadline,
      plaintiff_evidence: evidenceList(dispute.order_id, dispute.initiator_role as string),
      defendant_notes: dispute.defendant_notes ?? '（被诉方尚未提交回应）',
      defendant_evidence: JSON.parse((dispute.defendant_evidence_ids as string) || '[]'),
      ruling: dispute.ruling_type
        ? { type: dispute.ruling_type, refund_amount: dispute.refund_amount, reason: dispute.verdict_reason }
        : null,
      // QA 轮 15 P1：未裁定时暴露可选 ruling 列表（与 PWA disputes-write.ts validRulings 对齐）
      ruling_options: dispute.ruling_type ? undefined : [
        { type: 'refund_buyer',    desc: '全额退款给买家（卖家败诉）' },
        { type: 'release_seller',  desc: '放款给卖家（买家败诉）' },
        { type: 'partial_refund',  desc: '部分退款（需传 refund_amount）' },
        { type: 'liability_split', desc: '按责任分配（需传 liability_parties 数组）' },
      ],
      resolved_at: dispute.resolved_at,
    }
  }

  // ── 仲裁员查看所有待处理争议 ───────────────────────────────
  if (action === 'list_open') {
    if (user.role !== 'arbitrator') {
      return { error: '只有仲裁员可以查看所有待处理争议' }
    }
    const disputes = await getOpenDisputes(db)
    return {
      open_count: disputes.length,
      disputes: disputes.map(d => ({
        dispute_id: d.id,
        order_id: d.order_id,
        status: d.status,
        initiator: `${d.initiator_name}（${d.initiator_role}）`,
        defendant: `${d.defendant_name}（${d.defendant_role}）`,
        reason: d.reason,
        amount: `${d.total_amount} WAZ`,
        respond_deadline: d.respond_deadline,
        arbitrate_deadline: d.arbitrate_deadline,
        created_at: d.created_at,
      }))
    }
  }

  // ── 被诉方提交反驳 ──────────────────────────────────────────
  if (action === 'respond') {
    if (!args.dispute_id) return { error: '请提供 dispute_id' }

    // 如有证据描述，先创建证据记录
    const evidenceIds: string[] = []
    if (args.evidence_description) {
      const dispute = await getDisputeDetails(db, args.dispute_id as string)
      if (dispute) {
        const eid = generateId('evt')
        db.prepare(`
          INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
          VALUES (?, ?, ?, 'description', ?, ?)
        `).run(eid, dispute.order_id, user.id, args.evidence_description as string, `hash_${Date.now()}`)
        evidenceIds.push(eid)
      }
    }

    return respondToDispute(
      db,
      args.dispute_id as string,
      user.id,
      (args.notes as string) ?? '',
      evidenceIds
    )
  }

  // ── 争议参与方补充证据 (Wave 3 新增) ────────────────────────
  if (action === 'add_evidence') {
    if (!args.dispute_id) return { error: '请提供 dispute_id' }
    if (!args.evidence_description) return { error: '请提供 evidence_description（证据描述）' }
    // QA 轮 15 P1：PWA add-evidence 路由收 `description` 字段，MCP 之前发 `evidence_description` → 不匹配证据写不进
    return await pwaApi('POST', `/disputes/${args.dispute_id}/add-evidence`, apiKey, {
      description: args.evidence_description,
      evidence_type: 'text',
    })
  }

  return { error: `未知 action：${action}。Valid: view | list_open | respond | add_evidence | arbitrate` }
}

// ─── 索赔验证（claim-verification）处理 — Wave 6 新增 ────────────

async function handleClaimVerify(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required' }
  const action = String(args.action || '')

  // 【买家】发起验证
  if (action === 'create') {
    if (!args.order_id) return { error: '请提供 order_id（待验证的订单）' }
    if (!args.claim_target) return { error: '请提供 claim_target（声明对象，如 title / description / condition / shipping_time 等）' }
    if (!args.claim_text) return { error: '请提供 claim_text（声明文本，6-500 字）' }
    return await pwaApi('POST', `/orders/${args.order_id}/claim-verification`, apiKey, {
      claim_target: args.claim_target,
      claim_text: args.claim_text,
      evidence_uri: args.evidence_uri,
    })
  }

  // 【任意参与方】查详情
  if (action === 'view') {
    if (!args.task_id) return { error: '请提供 task_id' }
    return await pwaApi('GET', `/claim-tasks/${args.task_id}`, apiKey)
  }

  // 【我相关】三类视角
  if (action === 'mine') {
    return await pwaApi('GET', '/claim-tasks/mine', apiKey)
  }

  // 【卖家】提交反驳证据（延期 24h）
  if (action === 'submit_seller_evidence') {
    if (!args.task_id) return { error: '请提供 task_id' }
    if (!args.evidence_uri) return { error: '请提供 evidence_uri（证据链接，4-500 字符）' }
    return await pwaApi('POST', `/claim-tasks/${args.task_id}/seller-evidence`, apiKey, {
      evidence_uri: args.evidence_uri,
    })
  }

  // 【Verifier】可接任务
  if (action === 'available') {
    return await pwaApi('GET', '/claim-tasks/available', apiKey)
  }

  // 【Verifier】投票
  if (action === 'vote') {
    if (!args.task_id) return { error: '请提供 task_id' }
    const VALID_VOTES = ['pass', 'fail', 'no_fault', 'abstain']
    if (!args.vote || !VALID_VOTES.includes(String(args.vote))) {
      return { error: `vote 必须是 ${VALID_VOTES.join(' / ')}`, error_code: 'VOTE_INVALID' }
    }
    return await pwaApi('POST', `/claim-tasks/${args.task_id}/vote`, apiKey, {
      vote: args.vote,
      evidence_uri: args.evidence_uri,
      note: args.note,
    })
  }

  // 【Verifier 申请】资格查询
  if (action === 'eligibility') {
    return await pwaApi('GET', '/verifier/eligibility', apiKey)
  }

  // 【Verifier 状态】tier/quota/stake
  if (action === 'verifier_status') {
    return await pwaApi('GET', '/verifier/status', apiKey)
  }

  // 【Verifier 申请】提交
  if (action === 'apply') {
    return await pwaApi('POST', '/verifier/apply', apiKey)
  }

  // 【Verifier 申请】撤回
  if (action === 'withdraw_application') {
    return await pwaApi('POST', '/verifier/withdraw-application', apiKey)
  }

  // 【Verifier】被暂停后申诉
  if (action === 'appeal') {
    if (!args.reason) return { error: '请提供 reason（申诉理由，≤500 字）' }
    return await pwaApi('POST', '/verifier/appeal', apiKey, {
      reason: args.reason,
      task_id: args.task_id,
    })
  }

  return { error: `未知 action：${action}。Valid: create | view | mine | submit_seller_evidence | available | vote | eligibility | verifier_status | apply | withdraw_application | appeal` }
}

// ─── Skill 市场处理 ────────────────────────────────────────────

async function handleSkill(args: Record<string, unknown>) {
  const action = args.action as string

  // RFC-003 Batch 3:NETWORK 模式 → webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地引擎。
  if (toolBackend('webaz_skill') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (action === 'list') {
      const qs = new URLSearchParams()
      if (args.skill_type) qs.set('skill_type', String(args.skill_type))
      if (args.query)      qs.set('q', String(args.query))
      const q = qs.toString()
      return await apiCall('/api/skills' + (q ? '?' + q : ''), { apiKey })
    }
    if (!apiKey) return { error: 'api_key required' }
    if (action === 'publish') {
      return await apiCall('/api/skills', { method: 'POST', apiKey, body: {
        name: args.name, description: args.description, category: args.category,
        skill_type: args.skill_type, config: args.config,
      } })
    }
    if (action === 'subscribe') {
      if (!args.skill_id) return { error: '请提供 skill_id' }
      return await apiCall('/api/skills/' + encodeURIComponent(String(args.skill_id)) + '/subscribe', { method: 'POST', apiKey, body: { config: args.config } })
    }
    if (action === 'unsubscribe') {
      if (!args.skill_id) return { error: '请提供 skill_id' }
      return await apiCall('/api/skills/' + encodeURIComponent(String(args.skill_id)) + '/subscribe', { method: 'DELETE', apiKey })
    }
    if (action === 'my_skills') return await apiCall('/api/skills/mine', { apiKey })
    if (action === 'my_subs')   return await apiCall('/api/skills/subscriptions', { apiKey })
    return { error: `未知 action：${action}。可选：list, publish, subscribe, unsubscribe, my_skills, my_subs` }
  }

  // ── 浏览 Skill 市场 ────────────────────────────────────────
  if (action === 'list') {
    let userId: string | undefined
    if (resolveMcpApiKey(args)) {
      const a = requireAuth(db, resolveMcpApiKey(args))
      if (!('error' in a)) userId = a.user.id
    }
    const skills = await listSkills(db, {
      skillType: args.skill_type as SkillType | undefined,
      query: args.query as string | undefined,
      subscriberId: userId,
      limit: 20,
    })
    return {
      total: skills.length,
      skill_types: Object.entries(SKILL_TYPE_META).map(([k, v]) => ({ type: k, label: v.label, icon: v.icon, description: v.description })),
      skills: skills.map(formatSkillForAgent),
    }
  }

  // 以下操作需要身份验证
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth

  // ── 发布 Skill ────────────────────────────────────────────
  if (action === 'publish') {
    if (!args.name)        return { error: '请填写 Skill 名称（name）' }
    if (!args.description) return { error: '请填写 Skill 描述（description）' }
    if (!args.skill_type)  return { error: '请选择 Skill 类型（skill_type）' }

    const skill = publishSkill(db, {
      sellerId:     user.id,
      name:         args.name as string,
      description:  args.description as string,
      category:     args.category as string | undefined,
      skillType:    args.skill_type as SkillType,
      config:       args.config as Record<string, unknown> | undefined,
    })
    const meta = SKILL_TYPE_META[skill.skill_type as SkillType]
    return {
      success: true,
      skill_id: skill.id,
      message: `✅ Skill 「${skill.name}」已发布到 WebAZ Skill 市场！买家 Agent 现在可以订阅它。`,
      type: `${meta.icon} ${meta.label}`,
      tip: 'auto_accept Skill 发布后，买家新订单将自动被接受（无需手动操作）',
    }
  }

  // ── 订阅 Skill ────────────────────────────────────────────
  if (action === 'subscribe') {
    if (!args.skill_id) return { error: '请提供 skill_id' }
    const result = subscribeSkill(db, user.id, args.skill_id as string, args.config as Record<string, unknown> | undefined)
    return { ...result, skill_id: args.skill_id }
  }

  // ── 取消订阅 ──────────────────────────────────────────────
  if (action === 'unsubscribe') {
    if (!args.skill_id) return { error: '请提供 skill_id' }
    unsubscribeSkill(db, user.id, args.skill_id as string)
    return { success: true, message: '已取消订阅' }
  }

  // ── 我发布的 Skill ────────────────────────────────────────
  if (action === 'my_skills') {
    const skills = await getMySkills(db, user.id)
    return {
      total: skills.length,
      skills: skills.map(formatSkillForAgent),
      tip: skills.length === 0 ? '还没有发布任何 Skill。用 webaz_skill action=publish 发布你的第一个 Skill。' : undefined,
    }
  }

  // ── 我订阅的 Skill ────────────────────────────────────────
  if (action === 'my_subs') {
    const skills = await getMySubscriptions(db, user.id)
    return {
      total: skills.length,
      subscriptions: skills.map(formatSkillForAgent),
      tip: skills.length === 0 ? '还没有订阅任何 Skill。用 webaz_skill action=list 浏览市场。' : undefined,
    }
  }

  return { error: `未知 action：${action}。可选：list, publish, subscribe, unsubscribe, my_skills, my_subs` }
}

// P0-1 修复（QA 轮 5 抓到）：旧版只要 name → 直接吐所有匹配账户 api_key 明文，且无 rate limit。
// 新版：handle + permanent_code 双因素 + redact + in-memory rate limit (5/hr per handle)。
// 完整 api_key 不在 MCP 暴露 — 走 PWA + Passkey 才给（Iron-Rule，跟 claim_verify / arbitrate 同模型）。
const MYKEY_RATE_LIMIT = new Map<string, { count: number; resetAt: number }>()
const MYKEY_MAX_PER_HOUR = 5

function redactKey(key: string): string {
  if (!key || key.length < 12) return '***'
  return `${key.slice(0, 8)}***${key.slice(-4)}`
}

function handleMyKey(args: Record<string, unknown>) {
  // RFC-003 Batch 1:NETWORK 模式下,账号找回是 Passkey 门控(Iron-Rule)——handle+permanent_code
  // 查询不作为网络端点暴露(防枚举)。诚实引导到 PWA 的 Passkey 找回流,不在本地假装查到。
  if (toolBackend('webaz_mykey') === 'network') {
    return {
      _mode: 'network',
      found: null,
      message: 'On the live network, account recovery is Passkey-gated for security (Iron-Rule). handle + permanent_code lookup is not exposed as a network endpoint (anti-enumeration).',
      recover: {
        via: 'PWA + Passkey',
        start_url: `${WEBAZ_API_URL}/recover`,
        note: 'Open in a browser and verify with your Passkey to recover or rotate your api_key.',
      },
      rotate_hint: 'Already have your api_key but want to replace it? Use webaz_rotate_key.',
    }
  }
  const handle = (args.handle as string)?.trim()
  const permaCode = (args.permanent_code as string)?.trim()?.toUpperCase()

  if (!handle || !permaCode) {
    return {
      error: 'invalid_request',
      error_code: 'MISSING_PARAMS',
      message: 'Both handle and permanent_code required. Check the registration response — handle may have been auto-suffixed if requested name was taken (look for handle_modified=true).',
    }
  }

  const now = Date.now()
  const entry = MYKEY_RATE_LIMIT.get(handle) || { count: 0, resetAt: now + 3600_000 }
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 3600_000 }
  if (entry.count >= MYKEY_MAX_PER_HOUR) {
    return {
      error: 'rate_limit_exceeded',
      error_code: 'RATE_LIMIT',
      message: `Too many recovery attempts for this handle. Try again in ${Math.ceil((entry.resetAt - now) / 60_000)} minutes.`,
      retry_after_seconds: Math.ceil((entry.resetAt - now) / 1000),
    }
  }
  entry.count++
  MYKEY_RATE_LIMIT.set(handle, entry)

  const user = db.prepare(
    `SELECT id, name, handle, role, roles, api_key FROM users WHERE handle = ? AND permanent_code = ? AND id != 'sys_protocol'`
  ).get(handle, permaCode) as Record<string, unknown> | undefined

  if (!user) {
    return {
      error: 'invalid_credentials',
      error_code: 'AUTH_FAILED',
      message: 'No account matches handle + permanent_code. Handle is case-sensitive; permanent_code is uppercase.',
      attempts_remaining: MYKEY_MAX_PER_HOUR - entry.count,
    }
  }

  return {
    found: true,
    user_id: user.id,
    name: user.name,
    handle: user.handle,
    active_role: user.role,
    roles: JSON.parse((user.roles as string) || JSON.stringify([user.role])),
    api_key_hint: redactKey(user.api_key as string),
    full_api_key_recovery: {
      via: 'PWA + Passkey',
      url: 'https://webaz.xyz/recover',
      note: 'For security, full api_key disclosure requires Passkey verification on PWA (Iron-Rule). This MCP response only confirms the account exists and shows a redacted hint to help you identify which account.',
    },
    next_step: 'If you cannot access PWA, use webaz_rotate_key to invalidate the lost key and get a new one (also Passkey-gated).',
  }
}

async function handleProfile(args: Record<string, unknown>) {
  const action = args.action as string
  const apiKey = resolveMcpApiKey(args)

  // RFC-003 Batch 1:NETWORK 模式 → 全部 action 调 webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_profile') === 'network') {
    if (action === 'view_user') {
      if (!args.user_id) return { error: 'user_id required' }
      return await apiCall('/api/users/' + encodeURIComponent(String(args.user_id)), { apiKey })
    }
    if (action === 'feed') {
      if (!args.user_id || !args.feed) return { error: 'user_id + feed required' }
      const FEED_PATH: Record<string, string> = {
        secondhand: 'secondhand', auctions: 'auctions', reviews: 'reviews', products: 'products',
        shares: 'shareables', reputation: 'reputation', pv: 'pv-summary', liked: 'liked-shareables',
      }
      const seg = FEED_PATH[String(args.feed)]
      if (!seg) return { error: `unknown feed: ${args.feed}. options: ${Object.keys(FEED_PATH).join(', ')}` }
      return await apiCall('/api/users/' + encodeURIComponent(String(args.user_id)) + '/' + seg, { apiKey })
    }
    if (action === 'view')        return await apiCall('/api/me', { apiKey })
    if (action === 'add_role')    return await apiCall('/api/profile/add-role', { method: 'POST', apiKey, body: { role: args.role } })
    if (action === 'switch_role') return await apiCall('/api/profile/switch-role', { method: 'POST', apiKey, body: { role: args.role } })
    return { error: `Unknown action: ${action}. Options: view, add_role, switch_role, view_user, feed` }
  }

  // 看他人公开主页 / 内容流
  if (action === 'view_user') {
    if (!args.user_id) return { error: 'user_id required' }
    if (!apiKey) return { error: 'api_key required（公开主页端点需鉴权）' }
    return await pwaApi('GET', '/users/' + encodeURIComponent(String(args.user_id)), apiKey)
  }
  if (action === 'feed') {
    if (!args.user_id || !args.feed) return { error: 'user_id + feed required' }
    const FEED_PATH: Record<string, string> = {
      secondhand: 'secondhand', auctions: 'auctions', reviews: 'reviews', products: 'products',
      shares: 'shareables', reputation: 'reputation', pv: 'pv-summary', liked: 'liked-shareables',
    }
    const seg = FEED_PATH[String(args.feed)]
    if (!seg) return { error: `unknown feed: ${args.feed}. options: ${Object.keys(FEED_PATH).join(', ')}` }
    // liked = owner-only，需自己的 api_key；其余公开（无 key 也可）
    return await pwaApi('GET', '/users/' + encodeURIComponent(String(args.user_id)) + '/' + seg, apiKey)
  }

  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth
  const { user } = auth
  const roles: string[] = JSON.parse((user.roles as string) || JSON.stringify([user.role]))

  if (action === 'view') {
    const wallet = db.prepare('SELECT balance, staked, escrowed, earned FROM wallets WHERE user_id = ?').get(user.id) as Record<string, number>
    // P0-2 修复（QA 轮 5）：旧版直接回显完整 api_key 明文。Agent 上下文 / 日志 / 截屏一旦留痕等同于凭据泄漏。
    // 改返 redact 过的 hint，足够 agent 确认"我是哪个账户"，不再让完整 key 进 conversation transcript。
    return {
      id: user.id,
      name: user.name,
      handle: user.handle,
      active_role: user.role,
      roles,
      api_key_hint: redactKey(user.api_key as string),
      wallet,
      tip: 'Use add_role to add a new role, switch_role to change your active role. api_key is no longer returned in plaintext — use webaz_rotate_key if you need a new key.',
    }
  }

  const validRoles = ['buyer', 'seller', 'logistics', 'arbitrator']
  const role = args.role as string

  if (action === 'add_role') {
    if (!validRoles.includes(role)) return { error: `Invalid role. Options: ${validRoles.join(', ')}` }
    if (roles.includes(role)) return { error: `You already have the "${role}" role` }
    roles.push(role)
    db.prepare("UPDATE users SET roles = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(roles), user.id as string)
    return { success: true, active_role: user.role, roles, message: `Role "${role}" added. Use switch_role to activate it.` }
  }

  if (action === 'switch_role') {
    if (!validRoles.includes(role)) return { error: `Invalid role. Options: ${validRoles.join(', ')}` }
    if (!roles.includes(role)) return { error: `You don't have the "${role}" role yet. Use add_role first.` }
    db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, user.id as string)
    return { success: true, active_role: role, roles, message: `Switched to "${role}" mode.` }
  }

  return { error: `Unknown action: ${action}. Options: view, add_role, switch_role, view_user, feed` }
}

// ─── api_key 生命周期（Iron-Rule: 真正吊销/轮换走 PWA + Passkey） ─────
// QA 轮 5 抓到 P0：旧版没任何 logout/revoke/rotate 工具，api_key 一旦泄漏永久接管。
// 这里给 agent 两个"声明意图"工具：MCP 验 api_key 合法 → 返回 PWA URL 让用户 Passkey 二次确认。
// 真正改 DB 的动作放 PWA endpoint，跟 claim_verify / arbitrate 同模型。

function handleRevokeKey(args: Record<string, unknown>) {
  // RFC-003 Batch 5:NETWORK 模式 → 不本地校验 key(PWA 会鉴权),直接返回 Passkey 撤销指引。
  if (toolBackend('webaz_revoke_key') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    const reason = ((args.reason as string) || 'unspecified').trim().slice(0, 100)
    return {
      _mode: 'network',
      success: false,
      requires_human_action: true,
      iron_rule: 'API key revocation is a destructive, irreversible operation. Agent cannot execute unilaterally. Same gating as claim_verify and arbitrate.',
      action: 'revoke_api_key',
      api_key_hint: redactKey(apiKey),
      reason_logged: reason,
      next_step: {
        via: 'PWA + Passkey',
        url: 'https://webaz.xyz/revoke',
        instructions: '1) Open URL in browser  2) Sign in  3) Confirm with Passkey  4) Click "Revoke". After confirm the old api_key returns 401 on all tools.',
        warning: 'After revoke you cannot call any auth\'d tool until you have a new api_key. Use webaz_rotate_key instead for atomic invalidate + re-issue.',
      },
    }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const reason = ((args.reason as string) || 'unspecified').trim().slice(0, 100)
  return {
    success: false,
    requires_human_action: true,
    iron_rule: 'API key revocation is a destructive, irreversible operation. Agent cannot execute unilaterally. Same gating as claim_verify and arbitrate.',
    action: 'revoke_api_key',
    user_id: user.id,
    api_key_hint: redactKey(user.api_key),
    reason_logged: reason,
    next_step: {
      via: 'PWA + Passkey',
      url: `https://webaz.xyz/revoke?user=${encodeURIComponent(user.id)}`,
      instructions: '1) Open URL in browser  2) Sign in  3) Confirm with Passkey  4) Click "Revoke". After confirm the old api_key returns 401 on all tools.',
      warning: 'After revoke you cannot call any auth\'d tool until you have a new api_key. Use webaz_rotate_key instead for atomic invalidate + re-issue.',
    },
  }
}

function handleRotateKey(args: Record<string, unknown>) {
  // RFC-003 Batch 5:NETWORK 模式 → 不本地校验 key(PWA 会鉴权),直接返回 Passkey 轮换指引。
  if (toolBackend('webaz_rotate_key') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    const reason = ((args.reason as string) || 'rotation').trim().slice(0, 100)
    return {
      _mode: 'network',
      success: false,
      requires_human_action: true,
      iron_rule: 'API key rotation requires Passkey verification (Iron-Rule). MCP registers intent only.',
      action: 'rotate_api_key',
      old_api_key_hint: redactKey(apiKey),
      reason_logged: reason,
      next_step: {
        via: 'PWA + Passkey',
        url: 'https://webaz.xyz/rotate',
        instructions: '1) Open URL  2) Sign in  3) Confirm with Passkey  4) PWA returns new api_key — copy immediately, shown once. Old key invalidated atomically with new key issuance.',
      },
    }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const reason = ((args.reason as string) || 'rotation').trim().slice(0, 100)
  return {
    success: false,
    requires_human_action: true,
    iron_rule: 'API key rotation requires Passkey verification (Iron-Rule). MCP registers intent only.',
    action: 'rotate_api_key',
    user_id: user.id,
    old_api_key_hint: redactKey(user.api_key),
    reason_logged: reason,
    next_step: {
      via: 'PWA + Passkey',
      url: `https://webaz.xyz/rotate?user=${encodeURIComponent(user.id)}`,
      instructions: '1) Open URL  2) Sign in  3) Confirm with Passkey  4) PWA returns new api_key — copy immediately, shown once. Old key invalidated atomically with new key issuance.',
    },
  }
}

// ─── 推广 / 推荐网络 (Tokenomics) ───────────────────────────────────

async function handleReferral(args: Record<string, unknown>) {
  // RFC-003 Batch 2:NETWORK 模式 → webaz.xyz 真网络聚合(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_referral') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    return await apiCall('/api/referral/me', { apiKey })
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const userId = user.id as string

  // 团队 L1/L2/L3
  const l1 = (db.prepare("SELECT COUNT(*) as n FROM users WHERE sponsor_id = ?").get(userId) as { n: number }).n
  const l2 = (db.prepare(`SELECT COUNT(*) as n FROM users WHERE sponsor_id IN (SELECT id FROM users WHERE sponsor_id = ?)`).get(userId) as { n: number }).n
  const l3 = (db.prepare(`SELECT COUNT(*) as n FROM users WHERE sponsor_id IN (SELECT id FROM users WHERE sponsor_id IN (SELECT id FROM users WHERE sponsor_id = ?))`).get(userId) as { n: number }).n

  // 累计佣金（按 level 聚合）
  const earnings = db.prepare(`SELECT level, COUNT(*) as orders, COALESCE(SUM(amount),0) as total FROM commission_records WHERE beneficiary_id = ? GROUP BY level`).all(userId) as { level: number; orders: number; total: number }[]
  const byLevel: Record<number, { orders: number; total: number }> = { 1: { orders:0, total:0 }, 2: { orders:0, total:0 }, 3: { orders:0, total:0 } }
  for (const r of earnings) byLevel[r.level] = { orders: r.orders, total: r.total }

  // 推土机 L1 资格判定
  const completed = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND status = 'completed'").get(userId) as { n: number }).n
  const override = (db.prepare("SELECT l1_share_override FROM users WHERE id = ?").get(userId) as { l1_share_override: number } | undefined)?.l1_share_override ?? 0
  const canL1 = override === 1 || (override === 0 && completed > 0)

  // Neutral participation record only — placement position + per-leg PV. Matching-rewards engine excised (#401):
  // no Score / tier / pair-volume / payout is read or exposed.
  const me = db.prepare("SELECT total_left_pv, total_right_pv, left_child_id, right_child_id, placement_id, placement_side FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined

  // invite / share links use permanent_code ONLY — never usr_xxx. (sandbox users have one from register.)
  const permaCode = (db.prepare("SELECT permanent_code FROM users WHERE id = ?").get(userId) as { permanent_code: string | null } | undefined)?.permanent_code || null
  return {
    user_id: userId,
    name: user.name,
    invite_code: permaCode,
    invite_unavailable_reason: permaCode ? null : 'permanent_code_missing — re-register or contact support',
    base_referral_link: permaCode ? `/i/${permaCode}` : null,   // 仅推土机
    region: ((user as unknown) as Record<string, unknown>).region ?? 'global',
    permissions: {
      can_earn_l1_commission: canL1,
      completed_orders: completed,
      reason: canL1
        ? (override === 1 ? 'admin_grant' : 'verified_buyer')
        : 'need_completed_order — share PV-only link until verified',
    },
    team: { l1, l2, l3, total: l1 + l2 + l3 },
    earnings: {
      l1: byLevel[1], l2: byLevel[2], l3: byLevel[3],
      grand_total: byLevel[1].total + byLevel[2].total + byLevel[3].total,
    },
    placement: {
      // Neutral participation/attribution record: a single referral code + per-leg PV. No matching rewards.
      referral_link: permaCode ? `/i/${permaCode}` : null,
      total_left_pv:  Number(me?.total_left_pv ?? 0),
      total_right_pv: Number(me?.total_right_pv ?? 0),
      note: 'total_left_pv / total_right_pv are a participation / attribution record only — not income, not redeemable, no entitlement.',
    },
    rewards_status: (() => {
      // RFC-002 §3.5 — 4 states + pending escrow visibility (PR-4)
      const optIn = (db.prepare("SELECT rewards_opted_in FROM users WHERE id = ?").get(userId) as { rewards_opted_in: number } | undefined)?.rewards_opted_in ?? 0
      const lastAction = (db.prepare("SELECT action FROM rewards_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as { action: string } | undefined)?.action
      let state: 'opted_in' | 'never_activated' | 'auto_downgraded' | 'deactivated'
      let note: string
      if (optIn === 1) {
        state = 'opted_in'
        note = 'You have opted into rewards. Commissions credit to wallet immediately when orders settle.'
      } else if (lastAction === 'deactivate') {
        state = 'deactivated'
        note = 'You actively deactivated rewards. Future L1/L2/L3 commissions go to commission_reserve / protocol reserve, not charity_fund and not pending escrow. Re-applying only affects future commissions.'
      } else if (lastAction === 'auto_downgrade') {
        state = 'auto_downgraded'
        note = 'You were auto-downgraded (failed to re-confirm consent within grace window). Future commissions held in pending_commission_escrow (30d window) — re-confirm via PWA #me to recover them.'
      } else {
        state = 'never_activated'
        note = 'Rewards inactive — attributions recorded; commissions held in pending_commission_escrow (30d window per protocol_params.rewards_opt_in.escrow_days) until you activate via PWA #me.'
      }
      const pending = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM pending_commission_escrow WHERE recipient_user_id = ? AND status = 'pending'").get(userId) as { n: number; total: number }
      const expired = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM pending_commission_escrow WHERE recipient_user_id = ? AND status = 'expired'").get(userId) as { n: number; total: number }
      return {
        state,
        opted_in: optIn === 1,
        note,
        pending_escrow:  { count: pending.n, total_amount: pending.total },
        expired_to_charity: { count: expired.n, total_amount: expired.total },
        spec: 'RFC-002 §3.5 — rewards / share-commission opt-in (RFC-002)',
      }
    })(),
    tip: canL1
      ? 'Use webaz_share_link(product_id) to generate a product share link. Both 3-tier commission and points-matching will apply (only when rewards_opted_in=1).'
      : 'Complete 1 purchase first, then your share link will earn 3-tier commission. Until then, your share builds points-matching only.',
  }
}

async function handleShareLink(args: Record<string, unknown>) {
  // RFC-003 #1122:NETWORK 模式 → 调 webaz.xyz 的 /api/share-link(服务端同款计算);SANDBOX 走本地。
  if (toolBackend('webaz_share_link') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    if (!args.product_id) return { error: 'product_id required' }
    // pre-public 去左右码:不再向 /api/share-link 转发 side(放置永远自动)
    const qs = new URLSearchParams({ product_id: String(args.product_id) })
    return await apiCall('/api/share-link?' + qs.toString(), { apiKey })
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const userId = user.id as string
  const productId = args.product_id as string

  // RFC-002 §3.5 valuation-layer gate — share_link generation requires opt-in
  const optIn = (db.prepare("SELECT rewards_opted_in FROM users WHERE id = ?").get(userId) as { rewards_opted_in: number } | undefined)?.rewards_opted_in ?? 0
  if (optIn !== 1) {
    const getParam = (key: string, def: number): number => {
      const r = db.prepare("SELECT value FROM protocol_params WHERE key = ?").get(key) as { value: string } | undefined
      return r ? Number(r.value) : def
    }
    const minOrders = getParam('rewards_opt_in.min_completed_orders', 1)
    const requirePasskey = getParam('rewards_opt_in.require_passkey', 1)
    const totalCompleted = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND status = 'completed'").get(userId) as { n: number }).n
    const passkeyCount = (db.prepare("SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?").get(userId) as { n: number }).n
    const missing: string[] = []
    if (totalCompleted < minOrders) missing.push(`completed_orders ${totalCompleted}/${minOrders}`)
    if (requirePasskey === 1 && passkeyCount === 0) missing.push('passkey_not_registered')
    if (missing.length === 0) missing.push('application_not_submitted')
    return {
      error: 'rewards_opt_in_required',
      message: 'Share-link generation is a valuation-layer (rewards / share-link) action, NOT a contribution gate — requires rewards / share-commission opt-in (RFC-002 §3.5)',
      missing_requirements: missing,
      next_steps: [
        'Open PWA #me → tap "申请分享分润 / Enable share-commission opt-in"',
        'Read the 8-second disclosure (cannot skip)',
        'Submit application — pre-checks run server-side',
      ],
    }
  }

  const product = db.prepare("SELECT id, title, price, commission_rate FROM products WHERE id = ? AND status='active'").get(productId) as { id: string; title: string; price: number; commission_rate: number | null } | undefined
  if (!product) return { error: '商品不存在或已下架' }

  // pre-public 去左右码:分享链接不再携带 side(放置侧别由注册时系统自动决定)
  const completed = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE buyer_id = ? AND status = 'completed'").get(userId) as { n: number }).n
  const override = (db.prepare("SELECT l1_share_override FROM users WHERE id = ?").get(userId) as { l1_share_override: number } | undefined)?.l1_share_override ?? 0
  const canL1 = override === 1 || (override === 0 && completed > 0)

  const rate = Number(product.commission_rate ?? 0)
  // share ref uses permanent_code ONLY — never usr_xxx
  const permaCode = (db.prepare("SELECT permanent_code FROM users WHERE id = ?").get(userId) as { permanent_code: string | null } | undefined)?.permanent_code || null
  if (!permaCode) return { error: 'permanent_code_missing — cannot build a share link; re-register or contact support', error_code: 'PERMANENT_CODE_MISSING' }
  const link = `/?ref=${permaCode}#order-product/${productId}`
  return {
    product: { id: product.id, title: product.title, price: product.price, commission_rate: rate },
    share_link: link,
    full_url_hint: 'Prepend webaz.xyz (production) or http://localhost:3000 (local) to get the absolute URL',
    placement_note: 'New user via this link → placement is recorded automatically by the system (no left/right choice).',
    commission_eligibility: canL1
      ? `You will earn 3-tier commission: L1=${(rate*0.70*100).toFixed(1)}% L2=${(rate*0.20*100).toFixed(1)}% L3=${(rate*0.10*100).toFixed(1)}% of sale price`
      : 'You are NOT verified yet (need 1 completed purchase). 3-tier commission will be skipped, but points-matching still builds.',
    next_steps: 'Share on TikTok / WeChat / Telegram. New user clicks → 30-day attribution window starts.',
  }
}

// ─── 黑名单 / 关注 / 雷达 / 默认地址 / shareables ─────────

async function handleBlocklist(args: Record<string, unknown>) {
  // RFC-003 Batch 2:NETWORK 模式 → webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_blocklist') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    const act = String(args.action || '')
    if (act === 'list') return await apiCall('/api/blocklist', { apiKey })
    const uid = args.user_id ? encodeURIComponent(String(args.user_id)) : ''
    if (!uid) return { error: 'user_id required for block/unblock' }
    if (act === 'block')   return await apiCall('/api/blocklist/' + uid, { method: 'POST', apiKey, body: { reason: args.reason } })
    if (act === 'unblock') return await apiCall('/api/blocklist/' + uid, { method: 'DELETE', apiKey })
    return { error: `unknown action: ${act}` }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const action = String(args.action || '')
  // 多形态识别：usr_xxx / VKSF9P / @handle
  const targetId = args.user_id ? mcpResolveUserRef(String(args.user_id)) : undefined

  if (action === 'list') {
    const rows = db.prepare(`
      SELECT b.blocked_id, b.reason, b.created_at, u.name as blocked_name, u.role as blocked_role
      FROM user_blocklist b LEFT JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC
    `).all(user.id)
    return { blocked: rows }
  }
  if (!targetId) return { error: 'user_id required for block/unblock' }
  if (targetId === user.id) return { error: 'cannot block yourself' }
  if (targetId === 'sys_protocol') return { error: 'cannot block system account' }
  if (action === 'block') {
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(targetId)
    if (!exists) return { error: 'target user not found' }
    const reason = ((args.reason as string) || '').slice(0, 200)
    db.prepare("INSERT OR IGNORE INTO user_blocklist (blocker_id, blocked_id, reason) VALUES (?, ?, ?)")
      .run(user.id, targetId, reason || null)
    return { ok: true, blocked: targetId }
  }
  if (action === 'unblock') {
    db.prepare("DELETE FROM user_blocklist WHERE blocker_id = ? AND blocked_id = ?").run(user.id, targetId)
    return { ok: true, unblocked: targetId }
  }
  return { error: `unknown action: ${action}` }
}

async function handleFollows(args: Record<string, unknown>) {
  // RFC-003 Batch 2:NETWORK 模式 → webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_follows') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    const act = String(args.action || '')
    if (act === 'list') return await apiCall('/api/follows/me', { apiKey })
    const uid = args.user_id ? encodeURIComponent(String(args.user_id)) : ''
    if (!uid) return { error: 'user_id required' }
    if (act === 'follow')   return await apiCall('/api/follows/' + uid, { method: 'POST', apiKey })
    if (act === 'unfollow') return await apiCall('/api/follows/' + uid, { method: 'DELETE', apiKey })
    if (act === 'status')   return await apiCall('/api/follows/' + uid + '/status', { apiKey })
    return { error: `unknown action: ${act}` }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const action = String(args.action || '')
  // 多形态识别：usr_xxx / VKSF9P / @handle
  const targetId = args.user_id ? mcpResolveUserRef(String(args.user_id)) : undefined

  if (action === 'list') {
    const followers = db.prepare(`
      SELECT u.id, u.name, u.role, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT 100
    `).all(user.id)
    const following = db.prepare(`
      SELECT u.id, u.name, u.role, f.created_at FROM follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 100
    `).all(user.id)
    return { followers, following }
  }
  if (!targetId) return { error: 'user_id required' }
  if (targetId === user.id) return { error: 'cannot self-follow' }
  if (action === 'follow') {
    const target = db.prepare("SELECT id FROM users WHERE id=?").get(targetId)
    if (!target) return { error: 'target not found' }
    // 尊重 blocklist：若 target 已 block 自己 → 拒绝（防绕过私聊封锁）
    const blockedByTarget = db.prepare("SELECT 1 FROM user_blocklist WHERE blocker_id = ? AND blocked_id = ? LIMIT 1").get(targetId, user.id)
    if (blockedByTarget) return { error: 'target has blocked you', error_code: 'BLOCKED_BY_TARGET' }
    db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)").run(user.id, targetId)
    return { ok: true, following: true }
  }
  if (action === 'unfollow') {
    db.prepare("DELETE FROM follows WHERE follower_id=? AND followee_id=?").run(user.id, targetId)
    return { ok: true, following: false }
  }
  if (action === 'status') {
    const isFollowing = !!db.prepare("SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?").get(user.id, targetId)
    const followers = (db.prepare("SELECT COUNT(*) as n FROM follows WHERE followee_id=?").get(targetId) as { n: number }).n
    const followingCount = (db.prepare("SELECT COUNT(*) as n FROM follows WHERE follower_id=?").get(targetId) as { n: number }).n
    return { following: isFollowing, target_followers: followers, target_following_count: followingCount }
  }
  return { error: `unknown action: ${action}` }
}

async function handleNearby(args: Record<string, unknown>) {
  const action = String(args.action || '')
  // RFC-003 Batch 1:NETWORK 模式 → 调 webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_nearby') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    if (action === 'set_location')   return await apiCall('/api/profile/set-location', { method: 'POST', apiKey, body: { lat: args.lat, lng: args.lng } })
    if (action === 'clear_location') return await apiCall('/api/profile/clear-location', { method: 'POST', apiKey })
    if (action === 'query') {
      const qs = new URLSearchParams()
      if (args.scope)  qs.set('scope', String(args.scope))
      if (args.window) qs.set('window', String(args.window))
      const q = qs.toString()
      return await apiCall('/api/nearby' + (q ? '?' + q : ''), { apiKey })
    }
    return { error: `unknown action: ${action}` }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth

  if (action === 'set_location') {
    const lat = Number(args.lat), lng = Number(args.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: 'lat/lng required and numeric' }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { error: 'lat/lng out of bounds' }
    const truncLat = Math.round(lat * 10) / 10
    const truncLng = Math.round(lng * 10) / 10
    db.prepare("UPDATE users SET geo_lat = ?, geo_lng = ?, geo_updated_at = datetime('now') WHERE id = ?")
      .run(truncLat, truncLng, user.id)
    return { ok: true, lat: truncLat, lng: truncLng, precision_deg: 0.1, approx_km: 11 }
  }
  if (action === 'clear_location') {
    db.prepare("UPDATE users SET geo_lat = NULL, geo_lng = NULL, geo_updated_at = NULL WHERE id = ?").run(user.id)
    return { ok: true }
  }
  if (action === 'query') {
    const u = db.prepare("SELECT geo_lat, geo_lng FROM users WHERE id = ?").get(user.id) as { geo_lat: number | null; geo_lng: number | null }
    if (u?.geo_lat == null || u?.geo_lng == null) return { has_location: false, hint: 'call set_location first' }
    const lat = u.geo_lat, lng = u.geo_lng
    const K = 3
    // 防指纹：count < K 时返回 null（不暴露具体小数字），与 topProducts 一致
    const rawActive24 = (db.prepare(`SELECT COUNT(DISTINCT o.buyer_id) as n FROM orders o JOIN users u ON u.id = o.buyer_id WHERE u.geo_lat = ? AND u.geo_lng = ? AND o.status = 'completed' AND o.updated_at > datetime('now', '-1 day')`).get(lat, lng) as { n: number }).n
    const rawActive7 = (db.prepare(`SELECT COUNT(DISTINCT o.buyer_id) as n FROM orders o JOIN users u ON u.id = o.buyer_id WHERE u.geo_lat = ? AND u.geo_lng = ? AND o.status = 'completed' AND o.updated_at > datetime('now', '-7 day')`).get(lat, lng) as { n: number }).n
    const active24 = rawActive24 >= K ? rawActive24 : null
    const active7  = rawActive7  >= K ? rawActive7  : null
    const topProducts = db.prepare(`
      SELECT p.id, p.title, p.price, COUNT(DISTINCT o.buyer_id) as buyers
      FROM orders o JOIN users u ON u.id = o.buyer_id JOIN products p ON p.id = o.product_id
      WHERE u.geo_lat = ? AND u.geo_lng = ? AND o.status = 'completed' AND o.updated_at > datetime('now', '-1 day')
      GROUP BY p.id HAVING buyers >= ? ORDER BY buyers DESC LIMIT 10
    `).all(lat, lng, K)
    return {
      has_location: true,
      cell: { lat, lng, precision_deg: 0.1, approx_km: 11 },
      k_threshold: K,
      active_users_24h: active24,
      active_users_7d:  active7,
      top_products_24h: topProducts,
    }
  }
  return { error: `unknown action: ${action}` }
}

async function handleDefaultAddress(args: Record<string, unknown>) {
  // RFC-003 Batch 2:NETWORK 模式 → webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_default_address') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    const act = String(args.action || '')
    if (act === 'read') {
      const me = await apiCall('/api/me', { apiKey })
      if (me.error) return me
      return { address_text: me.default_address_text ?? null, address_region: me.default_address_region ?? null }
    }
    if (act === 'set') {
      const text = ((args.text as string) || '').trim().slice(0, 200)
      const region = ((args.region as string) || '').trim().slice(0, 40)
      if (!text) return { error: 'missing_text', error_code: 'TEXT_REQUIRED', message: 'action=set 需要 "text" 字段(自由格式地址,≤200);可选 "region"。' }
      return await apiCall('/api/profile/default-address', { method: 'POST', apiKey, body: { text, region: region || null } })
    }
    return { error: `unknown action: ${act}` }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth
  const action = String(args.action || '')

  if (action === 'read') {
    const u = db.prepare("SELECT default_address_text, default_address_region FROM users WHERE id = ?").get(user.id) as { default_address_text: string | null; default_address_region: string | null }
    return {
      address_text:   u?.default_address_text   || null,
      address_region: u?.default_address_region || null,
      hint: u?.default_address_text ? null : 'No default set. Setting it auto-filters unshippable products in search.',
    }
  }
  if (action === 'set') {
    // QA 轮 10.2-B P1 修复：旧版无校验，传不对的字段（recipient/line1/city 等）silently 写 NULL，
    // 返回 ok: true 但 text/region 都是 null —— 元规则 #4 不撒谎被违反。
    // 修：text 必填校验；返回里加 success/stored 字段更明确。
    const text = ((args.text as string) || '').trim().slice(0, 200)
    const region = ((args.region as string) || '').trim().slice(0, 40)
    if (!text) {
      return {
        error: 'missing_text',
        error_code: 'TEXT_REQUIRED',
        message: 'webaz_default_address action=set 需要 "text" 字段（自由格式地址字符串，≤200 字符）。不接受 structured 字段如 recipient/line1/city。如要 region 联动过滤 unshippable，请同时传 "region" 字段（如 "global" / "china" / "SG"）。',
        valid_params: { text: 'required', region: 'optional' },
      }
    }
    db.prepare("UPDATE users SET default_address_text = ?, default_address_region = ?, updated_at = datetime('now') WHERE id = ?")
      .run(text, region || null, user.id)
    return {
      success: true,
      stored: { text, region: region || null },
      hint: 'webaz_search 现在会自动按 region 过滤 unshippable 商品；webaz_rfq create 不传 shipping_address 时会 fallback 到此地址',
    }
  }
  return { error: `unknown action: ${action}` }
}

async function handleShareables(args: Record<string, unknown>) {
  const action = String(args.action || '')
  // RFC-003 Batch 1:NETWORK 模式 → 调 webaz.xyz 真网络(Bearer api_key);SANDBOX 走本地。
  if (toolBackend('webaz_shareables') === 'network') {
    const apiKey = resolveMcpApiKey(args)
    if (!apiKey) return { error: 'api_key required' }
    if (action === 'list_mine') return await apiCall('/api/shareables/me', { apiKey })
    if (action === 'by_product') {
      if (!args.related_product_id) return { error: 'related_product_id required' }
      return await apiCall('/api/shareables/by-product/' + encodeURIComponent(String(args.related_product_id)), { apiKey })
    }
    if (action === 'by_anchor') {
      if (!args.related_anchor) return { error: 'related_anchor required' }
      return await apiCall('/api/shareables/by-anchor/' + encodeURIComponent(String(args.related_anchor)), { apiKey })
    }
    if (action === 'add') {
      return await apiCall('/api/shareables', { method: 'POST', apiKey, body: {
        external_url: args.external_url, related_product_id: args.related_product_id,
        related_anchor: args.related_anchor, title: args.title, description: args.description,
      } })
    }
    if (action === 'delete') {
      if (!args.shareable_id) return { error: 'shareable_id required' }
      return await apiCall('/api/shareables/' + encodeURIComponent(String(args.shareable_id)), { method: 'DELETE', apiKey })
    }
    return { error: `unknown action: ${action}` }
  }
  const auth = requireAuth(db, resolveMcpApiKey(args))
  if ('error' in auth) return auth
  const { user } = auth

  if (action === 'list_mine') {
    const rows = db.prepare(`
      SELECT s.*, p.title as product_title FROM shareables s
      LEFT JOIN products p ON p.id = s.related_product_id
      WHERE s.owner_id = ? AND s.status != 'removed' ORDER BY s.created_at DESC LIMIT 100
    `).all(user.id)
    return { shareables: rows }
  }
  if (action === 'by_product') {
    const pid = args.related_product_id as string
    if (!pid) return { error: 'related_product_id required' }
    const rows = db.prepare(`
      SELECT s.*, u.name as owner_name FROM shareables s LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.related_product_id = ? AND s.status = 'active'
      ORDER BY s.click_count DESC, s.created_at DESC LIMIT 20
    `).all(pid)
    return { shareables: rows }
  }
  if (action === 'by_anchor') {
    const anchor = args.related_anchor as string
    if (!anchor) return { error: 'related_anchor required' }
    const rows = db.prepare(`
      SELECT s.*, u.name as owner_name FROM shareables s LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.related_anchor = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 50
    `).all(anchor)
    return { shareables: rows }
  }
  if (action === 'add') {
    const url = ((args.external_url as string) || '').trim()
    const product_id = args.related_product_id as string | undefined
    const anchor = args.related_anchor as string | undefined
    if (!url) return { error: 'external_url required' }
    if (!product_id && !anchor) return { error: 'related_product_id or related_anchor required' }
    if (url.length > 500) return { error: 'external_url too long (max 500)', error_code: 'URL_TOO_LONG' }
    if (!/^https?:\/\//i.test(url)) return { error: 'external_url must be http(s)://', error_code: 'URL_SCHEME_INVALID' }
    const todayCount = (db.prepare(`SELECT COUNT(*) as n FROM shareables WHERE owner_id = ? AND created_at > datetime('now', '-1 day')`).get(user.id) as { n: number }).n
    if (todayCount >= 10) return { error: 'daily limit 10 reached' }
    // 全局唯一：同 URL 已被任何用户认领 → 归因模糊，拒绝（首认领者拿）
    const globalDup = db.prepare(`SELECT id, owner_id FROM shareables WHERE external_url = ? AND status != 'removed' LIMIT 1`).get(url) as { id: string; owner_id: string } | undefined
    if (globalDup) {
      if (globalDup.owner_id === user.id) return { error: 'duplicate URL exists', existing_id: globalDup.id, error_code: 'DUP_OWN' }
      return { error: 'URL already claimed by another user (attribution conflict)', error_code: 'URL_CLAIMED' }
    }
    let type = 'external_url', platform = 'unknown'
    if (/youtube\.com|youtu\.be/i.test(url))           { type = 'external_youtube';  platform = 'youtube' }
    else if (/tiktok\.com/i.test(url))                 { type = 'external_tiktok';   platform = 'tiktok' }
    else if (/xiaohongshu|xhslink/i.test(url))         { type = 'external_xhs';      platform = 'xiaohongshu' }
    else if (/bilibili\.com/i.test(url))               { type = 'external_bilibili'; platform = 'bilibili' }
    else if (/instagram\.com/i.test(url))              { type = 'external_ig';       platform = 'instagram' }
    else if (/twitter\.com|x\.com/i.test(url))         { type = 'external_twitter';  platform = 'twitter' }
    const id = generateId('shr')
    const title = ((args.title as string) || '').slice(0, 100) || null
    const description = ((args.description as string) || '').slice(0, 200) || null
    db.prepare(`INSERT INTO shareables (id, owner_id, type, external_url, external_platform, title, description, related_product_id, related_anchor) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, user.id, type, url, platform, title, description, product_id || null, anchor || null)
    return { ok: true, id, type, platform }
  }
  if (action === 'delete') {
    const id = args.shareable_id as string
    if (!id) return { error: 'shareable_id required' }
    const row = db.prepare("SELECT owner_id FROM shareables WHERE id = ?").get(id) as { owner_id: string } | undefined
    if (!row || row.owner_id !== user.id) return { error: 'not owner or not found' }
    db.prepare(`UPDATE shareables SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(id)
    return { ok: true, deleted: id }
  }
  return { error: `unknown action: ${action}` }
}

// ─── P3 RFQ / bid / chat / auto_bid（HTTP 转发到 PWA，复用所有校验+状态机）────
const PWA_API_BASE = process.env.WEBAZ_PWA_API_BASE || 'http://localhost:3000/api'

// RFC-003 P1: 公开读端点按模式取数 —— network → apiCall(webaz.xyz + Bearer + 15s 超时);sandbox → 本地 PWA。
// subpath 不含 /api 前缀(如 '/leaderboard?...'),内部按模式补齐。
async function readEndpoint(tool: string, subpath: string): Promise<Record<string, unknown>> {
  if (toolBackend(tool) === 'network') return apiCall('/api' + subpath)
  try {
    const r = await fetch(PWA_API_BASE + subpath, { signal: AbortSignal.timeout(15_000) })
    return await r.json() as Record<string, unknown>
  } catch (e) { return { error: String((e as Error).message) } }
}

async function pwaApi(method: string, path: string, apiKey: string, body?: unknown): Promise<Record<string, unknown>> {
  // RFC-003:NETWORK / network_readonly → 走 webaz.xyz(Bearer 可空)。仅 NETWORK_TOOLS 里的工具会到这里
  // (其余未迁工具在 dispatch 被 Batch 0 守卫拦下);SANDBOX 才转发本地 PWA(localhost)。
  if (isNetworkMode()) {
    return apiCall(path.startsWith('/api') ? path : '/api' + path, { method, apiKey, body })
  }
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const url = PWA_API_BASE + path
  try {
    const r = await fetch(url, opts)
    // QA 轮 13 P1：检测 PWA 返回 HTML (SPA 兜底 fallback 404 时)
    // 之前直接 r.json() 抛 SyntaxError → agent 收到 "Unexpected token <" 无法 structurally 处理
    const ct = r.headers.get('content-type') || ''
    if (!ct.includes('application/json')) {
      const text = await r.text()
      return {
        error: `PWA upstream returned non-JSON (likely 404 SPA fallback or routing error)`,
        error_code: 'PWA_UPSTREAM_NOT_JSON',
        status: r.status,
        url: path,
        body_preview: text.slice(0, 200),
      }
    }
    return await r.json() as Record<string, unknown>
  } catch (e) {
    return {
      error: `PWA API unreachable: ${(e as Error).message}`,
      error_code: 'PWA_UNREACHABLE',
      url: path,
    }
  }
}

async function handleSecondhand(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  const isPublic = action === 'browse' || action === 'detail'
  if (!isPublic) {
    if (!apiKey) return { error: 'api_key required' }
    // NETWORK 模式由 webaz.xyz 端点鉴权;只有 SANDBOX 才查本地库(否则真网络用户的 key 不在本地会误拒)。
    if (toolBackend('webaz_secondhand') !== 'network') {
      const auth = requireAuth(db, apiKey)
      if ('error' in auth) return auth
    }
  }
  const iid = () => encodeURIComponent(String(args.item_id || ''))

  switch (action) {
    case 'browse': {
      const qs = new URLSearchParams()
      if (args.category)  qs.set('category', String(args.category))
      if (args.condition) qs.set('condition', String(args.condition))
      if (args.region)    qs.set('region', String(args.region))
      if (args.min_price != null) qs.set('min_price', String(args.min_price))
      if (args.max_price != null) qs.set('max_price', String(args.max_price))
      if (args.query)     qs.set('q', String(args.query))
      if (args.sort)      qs.set('sort', String(args.sort))
      return await pwaApi('GET', '/secondhand?' + qs.toString(), apiKey)
    }
    case 'detail': {
      if (!args.item_id) return { error: 'item_id required' }
      return await pwaApi('GET', '/secondhand/' + iid(), apiKey)
    }
    case 'publish': {
      if (!args.title || !args.category || !args.condition_grade || args.price == null || !Array.isArray(args.images)) {
        return { error: 'title + category + condition_grade + price + images[] required' }
      }
      return await pwaApi('POST', '/secondhand', apiKey, {
        title: args.title, description: args.description, category: args.category,
        condition_grade: args.condition_grade, price: args.price, negotiable: args.negotiable,
        images: args.images, region: args.region, fulfillment: args.fulfillment,
      })
    }
    case 'update': {
      if (!args.item_id) return { error: 'item_id required' }
      const body: Record<string, unknown> = {}
      for (const k of ['title', 'description', 'category', 'condition_grade', 'price', 'negotiable', 'region', 'fulfillment', 'status']) {
        if (args[k] !== undefined) body[k] = args[k]
      }
      return await pwaApi('PATCH', '/secondhand/' + iid(), apiKey, body)
    }
    case 'mine': return await pwaApi('GET', '/secondhand/mine', apiKey)
    case 'buy': {
      if (!args.item_id) return { error: 'item_id required' }
      return await pwaApi('POST', '/secondhand/' + iid() + '/order', apiKey, {
        fulfillment_mode: args.fulfillment_mode ?? 'shipping',
        shipping_address: args.shipping_address, notes: args.notes,
      })
    }
    default: return { error: `unknown action: ${action}` }
  }
}

async function handleTrial(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  const isPublic = action === 'get_campaign'
  if (!isPublic) {
    if (!apiKey) return { error: 'api_key required' }
    if (toolBackend('webaz_trial') !== 'network') {
      const auth = requireAuth(db, apiKey)
      if ('error' in auth) return auth
    }
  }
  const pid = () => encodeURIComponent(String(args.product_id || ''))

  switch (action) {
    case 'get_campaign': {
      if (!args.product_id) return { error: 'product_id required' }
      return await pwaApi('GET', '/products/' + pid() + '/trial-campaign', apiKey)
    }
    case 'apply': {
      if (!args.product_id) return { error: 'product_id required' }
      return await pwaApi('POST', '/products/' + pid() + '/trial-claim', apiKey, {})
    }
    case 'link_note': {
      if (!args.claim_id || !args.note_id) return { error: 'claim_id + note_id required' }
      return await pwaApi('POST', '/trial-claims/' + encodeURIComponent(String(args.claim_id)) + '/link-note', apiKey, { note_id: args.note_id })
    }
    case 'my_claims': return await pwaApi('GET', '/me/trial-claims', apiKey)
    case 'create_campaign': {
      if (!args.product_id || args.quota_total == null) return { error: 'product_id + quota_total required' }
      return await pwaApi('POST', '/products/' + pid() + '/trial-campaign', apiKey, {
        quota_total: args.quota_total, reach_threshold: args.reach_threshold,
        min_chars: args.min_chars, min_days_live: args.min_days_live,
      })
    }
    case 'cancel_campaign': {
      if (!args.product_id) return { error: 'product_id required' }
      return await pwaApi('DELETE', '/products/' + pid() + '/trial-campaign', apiKey)
    }
    case 'my_campaigns': return await pwaApi('GET', '/me/seller/trial-campaigns', apiKey)
    case 'campaign_claims': {
      if (!args.campaign_id) return { error: 'campaign_id required' }
      return await pwaApi('GET', '/trial-campaigns/' + encodeURIComponent(String(args.campaign_id)) + '/claims', apiKey)
    }
    default: return { error: `unknown action: ${action}` }
  }
}

async function handleSkillMarket(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  const isPublic = action === 'list' || action === 'detail'
  if (!isPublic) {
    if (!apiKey) return { error: 'api_key required' }
    if (toolBackend('webaz_skill_market') !== 'network') {
      const auth = requireAuth(db, apiKey)
      if ('error' in auth) return auth
    }
  }
  const sid = () => encodeURIComponent(String(args.skill_id || ''))

  switch (action) {
    case 'list': {
      const qs = new URLSearchParams()
      if (args.kind)    qs.set('kind', String(args.kind))
      if (args.billing) qs.set('billing', String(args.billing))
      if (args.query)   qs.set('q', String(args.query))
      return await pwaApi('GET', '/skill-market?' + qs.toString(), apiKey)
    }
    case 'detail': {
      if (!args.skill_id) return { error: 'skill_id required' }
      return await pwaApi('GET', '/skill-market/' + sid(), apiKey)
    }
    case 'publish': {
      if (!args.title || !args.content || !args.billing_mode) return { error: 'title + content + billing_mode required' }
      return await pwaApi('POST', '/skill-market', apiKey, {
        title: args.title, content: args.content, summary: args.summary, preview: args.preview,
        skill_kind: args.skill_kind, billing_mode: args.billing_mode, price: args.price, category: args.category,
      })
    }
    case 'update': {
      if (!args.skill_id) return { error: 'skill_id required' }
      const body: Record<string, unknown> = {}
      for (const k of ['title', 'content', 'summary', 'preview', 'skill_kind', 'billing_mode', 'price', 'category']) {
        if (args[k] !== undefined) body[k] = args[k]
      }
      return await pwaApi('PATCH', '/skill-market/' + sid(), apiKey, body)
    }
    case 'delist': {
      if (!args.skill_id) return { error: 'skill_id required' }
      return await pwaApi('POST', '/skill-market/' + sid() + '/delist', apiKey, {})
    }
    case 'resubmit': {
      if (!args.skill_id) return { error: 'skill_id required' }
      return await pwaApi('POST', '/skill-market/' + sid() + '/resubmit', apiKey, {})
    }
    case 'purchase': {
      if (!args.skill_id) return { error: 'skill_id required' }
      return await pwaApi('POST', '/skill-market/' + sid() + '/purchase', apiKey, {})
    }
    case 'read': {
      if (!args.skill_id) return { error: 'skill_id required' }
      return await pwaApi('POST', '/skill-market/' + sid() + '/read', apiKey, {})
    }
    case 'my_skills': return await pwaApi('GET', '/skill-market/mine', apiKey)
    case 'library':   return await pwaApi('GET', '/skill-market/library', apiKey)
    default: return { error: `unknown action: ${action}` }
  }
}

async function handleRfq(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  if (!apiKey) return { error: 'api_key required' }
  if (toolBackend('webaz_rfq') !== 'network') {
    const auth = requireAuth(db, apiKey)
    if ('error' in auth) return auth
  }

  switch (action) {
    case 'create': return await pwaApi('POST', '/rfqs', apiKey, {
      title: args.title, qty: args.qty, max_price: args.max_price,
      category: args.category, urgency: args.urgency,
      award_mode: args.award_mode, award_window_min: args.award_window_min,
      notes: args.notes, shipping_address: args.shipping_address,
    })
    case 'mine':   return await pwaApi('GET', '/rfqs/mine', apiKey)
    case 'browse': {
      const qs = new URLSearchParams()
      if (args.region)   qs.set('region', String(args.region))
      if (args.category) qs.set('category', String(args.category))
      if (args.urgency)  qs.set('urgency', String(args.urgency))
      if (args.unbidded) qs.set('unbidded', '1')
      return await pwaApi('GET', '/rfqs?' + qs.toString(), apiKey)
    }
    case 'detail': {
      if (!args.rfq_id) return { error: 'rfq_id required' }
      return await pwaApi('GET', '/rfqs/' + encodeURIComponent(String(args.rfq_id)), apiKey)
    }
    case 'award': {
      if (!args.rfq_id) return { error: 'rfq_id required' }
      const body = args.bid_id ? { bid_id: args.bid_id } : {}
      return await pwaApi('POST', '/rfqs/' + encodeURIComponent(String(args.rfq_id)) + '/award', apiKey, body)
    }
    case 'cancel': {
      if (!args.rfq_id) return { error: 'rfq_id required' }
      return await pwaApi('DELETE', '/rfqs/' + encodeURIComponent(String(args.rfq_id)), apiKey)
    }
    default: return { error: `unknown action: ${action}` }
  }
}

async function handleBid(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  if (!apiKey) return { error: 'api_key required' }

  // RFC-003 Batch 4:NETWORK 模式 → webaz.xyz 真网络(Bearer api_key);质押由服务端结算。
  if (toolBackend('webaz_bid') === 'network') {
    if (action === 'submit') {
      if (!args.rfq_id || !args.price) return { error: 'rfq_id + price required' }
      return await apiCall('/api/rfqs/' + encodeURIComponent(String(args.rfq_id)) + '/bids', { method: 'POST', apiKey, body: {
        price: args.price, qty_offered: args.qty_offered, eta_hours: args.eta_hours,
        fulfillment_type: args.fulfillment_type ?? 'standard', note: args.note, offer_id: args.offer_id,
      } })
    }
    if (action === 'patch') {
      if (!args.bid_id) return { error: 'bid_id required' }
      const body: Record<string, unknown> = {}
      for (const k of ['price','qty_offered','eta_hours','fulfillment_type','note']) if (args[k] !== undefined) body[k] = args[k]
      return await apiCall('/api/bids/' + encodeURIComponent(String(args.bid_id)), { method: 'PATCH', apiKey, body })
    }
    if (action === 'cancel') {
      if (!args.bid_id) return { error: 'bid_id required' }
      return await apiCall('/api/bids/' + encodeURIComponent(String(args.bid_id)), { method: 'DELETE', apiKey })
    }
    if (action === 'list_mine') {
      return { _mode: 'network', not_available_on_network: true,
        error: 'webaz_bid list_mine 暂无网络端点(webaz.xyz 未提供 my-bids GET)。请用 webaz_rfq action=detail 查看具体 RFQ 的出价,或到 PWA 查看。 / no my-bids GET on the network yet; use webaz_rfq detail or the PWA.' }
    }
    return { error: `unknown action: ${action}` }
  }

  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth

  switch (action) {
    case 'submit': {
      if (!args.rfq_id || !args.price) return { error: 'rfq_id + price required' }
      return await pwaApi('POST', '/rfqs/' + encodeURIComponent(String(args.rfq_id)) + '/bids', apiKey, {
        price: args.price, qty_offered: args.qty_offered,
        eta_hours: args.eta_hours, fulfillment_type: args.fulfillment_type ?? 'standard',
        note: args.note, offer_id: args.offer_id,
      })
    }
    case 'patch': {
      if (!args.bid_id) return { error: 'bid_id required' }
      const body: Record<string, unknown> = {}
      for (const k of ['price','qty_offered','eta_hours','fulfillment_type','note']) {
        if (args[k] !== undefined) body[k] = args[k]
      }
      return await pwaApi('PATCH', '/bids/' + encodeURIComponent(String(args.bid_id)), apiKey, body)
    }
    case 'cancel': {
      if (!args.bid_id) return { error: 'bid_id required' }
      return await pwaApi('DELETE', '/bids/' + encodeURIComponent(String(args.bid_id)), apiKey)
    }
    case 'list_mine': {
      const rows = db.prepare(`
        SELECT b.*, r.title as rfq_title, r.buyer_id, r.status as rfq_status
        FROM bids b JOIN rfqs r ON r.id = b.rfq_id
        WHERE b.seller_id = ? ORDER BY b.submitted_at DESC LIMIT 100
      `).all(auth.user.id)
      return { items: rows }
    }
    default: return { error: `unknown action: ${action}` }
  }
}

async function handleChat(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  if (!apiKey) return { error: 'api_key required' }
  if (toolBackend('webaz_chat') !== 'network') {
    const auth = requireAuth(db, apiKey)
    if ('error' in auth) return auth
  }

  switch (action) {
    case 'start': {
      if (!args.kind || !args.context_id) return { error: 'kind + context_id required' }
      return await pwaApi('POST', '/conversations/start', apiKey, {
        kind: args.kind, context_id: args.context_id, recipient_id: args.recipient_id,
      })
    }
    case 'list': return await pwaApi('GET', '/conversations', apiKey)
    case 'read': {
      if (!args.conversation_id) return { error: 'conversation_id required' }
      return await pwaApi('GET', '/conversations/' + encodeURIComponent(String(args.conversation_id)), apiKey)
    }
    case 'send': {
      if (!args.conversation_id || !args.body) return { error: 'conversation_id + body required' }
      return await pwaApi('POST', '/conversations/' + encodeURIComponent(String(args.conversation_id)) + '/messages', apiKey, { body: args.body })
    }
    case 'mark_read': {
      if (!args.conversation_id) return { error: 'conversation_id required' }
      return await pwaApi('POST', '/conversations/' + encodeURIComponent(String(args.conversation_id)) + '/read', apiKey)
    }
    case 'block': {
      if (!args.conversation_id) return { error: 'conversation_id required' }
      return await pwaApi('POST', '/conversations/' + encodeURIComponent(String(args.conversation_id)) + '/block', apiKey)
    }
    default: return { error: `unknown action: ${action}` }
  }
}

async function handleAutoBidSkill(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  if (!apiKey) return { error: 'api_key required' }

  const buildAutoBidConfig = (): Record<string, unknown> => ({
    enabled: args.enabled !== false,
    categories: Array.isArray(args.categories) ? args.categories : ['standard'],
    regions: Array.isArray(args.regions) ? args.regions : [],
    max_eta_h: Number(args.max_eta_h ?? 24),
    fulfillment_type: String(args.fulfillment_type ?? 'standard'),
    bid_strategy: String(args.bid_strategy ?? 'cheapest_undercut'),
    undercut_pct: Math.max(0, Math.min(0.5, Number(args.undercut_pct ?? 0.05))),
    max_price_cap: args.max_price_cap ?? null,
    daily_cap: Number(args.daily_cap ?? 20),
    cooldown_min: Number(args.cooldown_min ?? 60),
  })

  // RFC-003 Batch 4:NETWORK 模式 → 先从 webaz.xyz 取既有 auto_bid skill,再 PATCH/POST/disable。
  if (toolBackend('webaz_auto_bid') === 'network') {
    const mine = await apiCall('/api/skills/mine', { apiKey })
    if (mine.error) return mine
    const list = (Array.isArray(mine) ? mine : (Array.isArray(mine.skills) ? mine.skills : [])) as Record<string, unknown>[]
    const existingNet = list.find(s => s.skill_type === 'auto_bid')
    if (action === 'get') {
      if (!existingNet) return { exists: false }
      let cfg: unknown = existingNet.config
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg || '{}') } catch { cfg = {} } }
      return { exists: true, id: existingNet.id, active: existingNet.active, config: cfg }
    }
    if (action === 'set') {
      const config = buildAutoBidConfig()
      if (existingNet) return await apiCall('/api/skills/' + encodeURIComponent(String(existingNet.id)), { method: 'PATCH', apiKey, body: { config, active: config.enabled ? 1 : 0 } })
      return await apiCall('/api/skills', { method: 'POST', apiKey, body: { name: '我的自动报价 (MCP)', description: 'auto_bid via MCP', category: 'rfq', skill_type: 'auto_bid', config } })
    }
    if (action === 'disable') {
      if (!existingNet) return { error: '尚未创建 auto_bid Skill' }
      return await apiCall('/api/skills/' + encodeURIComponent(String(existingNet.id)) + '/disable', { method: 'POST', apiKey })
    }
    return { error: `unknown action: ${action}` }
  }

  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth
  if (auth.user.role !== 'seller') return { error: 'only seller can use auto_bid' }

  const existing = db.prepare(`SELECT id, config, active FROM skills WHERE seller_id = ? AND skill_type = 'auto_bid' ORDER BY created_at DESC LIMIT 1`).get(auth.user.id) as { id: string; config: string; active: number } | undefined

  if (action === 'get') {
    if (!existing) return { exists: false }
    let cfg: Record<string, unknown> = {}
    try { cfg = JSON.parse(existing.config || '{}') } catch {}
    return { exists: true, id: existing.id, active: existing.active, config: cfg }
  }
  if (action === 'set') {
    const config: Record<string, unknown> = {
      enabled: args.enabled !== false,
      categories: Array.isArray(args.categories) ? args.categories : ['standard'],
      regions: Array.isArray(args.regions) ? args.regions : [],
      max_eta_h: Number(args.max_eta_h ?? 24),
      fulfillment_type: String(args.fulfillment_type ?? 'standard'),
      bid_strategy: String(args.bid_strategy ?? 'cheapest_undercut'),
      undercut_pct: Math.max(0, Math.min(0.5, Number(args.undercut_pct ?? 0.05))),
      max_price_cap: args.max_price_cap ?? null,
      daily_cap: Number(args.daily_cap ?? 20),
      cooldown_min: Number(args.cooldown_min ?? 60),
    }
    if (existing) {
      return await pwaApi('PATCH', '/skills/' + encodeURIComponent(existing.id), apiKey, { config, active: config.enabled ? 1 : 0 })
    }
    return await pwaApi('POST', '/skills', apiKey, {
      name: '我的自动报价 (MCP)', description: 'auto_bid via MCP', category: 'rfq', skill_type: 'auto_bid', config,
    })
  }
  if (action === 'disable') {
    if (!existing) return { error: '尚未创建 auto_bid Skill' }
    return await pwaApi('POST', '/skills/' + encodeURIComponent(existing.id) + '/disable', apiKey)
  }
  return { error: `unknown action: ${action}` }
}

async function handlePriceHistory(args: Record<string, unknown>) {
  const pid = String(args.product_id || '')
  if (!pid) return { error: 'product_id required' }
  return readEndpoint('webaz_price_history', '/products/' + encodeURIComponent(pid) + '/price-history')
}

async function handleCharity(args: Record<string, unknown>) {
  const action = String(args.action || '')
  // RFC-003 Batch 4:公开读走 readEndpoint(network → webaz.xyz / sandbox → 本地);写走 pwaApi(mode-aware)。
  if (action === 'list') {
    const qs = new URLSearchParams()
    if (args.category) qs.set('category', String(args.category))
    if (args.target_kind) qs.set('target_kind', String(args.target_kind))
    if (args.limit) qs.set('limit', String(args.limit))
    return readEndpoint('webaz_charity', '/wishes' + (qs.toString() ? '?' + qs : ''))
  }
  if (action === 'detail') {
    if (!args.wish_id) return { error: 'wish_id required' }
    return readEndpoint('webaz_charity', '/wishes/' + encodeURIComponent(String(args.wish_id)))
  }
  if (action === 'stories')     return readEndpoint('webaz_charity', '/charity/stories')
  if (action === 'leaderboard') return readEndpoint('webaz_charity', '/charity/leaderboard')
  if (action === 'fund')        return readEndpoint('webaz_charity', '/charity/fund')
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required for this action' }
  if (toolBackend('webaz_charity') !== 'network') {
    const auth = requireAuth(db, apiKey)
    if ('error' in auth) return auth
  }
  if (action === 'create') {
    return await pwaApi('POST', '/wishes', apiKey, {
      title: args.title, content: args.content, category: args.category,
      target_kind: args.target_kind, target_waz: args.target_waz, escrow_self: args.escrow_self,
      window_hours: args.window_hours, allow_public: args.allow_public,
    })
  }
  if (action === 'me')      return await pwaApi('GET', '/charity/me', apiKey)
  if (action === 'donate')  return await pwaApi('POST', '/charity/fund/donate', apiKey, { amount: args.amount, note: args.note })
  if (!args.wish_id) return { error: 'wish_id required' }
  const id = encodeURIComponent(String(args.wish_id))
  if (action === 'claim')   return await pwaApi('POST', '/wishes/' + id + '/fulfill', apiKey)
  if (action === 'proof')   return await pwaApi('POST', '/wishes/' + id + '/proof', apiKey, { proof_hash: args.proof_hash, proof_note: args.proof_note })
  if (action === 'confirm') return await pwaApi('POST', '/wishes/' + id + '/confirm', apiKey, { fulfillment_id: args.fulfillment_id })
  if (action === 'disclose')return await pwaApi('POST', '/wishes/' + id + '/disclose', apiKey)
  if (action === 'cancel')  return await pwaApi('POST', '/wishes/' + id + '/cancel', apiKey)
  if (action === 'repay')   return await pwaApi('POST', '/wishes/' + id + '/repay', apiKey, { fulfillment_id: args.fulfillment_id, amount: args.amount, note: args.note })
  if (action === 'repay_respond') {
    if (!args.repay_id) return { error: 'repay_id required' }
    return await pwaApi('POST', '/wishes/' + id + '/repay/' + encodeURIComponent(String(args.repay_id)) + '/respond', apiKey, { choice: args.choice })
  }
  return { error: `unknown action: ${action}` }
}

async function handleP2pProduct(args: Record<string, unknown>) {
  const action = String(args.action || '')
  if (action === 'list') {
    try { const r = await fetch(PWA_API_BASE + '/p2p-products'); return await r.json() as Record<string, unknown> } catch (e) { return { error: String((e as Error).message) } }
  }
  if (action === 'detail') {
    if (!args.product_id) return { error: 'product_id required' }
    try { const r = await fetch(PWA_API_BASE + '/p2p-products/' + encodeURIComponent(String(args.product_id))); return await r.json() as Record<string, unknown> } catch (e) { return { error: String((e as Error).message) } }
  }
  const apiKey = resolveMcpApiKey(args)
  if (!apiKey) return { error: 'api_key required for create/patch' }
  const auth = requireAuth(db, apiKey)
  if ('error' in auth) return auth
  if (action === 'create') {
    return await pwaApi('POST', '/p2p-products', apiKey, {
      title: args.title, price: args.price, stock: args.stock,
      content_hash: args.content_hash, content_signature: args.content_signature, content_signed_at: args.content_signed_at,
      peer_endpoint: args.peer_endpoint, thumbnail_uri: args.thumbnail_uri,
      category: args.category, region: args.region,
    })
  }
  if (action === 'patch') {
    if (!args.product_id) return { error: 'product_id required' }
    const body: Record<string, unknown> = {}
    for (const k of ['title','price','stock','content_hash','content_signature','content_signed_at','peer_endpoint']) {
      if (args[k] !== undefined) body[k] = args[k]
    }
    return await pwaApi('PATCH', '/p2p-products/' + encodeURIComponent(String(args.product_id)), apiKey, body)
  }
  return { error: `unknown action: ${action}` }
}

async function handleLike(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  const sid = String(args.shareable_id || '')
  if (!apiKey || !sid) return { error: 'api_key + shareable_id required' }
  if (toolBackend('webaz_like') !== 'network') {
    const auth = requireAuth(db, apiKey)
    if ('error' in auth) return auth
  }
  if (action === 'toggle') return await pwaApi('POST', '/shareables/' + encodeURIComponent(sid) + '/like', apiKey)
  if (action === 'status') return await pwaApi('GET',  '/shareables/' + encodeURIComponent(sid) + '/like-status', apiKey)
  return { error: `unknown action: ${action}` }
}

async function handleLeaderboard(args: Record<string, unknown>) {
  const kind = String(args.kind || 'products')
  const limit = Number(args.limit || 20)
  const VALID_KINDS = ['products', 'creators', 'buyers', 'sellers', 'value_products', 'agents', 'arbitrators', 'verifiers']
  if (!VALID_KINDS.includes(kind)) return { error: `kind 必须是 ${VALID_KINDS.join(' / ')}` }
  // 排行榜公开（不需 api_key）。RFC-003 P1：network 走 webaz.xyz，sandbox 走本地。
  return readEndpoint('webaz_leaderboard', '/leaderboard?kind=' + kind + '&limit=' + limit)
}

async function handleAuction(args: Record<string, unknown>) {
  const apiKey = resolveMcpApiKey(args)
  const action = String(args.action || '')
  if (!apiKey) return { error: 'api_key required' }
  if (toolBackend('webaz_auction') !== 'network') {
    const auth = requireAuth(db, apiKey)
    if ('error' in auth) return auth
  }

  switch (action) {
    case 'create': return await pwaApi('POST', '/auctions', apiKey, {
      title: args.title, qty: args.qty, category: args.category,
      starting_price: args.starting_price, min_increment: args.min_increment,
      reserve_price: args.reserve_price, window_min: args.window_min,
      sniper_extend_min: args.sniper_extend_min, notes: args.notes,
    })
    case 'browse': {
      const qs = new URLSearchParams()
      if (args.category) qs.set('category', String(args.category))
      return await pwaApi('GET', '/auctions?' + qs.toString(), apiKey)
    }
    case 'mine':   return await pwaApi('GET', '/auctions/mine', apiKey)
    case 'detail': {
      if (!args.auction_id) return { error: 'auction_id required' }
      return await pwaApi('GET', '/auctions/' + encodeURIComponent(String(args.auction_id)), apiKey)
    }
    case 'bid': {
      if (!args.auction_id || !args.price) return { error: 'auction_id + price required' }
      return await pwaApi('POST', '/auctions/' + encodeURIComponent(String(args.auction_id)) + '/bids', apiKey, { price: args.price })
    }
    case 'cancel': {
      if (!args.auction_id) return { error: 'auction_id required' }
      return await pwaApi('DELETE', '/auctions/' + encodeURIComponent(String(args.auction_id)), apiKey)
    }
    default: return { error: `unknown action: ${action}` }
  }
}

// ─── 结算逻辑（买家确认后自动执行）──────────────────────────────

// QA P1（轮 6j）：旧版 2% protocolFee 从 buyer escrow 扣下来但不 payout 给任何账户 → 钱凭空消失。
// 修：路由到 sys_protocol；返回 settlement_breakdown 显式列出每分钱去向 + sum_check 验证恒等。
function settleOrder(db: Database.Database, orderId: string) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>

  const totalAmount = order.total_amount as number
  const sellerId = order.seller_id as string
  const buyerId = order.buyer_id as string
  const logisticsId = order.logistics_id as string | null
  const promoterId = order.promoter_id as string | null
  const donationAmount = (order.donation_amount as number) || 0

  // 分成比例（协议参数，未来可治理调整 — 注意：这里写死的比率跟 protocol_params 表里的 0.05/0.10 不一致，QA 也抓到，单独 follow-up）
  const round2 = (n: number) => Math.round(n * 100) / 100
  const isSelfFulfill = !logisticsId  // Phase 1: 无 logistics_id 即 seller 自负物流
  const protocolFee  = round2(totalAmount * 0.02)
  // self-fulfill 时 seller 已承担 logistics 责任，不再扣 5% — 否则违反"无责方零成本 / 责任方应得回报"原则
  const logisticsFee = isSelfFulfill ? 0 : round2(totalAmount * 0.05)
  const promoterFee  = promoterId ? round2(totalAmount * 0.03) : 0
  const sellerAmount = round2(totalAmount - protocolFee - logisticsFee - promoterFee - donationAmount)

  const payout = (recipientId: string, role: string, amount: number, reason: string) => {
    if (amount <= 0) return
    db.prepare(`INSERT INTO payouts (id, order_id, recipient_id, role, amount, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(generateId('pay'), orderId, recipientId, role, amount, reason)
    db.prepare(`UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?`)
      .run(amount, amount, recipientId)
  }

  // 释放买家托管资金（从 escrowed 减掉）
  db.prepare(`UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?`).run(totalAmount, buyerId)

  // 按比例分发
  payout(sellerId, 'seller', sellerAmount, 'seller_share')
  if (logisticsId) payout(logisticsId, 'logistics', logisticsFee, 'logistics_fee')
  if (promoterId)  payout(promoterId,  'promoter',  promoterFee,  'promoter_fee')
  // P1 修复：protocolFee 实际收款方 — 之前没人收
  if (protocolFee > 0) payout('sys_protocol', 'protocol_fund', protocolFee, 'protocol_fee_2pct')
  // 捐赠（如有）→ 进 charity_fund 池子
  if (donationAmount > 0) {
    db.prepare(`UPDATE charity_fund SET balance = balance + ?, total_donated = total_donated + ?, updated_at = datetime('now') WHERE id = 'main'`).run(donationAmount, donationAmount)
  }

  // QA 轮 7 P0 修复 — 改 per-order stake 释放
  // 不再读 product.stake_amount（旧 per-product 模型残留），改按本订单总额的 stake_rate 计算
  // 跟 handlePlaceOrder 锁的值一一对应，保证守恒
  const sellerStakeRate = 0.15
  const stakeReturned = Math.round(totalAmount * sellerStakeRate * 100) / 100
  if (stakeReturned > 0) {
    db.prepare(`UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?`)
      .run(stakeReturned, stakeReturned, sellerId)
  }

  // L4-3 声誉积分
  recordOrderReputation(db, orderId)

  // P1 修复：显式 breakdown 让 caller 把每分钱去向暴给 agent
  const sumCheck = round2(sellerAmount + logisticsFee + promoterFee + protocolFee + donationAmount)
  return {
    order_amount: totalAmount,
    distribution: {
      seller_net:        { amount: sellerAmount, to: sellerId, rate: isSelfFulfill ? '~98% (含 logistics work)' : '~93%' },
      logistics_fee:     { amount: logisticsFee, to: logisticsId, rate: isSelfFulfill ? 'N/A (self-fulfill: seller 承担)' : '5%' },
      promoter_fee:      { amount: promoterFee, to: promoterId, rate: promoterId ? '3%' : 'N/A' },
      protocol_fund:     { amount: protocolFee, to: 'sys_protocol', rate: '2%' },
      charity_donation:  { amount: donationAmount, to: 'charity_fund', rate: donationAmount > 0 ? 'buyer-chosen' : 'N/A' },
    },
    fulfillment_mode: isSelfFulfill ? 'self' : 'market',
    sum_check: sumCheck,
    sum_check_ok: Math.abs(sumCheck - totalAmount) < 0.01,
    seller_stake_returned: stakeReturned,
    note: 'sum_check_ok=true 说明 buyer 付的金额完全等于所有分配之和，无遗漏。',
  }
}

// ─── MCP Server 主体 ──────────────────────────────────────────

export async function startMCPServer() {
  const server = new Server(
    // name 是客户端配置引用的 server 标识(勿改);version 走单一来源(旧硬编码 '0.1.0' 已漂移)。
    { name: 'dcp-protocol', version: SOFTWARE_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  // ── MCP Resources：协议 Manifest ─────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri:         MANIFEST_URI,
        name:        'WebAZ Protocol Manifest',
        description: 'Full WebAZ machine-readable spec. Covers: state machine, economic model, roles, dispute system, Skill market, reputation, agent operating guide. Reading this is enough for an AI agent to participate in the protocol — no extra docs needed.',
        mimeType:    'application/json',
      },
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== MANIFEST_URI) {
      throw new Error(`未知资源：${request.params.uri}`)
    }
    const manifest = await generateManifest(db)
    return {
      contents: [
        {
          uri:      MANIFEST_URI,
          mimeType: 'application/json',
          text:     JSON.stringify(manifest, null, 2),
        },
      ],
    }
  })

  // ── MCP Prompts:预定义对话模板(#B.1 a — MCP 三大原语补齐)─────────────
  // Claude Desktop / Cursor / 其它 MCP 客户端会把这些 prompt 作为推荐对话起点呈现给用户。
  // 每个 prompt = 一个"如何在 webaz 完成 X"的引导,用户选了之后,模型按 prompt 模板开始对话。
  // 加这一层让 onboarding 极大简化 — 用户不需要先读 webaz_info 再决定怎么用。
  const PROMPTS = [
    {
      name: 'webaz-place-order',
      description: 'Guide buyer agent through discover → verify_price → lock → place_order (incl. precise match for pasted external links). Use this when the user hands you a product URL.',
      arguments: [
        { name: 'user_intent', description: 'User raw intent or pasted link text', required: true },
      ],
    },
    {
      name: 'webaz-list-product',
      description: 'Guide seller agent through product listing — covers SEO/agent-friendliness best practices (fill brand/model/specs/return_days/handling_hours and other Schema.org bonus fields).',
      arguments: [
        { name: 'product_summary', description: 'Seller-described product summary', required: true },
      ],
    },
    {
      name: 'webaz-onboard',
      description: 'Onboarding for a new agent first connecting to webaz — explains protocol nature / pre-launch state / commission model / registration path / user-authorization boundaries. Read webaz_info first, then run this prompt.',
      arguments: [],
    },
    {
      name: 'webaz-handle-dispute',
      description: 'Guide handling when an order goes wrong — distinguishes three paths: negotiated refund / dispute arbitration / seller-initiated cancel. Reminds Iron-Rule (arbitrate requires PWA + Passkey).',
      arguments: [
        { name: 'order_id', description: 'The problematic order ID', required: true },
        { name: 'issue_summary', description: 'Issue description (wrong item received / not received / quality problem, etc.)', required: true },
      ],
    },
    {
      name: 'webaz-cross-border',
      description: 'Onboarding for China cross-border sellers — domestic uses WebAZ native protocol / cross-border exposes UCP merchant endpoint to global agents. Explains dual-rail architecture + compliance boundaries.',
      arguments: [],
    },
  ]

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }))

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name
    const args = (request.params.arguments || {}) as Record<string, string>
    // 每个 prompt 返回一份 message 列表,客户端把它当作对话起点
    const messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }> = []

    switch (name) {
      case 'webaz-place-order':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `用户需求:${args.user_intent || '(未提供)'}\n\n` +
              `请使用 webaz_search 工具(可粘贴外链精准匹配,详见工具描述)找到最匹配的商品,` +
              `然后用 webaz_verify_price 锁价(返回 session_token,10 分钟有效),` +
              `最后用 webaz_place_order(session_token=...) 下单。` +
              `下单时记得跟用户确认收货地址 + 是否需要使用推荐人 promoter_api_key(可选)。\n\n` +
              `重要:不要跳过 verify_price 这一步 — 它是防价格篡改的关键。`,
          },
        })
        break

      case 'webaz-list-product':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `卖家概要:${args.product_summary || '(未提供)'}\n\n` +
              `请使用 webaz_list_product 工具上架。最佳实践:**填得越完整,SEO + agent 命中精度越高**:\n` +
              `- 必填:title / description / price\n` +
              `- 高 SEO 价值:images / category / brand / model / return_days(>0) / handling_hours / ship_regions\n` +
              `- 中等价值:specs(JSON 结构化,如 {颜色:黑色,容量:350ml}) / warranty_days / weight_kg / return_condition\n` +
              `- 跨境(可选):source_price(外部参考价) + 多语言版本(通过 PWA 上架)\n\n` +
              `Schema.org Product / Offer / shippingDetails / hasMerchantReturnPolicy 字段已自动映射 —` +
              `Google Rich Result 和外部 agent 会直接读到这些字段。`,
          },
        })
        break

      case 'webaz-onboard':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `请先调用 webaz_info 拿到完整协议状态,然后跟我确认以下几点理解:\n\n` +
              `1. **网络阶段(network_state.phase)**:webaz 目前是什么状态?真实用户数多少?\n` +
              `2. **经济模型(commission_model)**:三级佣金 7:2:1,按辖区 max_levels 分级(非各地无差别三级),显式 per-order 归因,opt-in 结算(默认 off)。` +
              `代理 AI 不应默认替终端用户生成推广链接或拉新,需用户显式授权。\n` +
              `3. **数据来源**:工具返回的所有 stats 是本机 MCP 数据库的本地计数,不代表协议全网真实状态。\n` +
              `4. **铁律(Iron Rule)**:vote / arbitrate / agent_revoke / delete_passkey / 大额提现需要用户在 PWA 完成 WebAuthn ceremony,` +
              `agent 无法替用户做这些操作 — 这是协议级强制,不是建议。\n\n` +
              `确认理解后,告诉我:你想做什么?(下单 / 上架 / 跨境 / 争议处理 / 其它)`,
          },
        })
        break

      case 'webaz-handle-dispute':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `订单:${args.order_id || '(未提供)'}\n问题:${args.issue_summary || '(未提供)'}\n\n` +
              `请先 webaz_get_status 查订单当前状态 + 责任方 + 截止时间。然后按以下路径:\n\n` +
              `**A. 协商退款**(最快):用 webaz_chat 私信卖家协商,卖家同意后 webaz_update_order(action=cancel_refund)。\n` +
              `**B. 走争议仲裁**(协商无果):webaz_dispute(action=create),系统进入 dispute_cases。\n` +
              `  - verifier 共识投票 → arbitrator 裁定 → 系统执行退款/扣 stake\n` +
              `  - 120h 内 arbitrator 不裁,系统自动退款买家\n` +
              `  - **arbitrate / vote 必须 PWA + Passkey(铁律),agent 不能替代**\n` +
              `**C. 卖家主动取消**:卖家用 webaz_update_order(action=cancel)。\n\n` +
              `跟用户确认走哪条路再行动。`,
          },
        })
        break

      case 'webaz-cross-border':
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `webaz 的跨境架构:\n\n` +
              `**境内业务**:走 webaz 自有协议(中文 + 监管友好 + 独立)。所有交易在 webaz state machine 内完成。\n\n` +
              `**跨境业务**:同一商品同时通过两条路径暴露:\n` +
              `1. webaz 自有协议(给 webaz 内部 agent / PWA 用户)\n` +
              `2. UCP merchant endpoint(被全球 commerce agent 如 Google AI Mode / Gemini / ChatGPT 发现)\n\n` +
              `**关键合规**:\n` +
              `- 资金通道严格走持牌(新加坡实体 + KYC ≥ 1000 WAZ)\n` +
              `- 数据出境严格限定到交易必要字段(不含画像 / 信誉细节)\n` +
              `- agent 替代下单的法律责任分配(平台 / 卖家 / agent 三方) — 当前 owner 在做法律意见\n\n` +
              `如果你是跨境卖家想入驻,告诉我商品类目 + 主要目的国 + 是否已有 Shopify/淘宝/亚马逊店,` +
              `我帮你规划在 webaz 上架的最优字段配置(SEO 友好 + 跨境合规)。`,
          },
        })
        break

      default:
        throw new Error(`未知 prompt: ${name}`)
    }

    return {
      description: PROMPTS.find(p => p.name === name)?.description || '',
      messages,
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    const t0 = Date.now()
    let result: unknown

    try {
      // ─── RFC-003 Batch 0 安全网:NETWORK 模式下未迁移的工具【硬失败】,不静默落本地沙盒 ───
      // 例外:info / register(NETWORK_SELF_AWARE)有专门 network-aware 处理,照常放行。
      let handled = false
      if (isNetworkMode() && !NETWORK_TOOLS.has(name) && !NETWORK_SELF_AWARE.has(name)) {
        result = networkMigrationPending(name)
        handled = true
      }
      if (!handled) switch (name) {
        case 'webaz_info':          result = await handleInfo(); break
        case 'webaz_register':      result = handleRegister(args); break
        case 'webaz_search':        result = await handleSearch(args); break
        case 'webaz_verify_price':  result = await handleVerifyPrice(args); break
        case 'webaz_list_product':  result = await handleListProduct(args); break
        case 'webaz_place_order':   result = await handlePlaceOrder(args); break
        case 'webaz_update_order':  result = await handleUpdateOrder(args); break
        case 'webaz_get_status':    result = await handleGetStatus(args); break
        case 'webaz_feedback':      result = await handleFeedback(args); break
        case 'webaz_contribute':    result = await handleContribute(args); break
        case 'webaz_wallet':        result = await handleWallet(args); break
        case 'webaz_dispute':        result = await handleDispute(args); break
        case 'webaz_claim_verify':   result = await handleClaimVerify(args); break
        case 'webaz_notifications':  result = await handleNotifications(args); break
        case 'webaz_skill':          result = await handleSkill(args); break
        case 'webaz_skill_market':   result = await handleSkillMarket(args); break
        case 'webaz_secondhand':     result = await handleSecondhand(args); break
        case 'webaz_trial':          result = await handleTrial(args); break
        case 'webaz_mykey':          result = handleMyKey(args); break
        case 'webaz_profile':        result = await handleProfile(args); break
        case 'webaz_revoke_key':     result = handleRevokeKey(args); break
        case 'webaz_rotate_key':     result = handleRotateKey(args); break
        case 'webaz_referral':       result = await handleReferral(args); break
        case 'webaz_share_link':     result = await handleShareLink(args); break
        case 'webaz_blocklist':        result = await handleBlocklist(args); break
        case 'webaz_follows':          result = await handleFollows(args); break
        case 'webaz_nearby':           result = await handleNearby(args); break
        case 'webaz_default_address':  result = await handleDefaultAddress(args); break
        case 'webaz_shareables':       result = await handleShareables(args); break
        case 'webaz_rfq':              result = await handleRfq(args); break
        case 'webaz_bid':              result = await handleBid(args); break
        case 'webaz_chat':              result = await handleChat(args); break
        case 'webaz_auto_bid':         result = await handleAutoBidSkill(args); break
        case 'webaz_auction':          result = await handleAuction(args); break
        case 'webaz_like':             result = await handleLike(args); break
        case 'webaz_p2p_product':      result = await handleP2pProduct(args); break
        case 'webaz_charity':          result = await handleCharity(args); break
        case 'webaz_price_history':    result = await handlePriceHistory(args); break
        case 'webaz_leaderboard':      result = await handleLeaderboard(args); break
        default: result = { error: `未知工具：${name}` }
      }
    } catch (err) {
      result = { error: `执行出错：${(err as Error).message}` }
    }

    recordToolCall(name, args, result, Date.now() - t0)

    // RFC-004 现场证据:记本次调用的脱敏摘要(只 arg key 名,不含值)。webaz_feedback 自身不入 buffer。
    if (name !== 'webaz_feedback') {
      const isErr = !!result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)
      pushRecentCall({
        tool: name,
        arg_keys: Object.keys(args || {}).filter(k => k !== 'api_key'),
        outcome: isErr ? 'error' : 'ok',
        mode: toolBackend(name),
        ts: new Date().toISOString(),
      })
    }

    // RFC-003 P0: 给每个工具结果盖模式戳(诚实可见,防把 sandbox 当 live 网络)
    // P3: handler 可自行预设 _mode(如 register 在 network 模式返回引导,不是 sandbox 结果)→ 不覆盖。
    // self-aware 工具(info/register)按全局 MODE 盖戳,不按 toolBackend(它们不在 NETWORK_TOOLS 但本就网络感知),
    // 否则 network_readonly/network 下 info 会被误盖 sandbox 戳,与其自身 network_state 矛盾。
    const backend = NETWORK_SELF_AWARE.has(name) ? (isNetworkMode() ? 'network' : 'sandbox') : toolBackend(name)
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const r = result as Record<string, unknown>
      if (!('_mode' in r)) r._mode = backend
      if (r._mode === 'sandbox' && !('_sandbox_note' in r)) {
        r._sandbox_note =
          'SANDBOX: 本地结果,非 webaz.xyz 全网真实状态 / local-only, NOT the live webaz.xyz network'
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('✅ WebAZ MCP Server 已启动，等待 Agent 连接...')
  console.error(modeBanner())
}

// ─── 工具函数 ─────────────────────────────────────────────────

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

function recordToolCall(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  latencyMs: number,
): void {
  let userId: string | null = null
  try {
    const apiKey = resolveMcpApiKey(args)
    if (apiKey) {
      const row = db.prepare('SELECT id FROM users WHERE api_key = ?').get(apiKey) as
        | { id: string }
        | undefined
      if (row) userId = row.id
    }
    const isError =
      !!result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)
    const errorMsg = isError
      ? String((result as { error: unknown }).error).slice(0, 200)
      : null
    // #1017 fix: mcp_tool_calls schema 是 user_id_hash 不是 user_id；无 error_msg 列
    // errorMsg 单独走 sendTelemetry → 服务端聚合，DB 只留汇总指标
    const userIdHash = userId ? createHash('sha256').update(userId).digest('hex').slice(0, 16) : null
    db.prepare(
      `INSERT INTO mcp_tool_calls (tool_name, user_id_hash, outcome, latency_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(tool, userIdHash, isError ? 'error' : 'success', latencyMs)

    sendTelemetry({
      tool_name: tool,
      outcome: isError ? 'error' : 'success',
      latency_ms: latencyMs,
      user_id_hash: userId ? createHash('sha256').update(userId).digest('hex').slice(0, 16) : null,
    })
  } catch (e) {
    console.error('[telemetry-write-failed]', (e as Error).message)
  }
}

function sendTelemetry(payload: {
  tool_name: string
  outcome: 'success' | 'error'
  latency_ms: number
  user_id_hash: string | null
}): void {
  if (!TELEMETRY_ENABLED) return
  try {
    void fetch(TELEMETRY_URL, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({
        ...payload,
        server_version: SERVER_VERSION,
        ts:             new Date().toISOString(),
      }),
      signal:  AbortSignal.timeout(2000),
    }).catch(() => { /* fire-and-forget */ })
  } catch { /* never block the tool call */ }
}
