/**
 * Hot-wallet custody signer abstraction (Phase 0 of docs/HOT-WALLET-CUSTODY-MIGRATION.md).
 *
 * All USDC-custody key derivation / signing goes through this interface so the backend can later
 * swap the in-process seed signer for a KMS / multisig signer WITHOUT touching call sites (same
 * seam pattern as internal/pv-settlement.ts).
 *
 * Three signer ROLES (kept distinct so they can be split later):
 *   - hot:     the hot wallet — signs USDC withdrawals out + ETH gas-funding (executeWithdrawal,
 *              sweepToHotWallet). This is the key that must move to KMS first (Phase 1).
 *   - deposit: per-user deposit address — signs the USDC sweep from each deposit address → hot
 *              wallet. N keys today; eliminated by CREATE2 forwarders in Phase 3.
 *   - issuer:  off-chain passport / credential signing (signMessage). ⚠️ Today it shares the hot
 *              key (LocalSeedSigner below); pointing it at a dedicated key changes the issuer
 *              address and needs credential re-verification — Phase 0.5, NOT done here.
 *
 * Phase 0 ships only `createLocalSeedSigner`, which reproduces the historical
 * `HMAC-SHA256(masterSeed, role)` derivation EXACTLY — every address + signature is unchanged
 * (golden-vector tested in scripts/test-wallet-signer.ts). No behavior change.
 */
import type { Account } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { createHmac } from 'node:crypto'

export interface WalletSigner {
  /** Hot wallet account — USDC withdrawals out + ETH gas-funding. */
  hotAccount(): Account
  hotAddress(): `0x${string}`
  /** Per-user deposit address account — sweeps USDC → hot wallet. */
  depositAccount(userId: string): Account
  depositAddress(userId: string): `0x${string}`
  /** Off-chain issuer (passport / credential) signing. Signs via the issuer role; address below. */
  issuerSignMessage(message: string): Promise<`0x${string}`>
  issuerAddress(): `0x${string}`
  /**
   * USDC-escrow EIP-712 voucher signer (WebazEscrow `deposit` authorization). Its address is the
   * on-chain `authorizationSigner` (configured at contract deploy, B8/B9). A DISTINCT role — a leaked
   * voucher key can only mint deposit opportunities, never move funds already locked (contract invariant).
   * NEVER reuse the hot/issuer/deposit key here.
   */
  escrowVoucherAccount(): Account
  escrowVoucherAddress(): `0x${string}`
  /**
   * USDC-escrow ARBITER signer (WebazEscrow `arbiterResolve` / arbiter-side `flagDispute`). Its address
   * is the on-chain `arbiter` (configured at contract deploy, B9) — the ONLY key that can move funds out
   * of a Disputed escrow. A DISTINCT role — NEVER reuse the hot/issuer/voucher/deposit key. Contract gate:
   * a leaked arbiter key can only split an ALREADY-Disputed escrow (arbiterResolve reverts on any other
   * state), never touch Funded escrows and never mint deposits. Backend use is Passkey-gated (B7a).
   */
  arbiterAccount(): Account
  arbiterAddress(): `0x${string}`
}

/** Seed string for the hot-wallet role (also the issuer role today — see Phase 0.5). */
export const HOT_WALLET_SEED = 'platform-hot-wallet'

/** Seed string for the USDC-escrow voucher role (distinct — its address is the contract authorizationSigner). */
export const ESCROW_VOUCHER_SEED = 'usdc-escrow-voucher-signer'

/** Seed string for the USDC-escrow arbiter role (distinct — its address is the contract `arbiter`; moves funds on arbiterResolve). */
export const ESCROW_ARBITER_SEED = 'usdc-escrow-arbiter'

/**
 * In-process signer derived from a single master seed (current production behavior; dev/testnet).
 * `privKey(role) = 0x<HMAC-SHA256(masterSeed, role)>` — byte-for-byte identical to the legacy
 * `derivePrivKey` in server.ts, so addresses / signatures do not change.
 *
 * Phase 1+ will provide `createKmsSigner(...)` / `createSafeSigner(...)` implementing the same
 * interface, selected via the `HOT_WALLET_SIGNER` env var.
 */
export function createLocalSeedSigner(masterSeed: string): WalletSigner {
  const privKey = (role: string): `0x${string}` =>
    `0x${createHmac('sha256', masterSeed).update(role).digest('hex')}`
  // Issuer currently shares the hot-wallet key (unchanged address). Phase 0.5 points it at a
  // dedicated key + dual-key credential verification; do NOT change this seed before that.
  const ISSUER_SEED = HOT_WALLET_SEED
  return {
    hotAccount: () => privateKeyToAccount(privKey(HOT_WALLET_SEED)),
    hotAddress: () => privateKeyToAddress(privKey(HOT_WALLET_SEED)),
    depositAccount: (userId: string) => privateKeyToAccount(privKey(userId)),
    depositAddress: (userId: string) => privateKeyToAddress(privKey(userId)),
    issuerSignMessage: (message: string) => privateKeyToAccount(privKey(ISSUER_SEED)).signMessage({ message }),
    issuerAddress: () => privateKeyToAddress(privKey(ISSUER_SEED)),
    // Dedicated voucher role (independent seed) — never shares the hot/issuer/deposit key.
    escrowVoucherAccount: () => privateKeyToAccount(privKey(ESCROW_VOUCHER_SEED)),
    escrowVoucherAddress: () => privateKeyToAddress(privKey(ESCROW_VOUCHER_SEED)),
    // Dedicated arbiter role (independent seed) — never shares the hot/issuer/voucher/deposit key. Moves funds on arbiterResolve.
    arbiterAccount: () => privateKeyToAccount(privKey(ESCROW_ARBITER_SEED)),
    arbiterAddress: () => privateKeyToAddress(privKey(ESCROW_ARBITER_SEED)),
  }
}
