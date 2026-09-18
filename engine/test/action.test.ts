import { describe, expect, it } from 'vitest'
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  parseAbi,
  parseAbiParameters,
  toFunctionSignature,
} from 'viem'
import type { Hex } from 'viem'
import { checkAction, decodeVaultCall, marketId, vaultAbi } from '../src/action.ts'
import { checkMandate } from '../src/mandate.ts'
import type { MarketParams } from '../src/morpho.ts'
import { ADAPTER, FIXTURE_ID, FIXTURE_PARAMS, OTHER_MARKET } from './fixtures.ts'

const OTHER_PARAMS: MarketParams = { ...FIXTURE_PARAMS, lltv: 915_000_000_000_000_000n }
const OTHER_ID = marketId(OTHER_PARAMS)

function adapterData(params: MarketParams): Hex {
  return encodeAbiParameters(parseAbiParameters('(address,address,address,address,uint256)'), [
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
  ])
}

function allocateData(assets: bigint, params: MarketParams = FIXTURE_PARAMS): Hex {
  return encodeFunctionData({
    abi: vaultAbi,
    functionName: 'allocate',
    args: [ADAPTER, adapterData(params), assets],
  })
}

function reallocateData(legs: [MarketParams, bigint][]): Hex {
  return encodeFunctionData({
    abi: vaultAbi,
    functionName: 'reallocate',
    args: [legs.map(([marketParams, assets]) => ({ marketParams, assets }))],
  })
}

describe('vault ABI', () => {
  it('matches the canonical signatures asserted against the real interfaces in ReasonGate.t.sol', () => {
    expect(toFunctionSignature(getAbiItem({ abi: vaultAbi, name: 'allocate' }))).toBe(
      'allocate(address,bytes,uint256)',
    )
    expect(toFunctionSignature(getAbiItem({ abi: vaultAbi, name: 'deallocate' }))).toBe(
      'deallocate(address,bytes,uint256)',
    )
    expect(toFunctionSignature(getAbiItem({ abi: vaultAbi, name: 'reallocate' }))).toBe(
      'reallocate(((address,address,address,address,uint256),uint256)[])',
    )
  })

  it('market id is keccak256(abi.encode(MarketParams)), matching the Solidity vector', () => {
    expect(FIXTURE_ID).toBe('0xaf8957dd4928705e8b62a61bd6eff57dd7225ea25e90c485c91342a07b90daec')
  })
})

describe('decodeVaultCall', () => {
  it('decodes allocate with the market id from the adapter data', () => {
    const decoded = decodeVaultCall(allocateData(1_000n))
    expect(decoded).toMatchObject({ fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: 1_000n })
  })

  it('rejects trailing bytes on the calldata and on the adapter data', () => {
    expect(() => decodeVaultCall(concat([allocateData(1_000n), '0x00']))).toThrow(/canonical/)
    const padded = encodeFunctionData({
      abi: vaultAbi,
      functionName: 'allocate',
      args: [ADAPTER, concat([adapterData(FIXTURE_PARAMS), '0x01']), 1_000n],
    })
    expect(() => decodeVaultCall(padded)).toThrow(/abi.encode\(MarketParams\)/)
  })
})

describe('checkAction', () => {
  it('matching allocate has no mismatches', () => {
    const check = checkAction(
      { fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '1000' },
      allocateData(1_000n),
    )
    expect(check.mismatches).toEqual([])
  })

  it('flags a different amount, market, adapter, or function', () => {
    const data = allocateData(1_000n)
    const base = { fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '1000' } as const
    expect(checkAction({ ...base, assets: '999' }, data).mismatches.map((m) => m.field)).toEqual(['assets'])
    expect(checkAction({ ...base, market: OTHER_MARKET }, data).mismatches.map((m) => m.field)).toEqual([
      'market',
    ])
    expect(
      checkAction({ ...base, adapter: '0x4444444444444444444444444444444444444444' }, data).mismatches.map(
        (m) => m.field,
      ),
    ).toEqual(['adapter'])
    expect(checkAction({ ...base, fn: 'deallocate' }, data).mismatches).toEqual([
      { source: 'action', field: 'fn', claimed: 'deallocate', observed: 'allocate', block: null },
    ])
  })

  it('checks every reallocate leg in order', () => {
    const data = reallocateData([
      [FIXTURE_PARAMS, 0n],
      [OTHER_PARAMS, 2n ** 256n - 1n],
    ])
    const legs = [
      { market: FIXTURE_ID, assets: '0' },
      { market: OTHER_ID, assets: (2n ** 256n - 1n).toString() },
    ]
    expect(checkAction({ fn: 'reallocate', allocations: legs }, data).mismatches).toEqual([])
    expect(
      checkAction({ fn: 'reallocate', allocations: [legs[1]!, legs[0]!] }, data).mismatches.map((m) => m.field),
    ).toEqual(['allocations.0.market', 'allocations.0.assets', 'allocations.1.market', 'allocations.1.assets'])
    expect(checkAction({ fn: 'reallocate', allocations: [legs[0]!] }, data).mismatches).toEqual([
      { source: 'action', field: 'allocations.length', claimed: 1, observed: 2, block: null },
    ])
  })

  it('undecodable calldata is a mismatch', () => {
    const withdraw = encodeFunctionData({
      abi: parseAbi(['function withdraw(uint256 assets, address receiver, address onBehalf)']),
      functionName: 'withdraw',
      args: [1n, ADAPTER, ADAPTER],
    })
    const check = checkAction({ fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '1' }, withdraw)
    expect(check.decoded).toBeNull()
    expect(check.mismatches).toHaveLength(1)
    expect(check.mismatches[0]!.field).toBe('calldata')
  })
})

describe('checkMandate', () => {
  it('passes when every touched market is allowed', () => {
    const decoded = decodeVaultCall(allocateData(1n))
    expect(checkMandate(decoded, { allowedMarkets: [FIXTURE_ID], requiredKinds: [] })).toEqual([])
  })

  it('flags each market outside the mandate once, including a leg reduced to zero', () => {
    const decoded = decodeVaultCall(
      reallocateData([
        [OTHER_PARAMS, 0n],
        [FIXTURE_PARAMS, 5n],
        [OTHER_PARAMS, 1n],
      ]),
    )
    const violations = checkMandate(decoded, { allowedMarkets: [FIXTURE_ID], requiredKinds: [] })
    expect(violations).toEqual([
      {
        source: 'mandate',
        rule: 'allowedMarkets',
        claimed: OTHER_ID,
        observed: 'not in mandate.allowedMarkets',
        block: null,
      },
    ])
  })

  it('has nothing to check when the calldata did not decode', () => {
    expect(checkMandate(null, { allowedMarkets: [], requiredKinds: [] })).toEqual([])
  })
})
