// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerchantBondVault} from "../MerchantBondVault.sol";
import {MockUSDC, MockOtherToken} from "./mocks/MockUSDC.sol";

/**
 * MerchantBondVault v1 — Foundry unit tests (testnet/dev).
 * Covers design invariants: conservation, role separation (relayer has no fund power),
 * EIP-712 + nonce/replay, slash→penaltyReserve only + cooling, orthogonal pause, unattributed
 * inflow handling, rescue safety, and no-arbitrary-drain.
 */
contract MerchantBondVaultTest is Test {
    MerchantBondVault internal vault;
    MockUSDC internal usdc;

    // typehashes (must mirror the contract verbatim)
    bytes32 private constant REGISTER_TYPEHASH =
        keccak256("RegisterWallet(bytes32 sellerId,address wallet,uint256 nonce,uint256 authExpiresAt)");
    bytes32 private constant ROTATE_TYPEHASH = keccak256(
        "RotateWallet(bytes32 sellerId,address oldWallet,address newWallet,uint256 nonce,uint256 authExpiresAt)"
    );
    bytes32 private constant WITHDRAW_TYPEHASH = keccak256(
        "WithdrawCollateral(bytes32 sellerId,address destination,uint256 amount,uint256 minRemainingCollateral,uint256 coolDownEnd,uint256 snapshotVersion,uint256 nonce,uint256 authExpiresAt)"
    );

    uint256 internal constant MIN_BOND = 500e6; // 500 USDC
    uint256 internal constant COOLDOWN = 2 days;

    uint256 internal signerPk = 0xA11CE;
    uint256 internal sellerPk = 0xB0B;
    uint256 internal seller2Pk = 0xB0B2;
    uint256 internal newWalletPk = 0xC0FFEE;

    address internal signer; // authorizationSigner (WebAZ)
    address internal wallet; // seller's registered bond wallet
    address internal wallet2;
    address internal newWallet;
    address internal penaltyReserve = makeAddr("penaltyReserve");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");

    bytes32 internal sellerId = keccak256("seller-1");
    bytes32 internal sellerId2 = keccak256("seller-2");

    function setUp() public {
        signer = vm.addr(signerPk);
        wallet = vm.addr(sellerPk);
        wallet2 = vm.addr(seller2Pk);
        newWallet = vm.addr(newWalletPk);
        usdc = new MockUSDC();
        // governance = address(this) for convenience; onlyGovernance gated calls come from the test.
        vault = new MerchantBondVault(address(this), signer, address(usdc), penaltyReserve, MIN_BOND, COOLDOWN);
        usdc.mint(wallet, 10_000e6);
        usdc.mint(wallet2, 10_000e6);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toTypedDataHash(vault.domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registerHash(bytes32 sid, address w, uint256 nonce, uint256 exp) internal pure returns (bytes32) {
        return keccak256(abi.encode(REGISTER_TYPEHASH, sid, w, nonce, exp));
    }

    function _register(bytes32 sid, uint256 walletPk, uint256 nonce) internal {
        address w = vm.addr(walletPk);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _sign(signerPk, _registerHash(sid, w, nonce, exp));
        vm.prank(w);
        vault.registerBondWallet(sid, w, nonce, exp, auth);
    }

    function _deposit(uint256 walletPk, bytes32 sid, uint256 amount) internal {
        address w = vm.addr(walletPk);
        vm.startPrank(w);
        usdc.approve(address(vault), amount);
        vault.depositCollateral(sid, amount);
        vm.stopPrank();
    }

    function _withdrawHash(
        bytes32 sid,
        address dest,
        uint256 amount,
        uint256 minRem,
        uint256 coolDownEnd,
        uint256 snap,
        uint256 nonce,
        uint256 exp
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(WITHDRAW_TYPEHASH, sid, dest, amount, minRem, coolDownEnd, snap, nonce, exp));
    }

    // ───────────────────────── registration ─────────────────────────

    function test_register_happyPath() public {
        _register(sellerId, sellerPk, 1);
        assertEq(vault.registeredBondWalletOf(sellerId), wallet);
        assertEq(vault.sellerIdOfWallet(wallet), sellerId);
        assertEq(uint256(vault.lifecycleOf(sellerId)), uint256(MerchantBondVault.SellerLifecycle.BelowMin));
        assertFalse(vault.isLocked(sellerId));
    }

    function test_register_revert_wrongSender() public {
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _sign(signerPk, _registerHash(sellerId, wallet, 1, exp));
        vm.prank(attacker); // not the wallet
        vm.expectRevert(MerchantBondVault.NotRegisteredWallet.selector);
        vault.registerBondWallet(sellerId, wallet, 1, exp, auth);
    }

    function test_register_revert_badAuthSig() public {
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _sign(sellerPk, _registerHash(sellerId, wallet, 1, exp)); // signed by wrong key
        vm.prank(wallet);
        vm.expectRevert(MerchantBondVault.BadAuthorizationSignature.selector);
        vault.registerBondWallet(sellerId, wallet, 1, exp, auth);
    }

    function test_register_revert_expired() public {
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _sign(signerPk, _registerHash(sellerId, wallet, 1, exp));
        vm.warp(exp + 1);
        vm.prank(wallet);
        vm.expectRevert(MerchantBondVault.AuthorizationExpired.selector);
        vault.registerBondWallet(sellerId, wallet, 1, exp, auth);
    }

    function test_register_revert_alreadyRegistered() public {
        _register(sellerId, sellerPk, 1);
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _sign(signerPk, _registerHash(sellerId, wallet, 2, exp));
        vm.prank(wallet);
        vm.expectRevert(MerchantBondVault.WalletAlreadyRegistered.selector);
        vault.registerBondWallet(sellerId, wallet, 2, exp, auth);
    }

    function test_register_revert_walletBoundToAnotherSeller() public {
        _register(sellerId, sellerPk, 1);
        // try to bind the same wallet to a different sellerId
        uint256 exp = block.timestamp + 1 hours;
        bytes memory auth = _sign(signerPk, _registerHash(sellerId2, wallet, 3, exp));
        vm.prank(wallet);
        vm.expectRevert(MerchantBondVault.WalletBoundToAnotherSeller.selector);
        vault.registerBondWallet(sellerId2, wallet, 3, exp, auth);
    }

    // (digest replay protection is exercised on a path where state doesn't otherwise block:
    //  see test_withdraw_revert_replay — registering twice hits WalletAlreadyRegistered first.)

    // ───────────────────────── deposit ─────────────────────────

    function test_deposit_happyPath_and_isLocked() public {
        _register(sellerId, sellerPk, 1);
        _deposit(sellerPk, sellerId, 200e6);
        assertEq(vault.collateralOf(sellerId), 200e6);
        assertEq(vault.totalCollateral(), 200e6);
        assertFalse(vault.isLocked(sellerId)); // below min
        _deposit(sellerPk, sellerId, 300e6);
        assertEq(vault.collateralOf(sellerId), 500e6);
        assertTrue(vault.isLocked(sellerId)); // at min
        assertEq(uint256(vault.lifecycleOf(sellerId)), uint256(MerchantBondVault.SellerLifecycle.Active));
        assertEq(usdc.balanceOf(address(vault)), 500e6);
    }

    function test_deposit_revert_notRegistered() public {
        vm.startPrank(wallet);
        usdc.approve(address(vault), 100e6);
        vm.expectRevert(MerchantBondVault.SellerNotRegistered.selector);
        vault.depositCollateral(sellerId, 100e6);
        vm.stopPrank();
    }

    function test_deposit_revert_notRegisteredWallet() public {
        _register(sellerId, sellerPk, 1);
        usdc.mint(attacker, 100e6);
        vm.startPrank(attacker);
        usdc.approve(address(vault), 100e6);
        vm.expectRevert(MerchantBondVault.NotRegisteredWallet.selector);
        vault.depositCollateral(sellerId, 100e6);
        vm.stopPrank();
    }

    function test_deposit_revert_whenDepositsPaused() public {
        _register(sellerId, sellerPk, 1);
        vault.setPaused(vault.DEPOSITS_PAUSED(), true);
        vm.startPrank(wallet);
        usdc.approve(address(vault), 100e6);
        vm.expectRevert(abi.encodeWithSelector(MerchantBondVault.ActionPaused.selector, vault.DEPOSITS_PAUSED()));
        vault.depositCollateral(sellerId, 100e6);
        vm.stopPrank();
    }

    function test_deposit_revert_whenGlobalPaused() public {
        _register(sellerId, sellerPk, 1);
        vault.setPaused(vault.GLOBAL_PAUSED(), true);
        vm.startPrank(wallet);
        usdc.approve(address(vault), 100e6);
        vm.expectRevert(MerchantBondVault.GloballyPaused.selector);
        vault.depositCollateral(sellerId, 100e6);
        vm.stopPrank();
    }

    // ───────────────────────── withdraw ─────────────────────────

    function _setupFunded() internal {
        _register(sellerId, sellerPk, 1);
        _deposit(sellerPk, sellerId, 800e6);
    }

    function test_withdraw_happyPath_relayerSubmits() public {
        _setupFunded();
        vm.warp(1_000_000); // absolute clock so cooldown is unambiguously in the past
        uint256 amount = 300e6;
        uint256 coolDownEnd = 500_000; // already elapsed
        uint256 exp = 2_000_000; // not yet expired
        bytes32 sh = _withdrawHash(sellerId, wallet, amount, 500e6, coolDownEnd, 42, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);

        uint256 walletBalBefore = usdc.balanceOf(wallet);
        // submitted by a relayer (NOT the wallet) — proves relayer is just a broadcaster.
        vm.prank(relayer);
        vault.sellerWithdrawCollateral(sellerId, wallet, amount, 500e6, coolDownEnd, 42, 1, exp, webaz, sellerSig);

        assertEq(vault.collateralOf(sellerId), 500e6);
        assertEq(vault.totalCollateral(), 500e6);
        assertEq(usdc.balanceOf(wallet), walletBalBefore + amount);
        assertEq(usdc.balanceOf(address(vault)), 500e6);
    }

    function test_withdraw_revert_coolDownNotElapsed() public {
        _setupFunded();
        uint256 coolDownEnd = block.timestamp + 1 days;
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 100e6, 0, coolDownEnd, 1, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(MerchantBondVault.CoolDownNotElapsed.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, coolDownEnd, 1, 1, exp, webaz, sellerSig);
    }

    function test_withdraw_revert_wrongDestination() public {
        _setupFunded();
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, attacker, 100e6, 0, 0, 1, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(MerchantBondVault.WrongDestination.selector);
        vault.sellerWithdrawCollateral(sellerId, attacker, 100e6, 0, 0, 1, 1, exp, webaz, sellerSig);
    }

    function test_withdraw_revert_minRemainingViolated() public {
        _setupFunded();
        uint256 exp = block.timestamp + 7 days;
        // withdraw 400 but require >=500 remaining → 800-400=400 < 500
        bytes32 sh = _withdrawHash(sellerId, wallet, 400e6, 500e6, 0, 1, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(MerchantBondVault.MinRemainingViolated.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 400e6, 500e6, 0, 1, 1, exp, webaz, sellerSig);
    }

    function test_withdraw_revert_amountExceedsCollateral() public {
        _setupFunded();
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 900e6, 0, 0, 1, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(MerchantBondVault.InsufficientCollateral.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 900e6, 0, 0, 1, 1, exp, webaz, sellerSig);
    }

    function test_withdraw_revert_badSellerSig() public {
        _setupFunded();
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 100e6, 0, 0, 1, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory badSeller = _sign(seller2Pk, sh); // wrong seller key
        vm.expectRevert(MerchantBondVault.BadSellerSignature.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 1, 1, exp, webaz, badSeller);
    }

    function test_withdraw_revert_badWebazSig() public {
        _setupFunded();
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 100e6, 0, 0, 1, 1, exp);
        bytes memory badWebaz = _sign(sellerPk, sh); // signed by seller, not authorizationSigner
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(MerchantBondVault.BadAuthorizationSignature.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 1, 1, exp, badWebaz, sellerSig);
    }

    function test_withdraw_revert_replay() public {
        _setupFunded();
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 100e6, 0, 0, 7, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 7, 1, exp, webaz, sellerSig);
        vm.expectRevert(MerchantBondVault.AuthorizationAlreadyUsed.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 7, 1, exp, webaz, sellerSig);
    }

    function test_withdraw_revert_whenWithdrawPaused_butDepositStillWorks() public {
        _setupFunded();
        vault.setPaused(vault.WITHDRAW_PAUSED(), true);
        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 100e6, 0, 0, 1, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(abi.encodeWithSelector(MerchantBondVault.ActionPaused.selector, vault.WITHDRAW_PAUSED()));
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 1, 1, exp, webaz, sellerSig);
        // deposits still work (orthogonal pause)
        _deposit(sellerPk, sellerId, 50e6);
        assertEq(vault.collateralOf(sellerId), 850e6);
    }

    // ───────────────────────── rotate ─────────────────────────

    function test_rotate_happyPath() public {
        _setupFunded();
        uint256 exp = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(ROTATE_TYPEHASH, sellerId, wallet, newWallet, 1, exp));
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory oldSig = _sign(sellerPk, sh);
        vm.prank(newWallet); // must be the new wallet (proves control)
        vault.rotateBondWallet(sellerId, newWallet, 1, exp, webaz, oldSig);
        assertEq(vault.registeredBondWalletOf(sellerId), newWallet);
        assertEq(vault.sellerIdOfWallet(newWallet), sellerId);
        assertEq(vault.sellerIdOfWallet(wallet), bytes32(0)); // old unbound
        assertEq(vault.collateralOf(sellerId), 800e6); // collateral preserved
    }

    function test_rotate_revert_notNewWalletSender() public {
        _setupFunded();
        uint256 exp = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(ROTATE_TYPEHASH, sellerId, wallet, newWallet, 1, exp));
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory oldSig = _sign(sellerPk, sh);
        vm.prank(attacker);
        vm.expectRevert(MerchantBondVault.NotRegisteredWallet.selector);
        vault.rotateBondWallet(sellerId, newWallet, 1, exp, webaz, oldSig);
    }

    function test_rotate_revert_badOldWalletSig() public {
        _setupFunded();
        uint256 exp = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(ROTATE_TYPEHASH, sellerId, wallet, newWallet, 1, exp));
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory badOld = _sign(seller2Pk, sh);
        vm.prank(newWallet);
        vm.expectRevert(MerchantBondVault.BadSellerSignature.selector);
        vault.rotateBondWallet(sellerId, newWallet, 1, exp, webaz, badOld);
    }

    // ───────────────────────── slash ─────────────────────────

    function test_slash_proposeExecute_toPenaltyReserveOnly() public {
        _setupFunded();
        vault.proposeSlash(sellerId, 200e6, keccak256("arbitration-final"));
        // cannot execute before cooldown
        vm.expectRevert(MerchantBondVault.CoolDownNotElapsed.selector);
        vault.executeSlash(sellerId);

        vm.warp(block.timestamp + COOLDOWN + 1);
        uint256 reserveBefore = usdc.balanceOf(penaltyReserve);
        vault.executeSlash(sellerId);
        assertEq(usdc.balanceOf(penaltyReserve), reserveBefore + 200e6);
        assertEq(vault.collateralOf(sellerId), 600e6);
        assertEq(vault.totalCollateral(), 600e6);
        assertTrue(vault.isLocked(sellerId)); // 600 >= 500 still active
    }

    function test_slash_revert_proposeNotGovernance() public {
        _setupFunded();
        vm.prank(attacker);
        vm.expectRevert(MerchantBondVault.NotGovernance.selector);
        vault.proposeSlash(sellerId, 100e6, bytes32(0));
    }

    function test_slash_authorizationSigner_cannotSlash() public {
        _setupFunded();
        vm.prank(signer); // the WebAZ signer is NOT governance
        vm.expectRevert(MerchantBondVault.NotGovernance.selector);
        vault.proposeSlash(sellerId, 100e6, bytes32(0));
    }

    function test_slash_cancel() public {
        _setupFunded();
        vault.proposeSlash(sellerId, 200e6, bytes32(0));
        vault.cancelSlash(sellerId);
        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.expectRevert(MerchantBondVault.NoPendingSlash.selector);
        vault.executeSlash(sellerId);
        assertEq(vault.collateralOf(sellerId), 800e6); // untouched
    }

    function test_slash_revert_doublePending() public {
        _setupFunded();
        vault.proposeSlash(sellerId, 100e6, bytes32(0));
        vm.expectRevert(MerchantBondVault.SlashAlreadyPending.selector);
        vault.proposeSlash(sellerId, 50e6, bytes32(0));
    }

    function test_slash_executeClampsToCurrentCollateral() public {
        _setupFunded();
        vault.proposeSlash(sellerId, 700e6, bytes32(0));
        // seller withdraws down to 500 in the meantime
        uint256 exp = block.timestamp + 30 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 300e6, 0, 0, 9, 1, exp);
        bytes memory webaz = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vault.sellerWithdrawCollateral(sellerId, wallet, 300e6, 0, 0, 9, 1, exp, webaz, sellerSig);
        assertEq(vault.collateralOf(sellerId), 500e6);

        vm.warp(block.timestamp + COOLDOWN + 1);
        vault.executeSlash(sellerId); // clamps 700 → 500
        assertEq(vault.collateralOf(sellerId), 0);
        assertEq(vault.totalCollateral(), 0);
        assertEq(usdc.balanceOf(penaltyReserve), 500e6);
    }

    // ───────────────────────── signer rotation ─────────────────────────

    function test_rotateSigner_oldSignerRejected_newAccepted() public {
        _setupFunded();
        uint256 newSignerPk = 0xDEAD;
        address newSigner = vm.addr(newSignerPk);
        vault.rotateAuthorizationSigner(newSigner);
        assertEq(vault.authorizationSigner(), newSigner);

        uint256 exp = block.timestamp + 7 days;
        bytes32 sh = _withdrawHash(sellerId, wallet, 100e6, 0, 0, 1, 1, exp);
        // old signer no longer valid
        bytes memory oldAuth = _sign(signerPk, sh);
        bytes memory sellerSig = _sign(sellerPk, sh);
        vm.expectRevert(MerchantBondVault.BadAuthorizationSignature.selector);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 1, 1, exp, oldAuth, sellerSig);
        // new signer works
        bytes memory newAuth = _sign(newSignerPk, sh);
        vault.sellerWithdrawCollateral(sellerId, wallet, 100e6, 0, 0, 1, 1, exp, newAuth, sellerSig);
        assertEq(vault.collateralOf(sellerId), 700e6);
    }

    // ───────────────────────── unattributed inflow ─────────────────────────

    function test_unattributed_rawTransferNotAutoCredited() public {
        _register(sellerId, sellerPk, 1);
        // raw transfer (NOT via depositCollateral)
        vm.prank(wallet);
        usdc.transfer(address(vault), 500e6);
        assertEq(vault.collateralOf(sellerId), 0); // not credited
        assertFalse(vault.isLocked(sellerId)); // no auto eligibility
        assertEq(vault.unattributedUsdc(), 500e6);
    }

    function test_unattributed_creditToSeller_boundedByExcess() public {
        _register(sellerId, sellerPk, 1);
        vm.prank(wallet);
        usdc.transfer(address(vault), 500e6);
        // cannot credit more than the excess
        vm.expectRevert(MerchantBondVault.InsufficientUnattributed.selector);
        vault.creditUnattributedCollateral(sellerId, 501e6, bytes32(0));
        vault.creditUnattributedCollateral(sellerId, 500e6, keccak256("ticket"));
        assertEq(vault.collateralOf(sellerId), 500e6);
        assertTrue(vault.isLocked(sellerId));
        assertEq(vault.unattributedUsdc(), 0);
    }

    function test_unattributed_returnExcess_neverTouchesCollateral() public {
        _setupFunded(); // 800 collateral
        vm.prank(wallet2);
        usdc.transfer(address(vault), 123e6); // unattributed
        assertEq(vault.unattributedUsdc(), 123e6);
        // returning more than excess reverts (cannot dip into collateral)
        vm.expectRevert(MerchantBondVault.InsufficientUnattributed.selector);
        vault.returnUnattributedInflow(attacker, 124e6, bytes32(0));
        vault.returnUnattributedInflow(wallet2, 123e6, keccak256("refund"));
        assertEq(vault.collateralOf(sellerId), 800e6);
        assertEq(vault.totalCollateral(), 800e6);
        assertEq(usdc.balanceOf(address(vault)), 800e6);
    }

    // ───────────────────────── no arbitrary drain ─────────────────────────

    function test_noDrain_governanceCannotPullCollateralViaReturn() public {
        _setupFunded(); // 800 collateral, zero excess
        assertEq(vault.unattributedUsdc(), 0);
        // governance attempts to siphon collateral via the unattributed path → reverts.
        vm.expectRevert(MerchantBondVault.InsufficientUnattributed.selector);
        vault.returnUnattributedInflow(attacker, 1, bytes32(0));
    }

    function test_noDrain_rescueRejectsCollateralUSDC() public {
        _setupFunded();
        vm.expectRevert(MerchantBondVault.CannotRescueCollateralToken.selector);
        vault.rescueNonWhitelistedToken(address(usdc), attacker, 1);
    }

    function test_rescue_nonWhitelistedToken() public {
        MockOtherToken other = new MockOtherToken();
        other.mint(address(vault), 1_000e18);
        vault.rescueNonWhitelistedToken(address(other), wallet, 1_000e18);
        assertEq(other.balanceOf(wallet), 1_000e18);
    }

    // ───────────────────────── governance transfer ─────────────────────────

    function test_governanceTransfer_twoStep() public {
        address newGov = makeAddr("newGov");
        vault.transferGovernance(newGov);
        assertEq(vault.governance(), address(this)); // not yet
        // only pending can accept
        vm.prank(attacker);
        vm.expectRevert(MerchantBondVault.NotGovernance.selector);
        vault.acceptGovernance();
        vm.prank(newGov);
        vault.acceptGovernance();
        assertEq(vault.governance(), newGov);
        // old governance now powerless. Cache the selector BEFORE arming expectRevert — an external
        // call (GLOBAL_PAUSED()) in the arg position would otherwise consume the armed expectRevert.
        bytes4 globalFlag = vault.GLOBAL_PAUSED();
        vm.expectRevert(MerchantBondVault.NotGovernance.selector);
        vault.setPaused(globalFlag, true);
    }

    // ───────────────────────── constructor fail-closed ─────────────────────────

    function test_constructor_revert_zeroBaseBondMin() public {
        vm.expectRevert(MerchantBondVault.ZeroAmount.selector);
        new MerchantBondVault(address(this), signer, address(usdc), penaltyReserve, 0, COOLDOWN);
    }

    function test_constructor_revert_zeroCoolDown() public {
        vm.expectRevert(MerchantBondVault.ZeroAmount.selector);
        new MerchantBondVault(address(this), signer, address(usdc), penaltyReserve, MIN_BOND, 0);
    }

    // ───────────────────────── penaltyReserve change (timelocked 2-step) ─────────────────────────

    function test_penaltyReserve_twoStepDelayedChange() public {
        address newReserve = makeAddr("newReserve");
        vault.proposePenaltyReserve(newReserve);
        assertEq(vault.penaltyReserve(), penaltyReserve); // unchanged before delay
        vm.expectRevert(MerchantBondVault.CoolDownNotElapsed.selector);
        vault.executePenaltyReserveChange();
        vm.warp(block.timestamp + COOLDOWN + 1);
        vault.executePenaltyReserveChange();
        assertEq(vault.penaltyReserve(), newReserve);
    }

    function test_penaltyReserve_revert_proposeNotGovernance() public {
        vm.prank(attacker);
        vm.expectRevert(MerchantBondVault.NotGovernance.selector);
        vault.proposePenaltyReserve(makeAddr("x"));
    }

    function test_penaltyReserve_cancel() public {
        address newReserve = makeAddr("newReserve");
        vault.proposePenaltyReserve(newReserve);
        vault.cancelPenaltyReserveChange();
        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.expectRevert(MerchantBondVault.NoPendingReserveChange.selector);
        vault.executePenaltyReserveChange();
        assertEq(vault.penaltyReserve(), penaltyReserve);
    }

    /// @dev An in-flight slash must pay the sink snapshotted at propose time, even if the reserve changes.
    function test_slash_inFlightUsesSnapshotSink() public {
        _setupFunded(); // 800
        vault.proposeSlash(sellerId, 200e6, bytes32(0)); // snapshot sink = original penaltyReserve (A)
        address newReserve = makeAddr("newReserve2");
        vault.proposePenaltyReserve(newReserve);
        vm.warp(block.timestamp + COOLDOWN + 1);
        vault.executePenaltyReserveChange(); // reserve is now B
        assertEq(vault.penaltyReserve(), newReserve);

        uint256 aBefore = usdc.balanceOf(penaltyReserve);
        uint256 bBefore = usdc.balanceOf(newReserve);
        vault.executeSlash(sellerId);
        assertEq(usdc.balanceOf(penaltyReserve), aBefore + 200e6); // A (snapshot) received
        assertEq(usdc.balanceOf(newReserve), bBefore); // B did NOT
    }

    // ───────────────────────── conservation (fuzz) ─────────────────────────

    function testFuzz_conservation_depositWithdraw(uint96 dep, uint96 wd) public {
        vm.assume(dep > 0 && dep <= 9_000e6);
        _register(sellerId, sellerPk, 1);
        usdc.mint(wallet, dep);
        vm.startPrank(wallet);
        usdc.approve(address(vault), dep);
        vault.depositCollateral(sellerId, dep);
        vm.stopPrank();

        uint256 amount = uint256(wd) % (uint256(dep) + 1); // 0..dep
        if (amount > 0) {
            uint256 exp = block.timestamp + 7 days;
            bytes32 sh = _withdrawHash(sellerId, wallet, amount, 0, 0, 1, 1, exp);
            bytes memory webaz = _sign(signerPk, sh);
            bytes memory sellerSig = _sign(sellerPk, sh);
            vault.sellerWithdrawCollateral(sellerId, wallet, amount, 0, 0, 1, 1, exp, webaz, sellerSig);
        }
        // invariant: totalCollateral == seller collateral, and balance covers it.
        assertEq(vault.totalCollateral(), vault.collateralOf(sellerId));
        assertGe(usdc.balanceOf(address(vault)), vault.totalCollateral());
    }
}
