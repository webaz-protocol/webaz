import type Database from 'better-sqlite3'

export interface BuyerAddressSnapshot {
  shippingAddress: string
  shipToRegion: string | null
  addressId: string | null
}

export type BuyerAddressResolution =
  | { ok: true; value: BuyerAddressSnapshot }
  | { ok: false; status: number; error: string; error_code: string }

type AddressRow = {
  id: string
  recipient: string
  phone: string | null
  region: string | null
  detail: string
  is_default?: number
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function formatBuyerAddress(row: AddressRow): string {
  return [row.region, row.detail, row.recipient, row.phone].map(v => str(v)).filter(Boolean).join(' · ')
}

export function syncAddressBookDefaultToLegacy(db: Database.Database, userId: string): void {
  const row = db.prepare('SELECT id, recipient, phone, region, detail, is_default FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1').get(userId) as AddressRow | undefined
  if (!row) {
    db.prepare("UPDATE users SET default_address_text = NULL, default_address_region = NULL, default_address_json = NULL, updated_at = datetime('now') WHERE id = ?").run(userId)
    return
  }
  const text = formatBuyerAddress(row)
  const json = JSON.stringify({ recipient_name: row.recipient, phone1: row.phone || '', country: row.region || '', state: '', city: '', line1: row.detail, line2: '', postal_code: '' })
  db.prepare("UPDATE users SET default_address_text = ?, default_address_region = ?, default_address_json = ?, updated_at = datetime('now') WHERE id = ?").run(text || null, row.region || null, json, userId)
}

export function resolveBuyerAddressSnapshot(
  db: Database.Database,
  buyerId: string,
  input: { addressId?: unknown; shippingAddress?: unknown; shipToRegion?: unknown },
): BuyerAddressResolution {
  const explicitRegion = str(input.shipToRegion)
  const addressId = str(input.addressId)

  if (addressId) {
    const row = db.prepare(`
      SELECT id, recipient, phone, region, detail, is_default
      FROM user_addresses
      WHERE id = ? AND user_id = ?
    `).get(addressId, buyerId) as AddressRow | undefined
    if (!row) return { ok: false, status: 404, error: '地址不存在或不属于当前买家', error_code: 'ADDRESS_NOT_FOUND' }
    const shippingAddress = formatBuyerAddress(row)
    if (!shippingAddress) return { ok: false, status: 400, error: '地址内容不完整', error_code: 'ADDRESS_INCOMPLETE' }
    return { ok: true, value: { shippingAddress, shipToRegion: explicitRegion || str(row.region) || null, addressId: row.id } }
  }

  const legacyText = str(input.shippingAddress)
  if (legacyText) return { ok: true, value: { shippingAddress: legacyText.slice(0, 240), shipToRegion: explicitRegion || null, addressId: null } }

  const def = db.prepare(`
    SELECT id, recipient, phone, region, detail, is_default
    FROM user_addresses
    WHERE user_id = ?
    ORDER BY is_default DESC, created_at DESC
    LIMIT 1
  `).get(buyerId) as AddressRow | undefined
  if (!def) {
    const legacy = db.prepare('SELECT default_address_text, default_address_region FROM users WHERE id = ?').get(buyerId) as { default_address_text: string | null; default_address_region: string | null } | undefined
    const text = str(legacy?.default_address_text)
    if (text) return { ok: true, value: { shippingAddress: text.slice(0, 240), shipToRegion: explicitRegion || str(legacy?.default_address_region) || null, addressId: null } }
    return { ok: false, status: 400, error: '请先添加收货地址', error_code: 'ADDRESS_REQUIRED' }
  }
  const shippingAddress = formatBuyerAddress(def)
  if (!shippingAddress) return { ok: false, status: 400, error: '默认地址内容不完整', error_code: 'ADDRESS_INCOMPLETE' }
  return { ok: true, value: { shippingAddress, shipToRegion: explicitRegion || str(def.region) || null, addressId: def.id } }
}
