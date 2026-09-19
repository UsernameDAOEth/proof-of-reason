// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IMetaMorphoV1_1} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1.sol";

import {ReasonGate} from "../src/ReasonGate.sol";
import {DeployBase} from "./DeployBase.s.sol";

/// @notice Deploys ReasonGate for VAULT through the CREATE2 deployer, at the address that
/// DeployVault.s.sol predicted and made allocator. Environment: VAULT plus the DeployBase
/// variables, which must hold the same values as when DeployVault ran.
contract DeployGate is DeployBase {
    error GateAddressMismatch(address deployed, address predicted);
    error Create2Failed();

    function run() external returns (address gate) {
        _checkChain();
        address vault = vm.envAddress("VAULT");
        address deployer = _startBroadcast();
        Config memory c = _config(deployer);

        address predicted = _predictGate(vault, c);
        (bool ok, bytes memory ret) =
            CREATE2_FACTORY.call{gas: GAS_DEPLOY_GATE}(abi.encodePacked(GATE_SALT, _gateInitCode(vault, c)));
        vm.stopBroadcast();
        if (!ok || ret.length != 20) revert Create2Failed();
        gate = address(bytes20(ret));
        if (gate != predicted) revert GateAddressMismatch(gate, predicted);

        ReasonGate g = ReasonGate(gate);
        require(g.vault() == vault && g.validator() == c.validator && g.agent() == c.agent, "gate config");
        require(g.owner() == c.gateOwner, "gate owner");
        if (vault.code.length > 0) {
            // Holds only once DeployVault has run on the same chain with the same config.
            require(IMetaMorphoV1_1(vault).isAllocator(gate), "gate is not the vault allocator");
        } else {
            console.log("WARNING: VAULT has no code on this chain; allocator check skipped");
        }

        console.log("GATE", gate);
        console.log("GATE_OWNER", c.gateOwner);
        console.log("VALIDATOR", c.validator);
        console.log("AGENT", c.agent);
    }
}
