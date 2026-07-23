// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {WebazEscrow} from "../WebazEscrow.sol";
import {MockUSDC, MockOtherToken} from "./mocks/MockUSDC.sol";

/**
 * WebazEscrow v1 — Foundry tests.
 * Covers the locked invariants: fund-exit enumeration (buyer/seller/treasury only), voucher-bound
 * deposit (one-shot orderId + replay/expiry/signature), release power map (buyer any time while
 * Funded, anyone after autoReleaseAt, arbiter ONLY on Disputed), conservation on every terminal
 * path (refund + sellerPay + fee == amount; full refund → zero fee), caps (per-tx + fee ceiling +
 * deadline window), deposits-only pause (exits always live), 2-step role transfers, rescue safety.
 */
contract WebazEscrowTest is Test {
    WebazEscrow internal esc;
    MockUSDC internal usdc;

    bytes32 private constant DEPOSIT_TYPEHASH = keccak256(
        "Deposit(bytes32 orderId,address buyer,address seller,uint256 amount,uint256 feeBps,uint256 autoReleaseAt,uint256 authExpiresAt)"
    );

    uint256 internal constant CAP_CEILING = 500e6;
    uint256 internal constant CAP = 50e6;

    uint256 internal signerPk = 0xA11CE;
    uint256 internal buyerPk = 0xB0B;
    address internal signer;
    address internal buyer;
    address internal seller = makeAddr("seller");
    address internal treasury = makeAddr("treasury");
    address internal arbiter = makeAddr("arbiter");
    address internal attacker = makeAddr("attacker");

    bytes32 internal orderId = keccak256("ord_1");

    function setUp() public {
        signer = vm.addr(signerPk);
        buyer = vm.addr(buyerPk);
        usdc = new MockUSDC();
        esc = new WebazEscrow(address(this), arbiter, treasury, signer, address(usdc), CAP_CEILING, CAP);
        usdc.mint(buyer, 1_000e6);
        vm.prank(buyer);
        usdc.approve(address(esc), type(uint256).max);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _voucher(bytes32 oid, address b, address s, uint256 amount, uint256 feeBps, uint64 releaseAt, uint256 exp)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(DEPOSIT_TYPEHASH, oid, b, s, amount, feeBps, uint256(releaseAt), exp));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, sg, v);
    }

    function _deposit(bytes32 oid, uint256 amount, uint256 feeBps) internal returns (uint64 releaseAt) {
        releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(oid, buyer, seller, amount, feeBps, releaseAt, exp);
        vm.prank(buyer);
        esc.deposit(oid, seller, amount, feeBps, releaseAt, exp, auth);
    }

    function _key(bytes32 oid) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(oid));
    }

    function _state(bytes32 oid) internal view returns (WebazEscrow.EscrowState st) {
        (,,,,, st) = esc.escrows(_key(oid));
    }

    // ───────────────────────── deposit ─────────────────────────

    function test_deposit_locksFundsAndRecordsEconomics() public {
        _deposit(orderId, 40e6, 200);
        (address b, address s, uint128 amt, uint16 fee,, WebazEscrow.EscrowState st) = esc.escrows(_key(orderId));
        assertEq(b, buyer);
        assertEq(s, seller);
        assertEq(amt, 40e6);
        assertEq(fee, 200);
        assertTrue(st == WebazEscrow.EscrowState.Funded);
        assertEq(usdc.balanceOf(address(esc)), 40e6);
        assertEq(esc.totalLocked(), 40e6);
    }

    function test_deposit_orderIdIsOneShot() public {
        _deposit(orderId, 10e6, 200);
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(orderId, buyer, seller, 10e6, 200, releaseAt, exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.OrderAlreadyExists.selector);
        esc.deposit(orderId, seller, 10e6, 200, releaseAt, exp, auth);
    }

    function test_deposit_voucherBindsEconomics_wrongAmountRejected() public {
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(orderId, buyer, seller, 10e6, 200, releaseAt, exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.BadAuthorizationSignature.selector);
        esc.deposit(orderId, seller, 11e6, 200, releaseAt, exp, auth); // amount mismatch → digest mismatch
    }

    function test_deposit_voucherIsBuyerBound() public {
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(orderId, buyer, seller, 10e6, 200, releaseAt, exp);
        usdc.mint(attacker, 100e6);
        vm.startPrank(attacker);
        usdc.approve(address(esc), type(uint256).max);
        vm.expectRevert(WebazEscrow.BadAuthorizationSignature.selector);
        esc.deposit(orderId, seller, 10e6, 200, releaseAt, exp, auth); // stolen voucher unusable by another buyer
        vm.stopPrank();
    }

    function test_deposit_expiredVoucherRejected() public {
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(orderId, buyer, seller, 10e6, 200, releaseAt, exp);
        vm.warp(block.timestamp + 2 hours);
        // deadline still valid, voucher expired
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.AuthorizationExpired.selector);
        esc.deposit(orderId, seller, 10e6, 200, releaseAt, exp, auth);
    }

    function test_deposit_wrongSignerRejected() public {
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(DEPOSIT_TYPEHASH, orderId, buyer, seller, uint256(10e6), uint256(200), uint256(releaseAt), exp));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(buyerPk, digest); // buyer self-signs — not the platform signer
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.BadAuthorizationSignature.selector);
        esc.deposit(orderId, seller, 10e6, 200, releaseAt, exp, abi.encodePacked(r, sg, v));
    }

    function test_deposit_caps() public {
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(orderId, buyer, seller, CAP + 1, 200, releaseAt, exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.OverPerTxCap.selector);
        esc.deposit(orderId, seller, CAP + 1, 200, releaseAt, exp, auth);

        auth = _voucher(orderId, buyer, seller, 10e6, 1001, releaseAt, exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.OverFeeCeiling.selector);
        esc.deposit(orderId, seller, 10e6, 1001, releaseAt, exp, auth); // >10% fee is uncappable by governance

        auth = _voucher(orderId, buyer, seller, 10e6, 200, uint64(block.timestamp), exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.BadDeadline.selector);
        esc.deposit(orderId, seller, 10e6, 200, uint64(block.timestamp), exp, auth); // deadline not in the future

        uint64 tooFar = uint64(block.timestamp + 91 days);
        auth = _voucher(orderId, buyer, seller, 10e6, 200, tooFar, exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.BadDeadline.selector);
        esc.deposit(orderId, seller, 10e6, 200, tooFar, exp, auth); // beyond the 90d sanity window
    }

    function test_pause_blocksDepositsOnly_exitsStayLive() public {
        _deposit(orderId, 20e6, 200);
        esc.setDepositsPaused(true);
        // new deposit blocked
        bytes32 oid2 = keccak256("ord_2");
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(oid2, buyer, seller, 10e6, 200, releaseAt, exp);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.DepositsArePaused.selector);
        esc.deposit(oid2, seller, 10e6, 200, releaseAt, exp, auth);
        // funds can still exit while paused (invariant: pause never traps money)
        vm.prank(buyer);
        esc.buyerRelease(orderId);
        assertEq(usdc.balanceOf(seller), 20e6 - (20e6 * 200) / 10_000);
    }

    // ───────────────────────── release ─────────────────────────

    function test_buyerRelease_paysSellerMinusFee() public {
        _deposit(orderId, 50e6, 200);
        vm.prank(buyer);
        esc.buyerRelease(orderId);
        assertEq(usdc.balanceOf(seller), 49e6); // 50 − 2%
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(esc.totalLocked(), 0);
        assertTrue(_state(orderId) == WebazEscrow.EscrowState.Released);
    }

    function test_buyerRelease_onlyBuyer() public {
        _deposit(orderId, 10e6, 200);
        vm.prank(attacker);
        vm.expectRevert(WebazEscrow.NotBuyer.selector);
        esc.buyerRelease(orderId);
        vm.prank(arbiter); // even the arbiter cannot release a non-disputed escrow
        vm.expectRevert(WebazEscrow.NotBuyer.selector);
        esc.buyerRelease(orderId);
    }

    function test_autoRelease_beforeDeadlineReverts_afterAnyoneCan() public {
        uint64 releaseAt = _deposit(orderId, 30e6, 100);
        vm.prank(attacker);
        vm.expectRevert(WebazEscrow.NotYetAutoReleasable.selector);
        esc.autoRelease(orderId);
        vm.warp(releaseAt);
        vm.prank(attacker); // anyone — liveness for the seller
        esc.autoRelease(orderId);
        assertEq(usdc.balanceOf(seller), 30e6 - (30e6 * 100) / 10_000);
        assertTrue(_state(orderId) == WebazEscrow.EscrowState.Released);
    }

    function test_release_doubleSpendImpossible() public {
        _deposit(orderId, 10e6, 0);
        vm.prank(buyer);
        esc.buyerRelease(orderId);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.BadState.selector);
        esc.buyerRelease(orderId);
        vm.warp(block.timestamp + 15 days);
        vm.expectRevert(WebazEscrow.BadState.selector);
        esc.autoRelease(orderId);
    }

    // ───────────────────────── dispute + resolve ─────────────────────────

    function test_flagDispute_buyerInsideWindow_freezesAutoRelease() public {
        uint64 releaseAt = _deposit(orderId, 10e6, 200);
        vm.prank(buyer);
        esc.flagDispute(orderId);
        assertTrue(_state(orderId) == WebazEscrow.EscrowState.Disputed);
        vm.warp(releaseAt + 1);
        vm.expectRevert(WebazEscrow.BadState.selector);
        esc.autoRelease(orderId); // frozen — only arbiterResolve can exit now
    }

    function test_flagDispute_buyerAfterDeadlineRejected_arbiterAnytime() public {
        uint64 releaseAt = _deposit(orderId, 10e6, 200);
        vm.warp(releaseAt);
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.AutoReleaseWindowPassed.selector);
        esc.flagDispute(orderId);
        vm.prank(arbiter); // platform (human-confirmed) may still freeze, e.g. lost-key buyer
        esc.flagDispute(orderId);
        assertTrue(_state(orderId) == WebazEscrow.EscrowState.Disputed);
    }

    function test_flagDispute_strangerRejected() public {
        _deposit(orderId, 10e6, 200);
        vm.prank(attacker);
        vm.expectRevert(WebazEscrow.NotArbiter.selector);
        esc.flagDispute(orderId);
    }

    function test_arbiterResolve_fullRefund_zeroFee() public {
        _deposit(orderId, 40e6, 200);
        vm.prank(buyer);
        esc.flagDispute(orderId);
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(arbiter);
        esc.arbiterResolve(orderId, 40e6);
        assertEq(usdc.balanceOf(buyer) - before, 40e6); // made whole — platform takes NO fee from a refund
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(seller), 0);
        assertTrue(_state(orderId) == WebazEscrow.EscrowState.Refunded);
        assertEq(esc.totalLocked(), 0);
    }

    function test_arbiterResolve_partialSplit_conserves() public {
        _deposit(orderId, 40e6, 200);
        vm.prank(buyer);
        esc.flagDispute(orderId);
        vm.prank(arbiter);
        esc.arbiterResolve(orderId, 15e6);
        uint256 sellerBound = 25e6;
        uint256 fee = (sellerBound * 200) / 10_000;
        assertEq(usdc.balanceOf(seller), sellerBound - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertTrue(_state(orderId) == WebazEscrow.EscrowState.Resolved);
    }

    function test_arbiterResolve_gates() public {
        _deposit(orderId, 40e6, 200);
        // not disputed yet → arbiter has NO power (the platform cannot touch a healthy escrow)
        vm.prank(arbiter);
        vm.expectRevert(WebazEscrow.BadState.selector);
        esc.arbiterResolve(orderId, 0);
        vm.prank(buyer);
        esc.flagDispute(orderId);
        vm.prank(attacker);
        vm.expectRevert(WebazEscrow.NotArbiter.selector);
        esc.arbiterResolve(orderId, 0);
        vm.prank(arbiter);
        vm.expectRevert(WebazEscrow.RefundExceedsAmount.selector);
        esc.arbiterResolve(orderId, 40e6 + 1);
    }

    function testFuzz_resolve_conservation(uint96 amountRaw, uint96 refundRaw, uint16 feeRaw) public {
        uint256 amount = bound(uint256(amountRaw), 1, CAP);
        uint256 refund = bound(uint256(refundRaw), 0, amount);
        uint256 feeBps = bound(uint256(feeRaw), 0, 1000);
        _deposit(orderId, amount, feeBps);
        vm.prank(buyer);
        esc.flagDispute(orderId);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.prank(arbiter);
        esc.arbiterResolve(orderId, refund);
        uint256 paidOut =
            (usdc.balanceOf(buyer) - buyerBefore) + usdc.balanceOf(seller) + usdc.balanceOf(treasury);
        assertEq(paidOut, amount); // refund + sellerPay + fee == amount, exactly
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(esc.totalLocked(), 0);
    }

    function testFuzz_release_conservation(uint96 amountRaw, uint16 feeRaw) public {
        uint256 amount = bound(uint256(amountRaw), 1, CAP);
        uint256 feeBps = bound(uint256(feeRaw), 0, 1000);
        _deposit(orderId, amount, feeBps);
        vm.prank(buyer);
        esc.buyerRelease(orderId);
        assertEq(usdc.balanceOf(seller) + usdc.balanceOf(treasury), amount);
        assertEq(esc.totalLocked(), 0);
    }

    // ───────────────────────── governance ─────────────────────────

    function test_perTxCap_boundedByImmutableCeiling() public {
        esc.setPerTxCap(CAP_CEILING);
        vm.expectRevert(WebazEscrow.OverCapCeiling.selector);
        esc.setPerTxCap(CAP_CEILING + 1);
        vm.prank(attacker);
        vm.expectRevert(WebazEscrow.NotOwner.selector);
        esc.setPerTxCap(1e6);
    }

    function test_twoStepTransfers() public {
        address newOwner = makeAddr("newOwner");
        esc.transferOwner(newOwner);
        assertEq(esc.owner(), address(this)); // not yet
        vm.prank(attacker);
        vm.expectRevert(WebazEscrow.NotPending.selector);
        esc.acceptOwner();
        vm.prank(newOwner);
        esc.acceptOwner();
        assertEq(esc.owner(), newOwner);

        vm.startPrank(newOwner);
        address newArb = makeAddr("newArb");
        esc.transferArbiter(newArb);
        vm.stopPrank();
        vm.prank(newArb);
        esc.acceptArbiter();
        assertEq(esc.arbiter(), newArb);

        vm.startPrank(newOwner);
        address newTre = makeAddr("newTre");
        esc.transferTreasury(newTre);
        vm.stopPrank();
        vm.prank(newTre);
        esc.acceptTreasury();
        assertEq(esc.treasury(), newTre);
    }

    function test_signerRotation_oldVouchersDie() public {
        uint64 releaseAt = uint64(block.timestamp + 14 days);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _voucher(orderId, buyer, seller, 10e6, 200, releaseAt, exp);
        esc.rotateSigner(makeAddr("newSigner"));
        vm.prank(buyer);
        vm.expectRevert(WebazEscrow.BadAuthorizationSignature.selector);
        esc.deposit(orderId, seller, 10e6, 200, releaseAt, exp, auth);
    }

    function test_rescue_neverTheEscrowToken() public {
        MockOtherToken other = new MockOtherToken();
        other.mint(address(esc), 5e18);
        esc.rescueToken(address(other), treasury, 5e18);
        assertEq(other.balanceOf(treasury), 5e18);
        vm.expectRevert(WebazEscrow.CannotRescueEscrowToken.selector);
        esc.rescueToken(address(usdc), treasury, 1);
    }

    function test_noArbitraryDrain_lockedFundsOnlyExitViaEnumeratedPaths() public {
        _deposit(orderId, 40e6, 200);
        // owner has zero fund power over a healthy escrow
        vm.expectRevert(WebazEscrow.CannotRescueEscrowToken.selector);
        esc.rescueToken(address(usdc), address(this), 40e6);
        // arbiter blocked while not disputed (tested above); attacker blocked everywhere
        vm.startPrank(attacker);
        vm.expectRevert(WebazEscrow.NotBuyer.selector);
        esc.buyerRelease(orderId);
        vm.expectRevert(WebazEscrow.NotYetAutoReleasable.selector);
        esc.autoRelease(orderId);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(esc)), 40e6);
    }
}
