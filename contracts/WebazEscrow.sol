// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * WebazEscrow — v1 per-order USDC escrow (buyer-funded, buyer-released, arbiter only on dispute).
 *
 * Mainnet decision: Holden approved real-USDC mainnet deployment on 2026-07-23, explicitly
 * superseding the earlier "no mainnet before legal opinion + external audit" gate. Claude/Codex
 * review does NOT substitute for an independent third-party audit — the compensating controls are
 * a small immutable surface, hard per-tx caps, a deposits-only pause, and exhaustive fund-exit
 * enumeration (see invariants). Keep the contract deliberately tiny; do not grow this surface.
 *
 * ── v1 LOCKED INVARIANTS (do not regress without a new Holden decision) ──
 *  - Holds ONLY buyer order escrows in ONE whitelisted USDC token. Nothing else is credited.
 *  - NON-custodial power map: the platform can NEVER move funds to an arbitrary address.
 *    Funds leave an escrow ONLY via: buyer refund (to the original buyer), seller payout
 *    (to the voucher-bound seller address), platform fee (to `treasury`). There is no other
 *    transfer of the escrow token out of this contract (no admin drain; rescue excludes USDC).
 *  - IMMUTABLE: no upgrade, no proxy, no delegatecall, no selfdestruct.
 *  - Release power map: buyer may release any time while Funded; ANYONE may trigger release
 *    after autoReleaseAt (liveness — a lost buyer key can never strand the seller); the arbiter
 *    may act ONLY on a Disputed escrow and only via the three-way split above.
 *  - deposit requires a WebAZ EIP-712 voucher binding ALL economics (orderId/seller/amount/
 *    feeBps/autoReleaseAt) — no orphan deposits with mismatched params; orderId is one-shot.
 *  - perTxCap is owner-adjustable but hard-capped by the immutable PER_TX_CAP_CEILING;
 *    feeBps per order is hard-capped by FEE_BPS_CEILING (10%). Fee is charged only on the
 *    portion the seller receives — a full refund carries zero platform fee.
 *  - pause blocks NEW deposits only; funds already in escrow can ALWAYS exit.
 *
 * ── Conservation ──
 *  - totalLocked == Σ amount over escrows in state Funded|Disputed, at all times.
 *  - usdc.balanceOf(this) >= totalLocked at all times (excess = unattributed inflow, ignored).
 *  - Every terminal transition pays out exactly `amount`: buyerRefund + sellerPay + fee == amount.
 */
contract WebazEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── EIP-712 ──
    bytes32 private constant DEPOSIT_TYPEHASH = keccak256(
        "Deposit(bytes32 orderId,address buyer,address seller,uint256 amount,uint256 feeBps,uint256 autoReleaseAt,uint256 authExpiresAt)"
    );

    enum EscrowState {
        None, // never funded
        Funded, // buyer USDC locked, awaiting release / dispute
        Disputed, // frozen — only arbiterResolve can exit
        Released, // paid out to seller (buyer or auto release)
        Resolved, // arbiter split (partial refund)
        Refunded // arbiter full refund to buyer
    }

    struct EscrowRec {
        address buyer;
        address seller;
        uint128 amount; // USDC 6dp units
        uint16 feeBps; // frozen at deposit (voucher-bound)
        uint64 autoReleaseAt; // after this ANYONE may trigger release (liveness)
        EscrowState state;
    }

    // ── immutable config ──
    IERC20 public immutable usdc; // the ONE whitelisted USDC
    uint256 public immutable PER_TX_CAP_CEILING; // hard ceiling for perTxCap (deploy-frozen)
    uint256 public constant FEE_BPS_CEILING = 1000; // 10% — platform fee power hard cap
    uint256 public constant MAX_AUTO_RELEASE_WINDOW = 90 days; // deadline sanity bound

    // ── governance-controlled config (all 2-step where fund-relevant) ──
    address public owner;
    address public pendingOwner;
    address public arbiter; // dispute ruling key; NEVER the hot relayer
    address public pendingArbiter;
    address public treasury; // platform fee sink
    address public pendingTreasury;
    address public authorizationSigner; // WebAZ EIP-712 voucher signer; no fund power over locked escrows
    uint256 public perTxCap; // operational per-deposit cap (<= PER_TX_CAP_CEILING)
    bool public depositsPaused;

    // ── state ──
    mapping(bytes32 => EscrowRec) public escrows; // orderKey => record (orderKey = keccak256(orderId))
    mapping(bytes32 => bool) public consumedAuthorization; // EIP-712 digest replay guard
    uint256 public totalLocked; // Σ Funded|Disputed amounts (conservation anchor)

    // ── events ──
    event Deposited(
        bytes32 indexed orderKey, address indexed buyer, address indexed seller, uint256 amount, uint256 feeBps, uint64 autoReleaseAt
    );
    event Released(bytes32 indexed orderKey, bool auto_, uint256 sellerPaid, uint256 feePaid);
    event Disputed(bytes32 indexed orderKey, address indexed by);
    event Resolved(bytes32 indexed orderKey, uint256 buyerRefund, uint256 sellerPaid, uint256 feePaid);
    event DepositsPausedSet(bool paused);
    event PerTxCapChanged(uint256 oldCap, uint256 newCap);
    event OwnerTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event ArbiterTransferStarted(address indexed currentArbiter, address indexed pendingArbiter);
    event ArbiterTransferred(address indexed oldArbiter, address indexed newArbiter);
    event TreasuryTransferStarted(address indexed currentTreasury, address indexed pendingTreasury);
    event TreasuryTransferred(address indexed oldTreasury, address indexed newTreasury);
    event SignerRotated(address indexed oldSigner, address indexed newSigner);
    event NonEscrowTokenRescued(address indexed token, address indexed to, uint256 amount);

    // ── errors ──
    error NotOwner();
    error NotArbiter();
    error NotBuyer();
    error NotPending();
    error ZeroAddress();
    error ZeroAmount();
    error DepositsArePaused();
    error OrderAlreadyExists();
    error BadState();
    error OverPerTxCap();
    error OverFeeCeiling();
    error BadDeadline();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error BadAuthorizationSignature();
    error NotYetAutoReleasable();
    error AutoReleaseWindowPassed();
    error RefundExceedsAmount();
    error OverCapCeiling();
    error CannotRescueEscrowToken();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        address arbiter_,
        address treasury_,
        address authorizationSigner_,
        address usdc_,
        uint256 perTxCapCeiling_,
        uint256 initialPerTxCap_
    ) EIP712("WebazEscrow", "1") {
        if (
            owner_ == address(0) || arbiter_ == address(0) || treasury_ == address(0)
                || authorizationSigner_ == address(0) || usdc_ == address(0)
        ) revert ZeroAddress();
        if (treasury_ == usdc_) revert ZeroAddress(); // fee sink must not be the token contract
        if (perTxCapCeiling_ == 0 || initialPerTxCap_ == 0 || initialPerTxCap_ > perTxCapCeiling_) revert ZeroAmount();
        owner = owner_;
        arbiter = arbiter_;
        treasury = treasury_;
        authorizationSigner = authorizationSigner_;
        usdc = IERC20(usdc_);
        PER_TX_CAP_CEILING = perTxCapCeiling_;
        perTxCap = initialPerTxCap_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Buyer flow
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Fund an order escrow. msg.sender is the buyer (the ONLY address a later refund can
     *         go to). Pulls `amount` USDC via transferFrom (requires prior approve). Every economic
     *         parameter is bound by a WebAZ EIP-712 voucher — a client cannot deposit mismatched
     *         amount/seller/fee, and an orderId can only ever be funded once.
     */
    function deposit(
        bytes32 orderId,
        address seller,
        uint256 amount,
        uint256 feeBps,
        uint64 autoReleaseAt,
        uint256 authExpiresAt,
        bytes calldata authorization
    ) external nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (seller == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > type(uint128).max) revert ZeroAmount();
        if (amount > perTxCap) revert OverPerTxCap();
        if (feeBps > FEE_BPS_CEILING) revert OverFeeCeiling();
        if (autoReleaseAt <= block.timestamp || autoReleaseAt > block.timestamp + MAX_AUTO_RELEASE_WINDOW) {
            revert BadDeadline();
        }
        bytes32 orderKey = keccak256(abi.encodePacked(orderId));
        if (escrows[orderKey].state != EscrowState.None) revert OrderAlreadyExists();

        bytes32 structHash = keccak256(
            abi.encode(DEPOSIT_TYPEHASH, orderId, msg.sender, seller, amount, feeBps, uint256(autoReleaseAt), authExpiresAt)
        );
        if (block.timestamp > authExpiresAt) revert AuthorizationExpired();
        bytes32 digest = _hashTypedDataV4(structHash);
        if (consumedAuthorization[digest]) revert AuthorizationAlreadyUsed();
        if (ECDSA.recover(digest, authorization) != authorizationSigner) revert BadAuthorizationSignature();
        consumedAuthorization[digest] = true;

        escrows[orderKey] = EscrowRec({
            buyer: msg.sender,
            seller: seller,
            amount: uint128(amount),
            feeBps: uint16(feeBps),
            autoReleaseAt: autoReleaseAt,
            state: EscrowState.Funded
        });
        totalLocked += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(orderKey, msg.sender, seller, amount, feeBps, autoReleaseAt);
    }

    /// @notice Buyer confirms receipt → escrow pays out to seller (minus the frozen fee).
    function buyerRelease(bytes32 orderId) external nonReentrant {
        bytes32 orderKey = keccak256(abi.encodePacked(orderId));
        EscrowRec storage e = escrows[orderKey];
        if (e.state != EscrowState.Funded) revert BadState();
        if (msg.sender != e.buyer) revert NotBuyer();
        _payoutRelease(orderKey, e, false);
    }

    /**
     * @notice After autoReleaseAt with no dispute, ANYONE may trigger the payout (liveness:
     *         a lost/idle buyer key can never strand the seller's funds).
     */
    function autoRelease(bytes32 orderId) external nonReentrant {
        bytes32 orderKey = keccak256(abi.encodePacked(orderId));
        EscrowRec storage e = escrows[orderKey];
        if (e.state != EscrowState.Funded) revert BadState();
        if (block.timestamp < e.autoReleaseAt) revert NotYetAutoReleasable();
        _payoutRelease(orderKey, e, true);
    }

    /**
     * @notice Freeze the escrow into Disputed (blocks autoRelease). The buyer may flag only inside
     *         the auto-release window; the arbiter (platform dispute engine, human-confirmed) may
     *         flag any time while Funded — e.g. for a buyer who lost their key.
     */
    function flagDispute(bytes32 orderId) external {
        bytes32 orderKey = keccak256(abi.encodePacked(orderId));
        EscrowRec storage e = escrows[orderKey];
        if (e.state != EscrowState.Funded) revert BadState();
        if (msg.sender == e.buyer) {
            if (block.timestamp >= e.autoReleaseAt) revert AutoReleaseWindowPassed();
        } else if (msg.sender != arbiter) {
            revert NotArbiter();
        }
        e.state = EscrowState.Disputed;
        emit Disputed(orderKey, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Arbiter flow (Disputed only — the ONLY state where the platform can move funds)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Rule a disputed escrow: `buyerRefund` goes back to the ORIGINAL buyer, the platform
     *         fee applies only to the seller-bound remainder, the rest pays the seller.
     *         buyerRefund + sellerPay + fee == amount, always. Full refund carries zero fee.
     */
    function arbiterResolve(bytes32 orderId, uint256 buyerRefund) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        bytes32 orderKey = keccak256(abi.encodePacked(orderId));
        EscrowRec storage e = escrows[orderKey];
        if (e.state != EscrowState.Disputed) revert BadState();
        uint256 amount = e.amount;
        if (buyerRefund > amount) revert RefundExceedsAmount();

        uint256 sellerBound = amount - buyerRefund;
        uint256 fee = (sellerBound * e.feeBps) / 10_000;
        uint256 sellerPay = sellerBound - fee;

        e.state = buyerRefund == amount ? EscrowState.Refunded : EscrowState.Resolved;
        totalLocked -= amount;
        if (buyerRefund > 0) usdc.safeTransfer(e.buyer, buyerRefund);
        if (sellerPay > 0) usdc.safeTransfer(e.seller, sellerPay);
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        emit Resolved(orderKey, buyerRefund, sellerPay, fee);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Governance (owner) — pause / cap / 2-step role transfers / signer rotation
    // ─────────────────────────────────────────────────────────────────────────

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setPerTxCap(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroAmount();
        if (newCap > PER_TX_CAP_CEILING) revert OverCapCeiling();
        emit PerTxCapChanged(perTxCap, newCap);
        perTxCap = newCap;
    }

    function transferOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnerTransferStarted(owner, newOwner);
    }

    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotPending();
        emit OwnerTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    function transferArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        pendingArbiter = newArbiter;
        emit ArbiterTransferStarted(arbiter, newArbiter);
    }

    function acceptArbiter() external {
        if (msg.sender != pendingArbiter) revert NotPending();
        emit ArbiterTransferred(arbiter, pendingArbiter);
        arbiter = pendingArbiter;
        pendingArbiter = address(0);
    }

    function transferTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0) || newTreasury == address(usdc)) revert ZeroAddress();
        pendingTreasury = newTreasury;
        emit TreasuryTransferStarted(treasury, newTreasury);
    }

    function acceptTreasury() external {
        if (msg.sender != pendingTreasury) revert NotPending();
        emit TreasuryTransferred(treasury, pendingTreasury);
        treasury = pendingTreasury;
        pendingTreasury = address(0);
    }

    /// @notice Rotate the voucher signer. A leaked signer can only mint DEPOSIT opportunities —
    ///         it has zero power over funds already locked.
    function rotateSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerRotated(authorizationSigner, newSigner);
        authorizationSigner = newSigner;
    }

    /// @notice Rescue tokens sent here by mistake. The escrow token itself can NEVER be rescued.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(usdc)) revert CannotRescueEscrowToken();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit NonEscrowTokenRescued(token, to, amount);
    }

    /// @notice EIP-712 domain separator (voucher signing helper for the backend/tests).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _payoutRelease(bytes32 orderKey, EscrowRec storage e, bool auto_) internal {
        uint256 amount = e.amount;
        uint256 fee = (amount * e.feeBps) / 10_000;
        uint256 sellerPay = amount - fee;
        e.state = EscrowState.Released;
        totalLocked -= amount;
        usdc.safeTransfer(e.seller, sellerPay);
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        emit Released(orderKey, auto_, sellerPay, fee);
    }
}
