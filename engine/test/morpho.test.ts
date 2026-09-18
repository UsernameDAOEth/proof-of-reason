import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import type { Address, Hex } from 'viem'
import type { RateClaim } from '../src/claims.ts'
import {
  annualPct,
  aprFraction,
  apyFraction,
  guardTripped,
  median,
  observe,
  supplyRatePerSecondWad,
  utilizationPct,
  utilizationWad,
  viemMorphoReader,
  withdrawable,
} from '../src/morpho.ts'
import {
  FakeReader,
  FIXTURE_BORROW_RATE,
  FIXTURE_ID,
  FIXTURE_MARKET,
  FIXTURE_PARAMS,
  PINNED_BLOCK,
} from './fixtures.ts'

// Hand-computed in fixtures.ts.
const BORROW_APR_PCT = 3.1536
const BORROW_APY_PCT = 3.20385283
const SUPPLY_APR_PCT = 2.270592
const SUPPLY_APY_PCT = 2.29656616

function rateClaim(overrides: Partial<RateClaim> = {}): RateClaim {
  return {
    id: 'r1',
    kind: 'rate',
    sourceSpan: null,
    market: FIXTURE_ID,
    side: 'supply',
    valuePct: SUPPLY_APY_PCT,
    basis: 'APY',
    compounding: 'continuous',
    window: { type: 'instant' },
    tolerancePp: 0.05,
    ...overrides,
  }
}

describe('Morpho formulas against the hand-computed fixture', () => {
  it('utilization', () => {
    expect(utilizationWad(FIXTURE_MARKET)).toBe(800_000_000_000_000_000n)
    expect(utilizationPct(FIXTURE_MARKET)).toBe(80)
  })

  it('utilization is 0 when supply is 0', () => {
    const empty = { ...FIXTURE_MARKET, totalSupplyAssets: 0n, totalBorrowAssets: 0n }
    expect(utilizationWad(empty)).toBe(0n)
    expect(utilizationPct(empty)).toBe(0)
    expect(supplyRatePerSecondWad(FIXTURE_BORROW_RATE, empty)).toBe(0n)
  })

  it('supply rate per second = borrow * utilization * (1 - fee)', () => {
    expect(supplyRatePerSecondWad(FIXTURE_BORROW_RATE, FIXTURE_MARKET)).toBe(720_000_000n)
    const noFee = { ...FIXTURE_MARKET, fee: 0n }
    expect(supplyRatePerSecondWad(FIXTURE_BORROW_RATE, noFee)).toBe(800_000_000n)
  })

  it('APR = rate * 31,536,000', () => {
    expect(aprFraction(FIXTURE_BORROW_RATE)).toBeCloseTo(0.031536, 15)
    expect(annualPct(FIXTURE_BORROW_RATE, 'APR')).toBeCloseTo(BORROW_APR_PCT, 12)
    expect(annualPct(720_000_000n, 'APR')).toBeCloseTo(SUPPLY_APR_PCT, 12)
  })

  it('APY = exp(APR) - 1', () => {
    expect(apyFraction(FIXTURE_BORROW_RATE)).toBeCloseTo(0.0320385283, 10)
    expect(annualPct(FIXTURE_BORROW_RATE, 'APY')).toBeCloseTo(BORROW_APY_PCT, 8)
    expect(annualPct(720_000_000n, 'APY')).toBeCloseTo(SUPPLY_APY_PCT, 8)
  })

  it('withdrawable = supply - borrow', () => {
    expect(withdrawable(FIXTURE_MARKET)).toBe(200_000_000_000n)
  })

  it('median, odd and even', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([7])).toBe(7)
    expect(() => median([])).toThrow(RangeError)
  })

  it('guard trips only when the spread exceeds 2x tolerance', () => {
    expect(guardTripped([1, 1.2], 0.1)).toBe(false)
    expect(guardTripped([1, 1.2000001], 0.1)).toBe(true)
    expect(guardTripped([5, 5, 5], 0)).toBe(false)
  })
})

describe('observe', () => {
  it('reads the last 5 blocks for an instant rate claim and takes the median', async () => {
    const reader = new FakeReader()
    const obs = await observe(reader, rateClaim(), PINNED_BLOCK)
    expect(obs.kind).toBe('rate')
    if (obs.kind !== 'rate') return
    expect(obs.samples.map((s) => s.block)).toEqual([996n, 997n, 998n, 999n, 1000n])
    expect(obs.valuePct).toBeCloseTo(SUPPLY_APY_PCT, 8)
    expect(obs.unverifiable).toBeNull()
    expect(obs.block).toBe(PINNED_BLOCK)
    const marketBlocks = reader.calls.filter((c) => c.fn === 'market').map((c) => c.block)
    expect(marketBlocks).toEqual([996n, 997n, 998n, 999n, 1000n])
    expect(reader.calls.find((c) => c.fn === 'idToMarketParams')?.block).toBe(PINNED_BLOCK)
  })

  it('uses window.blocks for a median rate claim', async () => {
    const reader = new FakeReader()
    const obs = await observe(
      reader,
      rateClaim({ side: 'borrow', basis: 'APR', valuePct: BORROW_APR_PCT, window: { type: 'median', blocks: 3 } }),
      PINNED_BLOCK,
    )
    if (obs.kind !== 'rate') throw new Error('expected rate')
    expect(obs.samples.map((s) => s.block)).toEqual([998n, 999n, 1000n])
    expect(obs.valuePct).toBeCloseTo(BORROW_APR_PCT, 12)
  })

  it('takes the median, not the pinned value, when one block is off but within the guard', async () => {
    // Borrow APR at 1000 is 3.1536 * 1.01; the spread 0.0315 pp is inside 2 * 0.05.
    const reader = new FakeReader({ borrowRates: new Map([[1_000n, 1_010_000_000n]]) })
    const obs = await observe(
      reader,
      rateClaim({ side: 'borrow', basis: 'APR', valuePct: BORROW_APR_PCT }),
      PINNED_BLOCK,
    )
    if (obs.kind !== 'rate') throw new Error('expected rate')
    expect(obs.valuePct).toBeCloseTo(BORROW_APR_PCT, 12)
    expect(obs.unverifiable).toBeNull()
  })

  it('is UNVERIFIABLE when the samples spread more than 2x tolerance', async () => {
    const reader = new FakeReader({ borrowRates: new Map([[998n, 3_000_000_000n]]) })
    const obs = await observe(reader, rateClaim({ side: 'borrow', basis: 'APR' }), PINNED_BLOCK)
    if (obs.kind !== 'rate') throw new Error('expected rate')
    expect(obs.valuePct).toBeNull()
    expect(obs.unverifiable).toMatch(/exceeds 2 \* tolerancePp/)
  })

  it('is UNVERIFIABLE for a market that is not created', async () => {
    const reader = new FakeReader({ base: { ...FIXTURE_MARKET, lastUpdate: 0n } })
    const rate = await observe(reader, rateClaim(), PINNED_BLOCK)
    const liq = await observe(
      reader,
      { id: 'l1', kind: 'liquidity', sourceSpan: null, market: FIXTURE_ID, minWithdrawable: '1' },
      PINNED_BLOCK,
    )
    expect(rate.unverifiable).toBe('market not created')
    expect(liq.unverifiable).toBe('market not created')
  })

  it('treats a zero irm as a zero borrow rate without calling it', async () => {
    const reader = new FakeReader({ params: { ...FIXTURE_PARAMS, irm: zeroAddress } })
    const obs = await observe(reader, rateClaim({ valuePct: 0 }), PINNED_BLOCK)
    if (obs.kind !== 'rate') throw new Error('expected rate')
    expect(obs.valuePct).toBe(0)
    expect(reader.calls.some((c) => c.fn === 'borrowRateView')).toBe(false)
  })

  it('samples utilization over the guard window', async () => {
    const reader = new FakeReader()
    const obs = await observe(
      reader,
      { id: 'u1', kind: 'utilization', sourceSpan: null, market: FIXTURE_ID, valuePct: 80, tolerancePp: 0.1 },
      PINNED_BLOCK,
      { guardBlocks: 3 },
    )
    if (obs.kind !== 'utilization') throw new Error('expected utilization')
    expect(obs.samples).toHaveLength(3)
    expect(obs.valuePct).toBe(80)
  })

  it('reads liquidity and identity at the pinned block', async () => {
    const reader = new FakeReader()
    const liq = await observe(
      reader,
      { id: 'l1', kind: 'liquidity', sourceSpan: null, market: FIXTURE_ID, minWithdrawable: '1' },
      PINNED_BLOCK,
    )
    const ident = await observe(
      reader,
      {
        id: 'i1',
        kind: 'identity',
        sourceSpan: null,
        market: FIXTURE_ID,
        loanToken: FIXTURE_PARAMS.loanToken,
        collateralToken: FIXTURE_PARAMS.collateralToken,
        oracle: FIXTURE_PARAMS.oracle,
        irm: FIXTURE_PARAMS.irm,
        lltv: FIXTURE_PARAMS.lltv.toString(),
      },
      PINNED_BLOCK,
    )
    if (liq.kind !== 'liquidity' || ident.kind !== 'identity') throw new Error('wrong kinds')
    expect(liq.withdrawable).toBe(200_000_000_000n)
    expect(ident.params).toEqual(FIXTURE_PARAMS)
    expect(reader.calls.map((c) => c.block)).toEqual([PINNED_BLOCK, PINNED_BLOCK])
  })

  it('refuses a window that starts before genesis', async () => {
    await expect(observe(new FakeReader(), rateClaim(), 3n)).rejects.toThrow(RangeError)
  })
})

describe('viemMorphoReader', () => {
  type Call = { address: Address; functionName: string; args: readonly unknown[]; blockNumber: bigint }

  function fakeClient(calls: Call[]) {
    return {
      readContract: async (args: Call) => {
        calls.push(args)
        switch (args.functionName) {
          case 'market':
            return [1n, 2n, 3n, 4n, 5n, 6n]
          case 'idToMarketParams':
            return [
              FIXTURE_PARAMS.loanToken,
              FIXTURE_PARAMS.collateralToken,
              FIXTURE_PARAMS.oracle,
              FIXTURE_PARAMS.irm,
              FIXTURE_PARAMS.lltv,
            ]
          default:
            return FIXTURE_BORROW_RATE
        }
      },
    }
  }

  it('pins every read to the block and maps tuples to named fields', async () => {
    const calls: Call[] = []
    const morpho: Address = '0x00000000000000000000000000000000000000AA'
    // The fake implements only the slice of readContract the reader uses.
    const reader = viemMorphoReader(fakeClient(calls) as never, morpho)
    const id = FIXTURE_ID as Hex

    const state = await reader.market(id, 42n)
    expect(state).toEqual({
      totalSupplyAssets: 1n,
      totalSupplyShares: 2n,
      totalBorrowAssets: 3n,
      totalBorrowShares: 4n,
      lastUpdate: 5n,
      fee: 6n,
    })
    const params = await reader.idToMarketParams(id, 43n)
    expect(params).toEqual(FIXTURE_PARAMS)
    const rate = await reader.borrowRateView(params, state, 44n)
    expect(rate).toBe(FIXTURE_BORROW_RATE)

    expect(calls.map((c) => [c.address, c.functionName, c.blockNumber])).toEqual([
      [morpho, 'market', 42n],
      [morpho, 'idToMarketParams', 43n],
      [FIXTURE_PARAMS.irm, 'borrowRateView', 44n],
    ])
    expect(calls[2]!.args).toEqual([params, state])
  })
})
