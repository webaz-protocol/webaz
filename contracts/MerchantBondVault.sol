// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * MerchantBondVault — v1 collateral-only (non-custodial merchant base-bond).
 *
 * Source of truth: docs/modules/MERCHANT-BASE-BOND-DESIGN.INTERNAL.md (v1 candidate-locked).
 * Testnet/dev implementation. ⚠️ NO mainnet / NO real USDC until design §9 hard gate is met:
 *   legal opinion + EXTERNAL contract audit + Holden approval (all three). Claude/Codex do NOT
 *   substitute for an independent third-party audit.
 *
 * ── v1 LOCKED INVARIANTS (do not regress without governance re-decision) ──
 *  - Holds ONLY merchant collateral in ONE whitelisted USDC token. Buyer funds NEVER enter.
 *  - NON-custodial: governance/WebAZ have only rule-bound, signature/governance-gated powers.
 *    There is NO function that drains seller collateral to an arbitrary address.
 *  - IMMUTABLE: no upgrade, no proxy, no delegatecall, no selfdestruct, no admin-drain.
 *  - slash is GOVERNANCE-ONLY (multisig+timelock) in v1 — no automatic/small-order slash —
 *    AND is two-step with an on-chain cooling window + cancel (appeal) path (§5 backstop).
 *  - slash proceeds can ONLY go to the fixed `penaltyReserve` (no arbitrary recipient).
 *  - withdraw needs WebAZ EIP-712 authorization + seller signature; only to registeredBondWallet.
 *  - authorizationSigner is SEPARATE from any hot relayer; relayer has NO fund power; signer
 *    rotation only by governance.
 *  - Single flat threshold (baseBondMinUnits); no exposure-tiered bond in v1.
 *  - Platform fee is OFF-CHAIN (backend AR). NO fee logic here — by design (doc §6/§10).
 *
 * ── Conservation ──
 *  - totalCollateral == Σ collateral[sellerId] at all times.
 *  - usdcToken.balanceOf(this) >= totalCollateral at all times (excess = unattributed inflow).
 *  - slash/withdraw decrease collateral and transfer EXACTLY that amount out; never mints.
 *
 * NOTE (surface refinements vs the PR1 skeleton, flagged for Holden + external audit):
 *  - added registerBondWallet (first sellerId↔wallet binding; skeleton only had the event + rotate).
 *  - slashCollateral split into proposeSlash/executeSlash/cancelSlash to bake the §5 cooling/appeal
 *    window into the immutable contract itself (backstop, not relying solely on an external timelock).
 *  - added returnUnattributedInflow (the "退回" half of §4's unattributed handling) and
 *    setPenaltyReserve / 2-step governance transfer (operational safety; all governance-gated).
 */
contract MerchantBondVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── pause flag selectors (orthogonal; not part of the seller lifecycle) ──
    bytes4 public constant DEPOSITS_PAUSED = bytes4(keccak256("DEPOSITS_PAUSED"));
    bytes4 public constant SLASH_PAUSED = bytes4(keccak256("SLASH_PAUSED"));
    bytes4 public constant WITHDRAW_PAUSED = bytes4(keccak256("WITHDRAW_PAUSED"));
    bytes4 public constant GLOBAL_PAUSED = bytes4(keccak256("GLOBAL_PAUSED"));

    // ── EIP-712 typehashes ──
    bytes32 private constant REGISTER_TYPEHASH =
        keccak256("RegisterWallet(bytes32 sellerId,address wallet,uint256 nonce,uint256 authExpiresAt)");
    bytes32 private constant ROTATE_TYPEHASH = keccak256(
        "RotateWallet(bytes32 sellerId,address oldWallet,address newWallet,uint256 nonce,uint256 authExpiresAt)"
    );
    bytes32 private constant WITHDRAW_TYPEHASH = keccak256(
        "WithdrawCollateral(bytes32 sellerId,address destination,uint256 amount,uint256 minRemainingCollateral,uint256 coolDownEnd,uint256 snapshotVersion,uint256 nonce,uint256 authExpiresAt)"
    );

    // ── on-chain seller lifecycle (richer states pending_confirmations/cooling/withdrawable
    //    are tracked off-chain per doc §4.1; on-chain authority is collateral >= min) ──
    enum SellerLifecycle {
        None, // no registered wallet
        Active, // registered AND collateral >= baseBondMinUnits → eligibility-locked
        BelowMin // registered AND collateral < baseBondMinUnits (unfunded / partially slashed / withdrawn)
    }

    struct PendingSlash {
        uint256 amount;
        uint256 executeAfter;
        bytes32 evidenceRef;
        bool exists;
    }

    // ── immutable config ──
    IERC20 public immutable usdcToken; // the ONE whitelisted USDC; only token counted as collateral
    uint256 public immutable baseBondMinUnits; // single flat threshold (6-dp USDC units)
    uint256 public immutable slashCoolDownSeconds; // §5 on-chain cooling/appeal window (unbypassable)

    // ── governance-controlled config ──
    address public governance; // multisig + timelock
    address public pendingGovernance; // 2-step transfer target
    address public authorizationSigner; // WebAZ EIP-712 signer (KMS/HSM); != hot relayer
    address public penaltyReserve; // fixed slash sink (3-redline reserve, §5/§10)

    // ── state ──
    mapping(bytes32 => address) public registeredBondWalletOf; // sellerId → wallet (unique 1:1)
    mapping(address => bytes32) public sellerIdOfWallet; // wallet → sellerId (enforce uniqueness)
    mapping(bytes32 => uint256) public collateralOf; // sellerId → locked USDC units
    mapping(bytes32 => PendingSlash) public pendingSlashOf; // sellerId → pending slash (one at a time)
    mapping(bytes32 => bool) public consumedAuthorization; // EIP-712 digest → used (replay guard)
    mapping(bytes4 => bool) public pausedFlag; // orthogonal pause flags
    uint256 public totalCollateral; // Σ collateralOf (conservation anchor)

    // ── events (audit trail) ──
    event WalletRegistered(bytes32 indexed sellerId, address indexed wallet, uint256 nonce);
    event WalletRotated(bytes32 indexed sellerId, address indexed oldWallet, address indexed newWallet, uint256 nonce);
    event CollateralDeposited(bytes32 indexed sellerId, address indexed wallet, uint256 amount, uint256 newCollateral);
    event SlashProposed(bytes32 indexed sellerId, uint256 amount, uint256 executeAfter, bytes32 evidenceRef);
    event SlashCancelled(bytes32 indexed sellerId, uint256 amount);
    event CollateralSlashed(bytes32 indexed sellerId, uint256 amount, address penaltyReserve, uint256 newCollateral);
    event CollateralWithdrawn(bytes32 indexed sellerId, address indexed to, uint256 amount, uint256 newCollateral);
    event UnattributedCredited(bytes32 indexed sellerId, uint256 amount, bytes32 ref);
    event UnattributedReturned(address indexed to, uint256 amount, bytes32 ref);
    event NonWhitelistedTokenRescued(address indexed token, address indexed to, uint256 amount);
    event PausedSet(bytes4 indexed flag, bool value);
    event SignerRotated(address indexed oldSigner, address indexed newSigner);
    event PenaltyReserveSet(address indexed oldReserve, address indexed newReserve);
    event GovernanceTransferStarted(address indexed currentGovernance, address indexed pendingGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);

    // ── errors ──
    error NotGovernance();
    error ZeroAddress();
    error ZeroAmount();
    error GloballyPaused();
    error ActionPaused(bytes4 flag);
    error WalletAlreadyRegistered();
    error WalletBoundToAnotherSeller();
    error NotRegisteredWallet();
    error SellerNotRegistered();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error BadAuthorizationSignature();
    error BadSellerSignature();
    error WrongDestination();
    error InsufficientCollateral();
    error MinRemainingViolated();
    error SlashAlreadyPending();
    error NoPendingSlash();
    error CoolDownNotElapsed();
    error CannotRescueCollateralToken();
    error InsufficientUnattributed();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /// @dev Reverts if `flag`'s action is paused, or if globally paused.
    modifier whenActionAllowed(bytes4 flag) {
        if (pausedFlag[GLOBAL_PAUSED]) revert GloballyPaused();
        if (pausedFlag[flag]) revert ActionPaused(flag);
        _;
    }

    constructor(
        address governance_,
        address authorizationSigner_,
        address usdcToken_,
        address penaltyReserve_,
        uint256 baseBondMinUnits_,
        uint256 slashCoolDownSeconds_
    ) EIP712("WebAZ MerchantBondVault", "1") {
        if (
            governance_ == address(0) || authorizationSigner_ == address(0) || usdcToken_ == address(0)
                || penaltyReserve_ == address(0)
        ) revert ZeroAddress();
        if (penaltyReserve_ == usdcToken_) revert ZeroAddress(); // reserve must not be the token contract
        governance = governance_;
        authorizationSigner = authorizationSigner_;
        usdcToken = IERC20(usdcToken_);
        penaltyReserve = penaltyReserve_;
        baseBondMinUnits = baseBondMinUnits_;
        slashCoolDownSeconds = slashCoolDownSeconds_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wallet binding (sellerId ↔ registeredBondWallet, unique 1:1)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice First-time binding of a sellerId to a bond wallet.
     *         msg.sender MUST be `wallet` (proves key control); WebAZ EIP-712 authorization required.
     *         Unregistered/foreign inflows never auto-grant eligibility (doc §4).
     */
    function registerBondWallet(
        bytes32 sellerId,
        address wallet,
        uint256 nonce,
        uint256 authExpiresAt,
        bytes calldata authorization
    ) external {
        if (wallet == address(0)) revert ZeroAddress();
        if (msg.sender != wallet) revert NotRegisteredWallet();
        if (registeredBondWalletOf[sellerId] != address(0)) revert WalletAlreadyRegistered();
        if (sellerIdOfWallet[wallet] != bytes32(0)) revert WalletBoundToAnotherSeller();

        bytes32 structHash = keccak256(abi.encode(REGISTER_TYPEHASH, sellerId, wallet, nonce, authExpiresAt));
        _consumeWebAzAuthorization(structHash, authExpiresAt, authorization);

        registeredBondWalletOf[sellerId] = wallet;
        sellerIdOfWallet[wallet] = sellerId;
        emit WalletRegistered(sellerId, wallet, nonce);
    }

    /**
     * @notice Rotate a sellerId's bond wallet. msg.sender MUST be `newWallet` (proves control of the
     *         new key); requires WebAZ EIP-712 authorization + the CURRENT (old) wallet's signature.
     */
    function rotateBondWallet(
        bytes32 sellerId,
        address newWallet,
        uint256 nonce,
        uint256 authExpiresAt,
        bytes calldata authorization,
        bytes calldata oldWalletSignature
    ) external {
        address oldWallet = registeredBondWalletOf[sellerId];
        if (oldWallet == address(0)) revert SellerNotRegistered();
        if (newWallet == address(0)) revert ZeroAddress();
        if (msg.sender != newWallet) revert NotRegisteredWallet();
        if (sellerIdOfWallet[newWallet] != bytes32(0)) revert WalletBoundToAnotherSeller();

        bytes32 structHash =
            keccak256(abi.encode(ROTATE_TYPEHASH, sellerId, oldWallet, newWallet, nonce, authExpiresAt));
        bytes32 digest = _consumeWebAzAuthorization(structHash, authExpiresAt, authorization);
        if (ECDSA.recover(digest, oldWalletSignature) != oldWallet) revert BadSellerSignature();

        delete sellerIdOfWallet[oldWallet];
        registeredBondWalletOf[sellerId] = newWallet;
        sellerIdOfWallet[newWallet] = sellerId;
        emit WalletRotated(sellerId, oldWallet, newWallet, nonce);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deposit (seller-initiated; whitelisted USDC only, via transferFrom)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit collateral. Pulls `amount` of the whitelisted USDC from msg.sender via
     *         transferFrom (requires prior approve). msg.sender MUST be the registered bond wallet.
     *         A raw ERC-20 `transfer` to this contract is NOT auto-credited (becomes unattributed).
     */
    function depositCollateral(bytes32 sellerId, uint256 amount)
        external
        nonReentrant
        whenActionAllowed(DEPOSITS_PAUSED)
    {
        if (amount == 0) revert ZeroAmount();
        address wallet = registeredBondWalletOf[sellerId];
        if (wallet == address(0)) revert SellerNotRegistered();
        if (msg.sender != wallet) revert NotRegisteredWallet();

        // effects-after-interaction guarded by nonReentrant; measure actual received (fee-on-transfer safe).
        uint256 balBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdcToken.balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        uint256 newCollateral = collateralOf[sellerId] + received;
        collateralOf[sellerId] = newCollateral;
        totalCollateral += received;
        emit CollateralDeposited(sellerId, wallet, received, newCollateral);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Withdraw (seller sig + WebAZ authorization; only to registeredBondWallet)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw collateral to the seller's registeredBondWallet. Submittable by anyone
     *         (e.g. a WebAZ relayer paying gas); both cryptographic authorizations are required:
     *           - WebAZ EIP-712 WithdrawCollateral authorization (no-open-liability attested off-chain), and
     *           - the registered bond wallet's signature over the SAME typed data.
     *         Contract enforces: destination==registeredBondWallet, amount<=collateral,
     *         post-withdraw collateral>=minRemainingCollateral, coolDownEnd reached, not expired, nonce unused.
     *         The off-chain withdraw/unlock blocker (open orders / disputes / etc., doc §5) is enforced
     *         by WebAZ BEFORE it signs; the contract is the "release-on-authorization" executor.
     */
    function sellerWithdrawCollateral(
        bytes32 sellerId,
        address destination,
        uint256 amount,
        uint256 minRemainingCollateral,
        uint256 coolDownEnd,
        uint256 snapshotVersion,
        uint256 nonce,
        uint256 authExpiresAt,
        bytes calldata authorization,
        bytes calldata sellerSignature
    ) external nonReentrant whenActionAllowed(WITHDRAW_PAUSED) {
        if (amount == 0) revert ZeroAmount();
        address wallet = registeredBondWalletOf[sellerId];
        if (wallet == address(0)) revert SellerNotRegistered();
        if (destination != wallet) revert WrongDestination();
        if (block.timestamp < coolDownEnd) revert CoolDownNotElapsed();

        uint256 current = collateralOf[sellerId];
        if (amount > current) revert InsufficientCollateral();
        uint256 remaining = current - amount;
        if (remaining < minRemainingCollateral) revert MinRemainingViolated();

        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAW_TYPEHASH,
                sellerId,
                destination,
                amount,
                minRemainingCollateral,
                coolDownEnd,
                snapshotVersion,
                nonce,
                authExpiresAt
            )
        );
        bytes32 digest = _consumeWebAzAuthorization(structHash, authExpiresAt, authorization);
        if (ECDSA.recover(digest, sellerSignature) != wallet) revert BadSellerSignature();

        // effects before interaction (CEI) — conservation preserved.
        collateralOf[sellerId] = remaining;
        totalCollateral -= amount;
        usdcToken.safeTransfer(destination, amount);
        emit CollateralWithdrawn(sellerId, destination, amount, remaining);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Slash (governance-only, two-step with on-chain cooling/appeal; → penaltyReserve only)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Stage a slash. Starts the on-chain cooling/appeal window. One pending slash per seller.
    function proposeSlash(bytes32 sellerId, uint256 amount, bytes32 evidenceRef)
        external
        onlyGovernance
        whenActionAllowed(SLASH_PAUSED)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > collateralOf[sellerId]) revert InsufficientCollateral();
        if (pendingSlashOf[sellerId].exists) revert SlashAlreadyPending();
        uint256 executeAfter = block.timestamp + slashCoolDownSeconds;
        pendingSlashOf[sellerId] =
            PendingSlash({amount: amount, executeAfter: executeAfter, evidenceRef: evidenceRef, exists: true});
        emit SlashProposed(sellerId, amount, executeAfter, evidenceRef);
    }

    /// @notice Cancel a staged slash (appeal upheld / error). Governance-only.
    function cancelSlash(bytes32 sellerId) external onlyGovernance {
        PendingSlash memory p = pendingSlashOf[sellerId];
        if (!p.exists) revert NoPendingSlash();
        delete pendingSlashOf[sellerId];
        emit SlashCancelled(sellerId, p.amount);
    }

    /// @notice Execute a staged slash after the cooling window. Funds can ONLY go to penaltyReserve.
    function executeSlash(bytes32 sellerId) external onlyGovernance nonReentrant whenActionAllowed(SLASH_PAUSED) {
        PendingSlash memory p = pendingSlashOf[sellerId];
        if (!p.exists) revert NoPendingSlash();
        if (block.timestamp < p.executeAfter) revert CoolDownNotElapsed();
        uint256 current = collateralOf[sellerId];
        // clamp to current balance (collateral may have decreased via withdraw since proposal).
        uint256 amount = p.amount > current ? current : p.amount;
        if (amount == 0) revert InsufficientCollateral();

        delete pendingSlashOf[sellerId];
        uint256 remaining = current - amount;
        collateralOf[sellerId] = remaining;
        totalCollateral -= amount;
        usdcToken.safeTransfer(penaltyReserve, amount);
        emit CollateralSlashed(sellerId, amount, penaltyReserve, remaining);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Unattributed inflow (raw transfers not via depositCollateral) — governance handling
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev USDC sitting in the contract beyond Σ collateral = unattributed inflow (raw transfers).
    function unattributedUsdc() public view returns (uint256) {
        return usdcToken.balanceOf(address(this)) - totalCollateral;
    }

    /**
     * @notice Credit previously-unattributed USDC to a seller's collateral. Bounded to the proven
     *         excess (balanceOf - totalCollateral), which guarantees it was NOT already counted as
     *         anyone's collateral (no double-credit, doc §4).
     */
    function creditUnattributedCollateral(bytes32 sellerId, uint256 amount, bytes32 ref) external onlyGovernance {
        if (amount == 0) revert ZeroAmount();
        if (registeredBondWalletOf[sellerId] == address(0)) revert SellerNotRegistered();
        if (amount > unattributedUsdc()) revert InsufficientUnattributed();
        collateralOf[sellerId] += amount;
        totalCollateral += amount;
        emit UnattributedCredited(sellerId, amount, ref);
    }

    /// @notice Return unattributed USDC (e.g. an erroneous raw transfer) to an address. Bounded to
    ///         the excess only — NEVER touches any seller's collateral.
    function returnUnattributedInflow(address to, uint256 amount, bytes32 ref) external onlyGovernance nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > unattributedUsdc()) revert InsufficientUnattributed();
        usdcToken.safeTransfer(to, amount);
        emit UnattributedReturned(to, amount, ref);
    }

    /// @notice Rescue a NON-whitelisted token sent here by mistake. Reverts for the collateral USDC.
    function rescueNonWhitelistedToken(address token, address to, uint256 amount) external onlyGovernance nonReentrant {
        if (token == address(usdcToken)) revert CannotRescueCollateralToken();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit NonWhitelistedTokenRescued(token, to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Governance config (pause / signer / penaltyReserve / governance transfer)
    // ─────────────────────────────────────────────────────────────────────────

    function setPaused(bytes4 flag, bool value) external onlyGovernance {
        pausedFlag[flag] = value;
        emit PausedSet(flag, value);
    }

    function rotateAuthorizationSigner(address newSigner) external onlyGovernance {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerRotated(authorizationSigner, newSigner);
        authorizationSigner = newSigner;
    }

    function setPenaltyReserve(address newReserve) external onlyGovernance {
        if (newReserve == address(0) || newReserve == address(usdcToken)) revert ZeroAddress();
        emit PenaltyReserveSet(penaltyReserve, newReserve);
        penaltyReserve = newReserve;
    }

    /// @notice Begin a 2-step governance handover (safer than a 1-step set; no upgrade of logic).
    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        pendingGovernance = newGovernance;
        emit GovernanceTransferStarted(governance, newGovernance);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert NotGovernance();
        emit GovernanceTransferred(governance, pendingGovernance);
        governance = pendingGovernance;
        pendingGovernance = address(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice On-chain authority for eligibility (doc §4.1). Backend additionally requires
    ///         >= N confirmations + its mirrored status before flipping sellerHasProductionBaseBondLocked.
    function isLocked(bytes32 sellerId) public view returns (bool) {
        return registeredBondWalletOf[sellerId] != address(0) && collateralOf[sellerId] >= baseBondMinUnits;
    }

    function lifecycleOf(bytes32 sellerId) external view returns (SellerLifecycle) {
        if (registeredBondWalletOf[sellerId] == address(0)) return SellerLifecycle.None;
        return collateralOf[sellerId] >= baseBondMinUnits ? SellerLifecycle.Active : SellerLifecycle.BelowMin;
    }

    function isPaused(bytes4 flag) external view returns (bool) {
        return pausedFlag[flag] || pausedFlag[GLOBAL_PAUSED];
    }

    /// @notice EIP-712 domain separator (exposed for off-chain signers/integrators).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Validates a WebAZ authorization: not expired, not replayed, signed by authorizationSigner.
    ///      Marks the digest consumed and returns it (for any co-signature checks).
    function _consumeWebAzAuthorization(bytes32 structHash, uint256 authExpiresAt, bytes calldata authorization)
        internal
        returns (bytes32 digest)
    {
        if (block.timestamp > authExpiresAt) revert AuthorizationExpired();
        digest = _hashTypedDataV4(structHash);
        if (consumedAuthorization[digest]) revert AuthorizationAlreadyUsed();
        if (ECDSA.recover(digest, authorization) != authorizationSigner) revert BadAuthorizationSignature();
        consumedAuthorization[digest] = true;
    }
}
