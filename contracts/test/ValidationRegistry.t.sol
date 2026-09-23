// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IIdentityRegistry, ValidationRegistry} from "../src/ValidationRegistry.sol";

/// @dev The ERC-721 surface of the ERC-8004 Identity Registry, as docs/MONAD.md section 5 records
/// it: an agent id is a token id, its owner is the token owner, operators are ERC-721 approvals.
/// ownerOf reverts for an agent id that was never registered, as ERC-721 requires.
contract MockIdentityRegistry is IIdentityRegistry {
    error NonexistentAgent(uint256 agentId);

    mapping(uint256 agentId => address owner) public owners;
    mapping(uint256 agentId => address operator) public approved;
    mapping(address owner => mapping(address operator => bool ok)) public operators;

    function mint(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function approve(uint256 agentId, address operator) external {
        approved[agentId] = operator;
    }

    function setApprovalForAll(address owner, address operator, bool ok) external {
        operators[owner][operator] = ok;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = owners[agentId];
        if (owner == address(0)) revert NonexistentAgent(agentId);
        return owner;
    }

    function getApproved(uint256 agentId) external view returns (address) {
        return approved[agentId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return operators[owner][operator];
    }
}

contract ValidationRegistryTest is Test {
    /// @dev The two overloads have different selectors. Named here so the tests read plainly.
    bytes4 internal constant RESPONSE_WITH_REQUEST = bytes4(keccak256("validationResponse(bytes32,uint8,string,bytes32,string)"));
    bytes4 internal constant RESPONSE_NO_REQUEST =
        bytes4(keccak256("validationResponse(uint256,bytes32,uint8,bytes32,string)"));

    uint8 internal constant PASS = 100;
    uint8 internal constant WAIT = 50;
    uint8 internal constant FAIL = 0;

    string internal constant TAG = "REASON-R0";

    ValidationRegistry internal registry;
    MockIdentityRegistry internal identity;

    address internal registryOwner = makeAddr("registryOwner");
    address internal agentOwner = makeAddr("agentOwner");
    address internal operator = makeAddr("operator");
    address internal validator = makeAddr("validator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AGENT_ID = 7;
    uint256 internal constant UNKNOWN_AGENT_ID = 999;
    bytes32 internal constant INTENT_HASH = keccak256("intent");
    bytes32 internal constant RECEIPT_HASH = keccak256("receipt");

    function setUp() public {
        vm.roll(1_000);
        identity = new MockIdentityRegistry();
        identity.mint(AGENT_ID, agentOwner);
        registry = new ValidationRegistry(registryOwner, address(identity));
    }

    // ---------------------------------------------------------------- helpers

    function _request(address caller, bytes32 requestHash) internal {
        vm.prank(caller);
        registry.validationRequest(validator, AGENT_ID, "https://api.proofofreason.com/check", requestHash);
    }

    function _respond(address caller, bytes32 requestHash, uint8 response) internal {
        vm.prank(caller);
        registry.validationResponse(requestHash, response, "", RECEIPT_HASH, TAG);
    }

    function _respondNoRequest(address caller, uint256 agentId, bytes32 requestHash, uint8 response, bytes32 receiptHash)
        internal
    {
        vm.prank(caller);
        registry.validationResponse(agentId, requestHash, response, receiptHash, TAG);
    }

    // ---------------------------------------------------------------- requests

    function test_request_byAgentOwner_isRecordedAndEmitted() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ValidationRegistry.ValidationRequest(
            validator, AGENT_ID, INTENT_HASH, "https://api.proofofreason.com/check"
        );
        _request(agentOwner, INTENT_HASH);

        assertTrue(registry.wasRequested(INTENT_HASH));
        ValidationRegistry.Validation memory v = registry.getValidation(INTENT_HASH);
        assertEq(v.validator, validator);
        assertEq(v.agentId, AGENT_ID);
        assertEq(v.requestedAtBlock, uint64(block.number));
        assertFalse(v.answered);
        assertEq(registry.getAgentValidations(AGENT_ID).length, 1);
        assertEq(registry.getValidatorRequests(validator)[0], INTENT_HASH);
    }

    function test_request_byTokenOperator_andByOperatorForAll_areAccepted() public {
        identity.approve(AGENT_ID, operator);
        _request(operator, INTENT_HASH);
        assertTrue(registry.wasRequested(INTENT_HASH));

        bytes32 second = keccak256("intent 2");
        identity.approve(AGENT_ID, address(0));
        identity.setApprovalForAll(agentOwner, operator, true);
        _request(operator, second);
        assertTrue(registry.wasRequested(second));
    }

    function test_request_byStranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotAgentOwnerOrOperator.selector, stranger, AGENT_ID));
        registry.validationRequest(validator, AGENT_ID, "", INTENT_HASH);
        assertFalse(registry.wasRequested(INTENT_HASH));
    }

    function test_request_forAnUnknownAgent_reverts() public {
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(MockIdentityRegistry.NonexistentAgent.selector, UNKNOWN_AGENT_ID));
        registry.validationRequest(validator, UNKNOWN_AGENT_ID, "", INTENT_HASH);
    }

    function test_request_twice_reverts_andZeroArgumentsRevert() public {
        _request(agentOwner, INTENT_HASH);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestExists.selector, INTENT_HASH));
        registry.validationRequest(validator, AGENT_ID, "", INTENT_HASH);

        vm.startPrank(agentOwner);
        vm.expectRevert(ValidationRegistry.ZeroValidator.selector);
        registry.validationRequest(address(0), AGENT_ID, "", keccak256("other"));
        vm.expectRevert(ValidationRegistry.ZeroRequestHash.selector);
        registry.validationRequest(validator, AGENT_ID, "", bytes32(0));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- responses

    function test_response_onlyTheNamedValidator() public {
        _request(agentOwner, INTENT_HASH);

        address[2] memory callers = [stranger, agentOwner];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(ValidationRegistry.NotNamedValidator.selector, callers[i], validator)
            );
            registry.validationResponse(INTENT_HASH, PASS, "", RECEIPT_HASH, TAG);
        }

        // And the interim overload is no way around it.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotNamedValidator.selector, stranger, validator));
        registry.validationResponse(AGENT_ID, INTENT_HASH, PASS, RECEIPT_HASH, TAG);

        _respond(validator, INTENT_HASH, PASS);
        (,, uint8 response,,) = registry.getValidationStatus(INTENT_HASH);
        assertEq(response, PASS);
    }

    function test_response_eventCarriesAgentIdRequestHashResponseResponseHashAndTag() public {
        _request(agentOwner, INTENT_HASH);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ValidationRegistry.ValidationResponse(validator, AGENT_ID, INTENT_HASH, WAIT, RECEIPT_HASH, TAG, true);
        _respond(validator, INTENT_HASH, WAIT);
    }

    function test_response_canBePostedAgain_andTheLatestWins() public {
        _request(agentOwner, INTENT_HASH);
        _respond(validator, INTENT_HASH, FAIL);

        vm.roll(vm.getBlockNumber() + 5);
        uint64 rolled = uint64(vm.getBlockNumber());
        vm.prank(validator);
        registry.validationResponse(INTENT_HASH, PASS, "", keccak256("receipt 2"), "REASON-R1");

        (address named, uint256 agentId, uint8 response, string memory tag, uint64 lastUpdate) =
            registry.getValidationStatus(INTENT_HASH);
        assertEq(named, validator);
        assertEq(agentId, AGENT_ID);
        assertEq(response, PASS);
        assertEq(tag, "REASON-R1");
        assertEq(lastUpdate, rolled);

        ValidationRegistry.Validation memory v = registry.getValidation(INTENT_HASH);
        assertEq(v.responses, 2);
        assertEq(v.responseHash, keccak256("receipt 2"));
        // One request, one record: answering again does not add a second entry.
        assertEq(registry.getAgentValidations(AGENT_ID).length, 1);
    }

    function test_response_outOfRange_reverts() public {
        _request(agentOwner, INTENT_HASH);
        vm.prank(validator);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ResponseOutOfRange.selector, uint8(101)));
        registry.validationResponse(INTENT_HASH, 101, "", RECEIPT_HASH, TAG);

        vm.prank(validator);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ResponseOutOfRange.selector, uint8(255)));
        registry.validationResponse(AGENT_ID, keccak256("volunteered"), 255, RECEIPT_HASH, TAG);
    }

    // ------------------------------------------------- the interim addition

    function test_responseWithoutRequest_isRecordedAndFlagged() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ValidationRegistry.ValidationResponse(validator, AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH, TAG, false);
        _respondNoRequest(validator, AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH);

        // Recorded, and flagged as one the agent never asked for.
        assertFalse(registry.wasRequested(INTENT_HASH));
        (address named, uint256 agentId, uint8 response, string memory tag, uint64 lastUpdate) =
            registry.getValidationStatus(INTENT_HASH);
        assertEq(named, validator);
        assertEq(agentId, AGENT_ID);
        assertEq(response, FAIL);
        assertEq(tag, TAG);
        assertEq(lastUpdate, uint64(block.number));
        ValidationRegistry.Validation memory v = registry.getValidation(INTENT_HASH);
        assertEq(v.requestedAtBlock, 0);
        assertTrue(v.answered);
        assertEq(registry.getAgentValidations(AGENT_ID)[0], INTENT_HASH);
        assertEq(registry.getValidatorRequests(validator)[0], INTENT_HASH);
    }

    function test_responseWithoutRequest_stillNeedsAnAgentThatExists() public {
        vm.prank(validator);
        vm.expectRevert(abi.encodeWithSelector(MockIdentityRegistry.NonexistentAgent.selector, UNKNOWN_AGENT_ID));
        registry.validationResponse(UNKNOWN_AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH, TAG);
        assertEq(registry.getAgentValidations(UNKNOWN_AGENT_ID).length, 0);
    }

    function test_theConformantOverloadStillRequiresARequest() public {
        vm.prank(validator);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NoRequest.selector, INTENT_HASH));
        registry.validationResponse(INTENT_HASH, PASS, "", RECEIPT_HASH, TAG);
    }

    function test_theAgentCanFileItsRequestOverAVolunteeredRecord_butNothingIsRewritten() public {
        _respondNoRequest(validator, AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH);
        assertFalse(registry.wasRequested(INTENT_HASH));

        _request(agentOwner, INTENT_HASH);
        assertTrue(registry.wasRequested(INTENT_HASH));
        ValidationRegistry.Validation memory v = registry.getValidation(INTENT_HASH);
        // The verdict it volunteered is untouched by the request.
        assertEq(v.response, FAIL);
        assertEq(v.responseHash, RECEIPT_HASH);
        assertEq(v.agentId, AGENT_ID);
        assertEq(registry.getAgentValidations(AGENT_ID).length, 1);
    }

    function test_aRequestCannotReassignAVolunteeredRecord() public {
        _respondNoRequest(validator, AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH);
        identity.mint(8, agentOwner);

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestMismatch.selector, INTENT_HASH));
        registry.validationRequest(validator, 8, "", INTENT_HASH);

        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestMismatch.selector, INTENT_HASH));
        registry.validationRequest(stranger, AGENT_ID, "", INTENT_HASH);
    }

    function test_volunteeredRecordCannotBeRetargetedToAnotherAgent() public {
        _respondNoRequest(validator, AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH);
        identity.mint(8, agentOwner);
        vm.prank(validator);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.RequestMismatch.selector, INTENT_HASH));
        registry.validationResponse(8, INTENT_HASH, PASS, RECEIPT_HASH, TAG);
    }

    // ---------------------------------------------------------------- summary

    function test_getSummary_countsAndAveragesAcrossValidatorsAndTags() public {
        address other = makeAddr("otherValidator");
        _respondNoRequest(validator, AGENT_ID, keccak256("a"), PASS, RECEIPT_HASH);
        _respondNoRequest(validator, AGENT_ID, keccak256("b"), FAIL, RECEIPT_HASH);
        _respondNoRequest(other, AGENT_ID, keccak256("c"), WAIT, RECEIPT_HASH);
        // A request with no response yet is not counted.
        _request(agentOwner, keccak256("d"));

        address[] memory none = new address[](0);
        (uint64 count, uint8 avg) = registry.getSummary(AGENT_ID, none, "");
        assertEq(count, 3);
        assertEq(avg, 50); // (100 + 0 + 50) / 3

        address[] memory justValidator = new address[](1);
        justValidator[0] = validator;
        (count, avg) = registry.getSummary(AGENT_ID, justValidator, "");
        assertEq(count, 2);
        assertEq(avg, 50); // (100 + 0) / 2

        (count, avg) = registry.getSummary(AGENT_ID, justValidator, TAG);
        assertEq(count, 2);
        (count, avg) = registry.getSummary(AGENT_ID, justValidator, "REASON-R9");
        assertEq(count, 0);
        assertEq(avg, 0);

        (count, avg) = registry.getSummary(8, none, "");
        assertEq(count, 0);
        assertEq(avg, 0);
    }

    // ---------------------------------------------------------------- ownership

    function test_theOwnerHasNoPowerOverAnyRecord() public {
        _respondNoRequest(validator, AGENT_ID, INTENT_HASH, FAIL, RECEIPT_HASH);

        // Ownable2Step is the whole of it: no setter exists, so the owner cannot touch a record.
        vm.prank(registryOwner);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.NotNamedValidator.selector, registryOwner, validator));
        registry.validationResponse(AGENT_ID, INTENT_HASH, PASS, RECEIPT_HASH, TAG);

        assertEq(registry.owner(), registryOwner);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.transferOwnership(stranger);

        // Two-step handover, for the migration in docs/MONAD.md section 12.
        vm.prank(registryOwner);
        registry.transferOwnership(stranger);
        assertEq(registry.owner(), registryOwner);
        assertEq(registry.pendingOwner(), stranger);
        vm.prank(stranger);
        registry.acceptOwnership();
        assertEq(registry.owner(), stranger);
    }

    function test_bothOverloadsAreReachableByTheirOwnSelector() public {
        assertTrue(RESPONSE_WITH_REQUEST != RESPONSE_NO_REQUEST);

        // The interim selector, the one the worker calls, records without a request.
        vm.prank(validator);
        (bool volunteered,) = address(registry).call(
            abi.encodeWithSelector(RESPONSE_NO_REQUEST, AGENT_ID, INTENT_HASH, PASS, RECEIPT_HASH, TAG)
        );
        assertTrue(volunteered);
        assertFalse(registry.wasRequested(INTENT_HASH));

        // The conformant selector refuses without one.
        bytes32 other = keccak256("never requested");
        vm.prank(validator);
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeWithSelector(RESPONSE_WITH_REQUEST, other, PASS, "", RECEIPT_HASH, TAG));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ValidationRegistry.NoRequest.selector, other));
    }
}
