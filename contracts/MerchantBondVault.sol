// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * MerchantBondVault — v1 collateral-only (non-custodial merchant base-bond).
 *
 * ⚠️ PR1 SKELETON / REFERENCE ONLY. Not compiled in this repo (no Solidity toolchain yet),
 *    not deployed, not wired. Function bodies are stubs. This file fixes the v1 contract
 *    surface + invariants for later testnet implementation + EXTERNAL AUDIT.
 *    Source of truth: docs/modules/MERCHANT-BASE-BOND-DESIGN.INTERNAL.md (v1 candidate-locked).
 *
 * v1 locked invariants (DO NOT regress without governance re-decision):
 *  - Holds ONLY merchant collateral (whitelisted USDC). Buyer funds NEVER enter this contract.
 *  - NON-custodial: WebAZ has only rule-bound, signature/governance-gated powers; NO arbitrary drain.
 *  - IMMUTABLE: no upgrade / no proxy / no admin-drain function.
 *  - slash is GOVERNANCE-ONLY (multisig+timelock) in v1; no automatic/small-order slash.
 *  - slash proceeds can only go to the fixed `penaltyReserve` (changeable only by timelock/multisig).
 *  - withdraw needs seller signature + WebAZ WithdrawAuthorization (EIP-712); only to registeredBondWallet.
 *  - authorizationSigner is SEPARATE from any hot relayer; signer rotation only by governance.
 *  - Single flat threshold (base_bond_min_units); no exposure-tiered bond in v1.
 *  - Platform fee is OFF-CHAIN (backend AR). No fee logic in this contract — by design (see design doc §6/§10).
 */
interface IMerchantBondVault {
    // ── events (audit trail) ──
    event WalletRegistered(bytes32 indexed sellerId, address wallet);
    event WalletRotated(bytes32 indexed sellerId, address oldWallet, address newWallet);
    event CollateralDeposited(bytes32 indexed sellerId, address wallet, uint256 amount);
    event CollateralSlashed(bytes32 indexed sellerId, uint256 amount, address penaltyReserve);
    event CollateralWithdrawn(bytes32 indexed sellerId, address to, uint256 amount);
    event UnattributedCredited(bytes32 indexed sellerId, uint256 amount, bytes32 ref);
    event Paused(bytes4 flag, bool value);
    event SignerRotated(address oldSigner, address newSigner);

    // ── seller-initiated (gated) ──
    /// @notice Deposit collateral via internal transferFrom of the whitelisted USDC ONLY.
    ///         Direct ERC-20 transfer to this contract is NOT auto-credited (becomes unattributed inflow).
    function depositCollateral(bytes32 sellerId, uint256 amount) external;

    /// @notice Withdraw collateral to the seller's registeredBondWallet.
    ///         Requires seller signature + WebAZ WithdrawAuthorization (EIP-712):
    ///         consume nonce, amount<=authorized, destination==registeredBondWallet, !expired,
    ///         and post-withdraw collateral >= remaining authorized threshold.
    function sellerWithdrawCollateral(
        bytes32 sellerId,
        bytes calldata withdrawAuthorization, // EIP-712 signed by authorizationSigner
        bytes calldata sellerSignature
    ) external;

    /// @notice Rotate registeredBondWallet: seller signature + WebAZ authorization (nonce/expiry).
    function rotateBondWallet(
        bytes32 sellerId,
        address newWallet,
        bytes calldata rotateAuthorization,
        bytes calldata sellerSignature
    ) external;

    // ── governance-only (multisig + timelock) ──
    function slashCollateral(bytes32 sellerId, uint256 amount) external; // → fixed penaltyReserve ONLY
    function creditUnattributedCollateral(bytes32 sellerId, bytes32 ref, uint256 amount) external; // proven not-yet-credited
    function rescueNonWhitelistedToken(address token, address to, uint256 amount) external; // NEVER whitelisted USDC
    function setPaused(bytes4 flag, bool value) external; // depositsPaused/slashPaused/withdrawPaused/globalPaused
    function rotateAuthorizationSigner(address newSigner) external; // signer leak → pause + rotate

    // ── views ──
    function collateralOf(bytes32 sellerId) external view returns (uint256);
    function registeredBondWalletOf(bytes32 sellerId) external view returns (address);
    function penaltyReserve() external view returns (address);
}

/// @dev Skeleton. Real implementation + invariants tests + EXTERNAL AUDIT are required before any
///      mainnet/real-USDC deployment (design doc §9). All bodies revert in PR1.
abstract contract MerchantBondVaultSkeleton is IMerchantBondVault {
    string internal constant PR1 = "MerchantBondVault: PR1 skeleton, not implemented";
    function depositCollateral(bytes32, uint256) external virtual override { revert(PR1); }
    function sellerWithdrawCollateral(bytes32, bytes calldata, bytes calldata) external virtual override { revert(PR1); }
    function rotateBondWallet(bytes32, address, bytes calldata, bytes calldata) external virtual override { revert(PR1); }
    function slashCollateral(bytes32, uint256) external virtual override { revert(PR1); }
    function creditUnattributedCollateral(bytes32, bytes32, uint256) external virtual override { revert(PR1); }
    function rescueNonWhitelistedToken(address, address, uint256) external virtual override { revert(PR1); }
    function setPaused(bytes4, bool) external virtual override { revert(PR1); }
    function rotateAuthorizationSigner(address) external virtual override { revert(PR1); }
}
