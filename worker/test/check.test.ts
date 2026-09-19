import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, recoverTypedDataAddress, stringToBytes } from 'viem'
import { receiptHash } from 'proof-of-reason-engine/receipt'
import { verdictTypes } from 'proof-of-reason-engine/sign'
import { CheckRequestV0 } from '../src/body.ts'
import { HttpError, runCheck } from '../src/check.ts'
import { CHECK_LAG_BLOCKS } from '../src/config.ts'
import { MANDATES, MARKET_A, MARKET_B } from '../src/mandates.ts'
import { FakeReader, GATE, HEAD, checkBody, checkDeps } from './helpers.ts'

const account = privateKeyToAccount(generatePrivateKey())
const mandate = MANDATES['demo-usdc-v1']!

function request(overrides: Record<string, unknown> = {}) {
  return CheckRequestV0.parse(checkBody(overrides))
}

describe('runCheck', () => {
  it('PASS: true premises, matching calldata, allowed markets; the Verdict signature recovers', async () => {
    const result = await runCheck(request(), mandate, checkDeps(account))
    expect(result.verdict.outcome).toBe('PASS')
    expect(result.signed.outcome).toBe(1)
    expect(result.signed.checkedAtBlock).toBe(HEAD - CHECK_LAG_BLOCKS)
    expect(result.signed.receiptHash).toBe(receiptHash(result.receipt))
    expect(result.signed.receiptHash).toBe(keccak256(stringToBytes(result.receiptJson)))
    expect(result.signed.domain).toEqual({ name: 'Proof of Reason', version: '1', chainId: 143, verifyingContract: GATE })
    const recovered = await recoverTypedDataAddress({
      domain: result.signed.domain,
      types: verdictTypes,
      primaryType: 'Verdict',
      message: {
        intentHash: result.signed.intentHash,
        outcome: result.signed.outcome,
        checkedAtBlock: result.signed.checkedAtBlock,
        receiptHash: result.signed.receiptHash,
      },
      signature: result.signed.signature,
    })
    expect(recovered).toBe(account.address)
    expect(result.signed.validator).toBe(account.address)
  })

  it('FAIL: a stale rate premise is still signed, with outcome 3 and the failing item', async () => {
    const body = checkBody()
    const claims = [{ ...body.claims[0]!, valuePct: 7.5 }, body.claims[1]!]
    const result = await runCheck(request({ claims }), mandate, checkDeps(account))
    expect(result.verdict.outcome).toBe('FAIL')
    expect(result.signed.outcome).toBe(3)
    expect(result.verdict.failing[0]).toMatchObject({ source: 'claim', id: 'r1', status: 'FALSE', claimed: 7.5 })
  })

  it('WAIT: a missing required kind', async () => {
    const body = checkBody()
    const result = await runCheck(request({ claims: [body.claims[0]!] }), mandate, checkDeps(account))
    expect(result.verdict.outcome).toBe('WAIT')
    expect(result.verdict.missingKinds).toEqual(['liquidity'])
  })

  it('FAIL: the stated action does not match the calldata', async () => {
    const action = {
      fn: 'reallocate',
      allocations: [
        { market: MARKET_A, assets: '1' },
        { market: MARKET_B, assets: (2n ** 256n - 1n).toString() },
      ],
    }
    const result = await runCheck(request({ action }), mandate, checkDeps(account))
    expect(result.verdict.outcome).toBe('FAIL')
    expect(result.verdict.failing).toContainEqual(
      expect.objectContaining({ source: 'action', field: 'allocations.0.assets' }),
    )
  })

  it('a mandate with zero required kinds carries the premise-check-disabled notice', async () => {
    const open = { allowedMarkets: mandate.allowedMarkets, requiredKinds: [] }
    const result = await runCheck(request({ claims: [] }), open, checkDeps(account))
    expect(result.verdict.outcome).toBe('PASS')
    expect(result.receipt.notices).toEqual(['premise check disabled by mandate'])
    expect(result.receiptJson).toContain('premise check disabled by mandate')
  })

  it('reads every window at the pinned block, head minus the declared lag', async () => {
    const reader = new FakeReader()
    await runCheck(request(), mandate, checkDeps(account, reader))
    const blocks = reader.calls.map((c) => c.block)
    expect(blocks.every((b) => b <= HEAD - CHECK_LAG_BLOCKS && b > HEAD - CHECK_LAG_BLOCKS - 5n)).toBe(true)
  })

  it('refuses another vault, prose, and an unreachable chain', async () => {
    await expect(
      runCheck(request({ intent: { ...checkBody().intent, vault: GATE } }), mandate, checkDeps(account)),
    ).rejects.toMatchObject({ status: 400 })
    const prose = CheckRequestV0.parse({ ...checkBody(), claims: undefined, prose: 'rates are better on B' })
    await expect(runCheck(prose, mandate, checkDeps(account))).rejects.toMatchObject({ status: 422 })
    const reader = new FakeReader()
    reader.fail = true
    const error = await runCheck(request(), mandate, checkDeps(account, reader)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 503, message: 'chain state unavailable' })
  })
})

describe('CheckRequestV0', () => {
  it('requires exactly one of claims or prose', () => {
    expect(CheckRequestV0.safeParse({ ...checkBody(), prose: 'x' }).success).toBe(false)
    expect(CheckRequestV0.safeParse({ ...checkBody(), claims: undefined }).success).toBe(false)
  })

  it('rejects unknown fields, bad calldata, and an out-of-range notAfterBlock', () => {
    expect(CheckRequestV0.safeParse({ ...checkBody(), extra: 1 }).success).toBe(false)
    const intent = checkBody().intent
    expect(CheckRequestV0.safeParse(checkBody({ intent: { ...intent, data: '0x1' } })).success).toBe(false)
    expect(
      CheckRequestV0.safeParse(checkBody({ intent: { ...intent, notAfterBlock: (2n ** 64n).toString() } })).success,
    ).toBe(false)
  })
})
