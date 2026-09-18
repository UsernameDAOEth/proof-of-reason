import type { Address, Hex } from 'viem'
import { marketId } from '../src/action.ts'
import type { MarketParams, MarketState, MorphoReader } from '../src/morpho.ts'

/**
 * Hand-computed fixture market (USDC-like, 6 decimals).
 *   totalSupplyAssets = 1,000,000e6, totalBorrowAssets = 800,000e6, fee = 10 percent
 *   borrowRatePerSecond = 1e9 WAD (1e-9 per second)
 *
 *   utilization          = 800,000 / 1,000,000                     = 0.8          -> 80 percent
 *   borrow APR           = 1e-9 * 31,536,000                       = 0.031536     -> 3.1536 percent
 *   borrow APY           = e^0.031536 - 1
 *                        = 0.031536 + 0.031536^2/2 + 0.031536^3/6 + 0.031536^4/24 + ...
 *                        = 0.031536 + 0.000497259648 + 0.0000052272 + 0.0000000412 + ...
 *                        = 0.0320385283                                   -> 3.20385283 percent
 *   supplyRatePerSecond  = 1e9 * 0.8 * (1 - 0.1)                   = 7.2e8 WAD (exact integer)
 *   supply APR           = 7.2e-10 * 31,536,000                    = 0.02270592   -> 2.270592 percent
 *   supply APY           = e^0.02270592 - 1
 *                        = 0.02270592 + 0.0002577794015 + 0.00000195104 + 0.0000000110754 + ...
 *                        = 0.0229656616                                   -> 2.29656616 percent
 *   withdrawable         = 1,000,000e6 - 800,000e6                 = 200,000e6
 */
export const FIXTURE_PARAMS: MarketParams = {
  loanToken: '0x0000000000000000000000000000000000001000',
  collateralToken: '0x0000000000000000000000000000000000002000',
  oracle: '0x0000000000000000000000000000000000003000',
  irm: '0x0000000000000000000000000000000000004000',
  lltv: 860_000_000_000_000_000n,
}

export const FIXTURE_MARKET: MarketState = {
  totalSupplyAssets: 1_000_000_000_000n,
  totalSupplyShares: 1_000_000_000_000_000_000n,
  totalBorrowAssets: 800_000_000_000n,
  totalBorrowShares: 800_000_000_000_000_000n,
  lastUpdate: 1_700_000_000n,
  fee: 100_000_000_000_000_000n,
}

export const FIXTURE_BORROW_RATE = 1_000_000_000n

export const FIXTURE_ID: Hex = marketId(FIXTURE_PARAMS)

export const PINNED_BLOCK = 1_000n

export type ReaderCall = { fn: string; block: bigint }

/** In-memory MorphoReader. `states` overrides the market state at specific blocks. */
export class FakeReader implements MorphoReader {
  calls: ReaderCall[] = []
  params: MarketParams
  base: MarketState
  states: Map<bigint, MarketState>
  borrowRates: Map<bigint, bigint>
  borrowRate: bigint

  constructor(
    options: {
      params?: MarketParams
      base?: MarketState
      states?: Map<bigint, MarketState>
      borrowRate?: bigint
      borrowRates?: Map<bigint, bigint>
    } = {},
  ) {
    this.params = options.params ?? FIXTURE_PARAMS
    this.base = options.base ?? FIXTURE_MARKET
    this.states = options.states ?? new Map()
    this.borrowRate = options.borrowRate ?? FIXTURE_BORROW_RATE
    this.borrowRates = options.borrowRates ?? new Map()
  }

  async market(_id: Hex, block: bigint): Promise<MarketState> {
    this.calls.push({ fn: 'market', block })
    return this.states.get(block) ?? this.base
  }

  async idToMarketParams(_id: Hex, block: bigint): Promise<MarketParams> {
    this.calls.push({ fn: 'idToMarketParams', block })
    return this.params
  }

  async borrowRateView(_params: MarketParams, _market: MarketState, block: bigint): Promise<bigint> {
    this.calls.push({ fn: 'borrowRateView', block })
    return this.borrowRates.get(block) ?? this.borrowRate
  }
}

export const ADAPTER: Address = '0x3333333333333333333333333333333333333333'
export const OTHER_MARKET: Hex = `0x${'ab'.repeat(32)}`
