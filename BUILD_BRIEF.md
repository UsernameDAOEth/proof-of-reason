# Proof of Reason build brief, Phase 1 (core, days 1 to 3)

Name: Proof of Reason. Always the full phrase. Never abbreviate it, in code or copy.
Issuer: DJZS AI, LLC.
Product: a premise check on automated allocation.
Doctrine: the LLM reads, the chain testifies, TypeScript decides.
Principle: hold the veto, never the keys. The gate can block a call. It can never start one, hold funds, or move assets out of a vault.

## Session rules
- Do not push. Do not run wrangler. Do not create, read, or print secrets.
- DJ commits at his own terminal. Stop where this brief says STOP.
- Step 0 comes before any code.
- Every numeric convention is declared, never guessed.
- No em dashes in any file. The repo goes public at submission.

## Step 0: write docs/PREREG.md verbatim (text between the markers), then STOP and ask DJ to commit it

----- BEGIN PREREG -----
# Proof of Reason market-fit pre-registration v1.0
Registered: 2026-09-17, before any product code.
Append-only. Amendments are appended with date and reason. Text above an amendment is never edited.

## Product under test
Proof of Reason checks the reason an automated allocator gives before a vault moves money: premises against chain state (TRUE), the action against the principal's mandate (ALLOWED), required fields present (COMPLETE). The gate holds a veto only.

## Hypothesis
Curated-vault operators and allocator teams will pay for, or require, an independent pre-execution premise check, because it lets them evidence each reallocation to depositors and distributors.

## Assumptions, tests, thresholds
A1 Premise failures happen often enough to matter.
Test: read-only audits of public agent reasoning against the state it cites, plus any operator logs shared with us.
Pass: at least 1 action in 20 carries a false premise at the time it was made.
Kill: fewer than 1 in 100 across at least 200 audited actions.

A2 Operators feel trust or liability pain.
Test: 20 discovery calls, no pitch in the first half of any call.
Pass: at least 5 of 20 raise evidencing, depositor trust, or agent-action liability unprompted.
Kill: at least 12 of 20 answer that caps and allowlists already cover it.

A3 Someone will require it.
Test: ask every allocator, curator, insurer, and listing platform contacted whether they would make it a condition.
Pass: 1 written commitment by 2026-11-03.
Kill: zero after all asks.

A4 Operators accept integration.
Test: paid pilot offer inside their existing stack (allocator role, Safe guard, or vault micro-manager).
Pass: 2 paid pilots by 2026-12-15.
Kill: every refusal is "we will build our own".

A5 Error rates are livable.
Test: demo and pilot telemetry.
Pass: WAIT rate under 20 percent and zero false FAILs after convention fixes, over at least 100 checks.
Kill: any pilot principal disables the gate over false FAILs.

## Gates
2026-10-13: hackathon submission; first read of A1 and A2.
2026-11-03: A3 read.
2026-12-15: fit gate. Pass requires A1 pass, 2 paid pilots, and 1 written requirer. A miss means no hosted validator is built; the code stays open source as consulting collateral.

## Counting rules
- DJ, DJZS AI, LLC, and any wallet or account DJ controls never count as a user, pilot, or requirer.
- A paid pilot is money received, any amount above zero, invoiced by DJZS AI, LLC.
- A discovery call counts only if it lasts at least 20 minutes and the person holds budget or execution authority over allocation.
- Every call gets a dated note within 24 hours: who, role, what they raised unprompted, what they asked for.

## Disclosure
Results publish at each gate date whichever way they fall, including a kill.
----- END PREREG -----

## Step 1: layout
contracts/  Foundry v1.8.0 or later with the Monad execution network enabled; Solidity 0.8.26+; OpenZeppelin v5
engine/     TypeScript, pnpm, vitest, viem, zod. Pure functions first.
docs/       PREREG.md, CLAIMS.md (generated from the schema)

## Step 2: contracts/src/ReasonGate.sol
A veto-only executor holding an allocator-type role on ONE vault. The agent calls the gate. The gate forwards the exact bound calldata to the vault only with a valid verdict.

State: owner (Ownable2Step), vault (immutable), validator, agent, allowedSelector mapping, maxAgeBlocks (default 20), usedNonce mapping.
EIP-712 domain: name "Proof of Reason", version "1", chainId, verifyingContract = the gate.
Types:
  Intent(address vault,bytes32 dataHash,bytes32 claimsHash,uint256 nonce,uint64 notAfterBlock)
  Verdict(bytes32 intentHash,uint8 outcome,uint64 checkedAtBlock,bytes32 receiptHash)   outcome 1 PASS, 2 WAIT, 3 FAIL
  Override(bytes32 intentHash)

execute(data, claimsHash, nonce, notAfterBlock, outcome, checkedAtBlock, receiptHash, validatorSig, ownerSig):
 1. msg.sender must be agent
 2. data.length >= 4 and allowedSelector[bytes4(data[:4])]
 3. nonce unused; block.number <= notAfterBlock
 4. intentHash = _hashTypedDataV4(Intent(vault, keccak256(data), claimsHash, nonce, notAfterBlock))
 5. ECDSA.recover over Verdict(intentHash, outcome, checkedAtBlock, receiptHash) must equal validator
 6. checkedAtBlock <= block.number and block.number - checkedAtBlock <= maxAgeBlocks
 7. FAIL: revert Refuted(intentHash, receiptHash). WAIT: SignatureChecker.isValidSignatureNow(owner, Override digest, ownerSig) must be true (owner may be an EOA or a Safe). PASS: continue.
 8. mark the nonce used before the external call
 9. vault.call(data); bubble the revert data on failure
10. emit Executed(intentHash, outcome, receiptHash, ownerOverride)
Also: nonReentrant; nothing payable; no receive(); no token approvals; every owner setter emits an event.
Selectors: compute from the vault ABI, never hardcode hex. Candidates: MetaMorpho V1.1 reallocate; Vault V2 allocate and deallocate (confirm exact signatures from the vault-v2 source first). Never allowlist a selector that can move assets out of the vault.

contracts/test/ReasonGate.t.sol with a MockVault that records calls. Required cases:
PASS executes and emits; FAIL reverts Refuted; WAIT without owner sig reverts; WAIT with owner sig executes (EOA and ERC-1271 owner); verdict older than maxAgeBlocks reverts; checkedAtBlock in the future reverts; notAfterBlock passed reverts; replayed nonce reverts; disallowed selector reverts; calldata changed after signing reverts; verdict signed for another chainId or another gate reverts; non-agent caller reverts; old validator rejected after rotation; high-s signature rejected.

## Step 3: engine/ (pure core)
src/claims.ts  zod schema ClaimV0. Every claim has id, kind, sourceSpan (verbatim text from the reason, or null when the agent sends typed claims).
  rate:        market (bytes32), side supply|borrow, valuePct, basis APY|APR, compounding "continuous", window {instant} or {median, blocks}, tolerancePp
  utilization: market, valuePct, tolerancePp
  liquidity:   market, minWithdrawable (decimal string, loan-token atomic units)
  identity:    market, loanToken, collateralToken, oracle, irm, lltv (decimal string)
  The action check is automatic: decode the vault calldata and compare markets and amounts to the agent's stated action. Any mismatch is FAIL.
src/morpho.ts  Morpho Blue observers at a pinned block (viem readContract with blockNumber):
  market(id): totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee
  idToMarketParams(id): loanToken, collateralToken, oracle, irm, lltv
  irm.borrowRateView(marketParams, market): borrow rate per second, WAD
  utilization = totalBorrowAssets / totalSupplyAssets (0 when supply is 0)
  supplyRatePerSecond = borrowRatePerSecond * utilization * (1 - fee / 1e18)
  APR = ratePerSecond * 31_536_000; APY = exp(APR) - 1. Document this in CLAIMS.md.
  withdrawable = totalSupplyAssets - totalBorrowAssets
  Manipulation guard: read the last N blocks (default 5), use the median; if max minus min exceeds 2x tolerance, the result is UNVERIFIABLE.
src/compare.ts  claim + observation -> { status TRUE|FALSE|UNVERIFIABLE, claimed, observed, block }
src/verdict.ts  pure. Any FALSE, action mismatch, or mandate violation -> FAIL. Else any UNVERIFIABLE or missing required kind -> WAIT. Else PASS. Returns the failing items with claimed, observed, and block.
src/receipt.ts  canonical JSON (sorted keys, bigints as decimal strings, no undefined); receiptHash = keccak256. Contents: intent fields, claims, observations with blocks, verdict, ruleset "REASON-R0", engine version, model id (null for typed claims).
src/sign.ts     EIP-712 Verdict signing with a viem LocalAccount passed in by the caller. This module never reads keys from disk or env.
Tests (vitest):
  verdict.ts exhaustive over every input combination, with invariants: any FALSE implies FAIL; no FALSE and any UNVERIFIABLE implies WAIT; PASS only when all TRUE and complete
  morpho.ts formulas against a hand-computed fixture market
  compare.ts edges: exactly at tolerance is TRUE; APR claimed against an APY basis is a schema error, not a FALSE
  receipt.ts: same input gives the same hash regardless of key order

## Step 4: report, then STOP
Print the forge test summary, the vitest summary, and anything unverified. Do not start Phase 2.

## Phase 2 preview (do not start)
- Worker route POST /x402/check on Monad: facilitator https://x402-facilitator.molandak.org, network eip155:143, USDC 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, EIP-712 domain name "USDC" version "2", exact scheme, @x402/evm 2.22.0 or later.
- Confirm which Morpho vault version and factory exist on Monad (143), deploy a small vault, grant the gate the allocator role. Monad charges the gas limit: set explicit gas in every script.
- Register the validator on Monad's ERC-8004 Identity Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432.
- On-chain re-assertion (ruleset REASON-R1): the gate re-checks rate and utilization bounds against Morpho state inside execute.
- Read-only shadow-audit runner reusing compare.ts and verdict.ts on public reasoning datasets (A1).
