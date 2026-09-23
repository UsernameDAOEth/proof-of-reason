// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @dev The ERC-8004 Identity Registry surface this registry needs. On Monad the registry at
/// 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 is an ERC-721 ("AgentIdentity", "AGENT", getVersion
/// 2.0.0), so an agent id is a token id and its owner is the token owner; see docs/MONAD.md section
/// 5. Operators are the ERC-721 approvals: one token, or all of an owner's tokens.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getApproved(uint256 agentId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

/// @title ValidationRegistry
/// @notice Interim ERC-8004 Validation Registry for Proof of Reason, with one documented addition.
/// @dev Why interim: the canonical ERC-8004 Validation Registry is not resolved on Monad mainnet at
/// the time of writing (docs/MONAD.md section 12). The Identity Registry is, so agent ids are real
/// and this registry never invents them: every record names an agent that exists there.
///
/// Conformant surface, as close to the ERC as could be resolved from source:
/// - `validationRequest(validator, agentId, requestUri, requestHash)`, callable by the agent's owner
///   or an operator per the Identity Registry,
/// - `validationResponse(requestHash, response, responseUri, responseHash, tag)`, callable only by
///   the validator the request named, with `response` 0 to 100, callable again for the same request,
/// - `getValidationStatus(requestHash)` and `getSummary(agentId, validators, tag)`.
///
/// The one addition, interim and to be dropped on migration:
/// - `validationResponse(agentId, requestHash, response, responseHash, tag)` records a response with
///   no prior request, so a refusal is on the record even when the agent never asked for one. A
///   Proof of Reason agent asks a validator before it acts; a WAIT or FAIL is exactly the case where
///   it has no reason to file a request afterwards, and those are the records that matter most. Such
///   a record is flagged: `wasRequested(requestHash)` is false and the event carries `requested`
///   false, so a reader can always tell a volunteered record from a requested one.
///
/// No upgradeability, no owner power over any record: nothing here is settable, and `Ownable2Step`
/// exists only so that ownership of this contract can be handed over when the canonical registry
/// arrives and this one is frozen (docs/MONAD.md section 12).
contract ValidationRegistry is Ownable2Step {
    uint8 public constant MAX_RESPONSE = 100;

    struct Validation {
        address validator;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        string requestUri;
        uint64 requestedAtBlock;
        uint64 lastUpdate;
        uint64 responses;
        bool requested;
        bool answered;
    }

    /// @notice The Identity Registry that owns the agent ids this registry cites.
    IIdentityRegistry public immutable identityRegistry;

    mapping(bytes32 requestHash => Validation validation) private _validations;
    mapping(uint256 agentId => bytes32[] requestHashes) private _agentValidations;
    mapping(address validator => bytes32[] requestHashes) private _validatorRequests;

    event ValidationRequest(
        address indexed validator, uint256 indexed agentId, bytes32 indexed requestHash, string requestUri
    );
    event ValidationResponse(
        address indexed validator,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        bytes32 responseHash,
        string tag,
        bool requested
    );

    error ZeroIdentityRegistry();
    error ZeroValidator();
    error ZeroRequestHash();
    error NotAgentOwnerOrOperator(address caller, uint256 agentId);
    error RequestExists(bytes32 requestHash);
    error RequestMismatch(bytes32 requestHash);
    error NoRequest(bytes32 requestHash);
    error NotNamedValidator(address caller, address validator);
    error ResponseOutOfRange(uint8 response);

    constructor(address initialOwner, address identityRegistry_) Ownable(initialOwner) {
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice The agent asks `validator` to validate `requestHash`. Owner or operator only.
    function validationRequest(address validator, uint256 agentId, string calldata requestUri, bytes32 requestHash)
        external
    {
        if (validator == address(0)) revert ZeroValidator();
        if (requestHash == bytes32(0)) revert ZeroRequestHash();
        // Reverts for an agent id the Identity Registry does not know.
        address agentOwner = identityRegistry.ownerOf(agentId);
        if (
            msg.sender != agentOwner && identityRegistry.getApproved(agentId) != msg.sender
                && !identityRegistry.isApprovedForAll(agentOwner, msg.sender)
        ) {
            revert NotAgentOwnerOrOperator(msg.sender, agentId);
        }

        Validation storage v = _validations[requestHash];
        if (v.requested) revert RequestExists(requestHash);
        if (v.answered) {
            // A volunteered record already exists. The agent may file its request over the top, but
            // only for the same agent and the same validator: the record is never rewritten.
            if (v.agentId != agentId || v.validator != validator) revert RequestMismatch(requestHash);
        } else {
            v.validator = validator;
            v.agentId = agentId;
            _agentValidations[agentId].push(requestHash);
            _validatorRequests[validator].push(requestHash);
        }
        v.requestUri = requestUri;
        v.requested = true;
        v.requestedAtBlock = uint64(block.number);
        emit ValidationRequest(validator, agentId, requestHash, requestUri);
    }

    /// @notice The named validator answers a request. Callable again: the latest response wins.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseUri,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Validation storage v = _validations[requestHash];
        if (!v.requested) revert NoRequest(requestHash);
        if (msg.sender != v.validator) revert NotNamedValidator(msg.sender, v.validator);
        responseUri; // the response document is addressed by responseHash through the validator's API
        _record(v, requestHash, v.agentId, response, responseHash, tag);
    }

    /// @notice Interim addition: the validator records a response with no prior request. The record
    /// is flagged as volunteered, and a reader can always tell it apart from a requested one.
    function validationResponse(
        uint256 agentId,
        bytes32 requestHash,
        uint8 response,
        bytes32 responseHash,
        string calldata tag
    ) external {
        if (requestHash == bytes32(0)) revert ZeroRequestHash();
        Validation storage v = _validations[requestHash];
        if (v.validator == address(0)) {
            // Reverts for an agent id the Identity Registry does not know, so a record can never
            // cite an agent that does not exist.
            identityRegistry.ownerOf(agentId);
            v.validator = msg.sender;
            v.agentId = agentId;
            _agentValidations[agentId].push(requestHash);
            _validatorRequests[msg.sender].push(requestHash);
        } else {
            if (msg.sender != v.validator) revert NotNamedValidator(msg.sender, v.validator);
            if (v.agentId != agentId) revert RequestMismatch(requestHash);
        }
        _record(v, requestHash, agentId, response, responseHash, tag);
    }

    /// @notice The latest response for a request, in the ERC's shape.
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validator, uint256 agentId, uint8 response, string memory tag, uint64 lastUpdate)
    {
        Validation storage v = _validations[requestHash];
        return (v.validator, v.agentId, v.response, v.tag, v.lastUpdate);
    }

    /// @notice How many validations an agent has, and their average response, optionally filtered by
    /// validator and by tag. An empty `validators` list means any validator, an empty `tag` any tag.
    function getSummary(uint256 agentId, address[] calldata validators, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32[] storage hashes = _agentValidations[agentId];
        uint256 total;
        for (uint256 i; i < hashes.length; ++i) {
            Validation storage v = _validations[hashes[i]];
            if (!v.answered) continue;
            if (!_matchesValidator(v.validator, validators)) continue;
            if (bytes(tag).length != 0 && keccak256(bytes(v.tag)) != keccak256(bytes(tag))) continue;
            total += v.response;
            count += 1;
        }
        avgResponse = count == 0 ? 0 : uint8(total / count);
    }

    /// @notice Every request hash recorded for an agent, requested or volunteered.
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    /// @notice Every request hash a validator is named on.
    function getValidatorRequests(address validator) external view returns (bytes32[] memory) {
        return _validatorRequests[validator];
    }

    /// @notice Part of the interim addition: false for a response the agent never asked for.
    function wasRequested(bytes32 requestHash) external view returns (bool) {
        return _validations[requestHash].requested;
    }

    /// @notice The full record, including how many times it has been answered.
    function getValidation(bytes32 requestHash) external view returns (Validation memory) {
        return _validations[requestHash];
    }

    function _record(
        Validation storage v,
        bytes32 requestHash,
        uint256 agentId,
        uint8 response,
        bytes32 responseHash,
        string calldata tag
    ) internal {
        if (response > MAX_RESPONSE) revert ResponseOutOfRange(response);
        v.response = response;
        v.responseHash = responseHash;
        v.tag = tag;
        v.lastUpdate = uint64(block.number);
        v.responses += 1;
        v.answered = true;
        emit ValidationResponse(v.validator, agentId, requestHash, response, responseHash, tag, v.requested);
    }

    function _matchesValidator(address validator, address[] calldata validators) internal pure returns (bool) {
        if (validators.length == 0) return true;
        for (uint256 i; i < validators.length; ++i) {
            if (validators[i] == validator) return true;
        }
        return false;
    }
}
