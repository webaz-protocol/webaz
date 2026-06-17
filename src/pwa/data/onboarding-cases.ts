/**
 * Governance Onboarding 案例库(spec §4.2)
 * task #1093 阶段 2b — arbitrator 5 案例 / verifier 3 案例
 *
 * **Status**: v1 draft(2026-06-02,user 后期 review 调整)
 *
 * 设计原则:
 *   - 脱敏 + 简化(phase A 不从真 disputes 表抽样,初版用编造案例;后续真用户出现后可补真案例)
 *   - 申请者写"我会怎么判 + 理由"(≥ 200 字,spec §4.2)
 *   - **不立即自动评分** — maintainer 在 §4.4 上岗签字前对比实际 expected_verdict,评估 reasoning 方向
 *   - expected_verdict 字段仅 maintainer 可见(server 端剥离)
 *   - key_principles 引用 spec(arbitration PLAYBOOK 案例 / META-RULES / framework §X)
 *
 * 覆盖范围:
 *   - arbitrator: 4 种 verdict(release_seller / refund_buyer / partial_refund / liability_split)+ Case 2 物流卡顿(资金流)
 *   - verifier: claim 真伪(pass / fail / no_fault)
 *
 * Phase B+ 升级方向(留 hook):
 *   - 真 disputes 表抽样脱敏 fixture
 *   - 给 maintainer review UI:对比申请者 review 与 expected_verdict + 给评语
 */

export interface CaseStudy {
  id: string                          // 'arb-1' / 'ver-1'
  role_filter: 'arbitrator' | 'verifier'
  scenario_zh: string                 // 简短场景描述
  scenario_en: string
  facts_zh: string[]                  // bullet list of 已知事实
  facts_en: string[]
  decision_options: Array<{           // 申请者可选 verdict
    key: string                       // 'release_seller' / 'refund_buyer' / 'pass' / 'fail' etc.
    text_zh: string
    text_en: string
  }>
  expected_verdict: string            // maintainer 视角"对"的 verdict key — 仅 maintainer 可见
  key_principles: string[]            // 引用 spec(列出考点)
  min_review_chars: number            // 申请者 review 文本最少字符数(默认 200)
}

export const ONBOARDING_CASES: CaseStudy[] = [
  // ── arbitrator 5 案例 ─────────────────────────────────────
  {
    id: 'arb-1',
    role_filter: 'arbitrator',
    scenario_zh: '卖家发货严重延迟,无任何物流证据',
    scenario_en: 'Seller severely delayed shipping with no logistics evidence',
    facts_zh: [
      '买家 2026-04-01 下单 100 WAZ 商品(标注 7 天内发货)',
      '截至 2026-05-15(超期 38 天),卖家未发货也未沟通',
      '买家提供:下单时的承诺截图 + 多次催促但卖家未回复',
      '卖家提供:无任何物流单 / 沟通记录 / 备货证明',
      '卖家 reputation 75(未达正常孵化阈值)',
    ],
    facts_en: [
      'Buyer ordered 100 WAZ product on 2026-04-01 (promised: ship within 7 days)',
      'As of 2026-05-15 (38 days overdue), seller has neither shipped nor communicated',
      'Buyer provides: order screenshot + multiple unreplied reminders',
      'Seller provides: no logistics doc / communication / inventory proof',
      'Seller reputation: 75 (below normal threshold)',
    ],
    decision_options: [
      { key: 'release_seller', text_zh: 'release_seller(放款给卖家)', text_en: 'release_seller (release to seller)' },
      { key: 'refund_buyer', text_zh: 'refund_buyer(全额退款给买家)', text_en: 'refund_buyer (full refund to buyer)' },
      { key: 'partial_refund', text_zh: 'partial_refund(部分退款)', text_en: 'partial_refund (partial refund)' },
      { key: 'liability_split', text_zh: 'liability_split(平摊)', text_en: 'liability_split (split liability)' },
    ],
    expected_verdict: 'refund_buyer',
    key_principles: [
      'ARBITRATION-PLAYBOOK 4 种 verdict 适用情境',
      'META-RULES #4 不撒谎(卖家承诺 + 无履约证据)',
      '举证责任在卖家(他承诺了发货)',
    ],
    min_review_chars: 200,
  },
  {
    id: 'arb-2',
    role_filter: 'arbitrator',
    scenario_zh: 'Case 2 物流卡顿:卖家发货,买家未收到,物流方失联',
    scenario_en: 'Case 2 logistics stuck: seller shipped, buyer never received, logistics gone',
    facts_zh: [
      '买家下单 200 WAZ 商品',
      '卖家提供:有效发货单 + 物流取件签名',
      '物流追踪显示"中转中"45 天无更新',
      '物流方联系不上(电话停机,后台账号下线)',
      '买家:未收到货,要求退款',
      '物流方 stake 余额 70 WAZ(< 200 WAZ 订单价)',
    ],
    facts_en: [
      'Buyer ordered 200 WAZ product',
      'Seller provides: valid shipping doc + logistics pickup signature',
      'Logistics tracking shows "in transit" for 45 days, no updates',
      'Logistics party unreachable (phone off, backend offline)',
      'Buyer: never received, demands refund',
      'Logistics stake balance: 70 WAZ (< 200 WAZ order value)',
    ],
    decision_options: [
      { key: 'release_seller', text_zh: 'release_seller', text_en: 'release_seller' },
      { key: 'refund_buyer', text_zh: 'refund_buyer + 物流 stake 优先赔买家 + protocol_reserve_pool 兜底', text_en: 'refund_buyer + logistics stake to buyer first + protocol_reserve_pool covers shortfall' },
      { key: 'partial_refund', text_zh: 'partial_refund 50/50', text_en: 'partial_refund 50/50' },
      { key: 'liability_split', text_zh: 'liability_split(卖家一半 / 物流方一半)', text_en: 'liability_split (half seller / half logistics)' },
    ],
    expected_verdict: 'refund_buyer',
    key_principles: [
      'ARBITRATION-PLAYBOOK Case 2 物流卡顿 — 卖家无过错应保护',
      'protocol_reserve_pool 来源 = ECONOMIC §3 ④a + 失效活动罚没',
      '资金流向:物流 stake 优先赔买家(不入 pool),pool 仅兜底差额',
      '物流方 debt_to_protocol 累计 → > 1000 WAZ 角色暂停',
    ],
    min_review_chars: 200,
  },
  {
    id: 'arb-3',
    role_filter: 'arbitrator',
    scenario_zh: '商品描述部分不符 — 主要功能 OK 但 minor 偏差',
    scenario_en: 'Product description partial mismatch — main feature OK but minor deviation',
    facts_zh: [
      '买家下单 50 WAZ 二手手机',
      '描述标注:"95 新,无明显划痕"',
      '买家收到后:功能完好,但侧面有 1 个 2cm 浅划痕',
      '买家提供:开箱照片(确实有划痕)+ 描述截图(承诺无划痕)',
      '卖家承认:"漏拍了那一面,无意误导"',
      '订单价低(50 WAZ),非贵重物品',
    ],
    facts_en: [
      'Buyer ordered 50 WAZ second-hand phone',
      'Description: "95% new, no visible scratches"',
      'Buyer received: functioning, but 2cm light scratch on side',
      'Buyer provides: unboxing photo (scratch exists) + description screenshot (promised no scratches)',
      'Seller acknowledges: "missed that side, no intent to mislead"',
      'Order value low (50 WAZ), not a high-value item',
    ],
    decision_options: [
      { key: 'release_seller', text_zh: 'release_seller(卖家承担轻微误差合理)', text_en: 'release_seller (acceptable minor deviation)' },
      { key: 'refund_buyer', text_zh: 'refund_buyer(全退)', text_en: 'refund_buyer (full refund)' },
      { key: 'partial_refund', text_zh: 'partial_refund(部分退款,5-15 WAZ 差异补偿)', text_en: 'partial_refund (5-15 WAZ compensation for deviation)' },
      { key: 'liability_split', text_zh: 'liability_split', text_en: 'liability_split' },
    ],
    expected_verdict: 'partial_refund',
    key_principles: [
      '描述不符但功能完好 → partial_refund(差异补偿)',
      'META-RULES #4 不撒谎 — 卖家描述有瑕疵但非恶意',
      '"无意误导"与"恶意欺诈"不同,处置不同',
      '比例:轻微偏差 5-15% 补偿,严重偏差 30-50%',
    ],
    min_review_chars: 200,
  },
  {
    id: 'arb-4',
    role_filter: 'arbitrator',
    scenario_zh: '双方各执一词 + 证据部分有效',
    scenario_en: 'Both parties insist + partial valid evidence on both sides',
    facts_zh: [
      '买家下单 80 WAZ 美妆产品',
      '买家:"收到时已开封,要求退款"提供开箱照(可见塑封破损)',
      '卖家:"快递可能粗暴搬运,我发货时是完好的"提供发货前完好照片',
      '物流方:无监控证据,无法判定途中是否破损',
      '双方都 reputation 良好(无前科)',
      '没有第三方目击或客观证据决定责任在哪',
    ],
    facts_en: [
      'Buyer ordered 80 WAZ cosmetics',
      'Buyer: "received already opened, demands refund" provides unboxing photo (visible seal damaged)',
      'Seller: "logistics may have mishandled, was intact when shipped" provides pre-ship intact photo',
      'Logistics: no surveillance evidence, cannot determine in-transit damage',
      'Both parties have good reputation (no prior incidents)',
      'No third-party witness or objective evidence to determine fault',
    ],
    decision_options: [
      { key: 'release_seller', text_zh: 'release_seller', text_en: 'release_seller' },
      { key: 'refund_buyer', text_zh: 'refund_buyer', text_en: 'refund_buyer' },
      { key: 'partial_refund', text_zh: 'partial_refund', text_en: 'partial_refund' },
      { key: 'liability_split', text_zh: 'liability_split(三方各承担一份)', text_en: 'liability_split (three-way split)' },
    ],
    expected_verdict: 'liability_split',
    key_principles: [
      '证据双方部分有效,无法 100% 归责 → liability_split',
      'META-RULES #5 不偏袒 — 凭证据均衡时不向任一方倾斜',
      '本案应考虑物流方分摊(stake)— 即便物流方无监控,procedural 上有责任',
      'split 比例可参 stake 余额 / reputation 算',
    ],
    min_review_chars: 200,
  },
  {
    id: 'arb-5',
    role_filter: 'arbitrator',
    scenario_zh: '买家恶意 dispute — 已退款后又申诉',
    scenario_en: 'Buyer malicious dispute — re-filing after already refunded',
    facts_zh: [
      '买家 2026-03 下单 120 WAZ 商品',
      '2026-04 因物流延迟自动退款(release_buyer)',
      '商品 2026-04-20 自动签收(买家未拒收)',
      '买家 2026-05 提 dispute:"我没收到货,要求再退一次"',
      '物流追踪:确认 4-20 签收(签名指纹匹配买家)',
      '买家 history:近 3 个月已 5 次类似 pattern dispute',
      '其他 4 次中 3 次被仲裁判 fault_buyer',
    ],
    facts_en: [
      'Buyer ordered 120 WAZ on 2026-03',
      'Auto-refunded 2026-04 due to logistics delay (release_buyer)',
      'Product auto-signed 2026-04-20 (buyer did not reject)',
      'Buyer 2026-05 raises dispute: "never received, demands re-refund"',
      'Logistics tracking confirms 4-20 signature (fingerprint matches buyer)',
      'Buyer history: 5 similar pattern disputes in last 3 months',
      'Of other 4, 3 ruled fault_buyer by arbitration',
    ],
    decision_options: [
      { key: 'release_seller', text_zh: 'release_seller + 标买家恶意 + 信誉惩罚', text_en: 'release_seller + mark buyer malicious + reputation penalty' },
      { key: 'refund_buyer', text_zh: 'refund_buyer', text_en: 'refund_buyer' },
      { key: 'partial_refund', text_zh: 'partial_refund', text_en: 'partial_refund' },
      { key: 'liability_split', text_zh: 'liability_split', text_en: 'liability_split' },
    ],
    expected_verdict: 'release_seller',
    key_principles: [
      '物流签收事实 + 买家 history pattern → 买家恶意',
      'META-RULES #6 不滥用 — 系统性 dispute 是滥用',
      '判决要标 buyer fault + reputation 惩罚(防再犯)',
      '与正常退款情境(arb-1)对比看:有签收事实 vs 无证据',
    ],
    min_review_chars: 200,
  },
  // ── verifier 3 案例 ──────────────────────────────────────
  {
    id: 'ver-1',
    role_filter: 'verifier',
    scenario_zh: 'claim_verify:卖家声称商品 origin "Made in Japan"',
    scenario_en: 'claim_verify: seller claims product origin "Made in Japan"',
    facts_zh: [
      '卖家上架商品标注 origin:"Made in Japan"',
      '买家发起 claim verify,提供事实证据:',
      '  - 收到的实物包装清晰印刷 "Made in China"',
      '  - 高清照片证实底面 sticker',
      '卖家未提供任何"Made in Japan"的进口证明 / 海关单',
      '其他 verifier 中 1 人投 fail,1 人投 pass,需第 3 票决定',
    ],
    facts_en: [
      'Seller listed product origin: "Made in Japan"',
      'Buyer raised claim verify with factual evidence:',
      '  - Physical product packaging clearly printed "Made in China"',
      '  - HD photo confirms bottom sticker',
      'Seller provided no proof of Japan origin (no import doc / customs)',
      'Other verifiers: 1 voted fail, 1 voted pass, needs 3rd vote to decide',
    ],
    decision_options: [
      { key: 'pass', text_zh: 'pass(claim 真实,Made in Japan)', text_en: 'pass (claim true, Made in Japan)' },
      { key: 'fail', text_zh: 'fail(claim 不实,实际 Made in China)', text_en: 'fail (claim false, actually Made in China)' },
      { key: 'no_fault', text_zh: 'no_fault(争议无法判定 / 中立)', text_en: 'no_fault (unable to determine / neutral)' },
    ],
    expected_verdict: 'fail',
    key_principles: [
      'verifier 投 pass/fail/no_fault 是对 claim 真伪的判定',
      '事实证据(物理实物 + 高清照片)> 卖家空口承诺',
      'META-RULES #4 不撒谎 — 描述事实必须真',
      '与 arbitrator 判 dispute 不同:verifier 只判 claim 真伪,不分配赔偿',
    ],
    min_review_chars: 200,
  },
  {
    id: 'ver-2',
    role_filter: 'verifier',
    scenario_zh: 'claim_verify:卖家声称 condition "全新",轻微 deviation',
    scenario_en: 'claim_verify: seller claims condition "brand new", minor deviation',
    facts_zh: [
      '卖家上架商品标注 condition:"全新,未拆封"',
      '买家收到后发现:外包装 完好,但内部商品有 1 个轻微指纹(可擦除)',
      '买家发起 claim verify',
      '卖家解释:"运输中可能 minor 接触,商品本身全新"',
      '事实判定:本质是新的(未使用),但 100% "未接触" claim 不成立',
    ],
    facts_en: [
      'Seller listed condition: "brand new, sealed"',
      'Buyer found: outer packaging intact, but inner product has 1 minor fingerprint (erasable)',
      'Buyer raises claim verify',
      'Seller explains: "minor contact during transit possible, item itself is new"',
      'Fact: essentially new (unused), but 100% "untouched" claim not perfect',
    ],
    decision_options: [
      { key: 'pass', text_zh: 'pass(本质全新)', text_en: 'pass (essentially new)' },
      { key: 'fail', text_zh: 'fail(claim 不准)', text_en: 'fail (claim inaccurate)' },
      { key: 'no_fault', text_zh: 'no_fault(轻微偏差非欺诈)', text_en: 'no_fault (minor deviation not fraud)' },
    ],
    expected_verdict: 'no_fault',
    key_principles: [
      '"全新"实质成立,但 100% 严格 claim 略偏差 — 不算 fail',
      'no_fault = 卖家无主观恶意 + 实质 claim 成立',
      '与 ver-1(本质事实不符)对比:此案是轻微 deviation',
      '过严判 fail 会让所有 minor 包装变化都"被欺诈"',
    ],
    min_review_chars: 200,
  },
  {
    id: 'ver-3',
    role_filter: 'verifier',
    scenario_zh: 'claim_verify:卖家声称 warranty 30 天,实际只给 7 天',
    scenario_en: 'claim_verify: seller claims 30-day warranty, only honors 7 days',
    facts_zh: [
      '卖家上架商品标注:warranty 30 天',
      '买家收到后产品在第 20 天损坏,联系卖家要保修',
      '卖家拒绝:"我的店铺政策实际只 7 天"',
      '买家提供:商品页 warranty 30 天截图',
      '卖家解释:"标错了,实际是 7 天"— 但商品页未改',
    ],
    facts_en: [
      'Seller listed: warranty 30 days',
      'Buyer\'s product broke on day 20, contacted seller for warranty',
      'Seller refuses: "my store policy is actually 7 days"',
      'Buyer provides: screenshot of 30-day warranty on product page',
      'Seller explains: "labeled wrong, actually 7 days" — but product page not updated',
    ],
    decision_options: [
      { key: 'pass', text_zh: 'pass(卖家解释合理)', text_en: 'pass (seller explanation reasonable)' },
      { key: 'fail', text_zh: 'fail(claim 不实,以商品页 30 天为准)', text_en: 'fail (claim false, product page 30 days is canonical)' },
      { key: 'no_fault', text_zh: 'no_fault(标错而非欺诈)', text_en: 'no_fault (labeling error, not fraud)' },
    ],
    expected_verdict: 'fail',
    key_principles: [
      '商品页明示的 claim 是承诺,事后说"标错"不成立',
      'META-RULES #4 不撒谎 — 公示=承诺,改了 ≠ 没承诺过',
      'META-RULES #2 代码即规则 — 公开数据是 canonical truth',
      '区别于 ver-2:此案 claim 与事实有实质 gap(30 vs 7),非 minor 偏差',
    ],
    min_review_chars: 200,
  },
]

// 给前端 GET:剥离 expected_verdict + key_principles(防泄答案,maintainer 视角才看)
export function getCasesForRole(role: 'arbitrator' | 'verifier'): Array<Omit<CaseStudy, 'expected_verdict' | 'key_principles'>> {
  return ONBOARDING_CASES
    .filter(c => c.role_filter === role)
    .map(({ expected_verdict: _expected_verdict, key_principles: _key_principles, ...rest }) => rest)
}

// 给 maintainer 看的完整数据(server 端用,validate review 时)
export function getCasesForMaintainer(role: 'arbitrator' | 'verifier'): CaseStudy[] {
  return ONBOARDING_CASES.filter(c => c.role_filter === role)
}

// 校验申请者提交的 case_review 结构
export interface CaseReviewInput {
  case_id: string
  chosen_verdict: string      // 申请者选择的 verdict key
  reasoning: string           // 申请者的理由(≥ min_review_chars)
}

export interface CaseReviewValidationResult {
  ok: boolean
  errors: Array<{ case_id: string; reason: string }>
}

export function validateCaseReviews(role: 'arbitrator' | 'verifier', reviews: CaseReviewInput[]): CaseReviewValidationResult {
  const cases = getCasesForMaintainer(role)
  const requiredIds = new Set(cases.map(c => c.id))
  const errors: Array<{ case_id: string; reason: string }> = []
  const submittedIds = new Set(reviews.map(r => r.case_id))

  // 检查未提交的 case
  for (const id of requiredIds) {
    if (!submittedIds.has(id)) {
      errors.push({ case_id: id, reason: '未提交 review' })
    }
  }

  // 检查每个 review
  for (const review of reviews) {
    const c = cases.find(c => c.id === review.case_id)
    if (!c) {
      errors.push({ case_id: review.case_id, reason: '案例 id 不存在或不属本 role' })
      continue
    }
    // chosen_verdict 必须是 decision_options 之一
    if (!c.decision_options.some(o => o.key === review.chosen_verdict)) {
      errors.push({ case_id: review.case_id, reason: `chosen_verdict='${review.chosen_verdict}' 不在选项内` })
    }
    // reasoning 长度
    const trimmed = (review.reasoning || '').trim()
    if (trimmed.length < c.min_review_chars) {
      errors.push({ case_id: review.case_id, reason: `reasoning 需 ≥ ${c.min_review_chars} 字符,当前 ${trimmed.length}` })
    }
  }

  return { ok: errors.length === 0, errors }
}
