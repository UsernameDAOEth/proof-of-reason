// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IKuruMarginAccount, KuruGate} from "../src/KuruGate.sol";

/// @dev Kuru OrderBook and Router entry points. Signatures from the official SDK ABIs
/// (kuru-labs/kuru-sdk 0.0.95); see docs/MONAD.md section 11.
interface IKuruOrderBook {
    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external;
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
}

contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @dev Records what the gate forwarded and, when asked, pulls the quote token mid-call to prove
/// the approval was live.
contract MockVenue {
    error VenueFailure();

    uint256 public calls;
    bytes public lastData;
    uint256 public lastValue;
    address public lastCaller;
    IERC20 public quote;
    uint256 public pullAmount;
    bool public shouldRevert;

    constructor(IERC20 quote_) {
        quote = quote_;
    }

    function setPull(uint256 amount) external {
        pullAmount = amount;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function batchUpdate(
        uint32[] calldata,
        uint96[] calldata,
        uint32[] calldata,
        uint96[] calldata,
        uint40[] calldata,
        bool
    ) external {
        _record();
    }

    function placeAndExecuteMarketBuy(uint96, uint256, bool, bool) external payable returns (uint256) {
        _record();
        return 0;
    }

    function _record() internal {
        if (shouldRevert) revert VenueFailure();
        calls += 1;
        lastData = msg.data;
        lastValue = msg.value;
        lastCaller = msg.sender;
        if (pullAmount > 0) quote.transferFrom(msg.sender, address(this), pullAmount);
    }
}

/// @dev Kuru's MarginAccount as the gate uses it: deposit credits the user it is given, withdraw
/// moves only the caller's own balance, to the caller. Selectors checked against docs/MONAD.md
/// section 11: deposit 0x8340f549, withdraw 0x00f714ce.
contract MockMarginAccount {
    mapping(address user => mapping(address token => uint256 amount)) public balance;

    function deposit(address user, address token, uint256 amount) external payable {
        if (token == address(0)) {
            require(msg.value == amount, "value != amount");
        } else {
            require(msg.value == 0, "native value on a token deposit");
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }
        balance[user][token] += amount;
    }

    function withdraw(uint256 amount, address token) external {
        require(balance[msg.sender][token] >= amount, "margin balance");
        balance[msg.sender][token] -= amount;
        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok, "native transfer");
        } else {
            IERC20(token).transfer(msg.sender, amount);
        }
    }

    function getBalance(address user, address token) external view returns (uint256) {
        return balance[user][token];
    }
}

contract Untouched {
    uint256 public calls;

    fallback() external payable {
        calls += 1;
    }
}

contract KuruGateTest is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant INTENT_TYPEHASH =
        keccak256("Intent(address vault,bytes32 dataHash,bytes32 claimsHash,uint256 nonce,uint64 notAfterBlock)");
    bytes32 internal constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 intentHash,uint8 outcome,uint64 checkedAtBlock,bytes32 receiptHash)");
    bytes32 internal constant OVERRIDE_TYPEHASH = keccak256("Override(bytes32 intentHash)");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint8 internal constant PASS = 1;
    uint8 internal constant WAIT = 2;
    uint8 internal constant FAIL = 3;
    uint64 internal constant DEFAULT_MAX_AGE = 60;

    struct Call {
        bytes data;
        bytes32 claimsHash;
        uint256 nonce;
        uint64 notAfterBlock;
        uint8 outcome;
        uint64 checkedAtBlock;
        bytes32 receiptHash;
    }

    KuruGate internal gate;
    MockVenue internal venue;
    MockMarginAccount internal margin;
    MockUsdc internal usdc;
    Untouched internal untouched;

    uint256 internal ownerKey = 0xA11CE;
    uint256 internal validatorKey = 0xB0B;
    address internal owner;
    address internal validator;
    address internal agent = makeAddr("agent");

    function setUp() public {
        vm.roll(1_000);
        owner = vm.addr(ownerKey);
        validator = vm.addr(validatorKey);
        usdc = new MockUsdc();
        venue = new MockVenue(IERC20(address(usdc)));
        margin = new MockMarginAccount();
        untouched = new Untouched();
        gate = _deployGate(address(venue));
        usdc.mint(address(gate), 1_000e6);
        vm.deal(address(gate), 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _selectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](3);
        selectors[0] = IKuruOrderBook.batchUpdate.selector;
        selectors[1] = IKuruOrderBook.placeAndExecuteMarketBuy.selector;
        selectors[2] = IKuruOrderBook.placeAndExecuteMarketSell.selector;
    }

    function _deployGate(address venue_) internal returns (KuruGate) {
        return new KuruGate(
            owner, venue_, address(usdc), address(0), address(margin), validator, agent, _selectors()
        );
    }

    /// @dev One post-only limit order, the call jev-trader makes every block.
    function _batchUpdateData(uint32 price, uint96 size) internal pure returns (bytes memory) {
        uint32[] memory buyPrices = new uint32[](1);
        uint96[] memory buySizes = new uint96[](1);
        buyPrices[0] = price;
        buySizes[0] = size;
        return abi.encodeCall(
            IKuruOrderBook.batchUpdate, (buyPrices, buySizes, new uint32[](0), new uint96[](0), new uint40[](0), true)
        );
    }

    function _call(uint8 outcome) internal view returns (Call memory c) {
        c = Call({
            data: _batchUpdateData(2_518_800, 200e10),
            claimsHash: keccak256("claims"),
            nonce: 7,
            notAfterBlock: uint64(block.number + 10),
            outcome: outcome,
            checkedAtBlock: uint64(block.number - 1),
            receiptHash: keccak256("receipt")
        });
    }

    function _domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Proof of Reason"), keccak256("1"), chainId, verifyingContract)
        );
    }

    function _typed(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _intentHashFor(Call memory c, uint256 chainId, address gateAddr) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(INTENT_TYPEHASH, address(venue), keccak256(c.data), c.claimsHash, c.nonce, c.notAfterBlock)
        );
        return _typed(_domainSeparator(chainId, gateAddr), structHash);
    }

    function _intentHash(Call memory c) internal view returns (bytes32) {
        return _intentHashFor(c, block.chainid, address(gate));
    }

    function _verdictDigestFor(Call memory c, uint256 chainId, address gateAddr) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                VERDICT_TYPEHASH, _intentHashFor(c, chainId, gateAddr), c.outcome, c.checkedAtBlock, c.receiptHash
            )
        );
        return _typed(_domainSeparator(chainId, gateAddr), structHash);
    }

    function _overrideDigest(Call memory c) internal view returns (bytes32) {
        return _typed(
            _domainSeparator(block.chainid, address(gate)), keccak256(abi.encode(OVERRIDE_TYPEHASH, _intentHash(c)))
        );
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signVerdictFor(uint256 key, Call memory c, uint256 chainId, address gateAddr)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, _verdictDigestFor(c, chainId, gateAddr));
    }

    function _signVerdict(Call memory c) internal view returns (bytes memory) {
        return _signVerdictFor(validatorKey, c, block.chainid, address(gate));
    }

    function _exec(KuruGate target, Call memory c, bytes memory validatorSig, bytes memory ownerSig) internal {
        vm.prank(agent);
        target.execute(
            c.data,
            c.claimsHash,
            c.nonce,
            c.notAfterBlock,
            c.outcome,
            c.checkedAtBlock,
            c.receiptHash,
            validatorSig,
            ownerSig
        );
    }

    function _exec(Call memory c, bytes memory validatorSig, bytes memory ownerSig) internal {
        _exec(gate, c, validatorSig, ownerSig);
    }

    // ---------------------------------------------------------------- setup and selectors

    function test_initialState() public view {
        assertEq(gate.owner(), owner);
        assertEq(gate.venue(), address(venue));
        assertEq(gate.quoteToken(), address(usdc));
        assertEq(gate.baseToken(), address(0));
        assertEq(gate.validator(), validator);
        assertEq(gate.agent(), agent);
        assertEq(gate.maxAgeBlocks(), DEFAULT_MAX_AGE);
        assertEq(gate.DEFAULT_MAX_AGE_BLOCKS(), DEFAULT_MAX_AGE);
        assertEq(usdc.balanceOf(address(gate)), 1_000e6);
        assertEq(address(gate).balance, 100 ether);
    }

    function test_selectorsComeFromTheKuruAbis() public view {
        assertEq(
            IKuruOrderBook.batchUpdate.selector,
            bytes4(keccak256("batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)"))
        );
        assertEq(
            IKuruOrderBook.placeAndExecuteMarketBuy.selector,
            bytes4(keccak256("placeAndExecuteMarketBuy(uint96,uint256,bool,bool)"))
        );
        assertEq(
            IKuruOrderBook.placeAndExecuteMarketSell.selector,
            bytes4(keccak256("placeAndExecuteMarketSell(uint96,uint256,bool,bool)"))
        );
        assertTrue(gate.allowedSelector(IKuruOrderBook.batchUpdate.selector));
        assertTrue(gate.allowedSelector(IKuruOrderBook.placeAndExecuteMarketBuy.selector));
        assertTrue(gate.allowedSelector(IKuruOrderBook.placeAndExecuteMarketSell.selector));
    }

    function test_blocklist_computedFromInterfaces() public view {
        assertEq(gate.BLOCKED_TRANSFER(), bytes4(keccak256("transfer(address,uint256)")));
        assertEq(gate.BLOCKED_TRANSFER_FROM(), bytes4(keccak256("transferFrom(address,address,uint256)")));
        assertEq(gate.BLOCKED_APPROVE(), bytes4(keccak256("approve(address,uint256)")));
        assertEq(gate.BLOCKED_MARGIN_WITHDRAW(), bytes4(keccak256("withdraw(uint256,address)")));
        assertEq(gate.BLOCKED_MARGIN_BATCH_WITHDRAW(), bytes4(keccak256("batchWithdrawMaxTokens(address[])")));
        assertFalse(gate.isBlockedSelector(IKuruOrderBook.batchUpdate.selector));
    }

    function test_blocklist_cannotBeAllowlisted() public {
        bytes4[5] memory blocked = [
            gate.BLOCKED_TRANSFER(),
            gate.BLOCKED_TRANSFER_FROM(),
            gate.BLOCKED_APPROVE(),
            gate.BLOCKED_MARGIN_WITHDRAW(),
            gate.BLOCKED_MARGIN_BATCH_WITHDRAW()
        ];
        for (uint256 i; i < blocked.length; ++i) {
            assertTrue(gate.isBlockedSelector(blocked[i]));
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(KuruGate.SelectorBlocked.selector, blocked[i]));
            gate.setAllowedSelector(blocked[i], true);

            bytes4[] memory withBlocked = new bytes4[](1);
            withBlocked[0] = blocked[i];
            vm.expectRevert(abi.encodeWithSelector(KuruGate.SelectorBlocked.selector, blocked[i]));
            new KuruGate(owner, address(venue), address(usdc), address(0), address(margin), validator, agent, withBlocked);
        }
    }

    function test_disallowedSelector_reverts() public {
        Call memory c = _call(PASS);
        c.data = abi.encodeWithSignature("cancelAllOrders()");
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(KuruGate.SelectorNotAllowed.selector, bytes4(c.data)));
        _exec(c, sig, "");
        assertEq(venue.calls(), 0);
    }

    function test_constructor_rejectsZeroVenue() public {
        vm.expectRevert(KuruGate.ZeroVenue.selector);
        new KuruGate(owner, address(0), address(usdc), address(0), address(margin), validator, agent, _selectors());
    }

    // ---------------------------------------------------------------- forwarding and approvals

    function test_pass_forwardsExactCalldataToTheVenueWithNoValue() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.expectEmit(true, false, false, true, address(gate));
        emit KuruGate.Executed(_intentHash(c), PASS, c.receiptHash, false);
        _exec(c, sig, "");

        assertEq(venue.calls(), 1);
        assertEq(venue.lastData(), c.data);
        assertEq(venue.lastCaller(), address(gate));
        assertEq(venue.lastValue(), 0);
        assertEq(address(gate).balance, 100 ether);
        assertTrue(gate.usedNonce(c.nonce));
        assertEq(untouched.calls(), 0);
    }

    function test_approvalIsLiveDuringTheCallAndZeroAfter() public {
        venue.setPull(250e6);
        Call memory c = _call(PASS);
        _exec(c, _signVerdict(c), "");

        assertEq(usdc.balanceOf(address(venue)), 250e6);
        assertEq(usdc.balanceOf(address(gate)), 750e6);
        assertEq(usdc.allowance(address(gate), address(venue)), 0);
    }

    function test_approvalIsZeroAfterACallThatPullsNothing() public {
        Call memory c = _call(PASS);
        _exec(c, _signVerdict(c), "");
        assertEq(usdc.allowance(address(gate), address(venue)), 0);
        assertEq(usdc.balanceOf(address(gate)), 1_000e6);
    }

    function test_venueRevert_bubblesAndKeepsNonce() public {
        venue.setShouldRevert(true);
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(MockVenue.VenueFailure.selector);
        _exec(c, sig, "");
        assertFalse(gate.usedNonce(c.nonce));
        assertEq(usdc.allowance(address(gate), address(venue)), 0);
    }

    function test_onlyTheVenueIsEverCalledAndItCannotBeRetargeted() public {
        // The venue is immutable: there is no setter to call, and the calldata cannot redirect it.
        (bool found,) = address(gate).call(abi.encodeWithSignature("setVenue(address)", address(untouched)));
        assertFalse(found);
        Call memory c = _call(PASS);
        c.data = abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketBuy, (1e10, 0, false, false));
        _exec(c, _signVerdict(c), "");
        assertEq(venue.calls(), 1);
        assertEq(untouched.calls(), 0);
        assertEq(gate.venue(), address(venue));
    }

    // ---------------------------------------------------------------- funds stay with the owner

    function test_agentCannotWithdraw() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent);
        vm.startPrank(agent);
        vm.expectRevert(err);
        gate.withdraw(address(usdc), 1e6, agent);
        vm.expectRevert(err);
        gate.withdraw(address(0), 1 ether, agent);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(gate)), 1_000e6);
        assertEq(address(gate).balance, 100 ether);
    }

    function test_validatorAndStrangerCannotWithdraw() public {
        address stranger = makeAddr("stranger");
        address[2] memory callers = [validator, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            gate.withdraw(address(usdc), 1e6, callers[i]);
        }
    }

    function test_ownerWithdrawsTokenAndNative() public {
        address to = makeAddr("treasury");
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, true, address(gate));
        emit KuruGate.Withdrawn(address(usdc), to, 400e6);
        gate.withdraw(address(usdc), 400e6, to);
        gate.withdraw(address(0), 10 ether, to);
        vm.stopPrank();

        assertEq(usdc.balanceOf(to), 400e6);
        assertEq(usdc.balanceOf(address(gate)), 600e6);
        assertEq(to.balance, 10 ether);
        assertEq(address(gate).balance, 90 ether);
    }

    function test_gateAcceptsMon() public {
        vm.deal(owner, 5 ether);
        vm.prank(owner);
        (bool ok,) = address(gate).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(address(gate).balance, 105 ether);
    }

    // ---------------------------------------------------------------- verdict flow, mirroring ReasonGate

    function test_fail_revertsRefuted() public {
        Call memory c = _call(FAIL);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(KuruGate.Refuted.selector, _intentHash(c), c.receiptHash));
        _exec(c, sig, "");
        assertEq(venue.calls(), 0);
    }

    function test_wait_withoutOwnerSig_reverts() public {
        Call memory c = _call(WAIT);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(KuruGate.OverrideNotAuthorized.selector, _intentHash(c)));
        _exec(c, sig, "");
        assertEq(venue.calls(), 0);
    }

    function test_wait_withOwnerSig_executes() public {
        Call memory c = _call(WAIT);
        bytes memory ownerSig = _sign(ownerKey, _overrideDigest(c));
        bytes memory sig = _signVerdict(c);
        vm.expectEmit(true, false, false, true, address(gate));
        emit KuruGate.Executed(_intentHash(c), WAIT, c.receiptHash, true);
        _exec(c, sig, ownerSig);
        assertEq(venue.calls(), 1);
    }

    function test_verdictOlderThanMaxAge_reverts() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number - DEFAULT_MAX_AGE - 1);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(
            abi.encodeWithSelector(KuruGate.VerdictTooOld.selector, c.checkedAtBlock, block.number, DEFAULT_MAX_AGE)
        );
        _exec(c, sig, "");
    }

    function test_verdictExactlyMaxAge_executes() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number - DEFAULT_MAX_AGE);
        _exec(c, _signVerdict(c), "");
        assertEq(venue.calls(), 1);
    }

    function test_checkedAtBlockInFuture_reverts() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number + 1);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(KuruGate.VerdictFromFuture.selector, c.checkedAtBlock, block.number));
        _exec(c, sig, "");
    }

    function test_notAfterBlockPassed_reverts() public {
        Call memory c = _call(PASS);
        c.notAfterBlock = uint64(block.number - 1);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(KuruGate.IntentExpired.selector, c.notAfterBlock, block.number));
        _exec(c, sig, "");
    }

    function test_replayedNonce_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        _exec(c, sig, "");
        vm.expectRevert(abi.encodeWithSelector(KuruGate.NonceUsed.selector, c.nonce));
        _exec(c, sig, "");
        assertEq(venue.calls(), 1);
    }

    function test_calldataChangedAfterSigning_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        c.data = _batchUpdateData(2_518_800, 900e10);
        vm.expectPartialRevert(KuruGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
        assertEq(venue.calls(), 0);
    }

    function test_nonAgentCaller_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        address[2] memory callers = [owner, validator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(KuruGate.NotAgent.selector, callers[i]));
            gate.execute(
                c.data, c.claimsHash, c.nonce, c.notAfterBlock, c.outcome, c.checkedAtBlock, c.receiptHash, sig, ""
            );
        }
    }

    function test_oldValidatorRejectedAfterRotation() public {
        uint256 newValidatorKey = 0xC0FFEE;
        vm.prank(owner);
        gate.setValidator(vm.addr(newValidatorKey));
        Call memory c = _call(PASS);
        bytes memory stale = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(KuruGate.InvalidValidatorSignature.selector, validator));
        _exec(c, stale, "");
        _exec(c, _signVerdictFor(newValidatorKey, c, block.chainid, address(gate)), "");
        assertEq(venue.calls(), 1);
    }

    function test_highSSignature_rejected() public {
        Call memory c = _call(PASS);
        bytes32 digest = _verdictDigestFor(c, block.chainid, address(gate));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKey, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), validator);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        _exec(c, abi.encodePacked(r, highS, flippedV), "");
    }

    function test_verdictForAnotherChainIdOrAnotherGate_reverts() public {
        Call memory c = _call(PASS);
        vm.expectPartialRevert(KuruGate.InvalidValidatorSignature.selector);
        _exec(c, _signVerdictFor(validatorKey, c, block.chainid + 1, address(gate)), "");

        KuruGate other = _deployGate(address(venue));
        vm.expectPartialRevert(KuruGate.InvalidValidatorSignature.selector);
        _exec(gate, c, _signVerdictFor(validatorKey, c, block.chainid, address(other)), "");
        assertEq(venue.calls(), 0);
    }

    function test_invalidOutcome_reverts() public {
        uint8[2] memory bad = [uint8(0), uint8(4)];
        for (uint256 i; i < bad.length; ++i) {
            Call memory c = _call(bad[i]);
            bytes memory sig = _signVerdict(c);
            vm.expectRevert(abi.encodeWithSelector(KuruGate.InvalidOutcome.selector, bad[i]));
            _exec(c, sig, "");
        }
    }

    function test_ownerSetters_onlyOwner() public {
        address stranger = makeAddr("stranger");
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(err);
        gate.setValidator(stranger);
        vm.expectRevert(err);
        gate.setAgent(stranger);
        vm.expectRevert(err);
        gate.setMaxAgeBlocks(1);
        vm.expectRevert(err);
        gate.setAllowedSelector(IKuruOrderBook.batchUpdate.selector, false);
        vm.stopPrank();
    }

    // ------------------------------------------------- Kuru MarginAccount, owner only

    function test_depositMargin_owner_movesTokensIntoTheGatesOwnMarginBalance() public {
        vm.prank(owner);
        gate.depositMargin(address(usdc), 20e6);

        assertEq(margin.getBalance(address(gate), address(usdc)), 20e6);
        assertEq(gate.marginBalance(address(usdc)), 20e6);
        assertEq(usdc.balanceOf(address(gate)), 980e6);
        // The approval does not outlive the deposit.
        assertEq(usdc.allowance(address(gate), address(margin)), 0);
        // Nobody else was credited.
        assertEq(margin.getBalance(owner, address(usdc)), 0);
        assertEq(margin.getBalance(agent, address(usdc)), 0);
    }

    function test_depositMargin_owner_movesNativeMonIntoTheGatesOwnMarginBalance() public {
        vm.prank(owner);
        gate.depositMargin(address(0), 60 ether);

        assertEq(margin.getBalance(address(gate), address(0)), 60 ether);
        assertEq(address(gate).balance, 40 ether);
        assertEq(address(margin).balance, 60 ether);
    }

    function test_depositMargin_agentValidatorAndStrangerAllRevert() public {
        address stranger = makeAddr("stranger");
        address[3] memory callers = [agent, validator, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            gate.depositMargin(address(usdc), 20e6);
        }
        assertEq(margin.getBalance(address(gate), address(usdc)), 0);
        assertEq(usdc.balanceOf(address(gate)), 1_000e6);
    }

    function test_withdrawMargin_owner_pullsBackToTheGate_thenOnlyOwnerTakesItOut() public {
        vm.startPrank(owner);
        gate.depositMargin(address(usdc), 20e6);
        gate.depositMargin(address(0), 60 ether);

        gate.withdrawMargin(address(usdc), 20e6);
        gate.withdrawMargin(address(0), 60 ether);
        vm.stopPrank();

        // A margin withdrawal can only land in the gate: Kuru moves the caller's own balance.
        assertEq(margin.getBalance(address(gate), address(usdc)), 0);
        assertEq(usdc.balanceOf(address(gate)), 1_000e6);
        assertEq(address(gate).balance, 100 ether);

        vm.startPrank(owner);
        gate.withdraw(address(usdc), 1_000e6, owner);
        gate.withdraw(address(0), 100 ether, owner);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 1_000e6);
        assertEq(owner.balance, 100 ether);
        assertEq(usdc.balanceOf(address(gate)), 0);
    }

    function test_withdrawMargin_agentValidatorAndStrangerAllRevert() public {
        vm.prank(owner);
        gate.depositMargin(address(usdc), 20e6);

        address stranger = makeAddr("stranger");
        address[3] memory callers = [agent, validator, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            gate.withdrawMargin(address(usdc), 20e6);
        }
        assertEq(margin.getBalance(address(gate), address(usdc)), 20e6);
        assertEq(usdc.balanceOf(address(gate)), 980e6);
    }

    function test_agentCannotReachTheMarginAccountThroughExecute() public {
        vm.prank(owner);
        gate.depositMargin(address(usdc), 20e6);

        // The margin withdraw selector is not allowlisted, and can never be: it is blocked.
        Call memory c = _call(PASS);
        c.data = abi.encodeCall(IKuruMarginAccount.withdraw, (20e6, address(usdc)));
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(
            abi.encodeWithSelector(KuruGate.SelectorNotAllowed.selector, IKuruMarginAccount.withdraw.selector)
        );
        _exec(c, sig, "");

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(KuruGate.SelectorBlocked.selector, IKuruMarginAccount.withdraw.selector)
        );
        gate.setAllowedSelector(IKuruMarginAccount.withdraw.selector, true);

        // And a deposit selector, even once the owner allowlists it, is forwarded to the venue and
        // never to the margin account, because the venue is immutable. Here that call reverts in the
        // venue, which has no such function, and the margin balances are untouched.
        vm.prank(owner);
        gate.setAllowedSelector(IKuruMarginAccount.deposit.selector, true);
        Call memory d = _call(PASS);
        d.nonce = 8;
        d.data = abi.encodeCall(IKuruMarginAccount.deposit, (agent, address(usdc), 20e6));
        bytes memory depositSig = _signVerdict(d);
        vm.expectRevert();
        _exec(d, depositSig, "");
        assertEq(venue.calls(), 0);
        assertEq(margin.getBalance(address(gate), address(usdc)), 20e6);
        assertEq(margin.getBalance(agent, address(usdc)), 0);
        assertEq(usdc.allowance(address(gate), address(margin)), 0);
    }

    function test_marginFunctionsRevertWhenTheVenueHasNoMarginAccount() public {
        KuruGate noMargin =
            new KuruGate(owner, address(venue), address(usdc), address(0), address(0), validator, agent, _selectors());
        usdc.mint(address(noMargin), 10e6);

        vm.startPrank(owner);
        vm.expectRevert(KuruGate.MarginAccountNotSet.selector);
        noMargin.depositMargin(address(usdc), 10e6);
        vm.expectRevert(KuruGate.MarginAccountNotSet.selector);
        noMargin.withdrawMargin(address(usdc), 10e6);
        vm.stopPrank();
    }
}
