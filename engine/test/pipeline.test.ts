import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, recoverTypedDataAddress } from 'viem'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ActionV0, ClaimV0, MandateV0 } from '../src/claims.ts'
import { checkAction, vaultAbi } from '../src/action.ts'
import { checkMandate } from '../src/mandate.ts'
import { observeAll } from '../src/morpho.ts'
import { compare } from '../src/compare.ts'
import { OUTCOME_CODE, decide } from '../src/verdict.ts'
import { buildReceipt, receiptHash } from '../src/receipt.ts'
import { gateDomain, signVerdict, verdictTypes } from '../src/sign.ts'
import { ADAPTER, FakeReader, FIXTURE_ID, FIXTURE_PARAMS, PINNED_BLOCK } from './fixtures.ts'

const TEST_KEY = `0x${(0xb0bn).toString(16).padStart(64, '0')}` as const
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
    50_000_000_000n,
  ],
})

const action: ActionV0 = { fn: 'allocate', adapter: ADAPTER, market: FIXTURE_ID, assets: '50000000000' }
const mandate: MandateV0 = { allowedMarkets: [FIXTURE_ID], requiredKinds: ['rate', 'liquidity'] }

async function run(claims: ClaimV0[], stated: ActionV0 = action) {
  const reader = new FakeReader()
  const observations = await observeAll(reader, claims, PINNED_BLOCK)
  const results = claims.map((c, i) => compare(c, observations[i]!))
  const actionCheck = checkAction(stated, data)
  const verdict = decide({
    results,
    actionMismatches: actionCheck.mismatches,
    mandateViolations: checkMandate(actionCheck.decoded, mandate),
    requiredKinds: mandate.requiredKinds,
  })
  const receipt = buildReceipt({
    chainId: 31337,
    gate: GATE,
    vault: VAULT,
    data,
    nonce: 1n,
    notAfterBlock: PINNED_BLOCK + 10n,
    claims,
    action: stated,
    mandate,
    observations,
    results,
    verdict,
    checkedAtBlock: PINNED_BLOCK,
    modelId: null,
  })
  return { verdict, receipt }
}

const supplyApy: ClaimV0 = {
  id: 'r1',
  kind: 'rate',
  sourceSpan: null,
  market: FIXTURE_ID,
  side: 'supply',
  valuePct: 2.3,
  basis: 'APY',
  compounding: 'continuous',
  window: { type: 'instant' },
  tolerancePp: 0.01,
}
const liquidity: ClaimV0 = {
  id: 'l1',
  kind: 'liquidity',
  sourceSpan: null,
  market: FIXTURE_ID,
  minWithdrawable: '150000000000',
}

describe('pipeline on the fixture market', () => {
  it('true premises and a matching action PASS, and the verdict signs and recovers', async () => {
    const { verdict, receipt } = await run([supplyApy, liquidity])
    expect(verdict.outcome).toBe('PASS')

    const account = privateKeyToAccount(TEST_KEY)
    const domain = gateDomain(31337, GATE)
    const message = {
      intentHash: receipt.intent.intentHash,
      outcome: OUTCOME_CODE[verdict.outcome],
      checkedAtBlock: PINNED_BLOCK,
      receiptHash: receiptHash(receipt),
    }
    const signature = await signVerdict(account, domain, message)
    const recovered = await recoverTypedDataAddress({
      domain,
      types: verdictTypes,
      primaryType: 'Verdict',
      message,
      signature,
    })
    expect(recovered).toBe(account.address)
  })

  it('a stale rate premise FAILs with the claimed and observed values', async () => {
    const { verdict } = await run([{ ...supplyApy, valuePct: 5 }, liquidity])
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failing).toHaveLength(1)
    expect(verdict.failing[0]).toMatchObject({ source: 'claim', id: 'r1', status: 'FALSE', claimed: 5, block: PINNED_BLOCK })
  })

  it('a missing required kind WAITs', async () => {
    const { verdict } = await run([supplyApy])
    expect(verdict.outcome).toBe('WAIT')
    expect(verdict.missingKinds).toEqual(['liquidity'])
  })

  it('an amount that differs from the calldata FAILs', async () => {
    const { verdict } = await run([supplyApy, liquidity], { ...action, assets: '5000000000' })
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failing[0]).toMatchObject({ source: 'action', field: 'assets' })
  })
})
