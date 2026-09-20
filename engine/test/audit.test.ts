import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { CHAINS, chainById, chainByName } from '../src/chains.ts'
import { SchemaError } from '../src/claims.ts'
import { compare } from '../src/compare.ts'
import { observeVaultRate, vaultRatePct } from '../src/erc4626.ts'
import type { Erc4626Reader, VaultRateObservation } from '../src/erc4626.ts'
import { observeBalance } from '../src/erc20.ts'
import type { BalanceObservation, Erc20Reader } from '../src/erc20.ts'
import { observeAuditAll, parseAuditClaims } from '../src/audit.ts'
import { viemMorphoReader } from '../src/morpho.ts'
import { FakeReader, FIXTURE_ID, PINNED_BLOCK } from './fixtures.ts'

const VAULT: Address = '0x00000000000000000000000000000000000000Aa'
const TOKEN: Address = '0x00000000000000000000000000000000000000Bb'
const HOLDER: Address = '0x00000000000000000000000000000000000000Cc'
const DAY = 86_400n

// Hand-checked at 40 digits: growth 1.0001 over one day.
//   APR = ln(1.0001) * 365             = 3.649817512165754 percent
//   APY = exp(APR) - 1 = 1.0001^365 - 1 = 3.717241130255193 percent
const APR_PCT = 3.649817512165754
const APY_PCT = 3.717241130255193

class FakeVaultReader implements Erc4626Reader {
  calls: string[] = []
  assets: Map<bigint, bigint>
  timestamps: Map<bigint, bigint>
  codeFrom: bigint

  constructor(assets: Map<bigint, bigint>, timestamps: Map<bigint, bigint>, codeFrom = 0n) {
    this.assets = assets
    this.timestamps = timestamps
    this.codeFrom = codeFrom
  }
  async blockTimestamp(block: bigint) {
    this.calls.push(`timestamp@${block}`)
    return this.timestamps.get(block)!
  }
  async hasCode(_address: Address, block: bigint) {
    this.calls.push(`code@${block}`)
    return block >= this.codeFrom
  }
  async convertToAssets(_vault: Address, _shares: bigint, block: bigint) {
    this.calls.push(`convertToAssets@${block}`)
    return this.assets.get(block)!
  }
  async totalAssets(_vault: Address, block: bigint) {
    this.calls.push(`totalAssets@${block}`)
    return 5_000_000_000_000n
  }
}

function vaultClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    kind: 'vault_rate',
    sourceSpan: 'the vault earns about 3.7% APY',
    vault: VAULT,
    valuePct: 3.7,
    basis: 'APY',
    compounding: 'continuous',
    lookbackBlocks: 100,
    tolerancePp: 0.05,
    ...overrides,
  }
}

const START = PINNED_BLOCK - 100n
const vaultReader = () =>
  new FakeVaultReader(
    new Map([
      [START, 10n ** 24n],
      [PINNED_BLOCK, 10001n * 10n ** 20n],
    ]),
    new Map([
      [START, 1_700_000_000n],
      [PINNED_BLOCK, 1_700_000_000n + DAY],
    ]),
  )

describe('chain configs', () => {
  it('carry the sourced Morpho addresses and RPC variable names', () => {
    expect(CHAINS.monad).toEqual({
      name: 'monad',
      chainId: 143,
      rpcUrlEnv: 'MONAD_RPC_URL',
      morpho: '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee',
      adaptiveCurveIrm: '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F',
    })
    expect(CHAINS.base).toMatchObject({
      chainId: 8453,
      rpcUrlEnv: 'BASE_RPC_URL',
      morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      adaptiveCurveIrm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
    })
    expect(CHAINS.ethereum).toMatchObject({
      chainId: 1,
      rpcUrlEnv: 'ETHEREUM_RPC_URL',
      morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      adaptiveCurveIrm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
    })
    expect(chainById(8453).name).toBe('base')
    expect(chainByName('ethereum').chainId).toBe(1)
    expect(() => chainByName('solana')).toThrow(RangeError)
  })

  it('the Morpho reader reads the chain config address', async () => {
    const seen: string[] = []
    const client = {
      readContract: async (args: { address: string }) => {
        seen.push(args.address)
        return [0n, 0n, 0n, 0n, 1n, 0n]
      },
    }
    await viemMorphoReader(client as never, CHAINS.base).market(FIXTURE_ID as Hex, 1n)
    expect(seen).toEqual([CHAINS.base.morpho])
  })
})

describe('vault_rate', () => {
  it('formula: continuous compounding from share-price growth', () => {
    expect(vaultRatePct(10n ** 24n, 10001n * 10n ** 20n, DAY, 'APR')).toBeCloseTo(APR_PCT, 10)
    expect(vaultRatePct(10n ** 24n, 10001n * 10n ** 20n, DAY, 'APY')).toBeCloseTo(APY_PCT, 10)
    expect(vaultRatePct(10n ** 24n, 9999n * 10n ** 20n, DAY, 'APR')).toBeCloseTo(-3.650182512167579, 10)
  })

  it('reads the start block then the pinned block, one read at a time', async () => {
    const reader = vaultReader()
    const obs = await observeVaultRate(reader, vaultClaim(), PINNED_BLOCK)
    expect(reader.calls).toEqual([
      `timestamp@${START}`,
      `code@${START}`,
      `convertToAssets@${START}`,
      `timestamp@${PINNED_BLOCK}`,
      `convertToAssets@${PINNED_BLOCK}`,
      `totalAssets@${PINNED_BLOCK}`,
    ])
    expect(obs.valuePct).toBeCloseTo(APY_PCT, 10)
    expect(obs).toMatchObject({ startBlock: START, block: PINNED_BLOCK, totalAssets: 5_000_000_000_000n, probeShares: 10n ** 36n })
  })

  it('compares within tolerance, and APR against APY is a schema error', async () => {
    const obs = await observeVaultRate(vaultReader(), vaultClaim(), PINNED_BLOCK)
    expect(compare(vaultClaim(), obs).status).toBe('TRUE')
    expect(compare(vaultClaim({ valuePct: 6 }), obs)).toMatchObject({ status: 'FALSE', claimed: 6, block: PINNED_BLOCK })
    expect(() => compare(vaultClaim({ basis: 'APR' }), obs)).toThrow(SchemaError)
    expect(() => compare(vaultClaim({ vault: TOKEN }), obs)).toThrow(SchemaError)
  })

  it('is UNVERIFIABLE when the vault did not exist at the start block', async () => {
    const reader = new FakeVaultReader(new Map(), new Map([[START, 1n]]), PINNED_BLOCK)
    const obs = await observeVaultRate(reader, vaultClaim(), PINNED_BLOCK)
    expect(obs.unverifiable).toBe('vault has no code at the start block')
    expect(compare(vaultClaim(), obs).status).toBe('UNVERIFIABLE')
  })

  it('rejects a lookback over the cap', async () => {
    await expect(observeVaultRate(vaultReader(), vaultClaim({ lookbackBlocks: 3_000_001 }), PINNED_BLOCK)).rejects.toThrow(
      SchemaError,
    )
  })
})

describe('balance', () => {
  const reader = (code = true): Erc20Reader & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      async hasCode(_a, block) {
        calls.push(`code@${block}`)
        return code
      },
      async balanceOf(_t, _h, block) {
        calls.push(`balanceOf@${block}`)
        return 1_000_000_000n
      },
    }
  }
  const claim = (overrides: Record<string, unknown> = {}) => ({
    id: 'b1',
    kind: 'balance',
    sourceSpan: null,
    token: TOKEN,
    holder: HOLDER,
    amount: '1000000000',
    toleranceAtomic: '0',
    ...overrides,
  })

  it('reads the balance at the pinned block and compares within an atomic tolerance', async () => {
    const r = reader()
    const obs = await observeBalance(r, claim(), PINNED_BLOCK)
    expect(r.calls).toEqual([`code@${PINNED_BLOCK}`, `balanceOf@${PINNED_BLOCK}`])
    expect(compare(claim(), obs)).toMatchObject({ status: 'TRUE', observed: '1000000000' })
    expect(compare(claim({ amount: '999999990', toleranceAtomic: '10' }), obs).status).toBe('TRUE')
    expect(compare(claim({ amount: '999999989', toleranceAtomic: '10' }), obs).status).toBe('FALSE')
    expect(() => compare(claim({ holder: VAULT }), obs)).toThrow(SchemaError)
  })

  it('is UNVERIFIABLE when the token has no code', async () => {
    const obs = await observeBalance(reader(false), claim(), PINNED_BLOCK)
    expect(obs.unverifiable).toBe('token has no code at the pinned block')
    expect(compare(claim(), obs).status).toBe('UNVERIFIABLE')
  })
})

describe('audit claim set', () => {
  it('parses all six kinds and observes them in order through the matching readers', async () => {
    const claims = parseAuditClaims([
      { id: 'l1', kind: 'liquidity', sourceSpan: null, market: FIXTURE_ID, minWithdrawable: '1' },
      vaultClaim(),
      {
        id: 'b1',
        kind: 'balance',
        sourceSpan: null,
        token: TOKEN,
        holder: HOLDER,
        amount: '1',
        toleranceAtomic: '0',
      },
    ])
    const balances: Erc20Reader = { hasCode: async () => true, balanceOf: async () => 1n }
    const observations = await observeAuditAll(
      { morpho: new FakeReader(), erc4626: vaultReader(), erc20: balances },
      claims,
      PINNED_BLOCK,
    )
    expect(observations.map((o) => o.kind)).toEqual(['liquidity', 'vault_rate', 'balance'])
    expect(claims.map((c, i) => compare(c, observations[i]!).status)).toEqual(['TRUE', 'TRUE', 'TRUE'])
    expect((observations[1] as VaultRateObservation).block).toBe(PINNED_BLOCK)
    expect((observations[2] as BalanceObservation).balance).toBe(1n)
  })

  it('rejects unknown kinds and duplicate ids', () => {
    expect(() => parseAuditClaims([{ id: 'x', kind: 'price', sourceSpan: null }])).toThrow(SchemaError)
    expect(() => parseAuditClaims([vaultClaim(), vaultClaim()])).toThrow(/duplicate claim id v1/)
  })
})
