// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {IERC20 as IVaultV2ERC20} from "vault-v2/interfaces/IERC20.sol";
import {IERC4626 as IVaultV2ERC4626} from "vault-v2/interfaces/IERC4626.sol";
import {IMetaMorphoV1_1Base, MarketAllocation} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1.sol";
import {MarketParams} from "../lib/metamorpho-v1.1/lib/morpho-blue/src/interfaces/IMorpho.sol";

import {ReasonGate} from "../src/ReasonGate.sol";

/// @dev Records every call. Function signatures mirror the real vault ABIs; the test checks the
/// selectors against the Vault V2 and MetaMorpho V1.1 interfaces.
contract MockVault {
    error MockVaultFailure(uint256 code);

    uint256 public calls;
    bytes public lastData;
    address public lastCaller;
    bool public shouldRevert;
    address public reentryTarget;
    bytes public reentryData;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function reallocate(MarketAllocation[] calldata) external {
        _record();
    }

    function allocate(address, bytes memory, uint256) external {
        _record();
    }

    function deallocate(address, bytes memory, uint256) external {
        _record();
    }

    function withdraw(uint256, address, address) external returns (uint256) {
        _record();
        return 0;
    }

    function _record() internal {
        if (shouldRevert) revert MockVaultFailure(42);
        if (reentryTarget != address(0)) {
            (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        calls += 1;
        lastData = msg.data;
        lastCaller = msg.sender;
    }
}

/// @dev ERC-1271 owner, standing in for a Safe: valid when its inner key signed the hash.
contract Mock1271Owner is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }

    function acceptOwnership(ReasonGate gate) external {
        gate.acceptOwnership();
    }
}

contract ReasonGateTest is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant INTENT_TYPEHASH =
        keccak256("Intent(address vault,bytes32 dataHash,bytes32 claimsHash,uint256 nonce,uint64 notAfterBlock)");
    bytes32 internal constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 intentHash,uint8 outcome,uint64 checkedAtBlock,bytes32 receiptHash)");
    bytes32 internal constant OVERRIDE_TYPEHASH = keccak256("Override(bytes32 intentHash)");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// Freshness bound default: 60 blocks, about 18 s on Monad.
    uint64 internal constant DEFAULT_MAX_AGE = 60;

    uint8 internal constant PASS = 1;
    uint8 internal constant WAIT = 2;
    uint8 internal constant FAIL = 3;

    struct Call {
        bytes data;
        bytes32 claimsHash;
        uint256 nonce;
        uint64 notAfterBlock;
        uint8 outcome;
        uint64 checkedAtBlock;
        bytes32 receiptHash;
    }

    ReasonGate internal gate;
    MockVault internal vault;

    uint256 internal ownerKey = 0xA11CE;
    uint256 internal validatorKey = 0xB0B;
    uint256 internal safeSignerKey = 0x5AFE;
    address internal owner;
    address internal validator;
    address internal agent = makeAddr("agent");
    address internal adapter = makeAddr("adapter");

    function setUp() public {
        vm.roll(1_000);
        owner = vm.addr(ownerKey);
        validator = vm.addr(validatorKey);
        vault = new MockVault();
        gate = _deployGate(owner);
    }

    // ---------------------------------------------------------------- helpers

    function _selectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](3);
        selectors[0] = IMetaMorphoV1_1Base.reallocate.selector;
        selectors[1] = IVaultV2.allocate.selector;
        selectors[2] = IVaultV2.deallocate.selector;
    }

    function _deployGate(address gateOwner) internal returns (ReasonGate) {
        return new ReasonGate(gateOwner, address(vault), validator, agent, _selectors());
    }

    function _marketParams() internal pure returns (MarketParams memory) {
        return MarketParams({
            loanToken: address(0x1000),
            collateralToken: address(0x2000),
            oracle: address(0x3000),
            irm: address(0x4000),
            lltv: 0.86e18
        });
    }

    function _allocateData(uint256 assets) internal view returns (bytes memory) {
        return abi.encodeCall(IVaultV2.allocate, (adapter, abi.encode(_marketParams()), assets));
    }

    function _call(uint8 outcome) internal view returns (Call memory c) {
        c = Call({
            data: _allocateData(1_000e6),
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
            abi.encode(INTENT_TYPEHASH, address(vault), keccak256(c.data), c.claimsHash, c.nonce, c.notAfterBlock)
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
        bytes32 structHash = keccak256(abi.encode(OVERRIDE_TYPEHASH, _intentHash(c)));
        return _typed(_domainSeparator(block.chainid, address(gate)), structHash);
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

    function _exec(ReasonGate target, Call memory c, bytes memory validatorSig, bytes memory ownerSig) internal {
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

    // ---------------------------------------------------------------- deployment

    function test_selectorsComeFromVaultAbis() public view {
        assertEq(MockVault.allocate.selector, IVaultV2.allocate.selector);
        assertEq(MockVault.deallocate.selector, IVaultV2.deallocate.selector);
        assertEq(MockVault.reallocate.selector, IMetaMorphoV1_1Base.reallocate.selector);
        assertEq(MockVault.withdraw.selector, IVaultV2ERC4626.withdraw.selector);
        assertTrue(gate.allowedSelector(IVaultV2.allocate.selector));
        assertTrue(gate.allowedSelector(IVaultV2.deallocate.selector));
        assertTrue(gate.allowedSelector(IMetaMorphoV1_1Base.reallocate.selector));
        assertFalse(gate.allowedSelector(IVaultV2ERC4626.withdraw.selector));
        assertFalse(gate.allowedSelector(IVaultV2ERC4626.redeem.selector));
        assertFalse(gate.allowedSelector(IVaultV2ERC20.transfer.selector));
        assertFalse(gate.allowedSelector(IVaultV2.forceDeallocate.selector));
    }

    function test_typehashesMatchBrief() public view {
        assertEq(gate.INTENT_TYPEHASH(), INTENT_TYPEHASH);
        assertEq(gate.VERDICT_TYPEHASH(), VERDICT_TYPEHASH);
        assertEq(gate.OVERRIDE_TYPEHASH(), OVERRIDE_TYPEHASH);
    }

    function test_initialState() public view {
        assertEq(gate.owner(), owner);
        assertEq(gate.vault(), address(vault));
        assertEq(gate.validator(), validator);
        assertEq(gate.agent(), agent);
        assertEq(gate.DEFAULT_MAX_AGE_BLOCKS(), DEFAULT_MAX_AGE);
        assertEq(gate.maxAgeBlocks(), DEFAULT_MAX_AGE);
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            gate.eip712Domain();
        assertEq(name, "Proof of Reason");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(gate));
    }

    function test_constructor_rejectsZeroVault() public {
        vm.expectRevert(ReasonGate.ZeroVault.selector);
        new ReasonGate(owner, address(0), validator, agent, _selectors());
    }

    // ---------------------------------------------------------------- required cases

    function test_pass_executesAndEmits() public {
        Call memory c = _call(PASS);
        bytes32 intentHash = _intentHash(c);

        bytes memory sig = _signVerdict(c);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ReasonGate.Executed(intentHash, PASS, c.receiptHash, false);
        _exec(c, sig, "");

        assertEq(vault.calls(), 1);
        assertEq(vault.lastData(), c.data);
        assertEq(vault.lastCaller(), address(gate));
        assertTrue(gate.usedNonce(c.nonce));
    }

    function test_pass_reallocateExecutes() public {
        MarketAllocation[] memory allocations = new MarketAllocation[](2);
        allocations[0] = MarketAllocation({marketParams: _marketParams(), assets: 0});
        allocations[1] = MarketAllocation({marketParams: _marketParams(), assets: type(uint256).max});
        Call memory c = _call(PASS);
        c.data = abi.encodeCall(IMetaMorphoV1_1Base.reallocate, (allocations));

        _exec(c, _signVerdict(c), "");
        assertEq(vault.lastData(), c.data);
    }

    function test_fail_revertsRefuted() public {
        Call memory c = _call(FAIL);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.Refuted.selector, _intentHash(c), c.receiptHash));
        _exec(c, sig, "");
        assertEq(vault.calls(), 0);
    }

    function test_fail_ownerSignatureDoesNotHelp() public {
        Call memory c = _call(FAIL);
        bytes memory ownerSig = _sign(ownerKey, _overrideDigest(c));
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.Refuted.selector, _intentHash(c), c.receiptHash));
        _exec(c, sig, ownerSig);
    }

    function test_wait_withoutOwnerSig_reverts() public {
        Call memory c = _call(WAIT);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.OverrideNotAuthorized.selector, _intentHash(c)));
        _exec(c, sig, "");
        assertEq(vault.calls(), 0);
    }

    function test_wait_withNonOwnerSig_reverts() public {
        Call memory c = _call(WAIT);
        bytes memory wrongSig = _sign(validatorKey, _overrideDigest(c));
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.OverrideNotAuthorized.selector, _intentHash(c)));
        _exec(c, sig, wrongSig);
    }

    function test_wait_withEoaOwnerSig_executes() public {
        Call memory c = _call(WAIT);
        bytes memory ownerSig = _sign(ownerKey, _overrideDigest(c));

        bytes memory sig = _signVerdict(c);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ReasonGate.Executed(_intentHash(c), WAIT, c.receiptHash, true);
        _exec(c, sig, ownerSig);

        assertEq(vault.calls(), 1);
        assertEq(vault.lastData(), c.data);
    }

    function test_wait_withErc1271OwnerSig_executes() public {
        Mock1271Owner safe = new Mock1271Owner(vm.addr(safeSignerKey));
        vm.prank(owner);
        gate.transferOwnership(address(safe));
        safe.acceptOwnership(gate);
        assertEq(gate.owner(), address(safe));

        Call memory c = _call(WAIT);
        bytes memory safeSig = _sign(safeSignerKey, _overrideDigest(c));

        bytes memory sig = _signVerdict(c);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ReasonGate.Executed(_intentHash(c), WAIT, c.receiptHash, true);
        _exec(c, sig, safeSig);
        assertEq(vault.calls(), 1);
    }

    function test_wait_withErc1271Owner_rejectsFormerEoaOwnerSig() public {
        Mock1271Owner safe = new Mock1271Owner(vm.addr(safeSignerKey));
        vm.prank(owner);
        gate.transferOwnership(address(safe));
        safe.acceptOwnership(gate);

        Call memory c = _call(WAIT);
        bytes memory staleSig = _sign(ownerKey, _overrideDigest(c));
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.OverrideNotAuthorized.selector, _intentHash(c)));
        _exec(c, sig, staleSig);
    }

    function test_verdictOlderThanMaxAge_reverts() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number - DEFAULT_MAX_AGE - 1);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(
            abi.encodeWithSelector(ReasonGate.VerdictTooOld.selector, c.checkedAtBlock, block.number, DEFAULT_MAX_AGE)
        );
        _exec(c, sig, "");
    }

    function test_verdictExactlyMaxAge_executes() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number - DEFAULT_MAX_AGE);
        _exec(c, _signVerdict(c), "");
        assertEq(vault.calls(), 1);
    }

    function test_verdictAtCurrentBlock_executes() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number);
        _exec(c, _signVerdict(c), "");
        assertEq(vault.calls(), 1);
    }

    function test_maxAgeBlocks_ownerSetBoundApplies() public {
        vm.prank(owner);
        gate.setMaxAgeBlocks(5);

        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number - 6);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(
            abi.encodeWithSelector(ReasonGate.VerdictTooOld.selector, c.checkedAtBlock, block.number, uint64(5))
        );
        _exec(c, sig, "");

        c.checkedAtBlock = uint64(block.number - 5);
        _exec(c, _signVerdict(c), "");
        assertEq(vault.calls(), 1);
    }

    function test_checkedAtBlockInFuture_reverts() public {
        Call memory c = _call(PASS);
        c.checkedAtBlock = uint64(block.number + 1);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.VerdictFromFuture.selector, c.checkedAtBlock, block.number));
        _exec(c, sig, "");
    }

    function test_notAfterBlockPassed_reverts() public {
        Call memory c = _call(PASS);
        c.notAfterBlock = uint64(block.number - 1);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.IntentExpired.selector, c.notAfterBlock, block.number));
        _exec(c, sig, "");
    }

    function test_notAfterBlockEqualsCurrent_executes() public {
        Call memory c = _call(PASS);
        c.notAfterBlock = uint64(block.number);
        _exec(c, _signVerdict(c), "");
        assertEq(vault.calls(), 1);
    }

    function test_notAfterBlockPassedAfterSigning_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.roll(c.notAfterBlock + 1);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.IntentExpired.selector, c.notAfterBlock, block.number));
        _exec(c, sig, "");
    }

    function test_replayedNonce_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        _exec(c, sig, "");
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.NonceUsed.selector, c.nonce));
        _exec(c, sig, "");
        assertEq(vault.calls(), 1);
    }

    function test_replayedNonceWithFreshVerdict_reverts() public {
        Call memory c = _call(PASS);
        _exec(c, _signVerdict(c), "");
        c.data = _allocateData(5e6);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.NonceUsed.selector, c.nonce));
        _exec(c, sig, "");
    }

    function test_disallowedSelector_reverts() public {
        Call memory c = _call(PASS);
        c.data = abi.encodeCall(IVaultV2ERC4626.withdraw, (1_000e6, agent, address(gate)));
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(
            abi.encodeWithSelector(ReasonGate.SelectorNotAllowed.selector, IVaultV2ERC4626.withdraw.selector)
        );
        _exec(c, sig, "");
        assertEq(vault.calls(), 0);
    }

    function test_removedSelector_reverts() public {
        vm.prank(owner);
        gate.setAllowedSelector(IVaultV2.allocate.selector, false);
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.SelectorNotAllowed.selector, IVaultV2.allocate.selector));
        _exec(c, sig, "");
    }

    function test_calldataShorterThanSelector_reverts() public {
        Call memory c = _call(PASS);
        c.data = hex"aabbcc";
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.CalldataTooShort.selector, uint256(3)));
        _exec(c, sig, "");
    }

    function test_calldataChangedAfterSigning_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        c.data = _allocateData(1_000_000e6);
        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
        assertEq(vault.calls(), 0);
    }

    function test_claimsHashChangedAfterSigning_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        c.claimsHash = keccak256("other claims");
        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
    }

    function test_outcomeFlippedByAgent_reverts() public {
        Call memory c = _call(WAIT);
        bytes memory sig = _signVerdict(c);
        c.outcome = PASS;
        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
    }

    function test_receiptHashChangedAfterSigning_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        c.receiptHash = keccak256("other receipt");
        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
    }

    function test_verdictForAnotherChainId_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdictFor(validatorKey, c, block.chainid + 1, address(gate));
        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
    }

    function test_verdictAfterChainIdChange_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.chainId(block.chainid + 1);
        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(c, sig, "");
    }

    function test_verdictForAnotherGate_reverts() public {
        ReasonGate other = _deployGate(owner);
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdictFor(validatorKey, c, block.chainid, address(other));

        vm.expectPartialRevert(ReasonGate.InvalidValidatorSignature.selector);
        _exec(gate, c, sig, "");

        // The same signature is valid on the gate it was signed for.
        _exec(other, c, sig, "");
        assertEq(vault.calls(), 1);
        assertEq(vault.lastCaller(), address(other));
    }

    function test_nonAgentCaller_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        address stranger = makeAddr("stranger");
        address[3] memory callers = [stranger, owner, validator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(ReasonGate.NotAgent.selector, callers[i]));
            gate.execute(
                c.data, c.claimsHash, c.nonce, c.notAfterBlock, c.outcome, c.checkedAtBlock, c.receiptHash, sig, ""
            );
        }
        assertEq(vault.calls(), 0);
    }

    function test_oldValidatorRejectedAfterRotation() public {
        uint256 newValidatorKey = 0xC0FFEE;
        address newValidator = vm.addr(newValidatorKey);
        vm.prank(owner);
        gate.setValidator(newValidator);

        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(ReasonGate.InvalidValidatorSignature.selector, validator));
        _exec(c, sig, "");

        _exec(c, _signVerdictFor(newValidatorKey, c, block.chainid, address(gate)), "");
        assertEq(vault.calls(), 1);
    }

    function test_highSSignature_rejected() public {
        Call memory c = _call(PASS);
        bytes32 digest = _verdictDigestFor(c, block.chainid, address(gate));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKey, digest);

        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        // The malleated signature still recovers the validator through the raw precompile.
        assertEq(ecrecover(digest, flippedV, r, highS), validator);

        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        _exec(c, abi.encodePacked(r, highS, flippedV), "");
        assertEq(vault.calls(), 0);
    }

    // ---------------------------------------------------------------- additional cases

    function test_invalidOutcome_reverts() public {
        uint8[2] memory bad = [uint8(0), uint8(4)];
        for (uint256 i; i < bad.length; ++i) {
            Call memory c = _call(bad[i]);
            bytes memory sig = _signVerdict(c);
            vm.expectRevert(abi.encodeWithSelector(ReasonGate.InvalidOutcome.selector, bad[i]));
            _exec(c, sig, "");
        }
    }

    function test_malformedValidatorSig_reverts() public {
        Call memory c = _call(PASS);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, uint256(0)));
        _exec(c, "", "");
    }

    function test_vaultRevert_bubblesAndKeepsNonce() public {
        vault.setShouldRevert(true);
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        vm.expectRevert(abi.encodeWithSelector(MockVault.MockVaultFailure.selector, uint256(42)));
        _exec(c, sig, "");
        assertFalse(gate.usedNonce(c.nonce));

        vault.setShouldRevert(false);
        _exec(c, sig, "");
        assertEq(vault.calls(), 1);
    }

    function test_reentrancy_reverts() public {
        Call memory c = _call(PASS);
        bytes memory sig = _signVerdict(c);
        Call memory inner = _call(PASS);
        inner.nonce = 8;
        vault.setReentry(
            address(gate),
            abi.encodeCall(
                ReasonGate.execute,
                (
                    inner.data,
                    inner.claimsHash,
                    inner.nonce,
                    inner.notAfterBlock,
                    inner.outcome,
                    inner.checkedAtBlock,
                    inner.receiptHash,
                    _signVerdict(inner),
                    ""
                )
            )
        );
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _exec(c, sig, "");
    }

    function test_rejectsEther() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(gate).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(gate).balance, 0);
    }

    function test_ownerSetters_emitAndUpdate() public {
        address newValidator = makeAddr("newValidator");
        address newAgent = makeAddr("newAgent");
        bytes4 selector = IVaultV2.allocate.selector;

        vm.startPrank(owner);
        vm.expectEmit(true, true, false, false, address(gate));
        emit ReasonGate.ValidatorSet(validator, newValidator);
        gate.setValidator(newValidator);

        vm.expectEmit(true, true, false, false, address(gate));
        emit ReasonGate.AgentSet(agent, newAgent);
        gate.setAgent(newAgent);

        vm.expectEmit(false, false, false, true, address(gate));
        emit ReasonGate.MaxAgeBlocksSet(DEFAULT_MAX_AGE, 5);
        gate.setMaxAgeBlocks(5);

        vm.expectEmit(true, false, false, true, address(gate));
        emit ReasonGate.SelectorSet(selector, false);
        gate.setAllowedSelector(selector, false);
        vm.stopPrank();

        assertEq(gate.validator(), newValidator);
        assertEq(gate.agent(), newAgent);
        assertEq(gate.maxAgeBlocks(), 5);
        assertFalse(gate.allowedSelector(selector));
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
        gate.setAllowedSelector(IVaultV2ERC4626.withdraw.selector, true);
        vm.stopPrank();
    }

    function test_constructor_emitsInitialConfig() public {
        vm.recordLogs();
        ReasonGate fresh = _deployGate(owner);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 selectorEvents;
        bool sawValidator;
        bool sawAgent;
        bool sawMaxAge;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(fresh)) continue;
            bytes32 topic = logs[i].topics[0];
            if (topic == ReasonGate.SelectorSet.selector) selectorEvents++;
            if (topic == ReasonGate.ValidatorSet.selector) sawValidator = true;
            if (topic == ReasonGate.AgentSet.selector) sawAgent = true;
            if (topic == ReasonGate.MaxAgeBlocksSet.selector) sawMaxAge = true;
        }
        assertEq(selectorEvents, 3);
        assertTrue(sawValidator && sawAgent && sawMaxAge);
    }

    // ---------------------------------------------------------------- blocklist

    function _blocked() internal pure returns (bytes4[4] memory) {
        return [
            IVaultV2ERC4626.withdraw.selector,
            IVaultV2ERC4626.redeem.selector,
            IVaultV2ERC20.transfer.selector,
            IVaultV2.forceDeallocate.selector
        ];
    }

    function test_blocklist_computedFromInterfaces() public view {
        assertEq(gate.BLOCKED_WITHDRAW(), bytes4(keccak256("withdraw(uint256,address,address)")));
        assertEq(gate.BLOCKED_REDEEM(), bytes4(keccak256("redeem(uint256,address,address)")));
        assertEq(gate.BLOCKED_TRANSFER(), bytes4(keccak256("transfer(address,uint256)")));
        assertEq(gate.BLOCKED_FORCE_DEALLOCATE(), bytes4(keccak256("forceDeallocate(address,bytes,uint256,address)")));
        // Same selectors as the Vault V2 interfaces pinned in lib/.
        bytes4[4] memory blocked = _blocked();
        assertEq(gate.BLOCKED_WITHDRAW(), blocked[0]);
        assertEq(gate.BLOCKED_REDEEM(), blocked[1]);
        assertEq(gate.BLOCKED_TRANSFER(), blocked[2]);
        assertEq(gate.BLOCKED_FORCE_DEALLOCATE(), blocked[3]);
    }

    function test_blocklist_isBlockedSelector() public view {
        bytes4[4] memory blocked = _blocked();
        for (uint256 i; i < blocked.length; ++i) {
            assertTrue(gate.isBlockedSelector(blocked[i]));
        }
        assertFalse(gate.isBlockedSelector(IVaultV2.allocate.selector));
        assertFalse(gate.isBlockedSelector(IVaultV2.deallocate.selector));
        assertFalse(gate.isBlockedSelector(IMetaMorphoV1_1Base.reallocate.selector));
    }

    function test_blocklist_setterRejects() public {
        bytes4[4] memory blocked = _blocked();
        vm.startPrank(owner);
        for (uint256 i; i < blocked.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(ReasonGate.SelectorBlocked.selector, blocked[i]));
            gate.setAllowedSelector(blocked[i], true);
            assertFalse(gate.allowedSelector(blocked[i]));
            // Disallowing a blocked selector is a harmless no-op.
            gate.setAllowedSelector(blocked[i], false);
        }
        vm.stopPrank();
    }

    function test_blocklist_constructorRejects() public {
        bytes4[4] memory blocked = _blocked();
        for (uint256 i; i < blocked.length; ++i) {
            bytes4[] memory selectors = new bytes4[](2);
            selectors[0] = IVaultV2.allocate.selector;
            selectors[1] = blocked[i];
            vm.expectRevert(abi.encodeWithSelector(ReasonGate.SelectorBlocked.selector, blocked[i]));
            new ReasonGate(owner, address(vault), validator, agent, selectors);
        }
    }

    // ---------------------------------------------------------------- engine parity

    function test_canonicalSignatures() public pure {
        assertEq(IVaultV2.allocate.selector, bytes4(keccak256("allocate(address,bytes,uint256)")));
        assertEq(IVaultV2.deallocate.selector, bytes4(keccak256("deallocate(address,bytes,uint256)")));
        assertEq(
            IMetaMorphoV1_1Base.reallocate.selector,
            bytes4(keccak256("reallocate(((address,address,address,address,uint256),uint256)[])"))
        );
    }

    /// @dev Same vector as engine/test/sign.test.ts. The signature below was produced by the
    /// engine's signVerdict with the validator test key; here the gate accepts it.
    function test_goldenVector_matchesEngine() public {
        address vectorGate = 0x1111111111111111111111111111111111111111;
        address vectorVault = 0x2222222222222222222222222222222222222222;
        address vectorAdapter = 0x3333333333333333333333333333333333333333;
        assertEq(block.chainid, 31337);

        bytes memory data = abi.encodeCall(IVaultV2.allocate, (vectorAdapter, abi.encode(_marketParams()), 1_000e6));
        assertEq(
            keccak256(abi.encode(_marketParams())), 0xaf8957dd4928705e8b62a61bd6eff57dd7225ea25e90c485c91342a07b90daec
        );
        assertEq(keccak256(data), 0x6bfe543c311e01a4e0ae47c86eb1296148673e5cffc81fcc561470328455401d);

        bytes32 domainSeparator = _domainSeparator(31337, vectorGate);
        bytes32 intentHash = _typed(
            domainSeparator,
            keccak256(
                abi.encode(INTENT_TYPEHASH, vectorVault, keccak256(data), keccak256("claims"), uint256(7), uint64(1010))
            )
        );
        assertEq(intentHash, 0xa94cccb12b3b6bdaaf945734156b0352809f8ddd1ff1de7da1f8acdedd64c2c3);
        bytes32 verdictDigest = _typed(
            domainSeparator,
            keccak256(abi.encode(VERDICT_TYPEHASH, intentHash, PASS, uint64(999), keccak256("receipt")))
        );
        assertEq(verdictDigest, 0xbb4a5f0697e6e548c5896ca6e54b7565941de63815acd07df3cb5c30f8247892);
        assertEq(
            _typed(domainSeparator, keccak256(abi.encode(OVERRIDE_TYPEHASH, intentHash))),
            0x53abfd98cc0d267e4310d13a977706dcd5568911ccc3f990888688b66eb813c4
        );

        bytes memory engineSig =
            hex"520ff09bea6d20ee2f2d80b5c5e7275f1ac228ff72b0a427715b75f6e22eab113f6e5656c2d6e5e6809d62dc61edccf6bf2010ac6c93cc5e926f9cc557da51251c";
        assertEq(engineSig, _sign(validatorKey, verdictDigest));

        deployCodeTo("ReasonGate.t.sol:MockVault", vectorVault);
        deployCodeTo(
            "ReasonGate.sol:ReasonGate", abi.encode(owner, vectorVault, validator, agent, _selectors()), vectorGate
        );
        vm.prank(agent);
        ReasonGate(vectorGate)
            .execute(data, keccak256("claims"), 7, 1010, PASS, 999, keccak256("receipt"), engineSig, "");
        assertEq(MockVault(vectorVault).lastData(), data);
        assertEq(MockVault(vectorVault).lastCaller(), vectorGate);
    }
}
