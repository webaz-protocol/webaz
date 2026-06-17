/**
 * RFC-011 §⑤ 可验证索引 —— 一份"什么可验 + 怎么验"的总表(护照/锚/AP2/订单链散在四处,这里统一)。
 * 诚实分级(不可过度声明):
 *   - 护照 / 外部锚:公开可验(任何第三方离线 ecrecover / 验签),强。
 *   - AP2 Mandate:签名输出,可验。
 *   - 订单事件链:HMAC 是 actor 私钥 → 第三方【无法】验签;可验的是【哈希链连续性】(防篡改),且 party-gated。
 * 只【链接 + 说明】how-to,不嵌密钥(密钥 live 发布在 did.json / protocol-status issuers),doc=code 不漂移。
 */
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'

const BASE = 'https://webaz.xyz'

export function buildVerifiabilityIndex() {
  return {
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    note: 'RFC-011 §⑤. Each artifact lists what it proves, the scheme, how to verify, and its verifiability LEVEL — do not over-trust beyond the stated level. Issuer keys are published live (not embedded here): /.well-known/did.json + /.well-known/webaz-protocol.json#issuers.',
    levels: {
      public_signature: 'any third party verifies offline (ecrecover / sig-check) without calling WebAZ',
      public_endpoint: 'verifiable via a public WebAZ endpoint (no auth)',
      integrity_chain: 'tamper-evidence via a hash-chain (verify continuity); NOT a third-party-verifiable signature',
      party_gated: 'full data only to order parties; others get integrity, not contents',
    },
    artifacts: [
      {
        artifact: 'agent_passport',
        proves: 'an agent\'s custodian fingerprint + risk/engagement/behavior, signed by the WebAZ issuer key',
        scheme: 'eip191 (EIP-191 personal_sign)',
        level: 'public_signature',
        offline: true,
        how_to_verify: 'GET /api/me/agents/:apiKeyPrefix/passport → ecrecover(passport.canonical, passport.signature) == issuer address from /.well-known/did.json (CAIP-10) / /.well-known/webaz-protocol.json#issuers; check active_since/revoked_at window.',
        endpoint: `${BASE}/api/me/agents/:apiKeyPrefix/passport`,
        keys: `${BASE}/.well-known/did.json`,
      },
      {
        artifact: 'external_anchor',
        proves: 'a real-world item\'s ownership/authenticity anchor + independent verifier attestations',
        scheme: 'signature (server-verifiable)',
        level: 'public_endpoint',
        offline: false,
        how_to_verify: `GET ${BASE}/api/external-anchors/:id/verify-sig (public); cross-check verifier attestations via /api/external-anchors/:id.`,
        endpoint: `${BASE}/api/external-anchors/:id/verify-sig`,
      },
      {
        artifact: 'ap2_mandate',
        proves: 'a buyer\'s signed Intent/Cart/Payment Mandate (AP2) emitted alongside the webaz price/order format',
        scheme: 'AP2 signed mandate',
        level: 'public_signature',
        offline: true,
        how_to_verify: 'verify the AP2 mandate signature per the AP2 spec; emitted by webaz_verify_price + webaz_place_order (dual-output).',
        endpoint: 'returned inline by verify_price / place_order',
      },
      {
        artifact: 'order_event_chain',
        proves: 'the order/dispute transition history is append-only + tamper-evident (each event hash chains to the previous)',
        scheme: 'sha256 hash-chain (event_hash / prev_event_hash). NOTE: the per-event `signature` is an HMAC with the actor\'s api_key — NOT third-party verifiable; the verifiable property is the HASH-CHAIN continuity.',
        level: 'integrity_chain',
        offline: true,
        party_gated: true,
        how_to_verify: `For an order you are party to: GET ${BASE}/api/orders/:id/chain (returns chain + verification). Or stream events via ${BASE}/api/agent/events (§⑥): check each event\'s prev_event_hash == the previous event\'s event_hash. Continuity proves no insert/delete/reorder.`,
        endpoint: `${BASE}/api/orders/:id/chain`,
      },
    ],
  }
}
