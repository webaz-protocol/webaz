/**
 * OpenAI public-plugin catalog policy.
 *
 * This is a distribution adapter, not a WebAZ protocol rule. Missing or
 * malformed configuration exposes no products on shopping_v1.
 */
export const PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_ENV = 'WEBAZ_PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS'
export const PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_MAX = 200

const PRODUCT_ID_RE = /^prd_[A-Za-z0-9_-]{8,80}$/

export function readPublicCommerceAllowedProductIds(
  raw: unknown = process.env[PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_ENV],
): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const trimmed = raw.trim()
  let values: unknown
  if (trimmed.startsWith('[')) {
    try { values = JSON.parse(trimmed) } catch { return [] }
  } else {
    values = trimmed.split(',').map(value => value.trim()).filter(Boolean)
  }
  if (!Array.isArray(values) ||
    values.length > PUBLIC_COMMERCE_ALLOWED_PRODUCT_IDS_MAX ||
    !values.every(value =>
    typeof value === 'string' && PRODUCT_ID_RE.test(value))) return []
  return [...new Set(values)]
}

export function publicCommerceSqlFilter(
  alias = 'p',
  allowedIds: readonly string[] = readPublicCommerceAllowedProductIds(),
): { clause: string; params: string[] } {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias) || allowedIds.length === 0) {
    return { clause: '1 = 0', params: [] }
  }
  return {
    clause: `${alias}.product_type = 'retail'
      AND ${alias}.id IN (${allowedIds.map(() => '?').join(',')})`,
    params: [...allowedIds],
  }
}
