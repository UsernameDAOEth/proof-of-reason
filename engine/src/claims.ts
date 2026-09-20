import { z } from 'zod'

/** Thrown when an input breaks the schema or a declared convention. Never a FALSE. */
export class SchemaError extends Error {
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}: ${issues.join('; ')}` : message)
    this.name = 'SchemaError'
    this.issues = issues
  }
}

// Declared numeric conventions. CLAIMS.md is generated from these values.
export const WAD = 10n ** 18n
export const SECONDS_PER_YEAR = 31_536_000n
export const DEFAULT_GUARD_BLOCKS = 5
/** Cap on window.blocks. A median rate claim reads params once, then state and IRM rate per block. */
export const MAX_WINDOW_BLOCKS = 20
/** ReasonGate.DEFAULT_MAX_AGE_BLOCKS, kept equal by engine/test/claims.test.ts. */
export const GATE_DEFAULT_MAX_AGE_BLOCKS = 60
export const TOLERANCE_SLACK_PP = 1e-9

const UINT256_MAX = 2n ** 256n - 1n

export const Bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .describe('32-byte hex string with 0x prefix')

export const AddressString = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe('20-byte hex address with 0x prefix, compared case-insensitively')

const DECIMAL = /^(0|[1-9][0-9]*)$/

export const DecimalString = z
  .string()
  .regex(DECIMAL)
  // zod runs refinements even after the regex fails, so re-check before BigInt.
  .refine((s) => !DECIMAL.test(s) || BigInt(s) <= UINT256_MAX, 'exceeds uint256')
  .describe('non-negative integer as a base-10 string, no sign, no leading zeros, at most 2^256 - 1')

const Pct = z.number().min(0)
const Tolerance = z.number().min(0)

const common = {
  id: z.string().min(1).describe('unique within the claim set'),
  sourceSpan: z
    .string()
    .nullable()
    .describe('verbatim text from the reason that this claim encodes; null when the agent sends typed claims'),
}

export const RateClaim = z.strictObject({
  ...common,
  kind: z.literal('rate'),
  market: Bytes32.describe('Morpho Blue market id'),
  side: z.enum(['supply', 'borrow']),
  valuePct: Pct.describe('claimed annual rate in percent: 5.2 means 5.2 percent'),
  basis: z.enum(['APY', 'APR']).describe('annualization basis of valuePct'),
  compounding: z.literal('continuous').describe('APY compounding convention'),
  window: z
    .discriminatedUnion('type', [
      z.strictObject({ type: z.literal('instant') }),
      z.strictObject({
        type: z.literal('median'),
        blocks: z.number().int().min(1).max(MAX_WINDOW_BLOCKS),
      }),
    ])
    .describe('instant: the rate at the pinned block, read through the default guard window; median: the median over the given number of blocks ending at the pinned block'),
  tolerancePp: Tolerance.describe('allowed absolute difference, in percentage points'),
})

export const UtilizationClaim = z.strictObject({
  ...common,
  kind: z.literal('utilization'),
  market: Bytes32.describe('Morpho Blue market id'),
  valuePct: Pct.max(100).describe('claimed utilization in percent'),
  tolerancePp: Tolerance.describe('allowed absolute difference, in percentage points'),
})

export const LiquidityClaim = z.strictObject({
  ...common,
  kind: z.literal('liquidity'),
  market: Bytes32.describe('Morpho Blue market id'),
  minWithdrawable: DecimalString.describe(
    'claimed lower bound on totalSupplyAssets - totalBorrowAssets, in loan-token atomic units',
  ),
})

export const IdentityClaim = z.strictObject({
  ...common,
  kind: z.literal('identity'),
  market: Bytes32.describe('Morpho Blue market id'),
  loanToken: AddressString,
  collateralToken: AddressString,
  oracle: AddressString,
  irm: AddressString,
  lltv: DecimalString.describe('raw WAD integer: 86 percent is "860000000000000000"'),
})

export const ClaimV0 = z.discriminatedUnion('kind', [
  RateClaim,
  UtilizationClaim,
  LiquidityClaim,
  IdentityClaim,
])

export const ClaimsV0 = z.array(ClaimV0).superRefine((claims, ctx) => {
  const seen = new Set<string>()
  for (const claim of claims) {
    if (seen.has(claim.id)) ctx.addIssue({ code: 'custom', message: `duplicate claim id ${claim.id}` })
    seen.add(claim.id)
  }
})

export const CLAIM_KINDS = ['rate', 'utilization', 'liquidity', 'identity'] as const
export const ClaimKind = z.enum(CLAIM_KINDS)

/** Fields every claim carries; shared with the audit-only kinds in erc4626.ts and erc20.ts. */
export const claimCommon = common

/**
 * Audit-only claim kinds, used by the shadow runner (docs/SHADOW.md). The validator worker accepts
 * ClaimV0 kinds only; these never reach a mandate or the gate.
 */
export const AUDIT_ONLY_KINDS = ['vault_rate', 'balance'] as const
/** Shares probed with convertToAssets for a vault_rate claim, large enough to keep 1e-24 precision. */
export const VAULT_PROBE_SHARES = 10n ** 36n
/** Cap on vault_rate lookbackBlocks. The rate uses two reads per endpoint, so the cap is about history, not cost. */
export const MAX_VAULT_LOOKBACK_BLOCKS = 3_000_000

/** The allocation the agent says it is making. Compared against the decoded vault calldata. */
export const ActionV0 = z.discriminatedUnion('fn', [
  z.strictObject({
    fn: z.literal('reallocate').describe('MetaMorpho V1.1 reallocate(MarketAllocation[])'),
    allocations: z
      .array(
        z.strictObject({
          market: Bytes32.describe('Morpho Blue market id'),
          assets: DecimalString.describe(
            'target supply in loan-token atomic units, as in the calldata; 2^256 - 1 means all remaining',
          ),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    fn: z.literal('allocate').describe('Vault V2 allocate(address,bytes,uint256)'),
    adapter: AddressString,
    market: Bytes32.describe('Morpho Blue market id encoded in the adapter data'),
    assets: DecimalString.describe('loan-token atomic units'),
  }),
  z.strictObject({
    fn: z.literal('deallocate').describe('Vault V2 deallocate(address,bytes,uint256)'),
    adapter: AddressString,
    market: Bytes32.describe('Morpho Blue market id encoded in the adapter data'),
    assets: DecimalString.describe('loan-token atomic units'),
  }),
])

/** The principal's mandate. */
export const MandateV0 = z.strictObject({
  allowedMarkets: z.array(Bytes32).describe('every market the calldata touches must be listed'),
  requiredKinds: z.array(ClaimKind).describe('claim kinds that must be present for a PASS'),
})

export type ClaimV0 = z.infer<typeof ClaimV0>
export type RateClaim = z.infer<typeof RateClaim>
export type UtilizationClaim = z.infer<typeof UtilizationClaim>
export type LiquidityClaim = z.infer<typeof LiquidityClaim>
export type IdentityClaim = z.infer<typeof IdentityClaim>
export type ClaimKind = z.infer<typeof ClaimKind>
export type AuditOnlyKind = (typeof AUDIT_ONLY_KINDS)[number]
export type AnyClaimKind = ClaimKind | AuditOnlyKind
export type ActionV0 = z.infer<typeof ActionV0>
export type MandateV0 = z.infer<typeof MandateV0>

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new SchemaError(`invalid ${label}`, issuesOf(result.error))
  return result.data
}

export function parseClaim(input: unknown): ClaimV0 {
  return parseWith(ClaimV0, input, 'ClaimV0')
}

export function parseClaims(input: unknown): ClaimV0[] {
  return parseWith(ClaimsV0, input, 'ClaimV0 list')
}

export function parseAction(input: unknown): ActionV0 {
  return parseWith(ActionV0, input, 'ActionV0')
}

export function parseMandate(input: unknown): MandateV0 {
  return parseWith(MandateV0, input, 'MandateV0')
}

/** Human-readable conventions, rendered into docs/CLAIMS.md. */
export const CONVENTIONS: readonly string[] = [
  'Percent values: valuePct is a percentage (5.2 means 5.2 percent). tolerancePp is an absolute difference in percentage points.',
  'Reads: every chain read is one eth_call pinned to one block, sent only after the previous read returns, in claim order and then ascending block order. Reads are never batched (no JSON-RPC batch, no Multicall) and never concurrent.',
  'Borrow rate: the market IRM borrowRateView(marketParams, market) at the pinned block, a per-second rate scaled by 1e18 (WAD). A market whose irm is the zero address has a borrow rate of 0.',
  'Utilization: totalBorrowAssets / totalSupplyAssets, and 0 when totalSupplyAssets is 0.',
  'Supply rate: supplyRatePerSecond = borrowRatePerSecond * utilization * (1 - fee / 1e18), computed in integer WAD arithmetic as borrowRate * totalBorrowAssets * (1e18 - fee) / (totalSupplyAssets * 1e18) with one floor division.',
  `APR = ratePerSecond * ${SECONDS_PER_YEAR.toString()} (a 365-day year). APY = exp(APR) - 1 (continuous compounding). Percent = fraction * 100.`,
  'Basis: a rate claim is compared only against an observation on the same basis and side. APR claimed against an APY basis is a schema error, never a FALSE.',
  `Manipulation guard: rate and utilization are sampled at every block of a window ending at the pinned block. The window is window.blocks for a median rate claim and ${DEFAULT_GUARD_BLOCKS} blocks otherwise. The observed value is the median of the samples (the mean of the two middle samples when the count is even). If max minus min exceeds 2 * tolerancePp, the result is UNVERIFIABLE. window.blocks is at most ${MAX_WINDOW_BLOCKS}, so a rate claim needs at most ${2 * MAX_WINDOW_BLOCKS + 1} reads (params once, then state and IRM rate at each block).`,
  'Tolerance: a rate or utilization claim is TRUE when |observed - claimed| <= tolerancePp. Exactly at tolerance is TRUE.',
  `Slack: every tolerance comparison, including the manipulation guard, adds a fixed ${TOLERANCE_SLACK_PP} percentage points (TOLERANCE_SLACK_PP) to absorb IEEE 754 rounding. So |observed - claimed| <= tolerancePp + ${TOLERANCE_SLACK_PP} and max - min > 2 * tolerancePp + ${TOLERANCE_SLACK_PP}.`,
  `Liquidity: withdrawable = totalSupplyAssets - totalBorrowAssets, in loan-token atomic units, sampled at every block of the ${DEFAULT_GUARD_BLOCKS}-block window ending at the pinned block. A floor claim takes the MINIMUM over the window, not the median. TRUE when that minimum >= minWithdrawable.`,
  'Identity: TRUE when loanToken, collateralToken, oracle, irm, and lltv all equal idToMarketParams(market) at the pinned block.',
  'Uncreated market: a rate, utilization, or liquidity claim on a market whose lastUpdate is 0 at any block of its window is UNVERIFIABLE.',
  'Action check: the vault calldata is decoded and compared with the stated action, function, adapter, market ids, and amounts, in order. The calldata must also re-encode to the exact same bytes. Any mismatch or undecodable calldata is FAIL. Market id = keccak256(abi.encode(MarketParams)).',
  'Mandate check: every market the decoded calldata touches, including markets reduced to zero, must be in mandate.allowedMarkets. Any violation is FAIL.',
  `Freshness bound: ReasonGate accepts a verdict only while checkedAtBlock <= block.number and block.number - checkedAtBlock <= maxAgeBlocks. maxAgeBlocks defaults to ${GATE_DEFAULT_MAX_AGE_BLOCKS} blocks (about 18 s on Monad at about 0.30 s per block) and is owner-settable with setMaxAgeBlocks. checkedAtBlock is the pinned block the observers read.`,
  'Verdict (ruleset REASON-R0): any FALSE, action mismatch, or mandate violation gives FAIL. Otherwise any UNVERIFIABLE or any missing mandate.requiredKinds gives WAIT. Otherwise PASS. On-chain codes: PASS 1, WAIT 2, FAIL 3.',
  'Premise check disabled: a mandate with zero requiredKinds lets an action PASS with no claims at all. Every receipt under such a mandate carries the notice "premise check disabled by mandate".',
  'Hashes: claimsHash = keccak256 of the UTF-8 canonical JSON of the claims array. receiptHash = keccak256 of the UTF-8 canonical JSON of the receipt. Canonical JSON sorts object keys by UTF-16 code unit, has no whitespace, writes bigints as base-10 strings, and rejects undefined and non-finite numbers.',
]

/** Conventions for the audit-only kinds, rendered into docs/CLAIMS.md. */
export const AUDIT_CONVENTIONS: readonly string[] = [
  'Scope: vault_rate and balance are audit-only kinds for the shadow runner (docs/SHADOW.md). The validator worker and ReasonGate accept ClaimV0 kinds only.',
  `vault_rate: the share price is convertToAssets(${VAULT_PROBE_SHARES.toString()} shares), read at block (pinned - lookbackBlocks) and at the pinned block. elapsed is the difference of those two block timestamps. ratePerSecond = ln(assetsEnd / assetsStart) / elapsed. APR = ratePerSecond * ${SECONDS_PER_YEAR.toString()}. APY = exp(APR) - 1, the same continuous compounding convention as Morpho rates. totalAssets at the pinned block is recorded in the observation. lookbackBlocks is at most ${MAX_VAULT_LOOKBACK_BLOCKS}.`,
  'vault_rate is UNVERIFIABLE when the vault has no code at the start block, the start share price is 0, or elapsed <= 0 seconds. The basis must match the observation; APR against APY is a schema error. The tolerance slack of TOLERANCE_SLACK_PP applies.',
  'balance: balanceOf(holder) of the token at the pinned block, in token atomic units. TRUE when |observed - amount| <= toleranceAtomic. UNVERIFIABLE when the token has no code at the pinned block.',
  'Reads for the audit-only kinds follow the same policy: one eth_call per read, sequential, ascending block order, never batched.',
]
