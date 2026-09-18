import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters } from 'viem'
import type { Address, Hex } from 'viem'
import type { ActionV0, ClaimV0, MandateV0 } from '../src/claims.ts'
import { vaultAbi } from '../src/action.ts'
import {
  ENGINE_VERSION,
  RULESET,
  buildReceipt,
  canonicalJson,
  claimsHash,
  receiptHash,
} from '../src/receipt.ts'
import type { ReceiptInput } from '../src/receipt.ts'
import { gateDomain, hashIntent } from '../src/sign.ts'
import { ADAPTER, FIXTURE_ID, FIXTURE_PARAMS, PINNED_BLOCK } from './fixtures.ts'

/** Rebuild every plain object with its keys in reverse insertion order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse()
    return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeys(v)])) as T
  }
  return value
}

const GATE: Address = '0x1111111111111111111111111111111111111111'
const VAULT: Address = '0x2222222222222222222222222222222222222222'

const data: Hex = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'allocate',
  args: [
    ADAPTER,
    encodeAbiParameters(parseAbiParameters('(address,address,address,address,uint256)'), [
      [
        FIXTURE_PARAMS.loanToken,
        FIXTURE_PARAMS.collateralToken,
        FIXTURE_PARAMS.oracle,
        FIXTURE_PARAMS.irm,
        FIXTURE_PARAMS.lltv,
      ],
    ]),
    1_000_000_000n,
  ],
})

const claims: ClaimV0[] = [
  {
    id: 'r1',
    kind: 'rate',
    sourceSpan: 'supply APY is 2.3%',
    market: FIXTURE_ID,
    side: 'supply',
    valuePct: 2.3,
    basis: 'APY',
    compounding: 'continuous',
    window: { type: 'median', blocks: 5 },
    tolerancePp: 0.01,
  },
  { id: 'l1', kind: 'liquidity', sourceSpan: null, market: FIXTURE_ID, minWithdrawable: '1000000000' },
]

const action: ActionV0 = { fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '1000000000' }
const mandate: MandateV0 = { allowedMarkets: [FIXTURE_ID], requiredKinds: ['rate'] }

function input(): ReceiptInput {
  return {
    chainId: 31337,
    gate: GATE,
    vault: VAULT,
    data,
    nonce: 7n,
    notAfterBlock: 1_010n,
    claims,
    action,
    mandate,
    observations: [
      {
        kind: 'liquidity',
        market: FIXTURE_ID as Hex,
        block: PINNED_BLOCK,
        withdrawable: 200_000_000_000n,
        unverifiable: null,
      },
    ],
    results: [
      { id: 'l1', kind: 'liquidity', status: 'TRUE', claimed: '1000000000', observed: '200000000000', block: PINNED_BLOCK },
    ],
    verdict: { outcome: 'PASS', failing: [], missingKinds: [] },
    checkedAtBlock: PINNED_BLOCK,
    modelId: null,
  }
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    )
  })

  it('writes bigints as decimal strings', () => {
    expect(canonicalJson({ n: 2n ** 200n })).toBe(`{"n":"${(2n ** 200n).toString()}"}`)
  })

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('rejects undefined anywhere', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError)
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError)
  })

  it('rejects non-finite numbers and non-plain objects', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(TypeError)
    expect(() => canonicalJson({ a: new Map() })).toThrow(TypeError)
  })

  it('is valid JSON', () => {
    expect(JSON.parse(canonicalJson({ b: [1, 'two', null, true], a: 1.5 }))).toEqual({
      a: 1.5,
      b: [1, 'two', null, true],
    })
  })
})

describe('receipt hash', () => {
  it('same input gives the same hash regardless of key order', () => {
    const a = receiptHash(buildReceipt(input()))
    const b = receiptHash(buildReceipt(reverseKeys(input())))
    expect(Object.keys(reverseKeys(input()))).not.toEqual(Object.keys(input()))
    expect(a).toBe(b)
    expect(receiptHash(reverseKeys(buildReceipt(input())))).toBe(a)
  })

  it('claimsHash ignores key order too', () => {
    expect(claimsHash(reverseKeys(claims))).toBe(claimsHash(claims))
  })

  it('any change in content changes the hash', () => {
    const base = receiptHash(buildReceipt(input()))
    expect(receiptHash(buildReceipt({ ...input(), nonce: 8n }))).not.toBe(base)
    expect(receiptHash(buildReceipt({ ...input(), modelId: 'model-x' }))).not.toBe(base)
    expect(receiptHash(buildReceipt({ ...input(), checkedAtBlock: 999n }))).not.toBe(base)
    const edited = [{ ...claims[0]!, valuePct: 2.31 } as ClaimV0, claims[1]!]
    expect(receiptHash(buildReceipt({ ...input(), claims: edited }))).not.toBe(base)
  })

  it('carries intent fields, ruleset, engine version, and model id', () => {
    const receipt = buildReceipt(input())
    expect(receipt.ruleset).toBe(RULESET)
    expect(RULESET).toBe('REASON-R0')
    expect(receipt.engineVersion).toBe(ENGINE_VERSION)
    expect(receipt.modelId).toBeNull()
    expect(receipt.intent.dataHash).toBe(keccak256(data))
    expect(receipt.intent.claimsHash).toBe(claimsHash(claims))
    expect(receipt.intent.intentHash).toBe(
      hashIntent(gateDomain(31337, GATE), {
        vault: VAULT,
        dataHash: keccak256(data),
        claimsHash: claimsHash(claims),
        nonce: 7n,
        notAfterBlock: 1_010n,
      }),
    )
    expect(receipt.verdict).toMatchObject({ outcome: 'PASS', outcomeCode: 1, checkedAtBlock: PINNED_BLOCK })
    expect(receipt.observations[0]).toMatchObject({ block: PINNED_BLOCK })
  })
})
