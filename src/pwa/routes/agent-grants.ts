/**
 * RFC-020 PR-B — Agent delegation grants: minimal PWA issue / read / revoke API.
 *
 * This is the human-owned side of RFC-020: a logged-in human mints a **scoped,
 * short-lived, revocable** delegation grant for an agent — NOT a permanent api_key.
 * The (future) MCP `webaz_pair` consumer + per-request scope enforcement are NOT in
 * this PR.
 *
 * HARD BOUNDARIES (PR-B):
 *   - A grant may carry ONLY safe scopes. Risk scopes are default-hard-rejected;
 *     never-delegable scopes are hard-rejected forever (see agent-grant-scopes.ts).
 *   - Touches NO payment / wallet / order / refund / escrow / commission / fund /
 *     tokenomics code — only the `agent_delegation_grants` table.
 *   - Bearer-first: the raw bearer is returned ONCE; only its SHA-256 hash is stored.
 *     PoP (`agent_pubkey`) is reserved, not implemented — required before any risk
 *     scope or longer-lived delegation.
 *   - `human_confirm_required` is a stored design field only; its enforcement (when
 *     risk scopes are later enabled) reuses the existing webauthn_gate_tokens /
 *     requireHumanPresence gate — no second confirmation mechanism is built here.
 *
 * Registered from registerWebauthnRoutes (Passkey-domain security routes) so the
 * money-dense src/pwa/server.ts stays untouched and within the complexity ratchet.
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'
import { initAgentDelegationGrantsSchema, initAgentPairingSchema, initAgentGrantAuthLogSchema, initAgentPermissionRequestsSchema, initDemandSignalsSchema, initOrderQuotesSchema, initOrderDraftsSchema } from '../../runtime/webaz-schema-helpers.js'
import { validateRequestedCapabilities, clampTtlSeconds, grantIsActive, resolveBundle, durationAllowedForScopes, suggestedDurationForScopes, allowedDurationsForScopes, durationToSeconds, riskLevelForScopes, type GrantDuration } from '../../runtime/agent-grant-scopes.js'
import { generateUserCode, verifyPkceS256, clampPairingTtlSeconds, pairingApprovable, pairingRetrievable } from '../../runtime/agent-pairing.js'
import { verifyGrantToken, type GrantPrincipal } from '../../runtime/agent-grant-verifier.js'
import { minimalSellerOrderView, MINIMAL_ORDER_COLUMNS, minimalBuyerOrderView, BUYER_MINIMAL_ORDER_COLUMNS } from '../agent-order-minimal-view.js'  // RFC-021 §6a / RFC-025 PR-1 最小化订单读投影
import { effectiveSaleRegionsRule, regionAllowedByRule } from '../../sale-regions.js'  // RFC-025 PR-2 discover 目的地纯谓词(S1/S3 同源)
import { computeBuyerQuote } from '../buyer-quote.js'  // RFC-025 PR-3 报价服务(server 权威;route 只做鉴权+转发)
import { createOrderDraft, cancelOrderDraft, getOrderDraft, listOrderDrafts } from '../order-draft.js'  // RFC-025 PR-4 草稿服务(draft_order 首个消费者)
import { createOrderSubmitRequest, submitRowSummary } from '../order-submit-request.js'  // RFC-025 PR-5a 提交域(SUBMIT-only,绝不执行)
import { approveAndExecuteOrderSubmit, type CreateOrderLoopback } from '../order-submit-exec.js'  // RFC-025 PR-5a 批准执行域(钱路;仅人类 approve 路径可达)
import { buildCaseDraft } from '../buyer-case-draft.js'  // RFC-025 PR-6 售后案件草稿(纯只读组装)
import { listApprovalRequests, getApprovalRequest } from '../approval-requests-read.js'  // RFC-026 PR-2 审批状态只读投影
import { toUnits } from '../../money.js'  // RFC-014:demand_signals.budget_units 整数化
import { createOrderActionRequest } from '../order-action-request.js'  // RFC-021 PR2 order-action 请求 domain(sync tx 在 domain 层,不增 route seam)
import { approveAndExecuteOrderAction } from '../order-action-exec.js'  // RFC-021 PR3 approve→执行(CAS approved + 执行 + executed_at CAS,domain 层)
import { notifyTransition } from '../../layer2-business/L2-6-notifications/notification-engine.js'  // 执行后通知买卖双方

export interface AgentGrantsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean  // throttles the anonymous pair/start
  // RFC-025 PR-3: quote 服务读协议参数(direct-pay 管控/保险率等)。可选注入 —— 未注入时 quote 用保守缺省。
  getProtocolParam?: <T>(key: string, fallback: T) => T
  // RFC-025 PR-5a: 批准执行的回环建单调用(进程内打真实 POST /api/orders;单一执行真相源)。未注入 → 提交可用但批准执行返回 SUBMIT_EXEC_UNAVAILABLE(fail-closed)。
  createOrderLoopback?: CreateOrderLoopback
  // 人工在场 gate:批准配对必须真人 Passkey/WebAuthn(与 agent_revoke 同机制)。param 关闭时放行。
  requireHumanPresence: (userId: string, purpose: 'agent_pair_approve' | 'agent_permission_approve', token: string | undefined, paramKey: string, validate?: (data: unknown) => boolean) => { ok: boolean; error_code?: string; reason?: string }
  // RFC-020 PR-4: shared product-create handler (single source with the human POST /api/products); used by the
  //   grant-gated warehouse-draft route so the agent path can never drift from the human validation.
  createProductDraftHandler?: (req: Request, res: Response, user: Record<string, unknown>, opts?: { forceStatus?: 'warehouse'; onCreated?: (productId: string) => Promise<void> | void; skipExternalLinkEffects?: boolean }) => Promise<void>
}

// Bounds on a pairing request (anti-bloat for the anonymous start endpoint).
const MAX_CAPABILITIES = 12
const MAX_CONSTRAINTS_JSON = 2000

// Thrown inside the approve transaction when the grant is no longer active (revoked/expired in the race
// window) — rolls the whole tx back so the request claim + expansion + audit are all-or-nothing.
class GrantInactiveError extends Error {}

function safeParseCaps(json: unknown): unknown {
  try { return JSON.parse(String(json)) } catch { return [] }
}

/** Server-generated consent view for a pairing — canonical scope labels only, no secrets. */
function consentView(p: Record<string, unknown>): Record<string, unknown> {
  return {
    pairing_id: p.pairing_id,
    agent_label: p.agent_label || null,
    reason: p.reason || null,                       // agent-supplied free text (display only)
    capabilities: safeParseCaps(p.capabilities),    // server-validated safe scopes
    status: p.status,
    expires_at: p.expires_at,
    // Duration-choice: agent's suggested lifetime + the durations the human may pick (safe scopes → up to 30d).
    suggested_duration: (p.grant_duration as string) || suggestedDurationForScopes((safeParseCaps(p.capabilities) as Array<{ capability?: string }>).map(c => String(c?.capability || '')).filter(Boolean)),
    allowed_durations: allowedDurationsForScopes((safeParseCaps(p.capabilities) as Array<{ capability?: string }>).map(c => String(c?.capability || '')).filter(Boolean)),
    notice: 'Approving issues a scoped, revocable delegation grant — NOT your api_key, NOT your funds. Safe (read/draft) scopes only; it can never move money, vote, arbitrate, or change keys. You choose how long it lasts.',
  }
}

export function registerAgentGrantsRoutes(app: Application, deps: AgentGrantsDeps): void {
  const { db, auth, generateId, rateLimitOk, requireHumanPresence, createProductDraftHandler } = deps
  const getProtocolParam = deps.getProtocolParam ?? (<T>(_key: string, fallback: T): T => fallback)   // 缺省保守值(direct-pay 管控 fail-closed)
  const createOrderLoopback = deps.createOrderLoopback
  // PWA runtime self-init (MCP gets the tables via applyWebazRuntimeSchema). Idempotent.
  initAgentDelegationGrantsSchema(db)
  initAgentPairingSchema(db)
  initAgentGrantAuthLogSchema(db)
  initAgentPermissionRequestsSchema(db)
  initDemandSignalsSchema(db)
  initOrderQuotesSchema(db)
  initOrderDraftsSchema(db)

  // Resolve the ACTIVE grant behind a gtk_ bearer (no scope check) — used to bind a permission request to
  // (grant_id, human_id). Returns null on missing/expired/revoked. token_hash lookup mirrors the verifier.
  async function resolveActiveGrantByBearer(req: Request): Promise<{ grant_id: string; human_id: string; agent_label: string | null; capabilities: string } | null> {
    const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!bearer.startsWith('gtk_')) return null
    const g = await dbOne<{ grant_id: string; human_id: string; agent_label: string | null; capabilities: string; status: string; expires_at: string; revoked_at: string | null }>(
      'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE token_hash = ?',
      [createHash('sha256').update(bearer).digest('hex')])
    if (!g || !grantIsActive(g, new Date().toISOString())) return null
    return { grant_id: g.grant_id, human_id: g.human_id, agent_label: g.agent_label, capabilities: g.capabilities }
  }

  // ─────────────────────────── RFC-020 PR-C2a: opt-in grant-scope enforcement ───────────────────────────
  // EXPLICIT, per-route, per-SAFE-scope. NOT global auth — a gtk_* token is accepted ONLY by routes that
  // deliberately mount requireAgentGrantScope(scope); auth()/api_key is untouched and never accepts gtk_*.
  // Risk / never-delegable scopes can never pass (the verifier hard-fails non-safe required scopes).
  const requireAgentGrantScope = (scope: string) =>
    async (req: Request, res: Response, next: () => void): Promise<void> => {
      // Anti-abuse: throttle the grant-consumption path BEFORE any DB work (parity with pair/start).
      // Bounds both anonymous probing and valid-grant spam, and caps audit-log growth.
      if (!rateLimitOk(`agent_grant:${req.ip || 'anon'}`, 30, 60_000)) {
        return void res.status(429).json({ error: 'too_many_grant_requests', error_code: 'GRANT_RATE_LIMITED', retry_after_s: 60 })
      }
      const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '')
      const presentedGrant = bearer.startsWith('gtk_') || bearer.startsWith('oat_')   // gtk_ direct grant OR oat_ OAuth token (both grant-authorized)
      const r = await verifyGrantToken(bearer, scope)
      // Append-only audit (RFC-020 §3.7 + invariant: every grant-authorized request is audited). Only audit
      // requests that actually presented a grant bearer — a no-token request is pure noise (and an unauth
      // bloat vector), not a grant-authorized request.
      let audited = false
      if (presentedGrant) {
        try {
          await dbRun(
            'INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)',
            [r.ok ? r.principal.grant_id : (r.grant_id ?? null), r.ok ? r.principal.human_id : (r.human_id ?? null), scope, r.ok ? 'allow' : 'deny', r.ok ? null : r.error_code],
          )
          audited = true
        } catch (e) {
          console.error('[agent-grant] audit write failed:', (e as Error).message)
        }
      }
      // Deny path: return the denial regardless of audit (no access is granted, so nothing to fail closed on).
      if (!r.ok) {
        // Structured permission_required (RFC-020): the agent IS validly connected but its grant simply lacks
        //   this SAFE scope. Instead of a bare 403, hand it the exact next step — ask the human to expand the
        //   grant (approval_url + the create-request call), then retry this same request. Other grant failures
        //   (no/expired/revoked/suspended grant) stay plain: those aren't "request more", they must re-pair.
        if (r.error_code === 'SCOPE_NOT_GRANTED') {
          return void res.status(403).json({
            error: `this action needs the "${scope}" permission, which your grant does not carry`,
            error_code: 'PERMISSION_REQUIRED',
            required_scope: scope,
            missing_scopes: [scope],
            approval_url: '/#agent-approvals',
            retry_after_approval: true,
            request_permission: { method: 'POST', endpoint: '/api/agent-grants/permission-requests', body: { scopes: [scope] } },
            note: 'Ask the human to approve at approval_url; on approval your existing grant is expanded — then retry this request.',
          })
        }
        return void res.status(r.status).json({ error: r.error, error_code: r.error_code })
      }
      // Success path: FAIL CLOSED if the authorization could not be audited — a grant-authorized request
      // must never proceed unaudited (RFC-020 invariant). Better to deny (503, retryable) than act unaccountably.
      if (!audited) return void res.status(503).json({ error: 'authorization audit unavailable; refusing to proceed unaudited', error_code: 'GRANT_AUDIT_FAILED' })
      ;(req as Request & { agentGrant?: GrantPrincipal }).agentGrant = r.principal
      next()
    }

  // Vertical slice (zero-risk): grant principal introspection. Proves the verifier + opt-in middleware
  // end-to-end on a brand-new read-only endpoint that touches NO existing route and NO money path.
  app.get('/api/agent-grants/whoami', requireAgentGrantScope('read_public'), (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant
    res.json({ grant: p, note: 'Authorized via delegation grant (safe scope read_public). This is a grant principal, not a human session.' })
  })

  // RFC-023 — the OAuth-bound identity for THIS connection (safe scope read_public). Lets a remote agent
  //   answer "which WebAZ account am I connected as, and with what scopes?" without any api_key. Returns the
  //   handle + a MASKED account id + the grant's safe scopes + expiry — and NEVER an api_key, token, email,
  //   address, or any other PII (E-node requirement). Backs webaz_connection_status.
  app.get('/api/agent-grants/connection', requireAgentGrantScope('read_public'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant
    if (!p) return void res.status(401).json({ error: 'no grant', error_code: 'GRANT_REQUIRED' })
    const g = await dbOne<{ capabilities: string; expires_at: string }>(
      'SELECT capabilities, expires_at FROM agent_delegation_grants WHERE grant_id = ?', [p.grant_id])
    const u = await dbOne<{ handle: string | null }>('SELECT handle FROM users WHERE id = ?', [p.human_id])
    const scopes = (safeParseCaps(g?.capabilities) as Array<{ capability?: string }>).map(c => String(c?.capability || '')).filter(Boolean)
    const id = p.human_id
    // Always redact — NEVER return the full id. Long id → prefix…suffix (middle hidden); short id (≤8,
    // where prefix+suffix would overlap and reveal everything) → 2-char prefix + ellipsis only.
    const account_id_hint = !id ? '' : id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `${id.slice(0, 2)}…`
    res.json({ connected: true, handle: u?.handle ? `@${u.handle}` : null, account_id_hint, agent_label: p.agent_label, scopes, expires_at: g?.expires_at ?? null })
  })

  // First REAL grant-consumed seller surface (Catalog Agent): read the grant human's OWN catalog. Read-only,
  //   money fields (commission/stake) excluded. A grant that lacks seller_products_read → structured
  //   permission_required (see requireAgentGrantScope) so the agent can request → human approves → retry.
  //   The consumption (allow AND the permission_required deny) is audited by the middleware.
  app.get('/api/agent/seller/products', requireAgentGrantScope('seller_products_read'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const rows = await dbAll<Record<string, unknown>>(
      "SELECT id, title, status, price, currency, stock, category, created_at, updated_at FROM products WHERE seller_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 200",
      [p.human_id])
    res.json({ seller_id: p.human_id, agent_label: p.agent_label, count: rows.length, products: rows, note: 'Seller-owned catalog read via delegation grant (safe scope seller_products_read). Read-only; no money/commission fields.' })
  })

  // RFC-021 §6a — 最小化订单读(safe scope seller_orders_read_minimal)。仅读该 agent 之人(卖家)的订单;
  //   ALLOWLIST 投影(minimalSellerOrderView)只产出 7 字段(含 PR-B 粗粒度 dest_country=结构化 ship_to_region),
  //   SELECT 只取非 PII 列(MINIMAL_ORDER_COLUMNS)—— 买家街道/门牌/邮编/联系/gift_recipient 连取都不取(I6)。
  //   纯只读,无任何执行(order_action_request 在 PR2/PR3 才有提交/执行)。
  app.get('/api/agent/orders', requireAgentGrantScope('seller_orders_read_minimal'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const rows = await dbAll<Record<string, unknown>>(
      `SELECT ${MINIMAL_ORDER_COLUMNS.join(', ')} FROM orders WHERE seller_id = ? ORDER BY created_at DESC LIMIT 200`,
      [p.human_id])
    res.json({ seller_id: p.human_id, agent_label: p.agent_label, count: rows.length, orders: rows.map(o => minimalSellerOrderView(o, db)), note: 'RFC-021 minimal order read (safe scope seller_orders_read_minimal). No buyer address/contact; no execution.' })
  })
  app.get('/api/agent/orders/:id', requireAgentGrantScope('seller_orders_read_minimal'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const o = await dbOne<Record<string, unknown>>(
      `SELECT ${MINIMAL_ORDER_COLUMNS.join(', ')} FROM orders WHERE id = ? AND seller_id = ?`,
      [req.params.id, p.human_id])
    if (!o) return void res.status(404).json({ error: '订单不存在或不属于你', error_code: 'ORDER_NOT_FOUND' })
    res.json({ order: minimalSellerOrderView(o, db) })
  })

  // RFC-025 PR-1 — 买家侧最小化订单读(safe scope buyer_orders_read_minimal)。镜像卖家侧的 allowlist 纪律:
  //   仅读该 agent 之人(买家)的订单;投影只产出 7 字段(order_id/status/next_actor/deadline/amount/item_ref/
  //   payment_rail),SELECT 只取非 PII 列(BUYER_MINIMAL_ORDER_COLUMNS)—— 地址/收件人/notes/gift_recipient/
  //   recipient_code 连取都不取(I6 同强度)。纯只读,零执行、零资金 —— 买家写动作(place_order 等)仍 RISK 硬拒。
  app.get('/api/agent/buyer/orders', requireAgentGrantScope('buyer_orders_read_minimal'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const rows = await dbAll<Record<string, unknown>>(
      `SELECT ${BUYER_MINIMAL_ORDER_COLUMNS.join(', ')} FROM orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 200`,
      [p.human_id])
    res.json({ buyer_id: p.human_id, agent_label: p.agent_label, count: rows.length, orders: rows.map(o => minimalBuyerOrderView(o, db)), note: 'RFC-025 minimal buyer order read (safe scope buyer_orders_read_minimal). No address/contact/PII; read-only, no execution.' })
  })
  app.get('/api/agent/buyer/orders/:id', requireAgentGrantScope('buyer_orders_read_minimal'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const o = await dbOne<Record<string, unknown>>(
      `SELECT ${BUYER_MINIMAL_ORDER_COLUMNS.join(', ')} FROM orders WHERE id = ? AND buyer_id = ?`,
      [req.params.id, p.human_id])
    if (!o) return void res.status(404).json({ error: '订单不存在或不属于你', error_code: 'ORDER_NOT_FOUND' })
    res.json({ order: minimalBuyerOrderView(o, db) })
  })

  // RFC-025 PR-2 — 买家发现(safe scope buyer_discover)。语义:「有结果输出结果,没结果记录,形成商机」。
  //   诚实纪律(certainty-over-coverage):候选一律标 discovery_candidate,绝不冒充精确命中;0 命中如实
  //   no_candidates + 引导(RFQ / PWA #discover)。【每次】查询把 allowlist 化的结构化 intent 落一行
  //   demand_signals(result_count 含 0;0 = 未被满足的需求 = 市场机会情报)—— 该采集在工具 description
  //   向用户披露,能力名 buyer_discover 显式命名该效果(不是 search)。无执行、无资金;intent 只收
  //   allowlist 字段(category/keywords≤5/max_price/ship_to_region/quantity);文本入口做形状校验(超长/邮箱/URL/电话数字连拒收;词形文本无法机械排除 —— 披露如实告知通过即原样记录)。
  app.post('/api/agent/discover', requireAgentGrantScope('buyer_discover'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const b = (req.body ?? {}) as Record<string, unknown>
    // ── allowlist 化 intent(parse-don't-validate:非法字段直接拒,不猜) ──
    // token-shape 校验(Codex PR-2 High,round-2 收紧):category/keywords 是唯一的文本入口。
    //   校验在【原始串】上做(先验后裁,parse-don't-validate:超长=400,绝不静默截断改意图);
    //   只放行商品词形态:文字/数字 + 空格 + -+._&%,显式拒绝邮箱(@)/URL(://|www.)/电话形态
    //   (剥掉全部放行分隔符后 ≥7 连续数字)。诚实边界:词形文本(人名/词写的联系方式)无法机械
    //   排除 —— 所以披露不承诺"绝无自由文本",承诺的是【已执行的形状校验 + 通过即原样记录,勿放个人数据】。
    const TOKEN_RE = /^[\p{L}\p{N} \-+._&%]{1,40}$/u   // % 合法("100% cotton"),LIKE 侧已转义为字面量
    const smells = (s: string): string | null => {
      if (s.length > 40) return 'too long (max 40 chars)'
      if (s.includes('@')) return 'email-like'
      if (/:\/\/|www\./i.test(s)) return 'url-like'
      if (/\d{7,}/.test(s.replace(/[ \-.+_&%]/g, ''))) return 'phone-like digit run'
      if (!TOKEN_RE.test(s)) return 'non-token characters'
      return null
    }
    const rejectText = (field: string, why: string) => void res.status(400).json({
      error: `${field} must be a short product term (letters/digits, ≤40 chars, no emails/phone-like digit runs/URLs) — rejected: ${why}`,
      error_code: 'INVALID_INTENT_TEXT',
      next_steps: 'Send short structured shopping terms only. Inputs that pass validation are recorded as-is — do not put personal data here.',
    })
    const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null
    if (category) { const w = smells(category); if (w) return rejectText('category', w) }
    const rawKw = Array.isArray(b.keywords) ? b.keywords : (typeof b.keywords === 'string' && b.keywords.trim() ? [b.keywords] : [])
    if (rawKw.length > 5) return rejectText('keywords', 'more than 5 keywords')
    const keywords = rawKw.filter((k): k is string => typeof k === 'string' && !!k.trim()).map(k => k.trim())
    for (const k of keywords) { const w = smells(k); if (w) return rejectText('keywords', w) }
    const maxPrice = b.max_price === undefined || b.max_price === null ? null : Number(b.max_price)
    if (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 1e9)) {
      return void res.status(400).json({ error: 'max_price must be a positive number', error_code: 'INVALID_MAX_PRICE' })
    }
    const region = typeof b.ship_to_region === 'string' && /^[A-Za-z]{2}$/.test(b.ship_to_region.trim()) ? b.ship_to_region.trim().toUpperCase() : null
    const quantity = b.quantity === undefined ? 1 : Number(b.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      return void res.status(400).json({ error: 'quantity must be an integer 1..999', error_code: 'INVALID_QUANTITY' })
    }
    if (!category && keywords.length === 0) {
      return void res.status(400).json({ error: 'give at least a category or one keyword', error_code: 'EMPTY_INTENT', next_steps: 'Provide { category } and/or { keywords: [...] } - short product terms only (shape-validated; passing inputs are recorded as-is).' })
    }
    // ── 诚实检索:active + 库存够 + 类目/关键词(LIKE, ESCAPE)/预算过滤;绝不模糊兜底冒充命中 ──
    const where: string[] = ["status = 'active'", 'stock >= ?']
    const params: unknown[] = [quantity]
    if (category) { where.push('LOWER(category) = LOWER(?)'); params.push(category) }
    for (const k of keywords) { where.push("LOWER(title) LIKE '%' || ? || '%' ESCAPE '\\'"); params.push(k.toLowerCase().replace(/[\\%_]/g, m => '\\' + m)) }
    if (maxPrice !== null) { where.push('price <= ?'); params.push(maxPrice) }
    const rows = await dbAll<Record<string, unknown>>(
      `SELECT id, title, price, currency, category, stock, seller_id, sale_regions FROM products WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 30`, params)
    // 目的地过滤:复用 S1/S3 的纯谓词(store 级规则回退),不可售目的地的商品如实剔除
    const matched = (region
      ? rows.filter(r => { const rule = effectiveSaleRegionsRule(db, r as { sale_regions?: string | null }, String(r.seller_id)); return !rule || regionAllowedByRule(rule, region) })
      : rows).slice(0, 10)
    const candidates = matched.map(r => ({
      label: 'discovery_candidate' as const,   // 诚实标注:相似候选,非精确命中
      product_id: String(r.id), title: String(r.title), price: Number(r.price),
      currency: String(r.currency || 'WAZ'), category: r.category == null ? null : String(r.category),
    }))
    // ── 需求信号落库(append-only;失败不吞——采集是本端点被授权的显式效果,写不进则如实 503) ──
    const intent = { category, keywords, max_price: maxPrice, ship_to_region: region, quantity }
    try {
      await dbRun('INSERT INTO demand_signals (id, human_id, source, intent_json, category, region, budget_units, result_count) VALUES (?,?,?,?,?,?,?,?)',
        [generateId('dms'), p.human_id, 'mcp_discover', JSON.stringify(intent), category, region, maxPrice === null ? null : toUnits(maxPrice), candidates.length])
    } catch (e) {
      console.error('[discover] demand-signal write failed:', (e as Error).message)
      return void res.status(503).json({ error: 'demand-signal ledger unavailable; discover is disclosed-as-recorded and will not run unrecorded', error_code: 'DEMAND_SIGNAL_WRITE_FAILED' })
    }
    res.json({
      count: candidates.length, candidates,
      ...(candidates.length === 0 ? { no_candidates: true, note: 'No matching listings right now — honestly zero, nothing similar is being passed off as a match. Your structured request was recorded as a demand signal (disclosed) so supply can catch up. Consider posting an RFQ at webaz.xyz, or browse PWA #discover.' } : {}),
      disclosure: 'This query was recorded as-is as a demand signal linked to your account, to inform marketplace supply. Validation enforced: max-40-char product terms; emails, URLs, phone-like digit runs, and non-product punctuation are rejected (400) and never recorded. Inputs that pass are recorded verbatim - do not put personal data in category/keywords.',
    })
  })

  // RFC-025 PR-3 — 买家报价(safe scope price_quote)。server 权威整数分项 + 有时效 quote_token。
  //   零经济执行(不建单/不扣款/不锁资金/不动库存);零 PII(默认地址只在服务内部用于配送计算);
  //   G-QTY-1:validateQuantity 单一规范化数量贯穿全部判断;幂等:同主体同键同载荷 → 同一报价。
  //   subject 恒 = grant human(agent 无法传 human_id/代表他人)。
  app.post('/api/agent/quote', requireAgentGrantScope('price_quote'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = computeBuyerQuote(db, { generateId, getProtocolParam }, p.human_id, (req.body ?? {}) as Record<string, unknown>)
    if (!r.ok) return void res.status(r.status).json(r.body)
    res.json(r.response)
  })

  // RFC-025 PR-4 — 订单草稿(safe scope draft_order —— RFC-020 以来首个消费者)。零经济执行:
  //   create = 消费一个本人未过期未消费的 quote_token(consumed_at CAS 与 INSERT 同事务,一次性)→ 冻结快照;
  //   草稿不可变(无 update),cancel 终态幂等安全;get/list 仅本人。提交/批准/建单全在 PR-5a。
  app.post('/api/agent/order-draft', requireAgentGrantScope('draft_order'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = createOrderDraft(db, { generateId }, p.human_id, (req.body ?? {}) as Record<string, unknown>)
    if (!r.ok) return void res.status(r.status).json(r.body)
    res.json(r.response)
  })
  app.post('/api/agent/order-drafts/:id/cancel', requireAgentGrantScope('draft_order'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = cancelOrderDraft(db, p.human_id, req.params.id)
    if (!r.ok) return void res.status(r.status).json(r.body)
    res.json(r.response)
  })
  app.get('/api/agent/order-drafts', requireAgentGrantScope('draft_order'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    res.json(listOrderDrafts(db, p.human_id).response)
  })
  app.get('/api/agent/order-drafts/:id', requireAgentGrantScope('draft_order'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = getOrderDraft(db, p.human_id, req.params.id)
    if (!r.ok) return void res.status(r.status).json(r.body)
    res.json(r.response)
  })

  // RFC-025 PR-5a — 提交订单草稿到人工审批队列(safe scope order_submit_request)。SUBMIT-only:
  //   写 pending(kind='order_submit',params_hash 绑全经济快照),【绝不执行】。执行(建单+入escrow)
  //   只发生在人 Passkey 批准后(下方 /approve 的 order_submit 分支 → order-submit-exec,agent 不可达)。
  // RFC-025 PR-6 — 售后案件草稿组装(safe scope buyer_case_prepare)。纯只读:时间线结构字段 +
  //   商品声明锚点 + 证据 ref(零自由文本/PII);零写入零经济;提交类售后动作全部指向人路径。
  // RFC-026 PR-2 — 审批状态只读(safe scope approval_requests_read;只看本人;零 PII)
  app.get('/api/agent/approval-requests', requireAgentGrantScope('approval_requests_read'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    res.json(listApprovalRequests(db, p.human_id))
  })
  app.get('/api/agent/approval-requests/:id', requireAgentGrantScope('approval_requests_read'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = getApprovalRequest(db, p.human_id, req.params.id)
    if (!r.ok) return void res.status(r.status).json(r.body)
    res.json(r.response)
  })

  app.get('/api/agent/buyer/orders/:id/case-draft', requireAgentGrantScope('buyer_case_prepare'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = buildCaseDraft(db, p.human_id, req.params.id)
    if (!r.ok) return void res.status(r.status).json(r.body)
    res.json(r.response)
  })

  app.post('/api/agent/order-drafts/:id/submit', requireAgentGrantScope('order_submit_request'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const r = createOrderSubmitRequest(db, { draftId: String(req.params.id), grantId: p.grant_id, humanId: p.human_id, agentLabel: p.agent_label ?? 'agent', generateId })
    if (!r.ok) return void res.status(r.http).json({ error: r.error, error_code: r.error_code })
    res.json({ success: true, request_id: r.request_id, draft_id: req.params.id, params_hash: r.params_hash, approval_url: `/#agent-approvals/${r.request_id}`, idempotency: { params_hash: r.params_hash, duplicate: !!r.duplicate, reused_existing_request: !!r.duplicate }, note: r.duplicate ? 'An equivalent submit request is already awaiting Passkey approval — REUSED it (no second request was created). Do NOT re-quote or re-draft to retry; ask the human to open the approval page.' : 'Pending human Passkey approval. NOT executed — approval creates the order (and for escrow debits wallet→escrow) server-side; nothing happens without the Passkey.' })
  })

  // RFC-021 PR2 — order-action 请求提交(safe scope order_action_request)。SUBMIT-only:写 pending,【绝不执行】。
  //   D2 拒 decline;归属校验 seller 本人;ship 须带 tracking+evidence_ref(I4 提交侧);地址永不入参/入 audit(I6);
  //   同 (order_id,action) 双 pending 被唯一索引拒。执行(accept/ship)在 PR3 经人 Passkey 批准后由服务端跑。
  app.post('/api/agent/orders/:orderId/action-request', requireAgentGrantScope('order_action_request'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const b = (req.body ?? {}) as { action?: string; action_params?: unknown }
    const orderId = String(req.params.orderId)
    const r = createOrderActionRequest(db, { orderId, action: String(b.action ?? ''), rawParams: b.action_params, grantId: p.grant_id, humanId: p.human_id, agentLabel: p.agent_label, generateId })
    if (!r.ok) return void res.status(r.http || 400).json({ error: r.error, error_code: r.error_code })
    res.json({ success: true, request_id: r.request_id, order_id: orderId, action: b.action, params_hash: r.params_hash, approval_url: `/#agent-approvals/${r.request_id}`, note: 'Pending human Passkey approval. NOT executed — execution (accept/ship) lands in RFC-021 PR3.' })
  })

  // POST create a DRAFT product via a delegation grant (Catalog Agent, safe scope seller_product_draft). The
  //   draft is FORCED to status='warehouse' (not public/sellable). PUBLISHING STAYS HUMAN-ONLY — the human
  //   flips warehouse→active in the existing 我的商品→仓库 UI (publish is never delegated to a grant, matching
  //   the taxonomy). Reuses the SAME product-create validation as the human POST /api/products
  //   (createProductDraftHandler) so the agent path can't drift. Audited by the middleware. Lightweight signal:
  //   a notification tells the human a draft is waiting to review + publish.
  if (createProductDraftHandler) {
    app.post('/api/agent/seller/products', requireAgentGrantScope('seller_product_draft'), async (req, res) => {
      const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
      const human = await dbOne<{ id: string; role: string }>('SELECT id, role FROM users WHERE id = ?', [p.human_id])
      if (!human || human.role !== 'seller') return void res.status(403).json({ error: 'the grant owner is not a seller — product drafts need a seller account', error_code: 'NOT_A_SELLER' })
      // Accurate error codes for the GRANT path WITHOUT touching the shared handler / human path: the create
      //   handler emits legacy validation errors as `200 + {error}` (no success). For a grant caller that's
      //   misleading, so translate exactly those to `400 VALIDATION_ERROR`. Explicit res.status(400/429/500…)
      //   and the success ({product_id}) response pass through unchanged.
      const origJson = res.json.bind(res)
      ;(res as unknown as { json: (b: unknown) => unknown }).json = (body: unknown) => {
        const b = body as Record<string, unknown> | null
        if (res.statusCode === 200 && b && typeof b === 'object' && b.error && !b.success) {
          res.status(400)
          return origJson({ error: b.error, error_code: 'VALIDATION_ERROR' })
        }
        return origJson(body as never)
      }
      await createProductDraftHandler(req, res, human as Record<string, unknown>, {
        forceStatus: 'warehouse',
        skipExternalLinkEffects: true,   // a SAFE draft grant must never trigger wallet debit / verify_tasks / auto-verified links (source_url stays inert metadata)
        onCreated: async (productId) => {
          try {
            await dbRun("INSERT INTO notifications (id, user_id, type, title, body) VALUES (?,?,?,?,?)",
              [generateId('ntf'), p.human_id, 'agent_product_draft', 'AI 助手起草了商品草稿', `${p.agent_label || 'An agent'} 起草了商品草稿 ${productId}，请到「我的商品 → 仓库」审核并发布。`])
          } catch (e) { console.error('[agent-grant draft notify]', (e as Error).message) }
        },
      })
    })
  }

  // helpers for the permission-request flow ----------------------------------------------------------------
  const parseCapList = (json: string): Array<{ capability: string; constraints?: Record<string, unknown> }> => { try { const a = JSON.parse(json); return Array.isArray(a) ? a : [] } catch { return [] } }
  const scopeNames = (json: string): string[] => parseCapList(json).map(c => (typeof c === 'string' ? c : c?.capability)).filter((s): s is string => typeof s === 'string')
  // Returns true iff the audit row was durably written. Callers on the grant-authorized SUCCESS path MUST
  // fail closed when this is false (RFC-020 invariant: a grant-authorized action is audited or it does not
  // happen) — parity with the requireAgentGrantScope middleware above.
  const auditGrant = async (grantId: string | null, humanId: string | null, cap: string, outcome: 'allow' | 'deny', errorCode?: string): Promise<boolean> => {
    try { await dbRun('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)', [grantId, humanId, cap, outcome, errorCode ?? null]); return true } catch (e) { console.error('[agent-grant] audit write failed:', (e as Error).message); return false }
  }
  const bundleSummary = (key: string | null): string | null => { const b = key ? resolveBundle(key) : null; return b ? b.human_summary : null }

  // GET verify — grant-authed. Returns the FULL grant (scopes, bundle, expiry, status), not just read_public.
  //   Audited (acceptance #8: every grant use logs). Never returns the raw token/api_key.
  app.get('/api/agent-grants/verify', async (req, res) => {
    const g = await resolveActiveGrantByBearer(req)
    if (!g) { return void res.status(401).json({ error: 'active delegation grant required', error_code: 'GRANT_REQUIRED' }) }
    const full = await dbOne<{ grant_id: string; human_id: string; agent_label: string | null; capabilities: string; status: string; expires_at: string; permission_bundle: string | null }>(
      'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, permission_bundle FROM agent_delegation_grants WHERE grant_id = ?', [g.grant_id])
    // Fail closed: a grant-authorized read is audited or it does not proceed (parity with requireAgentGrantScope).
    if (!(await auditGrant(g.grant_id, g.human_id, 'grant:verify', 'allow'))) return void res.status(503).json({ error: 'authorization audit unavailable; refusing to proceed unaudited', error_code: 'GRANT_AUDIT_FAILED' })
    res.json({ grant: { grant_id: full!.grant_id, human_id: full!.human_id, agent_label: full!.agent_label, scopes: scopeNames(full!.capabilities), permission_bundle: full!.permission_bundle, expires_at: full!.expires_at, status: full!.status }, note: 'Full grant principal — all authorized scopes/bundle/expiry/status. Not a human session; never authorizes risk/never-delegable actions.' })
  })

  // POST create a permission request — the AGENT (holding its current grant) asks for MORE scope / a bundle.
  //   Bound to (human_id, grant_id) from the grant bearer. Rate-limited. Safe-only: risk/never-delegable are
  //   NOT grantable (they need a per-action live Passkey, not a persistent grant) → structured reject.
  app.post('/api/agent-grants/permission-requests', async (req, res) => {
    if (!rateLimitOk(`agent_perm_req:${req.ip || 'anon'}`, 20, 60_000)) return void res.status(429).json({ error: 'too_many_permission_requests', retry_after_s: 60 })
    const g = await resolveActiveGrantByBearer(req)
    if (!g) return void res.status(401).json({ error: 'an active delegation grant is required to request more permissions (pair first with webaz_pair)', error_code: 'GRANT_REQUIRED' })
    const body = (req.body || {}) as Record<string, unknown>
    const bundleKey = typeof body.bundle === 'string' ? body.bundle : null
    const bundle = bundleKey ? resolveBundle(bundleKey) : null
    if (bundleKey && !bundle) return void res.status(400).json({ error: 'unknown permission bundle', error_code: 'UNKNOWN_BUNDLE' })
    const scopes = bundle ? [...bundle.scopes] : (Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [])
    if (scopes.length === 0) return void res.status(400).json({ error: 'bundle or scopes required', error_code: 'NO_SCOPES' })
    const v = validateRequestedCapabilities(scopes.map(s => ({ capability: s })))
    if (!v.ok) return void res.status(403).json({ error: 'permission_not_grantable', error_code: 'PERMISSION_NOT_GRANTABLE', rejected: v.rejected, note: 'Only safe (read/draft) scopes can be granted. Risk actions (order/publish/refund/…) require the human to act with a live Passkey — they are never delegated to a persistent grant.' })
    const risk = riskLevelForScopes(scopes)
    const duration: GrantDuration = durationAllowedForScopes(scopes, body.duration) ? body.duration as GrantDuration : suggestedDurationForScopes(scopes)
    const id = generateId('apr')
    const reqTtlIso = new Date(Date.now() + 7 * 86400_000).toISOString()   // request auto-expires in 7d if unanswered
    await dbRun(
      'INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, permission_bundle, reason, task_context, risk_level, duration, status, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, g.human_id, g.grant_id, g.agent_label, JSON.stringify(scopes), bundleKey, typeof body.reason === 'string' ? body.reason.slice(0, 280) : null, typeof body.task_context === 'string' ? body.task_context.slice(0, 500) : null, risk, duration, 'pending', reqTtlIso],
    )
    res.status(201).json({ approval_id: id, approval_url: '/#agent-approvals', status: 'pending', risk_level: risk, requested_scopes: scopes, permission_bundle: bundleKey, human_summary: bundleSummary(bundleKey), suggested_duration: duration, note: 'Ask the human to open approve_url (logged in) and approve. On approval your existing grant is expanded; then retry.' })
  })

  // GET list this human's PENDING permission requests (for #agent-approvals). Human-authed.
  app.get('/api/agent-grants/permission-requests', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(
      "SELECT id, agent_label, requested_scopes, permission_bundle, reason, task_context, risk_level, duration, created_at, expires_at, kind, order_id, order_action, params_hash, action_params, status FROM agent_permission_requests WHERE human_id = ? AND ((status = 'pending' AND expires_at > ?) OR (kind = 'order_submit' AND status = 'approved' AND executed_at IS NULL)) ORDER BY created_at DESC LIMIT 100",
      [user.id, new Date().toISOString()])  // RFC-026 R1:approved+未执行的 order_submit(执行结果不明冻结)也列出 —— 人再次 Passkey 批准即触发服务端和解(oracle 核对补回链或安全重试),这是冻结态唯一的解锁路径
    // order_action:额外返回 kind/order_id/order_action/params_hash/action_params(action_params 经 PR2 sanitize,
    //   只含 tracking/evidence_ref,【无地址/PII】)。前端据此绑 Passkey purpose_data {request_id, order_id, action, params_hash}。
    res.json({ requests: rows.map(r => {
      const base: Record<string, unknown> = { ...r, requested_scopes: scopeNames(String(r.requested_scopes)), human_summary: bundleSummary(r.permission_bundle as string | null) }
      if (r.kind === 'order_action') { try { base.action_params = r.action_params ? JSON.parse(String(r.action_params)) : {} } catch { base.action_params = {} } }
      // RFC-025 PR-5a:order_submit 行附经济摘要(域层 submitRowSummary,route 零新增 seam 计数;零 PII)。
      if (r.kind === 'order_submit') { const sum = submitRowSummary(db, String(r.order_id)); if (sum) base.submit_summary = sum; if (r.status === 'approved') base.needs_reconcile = true }
      delete base.status
      return base
    }) })
  })

  // GET list the requests THIS grant created — GRANT-authed (the agent, via webaz_pair), so an agent can poll
  //   its own request status (pending/approved/rejected/expired) without hitting the target surface. Bound to
  //   grant_id: an agent sees ONLY its own requests, never the human's other agents'. Audited (fail-closed).
  app.get('/api/agent-grants/my-permission-requests', async (req, res) => {
    if (!rateLimitOk(`agent_perm_list:${req.ip || 'anon'}`, 30, 60_000)) return void res.status(429).json({ error: 'too_many_requests', error_code: 'GRANT_RATE_LIMITED', retry_after_s: 60 })
    const g = await resolveActiveGrantByBearer(req)
    if (!g) return void res.status(401).json({ error: 'an active delegation grant is required (pair first with webaz_pair)', error_code: 'GRANT_REQUIRED' })
    const rows = await dbAll<Record<string, unknown>>(
      'SELECT id, requested_scopes, permission_bundle, risk_level, duration, status, created_at, expires_at, approved_at FROM agent_permission_requests WHERE grant_id = ? ORDER BY created_at DESC LIMIT 50', [g.grant_id])
    if (!(await auditGrant(g.grant_id, g.human_id, 'grant:list_requests', 'allow'))) return void res.status(503).json({ error: 'authorization audit unavailable; refusing to proceed unaudited', error_code: 'GRANT_AUDIT_FAILED' })
    res.json({ requests: rows.map(r => ({ ...r, requested_scopes: scopeNames(String(r.requested_scopes)), human_summary: bundleSummary(r.permission_bundle as string | null) })) })
  })

  // RFC-020: expanding an agent grant is a privilege escalation (like initial pairing) — a stolen web session
  //   must NOT widen an agent from read_public to a long-term bundle. So a LIVE Passkey bound to this request_id
  //   is required. Grant-active is checked BEFORE claiming the request, and the expand is guarded + reversible,
  //   so a mid-flight expire/revoke can never strand a phantom 'approved'.
  // POST approve — human-authed + live Passkey; expands the bound grant (union scopes + bundle + extend expiry). Audited.
  app.post('/api/agent-grants/permission-requests/:id/approve', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const now = new Date().toISOString()
    const r = await dbOne<{ human_id: string; grant_id: string; requested_scopes: string; permission_bundle: string | null; duration: string; status: string; expires_at: string; kind: string | null; order_id: string | null; order_action: string | null; params_hash: string | null }>(
      'SELECT human_id, grant_id, requested_scopes, permission_bundle, duration, status, expires_at, kind, order_id, order_action, params_hash FROM agent_permission_requests WHERE id = ?', [req.params.id])
    if (!r) return void res.status(404).json({ error: 'permission_request_not_found' })
    if (r.human_id !== user.id) return void res.status(403).json({ error: 'not your permission request' })

    // RFC-021 PR2:order-action 请求分流。Passkey 绑三元组 (order_id, action, params_hash)(对齐 admin fallback 严格绑定);
    //   过期/pending 判定【原子在 domain 的 CAS 里】(P1-b,含 expires_at > now),不做两步式预检查。
    //   批到 approved 就【停】—— 绝不执行、不改订单、不碰钱路(execute 在 PR3)。
    if ((r.kind ?? 'scope_grant') === 'order_action') {
      const hp = requireHumanPresence(user.id as string, 'agent_permission_approve', (req.body || {}).webauthn_token as string | undefined, 'require_human_presence_for_agent_permission_approve',
        (data) => { const d = data as Record<string, unknown> | null; return d != null && typeof d === 'object' && d.request_id === req.params.id && d.order_id === r.order_id && d.action === r.order_action && d.params_hash === r.params_hash })
      if (!hp.ok) return void res.status(412).json({ error: hp.reason, error_code: hp.error_code })
      // PR3:CAS→approved 后【由服务端在 seller 本人授权下执行】accept/ship(strictTracking=true,守卫全在执行器内)。
      //   执行成功写 executed_at(I5 幂等);执行失败请求保持 approved 可重试。执行器对 agent-bearer 不可达(/approve 需人类 session)。
      const ar = approveAndExecuteOrderAction(db, req.params.id, user.id as string, r.grant_id, now, generateId)
      if (!ar.ok) return void res.status(ar.http || 409).json({ error: ar.error, error_code: ar.error_code })
      // 执行成功后通知买卖双方(事务外;通知失败不回滚已完成的状态跃迁)
      if (!ar.already_executed && ar.order_status) { try { const fromS = ar.order_status === 'accepted' ? 'paid' : 'accepted'; notifyTransition(db, r.order_id as string, fromS, ar.order_status) } catch { /* */ } }
      return void res.json({ success: true, kind: 'order_action', status: 'executed', order_id: r.order_id, action: r.order_action, order_status: ar.order_status, already_executed: ar.already_executed || false })
    }

    // RFC-025 PR-5a:order-submit 分流(钱路)。Passkey 绑 (request_id, draft_id, params_hash) —— 人批的
    //   经济快照即执行的,一字不差;执行 = 回环打真实 POST /api/orders(escrow 建单事务内扣款入托管)。
    if ((r.kind ?? 'scope_grant') === 'order_submit') {
      const hp = requireHumanPresence(user.id as string, 'agent_permission_approve', (req.body || {}).webauthn_token as string | undefined, 'require_human_presence_for_agent_permission_approve',
        (data) => { const d = data as Record<string, unknown> | null; return d != null && typeof d === 'object' && d.request_id === req.params.id && d.order_id === r.order_id && d.action === 'order_submit' && d.params_hash === r.params_hash })   // 四元组与 PWA aaApprove 一致,order_id 承载 draft_id -- Codex BLOCKER-1
      if (!hp.ok) return void res.status(412).json({ error: hp.reason, error_code: hp.error_code })
      if (!createOrderLoopback) return void res.status(503).json({ error: '批准执行暂不可用(执行通道未配置)', error_code: 'SUBMIT_EXEC_UNAVAILABLE' })
      const er = await approveAndExecuteOrderSubmit(db, { requestId: req.params.id, approverId: user.id as string, nowIso: now, getProtocolParam, generateId, createOrderLoopback })
      if (!er.ok) return void res.status(er.http || 409).json({ error: er.error, error_code: er.error_code, ...(er.ambiguous ? { ambiguous: true } : {}) })
      return void res.json({ success: true, kind: 'order_submit', status: 'executed', draft_id: r.order_id, order_id: er.order_id, already_executed: er.already_executed || false })
    }

    // scope_grant:保留既有两步(下方还有 grant-active 复检 + 原子 tx;非 order-action)。
    if (r.status !== 'pending' || r.expires_at <= now) return void res.status(409).json({ error: 'permission_request_not_pending', status: r.status })
    // Live Passkey, bound to THIS request (a token minted for request A can't approve B).
    const hp = requireHumanPresence(user.id as string, 'agent_permission_approve', (req.body || {}).webauthn_token as string | undefined, 'require_human_presence_for_agent_permission_approve',
      (data) => { try { return typeof data === 'object' && data !== null && (data as Record<string, unknown>).request_id === req.params.id } catch { return false } })
    if (!hp.ok) return void res.status(412).json({ error: hp.reason, error_code: hp.error_code })
    const reqScopes = scopeNames(r.requested_scopes)
    // Defense in depth: re-validate safe-only + duration allowed at approval time.
    if (!validateRequestedCapabilities(reqScopes.map(s => ({ capability: s }))).ok) return void res.status(403).json({ error: 'permission_not_grantable', error_code: 'PERMISSION_NOT_GRANTABLE' })
    if (!durationAllowedForScopes(reqScopes, r.duration)) return void res.status(403).json({ error: 'duration_not_allowed_for_risk', error_code: 'DURATION_NOT_ALLOWED' })
    // (P2) Verify the grant is ACTIVE *before* claiming the request — never leave a phantom 'approved'.
    const grant = await dbOne<{ grant_id: string; capabilities: string; status: string; expires_at: string; revoked_at: string | null }>(
      'SELECT grant_id, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE grant_id = ?', [r.grant_id])
    if (!grant || !grantIsActive(grant, now)) return void res.status(409).json({ error: 'grant_inactive', error_code: 'GRANT_INACTIVE', note: 'the agent grant expired or was revoked; re-pair (this request stays pending)' })
    // Duration: the HUMAN's submitted value is authoritative. If body.duration is PRESENT but not allowed →
    //   400 (no silent fallback; nothing claimed/expanded below). Only when ABSENT do we fall back to the
    //   agent's requested duration. Checked BEFORE the tx so an invalid value never claims/extends anything.
    const bodyDur = (req.body || {}).duration
    if (bodyDur !== undefined && bodyDur !== null && !durationAllowedForScopes(reqScopes, bodyDur)) {
      return void res.status(400).json({ error: 'invalid grant duration', error_code: 'INVALID_GRANT_DURATION', allowed_durations: allowedDurationsForScopes(reqScopes) })
    }
    // Union new scopes into the grant; set bundle; extend expiry (never shorten).
    const union = [...new Set([...scopeNames(grant.capabilities), ...reqScopes])].map(s => ({ capability: s, constraints: {} }))
    const effDuration: GrantDuration = (bodyDur !== undefined && bodyDur !== null) ? bodyDur as GrantDuration : (r.duration as GrantDuration)
    const secs = durationToSeconds(effDuration) || 3600
    const newExpiry = new Date(Date.now() + secs * 1000).toISOString()
    const expiresAt = newExpiry > grant.expires_at ? newExpiry : grant.expires_at
    // ATOMIC (RFC-020 invariant: a grant expansion is audited-or-it-does-not-happen; parity with arbitrator
    //   approve). CAS-claim the request + guarded-expand the grant + write the audit row in ONE sync
    //   db.transaction. If the audit INSERT throws, OR the grant was revoked in the race window (guarded
    //   WHERE → 0 rows → GrantInactiveError), the WHOLE tx rolls back: scopes unchanged, request stays pending.
    let outcome: 'expanded' | 'not_pending'
    try {
      outcome = db.transaction((): 'expanded' | 'not_pending' => {
        const claimed = db.prepare("UPDATE agent_permission_requests SET status='approved', approved_at=? WHERE id=? AND status='pending'").run(now, req.params.id)
        if (claimed.changes !== 1) return 'not_pending'
        const expanded = db.prepare("UPDATE agent_delegation_grants SET capabilities=?, permission_bundle=COALESCE(?, permission_bundle), expires_at=? WHERE grant_id=? AND status='active' AND revoked_at IS NULL").run(JSON.stringify(union), r.permission_bundle, expiresAt, grant.grant_id)
        if (expanded.changes !== 1) throw new GrantInactiveError()
        db.prepare('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)').run(grant.grant_id, user.id as string, `permission_request:approve:${r.permission_bundle || reqScopes.join(',')}`, 'allow', null)
        return 'expanded'
      })()
    } catch (e) {
      if (e instanceof GrantInactiveError) return void res.status(409).json({ error: 'grant_inactive', error_code: 'GRANT_INACTIVE', note: 'the agent grant was revoked while approving; request stays pending' })
      console.error('[agent-grant] approve tx failed (audit unavailable?):', (e as Error).message)
      return void res.status(503).json({ error: 'authorization audit unavailable; refusing to expand unaudited', error_code: 'GRANT_AUDIT_FAILED' })
    }
    if (outcome === 'not_pending') return void res.status(409).json({ error: 'permission_request_not_pending' })
    res.json({ success: true, grant_id: grant.grant_id, scopes: union.map(u => u.capability), permission_bundle: r.permission_bundle, duration: effDuration, expires_at: expiresAt })
  })

  // POST reject — human-authed. Terminal 'rejected'; nothing is granted.
  app.post('/api/agent-grants/permission-requests/:id/reject', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbOne<{ human_id: string; status: string }>('SELECT human_id, status FROM agent_permission_requests WHERE id = ?', [req.params.id])
    if (!r) return void res.status(404).json({ error: 'permission_request_not_found' })
    if (r.human_id !== user.id) return void res.status(403).json({ error: 'not your permission request' })
    if (r.status !== 'pending') return void res.status(409).json({ error: 'permission_request_not_pending', status: r.status })
    const rj = await dbRun("UPDATE agent_permission_requests SET status='rejected' WHERE id=? AND status='pending'", [req.params.id])
    if (!rj || rj.changes !== 1) return void res.status(409).json({ error: 'permission_request_not_pending' })
    res.json({ success: true, status: 'rejected' })
  })

  // ─────────────────────────── RFC-020 PR-C1: pairing (device-flow + PKCE) ───────────────────────────
  // C1 = pairing + credential delivery ONLY. No grant is consumed by any tool here (that is PR-C2).

  // (pair 1) Agent starts a pairing — UNAUTHENTICATED (agent has no credential yet). Safe scopes only.
  app.post('/api/agent-grants/pair/start', async (req, res) => {
    // Rate-limit the anonymous write FIRST (anti-bloat: no DB row unless under the cap).
    if (!rateLimitOk(`agent_pair_start:${req.ip || 'anon'}`, 10, 60_000)) {
      return void res.status(429).json({ error: 'too_many_pairing_starts', retry_after_s: 60 })
    }
    const body = (req.body || {}) as Record<string, unknown>
    const codeChallenge = typeof body.code_challenge === 'string' ? body.code_challenge : ''
    if (!codeChallenge || codeChallenge.length < 32 || codeChallenge.length > 256) return void res.status(400).json({ error: 'code_challenge required (PKCE S256)' })
    const caps = Array.isArray(body.capabilities) ? body.capabilities as Array<{ capability: string; constraints?: Record<string, unknown> }> : []
    if (caps.length > MAX_CAPABILITIES) return void res.status(400).json({ error: 'too_many_capabilities', max: MAX_CAPABILITIES })
    const v = validateRequestedCapabilities(caps)
    if (!v.ok) return void res.status(403).json({ error: 'pairing_rejected', rejected: v.rejected })  // risk + never-delegable hard-reject

    const pairingId = generateId('par')
    const userCode = generateUserCode()
    const ttl = clampPairingTtlSeconds(body.ttl_seconds)
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    const label = typeof body.agent_label === 'string' ? body.agent_label.slice(0, 120) : null
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 280) : null               // agent free text only
    const pubkey = typeof body.agent_pubkey === 'string' ? body.agent_pubkey.slice(0, 1000) : null  // RESERVED (PoP), not verified in C1
    const capsJson = JSON.stringify(v.safe.map(c => ({ capability: c, constraints: (caps.find(x => x?.capability === c)?.constraints) || {} })))
    if (capsJson.length > MAX_CONSTRAINTS_JSON) return void res.status(400).json({ error: 'capabilities_too_large', max_bytes: MAX_CONSTRAINTS_JSON })
    // Agent SUGGESTS a grant lifetime; the human accepts or overrides it at approve. Safe-scope only → up to 30d.
    const reqDuration: GrantDuration = durationAllowedForScopes(v.safe, body.duration) ? body.duration as GrantDuration : suggestedDurationForScopes(v.safe)

    await dbRun(
      'INSERT INTO agent_pairing_sessions (pairing_id, user_code, code_challenge, agent_label, agent_pubkey, reason, capabilities, grant_duration, status, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [pairingId, userCode, codeChallenge, label, pubkey, reason, capsJson, reqDuration, 'pending', expiresAt],
    )
    res.status(201).json({
      pairing_id: pairingId,
      user_code: userCode,
      approve_url: `/#pair?code=${userCode}`,
      expires_at: expiresAt,
      suggested_duration: reqDuration,
      allowed_durations: allowedDurationsForScopes(v.safe),
      note: 'Ask the human to open approve_url at webaz.xyz (logged in) and approve. The human picks the grant duration (your suggested_duration is pre-selected; they can change it). Then retrieve the credential with the PKCE verifier.',
    })
  })

  // (pair 2) Human reviews the server-generated consent — human-authenticated.
  app.get('/api/agent-grants/pair/:user_code', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<Record<string, unknown>>('SELECT * FROM agent_pairing_sessions WHERE user_code = ?', [req.params.user_code])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (!pairingApprovable(p, new Date().toISOString())) return void res.status(409).json({ error: 'pairing_not_pending_or_expired', status: p.status })
    res.json({ consent: consentView(p) })
  })

  // (pair 3) Human approves — human-authenticated. Issues the grant (token_hash filled at retrieve).
  app.post('/api/agent-grants/pair/:user_code/approve', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const now = new Date().toISOString()
    const p = await dbOne<Record<string, unknown>>('SELECT * FROM agent_pairing_sessions WHERE user_code = ?', [req.params.user_code])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (!pairingApprovable(p, now)) return void res.status(409).json({ error: 'pairing_not_pending_or_expired', status: p.status })

    // 人工在场 gate:批准 = 真人 Passkey/WebAuthn 确认(默认必需,param 可关)。挡"账号被静默批准"。
    //   注:这挡的是"是不是真人在批",不挡 illicit-consent(人被骗批错 agent)—— 那由前端强制口令核对 + safe-scope 兜底。
    //   token 必须【绑定这个配对码】(purpose_data.user_code === :user_code)—— 防"为批 A 拿到的 token 被首次提交去批 B"(与 delete_passkey 绑 credential_id 同法)。
    const hp = requireHumanPresence(user.id as string, 'agent_pair_approve', (req.body || {}).webauthn_token as string | undefined, 'require_human_presence_for_agent_pair_approve',
      (data) => { try { return typeof data === 'object' && data !== null && (data as Record<string, unknown>).user_code === req.params.user_code } catch { return false } })
    if (!hp.ok) return void res.status(412).json({ error: hp.reason, error_code: hp.error_code })

    // Re-validate scopes at approval time (defense in depth) — must still be safe-only.
    const caps = safeParseCaps(p.capabilities) as Array<{ capability: string; constraints?: Record<string, unknown> }>
    const v = validateRequestedCapabilities(caps)
    if (!v.ok) return void res.status(403).json({ error: 'pairing_rejected', rejected: v.rejected })

    const grantId = generateId('grt')
    // Duration: the HUMAN's submitted value is authoritative. If body.duration is PRESENT but not in the
    //   safe-scope matrix → 400 (no silent fallback; nothing claimed/issued below). Only when ABSENT do we
    //   fall back to the agent's suggestion (grant_duration) then the safe default.
    const bodyDur = (req.body || {}).duration
    if (bodyDur !== undefined && bodyDur !== null && !durationAllowedForScopes(v.safe, bodyDur)) {
      return void res.status(400).json({ error: 'invalid grant duration', error_code: 'INVALID_GRANT_DURATION', allowed_durations: allowedDurationsForScopes(v.safe) })
    }
    const chosenDuration: GrantDuration = (bodyDur !== undefined && bodyDur !== null)
      ? bodyDur as GrantDuration
      : (durationAllowedForScopes(v.safe, p.grant_duration) ? p.grant_duration as GrantDuration : suggestedDurationForScopes(v.safe))
    const expiresAt = new Date(Date.now() + (durationToSeconds(chosenDuration) || 3600) * 1000).toISOString()
    // 先【CAS 抢占】pending 配对(唯一赢家),再插 grant —— 竞态下输家 changes!==1 直接 409、不插任何 grant,
    //   杜绝"插了 grant 但配对更新失败"留下 token_hash NULL 的 orphan grant(污染连接记录)。
    const claimed = await dbRun(
      "UPDATE agent_pairing_sessions SET status='approved', human_id=?, grant_id=?, approved_at=? WHERE user_code=? AND status='pending'",
      [user.id, grantId, now, req.params.user_code],
    )
    if (!claimed || claimed.changes !== 1) return void res.status(409).json({ error: 'pairing_not_pending_or_expired' })
    // Grant created WITHOUT a token (token_hash NULL) — the bearer is minted only at retrieval.
    await dbRun(
      'INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      [grantId, user.id, p.agent_label || null, JSON.stringify(caps), null, 0, 'active', expiresAt],
    )
    res.json({ success: true, grant_id: grantId, capabilities: caps, duration: chosenDuration, expires_at: expiresAt })
  })

  // (pair 3b) Human rejects — human-authenticated. Terminal 'rejected' → agent's retrieve fails clearly (no silent lingering).
  //   拒绝是保护性动作,无需 Passkey(不签发任何凭证)。幂等:仅 pending 可拒。
  app.post('/api/agent-grants/pair/:user_code/reject', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ status: string }>('SELECT status FROM agent_pairing_sessions WHERE user_code = ?', [req.params.user_code])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (p.status !== 'pending') return void res.status(409).json({ error: 'pairing_not_pending', status: p.status })
    const r = await dbRun("UPDATE agent_pairing_sessions SET status='rejected', human_id=? WHERE user_code=? AND status='pending'", [user.id, req.params.user_code])
    if (!r || r.changes !== 1) return void res.status(409).json({ error: 'pairing_not_pending' })
    res.json({ success: true, status: 'rejected' })
  })

  // (pair 4) Agent retrieves the credential ONCE via PKCE verifier — UNAUTHENTICATED (PKCE-gated).
  app.post('/api/agent-grants/pair/:pairing_id/retrieve', async (req, res) => {
    const now = new Date().toISOString()
    const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : ''
    const p = await dbOne<Record<string, unknown>>('SELECT * FROM agent_pairing_sessions WHERE pairing_id = ?', [req.params.pairing_id])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (p.status === 'consumed' || p.consumed_at) return void res.status(409).json({ error: 'pairing_already_consumed' })
    if (!pairingRetrievable(p, now)) return void res.status(409).json({ error: 'pairing_not_approved_or_expired', status: p.status })
    if (!verifyPkceS256(verifier, String(p.code_challenge))) return void res.status(403).json({ error: 'pkce_mismatch' })

    // Confirm the issued grant is still active (could have been revoked between approve and retrieve).
    const grant = await dbOne<{ grant_id: string; status: string; capabilities: string; expires_at: string }>(
      'SELECT grant_id, status, capabilities, expires_at FROM agent_delegation_grants WHERE grant_id = ?', [String(p.grant_id)])
    if (!grant || grant.status !== 'active') return void res.status(409).json({ error: 'grant_inactive' })

    // Mint the bearer ONCE here; persist only its SHA-256 hash. Raw bearer is returned a single time.
    const token = `gtk_${randomBytes(32).toString('hex')}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    // One-time consume: only succeeds if still approved+unconsumed (guards against retrieval races/reuse).
    const consumed = await dbRun(
      "UPDATE agent_pairing_sessions SET status='consumed', consumed_at=? WHERE pairing_id=? AND status='approved' AND consumed_at IS NULL",
      [now, req.params.pairing_id],
    )
    if (!consumed || consumed.changes !== 1) return void res.status(409).json({ error: 'pairing_already_consumed' })
    await dbRun('UPDATE agent_delegation_grants SET token_hash=? WHERE grant_id=?', [tokenHash, grant.grant_id])

    res.json({
      grant_id: grant.grant_id,
      token,                                    // shown ONCE — agent stores it locally; server keeps only the hash
      token_note: 'Shown once. Store in your OS secret store; the server keeps only a hash and cannot reissue it.',
      capabilities: safeParseCaps(grant.capabilities),
      expires_at: grant.expires_at,
    })
  })

  // ── Direct grant issuance is DISABLED — single blessed path is the Passkey pairing flow. ──
  //   旧的"仅登录即直接 mint 原文 bearer"入口会旁路 #pair 的真人 Passkey 批准,削弱"human Passkey-approves
  //   agent delegation"的安全叙事。零消费方(前端/MCP/测试均不用),故降级为不可用,统一走 pairing。
  app.post('/api/agent-grants', (req, res) => {
    const user = auth(req, res); if (!user) return
    return void res.status(410).json({
      error: 'USE_PAIRING_FLOW', error_code: 'USE_PAIRING_FLOW',
      note: 'Direct grant issuance is disabled. Start pairing with webaz_pair (action=start); the human approves at /#pair with a Passkey, then the agent retrieves the credential with its PKCE verifier. No endpoint mints a bearer without a live Passkey ceremony bound to the pairing.',
    })
  })

  // ── Read: the human's connected agents (no secrets) + recent-use from the audit log (PR-D). ──
  // last_used_at / use_count come from agent_grant_auth_log (RFC-020 §3.7) — the data the
  // "Connected agents" UI shows so a human can spot stale/unused or busy agents before revoking.
  app.get('/api/agent-grants', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(
      `SELECT g.grant_id, g.agent_label, g.capabilities, g.status, g.created_at, g.expires_at, g.revoked_at, g.revoked_reason,
              MAX(CASE WHEN l.outcome = 'allow' THEN l.ts END) AS last_used_at,
              COUNT(CASE WHEN l.outcome = 'allow' THEN 1 END) AS use_count
         FROM agent_delegation_grants g
         LEFT JOIN agent_grant_auth_log l ON l.grant_id = g.grant_id
        WHERE g.human_id = ?
        GROUP BY g.grant_id
        ORDER BY g.created_at DESC`,
      [user.id],
    )
    const now = new Date().toISOString()
    res.json({
      grants: rows.map(g => ({
        ...g,
        capabilities: safeParseCaps(g.capabilities),
        use_count: Number(g.use_count) || 0,
        active: grantIsActive(g as { status?: string; expires_at?: string; revoked_at?: string | null }, now),
      })),
    })
  })

  // ── Revoke (online, one-click). ──
  app.post('/api/agent-grants/:grant_id/revoke', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const grantId = req.params.grant_id
    const g = await dbOne<{ grant_id: string; status: string }>(
      'SELECT grant_id, status FROM agent_delegation_grants WHERE grant_id = ? AND human_id = ?',
      [grantId, user.id],
    )
    if (!g) return void res.status(404).json({ error: 'grant_not_found' })
    if (g.status === 'revoked') return void res.json({ success: true, already_revoked: true, grant_id: grantId })
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : null
    await dbRun(
      "UPDATE agent_delegation_grants SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE grant_id = ? AND human_id = ?",
      [new Date().toISOString(), reason, grantId, user.id],
    )
    res.json({ success: true, grant_id: grantId })
  })
}
