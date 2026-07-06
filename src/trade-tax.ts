/**
 * 跨境税费/进口责任【声明+披露】层(S3)—— 卖家 seller-of-record 自我声明,平台【绝不计算/代收/代缴】。
 *
 * 定位纪律(调研结论,2026-07):非托管≠必然免平台义务。EU Art.14a "deemed supplier" 的免责是三肢连接测试
 *   (不设条款 且 不授权收款 且 不涉订单/配送),WebAZ 设条款+涉订单 → 极可能被认定;US CA/WA 型 "any-activity"
 *   测试里"传递要约/承诺+接单+上架"各自独立触发,与是否碰钱无关。故本层【只声明只披露】,不碰税款:
 *     - import_duty_terms(DDP/DDU):卖家声明谁承担进口关税/税(DDP=卖家已含于价;DDU=买家到境自付)。
 *     - tax_lines(仅 'included' 类):卖家声明"价内已含 X 税"(如 SG GST 9%)—— 纯信息披露,不改总额、不入钱路。
 *   刻意【不做】(不上假开关):'added' 类税进总额(钱路,单独 PR 门控真实需求)、自动税率、代收代缴(Rail 3+律师)。
 *   合规义务(即便非 deemed):EU 10 年 / UK 6 年交易留痕由 orders.trade_terms_snapshot 满足(S0 已冻结卖家/货/值/时地/单号)。
 *   跨境进高执法辖区(EU/UK 及 CA/WA 型州)的 deemed-supplier 姿态 → 由 S1 的 trade.platform_region_blocklist 治理门
 *   + 律师确认逐区放行(本层不自动放开)。详 docs/COMPLIANCE-CROSS-BORDER-TAX.INTERNAL.md。
 *
 * 层级:products.{import_duty_terms,tax_lines} ?? users.store_{import_duty_terms,tax_lines}(与接单/运费/可售同约定)。
 * 快照:S0 的 trade-terms declarations.{import_duty_terms,tax_lines} 已从这些列自动填充 —— 本模块只管写入校验+生效解析+披露。
 */
const REGION_RE = /^[A-Z0-9-]{2,8}$/

export type ImportDutyTerms = 'ddu' | 'ddp'
export interface TaxLineIncluded { region: string; label: string; rate_pct?: number; note?: string; kind: 'included' }

/** DDP/DDU 写入校验:null/空=清除(继承上层);'ddu'|'ddp' 合法。 */
export function validateImportDutyTerms(raw: unknown): { value: ImportDutyTerms | null } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null }
  if (raw === 'ddu' || raw === 'ddp') return { value: raw }
  return { error: "import_duty_terms 必须是 'ddu'(买家到境自付)或 'ddp'(卖家已含)或 null" }
}

/** 税费科目写入校验:S3 只收 'included'(价内已含,纯披露)。'added'(进总额)明确拒 —— 钱路未开,不上假开关。 */
export function validateTaxLines(raw: unknown): { value: string | null } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null }
  if (!Array.isArray(raw)) return { error: 'tax_lines 必须是数组或 null' }
  if (raw.length > 32) return { error: 'tax_lines 最多 32 条' }
  const out: TaxLineIncluded[] = []
  const seen = new Set<string>()
  for (const e of raw) {
    if (!e || typeof e !== 'object') return { error: 'tax_lines 每条须是对象' }
    const r = e as Record<string, unknown>
    if (r.kind !== undefined && r.kind !== 'included') {   // 省略 kind = 'included'(S3 唯一允许值);未来开 'added' 钱路时须显式,勿继承此静默默认
      return { error: r.kind === 'added' ? "'added' 税费(进总额)暂不支持 —— 平台不代收税;仅支持 'included'(价内已含,披露)" : "tax_lines.kind 仅支持 'included'" }
    }
    const region = r.region === '*' ? '*' : (typeof r.region === 'string' ? r.region.trim().toUpperCase() : '')
    if (region !== '*' && !REGION_RE.test(region)) return { error: `tax_lines 含非法 region:${String(r.region).slice(0, 12)}(2-8 位大写码或 *)` }
    if (seen.has(region)) return { error: `tax_lines region 重复:${region}` }
    seen.add(region)
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 40) : ''
    if (!label) return { error: `tax_lines 每条须有 label(≤40 字,如 GST / VAT)(${region})` }
    let rate_pct: number | undefined
    if (r.rate_pct !== undefined && r.rate_pct !== null) {
      if (typeof r.rate_pct !== 'number' && typeof r.rate_pct !== 'string') return { error: `tax_lines.rate_pct 必须是数字(${region})` }   // 审计:拒 Number(true)=1 类强转
      const n = Number(r.rate_pct)
      if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `tax_lines.rate_pct 必须是 0~100(${region})` }
      rate_pct = Math.round(n * 100) / 100
    }
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 80) : undefined
    out.push({ region, label, ...(rate_pct !== undefined ? { rate_pct } : {}), ...(note ? { note } : {}), kind: 'included' })
  }
  return { value: JSON.stringify(out) }
}

/** parse-don't-validate 读:坏 JSON/坏形状 → null。 */
export function parseTaxLines(raw: unknown): TaxLineIncluded[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const a = JSON.parse(raw)
    if (!Array.isArray(a)) return null
    return a.filter((e): e is TaxLineIncluded => !!e && typeof e === 'object' && typeof e.region === 'string' && typeof e.label === 'string')
  } catch { return null }
}

/** 生效 DDP/DDU:商品 ?? 店铺 ?? null(纯函数;product/store 值由调用方各自的 DB seam 取好传入 —— 消费方是 async seam 路由,不持 sync db)。 */
export function effectiveImportDutyTerms(productVal: string | null | undefined, storeVal: string | null | undefined): ImportDutyTerms | null {
  const norm = (x: unknown): ImportDutyTerms | null => (x === 'ddu' || x === 'ddp') ? x : null
  return norm(productVal) ?? norm(storeVal)
}

/** 生效税费科目:商品 ?? 店铺 ?? null。 */
export function effectiveTaxLines(productVal: string | null | undefined, storeVal: string | null | undefined): TaxLineIncluded[] | null {
  const own = parseTaxLines(productVal)
  if (own && own.length) return own
  const st = parseTaxLines(storeVal)
  return (st && st.length) ? st : null
}

/** 按目的区筛生效税费(精确 region → '*' 兜底,合并;披露用)。 */
export function taxLinesForRegion(lines: TaxLineIncluded[] | null, region: string | null): TaxLineIncluded[] {
  if (!lines) return []
  const r = (region || '').toUpperCase()
  return lines.filter(l => l.region === '*' || (r && l.region === r))
}
