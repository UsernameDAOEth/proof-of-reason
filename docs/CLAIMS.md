# Proof of Reason claim schema

Generated from engine/src/claims.ts by `pnpm gen:claims`. Do not edit by hand. Ruleset REASON-R0, engine 0.1.0.

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
| window | { type: `"instant"` } or { type: `"median"`, blocks: integer >= 1, <= 100 } | yes | instant: the rate at the pinned block, read through the default guard window; median: the median over the given number of blocks ending at the pinned block |
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

## MandateV0

Set by the principal.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| allowedMarkets | array of string matching `^0x[0-9a-fA-F]{64}$` | yes | every market the calldata touches must be listed |
| requiredKinds | array of `"rate"` or `"utilization"` or `"liquidity"` or `"identity"` | yes | claim kinds that must be present for a PASS |

## Conventions

1. Percent values: valuePct is a percentage (5.2 means 5.2 percent). tolerancePp is an absolute difference in percentage points.
2. Borrow rate: the market IRM borrowRateView(marketParams, market) at the pinned block, a per-second rate scaled by 1e18 (WAD). A market whose irm is the zero address has a borrow rate of 0.
3. Utilization: totalBorrowAssets / totalSupplyAssets, and 0 when totalSupplyAssets is 0.
4. Supply rate: supplyRatePerSecond = borrowRatePerSecond * utilization * (1 - fee / 1e18), computed in integer WAD arithmetic as borrowRate * totalBorrowAssets * (1e18 - fee) / (totalSupplyAssets * 1e18) with one floor division.
5. APR = ratePerSecond * 31536000 (a 365-day year). APY = exp(APR) - 1 (continuous compounding). Percent = fraction * 100.
6. Basis: a rate claim is compared only against an observation on the same basis and side. APR claimed against an APY basis is a schema error, never a FALSE.
7. Manipulation guard: rate and utilization are sampled at every block of a window ending at the pinned block. The window is window.blocks for a median rate claim and 5 blocks otherwise. The observed value is the median of the samples (the mean of the two middle samples when the count is even). If max minus min exceeds 2 * tolerancePp, the result is UNVERIFIABLE. window.blocks is at most 100.
8. Tolerance: a rate or utilization claim is TRUE when |observed - claimed| <= tolerancePp. Exactly at tolerance is TRUE. Every tolerance comparison, including the guard, adds a fixed slack of 1e-9 percentage points to absorb IEEE 754 rounding.
9. Liquidity: withdrawable = totalSupplyAssets - totalBorrowAssets at the pinned block, in loan-token atomic units. TRUE when withdrawable >= minWithdrawable.
10. Identity: TRUE when loanToken, collateralToken, oracle, irm, and lltv all equal idToMarketParams(market) at the pinned block.
11. Uncreated market: a rate, utilization, or liquidity claim on a market whose lastUpdate is 0 is UNVERIFIABLE.
12. Action check: the vault calldata is decoded and compared with the stated action, function, adapter, market ids, and amounts, in order. The calldata must also re-encode to the exact same bytes. Any mismatch or undecodable calldata is FAIL. Market id = keccak256(abi.encode(MarketParams)).
13. Mandate check: every market the decoded calldata touches, including markets reduced to zero, must be in mandate.allowedMarkets. Any violation is FAIL.
14. Verdict (ruleset REASON-R0): any FALSE, action mismatch, or mandate violation gives FAIL. Otherwise any UNVERIFIABLE or any missing mandate.requiredKinds gives WAIT. Otherwise PASS. On-chain codes: PASS 1, WAIT 2, FAIL 3.
15. Hashes: claimsHash = keccak256 of the UTF-8 canonical JSON of the claims array. receiptHash = keccak256 of the UTF-8 canonical JSON of the receipt. Canonical JSON sorts object keys by UTF-16 code unit, has no whitespace, writes bigints as base-10 strings, and rejects undefined and non-finite numbers.
