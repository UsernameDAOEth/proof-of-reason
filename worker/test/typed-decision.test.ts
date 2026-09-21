import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { createApp } from '../src/app.ts'
import { CHECK_LAG_BLOCKS, NETWORK } from '../src/config.ts'
import { MANDATES } from '../src/mandates.ts'
import {
  FakeFacilitator,
  FakeKuruReader,
  HEAD,
  JEV_MANDATES,
  KURU_GATE,
  KURU_MARKET,
  MemoryStore,
  PAY_TO,
  batchUpdateData,
  checkBody,
  checkDeps,
  typedDecisionBody,
} from './helpers.ts'

const validator = privateKeyToAccount(generatePrivateKey())
const payer = privateKeyToAccount(generatePrivateKey())

/** A typed-decision deployment serves one venue as its vault and one KuruGate. */
function setup(kuru = new FakeKuruReader()) {
  const facilitator = new FakeFacilitator()
  const receipts = new MemoryStore()
  const app = createApp({
    facilitator,
    payTo: PAY_TO,
    receipts,
    mandates: JEV_MANDATES,
    checkDeps: () => checkDeps(validator, undefined, { kuru, gate: KURU_GATE, vault: KURU_MARKET }),
  })
  return { app, facilitator, receipts, kuru }
}

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/check', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function payerClient() {
  const client = new x402Client()
  registerExactEvmScheme(client, { signer: payer, networks: [NETWORK] })
  return new x402HTTPClient(client)
}

/** 402 challenge, then a real x402 v2 exact payment: the same flow as a Morpho check. */
async function paidPost(app: ReturnType<typeof createApp>, body: unknown) {
  const challenge = await post(app, body)
  expect(challenge.status).toBe(402)
  const http = payerClient()
  const required = http.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json())
  const payload = await http.createPaymentPayload(required)
  return post(app, body, http.encodePaymentSignatureHeader(payload))
}

const PINNED = HEAD - CHECK_LAG_BLOCKS

describe('POST /check under a typed-decision mandate', () => {
  it('passes a truthful book, answer and position, and records the model id the adapter reported', async () => {
    const { app, facilitator, kuru } = setup()
    const res = await paidPost(app, typedDecisionBody())
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(facilitator.calls).toEqual(['supported', 'verify', 'settle'])
    expect(body.verdict.outcome).toBe('PASS')
    expect(body.verdict.failing).toEqual([])
    expect(body.signed.outcome).toBe(1)
    expect(body.receipt.modelId).toBe('MrJev v0.1.0 (jev-trader b587759)')
    expect(body.receipt.mandate.type).toBe('typed-decision')
    expect(body.receipt.results.map((r: any) => [r.kind, r.status])).toEqual([
      ['kuru_book', 'TRUE'],
      ['decision', 'TRUE'],
      ['position', 'TRUE'],
    ])
    // The gate signs over this block, and every read was pinned to it.
    expect(body.signed.checkedAtBlock).toBe(PINNED.toString())
    expect(kuru.calls.every((call) => call.endsWith(`@${PINNED}`))).toBe(true)
  })

  it('returns the same receipt shape as a Morpho check, and the same signed Verdict fields', async () => {
    const typed = await paidPost(setup().app, typedDecisionBody())
    const morpho = createApp({
      facilitator: new FakeFacilitator(),
      payTo: PAY_TO,
      receipts: new MemoryStore(),
      mandates: MANDATES,
      checkDeps: () => checkDeps(validator),
    })
    const plain = await paidPost(morpho, checkBody())
    const typedBody = (await typed.json()) as any
    const plainBody = (await plain.json()) as any
    expect(Object.keys(typedBody)).toEqual(Object.keys(plainBody))
    expect(Object.keys(typedBody.receipt)).toEqual(Object.keys(plainBody.receipt))
    expect(Object.keys(typedBody.receipt.intent)).toEqual(Object.keys(plainBody.receipt.intent))
    expect(Object.keys(typedBody.receipt.verdict)).toEqual(Object.keys(plainBody.receipt.verdict))
    expect(Object.keys(typedBody.signed)).toEqual(Object.keys(plainBody.signed))
    expect(typedBody.receipt.ruleset).toBe(plainBody.receipt.ruleset)
  })

  it('reads Kuru one call at a time, in claim order, never batched', async () => {
    const { app, kuru } = setup()
    await paidPost(app, typedDecisionBody())
    expect(kuru.calls).toEqual([
      // kuru_book: parameters, then the top of book, then the depth
      `marketParams@${PINNED}`,
      `bestBidAsk@${PINNED}`,
      `l2Book@${PINNED}`,
      // decision: no chain read
      // position: parameters, the price, then the gate's base balance
      `marketParams@${PINNED}`,
      `bestBidAsk@${PINNED}`,
      `nativeBalance@${PINNED}`,
    ])
  })

  it('stores the receipt and serves the same bytes from GET /receipts/:intentHash', async () => {
    const { app, receipts } = setup()
    const res = await paidPost(app, typedDecisionBody())
    const body = (await res.json()) as any
    const stored = receipts.map.get(body.signed.intentHash)
    expect(stored).toBeTruthy()
    const fetched = await app.request(`/receipts/${body.signed.intentHash}`)
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe(stored)
  })

  it('records modelId null when the adapter reports no version', async () => {
    const { app } = setup()
    const withoutModel = typedDecisionBody()
    delete (withoutModel as Record<string, unknown>).model
    const res = await paidPost(app, withoutModel)
    const body = (await res.json()) as any
    expect(body.receipt.modelId).toBe(null)
    expect(body.verdict.outcome).toBe('PASS')
  })
})

describe('the three MrJev failure modes, seen by the validator', () => {
  it('an answer outside the allowed set waits: unverifiable, never defaulted to a side', async () => {
    const { app } = setup()
    const claims = typedDecisionBody().claims as Record<string, unknown>[]
    claims[1] = { ...claims[1], answer: 'SHORT' } // upstream answers buy or sell, never this
    const res = await paidPost(app, typedDecisionBody({ claims }))
    const body = (await res.json()) as any
    expect(body.verdict.outcome).toBe('WAIT')
    expect(body.signed.outcome).toBe(2)
    const item = body.verdict.failing.find((f: any) => f.kind === 'decision')
    expect(item.status).toBe('UNVERIFIABLE')
    expect(JSON.stringify(body.verdict.failing)).toContain('SHORT')
    // No side was inferred for it.
    expect(body.receipt.observations[1].recognised).toBe(false)
    expect(body.receipt.observations[1].answer).toBe('SHORT')
  })

  it('a position over the mandate cap fails, and the receipt carries the observed number', async () => {
    const kuru = new FakeKuruReader()
    kuru.balance = 5_000n * 10n ** 18n // 5000 MON at 0.025188 is about 126 USDC
    const { app } = setup(kuru)
    const res = await paidPost(app, typedDecisionBody())
    const body = (await res.json()) as any
    expect(body.verdict.outcome).toBe('FAIL')
    expect(body.signed.outcome).toBe(3)
    const position = body.receipt.observations[2]
    expect(position.positionBase).toBe(5_000)
    expect(position.notionalUsd).toBeCloseTo(125.94, 2)
    const item = body.verdict.failing.find((f: any) => f.kind === 'position')
    expect(item.status).toBe('FALSE')
    expect(JSON.stringify(item.observed)).toContain('125.94')
  })

  it('a claim that loosens the mandate fails on the mandate rule, not on the claim', async () => {
    const { app } = setup()
    const claims = typedDecisionBody().claims as Record<string, unknown>[]
    claims[1] = { ...claims[1], probability: 0.4, minProbability: 0.3 }
    const res = await paidPost(app, typedDecisionBody({ claims }))
    const body = (await res.json()) as any
    expect(body.verdict.outcome).toBe('FAIL')
    const violation = body.verdict.failing.find((f: any) => f.source === 'mandate')
    expect(violation).toMatchObject({ rule: 'minProbability', claimed: 0.3, observed: 0.6 })
  })

  it('a leverage field the mandate never granted is refused before payment', async () => {
    const { app, facilitator } = setup()
    const claims = typedDecisionBody().claims as Record<string, unknown>[]
    claims[1] = { ...claims[1], leverage: 3 }
    const res = await post(app, typedDecisionBody({ claims }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid check request')
    expect(facilitator.calls).not.toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })
})

describe('claim family and mandate must agree', () => {
  it('refuses ClaimV0 kinds under a typed-decision mandate, for free', async () => {
    const { app, facilitator } = setup()
    const res = await post(app, typedDecisionBody({ claims: checkBody().claims }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('mandate jev-mon-usdc-v1 takes typed-decision claim kinds')
    expect(facilitator.calls).not.toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })

  it('refuses typed-decision kinds under a Morpho mandate, for free', async () => {
    const facilitator = new FakeFacilitator()
    const app = createApp({
      facilitator,
      payTo: PAY_TO,
      receipts: new MemoryStore(),
      mandates: MANDATES,
      checkDeps: () => checkDeps(validator),
    })
    const res = await post(app, checkBody({ claims: typedDecisionBody().claims, mandateId: 'demo-usdc-v1' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('mandate demo-usdc-v1 takes ClaimV0 claim kinds')
    expect(facilitator.calls).not.toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })

  it('refuses a mix of the two families outright', async () => {
    const { app } = setup()
    const mixed = [...typedDecisionBody().claims, ...checkBody().claims] as unknown[]
    const res = await post(app, typedDecisionBody({ claims: mixed }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid check request')
  })
})

describe('the order the gate would forward is checked against the order claimed', () => {
  it('fails when the calldata price is not the price the agent stated', async () => {
    const { app } = setup()
    const res = await paidPost(app, typedDecisionBody({
      intent: {
        vault: KURU_MARKET,
        data: batchUpdateData(2_510_000n),
        nonce: '7',
        notAfterBlock: (HEAD + 50n).toString(),
      },
    }))
    const body = (await res.json()) as any
    expect(body.verdict.outcome).toBe('FAIL')
    expect(body.verdict.failing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'action', field: 'price', claimed: '2518800', observed: '2510000' }),
      ]),
    )
  })

  it('refuses a request aimed at another venue', async () => {
    const { app } = setup()
    const res = await paidPost(app, typedDecisionBody({
      intent: {
        vault: '0x000000000000000000000000000000000000dEaD',
        data: batchUpdateData(),
        nonce: '7',
        notAfterBlock: (HEAD + 50n).toString(),
      },
    }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe(`this validator serves vault ${KURU_MARKET}`)
  })
})
