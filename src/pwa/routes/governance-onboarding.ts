/**
 * Governance onboarding 申请域(W3.5-B 实施,task #1093 阶段 1)
 *
 * 实现 docs/GOVERNANCE-ONBOARDING.md §3 申请流程的后端。
 * 区别于 src/pwa/routes/arbitrator.ts(legacy stake-based 申请,写 arbitrator_applications 表):
 *   - 本模块写 governance_applications 表(append-only,W3.5-B spec)
 *   - 支持 arbitrator + verifier 两个 role
 *   - 反诱导 design: server-side 8s 延迟 + consent_hash + Passkey
 *   - 与老 arbitrator_applications 共存,不冲突
 *
 * 阶段 1 实施(本 PR):
 *   ✅ POST /api/governance/onboarding/apply   申请
 *   ✅ GET  /api/governance/onboarding/my       我的申请列表
 *
 * 后续阶段(task #1093):
 *   ⏳ POST /api/governance/onboarding/resign        卸任(阶段 4)
 *   ⏳ POST /api/governance/onboarding/appeal        申诉(阶段 4)
 *   ⏳ POST /api/admin/governance/activate           maintainer 激活(阶段 3,代码自动 re-gate)
 *   ⏳ Cron auto-deactivate(阶段 5)
 *   ⏳ POST /api/dispute/arbitrator/pause           暂停仲裁(阶段 6)
 *   ⏳ protocol_params 真参数化(阶段 7)
 *
 * 边界(参 docs/GOVERNANCE-ONBOARDING.md §3.1):
 *   - page_loaded_at 必须,server 验证 now - page_loaded_at >= 8s(反诱导)
 *   - 同 role active/pending → 409
 *   - cooldown_until 未到 → 409
 *   - eligibility 不过 → 400 + missing_requirements(严 gate,不允许提交 rejected 条目)
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { getQuestionsForRole, scoreQuiz, type QuizAnswerInput } from '../data/onboarding-quiz.js'
import { getCasesForRole, getCasesForMaintainer, validateCaseReviews, type CaseReviewInput } from '../data/onboarding-cases.js'
// RFC-016 Phase 1 — 申请/题目/案例/申诉的校验读 + 列表读 + 单语句写 → async seam;
//   activate/resign/resolve-appeal 的 3 个角色态 CAS db.transaction 保持同步(Phase 3 迁 pg)。
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'
import { grantArbitratorTx, suspendArbitrator } from '../arbitrator-lifecycle.js'  // PR-B/PR-C.2:激活桥接 active whitelist 同事务;#249-P2:仲裁员卸任真源=whitelist(suspend 可复用,非终态 revoke)
import { isActiveWhitelistArbitrator } from '../../layer3-trust/L3-1-dispute-engine/dispute-engine.js'

interface EligibilityItem {
  key: string
  label: string
  current?: unknown
  required?: unknown
  ok: boolean
}

export interface GovernanceOnboardingDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  checkArbitratorEligibility: (userId: string) => { eligible: boolean; items: EligibilityItem[] }
  checkVerifierEligibility: (userId: string) => { eligible: boolean; items: EligibilityItem[] }
  // PR #22 review fix:Passkey 真验 + consent_hash 内容校验
  consumeGateToken: (userId: string, token: string | undefined, purpose: string, validate: (data: unknown) => boolean) => { ok: boolean; reason?: string }
  getProtocolParam: <T>(key: string, fallback: T) => T
  // PR #25 阶段 3:maintainer activation flow
  requireGovernanceAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

// PR #22 review fix P1-2:披露文本版本(server 与 client 同步,变更披露需 bump)
// client 在 src/pwa/public/app.js 必须用相同 version
export const GOVERNANCE_APPLY_DISCLOSURE_VERSION = 'v1.0-2026-06-02'

export function registerGovernanceOnboardingRoutes(app: Application, deps: GovernanceOnboardingDeps): void {
  const { db, generateId, auth, errorRes, checkArbitratorEligibility, checkVerifierEligibility, consumeGateToken, getProtocolParam, requireGovernanceAdmin, logAdminAction } = deps

  const sha256_16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
  const sha256_hex = (s: string) => createHash('sha256').update(s).digest('hex')

  // PR #22 review fix P1-2:server 重建期望的 consent_hash 与 client 提交比对
  function expectedConsentHash(role: string, userId: string, pageLoadedAt: number): string {
    return sha256_hex(`governance_apply|disclosure=${GOVERNANCE_APPLY_DISCLOSURE_VERSION}|role=${role}|user=${userId}|page_loaded_at=${pageLoadedAt}`)
  }

  app.post('/api/governance/onboarding/apply', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const role = String(body.role || '')
    const consent_hash = String(body.consent_hash || '')
    const passkey_sig = body.passkey_sig ? String(body.passkey_sig) : null
    const iron_rule_method = String(body.iron_rule_method || 'passkey')
    const page_loaded_at = Number(body.page_loaded_at || 0)

    if (role !== 'arbitrator' && role !== 'verifier') {
      return void errorRes(res, 400, 'INVALID_ROLE', "role 必须是 'arbitrator' 或 'verifier'")
    }

    if (!consent_hash || consent_hash.length < 16) {
      return void errorRes(res, 400, 'MISSING_CONSENT', 'consent_hash 缺失或长度不足')
    }

    // 2026-06-02 #1094 audit fix:wire governance_onboarding.consent_delay_seconds(此前硬编码 8s)
    const delaySec = Number(getProtocolParam<number>('governance_onboarding.consent_delay_seconds', 8))
    const minDelayMs = delaySec * 1000
    if (page_loaded_at === 0) {
      return void errorRes(res, 400, 'MISSING_PAGE_LOADED_AT', 'page_loaded_at 缺失(反诱导校验)')
    }
    const elapsedMs = Date.now() - page_loaded_at
    if (elapsedMs < minDelayMs) {
      const waitSec = Math.ceil((minDelayMs - elapsedMs) / 1000)
      return void errorRes(res, 400, 'ANTI_INDUCTION_DELAY', `必须等待 ${waitSec}s 后才能提交(反诱导)`)
    }

    // PR #22 review fix P1-2:校验 consent_hash 内容(防"任意 16 字符过关")
    // server 用 disclosure_version + role + userId + page_loaded_at 重建,与 client 提交比对
    const expected = expectedConsentHash(role, userId, page_loaded_at)
    if (consent_hash !== expected) {
      return void errorRes(res, 400, 'INVALID_CONSENT_HASH', `consent_hash 不匹配当前披露文本(version=${GOVERNANCE_APPLY_DISCLOSURE_VERSION},检查 client / server 版本同步)`)
    }

    // PR #22 review fix P1-1:真验 Passkey 签发(spec §3.1 Iron-Rule 反诱导真人门)
    // 调 consumeGateToken 消费 webauthn_gate_tokens 表中的 token
    const hpEnabled = Number(getProtocolParam<number>('require_human_presence_for_governance_apply', 1)) === 1
    if (hpEnabled) {
      if (!passkey_sig) {
        return void errorRes(res, 401, 'PASSKEY_REQUIRED', '需 Passkey 签发(Iron-Rule 真人门)')
      }
      const validate = (data: unknown): boolean => {
        // purpose_data 来自 frontend 的 requestPasskeyGate('governance_apply', { role, consent_hash })
        if (!data || typeof data !== 'object') return false
        const d = data as Record<string, unknown>
        return d.role === role && d.consent_hash === consent_hash
      }
      const result = consumeGateToken(userId, passkey_sig, 'governance_apply', validate)
      if (!result.ok) {
        return void errorRes(res, 401, 'PASSKEY_INVALID', `Passkey 验证失败: ${result.reason || '未知'}`)
      }
    }

    const existing = await dbOne<{ id: string; status: string; cooldown_until: number | null }>(`
      SELECT id, status, cooldown_until FROM governance_applications
      WHERE user_id = ? AND role = ? AND status IN ('pending_onboarding', 'active', 'cooldown')
      ORDER BY created_at DESC LIMIT 1
    `, [userId, role])

    if (existing) {
      if (existing.status === 'active') {
        return void errorRes(res, 409, 'ALREADY_ACTIVE', `你已是 ${role},无需重复申请`)
      }
      if (existing.status === 'pending_onboarding') {
        return void errorRes(res, 409, 'PENDING_EXISTS', `已有 ${role} 申请待审(${existing.id})`)
      }
      if (existing.status === 'cooldown' && existing.cooldown_until) {
        const now = Math.floor(Date.now() / 1000)
        if (existing.cooldown_until > now) {
          const cooldownDate = new Date(existing.cooldown_until * 1000).toISOString().slice(0, 10)
          return void errorRes(res, 409, 'IN_COOLDOWN', `卸任冷却期未结束,${cooldownDate} 后可重新申请`)
        }
      }
    }

    const elig = role === 'arbitrator'
      ? checkArbitratorEligibility(userId)
      : checkVerifierEligibility(userId)

    if (!elig.eligible) {
      const missing = elig.items.filter(i => !i.ok).map(i => i.key)
      return void res.status(400).json({
        error: '门槛未达标',
        code: 'NOT_ELIGIBLE',
        missing_requirements: missing,
        eligibility: elig,
      })
    }

    const id = generateId('gapp')
    const ip = String(req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown').split(',')[0].trim()
    const ua = String(req.headers['user-agent'] || 'unknown')

    await dbRun(`
      INSERT INTO governance_applications
        (id, user_id, role, action, status, consent_hash, passkey_sig, iron_rule_method, ip_hash, ua_hash)
      VALUES (?, ?, ?, 'apply', 'pending_onboarding', ?, ?, ?, ?, ?)
    `, [id, userId, role, consent_hash, passkey_sig, iron_rule_method, sha256_16(ip), sha256_16(ua)])

    res.json({
      success: true,
      application_id: id,
      status: 'pending_onboarding',
      next_step: 'onboarding_learning',
      note: 'Maintainer 将 review 你的申请。下一步:完成 onboarding 学习 + 案例分析 + 题目(本阶段未上线)',
    })
  })

  app.get('/api/governance/onboarding/my', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string

    const items = await dbAll(`
      SELECT id, role, action, status, quiz_score, quiz_passed_at, cooldown_until, appeal_reason, appeal_resolution, created_at
      FROM governance_applications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId])

    res.json({ items, count: items.length })
  })

  // GET /api/governance/onboarding/quiz?role=arbitrator|verifier
  // 返回题库(已剥离 correct_answer 防泄题)
  // 实施 docs/GOVERNANCE-ONBOARDING.md §4.3 题目
  app.get('/api/governance/onboarding/quiz', (req, res) => {
    const user = auth(req, res); if (!user) return
    const role = String(req.query.role || '')
    if (role !== 'arbitrator' && role !== 'verifier') {
      return void errorRes(res, 400, 'INVALID_ROLE', "role 必须是 'arbitrator' 或 'verifier'")
    }
    const questions = getQuestionsForRole(role)
    res.json({ role, total: questions.length, questions })
  })

  // POST /api/governance/onboarding/quiz-submit
  // 提交题目答案 → server-side scoring → 写 governance_applications.quiz_score
  // body: { role, answers: [{question_id, answer}] }
  app.post('/api/governance/onboarding/quiz-submit', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const role = String(body.role || '')
    const answers = Array.isArray(body.answers) ? body.answers as QuizAnswerInput[] : []

    if (role !== 'arbitrator' && role !== 'verifier') {
      return void errorRes(res, 400, 'INVALID_ROLE', "role 必须是 'arbitrator' 或 'verifier'")
    }
    if (answers.length === 0) {
      return void errorRes(res, 400, 'MISSING_ANSWERS', 'answers 数组为空')
    }

    // 找用户的最新 pending_onboarding application(必须先 apply 才能提交 quiz)
    const app_ = await dbOne<{ id: string; status: string }>(`
      SELECT id, status FROM governance_applications
      WHERE user_id = ? AND role = ? AND status = 'pending_onboarding'
      ORDER BY created_at DESC LIMIT 1
    `, [userId, role])

    if (!app_) {
      return void errorRes(res, 404, 'NO_PENDING_APPLICATION', `未找到 ${role} 待审申请,请先提交申请`)
    }

    // 读 quiz_pass_score(protocol_params,默认 80)
    const param = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = ?", ['governance_onboarding.quiz_pass_score'])
    const passThreshold = param ? Number(param.value) : 80

    // 评分
    const result = scoreQuiz(role, answers, passThreshold)

    // 更新 quiz_score(只在分数有提升时更新,允许重考)
    const existing = (await dbOne<{ quiz_score: number | null; quiz_passed_at: number | null }>("SELECT quiz_score, quiz_passed_at FROM governance_applications WHERE id = ?", [app_.id]))!
    const newScore = result.score_pct
    // Codex #234 P1:await 预读与写之间 maintainer 可能激活/解决该申请;所有写必须带
    // status='pending_onboarding' 守卫,否则会篡改已离开 pending 的 onboarding audit 证据。
    if (existing.quiz_score == null || newScore > existing.quiz_score) {
      const u = await dbRun("UPDATE governance_applications SET quiz_score = ? WHERE id = ? AND status = 'pending_onboarding'", [newScore, app_.id])
      if (u.changes === 0) return void errorRes(res, 409, 'APPLICATION_MOVED', '申请状态已变更(已被激活/解决),无法更新成绩')
    }

    // PR #22 review fix P1-3:quiz pass 推进环节状态(quiz_passed_at 时间戳)
    // 一旦合格,记录时间戳;后续不变(即便重考更低分,也不抹掉已合格状态)
    // quiz_passed_at IS NULL 守卫保证"只盖一次戳",叠加 status 守卫防离开 pending 后篡改
    if (result.passed && !existing.quiz_passed_at) {
      const now = Math.floor(Date.now() / 1000)
      await dbRun("UPDATE governance_applications SET quiz_passed_at = ? WHERE id = ? AND status = 'pending_onboarding' AND quiz_passed_at IS NULL", [now, app_.id])
    }

    res.json({
      success: true,
      application_id: app_.id,
      ...result,
      pass_threshold: passThreshold,
      quiz_passed_at: existing.quiz_passed_at || (result.passed ? Math.floor(Date.now() / 1000) : null),
      note: result.passed
        ? '题目合格,可等待 maintainer 激活(完成案例研读后)'
        : `分数 ${newScore}% < ${passThreshold}%,可重试`,
    })
  })

  // GET /api/governance/onboarding/cases?role=arbitrator|verifier
  // 返回案例库(剥离 expected_verdict + key_principles 防泄答案;maintainer 视角才看)
  // 实施 docs/GOVERNANCE-ONBOARDING.md §4.2 案例研读
  app.get('/api/governance/onboarding/cases', (req, res) => {
    const user = auth(req, res); if (!user) return
    const role = String(req.query.role || '')
    if (role !== 'arbitrator' && role !== 'verifier') {
      return void errorRes(res, 400, 'INVALID_ROLE', "role 必须是 'arbitrator' 或 'verifier'")
    }
    const cases = getCasesForRole(role)
    res.json({ role, total: cases.length, cases })
  })

  // POST /api/governance/onboarding/case-review
  // 提交全部案例 review(必须一次性提交所有案例,部分提交→ 400)
  // body: { role, reviews: [{case_id, chosen_verdict, reasoning}] }
  // 写 governance_applications.case_review_text(JSON string)
  // 不立即评分 — maintainer 上岗签字前(阶段 3 #1093)对比 expected_verdict
  app.post('/api/governance/onboarding/case-review', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const role = String(body.role || '')
    const reviews = Array.isArray(body.reviews) ? body.reviews as CaseReviewInput[] : []

    if (role !== 'arbitrator' && role !== 'verifier') {
      return void errorRes(res, 400, 'INVALID_ROLE', "role 必须是 'arbitrator' 或 'verifier'")
    }
    if (reviews.length === 0) {
      return void errorRes(res, 400, 'MISSING_REVIEWS', 'reviews 数组为空')
    }

    // 找用户的 pending_onboarding application
    const app_ = await dbOne<{ id: string; status: string }>(`
      SELECT id, status FROM governance_applications
      WHERE user_id = ? AND role = ? AND status = 'pending_onboarding'
      ORDER BY created_at DESC LIMIT 1
    `, [userId, role])

    if (!app_) {
      return void errorRes(res, 404, 'NO_PENDING_APPLICATION', `未找到 ${role} 待审申请,请先提交申请`)
    }

    // 结构校验:必须全部 case 都有 review + chosen_verdict 在选项内 + reasoning ≥ min_chars
    const validation = validateCaseReviews(role, reviews)
    if (!validation.ok) {
      return void res.status(400).json({
        error: '案例 review 不完整或格式错',
        code: 'INVALID_REVIEWS',
        errors: validation.errors,
      })
    }

    // 写 case_review_text(JSON 序列化,覆盖式 — 重新提交覆盖旧版本)
    const payload = {
      submitted_at: Math.floor(Date.now() / 1000),
      reviews: reviews.map(r => ({
        case_id: r.case_id,
        chosen_verdict: r.chosen_verdict,
        reasoning: r.reasoning.trim(),
      })),
    }
    // Codex #234 P1:status 守卫,防 await 后申请被激活/解决时仍篡改 case_review audit 证据
    const cu = await dbRun("UPDATE governance_applications SET case_review_text = ? WHERE id = ? AND status = 'pending_onboarding'", [JSON.stringify(payload), app_.id])
    if (cu.changes === 0) return void errorRes(res, 409, 'APPLICATION_MOVED', '申请状态已变更(已被激活/解决),无法提交案例 review')

    res.json({
      success: true,
      application_id: app_.id,
      submitted_count: reviews.length,
      note: '案例 review 已提交,maintainer 上岗签字前会对比 expected verdict 评估 reasoning',
    })
  })

  // ─── Admin (maintainer activation flow, #1093 阶段 3) ─────────
  // spec docs/GOVERNANCE-ONBOARDING.md §4.4

  // GET /api/admin/governance/applications — 列出 pending_onboarding(可筛 quiz_passed + has_case_review)
  app.get('/api/admin/governance/applications', async (req, res) => {
    const admin = requireGovernanceAdmin(req, res); if (!admin) return
    const items = await dbAll(`
      SELECT ga.id, ga.user_id, ga.role, ga.action, ga.status, ga.quiz_score, ga.quiz_passed_at,
             CASE WHEN ga.case_review_text IS NOT NULL THEN 1 ELSE 0 END AS has_case_review,
             ga.created_at,
             u.name AS user_name, u.handle, u.region, u.email
      FROM governance_applications ga
      JOIN users u ON u.id = ga.user_id
      WHERE ga.status = 'pending_onboarding' AND ga.action = 'apply'
      ORDER BY ga.created_at ASC
      LIMIT 100
    `)
    res.json({ items, count: items.length })
  })

  // GET /api/admin/governance/application/:id — 详情(含 expected_verdict 用于对比 — 仅 maintainer 看)
  app.get('/api/admin/governance/application/:id', async (req, res) => {
    const admin = requireGovernanceAdmin(req, res); if (!admin) return
    const id = req.params.id
    const row = await dbOne<Record<string, unknown>>(`
      SELECT ga.*, u.name AS user_name, u.handle, u.email
      FROM governance_applications ga
      JOIN users u ON u.id = ga.user_id
      WHERE ga.id = ?
    `, [id])
    if (!row) return void errorRes(res, 404, 'NOT_FOUND', 'application 不存在')

    const role = row.role as 'arbitrator' | 'verifier'
    const cases_with_expected = getCasesForMaintainer(role)
    let parsed_review = null
    try { parsed_review = row.case_review_text ? JSON.parse(row.case_review_text as string) : null } catch {}

    res.json({
      application: row,
      cases_with_expected,    // 含 expected_verdict + key_principles(只给 maintainer)
      parsed_review,          // 申请者提交的 reviews(JSON 解析)
    })
  })

  // POST /api/admin/governance/activate — 激活上岗
  // spec §4.4:
  //   1. 代码自动 re-gate(eligibility 真验,非人肉)
  //   2. quiz_passed_at IS NOT NULL + case_review_text IS NOT NULL 已完成 onboarding
  //   3. Iron-Rule Passkey ceremony(maintainer 真人签发)
  //   4. INSERT action='activate' row + users.roles 加 role
  //   5. logAdminAction 留痕
  // body: { application_id, webauthn_token, note? }
  app.post('/api/admin/governance/activate', async (req, res) => {
    const admin = requireGovernanceAdmin(req, res); if (!admin) return
    const adminId = admin.id as string
    const body = req.body || {}
    const application_id = String(body.application_id || '')
    const webauthn_token = body.webauthn_token ? String(body.webauthn_token) : undefined
    const note = body.note ? String(body.note).slice(0, 1000) : null

    if (!application_id) {
      return void errorRes(res, 400, 'MISSING_APPLICATION_ID', 'application_id 必填')
    }

    // 1. 找 pending application(predicate read,真 status check 在 transaction 内)
    const app_ = await dbOne<{ id: string; user_id: string; role: string; status: string; quiz_passed_at: number | null; case_review_text: string | null }>(`
      SELECT id, user_id, role, status, quiz_passed_at, case_review_text
      FROM governance_applications WHERE id = ?
    `, [application_id])
    if (!app_) return void errorRes(res, 404, 'NOT_FOUND', 'application 不存在')
    if (app_.status !== 'pending_onboarding') {
      return void errorRes(res, 409, 'WRONG_STATUS', `application status='${app_.status}',只能激活 pending_onboarding`)
    }

    // 2. 检查 onboarding 完成度(quiz + case review)
    if (!app_.quiz_passed_at) {
      return void errorRes(res, 400, 'QUIZ_NOT_PASSED', '申请者尚未通过 onboarding 题目')
    }
    if (!app_.case_review_text) {
      return void errorRes(res, 400, 'CASE_REVIEW_MISSING', '申请者尚未提交案例 review')
    }

    // 3. ⚠️ 代码自动 re-gate(spec §4.4 — 非人肉,maintainer phase A solo 时不能记错)
    const role = app_.role as 'arbitrator' | 'verifier'
    const elig = role === 'arbitrator'
      ? checkArbitratorEligibility(app_.user_id)
      : checkVerifierEligibility(app_.user_id)
    if (!elig.eligible) {
      const missing = elig.items.filter(i => !i.ok).map(i => i.key)
      return void res.status(400).json({
        error: '代码自动 re-gate 失败:eligibility 二次校验不通过',
        code: 'ELIGIBILITY_REGATE_FAILED',
        missing_requirements: missing,
        eligibility: elig,
        note: 'spec §4.4:申请通过 → 激活前自动二次调 eligibility,防 maintainer 漏检',
      })
    }

    // 4. Iron-Rule Passkey ceremony(maintainer 真人签发)
    const hpEnabled = Number(getProtocolParam<number>('require_human_presence_for_governance_activate', 1)) === 1
    if (hpEnabled) {
      if (!webauthn_token) {
        return void errorRes(res, 401, 'PASSKEY_REQUIRED', 'maintainer 激活需 Iron-Rule Passkey 签发')
      }
      const validate = (data: unknown): boolean => {
        if (!data || typeof data !== 'object') return false
        const d = data as Record<string, unknown>
        return d.application_id === application_id && d.target_user_id === app_.user_id
      }
      const result = consumeGateToken(adminId, webauthn_token, 'governance_activate', validate)
      if (!result.ok) {
        return void errorRes(res, 401, 'PASSKEY_INVALID', `maintainer Passkey 验证失败: ${result.reason || '未知'}`)
      }
    }

    // 5. 事务:conditional UPDATE 防竞态 + PR-C.2 仲裁授权 + INSERT activate row + 加 users.roles(仅治理记录,非 eligibility 源)
    // PR #25 self-review fix P1-1:status check 进 transaction(防 2 maintainer 同时激活 → 2 activate row)
    // PR #25 self-review fix P1-2:不存 note 到 appeal_resolution(语义错);maintainer note 由 logAdminAction(detail) 记
    // PR-C.2:role='arbitrator' 的 grantArbitratorTx 与状态翻转【同事务】—— 保证"governance active ⟺ whitelist active",
    //   grant 失败(revoked/非人类/无 Passkey)→ 抛 sentinel,整个激活回滚。verifier 角色走其自身白名单,不在此桥。
    const RACE_LOST = 'RACE_LOST_PENDING_TO_ACTIVE'
    const GRANT_ABORT = 'GRANT_ABORT'
    let grantErr: string | null = null
    try {
      db.transaction(() => {
        // 5.1 conditional UPDATE 原 apply row(只在 status='pending_onboarding' 时改 → 防竞态)
        const updated = db.prepare(
          "UPDATE governance_applications SET status = 'active' WHERE id = ? AND status = 'pending_onboarding'"
        ).run(app_.id)
        if (updated.changes !== 1) {
          // 另一 maintainer 已激活 → 抛出 sentinel,整个事务回滚
          throw new Error(RACE_LOST)
        }

        // 5.1b 仲裁授权与状态翻转同事务(唯一 runtime 授权源 = active arbitrator_whitelist)
        if (role === 'arbitrator') {
          const g = grantArbitratorTx(db, { userId: app_.user_id, grantedBy: adminId, note: 'governance onboarding 激活' })
          if (!g.ok) { grantErr = g.error_code || 'GRANT_FAILED'; throw new Error(GRANT_ABORT) }
        }

        // 5.2 INSERT 新 row(append-only audit trail,action='activate')
        const activateId = generateId('gapp')
        db.prepare(`
          INSERT INTO governance_applications
            (id, user_id, role, action, status, passkey_sig, iron_rule_method)
          VALUES (?, ?, ?, 'activate', 'active', ?, 'passkey')
        `).run(activateId, app_.user_id, role, webauthn_token || null)

        // 5.3 加 role 到 users.roles JSON 数组(去重)。
        //   仲裁员例外:仲裁资格 = active arbitrator_whitelist(5.1b 已同事务 grant,#209/#220),【不是角色】——
        //   写进 roles 会在角色切换 UI 造出可切换的"仲裁员"假身份(与买卖身份互斥感误导用户,梦想者1号被卡案根源之一)。
        //   普通人保留 buyer/seller 身份 + 白名单资格,仲裁台入口随 can_arbitrate 出现,买卖能力不受影响。
        const user = db.prepare("SELECT roles FROM users WHERE id = ?").get(app_.user_id) as { roles: string } | undefined
        let roles: string[] = []
        try { roles = JSON.parse(user?.roles || '[]') } catch { roles = [] }
        if (role !== 'arbitrator' && !roles.includes(role)) {
          roles.push(role)
          db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(JSON.stringify(roles), app_.user_id)
        }
      })()
    } catch (e) {
      if ((e as Error).message === RACE_LOST) {
        return void errorRes(res, 409, 'ALREADY_ACTIVATED', '该 application 已被其他 maintainer 激活(竞态)')
      }
      if ((e as Error).message === GRANT_ABORT) {   // PR-C.2:仲裁授权失败 → 整个激活已回滚
        logAdminAction(adminId, 'governance_activate', 'user', app_.user_id, { ok: false, role, error_code: grantErr })
        return void errorRes(res, 409, grantErr || 'GRANT_FAILED', '激活失败:无法授予仲裁员资格(见 error_code),激活已回滚')
      }
      throw e  // 真实 SQL error → re-throw 给 express error handler
    }

    // 6. admin 审计 log(maintainer note 存 detail JSON,非 governance_applications 字段)
    logAdminAction(adminId, 'governance_activate', 'user', app_.user_id, { role, application_id, note })

    // 7. 通知 user(站内)
    try {
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`,
        [generateId('ntf'), app_.user_id, 'governance',
          `🎉 你的 ${role} 申请已通过`,
          `你已正式上岗 ${role}。本通知由 maintainer ${adminId} 签发。详 #me 治理面板。`,
          null])
    } catch (_e) { /* notification 失败不阻塞 activate */ }

    res.json({
      success: true,
      application_id,
      role,
      target_user_id: app_.user_id,
      note: 'maintainer 激活成功,user.roles 已加 ' + role,
    })
  })

  // ─── 阶段 4:resign(主动卸任)+ appeal(自动卸任后申诉)──────
  // spec docs/GOVERNANCE-ONBOARDING.md §6.1 §7.2

  // POST /api/governance/onboarding/resign — 主动卸任
  // body: { role, confirm_text, webauthn_token }
  // confirm_text 必须等于 'RESIGN arbitrator' 或 'RESIGN verifier'(type-to-confirm 防误触)
  app.post('/api/governance/onboarding/resign', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const role = String(body.role || '')
    const confirm_text = String(body.confirm_text || '')
    const webauthn_token = body.webauthn_token ? String(body.webauthn_token) : undefined

    if (role !== 'arbitrator' && role !== 'verifier') {
      return void errorRes(res, 400, 'INVALID_ROLE', "role 必须是 'arbitrator' 或 'verifier'")
    }
    const expectedConfirm = `RESIGN ${role}`
    if (confirm_text !== expectedConfirm) {
      return void errorRes(res, 400, 'CONFIRM_MISMATCH', `请准确输入 "${expectedConfirm}" 确认卸任(type-to-confirm 防误触)`)
    }

    // 真源判定:users.roles JSON 包含该 role(防 1 user 多 active 行 / 防 active 行存量不一致)
    const userRow = await dbOne<{ roles: string | null }>("SELECT roles FROM users WHERE id = ?", [userId])
    let currentRoles: string[] = []
    try { currentRoles = JSON.parse(userRow?.roles || '[]') } catch { currentRoles = [] }
    // #249-P2:activate 已不再把 arbitrator 写进 users.roles(资格=白名单)→ 仲裁员的"当前在任"真源
    //   = active whitelist(或 legacy roles 残留,两者任一即可卸);verifier 真源仍 = users.roles。
    const wlActiveArb = role === 'arbitrator' && isActiveWhitelistArbitrator(db, userId)
    if (!currentRoles.includes(role) && !wlActiveArb) {
      return void errorRes(res, 404, 'NOT_ACTIVE', `你当前不是 ${role},无需卸任`)
    }
    // 用于日志显示 + 后续 INSERT 关联(取最新的 active 行;若没有也容许,以 user.roles 为准)
    const activeRow = await dbOne<{ id: string }>(`
      SELECT id FROM governance_applications
      WHERE user_id = ? AND role = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `, [userId, role])

    // active case 检查(spec §6.1:有未结案 → block,要求先 transfer/完成)
    // 只对 arbitrator 适用 — verifier 投票无长期 assigned
    if (role === 'arbitrator') {
      // disputes.assigned_arbitrators 是 JSON 数组;ruling_type IS NULL = 未结案
      const openCases = await dbAll<{ id: string }>(`
        SELECT id FROM disputes
        WHERE ruling_type IS NULL
          AND assigned_arbitrators IS NOT NULL
          AND assigned_arbitrators LIKE ?
      `, [`%"${userId}"%`])
      if (openCases.length > 0) {
        return void res.status(409).json({
          error: '尚有未结案 dispute',
          code: 'ACTIVE_CASES_EXIST',
          open_case_count: openCases.length,
          open_case_ids: openCases.slice(0, 10).map(c => c.id),
          note: 'spec §6.1:卸任前必须先完成所有 assigned dispute 或转交(暂未实现 transfer,先完成裁决)',
        })
      }
    }

    // Iron-Rule Passkey(spec §6.1 二次验证)
    const hpEnabled = Number(getProtocolParam<number>('require_human_presence_for_governance_resign', 1)) === 1
    if (hpEnabled) {
      if (!webauthn_token) {
        return void errorRes(res, 401, 'PASSKEY_REQUIRED', '卸任需 Passkey 签发(spec §6.1 二次验证)')
      }
      const validate = (data: unknown): boolean => {
        if (!data || typeof data !== 'object') return false
        const d = data as Record<string, unknown>
        return d.role === role && d.action === 'resign'
      }
      const result = consumeGateToken(userId, webauthn_token, 'governance_resign', validate)
      if (!result.ok) {
        return void errorRes(res, 401, 'PASSKEY_INVALID', `Passkey 验证失败: ${result.reason || '未知'}`)
      }
    }

    // 冷却参数(default 30 天)
    const cooldownDays = Number(getProtocolParam<number>('governance_resign_cooldown_days', 30))
    const cooldownUntil = Math.floor(Date.now() / 1000) + cooldownDays * 86400

    // 事务:conditional UPDATE users.roles(SoT) + UPDATE 所有 active row → inactive + INSERT resign
    // 真源 = users.roles JSON;先去其中的 role(若中途竞态被改→ 触发 RACE_LOST)
    const RACE_LOST = 'RACE_LOST_ROLE_NOT_PRESENT'
    let resignId: string
    try {
      resignId = generateId('gapp')
      db.transaction(() => {
        // 1. 重读真源(进事务后)。仲裁员=active whitelist(#249 起 activate 不写 roles;suspend=自愿卸任可经
        //    admin reinstate 复用,刻意不用终态 revoke);legacy roles 里的 'arbitrator' 存量一并摘除。verifier=users.roles。
        const u = db.prepare("SELECT roles FROM users WHERE id = ?").get(userId) as { roles: string | null } | undefined
        let roles: string[] = []
        try { roles = JSON.parse(u?.roles || '[]') } catch { roles = [] }
        const legacyInRoles = roles.includes(role)
        if (role === 'arbitrator') {
          const wlNow = isActiveWhitelistArbitrator(db, userId)
          if (!wlNow && !legacyInRoles) throw new Error(RACE_LOST)
          if (wlNow) { const m = suspendArbitrator(db, { userId, note: '主动卸任(governance resign)' }); if (!m.ok) throw new Error(RACE_LOST) }
        } else if (!legacyInRoles) throw new Error(RACE_LOST)
        if (legacyInRoles) {
          roles = roles.filter(r => r !== role)
          db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(JSON.stringify(roles), userId)
        }

        // 2. 把所有该 user+role 的 active 行 → inactive(可能有 apply + activate 两行)
        db.prepare(
          "UPDATE governance_applications SET status = 'inactive' WHERE user_id = ? AND role = ? AND status = 'active'"
        ).run(userId, role)

        // 3. INSERT resign 行(append-only audit)
        db.prepare(`
          INSERT INTO governance_applications
            (id, user_id, role, action, status, passkey_sig, iron_rule_method, cooldown_until, source_application_id)
          VALUES (?, ?, ?, 'resign', 'cooldown', ?, 'passkey', ?, ?)
        `).run(resignId, userId, role, webauthn_token || null, cooldownUntil, activeRow?.id || null)
      })()
    } catch (e) {
      if ((e as Error).message === RACE_LOST) {
        return void errorRes(res, 409, 'CONCURRENT_STATE_CHANGE', '角色状态已变化(可能已被卸任),刷新后查看')
      }
      throw e
    }

    res.json({
      success: true,
      resign_application_id: resignId,
      role,
      cooldown_until: cooldownUntil,
      cooldown_days: cooldownDays,
      note: `卸任成功。${cooldownDays} 天内不能重新申请 ${role}(冷却期 spec §6.3)`,
    })
  })

  // POST /api/governance/onboarding/appeal — auto_deactivate 后申诉
  // body: { source_application_id, appeal_reason }
  // 必须:source 行 action='auto_deactivate' + window 内 + 未已 appeal + reason 长度
  app.post('/api/governance/onboarding/appeal', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string
    const body = req.body || {}
    const source_application_id = String(body.source_application_id || '')
    const appeal_reason = String(body.appeal_reason || '').trim()

    if (!source_application_id) {
      return void errorRes(res, 400, 'MISSING_SOURCE', 'source_application_id 必填(指向被申诉的 auto_deactivate 行)')
    }

    const minChars = Number(getProtocolParam<number>('governance_appeal_min_reason_chars', 100))
    if (appeal_reason.length < minChars) {
      return void errorRes(res, 400, 'REASON_TOO_SHORT', `申诉理由至少 ${minChars} 字符,当前 ${appeal_reason.length}`)
    }

    const source = await dbOne<{ id: string; user_id: string; role: string; action: string; status: string; created_at: number }>(`
      SELECT id, user_id, role, action, status, created_at
      FROM governance_applications WHERE id = ?
    `, [source_application_id])
    if (!source) return void errorRes(res, 404, 'SOURCE_NOT_FOUND', '原 application 不存在')
    if (source.user_id !== userId) return void errorRes(res, 403, 'NOT_OWNER', '不能为他人申诉')
    if (source.action !== 'auto_deactivate') {
      return void errorRes(res, 400, 'WRONG_SOURCE_ACTION', `只能对 auto_deactivate 行申诉,当前 action='${source.action}'`)
    }

    const windowDays = Number(getProtocolParam<number>('governance_appeal_window_days', 14))
    const now = Math.floor(Date.now() / 1000)
    if (now - source.created_at > windowDays * 86400) {
      return void errorRes(res, 400, 'APPEAL_WINDOW_EXPIRED', `申诉窗口已过期(${windowDays} 天内可申诉)`)
    }

    // 已 appeal 过?(防重复)
    const existing = await dbOne<{ id: string; status: string }>(`
      SELECT id, status FROM governance_applications
      WHERE source_application_id = ? AND action = 'appeal'
      ORDER BY created_at DESC LIMIT 1
    `, [source_application_id])
    if (existing) {
      return void errorRes(res, 409, 'APPEAL_EXISTS', `已对该 application 提交过申诉(id=${existing.id} status=${existing.status})`)
    }

    const id = generateId('gapp')
    await dbRun(`
      INSERT INTO governance_applications
        (id, user_id, role, action, status, appeal_reason, source_application_id)
      VALUES (?, ?, ?, 'appeal', 'pending_review', ?, ?)
    `, [id, userId, source.role, appeal_reason, source_application_id])

    res.json({
      success: true,
      appeal_application_id: id,
      status: 'pending_review',
      note: 'maintainer 群将多签 review(参 CHARTER §3.2)。phase A solo 阶段由 sole maintainer 单签裁决。',
    })
  })

  // GET /api/admin/governance/auto-deactivations — recent auto_deactivate audit
  // spec §6.2 公示触发原因(透明 — 元规则 #1)
  app.get('/api/admin/governance/auto-deactivations', async (req, res) => {
    const admin = requireGovernanceAdmin(req, res); if (!admin) return
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const items = await dbAll(`
      SELECT ga.id, ga.user_id, ga.role, ga.appeal_reason AS trigger_reason,
             ga.cooldown_until, ga.created_at,
             u.name AS user_name, u.handle,
             (SELECT id FROM governance_applications WHERE source_application_id = ga.id AND action = 'appeal' ORDER BY created_at DESC LIMIT 1) AS appeal_id,
             (SELECT status FROM governance_applications WHERE source_application_id = ga.id AND action = 'appeal' ORDER BY created_at DESC LIMIT 1) AS appeal_status
      FROM governance_applications ga
      JOIN users u ON u.id = ga.user_id
      WHERE ga.action = 'auto_deactivate'
      ORDER BY ga.created_at DESC
      LIMIT ?
    `, [limit])
    res.json({ items, count: items.length })
  })

  // GET /api/admin/governance/appeals — maintainer 看待裁决申诉
  app.get('/api/admin/governance/appeals', async (req, res) => {
    const admin = requireGovernanceAdmin(req, res); if (!admin) return
    const items = await dbAll(`
      SELECT ga.id, ga.user_id, ga.role, ga.appeal_reason, ga.source_application_id, ga.created_at,
             u.name AS user_name, u.handle, u.email,
             src.created_at AS auto_deactivate_at
      FROM governance_applications ga
      JOIN users u ON u.id = ga.user_id
      LEFT JOIN governance_applications src ON src.id = ga.source_application_id
      WHERE ga.action = 'appeal' AND ga.status = 'pending_review'
      ORDER BY ga.created_at ASC
      LIMIT 100
    `)
    res.json({ items, count: items.length })
  })

  // POST /api/admin/governance/resolve-appeal — maintainer 裁决申诉
  // body: { appeal_application_id, decision: 'accept' | 'reject', resolution_text, webauthn_token }
  // accept → 恢复 active(spec §7.2) ;reject → 维持 inactive,公开理由
  app.post('/api/admin/governance/resolve-appeal', async (req, res) => {
    const admin = requireGovernanceAdmin(req, res); if (!admin) return
    const adminId = admin.id as string
    const body = req.body || {}
    const appeal_application_id = String(body.appeal_application_id || '')
    const decision = String(body.decision || '')
    const resolution_text = String(body.resolution_text || '').trim()
    const webauthn_token = body.webauthn_token ? String(body.webauthn_token) : undefined

    if (!appeal_application_id) return void errorRes(res, 400, 'MISSING_APPEAL_ID', 'appeal_application_id 必填')
    if (decision !== 'accept' && decision !== 'reject') {
      return void errorRes(res, 400, 'INVALID_DECISION', "decision 必须是 'accept' 或 'reject'")
    }
    if (resolution_text.length < 30) {
      return void errorRes(res, 400, 'RESOLUTION_TOO_SHORT', '处置理由至少 30 字符(spec §7.2 公开理由)')
    }

    const appeal = await dbOne<{ id: string; user_id: string; role: string; action: string; status: string; source_application_id: string | null }>(`
      SELECT id, user_id, role, action, status, source_application_id
      FROM governance_applications WHERE id = ?
    `, [appeal_application_id])
    if (!appeal) return void errorRes(res, 404, 'NOT_FOUND', 'appeal 不存在')
    if (appeal.action !== 'appeal') return void errorRes(res, 400, 'NOT_APPEAL', `action='${appeal.action}',非 appeal 行`)
    if (appeal.status !== 'pending_review') return void errorRes(res, 409, 'ALREADY_RESOLVED', `appeal 已处置(status='${appeal.status}')`)

    // Iron-Rule Passkey(maintainer 决策需真人门)
    const hpEnabled = Number(getProtocolParam<number>('require_human_presence_for_governance_appeal_resolve', 1)) === 1
    if (hpEnabled) {
      if (!webauthn_token) return void errorRes(res, 401, 'PASSKEY_REQUIRED', 'maintainer 裁决申诉需 Passkey 签发')
      const validate = (data: unknown): boolean => {
        if (!data || typeof data !== 'object') return false
        const d = data as Record<string, unknown>
        return d.appeal_application_id === appeal_application_id && d.decision === decision
      }
      const result = consumeGateToken(adminId, webauthn_token, 'governance_appeal_resolve', validate)
      if (!result.ok) {
        return void errorRes(res, 401, 'PASSKEY_INVALID', `Passkey 验证失败: ${result.reason || '未知'}`)
      }
    }

    const RACE_LOST = 'RACE_LOST_APPEAL_RESOLVE'
    const newStatus = decision === 'accept' ? 'accepted' : 'rejected'
    try {
      db.transaction(() => {
        // conditional UPDATE appeal row(防双 maintainer 同时处置)
        const updated = db.prepare(
          "UPDATE governance_applications SET status = ?, appeal_resolution = ? WHERE id = ? AND status = 'pending_review'"
        ).run(newStatus, resolution_text, appeal_application_id)
        if (updated.changes !== 1) throw new Error(RACE_LOST)

        if (decision === 'accept') {
          // 恢复 active:新插 row + UPDATE 原 auto_deactivate 行的 cooldown_until 清空(允许立即恢复)
          // 同时 users.roles 加回 role
          const restoreId = generateId('gapp')
          db.prepare(`
            INSERT INTO governance_applications
              (id, user_id, role, action, status, source_application_id)
            VALUES (?, ?, ?, 'restore', 'active', ?)
          `).run(restoreId, appeal.user_id, appeal.role, appeal.source_application_id)

          const u = db.prepare("SELECT roles FROM users WHERE id = ?").get(appeal.user_id) as { roles: string } | undefined
          let roles: string[] = []
          try { roles = JSON.parse(u?.roles || '[]') } catch { roles = [] }
          if (!roles.includes(appeal.role)) {
            roles.push(appeal.role)
            db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(JSON.stringify(roles), appeal.user_id)
          }
        }
      })()
    } catch (e) {
      if ((e as Error).message === RACE_LOST) {
        return void errorRes(res, 409, 'CONCURRENT_RESOLUTION', 'appeal 已被其他 maintainer 处置(竞态)')
      }
      throw e
    }

    logAdminAction(adminId, 'governance_resolve_appeal', 'user', appeal.user_id, {
      role: appeal.role, appeal_id: appeal_application_id, decision, resolution_text,
    })

    // 通知 user
    try {
      const title = decision === 'accept'
        ? `✅ 你的 ${appeal.role} 申诉已通过`
        : `❌ 你的 ${appeal.role} 申诉被驳回`
      await dbRun(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`,
        [generateId('ntf'), appeal.user_id, 'governance', title, resolution_text, null])
    } catch (_e) { /* ignore */ }

    res.json({
      success: true,
      appeal_application_id,
      decision,
      new_status: newStatus,
      note: decision === 'accept' ? 'user.roles 已恢复 ' + appeal.role : '维持 inactive 状态',
    })
  })

  // GET /api/governance/onboarding/progress
  // 返回 onboarding 整体进度(spec §4):申请状态 + 学习包(client localStorage) + 题目分数 + 案例(后续)
  app.get('/api/governance/onboarding/progress', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const userId = user.id as string

    // 各 role 最新 application
    const applications = await dbAll<{
      id: string
      role: string
      action: string
      status: string
      quiz_score: number | null
      quiz_passed_at: number | null
      case_review_text: string | null
      cooldown_until: number | null
      created_at: number
    }>(`
      SELECT id, role, action, status, quiz_score, quiz_passed_at, case_review_text, cooldown_until, created_at
      FROM governance_applications
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [userId])

    const param = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = ?", ['governance_onboarding.quiz_pass_score'])
    const passThreshold = param ? Number(param.value) : 80

    res.json({
      applications,
      pass_threshold: passThreshold,
      disclosure_version: GOVERNANCE_APPLY_DISCLOSURE_VERSION,
    })
  })
}
