# Proof of Reason claim schema

Generated from engine/src/claims.ts by `pnpm gen:claims`. Do not edit by hand. Ruleset REASON-R0, engine 0.2.0.

## ClaimV0

Every claim carries id, kind, and sourceSpan. Unknown fields are rejected. Claim ids are unique within a claim set.

### kind rate

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"rate"` | yes |  |
| market | string matching `^0x[0-9a-fA-F]{64}$` | yes | Morpho Blue market id |
| side | `"supply"` or `"borrow"` | yes |  |
| valuePct | number >= 0 | yes | claimed annual rate in percent: 5.2 means 5.2 percent |
| basis | `"APY"` or `"APR"` | yes | annualization basis of valuePct |
| compounding | `"continuous"` | yes | APY compounding convention |
| window | { type: `"instant"` } or { type: `"median"`, blocks: integer >= 1, <= 20 } | yes | instant: the rate at the pinned block, read through the default guard window; median: the median over the given number of blocks ending at the pinned block |
| tolerancePp | number >= 0 | yes | allowed absolute difference, in percentage points |

### kind utilization

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"utilization"` | yes |  |
| market | string matching `^0x[0-9a-fA-F]{64}$` | yes | Morpho Blue market id |
| valuePct | number >= 0, <= 100 | yes | claimed utilization in percent |
| tolerancePp | number >= 0 | yes | allowed absolute difference, in percentage points |

### kind liquidity

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"liquidity"` | yes |  |
| market | string matching `^0x[0-9a-fA-F]{64}$` | yes | Morpho Blue market id |
| minWithdrawable | string matching `^(0\|[1-9][0-9]*)$` | yes | claimed lower bound on totalSupplyAssets - totalBorrowAssets, in loan-token atomic units |

### kind identity

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"identity"` | yes |  |
| market | string matching `^0x[0-9a-fA-F]{64}$` | yes | Morpho Blue market id |
| loanToken | string matching `^0x[0-9a-fA-F]{40}$` | yes | 20-byte hex address with 0x prefix, compared case-insensitively |
| collateralToken | string matching `^0x[0-9a-fA-F]{40}$` | yes | 20-byte hex address with 0x prefix, compared case-insensitively |
| oracle | string matching `^0x[0-9a-fA-F]{40}$` | yes | 20-byte hex address with 0x prefix, compared case-insensitively |
| irm | string matching `^0x[0-9a-fA-F]{40}$` | yes | 20-byte hex address with 0x prefix, compared case-insensitively |
| lltv | string matching `^(0\|[1-9][0-9]*)$` | yes | raw WAD integer: 86 percent is "860000000000000000" |

## ActionV0

The allocation the agent says it is making. The engine decodes the vault calldata and compares it field by field.

### fn reallocate

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| fn | `"reallocate"` | yes | MetaMorpho V1.1 reallocate(MarketAllocation[]) |
| allocations | array of { market: string matching `^0x[0-9a-fA-F]{64}$`, assets: string matching `^(0\|[1-9][0-9]*)$` }, at least 1 | yes |  |

### fn allocate

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| fn | `"allocate"` | yes | Vault V2 allocate(address,bytes,uint256) |
| adapter | string matching `^0x[0-9a-fA-F]{40}$` | yes | 20-byte hex address with 0x prefix, compared case-insensitively |
| market | string matching `^0x[0-9a-fA-F]{64}$` | yes | Morpho Blue market id encoded in the adapter data |
| assets | string matching `^(0\|[1-9][0-9]*)$` | yes | loan-token atomic units |

### fn deallocate

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| fn | `"deallocate"` | yes | Vault V2 deallocate(address,bytes,uint256) |
| adapter | string matching `^0x[0-9a-fA-F]{40}$` | yes | 20-byte hex address with 0x prefix, compared case-insensitively |
| market | string matching `^0x[0-9a-fA-F]{64}$` | yes | Morpho Blue market id encoded in the adapter data |
| assets | string matching `^(0\|[1-9][0-9]*)$` | yes | loan-token atomic units |

### fn kuru_order

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| fn | `"kuru_order"` | yes | Kuru OrderBook batchUpdate: one post-only order per block |
| venue | string matching `^0x[0-9a-fA-F]{40}$` | yes | the Kuru OrderBook market the gate forwards to |
| side | `"buy"` or `"sell"` or `"cancel-only"` | yes |  |
| price | string matching `^(0\|[1-9][0-9]*)$` | yes | price in pricePrecision units, exactly as in the calldata; 0 for cancel-only |
| size | string matching `^(0\|[1-9][0-9]*)$` | yes | size in sizePrecision units, exactly as in the calldata; 0 for cancel-only |
| cancels | integer >= 0, <= 64 | yes | how many order ids the call cancels |
| postOnly | boolean | yes |  |

## MandateV0

Set by the principal.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| allowedMarkets | array of string matching `^0x[0-9a-fA-F]{64}$` | yes | every market the calldata touches must be listed |
| requiredKinds | array of `"rate"` or `"utilization"` or `"liquidity"` or `"identity"` | yes | claim kinds that must be present for a PASS |

## Conventions

1. Percent values: valuePct is a percentage (5.2 means 5.2 percent). tolerancePp is an absolute difference in percentage points.
2. Reads: every chain read is one eth_call pinned to one block, sent only after the previous read returns, in claim order and then ascending block order. Reads are never batched (no JSON-RPC batch, no Multicall) and never concurrent.
3. Borrow rate: the market IRM borrowRateView(marketParams, market) at the pinned block, a per-second rate scaled by 1e18 (WAD). A market whose irm is the zero address has a borrow rate of 0.
4. Utilization: totalBorrowAssets / totalSupplyAssets, and 0 when totalSupplyAssets is 0.
5. Supply rate: supplyRatePerSecond = borrowRatePerSecond * utilization * (1 - fee / 1e18), computed in integer WAD arithmetic as borrowRate * totalBorrowAssets * (1e18 - fee) / (totalSupplyAssets * 1e18) with one floor division.
6. APR = ratePerSecond * 31536000 (a 365-day year). APY = exp(APR) - 1 (continuous compounding). Percent = fraction * 100.
7. Basis: a rate claim is compared only against an observation on the same basis and side. APR claimed against an APY basis is a schema error, never a FALSE.
8. Manipulation guard: rate and utilization are sampled at every block of a window ending at the pinned block. The window is window.blocks for a median rate claim and 5 blocks otherwise. The observed value is the median of the samples (the mean of the two middle samples when the count is even). If max minus min exceeds 2 * tolerancePp, the result is UNVERIFIABLE. window.blocks is at most 20, so a rate claim needs at most 41 reads (params once, then state and IRM rate at each block).
9. Tolerance: a rate or utilization claim is TRUE when |observed - claimed| <= tolerancePp. Exactly at tolerance is TRUE.
10. Slack: every tolerance comparison, including the manipulation guard, adds a fixed 1e-9 percentage points (TOLERANCE_SLACK_PP) to absorb IEEE 754 rounding. So |observed - claimed| <= tolerancePp + 1e-9 and max - min > 2 * tolerancePp + 1e-9.
11. Liquidity: withdrawable = totalSupplyAssets - totalBorrowAssets, in loan-token atomic units, sampled at every block of the 5-block window ending at the pinned block. A floor claim takes the MINIMUM over the window, not the median. TRUE when that minimum >= minWithdrawable.
12. Identity: TRUE when loanToken, collateralToken, oracle, irm, and lltv all equal idToMarketParams(market) at the pinned block.
13. Uncreated market: a rate, utilization, or liquidity claim on a market whose lastUpdate is 0 at any block of its window is UNVERIFIABLE.
14. Action check: the vault calldata is decoded and compared with the stated action, function, adapter, market ids, and amounts, in order. The calldata must also re-encode to the exact same bytes. Any mismatch or undecodable calldata is FAIL. Market id = keccak256(abi.encode(MarketParams)).
15. Mandate check: every market the decoded calldata touches, including markets reduced to zero, must be in mandate.allowedMarkets. Any violation is FAIL.
16. Freshness bound: ReasonGate accepts a verdict only while checkedAtBlock <= block.number and block.number - checkedAtBlock <= maxAgeBlocks. maxAgeBlocks defaults to 60 blocks (about 18 s on Monad at about 0.30 s per block) and is owner-settable with setMaxAgeBlocks. checkedAtBlock is the pinned block the observers read.
17. Verdict (ruleset REASON-R0): any FALSE, action mismatch, or mandate violation gives FAIL. Otherwise any UNVERIFIABLE or any missing mandate.requiredKinds gives WAIT. Otherwise PASS. On-chain codes: PASS 1, WAIT 2, FAIL 3.
18. Premise check disabled: a mandate with zero requiredKinds lets an action PASS with no claims at all. Every receipt under such a mandate carries the notice "premise check disabled by mandate".
19. Hashes: claimsHash = keccak256 of the UTF-8 canonical JSON of the claims array. receiptHash = keccak256 of the UTF-8 canonical JSON of the receipt. Canonical JSON sorts object keys by UTF-16 code unit, has no whitespace, writes bigints as base-10 strings, and rejects undefined and non-finite numbers.

## Audit-only claim kinds (shadow runner)

Used by the shadow runner for read-only audits (docs/SHADOW.md). The validator worker, mandates, and ReasonGate accept ClaimV0 kinds only.

### kind vault_rate

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"vault_rate"` | yes |  |
| vault | string matching `^0x[0-9a-fA-F]{40}$` | yes | ERC-4626 vault address |
| valuePct | number >= -100 | yes | claimed annualized share-price growth in percent |
| basis | `"APY"` or `"APR"` | yes | annualization basis of valuePct |
| compounding | `"continuous"` | yes | APY compounding convention |
| lookbackBlocks | integer >= 1, <= 3000000 | yes | the rate is measured from block (pinned - lookbackBlocks) to the pinned block |
| tolerancePp | number >= 0 | yes | allowed absolute difference, in percentage points |

### kind balance

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"balance"` | yes |  |
| token | string matching `^0x[0-9a-fA-F]{40}$` | yes | ERC-20 token address |
| holder | string matching `^0x[0-9a-fA-F]{40}$` | yes | address whose balance is claimed |
| amount | string matching `^(0\|[1-9][0-9]*)$` | yes | claimed balance, token atomic units |
| toleranceAtomic | string matching `^(0\|[1-9][0-9]*)$` | yes | allowed absolute difference, token atomic units |

### Audit conventions

1. Scope: vault_rate and balance are audit-only kinds for the shadow runner (docs/SHADOW.md). The validator worker and ReasonGate accept ClaimV0 kinds only.
2. vault_rate: the share price is convertToAssets(1000000000000000000000000000000000000 shares), read at block (pinned - lookbackBlocks) and at the pinned block. elapsed is the difference of those two block timestamps. ratePerSecond = ln(assetsEnd / assetsStart) / elapsed. APR = ratePerSecond * 31536000. APY = exp(APR) - 1, the same continuous compounding convention as Morpho rates. totalAssets at the pinned block is recorded in the observation. lookbackBlocks is at most 3000000.
3. vault_rate is UNVERIFIABLE when the vault has no code at the start block, the start share price is 0, or elapsed <= 0 seconds. The basis must match the observation; APR against APY is a schema error. The tolerance slack of TOLERANCE_SLACK_PP applies.
4. balance: balanceOf(holder) of the token at the pinned block, in token atomic units. TRUE when |observed - amount| <= toleranceAtomic. UNVERIFIABLE when the token has no code at the pinned block.
5. Reads for the audit-only kinds follow the same policy: one eth_call per read, sequential, ascending block order, never batched.

## Typed-decision claim kinds

For agents that emit a choice and probabilities instead of a reason (examples/jev-trader-gated). The validator worker accepts these under a typed-decision mandate.

### kind kuru_book

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"kuru_book"` | yes |  |
| market | string matching `^0x[0-9a-fA-F]{40}$` | yes | Kuru OrderBook market the model read |
| bestBid | number | yes | claimed best bid, quote per base |
| bestAsk | number | yes | claimed best ask, quote per base |
| tolerancePp | number >= 0 | yes | allowed relative difference in percent: \|observed - claimed\| / claimed * 100 |

### kind decision

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"decision"` | yes |  |
| answer | string | yes | the answer the model returned, verbatim |
| allowedValues | array of string, at least 1 | yes | every answer the principal accepts; an answer outside this set is never defaulted |
| probability | number >= 0, <= 1 | yes | the probability the model gave its answer |
| minProbability | number >= 0, <= 1 | yes | the lowest probability the principal accepts |

### kind position

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| id | string | yes | unique within the claim set |
| sourceSpan | string or null | yes | verbatim text from the reason that this claim encodes; null when the agent sends typed claims |
| kind | `"position"` | yes |  |
| gate | string matching `^0x[0-9a-fA-F]{40}$` | yes | the gate whose balances are the position |
| market | string matching `^0x[0-9a-fA-F]{40}$` | yes | Kuru OrderBook market used to price the base balance |
| maxNotionalUsd | number | yes | cap on base balance times best bid, in quote units |
| maxPositionBase | number | yes | cap on the base balance, in whole base units |

### Typed-decision mandate

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| type | `"typed-decision"` | yes |  |
| gate | string matching `^0x[0-9a-fA-F]{40}$` | yes | the KuruGate that holds the trading balance |
| market | string matching `^0x[0-9a-fA-F]{40}$` | yes | the only Kuru market this mandate covers |
| allowedAnswers | array of string, at least 1 | yes | every answer the principal accepts |
| minProbability | number >= 0, <= 1 | yes | the lowest probability the principal accepts |
| maxNotionalUsd | number | yes | cap on the position value in quote units |
| maxPositionBase | number | yes | cap on the base balance in whole base units |
| requiredKinds | array of `"kuru_book"` or `"decision"` or `"position"` | yes | claim kinds that must be present for a PASS |

### Typed-decision conventions

1. Scope: kuru_book, decision, and position describe a typed-decision agent, one that emits a choice and probabilities and never a reason. The reason on record is the state the model was shown plus the answer it gave.
2. kuru_book: bestBid and bestAsk come from the Kuru OrderBook at the pinned block (bestBidAsk(), 1e18-scaled, plus getL2Book() for depth). Both sides must hold: TRUE when |observed - claimed| / claimed * 100 <= tolerancePp for the bid and the ask.
3. decision: TRUE when the answer is in allowedValues and probability >= minProbability. An answer outside allowedValues is UNVERIFIABLE, which gives WAIT, and is never mapped to a default side. A recognised answer below minProbability is FALSE, which gives FAIL.
4. position: the gate is the position. positionBase is the gate base balance at the pinned block in whole base units, and notionalUsd is positionBase times the best bid. TRUE when positionBase <= maxPositionBase and notionalUsd <= maxNotionalUsd; a breach is FALSE, which gives FAIL, and the failing item carries the observed numbers.
5. A typed-decision mandate fixes the gate, the market, the allowed answers, the minimum probability, and both caps. A claim that widens any of them is a mandate violation, which gives FAIL: the agent cannot grant itself a looser limit.
