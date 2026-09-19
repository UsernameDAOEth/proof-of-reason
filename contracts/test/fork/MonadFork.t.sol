// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMetaMorphoV1_1, IMetaMorphoV1_1Base, MarketAllocation} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1.sol";
import {
    Id,
    IMorpho,
    Market,
    MarketParams,
    Position
} from "../../lib/metamorpho-v1.1/lib/morpho-blue/src/interfaces/IMorpho.sol";

import {ReasonGate} from "../../src/ReasonGate.sol";
import {DeployVault} from "../../script/DeployVault.s.sol";
import {DeployGate} from "../../script/DeployGate.s.sol";

/// @dev Opt-in fork test against Monad mainnet state (read-only RPC). Skipped unless RPC_URL is
/// set, normally to the archive RPC from contracts/.env.deploy: `forge test --match-path test/fork/*`.
/// A public endpoint (docs/MONAD.md section 4) also works as a fallback.
/// Runs both deploy scripts on the fork, then has the gate execute a real MetaMorpho V1.1
/// reallocate between the two live USDC markets under a validator-signed PASS verdict.
contract MonadForkTest is Test {
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant MORPHO = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
    bytes32 internal constant MARKET_A_ID = 0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626;
    bytes32 internal constant MARKET_B_ID = 0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439;
    bytes32 internal constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 intentHash,uint8 outcome,uint64 checkedAtBlock,bytes32 receiptHash)");
    bytes32 internal constant INTENT_TYPEHASH =
        keccak256("Intent(address vault,bytes32 dataHash,bytes32 claimsHash,uint256 nonce,uint64 notAfterBlock)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal validatorKey = 0xB0B;
    address internal agent = makeAddr("agent");
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        vm.setEnv("VALIDATOR_ADDRESS", vm.toString(vm.addr(validatorKey)));
        vm.setEnv("AGENT_ADDRESS", vm.toString(agent));
    }

    function _market(bytes32 id) internal view returns (MarketParams memory) {
        return IMorpho(MORPHO).idToMarketParams(Id.wrap(id));
    }

    /// Supply assets of `user` in market `id`, rounding down (Morpho SharesMathLib, virtual shares 1e6).
    function _supplyAssets(bytes32 id, address user) internal view returns (uint256) {
        Position memory p = IMorpho(MORPHO).position(Id.wrap(id), user);
        Market memory m = IMorpho(MORPHO).market(Id.wrap(id));
        return p.supplyShares * (uint256(m.totalSupplyAssets) + 1) / (uint256(m.totalSupplyShares) + 1e6);
    }

    function _digest(address gate, bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Proof of Reason"), keccak256("1"), block.chainid, gate));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _deployBoth() internal returns (address vault, address gate) {
        address predicted;
        (vault, predicted) = new DeployVault().run();
        vm.setEnv("VAULT", vm.toString(vault));
        gate = new DeployGate().run();
        assertEq(gate, predicted);
    }

    function _deposit(address vault, uint256 assets) internal {
        address depositor = makeAddr("depositor");
        deal(USDC, depositor, assets);
        vm.startPrank(depositor);
        IERC20(USDC).approve(vault, assets);
        IMetaMorphoV1_1(vault).deposit(assets, depositor);
        vm.stopPrank();
    }

    /// Move A to a 6 USDC target; B takes all that remains.
    function _reallocateData() internal view returns (bytes memory) {
        MarketAllocation[] memory allocations = new MarketAllocation[](2);
        allocations[0] = MarketAllocation({marketParams: _market(MARKET_A_ID), assets: 6e6});
        allocations[1] = MarketAllocation({marketParams: _market(MARKET_B_ID), assets: type(uint256).max});
        return abi.encodeCall(IMetaMorphoV1_1Base.reallocate, (allocations));
    }

    function _executePass(address gate, address vault, bytes memory data) internal {
        uint64 notAfterBlock = uint64(block.number + 10);
        uint64 checkedAt = uint64(block.number);
        bytes32 intentHash = _digest(
            gate,
            keccak256(
                abi.encode(INTENT_TYPEHASH, vault, keccak256(data), keccak256("claims"), uint256(1), notAfterBlock)
            )
        );
        bytes32 verdict = _digest(
            gate, keccak256(abi.encode(VERDICT_TYPEHASH, intentHash, uint8(1), checkedAt, keccak256("receipt")))
        );
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(validatorKey, verdict);
        vm.prank(agent);
        ReasonGate(gate)
            .execute(
                data,
                keccak256("claims"),
                1,
                notAfterBlock,
                1,
                checkedAt,
                keccak256("receipt"),
                abi.encodePacked(sr, ss, sv),
                ""
            );
    }

    function test_fork_deployScriptsThenGateReallocates() public {
        if (!forked) vm.skip(true);
        assertEq(block.chainid, 143);

        (address vault, address gate) = _deployBoth();
        IMetaMorphoV1_1 v = IMetaMorphoV1_1(vault);
        assertTrue(v.isAllocator(gate));
        assertEq(v.timelock(), 0);

        // 15 USDC in: the supply queue fills market A to its 10 USDC cap, then B.
        _deposit(vault, 15e6);
        assertApproxEqAbs(_supplyAssets(MARKET_A_ID, vault), 10e6, 2);
        assertApproxEqAbs(_supplyAssets(MARKET_B_ID, vault), 5e6, 2);
        uint256 assetsBefore = v.totalAssets();

        _executePass(gate, vault, _reallocateData());

        // 4 USDC moved from A to B; total assets unchanged up to Morpho share rounding.
        assertApproxEqAbs(v.totalAssets(), assetsBefore, 2);
        assertApproxEqAbs(_supplyAssets(MARKET_A_ID, vault), 6e6, 2);
        assertApproxEqAbs(_supplyAssets(MARKET_B_ID, vault), 9e6, 2);
    }
}
