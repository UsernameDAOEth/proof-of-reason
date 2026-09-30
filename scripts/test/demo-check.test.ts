import { describe, expect, it, vi } from 'vitest'
import {
  concat,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  keccak256,
  maxUint256,
  recoverAddress,
  stringToBytes,
  toFunctionSelector,
} from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { monad } from 'viem/chains'
import { observeAll } from 'proof-of-reason-engine/morpho'
import { decide } from 'proof-of-reason-engine/verdict'
import { checkAction, decodeVaultCall, marketId } from 'proof-of-reason-engine/action'
import { compare } from 'proof-of-reason-engine/compare'
import type { Observation } from 'proof-of-reason-engine/morpho'
import type { ClaimV0 } from 'proof-of-reason-engine/claims'
// The Worker itself, in process, with its own test doubles: the 402 flow is checked against the
// same FakeFacilitator the worker suite uses, not against a mock of my own making.
import { createApp } from '../../worker/src/app.ts'
import { MANDATES } from '../../worker/src/mandates.ts'
import { FakeFacilitator, FakeReader, HEAD, MemoryStore, PAY_TO, checkDeps } from '../../worker/test/helpers.ts'
import {
  AGENT,
  MARKET_A,
  MARKET_B,
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
  premiseArgs,
  verdictMatchesIntent,
} from '../demo-check.ts'
import type { CheckBody, CheckResponse, SavedCheck } from '../demo-check.ts'
import { payAndCheck } from '../demo-check.ts'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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

/** The frozen vector moves 5 USDC; the command's default is now 4 (DEFAULT_MOVE_ATOMIC). */
const MOVE_ATOMIC = 5_000_000n

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
        domain: { name: 'Proof of Reason', version: '2', chainId: 143, verifyingContract: AGENT },
        intentHash: `0x${'11'.repeat(32)}`,
        claimsHash: `0x${'22'.repeat(32)}`,
        outcome: 1,
        checkedAtBlock: '106700000',
        receiptHash: `0x${'33'.repeat(32)}`,
        tally: { falseCount: 0, unverifiableCount: 0, missingCount: 0, mismatchCount: 0, violationCount: 0 },
        premisesHash: `0x${'55'.repeat(32)}`,
        premises: [{ subject: `0x${'66'.repeat(32)}`, kind: 2, lo: '4000000', hi: '1' }],
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
        domain: { name: 'Proof of Reason', version: '2', chainId: 143, verifyingContract: AGENT },
        intentHash: `0x${'de'.repeat(32)}`,
        claimsHash: `0x${'22'.repeat(32)}`,
        outcome: 1,
        checkedAtBlock: '106700000',
        receiptHash: `0x${'33'.repeat(32)}`,
        tally: { falseCount: 0, unverifiableCount: 0, missingCount: 0, mismatchCount: 0, violationCount: 0 },
        premisesHash: `0x${'55'.repeat(32)}`,
        premises: [{ subject: `0x${'66'.repeat(32)}`, kind: 2, lo: '4000000', hi: '1' }],
        validator: AGENT,
        signature: `0x${'44'.repeat(65)}`,
      },
      receiptUrl: 'https://api.proofofreason.com/receipts/0xde',
      registryTx: null,
    }
    expect(verdictMatchesIntent(saved)).toBe('the saved verdict is not over the saved intent')
  })

  it('turns served premises back into the integers the gate decodes', () => {
    expect(premiseArgs([{ subject: `0x${'66'.repeat(32)}`, kind: 2, lo: '4000000', hi: '115792089237316195423570985008687907853269984665640564039457584007913129639935' }])).toEqual([
      { subject: `0x${'66'.repeat(32)}`, kind: 2, lo: 4_000_000n, hi: (1n << 256n) - 1n },
    ])
    expect(premiseArgs([])).toEqual([])
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

// ------------------------------------------------------------------ the three demo takes

import {
  FALSE_RATE_OFFSET_PP,
  GATE,
  buildCheckBody,
  executeArgs,
  executeRefusal,
  fetchReceipt,
  gateAbi,
  gateDomainV1,
  intentHashOf,
  parseArgs,
  signOverride,
  simulateExecute,
  verdictWindowLines,
  writeReceipt,
} from '../demo-check.ts'

/** The observer, mocked: the engine's own observeAll over the worker suite's FakeReader. */
const fakeObserve = (claims: ClaimV0[], block: bigint) => observeAll(new FakeReader(), claims, block)

/** The first paid check on the v1 gate, 2026-09-25, as the live API serves its receipt. */
const FIRST_PASS: SavedCheck = {
  savedAt: '2026-09-25T20:44:59.605Z',
  mandateId: 'demo-usdc-v1',
  outcome: 'PASS',
  intent: {
    vault: VAULT,
    data: '0x7299aa3100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb6030000000000000000000000007cd231120a60f500887444a9baf5e1bd753a5e590000000000000000000000004af4f38164cd7f28653a66aa2255b249a23cfbec00000000000000000000000009475a3d6ea8c314c592b1a3799bde044e2f400f0000000000000000000000000000000000000000000000000aaf96eb9d0d000000000000000000000000000000000000000000000000000000000000004c4b3f000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603000000000000000000000000a08a69ab9dd3b04d0992bc7afb2c0b907bbdc147000000000000000000000000597921a5b5ad74a0bf573fd7b58f80c383dcdab200000000000000000000000009475a3d6ea8c314c592b1a3799bde044e2f400f0000000000000000000000000000000000000000000000000cb2bba6f17b8000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    nonce: '1790369096908',
    notAfterBlock: '107991934',
  },
  signed: {
    domain: { name: 'Proof of Reason', version: '1', chainId: 143, verifyingContract: GATE },
    intentHash: '0x45ab90694af77667d82c0b3047611c4ac707b3e3f94cda5cd67aad63735298e3',
    claimsHash: '0x7d51f0fda6b217bf1e6157dcaf2ac34042232510870a3f66f23cc846bfc016f8',
    outcome: 1,
    checkedAtBlock: '107991649',
    receiptHash: '0x3cb1764a104bc52f1db95b9f6572de13d3a352ee5ec4213a2050e64a454b1ea7',
    validator: '0xEC37691732204714DDfd024B67F1B7abfcF3FC9E',
    signature:
      '0xcdaeb82f1c382ff3cdfd6495451b60c524197f759a2005fff95ca5697abd107743e0ae4943b52313c4165eddaf90a42462e8fbfb119ed3ffd705db372d3fa32a1b',
  },
  receiptUrl: 'https://api.proofofreason.com/receipts/0x45ab90694af77667d82c0b3047611c4ac707b3e3f94cda5cd67aad63735298e3',
  registryTx: '0x4eb4422544c1120c5133653d06469ab7ef44574eeaf0ecd4bcf1134311740240',
}

describe('the flags', () => {
  it('parses every flag to the command that owns it', () => {
    expect(parseArgs(['check'])).toEqual({
      command: 'check',
      options: { dryRun: false, from: 'A', amount: 4_000_000n, claimFalse: false },
    })
    expect(parseArgs(['check', '--from', 'B', '--claim-false', '--dry-run'])).toEqual({
      command: 'check',
      options: { dryRun: true, from: 'B', amount: 4_000_000n, claimFalse: true },
    })
    expect(parseArgs(['check', '--from', 'B', '--omit', 'liquidity'])).toEqual({
      command: 'check',
      options: { dryRun: false, from: 'B', amount: 4_000_000n, claimFalse: false, omit: 'liquidity' },
    })
    expect(parseArgs(['execute', '--owner-sig'])).toEqual({
      command: 'execute',
      options: { dryRun: false, ownerSig: true, simulate: false },
    })
    expect(parseArgs(['execute', '--simulate'])).toEqual({
      command: 'execute',
      options: { dryRun: false, ownerSig: false, simulate: true },
    })
    expect(parseArgs(['receipt', '--save', '.demo/receipt-fail.json'])).toEqual({
      command: 'receipt',
      savePath: '.demo/receipt-fail.json',
    })
    expect(parseArgs(['seed', '--dry-run'])).toEqual({ command: 'seed', options: { dryRun: true } })
  })

  it('refuses a flag on the wrong command, a bad value, or a missing one, rather than ignoring it', () => {
    expect(() => parseArgs(['execute', '--claim-false'])).toThrow(/--claim-false is not a flag of execute/)
    expect(() => parseArgs(['check', '--simulate'])).toThrow(/--simulate is not a flag of check/)
    expect(() => parseArgs(['check', '--omit', 'rate'])).toThrow(/--omit takes liquidity/)
    expect(() => parseArgs(['check', '--from', 'C'])).toThrow(/--from takes A or B/)
    expect(() => parseArgs(['check', '--omit'])).toThrow(/--omit needs a value/)
    expect(() => parseArgs(['receipt'])).toThrow(/receipt needs --save PATH/)
    expect(() => parseArgs(['receipt', '--save', '--dry-run'])).toThrow(/--save needs a value/)
    expect(() => parseArgs(['check', 'liquidity'])).toThrow(/unexpected argument liquidity/)
    expect(() => parseArgs([])).toThrow(/unknown command/)
  })
})

describe('check --from B: the 5 USDC goes back from market B to market A', () => {
  it('withdraws from B and supplies the remainder to A, and the action agrees with the calldata', () => {
    const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: 10_009_000n, moveAtomic: MOVE_ATOMIC, from: 'B' })
    expect(fromTarget).toBe(5_009_000n)
    const decoded = decodeVaultCall(data)
    if (decoded.fn !== 'reallocate') throw new Error('unreachable')
    expect(decoded.allocations.map((a) => a.market)).toEqual([MARKET_B.id, MARKET_A.id])
    expect(decoded.allocations[1]!.assets).toBe(maxUint256)
    expect(checkAction(buildAction(fromTarget, 'B') as never, data).mismatches).toEqual([])
  })

  it('makes its claims about market A, the destination', async () => {
    const { body } = await buildCheckBody({
      observe: fakeObserve,
      fromCurrentAssets: 10_000_000n,
      head: HEAD,
      pinned: HEAD - 2n,
      nonce: 1n,
      from: 'B',
    })
    expect(body.claims.map((c) => [c.kind, (c as { market: string }).market])).toEqual([
      ['rate', MARKET_A.id],
      ['liquidity', MARKET_A.id],
    ])
    expect(body.claims[0]!.sourceSpan).toBe('market A pays more to supply than market B')
  })
})

describe('the three verdicts, through the Worker in process, the observer mocked', () => {
  const validator = privateKeyToAccount(generatePrivateKey())
  const agent = privateKeyToAccount(generatePrivateKey())

  async function verdictFor(options: { from: 'A' | 'B'; claimFalse?: boolean; omit?: 'liquidity' }) {
    const { body, observations } = await buildCheckBody({
      observe: fakeObserve,
      fromCurrentAssets: 10_000_000n,
      head: HEAD,
      pinned: HEAD - 2n,
      nonce: 42n,
      ...options,
    })
    const instance = createApp({
      facilitator: new FakeFacilitator(),
      payTo: PAY_TO,
      receipts: new MemoryStore(),
      mandates: MANDATES,
      checkDeps: () => checkDeps(validator, new FakeReader(), { vault: VAULT }),
    })
    const result = await payAndCheck({
      origin: 'https://api.test',
      body,
      signer: agent,
      fetchImpl: async (url, init) => instance.request(url, init),
    })
    expect(result.status).toBe(200)
    return { body, observations, response: result.body as CheckResponse }
  }

  it('PASS: the claims as read, A to B, registry response 100', async () => {
    const { response } = await verdictFor({ from: 'A' })
    expect(response.verdict.outcome).toBe('PASS')
    expect(response.signed.outcome).toBe(1)
    expect(response.receipt.registry?.response).toBe(100)
  })

  it('check --claim-false: the rate stated 5.0 pp above what was observed is FALSE, so FAIL, registry response 0', async () => {
    const { body, observations, response } = await verdictFor({ from: 'B', claimFalse: true })
    const observed = observations[0]!.kind === 'rate' ? observations[0]!.valuePct! : NaN
    const rate = body.claims[0] as Extract<ClaimV0, { kind: 'rate' }>
    expect(FALSE_RATE_OFFSET_PP).toBe(5)
    expect(rate.valuePct).toBe(Number((observed + 5).toFixed(4)))
    // Only the rate is wrong: the liquidity claim still holds.
    expect(body.claims.map((c) => compare(c, observations[body.claims.indexOf(c)]!).status)).toEqual(['FALSE', 'TRUE'])
    expect(response.verdict.outcome).toBe('FAIL')
    expect(response.signed.outcome).toBe(3)
    expect(response.verdict.failing).toMatchObject([{ id: 'r1', kind: 'rate', status: 'FALSE' }])
    expect(response.receipt.registry?.response).toBe(0)
  })

  it('check --omit liquidity: a rate claim alone misses a required kind, so WAIT, registry response 50', async () => {
    const { body, response } = await verdictFor({ from: 'B', omit: 'liquidity' })
    expect(body.claims.map((c) => c.kind)).toEqual(['rate'])
    expect(response.verdict.outcome).toBe('WAIT')
    expect(response.signed.outcome).toBe(2)
    expect(response.verdict.missingKinds).toEqual(['liquidity'])
    expect(response.verdict.failing).toEqual([])
    expect(response.receipt.registry?.response).toBe(50)
  })

  it('agrees with the engine rule directly: a missing required kind alone is WAIT, never FAIL', () => {
    const rateOnly = decide({
      results: [{ id: 'r1', kind: 'rate', status: 'TRUE', claimed: 1, observed: 1, block: 1n }] as never,
      requiredKinds: ['rate', 'liquidity'],
      actionMismatches: [],
      mandateViolations: [],
    })
    expect(rateOnly.outcome).toBe('WAIT')
    expect(rateOnly.missingKinds).toEqual(['liquidity'])
  })
})

describe('the v1 gate, as deployed', () => {
  it('rebuilds the intent hash of the first live PASS under domain version 1, and accepts that verdict', () => {
    expect(intentHashOf(FIRST_PASS)).toBe(FIRST_PASS.signed.intentHash)
    expect(verdictMatchesIntent(FIRST_PASS)).toBeNull()
  })

  it('refuses a verdict signed for another domain version, which the v1 gate would reject', () => {
    const v2 = { ...FIRST_PASS, signed: { ...FIRST_PASS.signed, domain: { ...FIRST_PASS.signed.domain, version: '2' } } }
    expect(verdictMatchesIntent(v2)).toMatch(/domain version 2; the deployed gate is version 1/)
  })

  it('calls execute with the nine flat arguments of the deployed ABI, ownerSig last', () => {
    expect(toFunctionSelector(gateAbi.find((x) => x.type === 'function' && x.name === 'execute')!)).toBe(
      toFunctionSelector(
        'execute(bytes,bytes32,uint256,uint64,uint8,uint64,bytes32,bytes,bytes)',
      ),
    )
    const args = executeArgs(FIRST_PASS, '0xabcd')
    expect(args).toHaveLength(9)
    expect(args[4]).toBe(1)
    expect(args[5]).toBe(107_991_649n)
    expect(args[8]).toBe('0xabcd')
    expect(executeArgs(FIRST_PASS)[8]).toBe('0x')
  })
})

describe('execute --owner-sig', () => {
  it('signs Override(intentHash) the way ReasonGate recomputes it, and it recovers to the owner', async () => {
    const owner = privateKeyToAccount(generatePrivateKey())
    const intentHash = FIRST_PASS.signed.intentHash
    const signature = await signOverride(owner, intentHash)
    // The gate's own arithmetic, written out from the Solidity: OVERRIDE_TYPEHASH, the v1 domain
    // separator of OpenZeppelin EIP712, then _hashTypedDataV4.
    const typeHash = keccak256(stringToBytes('Override(bytes32 intentHash)'))
    const domainTypeHash = keccak256(
      stringToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    )
    const separator = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [domainTypeHash, keccak256(stringToBytes('Proof of Reason')), keccak256(stringToBytes('1')), 143n, GATE],
      ),
    )
    const structHash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [typeHash, intentHash]))
    const digest = keccak256(concat(['0x1901', separator, structHash]))
    expect(await recoverAddress({ hash: digest, signature })).toBe(owner.address)
    expect(gateDomainV1()).toEqual({ name: 'Proof of Reason', version: '1', chainId: 143, verifyingContract: GATE })
  })

  it('is what execute needs for a WAIT, and is refused where it means nothing', () => {
    expect(executeRefusal('WAIT', { ownerSig: false, simulate: false })).toMatch(/Add --owner-sig/)
    expect(executeRefusal('WAIT', { ownerSig: true, simulate: false })).toBeNull()
    expect(executeRefusal('PASS', { ownerSig: false, simulate: false })).toBeNull()
    expect(executeRefusal('PASS', { ownerSig: true, simulate: false })).toMatch(/needs no owner signature/)
    expect(executeRefusal('FAIL', { ownerSig: true, simulate: false })).toMatch(/revert Refuted/)
  })
})

describe('what check says about the gate, per verdict', () => {
  it('PASS: accepted until checkedAtBlock plus maxAge, and execute now', () => {
    const lines = verdictWindowLines('PASS', 107_991_649n, 60n)
    expect(lines.gate).toBe('the gate accepts this verdict until block 107991709, 60 blocks after the check')
    expect(lines.saved).toBe('saved to .demo/last-check.json. Run execute now: the window is 60 blocks.')
  })

  it('WAIT: the same window wording as PASS', () => {
    const lines = verdictWindowLines('WAIT', 107_991_649n, 60n)
    expect(lines.gate).toBe('the gate accepts this verdict until block 107991709, 60 blocks after the check')
    expect(lines.saved).toBe('saved to .demo/last-check.json. Run execute now: the window is 60 blocks.')
  })

  it('FAIL: the gate will refuse it, and there is no window and no call to execute', () => {
    const lines = verdictWindowLines('FAIL', 107_991_649n, 60n)
    expect(lines.gate).toBe('the gate will refuse this verdict')
    expect(lines.gate).not.toMatch(/accepts/)
    expect(lines.saved).toBe('saved to .demo/last-check.json.')
    expect(lines.saved).not.toMatch(/Run execute now/)
  })
})

describe('execute --simulate', () => {
  const FAIL_CHECK: SavedCheck = {
    ...FIRST_PASS,
    outcome: 'FAIL',
    signed: { ...FIRST_PASS.signed, outcome: 3 },
  }

  /** A node that answers eth_call with a revert carrying `data`, or with empty success. */
  function clientReverting(data: Hex | null) {
    const calls: { method: string; params: unknown }[] = []
    const client = createPublicClient({
      chain: monad,
      transport: custom({
        async request({ method, params }) {
          calls.push({ method, params })
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
          if (data === null) return '0x'
          throw Object.assign(new Error('execution reverted'), { code: 3, data })
        },
      }, { retryCount: 0 }),
    })
    return { client, calls }
  }

  it('is the only way execute goes near a FAIL', () => {
    expect(executeRefusal('FAIL', { ownerSig: false, simulate: false })).toMatch(/Add --simulate/)
    expect(executeRefusal('FAIL', { ownerSig: false, simulate: true })).toBeNull()
  })

  it('decodes Refuted from the gate by name, from an eth_call sent as the agent, and sends nothing', async () => {
    const revert = encodeErrorResult({
      abi: gateAbi,
      errorName: 'Refuted',
      args: [FAIL_CHECK.signed.intentHash, FAIL_CHECK.signed.receiptHash],
    })
    const { client, calls } = clientReverting(revert)
    const result = await simulateExecute(client, FAIL_CHECK)
    expect(result).toMatchObject({ reverted: true, errorName: 'Refuted' })
    if (!result.reverted) throw new Error('unreachable')
    expect(result.text).toBe(`Refuted(${FAIL_CHECK.signed.intentHash}, ${FAIL_CHECK.signed.receiptHash})`)
    expect(calls.map((c) => c.method)).toEqual(['eth_call'])
    const [tx] = calls[0]!.params as [{ from: string; to: string; data: Hex }]
    expect(tx.from.toLowerCase()).toBe(AGENT.toLowerCase())
    expect(tx.to.toLowerCase()).toBe(GATE.toLowerCase())
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector('execute(bytes,bytes32,uint256,uint64,uint8,uint64,bytes32,bytes,bytes)'))
  })

  it('names any other gate error too, so a stale verdict is not mistaken for a refusal', async () => {
    const revert = encodeErrorResult({ abi: gateAbi, errorName: 'VerdictTooOld', args: [1n, 100n, 60n] })
    const result = await simulateExecute(clientReverting(revert).client, FAIL_CHECK)
    expect(result).toMatchObject({ reverted: true, errorName: 'VerdictTooOld', text: 'VerdictTooOld(1, 100, 60)' })
  })

  it('reports a call the gate would accept without sending it', async () => {
    expect(await simulateExecute(clientReverting(null).client, FIRST_PASS)).toEqual({ reverted: false })
  })
})

describe('receipt --save', () => {
  /** Deliberately not canonical: key order, spacing and a trailing newline must all survive. */
  const SERVED = '{"verdict":{"outcome":"FAIL"},  "claims":[],\n"registry":{"response":0}}\n'

  it('fetches the receipt of the last check from the live path and writes the served bytes, verbatim', async () => {
    const seen: string[] = []
    const { url, bytes } = await fetchReceipt({
      intentHash: FIRST_PASS.signed.intentHash,
      fetchImpl: async (u) => {
        seen.push(u)
        return new Response(SERVED, { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    expect(seen).toEqual([`https://api.proofofreason.com/receipts/${FIRST_PASS.signed.intentHash}`])
    expect(url).toBe(FIRST_PASS.receiptUrl)
    const path = join(mkdtempSync(join(tmpdir(), 'demo-receipt-')), 'takes', 'receipt-fail.json')
    writeReceipt(path, bytes)
    expect(readFileSync(path, 'utf8')).toBe(SERVED)
  })

  it('writes nothing when the API does not serve the receipt', async () => {
    await expect(
      fetchReceipt({ intentHash: FIRST_PASS.signed.intentHash, fetchImpl: async () => new Response('{"error":"not found"}', { status: 404 }) }),
    ).rejects.toThrow(/answered 404/)
    expect(existsSync(join(tmpdir(), 'never-written.json'))).toBe(false)
  })
})

// ------------------------------------------------------------------ amount and preflight

import {
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  toHex,
} from 'viem'
import { vaultAbi } from 'proof-of-reason-engine/action'
import {
  DEFAULT_MOVE_ATOMIC,
  MARKET_CAP_ATOMIC,
  MORPHO,
  check,
  describeRevert,
  labelMarket,
  metaMorphoErrorsAbi,
  parseUsdc,
  preflightReallocate,
  usdcShort,
} from '../demo-check.ts'
import type { CheckDeps } from '../demo-check.ts'

/** What the vault held in each market on 29 Sep 2026, in USDC atomic units. */
const HELD = { [MARKET_A.id]: 5_005_027n, [MARKET_B.id]: 5_004_221n } as Record<string, bigint>

const mockReads = parseAbi([
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function totalAssets() view returns (uint256)',
  'function maxAgeBlocks() view returns (uint64)',
])

/** 1e6 shares per asset and a market of 2e12 assets, so toAssetsDown gives HELD back exactly. */
const MARKET_TOTAL = 2_000_000_000_000n

/**
 * MetaMorphoV1_1.reallocate, reduced to what the demo can hit: allocations in order, a withdrawal
 * when the target is below what is held, a supply otherwise, maxUint256 supplies what was withdrawn
 * and not yet supplied, and a supply that takes a market over its cap reverts SupplyCapExceeded(id).
 * Only the allocator may call it.
 */
function vaultReallocate(from: string, data: Hex): Hex | { revert: Hex } {
  if (from.toLowerCase() !== GATE.toLowerCase()) {
    return { revert: encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'NotAllocatorRole' }) }
  }
  const { args } = decodeFunctionData({ abi: vaultAbi, data })
  let withdrawn = 0n
  let supplied = 0n
  for (const allocation of (args as unknown as [{ marketParams: never; assets: bigint }[]])[0]) {
    const id = marketId(allocation.marketParams)
    const held = HELD[id]!
    if (allocation.assets < held) {
      withdrawn += held - allocation.assets
      continue
    }
    const add = allocation.assets === maxUint256 ? withdrawn - supplied : allocation.assets - held
    if (held + add > MARKET_CAP_ATOMIC) {
      return { revert: encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'SupplyCapExceeded', args: [id] }) }
    }
    supplied += add
  }
  if (withdrawn !== supplied) {
    return { revert: encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'InconsistentReallocation' }) }
  }
  return '0x'
}

/** The RPC, mocked: Morpho reads, the vault, and the gate's maxAgeBlocks. Records every eth_call. */
function mockChain() {
  const calls: { from?: string; to: string; data: Hex }[] = []
  const client = createPublicClient({
    chain: monad,
    transport: custom(
      {
        async request({ method, params }) {
          if (method === 'eth_blockNumber') return toHex(HEAD)
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
          const [tx] = params as [{ from?: string; to: string; data: Hex }]
          calls.push(tx)
          const to = tx.to.toLowerCase()
          if (to === VAULT.toLowerCase() && tx.data.startsWith('0x7299aa31')) {
            const result = vaultReallocate(tx.from ?? '0x0000000000000000000000000000000000000000', tx.data)
            if (typeof result === 'string') return result
            throw Object.assign(new Error('execution reverted'), { code: 3, data: result.revert })
          }
          const call = decodeFunctionData({ abi: mockReads, data: tx.data })
          if (call.functionName === 'position') {
            const id = (call.args as readonly unknown[])[0] as Hex
            return encodeFunctionResult({ abi: mockReads, functionName: 'position', result: [HELD[id]! * 1_000_000n, 0n, 0n] })
          }
          if (call.functionName === 'market') {
            return encodeFunctionResult({
              abi: mockReads,
              functionName: 'market',
              result: [MARKET_TOTAL, MARKET_TOTAL * 1_000_000n, 0n, 0n, 0n, 0n],
            })
          }
          if (call.functionName === 'totalAssets') {
            return encodeFunctionResult({ abi: mockReads, functionName: 'totalAssets', result: HELD[MARKET_A.id]! + HELD[MARKET_B.id]! })
          }
          return encodeFunctionResult({ abi: mockReads, functionName: 'maxAgeBlocks', result: 60n })
        },
      },
      { retryCount: 0 },
    ),
  })
  return { client, calls }
}

function reallocateData(from: 'A' | 'B', moveAtomic: bigint): Hex {
  return buildReallocateData({ fromCurrentAssets: HELD[(from === 'A' ? MARKET_A : MARKET_B).id]!, moveAtomic, from }).data
}

describe('check --amount', () => {
  it('reads a USDC amount to atomic units, exactly, and refuses what it cannot read exactly', () => {
    expect(parseUsdc('4')).toBe(4_000_000n)
    expect(parseUsdc('5.000000')).toBe(5_000_000n)
    expect(parseUsdc('4.5')).toBe(4_500_000n)
    expect(parseUsdc('0.000001')).toBe(1n)
    for (const bad of ['0', '0.0', '-1', '1.0000001', '4 USDC', 'four', '.5', '']) {
      expect(() => parseUsdc(bad), bad).toThrow(/--amount/)
    }
  })

  it('defaults to 4 USDC and parses the flag', () => {
    expect(DEFAULT_MOVE_ATOMIC).toBe(4_000_000n)
    const parsed = parseArgs(['check', '--from', 'B', '--amount', '4.5'])
    expect(parsed).toMatchObject({ command: 'check', options: { from: 'B', amount: 4_500_000n } })
    expect(() => parseArgs(['execute', '--amount', '4'])).toThrow(/--amount is not a flag of execute/)
    expect(() => parseArgs(['check', '--amount'])).toThrow(/--amount needs a value/)
  })

  it('moves the amount: the source targets what it holds minus the amount, and the claim text says it', async () => {
    const { body, fromTarget } = await buildCheckBody({
      observe: fakeObserve,
      fromCurrentAssets: HELD[MARKET_B.id]!,
      head: HEAD,
      pinned: HEAD - 2n,
      nonce: 1n,
      from: 'B',
    })
    expect(fromTarget).toBe(1_004_221n)
    expect(body.action.allocations[0]).toEqual({ market: MARKET_B.id, assets: '1004221' })
    expect(body.claims[1]!.sourceSpan).toBe('market A can return the 4 USDC on demand')
    const custom45 = await buildCheckBody({
      observe: fakeObserve,
      fromCurrentAssets: HELD[MARKET_A.id]!,
      head: HEAD,
      pinned: HEAD - 2n,
      nonce: 1n,
      moveAtomic: 4_500_000n,
    })
    expect(custom45.fromTarget).toBe(505_027n)
    expect(custom45.body.claims[1]!.sourceSpan).toBe('market B can return the 4.5 USDC on demand')
    expect(usdcShort(5_000_000n)).toBe('5 USDC')
    expect(usdcShort(1n)).toBe('0.000001 USDC')
  })
})

describe('the free preflight, the RPC mocked with the vault caps', () => {
  it('refuses exactly 5.000000 USDC into either market with SupplyCapExceeded, the market named', async () => {
    const { client, calls } = mockChain()
    expect(await preflightReallocate(client, reallocateData('A', 5_000_000n))).toEqual({
      ok: false,
      reason: `SupplyCapExceeded(market B ${MARKET_B.id})`,
    })
    expect(await preflightReallocate(client, reallocateData('B', 5_000_000n))).toEqual({
      ok: false,
      reason: `SupplyCapExceeded(market A ${MARKET_A.id})`,
    })
    // Asked of the vault, as the gate: the allocator the vault will see when the gate forwards it.
    for (const call of calls) {
      expect(call.to.toLowerCase()).toBe(VAULT.toLowerCase())
      expect(call.from?.toLowerCase()).toBe(GATE.toLowerCase())
    }
  })

  it('accepts 4 USDC in both directions', async () => {
    const { client } = mockChain()
    expect(await preflightReallocate(client, reallocateData('A', 4_000_000n))).toEqual({ ok: true })
    expect(await preflightReallocate(client, reallocateData('B', 4_000_000n))).toEqual({ ok: true })
  })

  it('refuses at the cap, not at a round number: 4.995779 USDC into B fits, 4.995780 does not', async () => {
    const { client } = mockChain()
    // Market B holds 5.004221, so it takes at most 4.995779 more.
    expect(await preflightReallocate(client, reallocateData('A', 4_995_779n))).toEqual({ ok: true })
    expect(await preflightReallocate(client, reallocateData('A', 4_995_780n))).toMatchObject({ ok: false })
  })

  it('names every MetaMorpho error the script lists, labels a market A or B, and prints an unknown selector raw', () => {
    const id = MARKET_A.id
    expect(describeRevert(encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'SupplyCapExceeded', args: [MARKET_B.id] }))).toBe(
      `SupplyCapExceeded(market B ${MARKET_B.id})`,
    )
    expect(describeRevert(encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'MarketNotEnabled', args: [id] }))).toBe(
      `MarketNotEnabled(market A ${id})`,
    )
    expect(describeRevert(encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'UnauthorizedMarket', args: [`0x${'77'.repeat(32)}`] }))).toBe(
      `UnauthorizedMarket(0x${'77'.repeat(32)})`,
    )
    for (const errorName of ['AllCapsReached', 'InconsistentReallocation', 'NotEnoughLiquidity', 'NotAllocatorRole'] as const) {
      expect(describeRevert(encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName }))).toBe(`${errorName}()`)
    }
    // Morpho Blue reverts with strings.
    expect(describeRevert(encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['insufficient liquidity'] }))).toBe(
      'Error(insufficient liquidity)',
    )
    expect(describeRevert('0xdeadbeef00000000')).toBe('an unknown error, selector 0xdeadbeef')
    expect(describeRevert('0x')).toBe('a revert with no error data (0x)')
    expect(labelMarket(MARKET_B.id.toUpperCase().replace('0X', '0x'))).toMatch(/^market B /)
  })

  it('selectors match the ones MetaMorpho emits, SupplyCapExceeded among them', () => {
    expect(toFunctionSelector('SupplyCapExceeded(bytes32)')).toBe('0x5e25afa5')
    expect(encodeErrorResult({ abi: metaMorphoErrorsAbi, errorName: 'SupplyCapExceeded', args: [MARKET_A.id] }).slice(0, 10)).toBe('0x5e25afa5')
  })
})

describe('check, end to end with the observer, the RPC and the payment mocked', () => {
  function deps(chain: ReturnType<typeof mockChain>) {
    const pay = vi.fn(async () => ({ status: 500, body: { error: 'stopped by the test' }, paid: false }))
    const loadAgent = vi.fn(() => privateKeyToAccount(generatePrivateKey()))
    const d: CheckDeps = { client: chain.client, observe: fakeObserve, loadAgent, pay: pay as never, now: () => 7n }
    return { d, pay, loadAgent }
  }
  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {})

  it('at 5.000000 USDC stops at the preflight with SupplyCapExceeded: no key read, no payment', async () => {
    const log = quiet()
    for (const from of ['A', 'B'] as const) {
      const chain = mockChain()
      const { d, pay, loadAgent } = deps(chain)
      await expect(check({ dryRun: false, from, amount: 5_000_000n, claimFalse: false }, d)).rejects.toThrow(
        new RegExp(`preflight: the vault would revert SupplyCapExceeded\\(market ${from === 'A' ? 'B' : 'A'} 0x[0-9a-f]{64}\\).*No payment made`),
      )
      expect(loadAgent).not.toHaveBeenCalled()
      expect(pay).not.toHaveBeenCalled()
    }
    log.mockRestore()
  })

  it('a dry run is preflighted too, so a rehearsal shows the refusal', async () => {
    const log = quiet()
    const { d } = deps(mockChain())
    await expect(check({ dryRun: true, from: 'B', amount: 5_000_000n, claimFalse: true }, d)).rejects.toThrow(/SupplyCapExceeded\(market A/)
    await expect(check({ dryRun: true, from: 'B', amount: 4_000_000n, claimFalse: true }, d)).resolves.toBeUndefined()
    expect(log.mock.calls.flat().join('\n')).toContain('preflight: the vault accepts this reallocate from the gate')
    log.mockRestore()
  })

  it('at the 4 USDC default passes the preflight and only then pays, for the intent it preflighted', async () => {
    const log = quiet()
    const chain = mockChain()
    const { d, pay, loadAgent } = deps(chain)
    await expect(check({ dryRun: false, from: 'A', amount: DEFAULT_MOVE_ATOMIC, claimFalse: false }, d)).rejects.toThrow(
      /POST \/check answered 500/,
    )
    expect(loadAgent).toHaveBeenCalledTimes(1)
    expect(pay).toHaveBeenCalledTimes(1)
    const body = (pay.mock.calls[0] as unknown as [CheckBody])[0]
    expect(body.action.allocations).toEqual([
      { market: MARKET_A.id, assets: '1005027' },
      { market: MARKET_B.id, assets: maxUint256.toString() },
    ])
    const preflighted = chain.calls.filter((c) => c.to.toLowerCase() === VAULT.toLowerCase() && c.data.startsWith('0x7299aa31'))
    expect(preflighted.map((c) => c.data)).toEqual([body.intent.data])
    expect(chain.calls.some((c) => c.to.toLowerCase() === MORPHO.toLowerCase())).toBe(true)
    log.mockRestore()
  })
})
