/**
 * Governance Onboarding 题库(spec §4.3)
 * task #1093 阶段 2a — 10 多选题 + 5 短答题
 *
 * **Status**: v1 draft(2026-06-02 草稿,user 后期 review 调整)
 *
 * 4 个领域(per spec §4.3):
 *   - 元规则识别(违反哪条)
 *   - Iron-Rule 边界(哪些 action 必须 Passkey)
 *   - 4 种 dispute 结算路径(release_seller / partial_refund / liability_split / refund_buyer)
 *   - 反 outlier 机制(信誉惩罚原则)
 *
 * 合格线:80%(`protocol_params.governance_onboarding.quiz_pass_score`,默认 80)
 *
 * 评分逻辑:
 *   - 多选题:correct_answer 完全匹配 → 1 score
 *   - 短答题:phase A 简化 — text.length ≥ 50 chars 且非纯空白 → 1 score
 *           (phase B+ maintainer 人工评,可补充 case_review_text 字段)
 *   - 总分 = score_count / total_count(15 题)百分比
 */

export interface QuizQuestion {
  id: string                            // 'mcq-1' / 'short-1'
  type: 'multiple_choice' | 'short_answer'
  domain: 'meta-rules' | 'iron-rule' | 'dispute-verdict' | 'outlier' | 'governance'
  role_filter?: 'arbitrator' | 'verifier'  // 只对此 role 显示;未指定 = 通用
  question_zh: string
  question_en: string
  options?: Array<{ key: string; text_zh: string; text_en: string }>  // 仅 multi-choice
  correct_answer?: string               // 仅 multi-choice;option key e.g. 'B'
  min_chars?: number                    // 仅 short-answer,默认 50
}

export const ONBOARDING_QUIZ: QuizQuestion[] = [
  // ── 多选题 1-10 ────────────────────────────────────────────────
  {
    id: 'mcq-1',
    type: 'multiple_choice',
    domain: 'meta-rules',
    question_zh: 'maintainer 在 review PR 时,看到代码作者是创始人,因此放宽审核标准。这违反哪条元规则?',
    question_en: 'A maintainer relaxes review standards because the PR author is the founder. Which meta-rule does this violate?',
    options: [
      { key: 'A', text_zh: '#4 不撒谎', text_en: '#4 no lies' },
      { key: 'B', text_zh: '#5 不偏袒', text_en: '#5 no favoritism' },
      { key: 'C', text_zh: '#8 最小介入', text_en: '#8 minimal intervention' },
      { key: 'D', text_zh: '#10 参与者即 webazer', text_en: '#10 participants are webazers' },
    ],
    correct_answer: 'B',
  },
  {
    id: 'mcq-2',
    type: 'multiple_choice',
    domain: 'iron-rule',
    question_zh: '下列哪个 action 必须真人 Passkey 签发?(注:提现无金额门槛,任何金额都需 Passkey)',
    question_en: 'Which action must require real-human Passkey signature? (Note: withdrawal has no amount threshold for Passkey)',
    options: [
      { key: 'A', text_zh: '查看自己的订单', text_en: 'View own orders' },
      { key: 'B', text_zh: '卖家上架商品', text_en: 'Seller lists product' },
      { key: 'C', text_zh: '用户提现资金(任何金额)', text_en: 'User withdrawal (any amount)' },
      { key: 'D', text_zh: '评价商品', text_en: 'Rate a product' },
    ],
    correct_answer: 'C',
  },
  {
    id: 'mcq-3',
    type: 'multiple_choice',
    domain: 'dispute-verdict',
    role_filter: 'arbitrator',
    question_zh: '买家下单 100 WAZ 商品。卖家发货延迟 30 天且无任何物流证据。买家提 dispute。最合理 verdict?',
    question_en: 'Buyer ordered 100 WAZ product. Seller delayed shipping 30 days with no logistics evidence. Buyer raises dispute. Most reasonable verdict?',
    options: [
      { key: 'A', text_zh: 'release_seller(放款给卖家)', text_en: 'release_seller (release to seller)' },
      { key: 'B', text_zh: 'refund_buyer(全额退款给买家)', text_en: 'refund_buyer (full refund to buyer)' },
      { key: 'C', text_zh: 'partial_refund(部分退款)', text_en: 'partial_refund (partial refund)' },
      { key: 'D', text_zh: 'liability_split(平摊)', text_en: 'liability_split (split liability)' },
    ],
    correct_answer: 'B',
  },
  {
    id: 'mcq-4',
    type: 'multiple_choice',
    domain: 'outlier',
    question_zh: 'verifier A 投 pass(认定该 claim 为真),多数 verifier 投 fail。后续 maintainer 复核证实事实是 fail(claim 是假的)。verifier A 该:',
    question_en: 'Verifier A voted pass (claim is true); majority voted fail. Later maintainer review confirmed the fact was fail (claim was false). Verifier A should:',
    options: [
      { key: 'A', text_zh: '不处罚(投票自由)', text_en: 'No penalty (voting freedom)' },
      { key: 'B', text_zh: '信誉惩罚(偏离已查实事实,非偏离多数)', text_en: 'Reputation penalty (deviated from confirmed fact, not from majority)' },
      { key: 'C', text_zh: '永久禁言', text_en: 'Permanent ban' },
      { key: 'D', text_zh: '退还 stake 让他重投', text_en: 'Refund stake and re-vote' },
    ],
    correct_answer: 'B',
  },
  {
    id: 'mcq-5',
    type: 'multiple_choice',
    domain: 'iron-rule',
    question_zh: '下列哪个 不属于 Iron-Rule 真人 Passkey 路径(必须真人确认的 action)?',
    question_en: 'Which one is NOT among the Iron-Rule real-human Passkey paths (actions requiring real-human confirmation)?',
    options: [
      { key: 'A', text_zh: 'arbitrator 仲裁判决', text_en: 'Arbitrator verdict' },
      { key: 'B', text_zh: '用户提现资金(任何金额)', text_en: 'User withdrawal (any amount)' },
      { key: 'C', text_zh: '浏览公开商品列表', text_en: 'Browse public product list' },
      { key: 'D', text_zh: '删除自己的 Passkey', text_en: 'Delete own Passkey' },
    ],
    correct_answer: 'C',
  },
  {
    id: 'mcq-6',
    type: 'multiple_choice',
    domain: 'governance',
    question_zh: 'framework §3.1 / §3.2 说:二叉树位置是…',
    question_en: 'framework §3.1 / §3.2 says: binary-tree position is...',
    options: [
      { key: 'A', text_zh: '独立收益源(占位就有钱)', text_en: 'Independent income source (hold = earn)' },
      { key: 'B', text_zh: '关系层记录 + 估值层修饰参数(base 必须 > 0)', text_en: 'Relationship-layer record + valuation-layer modifier (base must be > 0)' },
      { key: 'C', text_zh: '与回报完全无关', text_en: 'Completely unrelated to rewards' },
      { key: 'D', text_zh: '仅 arbitrator 可用', text_en: 'Only arbitrators can use it' },
    ],
    correct_answer: 'B',
  },
  {
    id: 'mcq-7',
    type: 'multiple_choice',
    domain: 'governance',
    question_zh: '修改 fault 处置【规则】(属宪法级条款变动,见 CHARTER §4 I-4 — 不是普通协议改动)需要走?',
    question_en: 'Modifying fault-handling **rules** (a CONSTITUTIONAL clause change per CHARTER §4 I-4 — not a regular protocol change) requires?',
    options: [
      { key: 'A', text_zh: '普通 maintainer 1 签', text_en: 'Single maintainer signature' },
      { key: 'B', text_zh: 'user 个人否决', text_en: 'User personal veto' },
      { key: 'C', text_zh: '超级多数多签(2/3) + 60 天公示(宪法级,user 仅是多签一票)', text_en: 'Supermajority multisig (2/3) + 60d public notice (constitutional; user is just one signer)' },
      { key: 'D', text_zh: '任意 contributor 投票', text_en: 'Any contributor vote' },
    ],
    correct_answer: 'C',
  },
  {
    id: 'mcq-8',
    type: 'multiple_choice',
    domain: 'dispute-verdict',
    role_filter: 'arbitrator',
    question_zh: 'Case 2 物流卡顿:卖家提供发货单,买家未收到货,物流方失联 45 天。arbitrator 应:',
    question_en: 'Case 2 logistics stuck: seller has shipping doc, buyer never received, logistics gone 45 days. Arbitrator should:',
    options: [
      { key: 'A', text_zh: 'release_seller(卖家无过错)', text_en: 'release_seller (seller has no fault)' },
      { key: 'B', text_zh: 'refund_buyer + 物流 stake **优先赔买家**(不足部分由 protocol_reserve_pool 兜底差额)', text_en: 'refund_buyer + logistics stake **goes to buyer first** (shortfall covered by protocol_reserve_pool)' },
      { key: 'C', text_zh: 'partial_refund 50/50', text_en: 'partial_refund 50/50' },
      { key: 'D', text_zh: 'liability_split,卖家一半物流方一半', text_en: 'liability_split, half seller half logistics' },
    ],
    correct_answer: 'B',
  },
  {
    id: 'mcq-9',
    type: 'multiple_choice',
    domain: 'outlier',
    role_filter: 'arbitrator',
    question_zh: 'arbitrator A 最近 10 次 verdict 有 6 次被 maintainer 复核证实判错(count=6 ≥ 5 阈值, pct=60% ≥ 30% 阈值,双阈值均触发)。A 该:',
    question_en: 'Arbitrator A: 6 of last 10 verdicts confirmed-wrong by maintainer review (count=6 ≥ 5 threshold AND pct=60% ≥ 30% threshold, both triggered). A should:',
    options: [
      { key: 'A', text_zh: '不处罚,投票自由', text_en: 'No penalty, voting freedom' },
      { key: 'B', text_zh: '仅加 outlier 标记(信号,不触发 deactivate)', text_en: 'Only add outlier flag (signal, no deactivate)' },
      { key: 'C', text_zh: '触发 auto_deactivate(双阈值均满足 — ARBITRATION-PLAYBOOK §6.2)', text_en: 'Trigger auto_deactivate (both thresholds met — ARBITRATION-PLAYBOOK §6.2)' },
      { key: 'D', text_zh: '永久驱逐', text_en: 'Permanent ban' },
    ],
    correct_answer: 'C',
  },
  {
    id: 'mcq-10',
    type: 'multiple_choice',
    domain: 'governance',
    question_zh: 'arbitrator 对**具体某个仲裁案件**的 verdict 是否可被创始人 veto?',
    question_en: 'Can the founder veto an arbitrator\'s verdict on a specific individual case?',
    options: [
      { key: 'A', text_zh: '可,创始人是最终仲裁', text_en: 'Yes, founder is final arbiter' },
      { key: 'B', text_zh: '不可,verdict 归 arbitrator 集体,创始人无个案 veto(违 #5)', text_en: 'No, verdict belongs to arbitrator collective; founder has no per-case veto (violates #5)' },
      { key: 'C', text_zh: '仅大额案件可', text_en: 'Only large-value cases' },
      { key: 'D', text_zh: '仅 phase A 可', text_en: 'Only in phase A' },
    ],
    correct_answer: 'B',
  },
  // ── 短答题 1-5(phase A 简化评分:length >= 50 chars 且非纯空白) ─────
  {
    id: 'short-1',
    type: 'short_answer',
    domain: 'meta-rules',
    question_zh: '描述一个**违反 #5 不偏袒** 的具体场景(≥ 100 字)。例如:某 user 通过多签提交协议参数修改,maintainer 因为该 user 是早期贡献者而跳过 review。',
    question_en: 'Describe a concrete scenario of **violating #5 no-favoritism** (≥ 100 chars). E.g.: maintainer skips review of a protocol param change because the proposer is an early contributor.',
    min_chars: 100,
  },
  {
    id: 'short-2',
    type: 'short_answer',
    domain: 'iron-rule',
    question_zh: '列出 Iron-Rule 7 paths 中你能记住的 5 条(每条简短描述)。',
    question_en: 'List 5 of the Iron-Rule 7 paths you can remember (brief description each).',
    min_chars: 50,
  },
  {
    id: 'short-3',
    type: 'short_answer',
    domain: 'dispute-verdict',
    role_filter: 'arbitrator',
    question_zh: '解释 4 种 dispute verdict(release_seller / refund_buyer / partial_refund / liability_split)的适用场景。每种简短说一个例子。',
    question_en: 'Explain when to apply each of 4 dispute verdicts (release_seller / refund_buyer / partial_refund / liability_split) with one short example each.',
    min_chars: 100,
  },
  {
    id: 'short-4',
    type: 'short_answer',
    domain: 'governance',
    question_zh: '解释为什么 arbitrator 对个案 verdict 不能被任何个人(包括创始人)veto。引用 CHARTER §4 I-4 + 元规则 #5。',
    question_en: 'Explain why an arbitrator\'s per-case verdict cannot be vetoed by any individual (including founder). Reference CHARTER §4 I-4 + meta-rule #5.',
    min_chars: 100,
  },
  {
    id: 'short-5',
    type: 'short_answer',
    domain: 'outlier',
    role_filter: 'arbitrator',
    question_zh: '描述 outlier 标记(信号)vs auto_deactivate(触发)的区别。前者只标记,后者真触发 deactivate。引用 ARBITRATION-PLAYBOOK §6.1 / §6.2。',
    question_en: 'Describe the difference between outlier flag (signal) and auto_deactivate (trigger). The former is just a flag, the latter actually deactivates. Reference ARBITRATION-PLAYBOOK §6.1 / §6.2.',
    min_chars: 100,
  },
]

// 为前端 GET 端点准备:剥离 correct_answer + min_chars 限制(防泄题)
export function getQuestionsForRole(role: 'arbitrator' | 'verifier'): Array<Omit<QuizQuestion, 'correct_answer'>> {
  return ONBOARDING_QUIZ
    .filter(q => !q.role_filter || q.role_filter === role)
    .map(({ correct_answer: _correct_answer, ...rest }) => rest)
}

// 评分:输入 answers 数组,输出 score_pct + per-question result
export interface QuizAnswerInput {
  question_id: string
  answer: string                        // multi-choice = option key / short-answer = text
}

export interface QuizScoreResult {
  total: number
  correct: number
  score_pct: number
  passed: boolean                       // ≥ pass_threshold
  per_question: Array<{ id: string; ok: boolean; reason?: string }>
}

export function scoreQuiz(
  role: 'arbitrator' | 'verifier',
  answers: QuizAnswerInput[],
  passThreshold: number = 80,
): QuizScoreResult {
  const questions = ONBOARDING_QUIZ.filter(q => !q.role_filter || q.role_filter === role)
  const answerMap = new Map(answers.map(a => [a.question_id, a.answer]))

  const perQuestion: Array<{ id: string; ok: boolean; reason?: string }> = []
  let correct = 0

  for (const q of questions) {
    const userAnswer = answerMap.get(q.id) ?? ''

    if (q.type === 'multiple_choice') {
      const ok = userAnswer === q.correct_answer
      perQuestion.push({ id: q.id, ok })
      if (ok) correct++
    } else {
      // short-answer: phase A 简化 — length >= min_chars 且非纯空白 → ok
      const trimmed = userAnswer.trim()
      const minChars = q.min_chars ?? 50
      const ok = trimmed.length >= minChars
      perQuestion.push({
        id: q.id,
        ok,
        reason: ok ? undefined : `需要至少 ${minChars} 字符,当前 ${trimmed.length}`,
      })
      if (ok) correct++
    }
  }

  const total = questions.length
  const score_pct = total > 0 ? Math.round((correct / total) * 100) : 0
  const passed = score_pct >= passThreshold

  return { total, correct, score_pct, passed, per_question: perQuestion }
}
