/**
 * AP2 Mandate 构造器 — 把 webaz 内部 verify_price / place_order 输出
 * 映射为 Google AP2 (Agent Payments Protocol) 的三类 Mandate 结构,
 * 与 webaz 原 schema 并存(不破坏现有客户端),让 AP2-aware 的 agent 可直接消费。
 *
 * AP2 三类 Mandate:
 *   IntentMandate  — 用户/agent "想买什么"(verify_price 锁价时签发)
 *   CartMandate    — agent 实际组装的购物车(place_order 成功时签发)
 *   PaymentMandate — 卖家应收金额(place_order 成功时签发,与 Cart 并发)
 *
 * 签名方案 = Phase 4 同款 eip191(hot wallet),signature 字段由调用方填充。
 * canonical 是用于签名的 JSON.stringify 输出(确定序列化、键序固定)。
 */

export type AgentRole = 'user' | 'agent' | 'merchant'

export interface BaseMandateInput {
  issuerDid: string             // 'did:web:webaz.xyz'
  issuerAddress: string         // 0x... (CAIP-10 eip155:8453)
  issuedAt?: string             // ISO；默认 now
  expiresAt?: string            // ISO；可选
}

export interface IntentMandateInput extends BaseMandateInput {
  principal: { role: AgentRole; id: string }   // 'usr_xxx' or 'agt_xxx'
  productId: string
  productName?: string
  quantity: number
  maxUnitPrice: number
  currency: string                              // 'WAZ'
  sessionToken: string                          // webaz price_session token
}

export interface CartMandateInput extends BaseMandateInput {
  principal: { role: AgentRole; id: string }
  orderId: string
  items: Array<{ sku: string; name: string; quantity: number; unit_price: number; line_total: number }>
  subtotal: number
  fees?: { insurance?: number; donation?: number; tax?: number }
  total: number
  currency: string
}

export interface PaymentMandateInput extends BaseMandateInput {
  payer: { role: AgentRole; id: string }
  payee: { role: 'merchant'; id: string; name?: string }
  amount: number
  currency: string
  paymentMethod: string                         // 'webaz_escrow' | 'usdc_base' | ...
  orderId: string
  escrowReleaseCondition?: string               // e.g. 'buyer_confirms_receipt'
}

export interface MandateOutput {
  canonical: string
  mandate: Record<string, unknown>
}

const AP2_VERSION = '1.0'
const AP2_SPEC = 'https://github.com/google-agentic-commerce/AP2'

function nowIso(): string { return new Date().toISOString() }

function canonical(obj: Record<string, unknown>): string {
  // 简单深排序后 JSON.stringify;够用于签名稳定性,不引入额外依赖。
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(sort)
    return Object.keys(v as object).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sort((v as Record<string, unknown>)[k])
      return acc
    }, {})
  }
  return JSON.stringify(sort(obj))
}

function baseProof(input: BaseMandateInput): Record<string, unknown> {
  return {
    type: 'EcdsaSecp256k1RecoverySignature2020',
    scheme: 'eip191',
    proofPurpose: 'assertionMethod',
    verificationMethod: `${input.issuerDid}#controller`,
    blockchainAccountId: `eip155:8453:${input.issuerAddress}`,
    created: input.issuedAt ?? nowIso(),
    signature: '',   // 调用方填充
  }
}

export function buildIntentMandate(input: IntentMandateInput): MandateOutput {
  const issuedAt = input.issuedAt ?? nowIso()
  const mandate: Record<string, unknown> = {
    '@context': ['https://www.w3.org/2018/credentials/v1', AP2_SPEC],
    type: ['VerifiableCredential', 'IntentMandate'],
    ap2_version: AP2_VERSION,
    issuer: input.issuerDid,
    issuedAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    principal: input.principal,
    intent: {
      action: 'purchase',
      target: { type: 'product', sku: input.productId, ...(input.productName ? { name: input.productName } : {}) },
      constraints: {
        max_unit_price: input.maxUnitPrice,
        quantity: input.quantity,
        max_total: input.maxUnitPrice * input.quantity,
        currency: input.currency,
      },
      session_token: input.sessionToken,
    },
    proof: baseProof({ ...input, issuedAt }),
  }
  // canonical 签名内容 = 除 proof.signature 外的全部字段
  const forSign = JSON.parse(JSON.stringify(mandate))
  ;(forSign.proof as Record<string, unknown>).signature = ''
  return { canonical: canonical(forSign), mandate }
}

export function buildCartMandate(input: CartMandateInput): MandateOutput {
  const issuedAt = input.issuedAt ?? nowIso()
  const mandate: Record<string, unknown> = {
    '@context': ['https://www.w3.org/2018/credentials/v1', AP2_SPEC],
    type: ['VerifiableCredential', 'CartMandate'],
    ap2_version: AP2_VERSION,
    issuer: input.issuerDid,
    issuedAt,
    principal: input.principal,
    cart: {
      order_id: input.orderId,
      items: input.items,
      subtotal: input.subtotal,
      ...(input.fees ? { fees: input.fees } : {}),
      total: input.total,
      currency: input.currency,
    },
    proof: baseProof({ ...input, issuedAt }),
  }
  const forSign = JSON.parse(JSON.stringify(mandate))
  ;(forSign.proof as Record<string, unknown>).signature = ''
  return { canonical: canonical(forSign), mandate }
}

export function buildPaymentMandate(input: PaymentMandateInput): MandateOutput {
  const issuedAt = input.issuedAt ?? nowIso()
  const mandate: Record<string, unknown> = {
    '@context': ['https://www.w3.org/2018/credentials/v1', AP2_SPEC],
    type: ['VerifiableCredential', 'PaymentMandate'],
    ap2_version: AP2_VERSION,
    issuer: input.issuerDid,
    issuedAt,
    payer: input.payer,
    payee: input.payee,
    payment: {
      amount: input.amount,
      currency: input.currency,
      method: input.paymentMethod,
      order_id: input.orderId,
      ...(input.escrowReleaseCondition ? { release_condition: input.escrowReleaseCondition } : {}),
    },
    proof: baseProof({ ...input, issuedAt }),
  }
  const forSign = JSON.parse(JSON.stringify(mandate))
  ;(forSign.proof as Record<string, unknown>).signature = ''
  return { canonical: canonical(forSign), mandate }
}

/** 把 build*Mandate 输出的 canonical 经 signFn 签名后,返回带 signature 的深 clone(不 mutate 入参) */
export async function signMandate(
  out: MandateOutput,
  signFn: (message: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const sig = await signFn(out.canonical)
  // P2-3:深 clone 后再塞 signature;入参 out.mandate 保持不变,防调用方持引用被旁路修改
  const signed = JSON.parse(JSON.stringify(out.mandate)) as Record<string, unknown>
  ;(signed.proof as Record<string, unknown>).signature = sig
  return signed
}
