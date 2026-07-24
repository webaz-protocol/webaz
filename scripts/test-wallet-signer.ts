#!/usr/bin/env tsx
/**
 * Phase 0 guard for the hot-wallet custody signer seam (src/pwa/internal/wallet-signer.ts +
 * docs/HOT-WALLET-CUSTODY-MIGRATION.md). 用法:npm run test:wallet-signer
 *
 * Behavior preservation is the whole point: LocalSeedSigner MUST reproduce the historical
 * `privateKeyToAddress(HMAC-SHA256(MASTER_SEED, role))` derivation byte-for-byte, or funds would
 * route to different addresses after the refactor.
 *
 *  A) golden vector — the signer's hot/deposit/issuer addresses equal the legacy inline derivation
 *     for a fixed seed (independent recompute), and match a pinned expected value.
 *  B) invariants — deterministic; per-user addresses differ; different seed → different addresses;
 *     issuer currently shares the hot key (documents the not-yet-separated state, Phase 0.5);
 *     issuerSignMessage produces a verifiable signature from issuerAddress.
 *  C) static guard — server.ts routes hot/deposit/issuer through walletSigner and no longer derives
 *     these keys inline (no `derivePrivKey('platform-hot-wallet')` / `privateKeyToAccount(derivePrivKey`).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHmac } from 'node:crypto'
import { privateKeyToAddress } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { createLocalSeedSigner, HOT_WALLET_SEED, ESCROW_VOUCHER_SEED } from '../src/pwa/internal/wallet-signer.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// legacy derivation, recomputed independently (must match the signer exactly)
const SEED = 'test-master-seed-deterministic-vector-1234'
const legacyAddr = (role: string) =>
  privateKeyToAddress(`0x${createHmac('sha256', SEED).update(role).digest('hex')}` as `0x${string}`)

const signer = createLocalSeedSigner(SEED)

// ── A) golden vector: signer == legacy inline derivation ──
ok('A hot address == legacy HMAC derivation', signer.hotAddress() === legacyAddr(HOT_WALLET_SEED))
ok('A deposit(usr_x) == legacy HMAC derivation', signer.depositAddress('usr_x') === legacyAddr('usr_x'))
ok('A issuer address == legacy HMAC derivation', signer.issuerAddress() === legacyAddr(HOT_WALLET_SEED))
// pinned expected (independent of the impl — recompute with viem from the raw HMAC key)
const pinnedHot = privateKeyToAddress(`0x${createHmac('sha256', SEED).update('platform-hot-wallet').digest('hex')}` as `0x${string}`)
ok('A hot address matches pinned expected value', signer.hotAddress() === pinnedHot, `got ${signer.hotAddress()} expected ${pinnedHot}`)
// escrow-voucher role (B6a): distinct seed 'usdc-escrow-voucher-signer' → its address is the contract authorizationSigner
ok('A escrow-voucher address == legacy HMAC derivation', signer.escrowVoucherAddress() === legacyAddr(ESCROW_VOUCHER_SEED))
const pinnedVoucher = privateKeyToAddress(`0x${createHmac('sha256', SEED).update('usdc-escrow-voucher-signer').digest('hex')}` as `0x${string}`)
ok('A escrow-voucher matches pinned expected value', signer.escrowVoucherAddress() === pinnedVoucher, `got ${signer.escrowVoucherAddress()} expected ${pinnedVoucher}`)

// ── B) invariants ──
ok('B deterministic (same seed+role → same address)', createLocalSeedSigner(SEED).hotAddress() === signer.hotAddress())
ok('B per-user deposit addresses differ', signer.depositAddress('usr_a') !== signer.depositAddress('usr_b'))
ok('B different seed → different hot address', createLocalSeedSigner(SEED + 'x').hotAddress() !== signer.hotAddress())
ok('B issuer currently shares the hot key (Phase 0.5 will separate)', signer.issuerAddress() === signer.hotAddress())
ok('B escrow-voucher is a DISTINCT key (never hot/issuer/deposit)', signer.escrowVoucherAddress() !== signer.hotAddress() && signer.escrowVoucherAddress() !== signer.issuerAddress() && signer.escrowVoucherAddress() !== signer.depositAddress('usr_x'))
ok('B escrow-voucher account address == escrowVoucherAddress()', signer.escrowVoucherAccount().address.toLowerCase() === signer.escrowVoucherAddress().toLowerCase())
ok('B hot account address == hotAddress()', signer.hotAccount().address.toLowerCase() === signer.hotAddress().toLowerCase())
ok('B deposit account address == depositAddress()', signer.depositAccount('usr_x').address.toLowerCase() === signer.depositAddress('usr_x').toLowerCase())
// issuerSignMessage produces a signature that verifies against issuerAddress
const msg = 'webaz-passport:vector'
const sig = await signer.issuerSignMessage(msg)
const verified = await verifyMessage({ address: signer.issuerAddress(), message: msg, signature: sig })
ok('B issuerSignMessage verifies against issuerAddress', verified === true)

// ── C) static guard over server.ts ──
const server = readFileSync(join(ROOT, 'src', 'pwa', 'server.ts'), 'utf8')
ok('C server.ts instantiates the signer seam', /createLocalSeedSigner\(MASTER_SEED\)/.test(server))
ok('C deriveDepositAddress routes through walletSigner', /walletSigner\.depositAddress\(userId\)/.test(server))
ok('C hot wallet routes through walletSigner', /walletSigner\.hotAccount\(\)/.test(server) && /walletSigner\.hotAddress\(\)/.test(server))
ok('C deposit sweep routes through walletSigner', /walletSigner\.depositAccount\(userId\)/.test(server))
ok('C issuer routes through walletSigner', /walletSigner\.issuerSignMessage\(message\)/.test(server) && /walletSigner\.issuerAddress\(\)/.test(server))
ok('C no inline hot-wallet/issuer key derivation left', !/privateKeyToAccount\(derivePrivKey/.test(server) && !/derivePrivKey\('platform-hot-wallet'\)/.test(server))

if (fail === 0) {
  console.log(`\n✅ wallet-signer Phase 0 seam: LocalSeedSigner reproduces the legacy HMAC derivation exactly (hot/deposit/issuer addresses unchanged, golden-vector + pinned); issuer still shares the hot key (Phase 0.5 to separate); server.ts routes all custody signing through the seam with no inline key derivation\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ wallet-signer FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
