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
export const MAX_WINDOW_BLOCKS = 100
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
  'Borrow rate: the market IRM borrowRateView(marketParams, market) at the pinned block, a per-second rate scaled by 1e18 (WAD). A market whose irm is the zero address has a borrow rate of 0.',
  'Utilization: totalBorrowAssets / totalSupplyAssets, and 0 when totalSupplyAssets is 0.',
  'Supply rate: supplyRatePerSecond = borrowRatePerSecond * utilization * (1 - fee / 1e18), computed in integer WAD arithmetic as borrowRate * totalBorrowAssets * (1e18 - fee) / (totalSupplyAssets * 1e18) with one floor division.',
  `APR = ratePerSecond * ${SECONDS_PER_YEAR.toString()} (a 365-day year). APY = exp(APR) - 1 (continuous compounding). Percent = fraction * 100.`,
  'Basis: a rate claim is compared only against an observation on the same basis and side. APR claimed against an APY basis is a schema error, never a FALSE.',
  `Manipulation guard: rate and utilization are sampled at every block of a window ending at the pinned block. The window is window.blocks for a median rate claim and ${DEFAULT_GUARD_BLOCKS} blocks otherwise. The observed value is the median of the samples (the mean of the two middle samples when the count is even). If max minus min exceeds 2 * tolerancePp, the result is UNVERIFIABLE. window.blocks is at most ${MAX_WINDOW_BLOCKS}.`,
  `Tolerance: a rate or utilization claim is TRUE when |observed - claimed| <= tolerancePp. Exactly at tolerance is TRUE. Every tolerance comparison, including the guard, adds a fixed slack of ${TOLERANCE_SLACK_PP} percentage points to absorb IEEE 754 rounding.`,
  'Liquidity: withdrawable = totalSupplyAssets - totalBorrowAssets at the pinned block, in loan-token atomic units. TRUE when withdrawable >= minWithdrawable.',
  'Identity: TRUE when loanToken, collateralToken, oracle, irm, and lltv all equal idToMarketParams(market) at the pinned block.',
  'Uncreated market: a rate, utilization, or liquidity claim on a market whose lastUpdate is 0 is UNVERIFIABLE.',
  'Action check: the vault calldata is decoded and compared with the stated action, function, adapter, market ids, and amounts, in order. The calldata must also re-encode to the exact same bytes. Any mismatch or undecodable calldata is FAIL. Market id = keccak256(abi.encode(MarketParams)).',
  'Mandate check: every market the decoded calldata touches, including markets reduced to zero, must be in mandate.allowedMarkets. Any violation is FAIL.',
  'Verdict (ruleset REASON-R0): any FALSE, action mismatch, or mandate violation gives FAIL. Otherwise any UNVERIFIABLE or any missing mandate.requiredKinds gives WAIT. Otherwise PASS. On-chain codes: PASS 1, WAIT 2, FAIL 3.',
  'Hashes: claimsHash = keccak256 of the UTF-8 canonical JSON of the claims array. receiptHash = keccak256 of the UTF-8 canonical JSON of the receipt. Canonical JSON sorts object keys by UTF-16 code unit, has no whitespace, writes bigints as base-10 strings, and rejects undefined and non-finite numbers.',
]
