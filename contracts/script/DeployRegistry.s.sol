// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";

import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {DeployBase} from "./DeployBase.s.sol";

/// @notice Deploys the interim ERC-8004 Validation Registry (docs/MONAD.md section 12) through the
/// CREATE2 deployer, so its address is known before it exists and can be pinned in the worker's
/// REGISTRY_ADDRESS var and in envio/config.yaml.
/// @dev Environment: the same variables as the other scripts (DeployBase). PRIVATE_KEY is optional,
/// so a dry run needs no key; GATE_OWNER, if set, owns the registry as well, which keeps one owner
/// for the whole deployment. Nothing else is read and nothing is printed but addresses.
contract DeployRegistry is DeployBase {
    /// ERC-8004 Identity Registry on Monad mainnet (docs/MONAD.md section 5). Agent ids are its
    /// token ids, and this registry refuses to record a verdict against an id it does not know.
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    bytes32 internal constant REGISTRY_SALT = keccak256("Proof of Reason interim validation registry v1");

    // Explicit gas limit, as everywhere else: Monad charges the full limit, not the gas used.
    // Deployed bytecode is 6,213 bytes, so the code deposit alone is 200 * 6,213 = 1,242,600; plus
    // the constructor, the 6,607 bytes of init code as calldata, and intrinsic gas, about 1.39M.
    // Plus about 20 percent.
    uint256 internal constant GAS_DEPLOY_REGISTRY = 1_700_000;

    error RegistryAddressMismatch(address deployed, address predicted);
    error Create2Failed();
    error IdentityRegistryHasNoCode(address identityRegistry);

    function run() external returns (address registry) {
        _checkChain();
        if (IDENTITY_REGISTRY.code.length == 0) revert IdentityRegistryHasNoCode(IDENTITY_REGISTRY);

        address deployer = _startBroadcast();
        Config memory c = _config(deployer);
        bytes memory initCode =
            abi.encodePacked(type(ValidationRegistry).creationCode, abi.encode(c.gateOwner, IDENTITY_REGISTRY));
        address predicted = vm.computeCreate2Address(REGISTRY_SALT, keccak256(initCode), CREATE2_FACTORY);

        (bool ok, bytes memory ret) =
            CREATE2_FACTORY.call{gas: GAS_DEPLOY_REGISTRY}(abi.encodePacked(REGISTRY_SALT, initCode));
        vm.stopBroadcast();
        if (!ok || ret.length != 20) revert Create2Failed();
        registry = address(bytes20(ret));
        if (registry != predicted) revert RegistryAddressMismatch(registry, predicted);

        ValidationRegistry r = ValidationRegistry(registry);
        require(address(r.identityRegistry()) == IDENTITY_REGISTRY, "identity registry");
        require(r.owner() == c.gateOwner, "registry owner");
        require(r.MAX_RESPONSE() == 100, "max response");

        console.log("REGISTRY", registry);
        console.log("REGISTRY_OWNER", c.gateOwner);
        console.log("IDENTITY_REGISTRY", IDENTITY_REGISTRY);
        console.log("VALIDATOR", c.validator);
    }
}
