/**
 * Direct Pay (Rail 1) — direct-receive ELIGIBILITY 纯谓词 (PR-4a)。
 * 设计稿 §6 / §10.3 入门门(Rev d/h,LOCKED):开通"直接收款"特权的【已锁定入门门】=
 *   ① 真人 KYC 通过  ② 制裁筛查已清(hard requirement)  ③ 账龄 ≥ 30 天  ④ base bond 已到位且 ≥ 该档要求额。
 *
 * 边界(刻意约束 —— 避免遗漏 / 越界 / 误放行):
 *  - 纯函数,无副作用,不写库,不动资金;只对【已核实的事实】下判定。本模块【不】执行 KYC / 制裁筛查 / 收 base bond,
 *    也【不】声称做了这些 —— 它只消费别处核实后的布尔事实。
 *  - FAIL-CLOSED:每个【正向事实】(KYC / 制裁 / 账龄 / bond)必须【显式满足】才算过;缺失/未确认
 *    (undefined / null / false / NaN / 负)→ 该项不过 + reason。绝不因数据缺失而意外通过(制裁/KYC 尤其)。
 *  - 只覆盖【入门门】。运行期断路器(dispute-rate / AML 暂停 = PR-5/6)与"未被吊销/暂停"的在册状态是【独立】关卡,
 *    由调用方另行 AND —— 本谓词不读、不判这些,只回答"给定要求额下是否满足入门门"。
 *  - 档位选择 + reputation 折扣(算出 requiredBaseBondUnits)= PR-5 / 4b 的事;本谓词把 requiredBaseBondUnits 当【输入】。
 *  - base bond 单位无关:baseBondLockedUnits 与 requiredBaseBondUnits 必须【同一单位】(WAZ 或 USDC/fiat 的 FIXED
 *    token 数,无 per-deposit FX —— Rev h),由调用方预归一;本谓词只比大小,不做任何货币换算。
 *  - 事实来源(由后续 slice 的 thin adapter 装配,均为只读):账龄 = users.created_at;
 *    KYC / 制裁 = KYC/筛查系统(尚未建);baseBondLocked = 4b 存款记录(尚未建)。在它们建好前,谓词对真实卖家天然 fail-closed。
 */
import type { Units } from './money.js'

/** 未通过原因(机器码;UI 4f 映射成双语 t())。 */
export type EligibilityReason =
  | 'KYC_NOT_VERIFIED'
  | 'SANCTIONS_NOT_CLEARED'
  | 'ACCOUNT_TOO_NEW'
  | 'BASE_BOND_INSUFFICIENT'

/** 已核实事实快照(由调用方装配)。全部 optional —— 缺失即按 fail-closed 处理。 */
export interface EligibilityFacts {
  kycVerified: boolean            // 真人/商户 KYC(KYB)已通过 —— 必须显式 true
  sanctionsCleared: boolean       // 制裁筛查已清(无命中)—— 必须显式 true(hard requirement)
  accountAgeDays: number          // 账龄(整天);来源 users.created_at(见 accountAgeDays())
  baseBondLockedUnits: Units      // 已锁定 base bond(与 required 同单位的整数 base-units)
  requiredBaseBondUnits: Units    // 该档(经 reputation 折扣后)要求的 base bond(上游 PR-5/4b 算出)
}

export interface EligibilityConfig { minAccountAgeDays: number }
/** §10.3 LOCKED 默认(治理可调:protocol_params 'direct_pay.min_account_age_days')。 */
export const DEFAULT_DIRECT_RECEIVE_ELIGIBILITY: EligibilityConfig = { minAccountAgeDays: 30 }

export interface EligibilityVerdict {
  eligible: boolean
  reasons: EligibilityReason[]
  /** 逐项是否通过(UI 清单用)。eligible ⇔ 四项全 true。 */
  checks: { kyc: boolean; sanctions: boolean; accountAge: boolean; baseBond: boolean }
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
/** 合法非负 base-units:整数 + 在安全整数范围内(对齐 money.ts assertUnits 的 finite+integer+|u|≤MAX_SAFE)。
 *  Units 是【整数】base-units(money.ts §21)—— 分数(如 500.5)不是合法 units,必须 fail-closed 拒绝。 */
const isNonNegUnits = (x: unknown): x is Units => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

/**
 * 入门门判定(纯、fail-closed、total)。eligible ⇔ 四项全过;返回【所有】未过项,便于 UI 显示完整清单。
 * 任何缺失/坏值都收敛到"不过 + reason",不抛错。
 */
export function evaluateDirectReceiveEligibility(
  facts: Partial<EligibilityFacts> | null | undefined,
  config: EligibilityConfig = DEFAULT_DIRECT_RECEIVE_ELIGIBILITY,
): EligibilityVerdict {
  const f = facts ?? {}
  const minAge = isFiniteNum(config?.minAccountAgeDays) && config.minAccountAgeDays >= 0
    ? config.minAccountAgeDays
    : DEFAULT_DIRECT_RECEIVE_ELIGIBILITY.minAccountAgeDays

  // 正向事实 —— 必须显式满足,否则 fail-closed
  const kyc = f.kycVerified === true
  const sanctions = f.sanctionsCleared === true
  const accountAge = isFiniteNum(f.accountAgeDays) && f.accountAgeDays >= minAge
  // base bond:两边都必须是合法非负整数 base-units(分数/非安全整数 → fail-closed);
  //   required 还必须【正】(spec:always some bond, never 0),否则无从对照 → insufficient。
  const baseBond = isNonNegUnits(f.requiredBaseBondUnits) && f.requiredBaseBondUnits > 0
    && isNonNegUnits(f.baseBondLockedUnits) && f.baseBondLockedUnits >= f.requiredBaseBondUnits

  const reasons: EligibilityReason[] = []
  if (!kyc) reasons.push('KYC_NOT_VERIFIED')
  if (!sanctions) reasons.push('SANCTIONS_NOT_CLEARED')
  if (!accountAge) reasons.push('ACCOUNT_TOO_NEW')
  if (!baseBond) reasons.push('BASE_BOND_INSUFFICIENT')

  return { eligible: reasons.length === 0, reasons, checks: { kyc, sanctions, accountAge, baseBond } }
}

/** 账龄(整天,floor)。纯:now 由调用方传入(便于测试/确定性)。无法解析/未来时间 → 0(fail-closed:视作最新账户)。 */
export function accountAgeDays(createdAtIso: string | null | undefined, nowIso: string): number {
  if (!createdAtIso) return 0
  const created = Date.parse(createdAtIso)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(created) || !Number.isFinite(now) || now < created) return 0
  return Math.floor((now - created) / 86_400_000)
}

// NOTE: minAccountAgeDays 的 protocol_params 装配(`direct_pay.min_account_age_days`,缺行回落 DEFAULT)+
//   KYC/制裁/base-bond 事实的 DB 装配 → 由 PR-4c 的 route adapter 提供;本模块刻意【保持纯】(不读库)。
