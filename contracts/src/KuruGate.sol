// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// The Kuru MarginAccount. Limit orders draw from here, so the gate's trading balance lives here and
// not in the gate. Signatures from the official SDK (kuru-labs/kuru-sdk 0.0.95,
// abi/MarginAccount.json), selectors in docs/MONAD.md section 11. deposit credits the user passed to
// it, and withdraw only ever moves the caller's own balance, which is why both are owner-only
// functions here and never forwardable calldata.
interface IKuruMarginAccount {
    function deposit(address user, address token, uint256 amount) external payable;
    function withdraw(uint256 amount, address token) external;
    function batchWithdrawMaxTokens(address[] calldata tokens) external;
    function getBalance(address user, address token) external view returns (uint256);
}

/// @title KuruGate
/// @notice Proof of Reason veto-only executor for a typed-decision trading agent on Kuru. The gate
/// holds the trading balance. The agent may only ask it to forward an allowlisted Kuru selector to
/// one fixed venue, and only with a fresh validator verdict over the exact calldata.
/// @dev Hold the veto, never the keys:
/// - the venue is immutable, so no key can retarget the gate,
/// - only the owner can withdraw, so the agent key can never move funds out,
/// - only the owner can move funds into or out of the Kuru MarginAccount, and a withdrawal from it
///   can only land in the gate, from where only the owner can take it,
/// - the agent can only reach `execute`, which forwards to the venue with value 0,
/// - token approvals to the venue are set for the duration of one call and reset to zero after,
/// - selectors that move tokens out of the gate can never be allowlisted.
/// The Intent, Verdict, and Override types, the nonce, and the freshness bound are ReasonGate's, so
/// one validator and one engine serve both gates. Intent.vault carries the venue address.
contract KuruGate is Ownable2Step, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant PASS = 1;
    uint8 public constant WAIT = 2;
    uint8 public constant FAIL = 3;

    /// @dev Freshness bound, as in ReasonGate: about 18 s on Monad. Owner-settable.
    uint64 public constant DEFAULT_MAX_AGE_BLOCKS = 60;

    bytes32 public constant INTENT_TYPEHASH =
        keccak256("Intent(address vault,bytes32 dataHash,bytes32 claimsHash,uint256 nonce,uint64 notAfterBlock)");
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 intentHash,uint8 outcome,uint64 checkedAtBlock,bytes32 receiptHash)");
    bytes32 public constant OVERRIDE_TYPEHASH = keccak256("Override(bytes32 intentHash)");

    /// @dev Selectors that could move the gate's balance out. Computed from the interfaces.
    bytes4 public constant BLOCKED_TRANSFER = IERC20.transfer.selector;
    bytes4 public constant BLOCKED_TRANSFER_FROM = IERC20.transferFrom.selector;
    bytes4 public constant BLOCKED_APPROVE = IERC20.approve.selector;
    bytes4 public constant BLOCKED_MARGIN_WITHDRAW = IKuruMarginAccount.withdraw.selector;
    bytes4 public constant BLOCKED_MARGIN_BATCH_WITHDRAW = IKuruMarginAccount.batchWithdrawMaxTokens.selector;

    /// @notice The only contract this gate ever calls: a Kuru OrderBook market or the Kuru Router.
    address public immutable venue;
    /// @notice Quote token (USDC). Approved to the venue for the duration of one call.
    address public immutable quoteToken;
    /// @notice Base token, or address(0) when the base asset is native MON, as on Kuru MON-USDC.
    address public immutable baseToken;
    /// @notice The Kuru MarginAccount the venue settles against, or address(0) for a venue with none.
    address public immutable marginAccount;

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
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event MarginDeposited(address indexed token, uint256 amount);
    event MarginWithdrawn(address indexed token, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    error ZeroVenue();
    error NotAgent(address caller);
    error CalldataTooShort(uint256 length);
    error SelectorNotAllowed(bytes4 selector);
    error SelectorBlocked(bytes4 selector);
    error NonceUsed(uint256 nonce);
    error IntentExpired(uint64 notAfterBlock, uint256 blockNumber);
    error InvalidValidatorSignature(address recovered);
    error VerdictFromFuture(uint64 checkedAtBlock, uint256 blockNumber);
    error VerdictTooOld(uint64 checkedAtBlock, uint256 blockNumber, uint64 maxAgeBlocks);
    error Refuted(bytes32 intentHash, bytes32 receiptHash);
    error OverrideNotAuthorized(bytes32 intentHash);
    error InvalidOutcome(uint8 outcome);
    error NativeTransferFailed(address to, uint256 amount);
    error MarginAccountNotSet();

    constructor(
        address initialOwner,
        address venue_,
        address quoteToken_,
        address baseToken_,
        address marginAccount_,
        address validator_,
        address agent_,
        bytes4[] memory selectors
    ) Ownable(initialOwner) EIP712("Proof of Reason", "1") {
        if (venue_ == address(0)) revert ZeroVenue();
        venue = venue_;
        quoteToken = quoteToken_;
        baseToken = baseToken_;
        marginAccount = marginAccount_;
        _setValidator(validator_);
        _setAgent(agent_);
        _setMaxAgeBlocks(DEFAULT_MAX_AGE_BLOCKS);
        for (uint256 i; i < selectors.length; ++i) {
            _setSelector(selectors[i], true);
        }
    }

    /// @notice Holds the trading balance: the owner funds the gate with MON.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Forward `data` to the venue if the validator's verdict allows it.
    /// @dev Same order of checks as ReasonGate, steps 1 to 10. Value is always 0.
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

        // 9. Approve for this call only, forward the exact bound calldata, then reset to zero.
        _forward(data);

        // 10.
        emit Executed(intentHash, outcome, receiptHash, ownerOverride);
    }

    /// @notice Owner only: fund the venue's margin account from the gate's own balance, credited to
    /// the gate. token address(0) deposits native MON as value. The agent key cannot call this, and
    /// there is no path through `execute` to the margin account, because the venue is immutable.
    function depositMargin(address token, uint256 amount) external onlyOwner nonReentrant {
        if (marginAccount == address(0)) revert MarginAccountNotSet();
        emit MarginDeposited(token, amount);
        if (token == address(0)) {
            IKuruMarginAccount(marginAccount).deposit{value: amount}(address(this), address(0), amount);
        } else {
            // Approved for this deposit only, then reset, exactly as the venue approval is.
            IERC20(token).forceApprove(marginAccount, amount);
            IKuruMarginAccount(marginAccount).deposit(address(this), token, amount);
            IERC20(token).forceApprove(marginAccount, 0);
        }
    }

    /// @notice Owner only: pull the gate's margin balance back into the gate. Kuru's withdraw moves
    /// the caller's own balance, so the funds can only land here; `withdraw` then takes them out.
    function withdrawMargin(address token, uint256 amount) external onlyOwner nonReentrant {
        if (marginAccount == address(0)) revert MarginAccountNotSet();
        emit MarginWithdrawn(token, amount);
        IKuruMarginAccount(marginAccount).withdraw(amount, token);
    }

    /// @notice The gate's balance inside the margin account, for the owner and for observers.
    function marginBalance(address token) external view returns (uint256) {
        if (marginAccount == address(0)) revert MarginAccountNotSet();
        return IKuruMarginAccount(marginAccount).getBalance(address(this), token);
    }

    /// @notice Only the owner ever moves funds out. token address(0) withdraws native MON.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        emit Withdrawn(token, to, amount);
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
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

    /// @dev Only Kuru order and swap selectors belong here. The blocklist refuses the rest.
    function setAllowedSelector(bytes4 selector, bool allowed) external onlyOwner {
        _setSelector(selector, allowed);
    }

    function isBlockedSelector(bytes4 selector) public pure returns (bool) {
        return selector == BLOCKED_TRANSFER || selector == BLOCKED_TRANSFER_FROM || selector == BLOCKED_APPROVE
            || selector == BLOCKED_MARGIN_WITHDRAW || selector == BLOCKED_MARGIN_BATCH_WITHDRAW;
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

        // 4. The venue takes the Intent's vault slot: one validator serves both gates.
        return _hashTypedDataV4(
            keccak256(abi.encode(INTENT_TYPEHASH, venue, keccak256(data), claimsHash, nonce, notAfterBlock))
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

    /// @dev Approvals live for one call. Whatever the venue does not pull is un-approved again.
    function _forward(bytes calldata data) internal {
        _approve(quoteToken, type(uint256).max);
        _approve(baseToken, type(uint256).max);
        (bool ok, bytes memory ret) = venue.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        _approve(quoteToken, 0);
        _approve(baseToken, 0);
    }

    function _approve(address token, uint256 amount) internal {
        if (token == address(0)) return;
        IERC20(token).forceApprove(venue, amount);
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
        if (allowed && isBlockedSelector(selector)) revert SelectorBlocked(selector);
        allowedSelector[selector] = allowed;
        emit SelectorSet(selector, allowed);
    }
}
