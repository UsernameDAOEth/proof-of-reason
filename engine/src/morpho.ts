import { parseAbi, zeroAddress } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import {
  DEFAULT_GUARD_BLOCKS,
  SECONDS_PER_YEAR,
  TOLERANCE_SLACK_PP,
  WAD,
  parseClaim,
} from './claims.ts'
import type { ClaimV0, IdentityClaim, LiquidityClaim, RateClaim, UtilizationClaim } from './claims.ts'

export type MarketState = {
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  lastUpdate: bigint
  fee: bigint
}

export type MarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

// ------------------------------------------------------------------ pure formulas

/** totalBorrowAssets / totalSupplyAssets in WAD, floored; 0 when supply is 0. */
export function utilizationWad(market: MarketState): bigint {
  if (market.totalSupplyAssets === 0n) return 0n
  return (market.totalBorrowAssets * WAD) / market.totalSupplyAssets
}

/** borrowRate * utilization * (1 - fee / 1e18), one floor division. */
export function supplyRatePerSecondWad(borrowRatePerSecondWad: bigint, market: MarketState): bigint {
  if (market.totalSupplyAssets === 0n) return 0n
  return (
    (borrowRatePerSecondWad * market.totalBorrowAssets * (WAD - market.fee)) /
    (market.totalSupplyAssets * WAD)
  )
}

/** APR as a fraction: ratePerSecond * 31_536_000. */
export function aprFraction(ratePerSecondWad: bigint): number {
  return Number(ratePerSecondWad * SECONDS_PER_YEAR) / Number(WAD)
}

/** APY as a fraction under continuous compounding: exp(APR) - 1. */
export function apyFraction(ratePerSecondWad: bigint): number {
  return Math.expm1(aprFraction(ratePerSecondWad))
}

export function annualPct(ratePerSecondWad: bigint, basis: 'APY' | 'APR'): number {
  return (basis === 'APR' ? aprFraction(ratePerSecondWad) : apyFraction(ratePerSecondWad)) * 100
}

export function utilizationPct(market: MarketState): number {
  return (Number(utilizationWad(market)) / Number(WAD)) * 100
}

/** totalSupplyAssets - totalBorrowAssets, loan-token atomic units. */
export function withdrawable(market: MarketState): bigint {
  return market.totalSupplyAssets - market.totalBorrowAssets
}

/** Median; the mean of the two middle values when the count is even. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of no values')
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** True when the samples spread more than 2 * tolerancePp. */
export function guardTripped(values: readonly number[], tolerancePp: number): boolean {
  const spread = Math.max(...values) - Math.min(...values)
  return spread > 2 * tolerancePp + TOLERANCE_SLACK_PP
}

// ------------------------------------------------------------------ chain reads

export const morphoAbi = parseAbi([
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
])

export const irmAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }',
  'function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)',
])

/** Every read is pinned to a block. */
export interface MorphoReader {
  market(id: Hex, block: bigint): Promise<MarketState>
  idToMarketParams(id: Hex, block: bigint): Promise<MarketParams>
  borrowRateView(params: MarketParams, market: MarketState, block: bigint): Promise<bigint>
}

export function viemMorphoReader(
  client: Pick<PublicClient, 'readContract'>,
  morpho: Address,
): MorphoReader {
  return {
    async market(id, block) {
      const [
        totalSupplyAssets,
        totalSupplyShares,
        totalBorrowAssets,
        totalBorrowShares,
        lastUpdate,
        fee,
      ] = await client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: 'market',
        args: [id],
        blockNumber: block,
      })
      return {
        totalSupplyAssets,
        totalSupplyShares,
        totalBorrowAssets,
        totalBorrowShares,
        lastUpdate,
        fee,
      }
    },
    async idToMarketParams(id, block) {
      const [loanToken, collateralToken, oracle, irm, lltv] = await client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: 'idToMarketParams',
        args: [id],
        blockNumber: block,
      })
      return { loanToken, collateralToken, oracle, irm, lltv }
    },
    async borrowRateView(params, market, block) {
      return client.readContract({
        address: params.irm,
        abi: irmAbi,
        functionName: 'borrowRateView',
        args: [params, market],
        blockNumber: block,
      })
    },
  }
}

// ------------------------------------------------------------------ observations

export type Sample = { block: bigint; valuePct: number }

export type RateObservation = {
  kind: 'rate'
  market: Hex
  side: 'supply' | 'borrow'
  basis: 'APY' | 'APR'
  block: bigint
  samples: Sample[]
  valuePct: number | null
  unverifiable: string | null
}

export type UtilizationObservation = {
  kind: 'utilization'
  market: Hex
  block: bigint
  samples: Sample[]
  valuePct: number | null
  unverifiable: string | null
}

export type WithdrawableSample = { block: bigint; withdrawable: bigint }

export type LiquidityObservation = {
  kind: 'liquidity'
  market: Hex
  block: bigint
  samples: WithdrawableSample[]
  /** Minimum over the window: a floor claim is checked against the worst block, not the median. */
  withdrawable: bigint | null
  unverifiable: string | null
}

export type IdentityObservation = {
  kind: 'identity'
  market: Hex
  block: bigint
  params: MarketParams
  unverifiable: null
}

export type Observation =
  | RateObservation
  | UtilizationObservation
  | LiquidityObservation
  | IdentityObservation

export type ObserveOptions = { guardBlocks?: number }

const NOT_CREATED = 'market not created'

function windowBlocks(block: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`bad window size ${count}`)
  const first = block - BigInt(count - 1)
  if (first < 0n) throw new RangeError(`window of ${count} blocks starts before genesis`)
  return Array.from({ length: count }, (_, i) => first + BigInt(i))
}

function summarize(samples: Sample[], tolerancePp: number): { valuePct: number | null; unverifiable: string | null } {
  const values = samples.map((s) => s.valuePct)
  if (guardTripped(values, tolerancePp)) {
    const spread = Math.max(...values) - Math.min(...values)
    return { valuePct: null, unverifiable: `samples spread ${spread} pp exceeds 2 * tolerancePp` }
  }
  return { valuePct: median(values), unverifiable: null }
}

/**
 * Reads the market state at each block, one eth_call at a time in ascending block order.
 * Never batched and never concurrent (docs/MONAD.md, RPC policy). Returns null as soon as a
 * block shows the market not yet created.
 */
async function readStates(reader: MorphoReader, market: Hex, blocks: bigint[]): Promise<MarketState[] | null> {
  const states: MarketState[] = []
  for (const b of blocks) {
    const state = await reader.market(market, b)
    if (state.lastUpdate === 0n) return null
    states.push(state)
  }
  return states
}

async function observeRate(
  reader: MorphoReader,
  claim: RateClaim,
  block: bigint,
  guardBlocks: number,
): Promise<RateObservation> {
  const market = claim.market as Hex
  const base = { kind: 'rate', market, side: claim.side, basis: claim.basis, block } as const
  const count = claim.window.type === 'median' ? claim.window.blocks : guardBlocks
  const blocks = windowBlocks(block, count)
  const params = await reader.idToMarketParams(market, block)
  const samples: Sample[] = []
  // Sequential: the state at block b, then the IRM rate at block b, then block b + 1.
  for (const b of blocks) {
    const state = await reader.market(market, b)
    if (state.lastUpdate === 0n) return { ...base, samples: [], valuePct: null, unverifiable: NOT_CREATED }
    const borrowRate =
      params.irm.toLowerCase() === zeroAddress ? 0n : await reader.borrowRateView(params, state, b)
    const rate = claim.side === 'borrow' ? borrowRate : supplyRatePerSecondWad(borrowRate, state)
    samples.push({ block: b, valuePct: annualPct(rate, claim.basis) })
  }
  return { ...base, samples, ...summarize(samples, claim.tolerancePp) }
}

async function observeUtilization(
  reader: MorphoReader,
  claim: UtilizationClaim,
  block: bigint,
  guardBlocks: number,
): Promise<UtilizationObservation> {
  const market = claim.market as Hex
  const base = { kind: 'utilization', market, block } as const
  const blocks = windowBlocks(block, guardBlocks)
  const states = await readStates(reader, market, blocks)
  if (states === null) return { ...base, samples: [], valuePct: null, unverifiable: NOT_CREATED }
  const samples = blocks.map((b, i) => ({ block: b, valuePct: utilizationPct(states[i]!) }))
  return { ...base, samples, ...summarize(samples, claim.tolerancePp) }
}

async function observeLiquidity(
  reader: MorphoReader,
  claim: LiquidityClaim,
  block: bigint,
  guardBlocks: number,
): Promise<LiquidityObservation> {
  const market = claim.market as Hex
  const base = { kind: 'liquidity', market, block } as const
  const blocks = windowBlocks(block, guardBlocks)
  const states = await readStates(reader, market, blocks)
  if (states === null) return { ...base, samples: [], withdrawable: null, unverifiable: NOT_CREATED }
  const samples = blocks.map((b, i) => ({ block: b, withdrawable: withdrawable(states[i]!) }))
  const min = samples.reduce((lo, s) => (s.withdrawable < lo ? s.withdrawable : lo), samples[0]!.withdrawable)
  return { ...base, samples, withdrawable: min, unverifiable: null }
}

async function observeIdentity(
  reader: MorphoReader,
  claim: IdentityClaim,
  block: bigint,
): Promise<IdentityObservation> {
  const market = claim.market as Hex
  const params = await reader.idToMarketParams(market, block)
  return { kind: 'identity', market, block, params, unverifiable: null }
}

/** Read the chain state a claim cites, pinned at `block`. */
export async function observe(
  reader: MorphoReader,
  claimInput: ClaimV0,
  block: bigint,
  options: ObserveOptions = {},
): Promise<Observation> {
  const claim = parseClaim(claimInput)
  const guardBlocks = options.guardBlocks ?? DEFAULT_GUARD_BLOCKS
  switch (claim.kind) {
    case 'rate':
      return observeRate(reader, claim, block, guardBlocks)
    case 'utilization':
      return observeUtilization(reader, claim, block, guardBlocks)
    case 'liquidity':
      return observeLiquidity(reader, claim, block, guardBlocks)
    case 'identity':
      return observeIdentity(reader, claim, block)
  }
}

/** Observes each claim in order, one claim at a time. Never concurrent. */
export async function observeAll(
  reader: MorphoReader,
  claims: readonly ClaimV0[],
  block: bigint,
  options: ObserveOptions = {},
): Promise<Observation[]> {
  const observations: Observation[] = []
  for (const claim of claims) observations.push(await observe(reader, claim, block, options))
  return observations
}
