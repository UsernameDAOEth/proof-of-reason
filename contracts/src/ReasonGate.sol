// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ReasonGate
/// @notice Proof of Reason veto-only executor for ONE vault. The gate holds an allocator-type
/// role on the vault. The agent calls the gate; the gate forwards the exact bound calldata to
/// the vault only when the validator has signed a verdict over it.
/// @dev Hold the veto, never the keys. The gate cannot start a call on its own, holds no funds,
/// accepts no ether, grants no token approvals, and only forwards allowlisted selectors.
/// Setting `agent` or `validator` to address(0) halts execution.
contract ReasonGate is Ownable2Step, EIP712, ReentrancyGuard {
    uint8 public constant PASS = 1;
    uint8 public constant WAIT = 2;
    uint8 public constant FAIL = 3;

    uint64 public constant DEFAULT_MAX_AGE_BLOCKS = 20;

    bytes32 public constant INTENT_TYPEHASH =
        keccak256("Intent(address vault,bytes32 dataHash,bytes32 claimsHash,uint256 nonce,uint64 notAfterBlock)");
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 intentHash,uint8 outcome,uint64 checkedAtBlock,bytes32 receiptHash)");
    bytes32 public constant OVERRIDE_TYPEHASH = keccak256("Override(bytes32 intentHash)");

    address public immutable vault;
    address public validator;
    address public agent;
    uint64 public maxAgeBlocks;
    mapping(bytes4 selector => bool allowed) public allowedSelector;
    mapping(uint256 nonce => bool used) public usedNonce;

    event Executed(bytes32 indexed intentHash, uint8 outcome, bytes32 receiptHash, bool ownerOverride);
    event ValidatorSet(address indexed previousValidator, address indexed newValidator);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event MaxAgeBlocksSet(uint64 previousMaxAgeBlocks, uint64 newMaxAgeBlocks);
    event SelectorSet(bytes4 indexed selector, bool allowed);

    error ZeroVault();
    error NotAgent(address caller);
    error CalldataTooShort(uint256 length);
    error SelectorNotAllowed(bytes4 selector);
    error NonceUsed(uint256 nonce);
    error IntentExpired(uint64 notAfterBlock, uint256 blockNumber);
    error InvalidValidatorSignature(address recovered);
    error VerdictFromFuture(uint64 checkedAtBlock, uint256 blockNumber);
    error VerdictTooOld(uint64 checkedAtBlock, uint256 blockNumber, uint64 maxAgeBlocks);
    error Refuted(bytes32 intentHash, bytes32 receiptHash);
    error OverrideNotAuthorized(bytes32 intentHash);
    error InvalidOutcome(uint8 outcome);

    constructor(address initialOwner, address vault_, address validator_, address agent_, bytes4[] memory selectors)
        Ownable(initialOwner)
        EIP712("Proof of Reason", "1")
    {
        if (vault_ == address(0)) revert ZeroVault();
        vault = vault_;
        _setValidator(validator_);
        _setAgent(agent_);
        _setMaxAgeBlocks(DEFAULT_MAX_AGE_BLOCKS);
        for (uint256 i; i < selectors.length; ++i) {
            _setSelector(selectors[i], true);
        }
    }

    /// @notice Forward `data` to the vault if the validator's verdict allows it.
    /// @dev Checks run in the order fixed by the Proof of Reason build brief, steps 1 to 10.
    function execute(
        bytes calldata data,
        bytes32 claimsHash,
        uint256 nonce,
        uint64 notAfterBlock,
        uint8 outcome,
        uint64 checkedAtBlock,
        bytes32 receiptHash,
        bytes calldata validatorSig,
        bytes calldata ownerSig
    ) external nonReentrant {
        // 1 to 4. Agent only, allowlisted selector, fresh nonce, live intent; bind data and claims.
        bytes32 intentHash = _checkIntent(data, claimsHash, nonce, notAfterBlock);

        // 5. The verdict must be signed by the current validator.
        _checkValidator(intentHash, outcome, checkedAtBlock, receiptHash, validatorSig);

        // 6. The verdict must be fresh.
        _checkAge(checkedAtBlock);

        // 7. FAIL refutes, WAIT needs the owner, PASS continues.
        bool ownerOverride = _checkOutcome(intentHash, outcome, receiptHash, ownerSig);

        // 8. Consume the nonce before the external call.
        usedNonce[nonce] = true;

        // 9. Forward the exact bound calldata; bubble any revert.
        _forward(data);

        // 10.
        emit Executed(intentHash, outcome, receiptHash, ownerOverride);
    }

    function setValidator(address newValidator) external onlyOwner {
        _setValidator(newValidator);
    }

    function setAgent(address newAgent) external onlyOwner {
        _setAgent(newAgent);
    }

    function setMaxAgeBlocks(uint64 newMaxAgeBlocks) external onlyOwner {
        _setMaxAgeBlocks(newMaxAgeBlocks);
    }

    /// @dev Never allowlist a selector that can move assets out of the vault.
    function setAllowedSelector(bytes4 selector, bool allowed) external onlyOwner {
        _setSelector(selector, allowed);
    }

    function _checkIntent(bytes calldata data, bytes32 claimsHash, uint256 nonce, uint64 notAfterBlock)
        internal
        view
        returns (bytes32)
    {
        // 1.
        if (msg.sender != agent) revert NotAgent(msg.sender);

        // 2.
        if (data.length < 4) revert CalldataTooShort(data.length);
        bytes4 selector = bytes4(data[:4]);
        if (!allowedSelector[selector]) revert SelectorNotAllowed(selector);

        // 3.
        if (usedNonce[nonce]) revert NonceUsed(nonce);
        if (block.number > notAfterBlock) revert IntentExpired(notAfterBlock, block.number);

        // 4.
        return _hashTypedDataV4(
            keccak256(abi.encode(INTENT_TYPEHASH, vault, keccak256(data), claimsHash, nonce, notAfterBlock))
        );
    }

    function _checkValidator(
        bytes32 intentHash,
        uint8 outcome,
        uint64 checkedAtBlock,
        bytes32 receiptHash,
        bytes calldata validatorSig
    ) internal view {
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(VERDICT_TYPEHASH, intentHash, outcome, checkedAtBlock, receiptHash))
        );
        address recovered = ECDSA.recover(digest, validatorSig);
        if (recovered != validator) revert InvalidValidatorSignature(recovered);
    }

    function _checkAge(uint64 checkedAtBlock) internal view {
        if (checkedAtBlock > block.number) revert VerdictFromFuture(checkedAtBlock, block.number);
        if (block.number - checkedAtBlock > maxAgeBlocks) {
            revert VerdictTooOld(checkedAtBlock, block.number, maxAgeBlocks);
        }
    }

    function _checkOutcome(bytes32 intentHash, uint8 outcome, bytes32 receiptHash, bytes calldata ownerSig)
        internal
        view
        returns (bool ownerOverride)
    {
        if (outcome == FAIL) revert Refuted(intentHash, receiptHash);
        if (outcome == WAIT) {
            bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(OVERRIDE_TYPEHASH, intentHash)));
            if (!SignatureChecker.isValidSignatureNow(owner(), digest, ownerSig)) {
                revert OverrideNotAuthorized(intentHash);
            }
            return true;
        }
        if (outcome != PASS) revert InvalidOutcome(outcome);
        return false;
    }

    function _forward(bytes calldata data) internal {
        (bool ok, bytes memory ret) = vault.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _setValidator(address newValidator) internal {
        emit ValidatorSet(validator, newValidator);
        validator = newValidator;
    }

    function _setAgent(address newAgent) internal {
        emit AgentSet(agent, newAgent);
        agent = newAgent;
    }

    function _setMaxAgeBlocks(uint64 newMaxAgeBlocks) internal {
        emit MaxAgeBlocksSet(maxAgeBlocks, newMaxAgeBlocks);
        maxAgeBlocks = newMaxAgeBlocks;
    }

    function _setSelector(bytes4 selector, bool allowed) internal {
        allowedSelector[selector] = allowed;
        emit SelectorSet(selector, allowed);
    }
}
