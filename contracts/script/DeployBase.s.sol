// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IMetaMorphoV1_1Base} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1.sol";
import {IMetaMorphoV1_1Factory} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1Factory.sol";
import {Id, IMorpho, MarketParams} from "../lib/metamorpho-v1.1/lib/morpho-blue/src/interfaces/IMorpho.sol";

import {ReasonGate} from "../src/ReasonGate.sol";

/// @dev Shared configuration for the Proof of Reason Monad deployment scripts.
/// Addresses and market parameters come from docs/MONAD.md and are re-checked on chain by
/// `_checkChain` before anything is broadcast.
/// Environment (read here only; nothing is ever hardcoded or printed):
///   PRIVATE_KEY        deployer key. Optional: without it the script simulates as `--sender`.
///   VALIDATOR_ADDRESS  address of the worker's VALIDATOR_KEY (public address, not the key).
///   AGENT_ADDRESS      the only address allowed to call ReasonGate.execute.
///   GATE_OWNER         optional; defaults to the deployer.
/// RPC_URL is read by foundry.toml `[rpc_endpoints] monad = "${RPC_URL}"`; pass `--rpc-url monad`.
/// RPC_URL is the archive-capable RPC (QuickNode or Tenderly Node); public endpoints are fallback only.
abstract contract DeployBase is Script {
    uint256 internal constant MONAD_CHAIN_ID = 143;
    address internal constant MORPHO = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
    address internal constant METAMORPHO_V1_1_FACTORY = 0x33f20973275B2F574488b18929cd7DCBf1AbF275;
    address internal constant ADAPTIVE_CURVE_IRM = 0x09475a3D6eA8c314c592b1a3799bDE044E2F400F;
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    /// Market A, USDC / aHYPER, lltv 77 percent.
    bytes32 internal constant MARKET_A_ID = 0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626;
    address internal constant MARKET_A_COLLATERAL = 0x7Cd231120a60F500887444a9bAF5e1BD753A5e59;
    address internal constant MARKET_A_ORACLE = 0x4af4f38164cD7F28653A66aa2255B249a23cFBec;
    uint256 internal constant MARKET_A_LLTV = 0.77e18;

    /// Market B, USDC / PT-USDat-14JAN2027, lltv 91.5 percent.
    bytes32 internal constant MARKET_B_ID = 0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439;
    address internal constant MARKET_B_COLLATERAL = 0xa08A69aB9Dd3B04D0992BC7aFb2c0b907bbdc147;
    address internal constant MARKET_B_ORACLE = 0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2;
    uint256 internal constant MARKET_B_LLTV = 0.915e18;

    /// Minimal supply cap per market: 10 USDC (6 decimals).
    uint256 internal constant CAP_PER_MARKET = 10e6;

    string internal constant VAULT_NAME = "Proof of Reason Demo USDC";
    string internal constant VAULT_SYMBOL = "demoUSDC";
    bytes32 internal constant VAULT_SALT = keccak256("Proof of Reason demo vault v1");
    bytes32 internal constant GATE_SALT = keccak256("Proof of Reason gate v1");

    // Explicit gas limit for every broadcast transaction. Monad charges the full gas limit, not the
    // gas used, and forge's own on-chain estimate cannot see contracts created earlier in the same
    // script (it estimated submitCap at 25,898, which is intrinsic gas only). Broadcast with
    // --skip-simulation so these limits are sent verbatim.
    // Each limit = execution gas measured by `forge script -vvvv --network monad` against Monad
    // state on 2026-09-18, plus intrinsic gas (21,000 + calldata), plus about 20 percent.
    //   createMetaMorpho  exec 4,191,422                      -> 5,100,000
    //   submitCap         exec    92,340                      ->   150,000
    //   acceptCap         exec   181,431 (first market)       ->   250,000
    //   setSupplyQueue    exec   123,775                      ->   180,000
    //   setIsAllocator    exec    60,829                      ->   100,000
    //   gate CREATE2      exec 1,529,194 + calldata 124,504   -> 2,050,000
    uint256 internal constant GAS_CREATE_VAULT = 5_100_000;
    uint256 internal constant GAS_SUBMIT_CAP = 150_000;
    uint256 internal constant GAS_ACCEPT_CAP = 250_000;
    uint256 internal constant GAS_SET_SUPPLY_QUEUE = 180_000;
    uint256 internal constant GAS_SET_IS_ALLOCATOR = 100_000;
    uint256 internal constant GAS_DEPLOY_GATE = 2_050_000;

    struct Config {
        address deployer;
        address gateOwner;
        address validator;
        address agent;
    }

    error WrongChain(uint256 chainId);
    error ChainMismatch(string what);

    /// Starts broadcasting and returns the deployer. Without PRIVATE_KEY this simulates as the
    /// `--sender` address, so a dry run never needs a key.
    function _startBroadcast() internal returns (address deployer) {
        uint256 privateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (privateKey != 0) {
            deployer = vm.addr(privateKey);
            vm.startBroadcast(privateKey);
        } else {
            deployer = msg.sender;
            vm.startBroadcast(deployer);
        }
    }

    function _config(address deployer) internal view returns (Config memory c) {
        c.deployer = deployer;
        c.gateOwner = vm.envOr("GATE_OWNER", deployer);
        c.validator = vm.envAddress("VALIDATOR_ADDRESS");
        c.agent = vm.envAddress("AGENT_ADDRESS");
    }

    function _marketA() internal pure returns (MarketParams memory) {
        return MarketParams({
            loanToken: USDC,
            collateralToken: MARKET_A_COLLATERAL,
            oracle: MARKET_A_ORACLE,
            irm: ADAPTIVE_CURVE_IRM,
            lltv: MARKET_A_LLTV
        });
    }

    function _marketB() internal pure returns (MarketParams memory) {
        return MarketParams({
            loanToken: USDC,
            collateralToken: MARKET_B_COLLATERAL,
            oracle: MARKET_B_ORACLE,
            irm: ADAPTIVE_CURVE_IRM,
            lltv: MARKET_B_LLTV
        });
    }

    function _sameParams(MarketParams memory a, MarketParams memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    /// Re-check every hardcoded fact against the chain before broadcasting.
    function _checkChain() internal view {
        if (block.chainid != MONAD_CHAIN_ID) revert WrongChain(block.chainid);
        if (IMetaMorphoV1_1Factory(METAMORPHO_V1_1_FACTORY).MORPHO() != MORPHO) revert ChainMismatch("factory");
        if (keccak256(abi.encode(_marketA())) != MARKET_A_ID) revert ChainMismatch("market A id");
        if (keccak256(abi.encode(_marketB())) != MARKET_B_ID) revert ChainMismatch("market B id");
        IMorpho morpho = IMorpho(MORPHO);
        if (!_sameParams(morpho.idToMarketParams(_id(MARKET_A_ID)), _marketA())) revert ChainMismatch("market A");
        if (!_sameParams(morpho.idToMarketParams(_id(MARKET_B_ID)), _marketB())) revert ChainMismatch("market B");
    }

    function _id(bytes32 raw) internal pure returns (Id) {
        return Id.wrap(raw);
    }

    function _gateSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](1);
        selectors[0] = IMetaMorphoV1_1Base.reallocate.selector;
    }

    function _gateInitCode(address vault, Config memory c) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(ReasonGate).creationCode, abi.encode(c.gateOwner, vault, c.validator, c.agent, _gateSelectors())
        );
    }

    /// CREATE2 address of the gate for `vault`, through the deterministic deployer.
    function _predictGate(address vault, Config memory c) internal pure returns (address) {
        return vm.computeCreate2Address(GATE_SALT, keccak256(_gateInitCode(vault, c)), CREATE2_FACTORY);
    }
}

