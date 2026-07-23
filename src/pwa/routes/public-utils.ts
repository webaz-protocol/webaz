/**
 * 公开/工具类小端点 — health / system-flags / editor-picks / manifest
 *                  + mcp-telemetry / error-report
 *
 * 由 #1013 Phase 107 从 src/pwa/server.ts 抽出。
 *
 * 6 endpoints:
 *   GET  /api/health         LB/k8s readiness probe（DB ping + uptime + seed_strength）
 *   POST /api/mcp-telemetry  MCP 工具调用埋点（IP 限流 200/min）
 *   GET  /api/system-flags   注册门控公开探测（require_ref）
 *   GET  /api/editor-picks   生效中的编辑精选（商品 + 卖家各 20）
 *   GET  /api/manifest       协议 manifest dump（generateManifest(db)）
 *   POST /api/error-report   前端错误回传（IP 限流 30/min，不 401）
 *
 * 跨域注入：db + MASTER_SEED + NODE_ENV + SERVICE_START_MS
 *           + rateLimitOk + generateManifest + getUser + logError
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../../version.js'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam
import { capabilityMatrix } from '../endpoint-actions.js'
import { buildEntityDictionary } from '../entity-dictionary.js'
import { buildGoalIndex } from '../goal-index.js'
import { buildChangeFeed } from '../contract-fingerprint.js'
import { buildIntegrationContract } from '../integration-contract.js'
import { buildVerifiabilityIndex } from '../verifiability-index.js'
import { buildEconomicParticipation } from '../economic-participation.js'
import { buildNegativeSpace } from '../negative-space.js'
import { buildAcpProductFeed } from '../acp-feed.js'
import { remoteMcpEnabled, remoteMcpManifest } from './mcp-remote.js'
import { registerOpenAiAppsChallengeRoute } from './openai-apps-challenge.js'

export interface PublicUtilsDeps {
  db: Database.Database
  MASTER_SEED: string
  NODE_ENV: string
  SERVICE_START_MS: number
  rateLimitOk: (ip: string, max?: number, windowMs?: number) => boolean
  generateManifest: (db: Database.Database) => unknown | Promise<unknown>
  getUser: (req: Request) => Record<string, unknown> | null
  logError: (source: string, msg: string, ctx?: Record<string, unknown>) => void
  issuerAddress: () => string                                  // Phase 4 协议签发地址(信任锚)
}

export function registerPublicUtilsRoutes(app: Application, deps: PublicUtilsDeps): void {
  const { db, MASTER_SEED, NODE_ENV, SERVICE_START_MS, rateLimitOk,
          generateManifest, getUser, logError, issuerAddress } = deps
  registerOpenAiAppsChallengeRoute(app)

  app.get('/api/health', async (_req, res) => {
    const t0 = Date.now()
    let dbOk = false
    let dbLatency = 0
    try {
      const t1 = Date.now()
      const r = await dbOne<{ ok: number }>('SELECT 1 as ok')
      dbLatency = Date.now() - t1
      dbOk = r?.ok === 1
    } catch { dbOk = false }
    const uptime = Math.floor((Date.now() - SERVICE_START_MS) / 1000)
    const healthy = dbOk
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptime_sec: uptime,
      db: { ok: dbOk, latency_ms: dbLatency },
      seed_strength: MASTER_SEED === 'webaz-dev-seed-changeme' ? 'default' : MASTER_SEED.length >= 32 ? 'strong' : 'weak',
      env: NODE_ENV,
      check_ms: Date.now() - t0,
    })
  })

  app.post('/api/mcp-telemetry', async (req, res) => {
    const ip = req.ip || 'unknown'
    if (!rateLimitOk(ip)) return void res.status(429).json({ error: 'rate-limited' })

    const { tool_name, outcome, latency_ms, user_id_hash, server_version } = req.body ?? {}
    if (typeof tool_name !== 'string' || tool_name.length === 0 || tool_name.length > 64) {
      return void res.status(400).json({ error: 'bad tool_name' })
    }
    if (outcome !== 'success' && outcome !== 'error') {
      return void res.status(400).json({ error: 'bad outcome' })
    }
    const lat = Number(latency_ms)
    if (!Number.isFinite(lat) || lat < 0 || lat > 60_000) {
      return void res.status(400).json({ error: 'bad latency' })
    }
    const uih = typeof user_id_hash === 'string' && /^[0-9a-f]{1,32}$/.test(user_id_hash) ? user_id_hash : null
    const sv  = typeof server_version === 'string' && server_version.length <= 32 ? server_version : null

    try {
      await dbRun(`
        INSERT INTO mcp_tool_calls (tool_name, user_id_hash, server_version, outcome, latency_ms)
        VALUES (?, ?, ?, ?, ?)
      `, [tool_name, uih, sv, outcome, Math.round(lat)])
    } catch { /* swallow — never fail telemetry */ }
    res.json({ ok: true })
  })

  app.get('/api/system-flags', async (_req, res) => {
    const requireRef = (await dbOne<{ value: string }>("SELECT value FROM system_state WHERE key='require_ref_to_register'"))?.value === '1'
    // #1049 Turnstile 公钥(若启用),前端注册表单 widget 用
    const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || null
    res.json({
      require_ref_to_register: requireRef,
      turnstile_site_key: turnstileSiteKey,
    })
  })

  // #1045 + #1048 整合 — 公开诚实化 manifest
  //   /.well-known/webaz-protocol.json  — 标准 well-known URL,任何 HTTP 客户端可发现
  //   /api/protocol-status              — JSON API 别名(同份内容)
  // 内容:network_state(协议处于哪一阶段 + 诚实免责) + issuers(信任锚地址 + 轮换历史)
  // 信任锚是 Phase 4 凭证(/api/me/agents/:prefix/passport)的验签依据,陌生第三方靠这个端点找到"webaz 官方地址"。
  async function buildProtocolManifest() {
    const phase = (await dbOne<{ value: string }>("SELECT value FROM system_state WHERE key='protocol_phase'"))?.value || 'launched'
    // real_users = 已绑 Passkey 的账号数(我们的"真人"定义),始终按 live DB 实时计算。
    const realUsers = (await dbOne<{ n: number }>("SELECT COUNT(DISTINCT user_id) AS n FROM webauthn_credentials"))?.n ?? 0
    const issuerActiveSince = (await dbOne<{ value: string }>("SELECT value FROM system_state WHERE key='issuer_active_since'"))?.value || '2026-05-30'
    return {
      name: 'WebAZ Protocol',
      // RFC-011 §④ 两轴版本(单一来源 src/version.ts):
      //   schema_version  = 集成契约版本(整数,仅 breaking 契约变更才 bump;集成方 agent 按此判兼容)
      //   software_version = 本代码 npm/release semver(= package.json,自动同步,永不漂移)
      schema_version: CONTRACT_VERSION,
      software_version: SOFTWARE_VERSION,
      // ★ Remote MCP — 顶层公告(完整 shape),陌生 agent 扫 protocol.json 即发现可连接地址。仅端点真开时出现。
      ...(remoteMcpManifest() ? { remote_mcp: remoteMcpManifest() } : {}),
      // 给【终端用户/买家】的一句话价值主张 —— 陌生 agent / 爬虫抓 manifest 第一眼就懂"对买家有什么用",
      //   不只是抽象 tagline + 技术 description。与 MCP webaz_info.for_end_user 对齐(两个发现面一致)。
      for_end_user: {
        one_liner: 'WebAZ is live for commerce through Direct Pay: real off-platform payment straight from buyer to seller, with protocol-recorded order states and evidence. WebAZ is non-custodial and never holds the principal. The escrow rail remains a simulated test flow while additional payment methods are being added. / WebAZ 已发布并可通过直付交易:买家向卖家进行真实场外付款,协议记录订单状态和证据。WebAZ 非托管,不经手本金。托管轨仍为模拟测试流程,其他支付方式持续接入。',
        why_use: [
          'Direct Pay rail (live, conditions-gated) — pay the seller directly off-platform; non-custodial: WebAZ never holds the principal, does not guarantee and cannot refund, but records risk confirmation + Passkey, payment-info snapshot, order states and evidence for auditability.',
          'Escrow rail — currently a simulated WAZ test flow, not a real payment method. Additional real payment methods are being added.',
          'Automatic fault ruling — seller fails to accept/ship/deliver in time → auto-refund on the escrow rail; on Direct Pay, timeouts rule reputation fault (non-custodial: no money moves through WebAZ).',
          'Disputes with evidence + neutral arbitration.',
          'Decision-ready transparency — seller reputation, price history and arbitration precedents are public before you buy.',
          'Agent-native — your AI agent can compare, order and track fulfillment via MCP.',
        ],
        honesty: 'WebAZ is launched. Direct Pay is real off-platform payment between buyer and seller — non-custodial, gated per seller/product/region/amount, and fail-closed by default. The escrow rail remains simulated and must not be treated as a real payment method.',
        try_it: 'Browse now, no account needed → https://webaz.xyz/#discover',
        get_access: 'Registration currently uses invitations for Sybil resistance — request one at https://webaz.xyz/#welcome (browsing needs no invite).',
      },
      network_state: {
        phase,
        real_users_on_canonical: realUsers,
        canonical_endpoint: 'https://webaz.xyz',
        economic_flow: 'dual-rail — escrow rail: simulated WAZ (test currency, 1 WAZ ≈ 1 USDC peg is a模拟基准, not a real exchange rate); no fiat/crypto settles through WebAZ custody. Direct Pay rail: real off-platform payment directly between buyer and seller (non-custodial — WebAZ never holds the principal; conditions-gated per seller/product/region/amount, fail-closed).',
        disclaimer: {
          zh: 'WebAZ 已公开发布;real_users_on_canonical 实时反映已绑定 Passkey 的账户数。当前真实交易使用直付轨(Direct Pay):买家与卖家直接进行场外付款,本金不经过 WebAZ。托管轨仍为模拟测试流程,其他支付方式持续接入。',
          en: 'WebAZ is publicly launched; real_users_on_canonical reflects the live count of Passkey-bound accounts. Real transactions currently use Direct Pay: payment moves directly between buyer and seller and never through WebAZ. The escrow rail remains a simulated test flow while additional payment methods are being added.',
        },
      },
      issuers: {
        // 数组结构 — 将来轮换/泄露时往里追加新条目并把旧的设 revoked_at,验真方按签发时间判落在哪个有效区间
        agent_passport: [
          {
            address: issuerAddress(),
            did_web: 'did:web:webaz.xyz',                                            // W3C DID method,resolve at /.well-known/did.json
            did_legacy: 'did:webaz:' + issuerAddress(),                              // 原自定义形态,Phase 4 webaz_format 仍用
            scheme: 'eip191',
            purpose: 'Phase 4 Agent Passport signing (custodian_fingerprint + risk_score + engagement_depth + behavior_profile)',
            active_since: issuerActiveSince,
            revoked_at: null,
            verify: 'verifyMessage(address, passport.canonical, passport.signature) — any party can ecrecover without calling WebAZ',
          },
        ],
      },
      // 公开披露文档(#1050) — 协议层"钱怎么流"的源真理(协议外可读)
      disclosures: {
        // 源码仓库已公开(github.com/webaz-protocol/webaz);机器可读 spec 也全在 /.well-known/*。
        source_status: 'repo is public (github.com/webaz-protocol/webaz); the full spec is also available via /.well-known/*.',
        economic_model: 'https://github.com/webaz-protocol/webaz/blob/main/docs/ECONOMIC-MODEL.md',
        mlm_compliance: 'https://github.com/webaz-protocol/webaz/blob/main/docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md',
        agent_governance: 'https://github.com/webaz-protocol/webaz/blob/main/docs/AGENT-GOVERNANCE.md',
        changelog: 'https://github.com/webaz-protocol/webaz/blob/main/CHANGELOG.md',
        // RFC-011 §②:agent 可读能力矩阵(写边界 action-scope + 敏感读 scope),live doc=code
        capability_matrix: 'https://webaz.xyz/.well-known/webaz-capabilities.json',
      },
      // RFC-011 agent 接入 live 端点;总入口 integration.json 把它们按旅程串起来
      agent_endpoints: {
        integration_contract: 'https://webaz.xyz/.well-known/webaz-integration.json', // RFC-011 总入口(按旅程导航全维度)
        ...(remoteMcpEnabled() ? { remote_mcp: 'https://webaz.xyz/mcp' } : {}),           // RFC-022 远程 MCP(仅开启时披露)
        capability_matrix: 'https://webaz.xyz/.well-known/webaz-capabilities.json',   // ② 边界(#126)
        entity_dictionary: 'https://webaz.xyz/.well-known/webaz-entities.json',       // ① 语义(order/product/dispute 状态机 + 字段)
        goal_index: 'https://webaz.xyz/.well-known/webaz-goals.json',                 // ① 目标索引(intent → action + endpoint + 工具)
        change_feed: 'https://webaz.xyz/api/agent/changes',                           // ④ 契约变更 + 指纹 + 弃用
        verifiability_index: 'https://webaz.xyz/.well-known/webaz-verifiability.json', // ⑤ 什么可验+怎么验
        economic_participation: 'https://webaz.xyz/.well-known/webaz-economic.json',  // ⑧ value-participant 角色经济条款(费率实时)
        launch_pulse: 'https://webaz.xyz/.well-known/webaz-launch-pulse.json',        // 兼容既有端点名:诚实 live 计数 + 动量 + 里程碑
        negative_space: 'https://webaz.xyz/.well-known/webaz-negative-space.json',    // ② 负空间(禁区 + 限额 + 后果阶梯)
        event_stream: 'https://webaz.xyz/api/agent/events?since=<cursor>',            // ⑥ 事件游标流(party-gated,需 auth)
        passport: 'https://webaz.xyz/api/me/agents/:apiKeyPrefix/passport',            // ⑤ 可验护照
        did: 'https://webaz.xyz/.well-known/did.json',
        acp_product_feed: 'https://webaz.xyz/.well-known/webaz-acp-feed.json',          // RFC-015 P0 — ACP-inspired 商品【发现】投影(非 strict ACP-ingestable;只读;is_eligible_checkout=false;见 feed.compatibility)
      },
      // 路线图 — 回应"知道还有哪些没做"的诚实化第三层。哲学:公开当前到达点 + 已知未做项,不承诺时间表。
      roadmap: {
        philosophy: 'Disclose what is live + what is known-not-yet-done. We do not publish speculative deadlines; we commit to honest enumeration.',
        completed: [
          'Phase 1-4 Agent Passport: custodian + risk + behavior + signed portable export (cross-protocol ecrecover verifiable)',
          'Phase 3a-3d access control: registration rate-limit + invite-required + declared-scope reads/writes + non-Passkey writers must declare',
          'Iron-Rule: arbitrate / vote / agent_revoke / delete_passkey / large withdraw all require live WebAuthn ceremony',
          'Integrity disclosure: MCP descriptions + /.well-known + payment-status banner + protocol-status endpoint',
          'Cross-user read daily cap — distinct other-user-id per day, Passkey humans capped too (#1043, 2026-05-30)',
          'AP2 Mandate dual-output — verify_price + place_order emit signed AP2 Intent/Cart/Payment Mandate alongside webaz format (B.4 b, 2026-05-30)',
          'Public economic model document — docs/ECONOMIC-MODEL.md (#1050, 2026-05-30)',
        ],
        known_next: [
          'Adaptive registration abuse controls beyond verified email + invitations — ongoing hardening',
          'Phase 5 ZK privacy L2/L3 — long-term research; triggered when real cross-protocol consumers appear',
        ],
        deliberate_deferrals: [
          'Model B (independent sub-agent keys with delegated scope) — destination locked; not building until real multi-agent demand surfaces',
          'Parameterized fee rates (settleOrder currently hardcodes) — wire when fee governance launches',
          'Binary/PV referral region MLM-term cleanup — region-gated to max=3 areas; deferred until structural decision on tree',
        ],
        rationale_for_no_dates: 'Shipping dates depend on review, safety and real demand. We publish the work list and the current state instead of speculative deadlines.',
      },
    }
  }
  app.get('/.well-known/webaz-protocol.json', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')  // 5min 边缘缓存,降轮询
    res.json(await buildProtocolManifest())
  })
  app.get('/api/protocol-status', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(await buildProtocolManifest())
  })

  // L2 公开运行脉搏(2026-06-08):真实计数 + 7d 动量 + 里程碑(firsts),零粉饰。
  //   纯公开读(无 auth),网站侧(不进 MCP 包,Railway 部署即生效)。
  // RFC-016 Phase 0 试点:本函数改用异步 DB seam(dbOne)。其余 call site 后续分批迁。
  async function buildLaunchPulse() {
    const count = async (sql: string): Promise<number> => ((await dbOne<{ n: number }>(sql))?.n ?? 0)
    const firstAt = async (sql: string): Promise<string | null> => ((await dbOne<{ t: string }>(sql))?.t ?? null)
    const phase = (await dbOne<{ value: string }>("SELECT value FROM system_state WHERE key='protocol_phase'"))?.value || 'launched'
    const [passkey, sellers, products, completed, disputesResolved, newPasskey7d, orders7d,
           firstSeller, firstProduct, firstOrder, firstCompleted, firstDispute] = await Promise.all([
      count("SELECT COUNT(DISTINCT user_id) AS n FROM webauthn_credentials"),
      count("SELECT COUNT(*) AS n FROM users WHERE roles LIKE '%seller%' AND (deleted_at IS NULL OR deleted_at = '')"),
      count("SELECT COUNT(*) AS n FROM products WHERE status='active'"),
      count("SELECT COUNT(*) AS n FROM orders WHERE status='completed'"),
      count("SELECT COUNT(*) AS n FROM disputes WHERE status='resolved'"),
      count("SELECT COUNT(DISTINCT user_id) AS n FROM webauthn_credentials WHERE created_at > datetime('now','-7 day')"),
      count("SELECT COUNT(*) AS n FROM orders WHERE created_at > datetime('now','-7 day')"),
      firstAt("SELECT MIN(created_at) AS t FROM users WHERE roles LIKE '%seller%'"),
      firstAt("SELECT MIN(created_at) AS t FROM products"),
      firstAt("SELECT MIN(created_at) AS t FROM orders"),
      firstAt("SELECT MIN(updated_at) AS t FROM orders WHERE status='completed'"),
      firstAt("SELECT MIN(resolved_at) AS t FROM disputes WHERE status='resolved'"),
    ])
    return {
      phase,
      as_of: new Date().toISOString(),
      note: 'Live protocol pulse — real counts, zero inflation. Track current participation and activity.',
      participants: { passkey_bound_humans: passkey, sellers },
      catalog: { active_products: products },
      activity: {
        completed_orders: completed,
        disputes_resolved: disputesResolved,
        new_passkey_humans_7d: newPasskey7d,
        orders_7d: orders7d,
      },
      milestones: {
        first_seller_at: firstSeller,
        first_product_listed_at: firstProduct,
        first_order_at: firstOrder,
        first_order_completed_at: firstCompleted,
        first_dispute_resolved_at: firstDispute,
      },
      next: 'Use live non-custodial Direct Pay now; additional real payment methods will be added over time. Browse or request registration access: https://webaz.xyz/#welcome',
      honesty: 'WebAZ is launched. Direct Pay orders are real off-platform payments between buyer and seller (non-custodial — WebAZ never holds principal); the escrow rail remains simulated. These numbers are the live protocol state.',
    }
  }
  app.get('/.well-known/webaz-launch-pulse.json', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=120')
    res.json(await buildLaunchPulse())
  })
  app.get('/api/launch-pulse', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=120')
    res.json(await buildLaunchPulse())
  })

  // RFC-011 §② — agent 可读能力矩阵(写边界 action-scope + 敏感读 scope)。
  //   live = 直接序列化 enforce 用的规则表(src/pwa/endpoint-actions.ts),doc=code 零漂移。
  //   集成方 agent fetch 此端点即知"我要做的写需要声明哪个 scope / 哪些写无需 scope / 哪些读受约束"。
  app.get('/.well-known/webaz-capabilities.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(capabilityMatrix())
  })
  app.get('/api/agent/capabilities', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(capabilityMatrix())
  })

  // RFC-011 §① — agent 可读实体字典(订单状态机 doc=code + 保守公开字段 + 可验证标注)。
  app.get('/.well-known/webaz-entities.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildEntityDictionary())
  })
  app.get('/api/agent/entities', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildEntityDictionary())
  })

  // RFC-011 §① 目标索引 —— intent → action(②)+ endpoint + MCP 工具 + PWA 页(agent 自路由)。
  app.get('/.well-known/webaz-goals.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildGoalIndex())
  })

  // 集成必需文档(规则 + onboarding)由协议自身 serve —— 外部 agent 必须能读到约束它的规则,
  //   不能指向私有 repo 的 GitHub(对外 404)。显式白名单:只暴露这 3 份"本就该公开"的文档,
  //   非白名单 → 404(不泄漏 RFC/审计等内部设计文档;它们是 provenance,随 repo 公开解锁)。
  const PUBLIC_DOCS = new Set(['INTEGRATOR.md', 'META-RULES-FULL.md', 'ECONOMIC-MODEL.md', 'REMOTE-MCP.md'])
  const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs')  // repo-root/docs(dev+prod 都解析到此)
  app.get('/docs/:name', (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!PUBLIC_DOCS.has(name)) return void res.status(404).json({ error: 'not a public doc', public_docs: [...PUBLIC_DOCS] })
    try {
      const md = readFileSync(path.join(DOCS_DIR, name), 'utf8')
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.send(md)
    } catch { res.status(404).json({ error: 'doc unavailable' }) }
  })
  app.get('/api/agent/goals', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildGoalIndex())
  })

  // RFC-011 §④ — 契约变更 feed:current_contract_version + 契约面指纹 + 变更注册表 + 弃用策略。
  //   agent 用上次见过的 contract_version poll;指纹让它不必 diff 整份契约就知道有没有漂移。
  //   指纹由 tests/test-contract-fingerprint.ts + docs/CONTRACT-LOCK.json 守住(静默改契约不可 merge)。
  app.get('/api/agent/changes', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildChangeFeed())
  })

  // RFC-011 总入口 —— 集成方 agent 一次 fetch 拿到整份契约导航(按旅程组织,指向各维度 live 端点)。
  app.get('/.well-known/webaz-integration.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildIntegrationContract())
  })
  app.get('/api/agent/integration', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildIntegrationContract())
  })

  // RFC-011 §⑤ 可验证索引 —— "什么可验 + 怎么验"统一表(护照/锚/AP2/订单链),诚实分级。
  app.get('/.well-known/webaz-verifiability.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildVerifiabilityIndex())
  })
  app.get('/api/agent/verifiability', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildVerifiabilityIndex())
  })

  // RFC-011 §⑧ 经济参与索引 —— value-participant 角色 × 赚什么/押什么/担什么责,
  //   费率【实时】从 protocol_params 读(doc=code,永不和 enforced 经济漂移)。
  // RFC-016: 一次性异步预取全部 protocol_params → Map,再返回同步 getter,喂给
  //   buildEconomicParticipation / buildNegativeSpace(保持其同步签名,不动共享 module),仍是 doc=code 实时读。
  const loadLiveParam = async (): Promise<<T>(key: string, fallback: T) => T> => {
    const paramRows = await dbAll<{ key: string; value: string; type: string }>('SELECT key, value, type FROM protocol_params')
    const paramMap = new Map(paramRows.map(r => [r.key, r]))
    return <T>(key: string, fallback: T): T => {
      const row = paramMap.get(key)
      if (!row) return fallback
      if (row.type === 'number') return Number(row.value) as unknown as T
      if (row.type === 'boolean') return (row.value === 'true' || row.value === '1') as unknown as T
      return row.value as unknown as T
    }
  }
  const economic = async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildEconomicParticipation(await loadLiveParam()))
  }
  app.get('/.well-known/webaz-economic.json', economic)
  app.get('/api/agent/economic-participation', economic)

  // RFC-011 §② 负空间 —— 禁区 + enforced 限额 + 后果阶梯(per-agent 速率实时读)。
  const negativeSpace = async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildNegativeSpace(await loadLiveParam()))
  }
  app.get('/.well-known/webaz-negative-space.json', negativeSpace)
  app.get('/api/agent/negative-space', negativeSpace)

  // RFC-015 P0 —— ACP-inspired 商品【发现】投影:把现有商品投影成 OpenAI Agentic Commerce 的 feed 形状,
  //   让 ACP/ChatGPT agent 能【发现】WebAZ 商品(只读,无钱)。【非 strict ACP-ingestable feed】(Codex #151):
  //   currency=WAZ 非 ISO 4217、is_eligible_checkout 恒 false(ACP /complete 是卡+PSP,WebAZ 未接)
  //   —— 非合规点逐条见 feed.compatibility。store_country/target_countries 自 A0(#510)起按辖区/跨境规则诚实发出。
  //   详见 buildAcpProductFeed + RFC-015。
  const acpFeed = (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(buildAcpProductFeed(db))
  }
  app.get('/.well-known/webaz-acp-feed.json', acpFeed)
  app.get('/api/agent/acp-feed', acpFeed)

  // W3C DID Document(B.6 b DID 短期 mapping,2026-05-30):
  //   did:web:webaz.xyz 通过 HTTPS 解析到这里(W3C did:web spec §3.2)
  //   verificationMethod 用 EcdsaSecp256k1RecoveryMethod2020 + CAIP-10 blockchainAccountId
  //   任何标准 DID resolver(Veramo / SpruceID / KILT / web5 ...)可 GET → 解出 issuer key → 验 Phase 4 凭证签名
  app.get('/.well-known/did.json', (_req, res) => {
    const addr = issuerAddress()
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/secp256k1recovery-2020/v2',
      ],
      id: 'did:web:webaz.xyz',
      verificationMethod: [
        {
          id: 'did:web:webaz.xyz#key-1',
          type: 'EcdsaSecp256k1RecoveryMethod2020',
          controller: 'did:web:webaz.xyz',
          // CAIP-10:eip155 namespace + Base mainnet chain id (8453) + 同把 hot wallet 地址(Phase 4 同款)
          // 注:WAZ peg USDC,真链 Base/Base Sepolia,但 issuer key 是协议级,链中立,这里只标声明绑定到 Base 用于消费者发现
          blockchainAccountId: `eip155:8453:${addr}`,
        },
      ],
      assertionMethod: ['did:web:webaz.xyz#key-1'],
      authentication: ['did:web:webaz.xyz#key-1'],
      // 自描述 — 让 resolver 知道这个 DID 用来签 webaz agent passport
      service: [
        {
          id: 'did:web:webaz.xyz#agent-passport-endpoint',
          type: 'WebAZAgentPassportEndpoint',
          serviceEndpoint: 'https://webaz.xyz/api/me/agents/:apiKeyPrefix/passport',
        },
        {
          id: 'did:web:webaz.xyz#protocol-manifest',
          type: 'WebAZProtocolManifest',
          serviceEndpoint: 'https://webaz.xyz/.well-known/webaz-protocol.json',
        },
      ],
    })
  })

  app.get('/api/editor-picks', async (_req, res) => {
    const products = await dbAll(`
      SELECT ep.id, ep.target_id, ep.title, ep.note, ep.starts_at, ep.ends_at, ep.sort_order,
        p.title as product_title, p.price, p.images, p.category,
        u.handle as seller_handle
      FROM editor_picks ep
      JOIN products p ON p.id = ep.target_id AND p.status = 'active'
      JOIN users u ON u.id = p.seller_id
      WHERE ep.kind = 'product' AND ep.starts_at <= datetime('now') AND ep.ends_at > datetime('now')
      ORDER BY ep.sort_order ASC, ep.created_at DESC LIMIT 20
    `)
    const sellers = await dbAll(`
      SELECT ep.id, ep.target_id, ep.title, ep.note, ep.starts_at, ep.ends_at, ep.sort_order,
        u.handle, u.name, u.shop_banner_url, u.bio
      FROM editor_picks ep
      JOIN users u ON u.id = ep.target_id AND u.role = 'seller'
      WHERE ep.kind = 'seller' AND ep.starts_at <= datetime('now') AND ep.ends_at > datetime('now')
      ORDER BY ep.sort_order ASC, ep.created_at DESC LIMIT 20
    `)
    res.json({ products, sellers })
  })

  app.get('/api/manifest', async (_req, res) => {
    res.json(await generateManifest(db))
  })

  // W3.5-B 治理上岗公开 stats(docs/GOVERNANCE-ONBOARDING.md)
  // 无 auth — agent / 用户 / 第三方都可读;不暴露 PII
  app.get('/api/governance/onboarding-stats', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    try {
      // active counts(users.roles 含 arbitrator / verifier 的人数,fixture 也算)
      const arbitratorCount = (await dbOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE roles LIKE '%arbitrator%' AND (deleted_at IS NULL OR deleted_at = '')`
      ))?.n ?? 0
      const verifierCount = (await dbOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE roles LIKE '%verifier%' AND (deleted_at IS NULL OR deleted_at = '')`
      ))?.n ?? 0
      // pending applications
      const pendingCount = (await dbOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM governance_applications WHERE status = 'pending_onboarding'`
      ))?.n ?? 0
      // 资格门槛 snapshot(给前端 pre-check 显示)
      // ⚠️ 2026-06-03 #4 修:此前这里 dump 装饰性 protocol_params.governance_onboarding.*,
      //   与代码实际 enforce 的门槛不符(例 min_completed_orders param=5,但代码 arbitrator 要 50 /
      //   verifier 要 20;arbitrator_min_reputation param=95,代码要 300)— 把错误数字当资格要求
      //   显示给用户构成 #4 误导。改为返回【真实 enforced 门槛】,role-split。
      // ⚠️ 必须与 server.ts checkArbitratorEligibility / checkVerifierEligibility 保持同步。
      const eligibility = {
        arbitrator: { registration_days: 90, completed_orders: 50, reputation: 300, balance_waz: 500, email_verified: true, zero_disputes_lost: true, never_suspended: true },
        verifier:   { registration_days: 60, completed_orders: 20, reputation: 110, balance_waz: 200, email_verified: true, zero_disputes_lost: true, never_suspended: true },
      }
      // quiz_pass_score 是真正被代码读取的 param(governance-onboarding.ts quiz-submit),保留。
      const quizPassRow = await dbOne<{ value: string }>(
        `SELECT value FROM protocol_params WHERE key = 'governance_onboarding.quiz_pass_score'`
      )
      const quizPassScore = Number(quizPassRow?.value ?? 80)

      res.json({
        phase: 'A',
        compensation: 'none',                  // phase A 无报酬
        observation_only: true,                // leaderboard observation-only
        active_arbitrators: arbitratorCount,
        active_verifiers: verifierCount,
        pending_applications: pendingCount,
        eligibility,
        quiz_pass_score: quizPassScore,
        spec_urls: {
          onboarding: 'https://github.com/webaz-protocol/webaz/blob/main/docs/GOVERNANCE-ONBOARDING.md',
          playbook: 'https://github.com/webaz-protocol/webaz/blob/main/docs/ARBITRATION-PLAYBOOK.md',
          leaderboard: 'https://github.com/webaz-protocol/webaz/blob/main/docs/GOVERNANCE-LEADERBOARD-SPEC.md',
        },
      })
    } catch (e) {
      logError('governance-onboarding-stats', (e as Error).message)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  const _errorReportLimiter = new Map<string, { count: number; reset: number }>()
  app.post('/api/error-report', (req, res) => {
    const ip = req.ip || 'unknown'
    const now = Date.now()
    const bucket = _errorReportLimiter.get(ip) || { count: 0, reset: now + 60_000 }
    if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60_000 }
    bucket.count++
    _errorReportLimiter.set(ip, bucket)
    if (bucket.count > 30) return void res.status(429).json({ error: 'rate_limited' })

    const { message, stack, url } = req.body || {}
    if (!message || typeof message !== 'string') return void res.status(400).json({ error: 'message required' })
    const user = getUser(req) as { id: string } | null
    logError('client', message.slice(0, 1000), { stack: String(stack || '').slice(0, 4000), url: String(url || '').slice(0, 500), user_agent: req.headers['user-agent'] || '', user_id: user?.id })
    res.json({ ok: true })
  })
}
