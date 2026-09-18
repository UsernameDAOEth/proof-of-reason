import { describe, expect, it } from 'vitest'
import { SchemaError, parseAction, parseClaim, parseClaims, parseMandate } from '../src/claims.ts'
import { ADAPTER, FIXTURE_ID } from './fixtures.ts'

const rate = {
  id: 'r1',
  kind: 'rate',
  sourceSpan: 'supply APY of 2.3 percent',
  market: FIXTURE_ID,
  side: 'supply',
  valuePct: 2.3,
  basis: 'APY',
  compounding: 'continuous',
  window: { type: 'instant' },
  tolerancePp: 0.05,
}
const utilization = { id: 'u1', kind: 'utilization', sourceSpan: null, market: FIXTURE_ID, valuePct: 80, tolerancePp: 1 }
const liquidity = { id: 'l1', kind: 'liquidity', sourceSpan: null, market: FIXTURE_ID, minWithdrawable: '0' }
const identity = {
  id: 'i1',
  kind: 'identity',
  sourceSpan: null,
  market: FIXTURE_ID,
  loanToken: '0x0000000000000000000000000000000000001000',
  collateralToken: '0x0000000000000000000000000000000000002000',
  oracle: '0x0000000000000000000000000000000000003000',
  irm: '0x0000000000000000000000000000000000004000',
  lltv: '860000000000000000',
}

describe('ClaimV0', () => {
  it('accepts one claim of every kind', () => {
    expect(parseClaims([rate, utilization, liquidity, identity])).toHaveLength(4)
    expect(parseClaim({ ...rate, window: { type: 'median', blocks: 100 } }).kind).toBe('rate')
  })

  it('rejects malformed claims with a SchemaError', () => {
    const bad: unknown[] = [
      { ...rate, extra: true },
      { ...rate, basis: 'apy' },
      { ...rate, compounding: 'daily' },
      { ...rate, side: 'both' },
      { ...rate, window: { type: 'median', blocks: 0 } },
      { ...rate, window: { type: 'median', blocks: 101 } },
      { ...rate, window: { type: 'median', blocks: 2.5 } },
      { ...rate, window: { type: 'instant', blocks: 3 } },
      { ...rate, tolerancePp: -1 },
      { ...rate, valuePct: Number.POSITIVE_INFINITY },
      { ...rate, market: '0x1234' },
      { ...rate, id: '' },
      { ...utilization, valuePct: 100.01 },
      { ...liquidity, minWithdrawable: '1.5' },
      { ...liquidity, minWithdrawable: '-1' },
      { ...liquidity, minWithdrawable: '01' },
      { ...liquidity, minWithdrawable: (2n ** 256n).toString() },
      { ...identity, lltv: '0.86' },
      { ...identity, oracle: '0x123' },
      { id: 'x', kind: 'price', sourceSpan: null },
    ]
    for (const claim of bad) expect(() => parseClaim(claim), JSON.stringify(claim)).toThrow(SchemaError)
  })

  it('requires sourceSpan, which may be null', () => {
    const { sourceSpan: _omit, ...withoutSpan } = rate
    expect(() => parseClaim(withoutSpan)).toThrow(SchemaError)
    expect(parseClaim({ ...rate, sourceSpan: null }).sourceSpan).toBeNull()
  })

  it('accepts the uint256 maximum as a decimal string', () => {
    expect(parseClaim({ ...liquidity, minWithdrawable: (2n ** 256n - 1n).toString() }).kind).toBe('liquidity')
  })

  it('rejects duplicate ids in a claim set', () => {
    expect(() => parseClaims([rate, { ...utilization, id: 'r1' }])).toThrow(/duplicate claim id r1/)
  })
})

describe('ActionV0 and MandateV0', () => {
  it('accepts each action shape', () => {
    expect(parseAction({ fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '1' }).fn).toBe('allocate')
    expect(parseAction({ fn: 'deallocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '1' }).fn).toBe('deallocate')
    expect(parseAction({ fn: 'reallocate', allocations: [{ market: FIXTURE_ID, assets: '0' }] }).fn).toBe('reallocate')
  })

  it('rejects an empty reallocation, an unknown fn, and unknown mandate kinds', () => {
    expect(() => parseAction({ fn: 'reallocate', allocations: [] })).toThrow(SchemaError)
    expect(() => parseAction({ fn: 'withdraw', assets: '1' })).toThrow(SchemaError)
    expect(() => parseMandate({ allowedMarkets: [], requiredKinds: ['price'] })).toThrow(SchemaError)
  })
})
