import { describe, expect, it } from 'vitest'
import { maxUint256 } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { checkAction, decodeVaultCall, marketId } from 'proof-of-reason-engine/action'
import { compare } from 'proof-of-reason-engine/compare'
import type { Observation } from 'proof-of-reason-engine/morpho'
import type { ClaimV0 } from 'proof-of-reason-engine/claims'
// The Worker itself, in process, with its own test doubles: the 402 flow is checked against the
// same FakeFacilitator the worker suite uses, not against a mock of my own making.
import { createApp } from '../../worker/src/app.ts'
import { MANDATES } from '../../worker/src/mandates.ts'
import { FakeFacilitator, FakeReader, MemoryStore, PAY_TO, checkDeps } from '../../worker/test/helpers.ts'
import {
  AGENT,
  MARKET_A,
  MARKET_B,
  MOVE_ATOMIC,
  SEED_ATOMIC,
  VAULT,
  buildAction,
  buildReallocateData,
  parseEnvFile,
  phraseClaims,
  probeClaims,
  saveCheck,
  toAssetsDown,
  usdc,
  verdictMatchesIntent,
} from '../demo-check.ts'
import type { CheckBody, CheckResponse, SavedCheck } from '../demo-check.ts'
import { payAndCheck } from '../demo-check.ts'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Frozen vector: 10 USDC in market A, 5 USDC moved out, so market A targets 5 USDC and market B
 * takes the remainder with maxUint256. Regenerate with
 * `node -e "import('./demo-check.ts').then(m => console.log(m.buildReallocateData({fromCurrentAssets: 10000000n, moveAtomic: 5000000n}).data))"`
 * and only when the vault ABI itself changes.
 */
const VECTOR: Hex =
  '0x7299aa3100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb6030000000000000000000000007cd231120a60f500887444a9baf5e1bd753a5e590000000000000000000000004af4f38164cd7f28653a66aa2255b249a23cfbec00000000000000000000000009475a3d6ea8c314c592b1a3799bde044e2f400f0000000000000000000000000000000000000000000000000aaf96eb9d0d000000000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603000000000000000000000000a08a69ab9dd3b04d0992bc7afb2c0b907bbdc147000000000000000000000000597921a5b5ad74a0bf573fd7b58f80c383dcdab200000000000000000000000009475a3d6ea8c314c592b1a3799bde044e2f400f0000000000000000000000000000000000000000000000000cb2bba6f17b8000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/** The selector the live gate allowlists: MetaMorpho V1.1 reallocate. */
const REALLOCATE_SELECTOR = '0x7299aa31'

describe('the reallocate calldata', () => {
  it('matches the frozen vector, byte for byte', () => {
    const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: SEED_ATOMIC, moveAtomic: MOVE_ATOMIC })
    expect(data).toBe(VECTOR)
    expect(fromTarget).toBe(5_000_000n)
    expect(data.slice(0, 10)).toBe(REALLOCATE_SELECTOR)
  })

  it('decodes back to the two allocations, through the decoder the validator uses', () => {
    const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: SEED_ATOMIC, moveAtomic: MOVE_ATOMIC })
    const decoded = decodeVaultCall(data)
    expect(decoded.fn).toBe('reallocate')
    if (decoded.fn !== 'reallocate') throw new Error('unreachable')
    expect(decoded.allocations).toHaveLength(2)
    // Withdraw from A down to the target, then supply the remainder to B.
    expect(decoded.allocations[0]!.market).toBe(MARKET_A.id)
    expect(decoded.allocations[0]!.assets).toBe(fromTarget)
    expect(decoded.allocations[1]!.market).toBe(MARKET_B.id)
    expect(decoded.allocations[1]!.assets).toBe(maxUint256)
  })

  it('carries the market ids docs/MONAD.md section 3 records', () => {
    // The id is keccak256(abi.encode(marketParams)), so the params on the page and the id agree.
    expect(marketId(MARKET_A.params)).toBe(MARKET_A.id)
    expect(marketId(MARKET_B.params)).toBe(MARKET_B.id)
  })

  it('agrees with the action the agent states, so the validator finds no mismatch', () => {
    const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: SEED_ATOMIC, moveAtomic: MOVE_ATOMIC })
    const action = buildAction(fromTarget)
    const result = checkAction(action as never, data)
    expect(result.mismatches).toEqual([])
  })

  it('refuses to move more than the market holds, rather than underflowing', () => {
    expect(() => buildReallocateData({ fromCurrentAssets: 1_000_000n, moveAtomic: MOVE_ATOMIC })).toThrow(
      /less than the 5.000000 USDC to move; run seed first/,
    )
    expect(() => buildReallocateData({ fromCurrentAssets: SEED_ATOMIC, moveAtomic: 0n })).toThrow(/nothing to move/)
  })
})

describe('the claims, phrased from what was read', () => {
  const pinned = 106_700_000n
  const sample = (block: bigint, valuePct: number) => ({ block, valuePct })

  /** A five block guard window around a supply APY of 4.8712 percent, and a dipping liquidity floor. */
  const fixture: Observation[] = [
    {
      kind: 'rate',
      market: MARKET_B.id,
      side: 'supply',
      basis: 'APY',
      block: pinned,
      samples: [
        sample(pinned - 4n, 4.8698),
        sample(pinned - 3n, 4.8705),
        sample(pinned - 2n, 4.8712),
        sample(pinned - 1n, 4.8719),
        sample(pinned, 4.8724),
      ],
      valuePct: 4.8712,
      unverifiable: null,
    },
    {
      kind: 'liquidity',
      market: MARKET_B.id,
      block: pinned,
      samples: [
        { block: pinned - 1n, withdrawable: 2_080_298_466_672n },
        { block: pinned, withdrawable: 2_080_123_456_789n },
      ],
      withdrawable: 2_080_123_456_789n,
      unverifiable: null,
    },
  ]

  it('states the rate to four decimals of the median, inside its own tolerance', () => {
    const [rate] = phraseClaims(fixture) as [Extract<ClaimV0, { kind: 'rate' }>]
    expect(rate.kind).toBe('rate')
    expect(rate.market).toBe(MARKET_B.id)
    expect(rate.side).toBe('supply')
    expect(rate.basis).toBe('APY')
    expect(rate.compounding).toBe('continuous')
    expect(rate.valuePct).toBe(4.8712)
    expect(Math.abs(rate.valuePct - 4.8712)).toBeLessThanOrEqual(rate.tolerancePp)
  })

  it('states liquidity as a floor at 90 percent of the worst block in the window', () => {
    const [, liquidity] = phraseClaims(fixture) as [ClaimV0, Extract<ClaimV0, { kind: 'liquidity' }>]
    expect(liquidity.kind).toBe('liquidity')
    expect(liquidity.minWithdrawable).toBe('1872111111110')
    expect(BigInt(liquidity.minWithdrawable)).toBeLessThan(2_080_123_456_789n)
  })

  it('compares TRUE against the very observations it was phrased from', () => {
    const claims = phraseClaims(fixture)
    const results = claims.map((claim, i) => compare(claim, fixture[i]!))
    expect(results.map((r) => r.status)).toEqual(['TRUE', 'TRUE'])
    expect(results.map((r) => r.kind)).toEqual(['rate', 'liquidity'])
  })

  it('keeps the probe claims and the phrased claims the same shape, only the values change', () => {
    const probes = probeClaims()
    const phrased = phraseClaims(fixture)
    expect(phrased).toHaveLength(probes.length)
    for (const [i, claim] of phrased.entries()) {
      expect(Object.keys(claim).sort()).toEqual(Object.keys(probes[i]!).sort())
      expect(claim.id).toBe(probes[i]!.id)
      expect(claim.sourceSpan).toBe(probes[i]!.sourceSpan)
    }
    // The mandate requires a rate and a liquidity claim, and that is what is sent.
    expect(phrased.map((c) => c.kind)).toEqual([...MANDATES['demo-usdc-v1']!.requiredKinds])
  })

  it('refuses to state a claim it could not read', () => {
    const blind: Observation[] = [
      { ...fixture[0]!, valuePct: null, unverifiable: 'guard window tripped' } as Observation,
      fixture[1]!,
    ]
    expect(() => phraseClaims(blind)).toThrow(/rate is unverifiable: guard window tripped/)
    const dry: Observation[] = [
      fixture[0]!,
      { ...fixture[1]!, withdrawable: null, unverifiable: 'market not created' } as Observation,
    ]
    expect(() => phraseClaims(dry)).toThrow(/liquidity is unverifiable: market not created/)
  })
})

describe('the paid 402 flow', () => {
  const validator = privateKeyToAccount(generatePrivateKey())
  const agent = privateKeyToAccount(generatePrivateKey())

  function app() {
    const facilitator = new FakeFacilitator()
    const receipts = new MemoryStore()
    const instance = createApp({
      facilitator,
      payTo: PAY_TO,
      receipts,
      mandates: MANDATES,
      // The real Worker, reading the fake chain, signing with a throwaway validator key.
      checkDeps: () => checkDeps(validator, new FakeReader(), { vault: VAULT }),
    })
    return { instance, facilitator, receipts }
  }

  /** The body the script would send, with claim values the FakeReader will agree with. */
  function body(): CheckBody {
    const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: SEED_ATOMIC, moveAtomic: MOVE_ATOMIC })
    return {
      intent: { vault: VAULT, data, nonce: '1', notAfterBlock: '106999999' },
      action: buildAction(fromTarget),
      claims: [
        {
          id: 'r1',
          kind: 'rate',
          sourceSpan: 'market B pays more to supply than market A',
          market: MARKET_B.id,
          side: 'supply',
          valuePct: 4.9,
          basis: 'APY',
          compounding: 'continuous',
          window: { type: 'instant' },
          tolerancePp: 0.5,
        },
        {
          id: 'l1',
          kind: 'liquidity',
          sourceSpan: 'market B can return the 5 USDC on demand',
          market: MARKET_B.id,
          minWithdrawable: '1000000',
        },
      ],
      mandateId: 'demo-usdc-v1',
    }
  }

  it('is challenged with 402, pays, and comes back with a signed verdict', async () => {
    const { instance, facilitator } = app()
    const challenges: unknown[] = []
    const result = await payAndCheck({
      origin: 'https://api.test',
      body: body(),
      signer: agent,
      fetchImpl: async (url, init) => instance.request(url, init),
      onChallenge: (accepts) => challenges.push(accepts),
    })

    expect(result.paid).toBe(true)
    expect(result.status).toBe(200)
    const response = result.body as CheckResponse
    expect(['PASS', 'WAIT', 'FAIL']).toContain(response.verdict.outcome)
    expect(response.signed.validator).toBe(validator.address)
    expect(response.signed.receiptHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(response.signed.signature).toMatch(/^0x[0-9a-f]+$/)
    // The challenge carried the terms, and the agent paid them: no facilitator URL is hardcoded.
    expect(challenges).toHaveLength(1)
    expect(JSON.stringify(challenges[0])).toContain('eip155:143')
    expect(facilitator.calls).toEqual(['supported', 'verify', 'settle'])
    expect(facilitator.lastVerify?.requirements).toMatchObject({ amount: '100000', network: 'eip155:143' })
  })

  it('does not pay when the request is refused for free', async () => {
    const { instance, facilitator } = app()
    const result = await payAndCheck({
      origin: 'https://api.test',
      body: { ...body(), mandateId: 'no-such-mandate' },
      signer: agent,
      fetchImpl: async (url, init) => instance.request(url, init),
    })
    expect(result.paid).toBe(false)
    expect(result.status).toBe(404)
    expect(facilitator.calls).not.toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })
})

describe('what is carried between the two commands', () => {
  it('saves the intent and the verdict, and no key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-check-'))
    const path = join(dir, 'last-check.json')
    const saved: SavedCheck = {
      savedAt: '2026-09-25T12:00:00.000Z',
      mandateId: 'demo-usdc-v1',
      outcome: 'PASS',
      intent: { vault: VAULT, data: VECTOR, nonce: '7', notAfterBlock: '106999999' },
      signed: {
        domain: { name: 'Proof of Reason', version: '1', chainId: 143, verifyingContract: AGENT },
        intentHash: `0x${'11'.repeat(32)}`,
        claimsHash: `0x${'22'.repeat(32)}`,
        outcome: 1,
        checkedAtBlock: '106700000',
        receiptHash: `0x${'33'.repeat(32)}`,
        validator: AGENT,
        signature: `0x${'44'.repeat(65)}`,
      },
      receiptUrl: 'https://api.proofofreason.com/receipts/0x11',
      registryTx: null,
    }
    saveCheck(saved, path)
    const text = readFileSync(path, 'utf8')
    expect(JSON.parse(text)).toEqual(saved)
    // The guarantee is the shape: these fields and no others, so nothing can ride along. The hashes
    // and the validator signature are public by design; a key would have to be a new field.
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'intent',
      'mandateId',
      'outcome',
      'receiptUrl',
      'registryTx',
      'savedAt',
      'signed',
    ])
    expect(text).not.toMatch(/AGENT_KEY|PRIVATE_KEY|authorization/i)
  })

  it('refuses a verdict that is not over the saved intent', () => {
    const saved: SavedCheck = {
      savedAt: '2026-09-25T12:00:00.000Z',
      mandateId: 'demo-usdc-v1',
      outcome: 'PASS',
      intent: { vault: VAULT, data: VECTOR, nonce: '7', notAfterBlock: '106999999' },
      signed: {
        domain: { name: 'Proof of Reason', version: '1', chainId: 143, verifyingContract: AGENT },
        intentHash: `0x${'de'.repeat(32)}`,
        claimsHash: `0x${'22'.repeat(32)}`,
        outcome: 1,
        checkedAtBlock: '106700000',
        receiptHash: `0x${'33'.repeat(32)}`,
        validator: AGENT,
        signature: `0x${'44'.repeat(65)}`,
      },
      receiptUrl: 'https://api.proofofreason.com/receipts/0xde',
      registryTx: null,
    }
    expect(verdictMatchesIntent(saved)).toBe('the saved verdict is not over the saved intent')
  })
})

describe('the small pieces', () => {
  it('reads an env file without keeping anything else', () => {
    const parsed = parseEnvFile('# a comment\nRPC_URL=https://rpc.example/abc\nAGENT_KEY="0xdeadbeef"\n\nBAD\n')
    expect(parsed).toEqual({ RPC_URL: 'https://rpc.example/abc', AGENT_KEY: '0xdeadbeef' })
  })

  it('converts shares to assets the way Morpho does, with the virtual amounts', () => {
    // SharesMathLib.toAssetsDown: shares * (totalAssets + 1) / (totalShares + 1e6).
    expect(toAssetsDown(0n, 1_000_000n, 1_000_000_000_000n)).toBe(0n)
    // A full share balance at a 1e6 share price comes back whole.
    expect(toAssetsDown(10_000_000_000_000n, 10_000_000n, 10_000_000_000_000n)).toBe(10_000_000n)
    // And it rounds down, never up, so a target is never over-stated.
    expect(toAssetsDown(3n, 10_000_000n, 10_000_000_000_000n)).toBe(0n)
    expect(toAssetsDown(1_234_567n, 9_999_999n, 1_234_567_890_123n)).toBe(9n)
    expect(toAssetsDown(1n, 0n, 0n)).toBe(0n)
  })

  it('prints USDC at six decimals', () => {
    expect(usdc(5_000_000n)).toBe('5.000000 USDC')
    expect(usdc(100_000n)).toBe('0.100000 USDC')
    expect(usdc(0n)).toBe('0.000000 USDC')
  })
})
