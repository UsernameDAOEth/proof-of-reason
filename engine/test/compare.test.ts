import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { SchemaError } from '../src/claims.ts'
import type { RateClaim } from '../src/claims.ts'
import { compare } from '../src/compare.ts'
import { observe } from '../src/morpho.ts'
import type { Observation, RateObservation } from '../src/morpho.ts'
import { FakeReader, FIXTURE_ID, FIXTURE_MARKET, FIXTURE_PARAMS, PINNED_BLOCK } from './fixtures.ts'

function rateClaim(overrides: Partial<RateClaim> = {}): RateClaim {
  return {
    id: 'r1',
    kind: 'rate',
    sourceSpan: '5% supply APY',
    market: FIXTURE_ID,
    side: 'supply',
    valuePct: 5,
    basis: 'APY',
    compounding: 'continuous',
    window: { type: 'instant' },
    tolerancePp: 0.25,
    ...overrides,
  }
}

function rateObs(valuePct: number | null, overrides: Partial<RateObservation> = {}): RateObservation {
  return {
    kind: 'rate',
    market: FIXTURE_ID as Hex,
    side: 'supply',
    basis: 'APY',
    block: PINNED_BLOCK,
    samples: [],
    valuePct,
    unverifiable: valuePct === null ? 'guard' : null,
    ...overrides,
  }
}

describe('compare, tolerance edges', () => {
  it('exactly at tolerance is TRUE, above and below', () => {
    expect(compare(rateClaim(), rateObs(5.25)).status).toBe('TRUE')
    expect(compare(rateClaim(), rateObs(4.75)).status).toBe('TRUE')
  })

  it('exactly at tolerance is TRUE even when the float difference rounds up', () => {
    // 0.4 - 0.1 evaluates to 0.30000000000000004 in IEEE 754.
    expect(0.4 - 0.1).toBeGreaterThan(0.3)
    const claim = rateClaim({ valuePct: 0.1, tolerancePp: 0.3 })
    expect(compare(claim, rateObs(0.4)).status).toBe('TRUE')
  })

  it('just beyond tolerance is FALSE', () => {
    expect(compare(rateClaim(), rateObs(5.250001)).status).toBe('FALSE')
    expect(compare(rateClaim(), rateObs(4.749999)).status).toBe('FALSE')
  })

  it('zero tolerance demands equality', () => {
    const claim = rateClaim({ tolerancePp: 0 })
    expect(compare(claim, rateObs(5)).status).toBe('TRUE')
    expect(compare(claim, rateObs(5.000001)).status).toBe('FALSE')
  })

  it('reports claimed, observed, and block', () => {
    const result = compare(rateClaim(), rateObs(6))
    expect(result).toEqual({ id: 'r1', kind: 'rate', status: 'FALSE', claimed: 5, observed: 6, block: PINNED_BLOCK })
  })

  it('utilization exactly at tolerance is TRUE', () => {
    const claim = {
      id: 'u1',
      kind: 'utilization',
      sourceSpan: null,
      market: FIXTURE_ID,
      valuePct: 80,
      tolerancePp: 0.5,
    } as const
    const obs = (valuePct: number): Observation => ({
      kind: 'utilization',
      market: FIXTURE_ID as Hex,
      block: PINNED_BLOCK,
      samples: [],
      valuePct,
      unverifiable: null,
    })
    expect(compare(claim, obs(80.5)).status).toBe('TRUE')
    expect(compare(claim, obs(79.5)).status).toBe('TRUE')
    expect(compare(claim, obs(80.51)).status).toBe('FALSE')
  })

  it('liquidity exactly at the bound is TRUE, one unit short is FALSE', () => {
    const claim = {
      id: 'l1',
      kind: 'liquidity',
      sourceSpan: null,
      market: FIXTURE_ID,
      minWithdrawable: '200000000000',
    } as const
    const obs = (withdrawable: bigint): Observation => ({
      kind: 'liquidity',
      market: FIXTURE_ID as Hex,
      block: PINNED_BLOCK,
      samples: [],
      withdrawable,
      unverifiable: null,
    })
    expect(compare(claim, obs(200_000_000_000n)).status).toBe('TRUE')
    expect(compare(claim, obs(199_999_999_999n)).status).toBe('FALSE')
  })

  it('identity compares addresses case-insensitively and lltv exactly', () => {
    const claim = {
      id: 'i1',
      kind: 'identity',
      sourceSpan: null,
      market: FIXTURE_ID.toUpperCase().replace('0X', '0x'),
      loanToken: FIXTURE_PARAMS.loanToken.toUpperCase().replace('0X', '0x'),
      collateralToken: FIXTURE_PARAMS.collateralToken,
      oracle: FIXTURE_PARAMS.oracle,
      irm: FIXTURE_PARAMS.irm,
      lltv: '860000000000000000',
    }
    const obs: Observation = {
      kind: 'identity',
      market: FIXTURE_ID as Hex,
      block: PINNED_BLOCK,
      params: FIXTURE_PARAMS,
      unverifiable: null,
    }
    expect(compare(claim, obs).status).toBe('TRUE')
    expect(compare({ ...claim, lltv: '860000000000000001' }, obs).status).toBe('FALSE')
  })

  it('an unverifiable observation gives UNVERIFIABLE', () => {
    const result = compare(rateClaim(), rateObs(null))
    expect(result.status).toBe('UNVERIFIABLE')
    expect(result.observed).toBeNull()
  })
})

describe('observe then compare, liquidity floor', () => {
  it('a floor claim met at the pinned block but not at every block of the window is FALSE', async () => {
    const dip = { ...FIXTURE_MARKET, totalBorrowAssets: 850_000_000_000n }
    const reader = new FakeReader({ states: new Map([[997n, dip]]) })
    const claim = {
      id: 'l1',
      kind: 'liquidity',
      sourceSpan: null,
      market: FIXTURE_ID,
      minWithdrawable: '200000000000',
    } as const
    const result = compare(claim, await observe(reader, claim, PINNED_BLOCK))
    expect(result.status).toBe('FALSE')
    expect(result.observed).toBe('150000000000')
  })
})

describe('compare, schema errors', () => {
  it('APR claimed against an APY basis is a schema error, not a FALSE', () => {
    const claim = rateClaim({ basis: 'APR' })
    expect(() => compare(claim, rateObs(5, { basis: 'APY' }))).toThrow(SchemaError)
    expect(() => compare(claim, rateObs(5, { basis: 'APY' }))).toThrow(/APR but the observation basis is APY/)
  })

  it('APY claimed against an APR basis is a schema error too', () => {
    expect(() => compare(rateClaim({ basis: 'APY' }), rateObs(5, { basis: 'APR' }))).toThrow(SchemaError)
  })

  it('a side mismatch is a schema error', () => {
    expect(() => compare(rateClaim(), rateObs(5, { side: 'borrow' }))).toThrow(SchemaError)
  })

  it('a kind or market mismatch is a schema error', () => {
    const liquidity: Observation = {
      kind: 'liquidity',
      market: FIXTURE_ID as Hex,
      block: PINNED_BLOCK,
      samples: [],
      withdrawable: 1n,
      unverifiable: null,
    }
    expect(() => compare(rateClaim(), liquidity)).toThrow(SchemaError)
    expect(() => compare(rateClaim(), rateObs(5, { market: `0x${'00'.repeat(32)}` }))).toThrow(SchemaError)
  })

  it('a malformed claim is a schema error', () => {
    const bad = [
      { ...rateClaim(), basis: 'apy' },
      { ...rateClaim(), compounding: 'daily' },
      { ...rateClaim(), extra: 1 },
      { ...rateClaim(), tolerancePp: -0.1 },
    ]
    for (const claim of bad) expect(() => compare(claim, rateObs(5))).toThrow(SchemaError)
  })
})

describe('observe then compare on the fixture market', () => {
  it('supply APY claim at the hand-computed value is TRUE; a stale 5% claim is FALSE', async () => {
    const reader = new FakeReader()
    const good = rateClaim({ valuePct: 2.3, tolerancePp: 0.01 })
    const stale = rateClaim({ id: 'r2', valuePct: 5, tolerancePp: 0.25 })
    expect(compare(good, await observe(reader, good, PINNED_BLOCK)).status).toBe('TRUE')
    expect(compare(stale, await observe(reader, stale, PINNED_BLOCK)).status).toBe('FALSE')
  })
})
