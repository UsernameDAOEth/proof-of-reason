// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IMetaMorphoV1_1} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1.sol";
import {IMetaMorphoV1_1Factory} from "metamorpho-v1.1/interfaces/IMetaMorphoV1_1Factory.sol";
import {Id} from "../lib/metamorpho-v1.1/lib/morpho-blue/src/interfaces/IMorpho.sol";

import {DeployBase} from "./DeployBase.s.sol";

/// @notice Creates the Proof of Reason demo vault: a MetaMorpho V1.1 USDC vault with timelock 0,
/// minimal caps on markets A and B, supply queue [A, B], and the ReasonGate (at its predicted
/// CREATE2 address) as the only allocator. Run DeployGate.s.sol next with VAULT set to the
/// logged address; it deploys the gate at exactly that predicted address.
contract DeployVault is DeployBase {
    function run() external returns (address vault, address gate) {
        _checkChain();
        address deployer = _startBroadcast();
        Config memory c = _config(deployer);

        IMetaMorphoV1_1 v = IMetaMorphoV1_1Factory(METAMORPHO_V1_1_FACTORY).createMetaMorpho{gas: GAS_CREATE_VAULT}(
            deployer, 0, USDC, VAULT_NAME, VAULT_SYMBOL, VAULT_SALT
        );
        vault = address(v);

        // Timelock 0: each cap raise is accepted immediately (docs/MONAD.md section 2).
        v.submitCap{gas: GAS_SUBMIT_CAP}(_marketA(), CAP_PER_MARKET);
        v.acceptCap{gas: GAS_ACCEPT_CAP}(_marketA());
        v.submitCap{gas: GAS_SUBMIT_CAP}(_marketB(), CAP_PER_MARKET);
        v.acceptCap{gas: GAS_ACCEPT_CAP}(_marketB());

        Id[] memory queue = new Id[](2);
        queue[0] = _id(MARKET_A_ID);
        queue[1] = _id(MARKET_B_ID);
        v.setSupplyQueue{gas: GAS_SET_SUPPLY_QUEUE}(queue);

        gate = _predictGate(vault, c);
        v.setIsAllocator{gas: GAS_SET_IS_ALLOCATOR}(gate, true);
        vm.stopBroadcast();

        require(v.timelock() == 0, "timelock");
        require(v.supplyQueueLength() == 2, "supply queue");
        require(v.isAllocator(gate), "allocator");

        console.log("VAULT", vault);
        console.log("PREDICTED_GATE", gate);
        console.log("VAULT_OWNER", deployer);
    }
}
