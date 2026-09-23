import { describe, expect, it } from 'vitest'
import { keccak256, stringToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { createApp } from '../src/app.ts'
import { NETWORK, PRICE_ATOMIC, USDC } from '../src/config.ts'
import { MANDATES } from '../src/mandates.ts'
import { FakeFacilitator, FakeReader, MemoryStore, PAY_TO, checkBody, checkDeps, sealHashOf } from './helpers.ts'

const validator = privateKeyToAccount(generatePrivateKey())
const payer = privateKeyToAccount(generatePrivateKey())

function setup(reader = new FakeReader()) {
  const facilitator = new FakeFacilitator()
  const receipts = new MemoryStore()
  const app = createApp({
    facilitator,
    payTo: PAY_TO,
    receipts,
    mandates: MANDATES,
    checkDeps: () => checkDeps(validator, reader),
  })
  return { app, facilitator, receipts }
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

/** 402 challenge, then a real x402 v2 exact payment signed by a throwaway key. */
async function paidPost(app: ReturnType<typeof createApp>, body: unknown) {
  const challenge = await post(app, body)
  expect(challenge.status).toBe(402)
  const http = payerClient()
  const required = http.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json())
  const payload = await http.createPaymentPayload(required)
  return post(app, body, http.encodePaymentSignatureHeader(payload))
}

describe('POST /check payment', () => {
  it('answers 402 with x402 v2 exact requirements: Monad USDC, 0.10 USDC, EIP-712 USDC v2', async () => {
    const { app, facilitator } = setup()
    const res = await post(app, checkBody())
    expect(res.status).toBe(402)
    const required = payerClient().getPaymentRequiredResponse((name) => res.headers.get(name), await res.json())
    expect(required.x402Version).toBe(2)
    expect(required.accepts).toHaveLength(1)
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:143',
      asset: USDC,
      amount: PRICE_ATOMIC,
      payTo: PAY_TO,
      extra: { name: 'USDC', version: '2' },
    })
    expect(PRICE_ATOMIC).toBe('100000')
    expect(facilitator.calls).not.toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })

  it('a paid request is verified, checked, settled, and returns verdict, signed Verdict, and receipt', async () => {
    const { app, facilitator, receipts } = setup()
    const res = await paidPost(app, checkBody())
    expect(res.status).toBe(200)
    expect(facilitator.calls).toEqual(['supported', 'verify', 'settle'])
    expect(facilitator.lastVerify?.requirements).toMatchObject({ amount: '100000', asset: USDC, network: NETWORK })
    expect(facilitator.lastVerify?.payload.x402Version).toBe(2)
    expect(res.headers.get('payment-response')).toBeTruthy()

    const body = (await res.json()) as {
      mandateId: string
      verdict: { outcome: string }
      signed: { intentHash: string; receiptHash: string; signature: string; outcome: number; validator: string }
      receipt: unknown
    }
    expect(body.mandateId).toBe('demo-usdc-v1')
    expect(body.verdict.outcome).toBe('PASS')
    expect(body.signed.outcome).toBe(1)
    expect(body.signed.validator).toBe(validator.address)

    const stored = receipts.map.get(body.signed.intentHash)!
    expect(sealHashOf(stored)).toBe(body.signed.receiptHash)

    const fetched = await app.request(`/receipts/${body.signed.intentHash}`)
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe(stored)
  })

  it('a payment the facilitator rejects never reaches the check', async () => {
    const reader = new FakeReader()
    const { app, facilitator, receipts } = setup(reader)
    facilitator.verifyResult = { isValid: false, invalidReason: 'insufficient_funds' }
    const res = await paidPost(app, checkBody())
    expect(res.status).toBe(402)
    expect(facilitator.calls).not.toContain('settle')
    expect(reader.calls).toHaveLength(0)
    expect(receipts.map.size).toBe(0)
  })

  it('a check that cannot read the chain answers 503 and is not settled', async () => {
    const reader = new FakeReader()
    reader.fail = true
    const { app, facilitator } = setup(reader)
    const res = await paidPost(app, checkBody())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'chain state unavailable' })
    expect(facilitator.calls).toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })

  it('a FAIL verdict is still a paid, signed answer', async () => {
    const { app, facilitator } = setup()
    const body = checkBody()
    const res = await paidPost(app, { ...body, claims: [{ ...body.claims[0]!, valuePct: 7.5 }, body.claims[1]!] })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { verdict: { outcome: string } }).verdict.outcome).toBe('FAIL')
    expect(facilitator.calls).toContain('settle')
  })
})

describe('POST /check refusals are free', () => {
  it.each([
    ['malformed JSON gets 400', '{', 400],
    ['a schema violation gets 400', { ...checkBody(), extra: true }, 400],
    ['an unknown mandate gets 404', { ...checkBody(), mandateId: 'nope' }, 404],
    ['prose without an extractor gets 422', { ...checkBody(), claims: undefined, prose: 'B is better' }, 422],
  ] as const)('%s before any payment', async (_label, body, status) => {
    const { app, facilitator } = setup()
    const res = await post(app, body)
    expect(res.status).toBe(status)
    expect(res.headers.get('payment-required')).toBeNull()
    // The middleware syncs /supported when it is created; nothing is verified or settled.
    expect(facilitator.calls).not.toContain('verify')
    expect(facilitator.calls).not.toContain('settle')
  })
})

describe('GET /', () => {
  it('describes the service exactly as docs/DEPLOY_RUNBOOK.md step 8 expects', async () => {
    const { app } = setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      '{"check":{"method":"POST","path":"/check","price":{"amount":"100000","asset":"0x754704Bc059F8C67012fEd69BC8A327a5aafb603","network":"eip155:143"}},"mandates":["demo-usdc-v1"],"name":"Proof of Reason","receipts":{"method":"GET","path":"/receipts/:intentHash"}}',
    )
  })
})

describe('GET /receipts/:intentHash', () => {
  it('404 for an unknown hash, 400 for a malformed one', async () => {
    const { app } = setup()
    expect((await app.request(`/receipts/0x${'00'.repeat(32)}`)).status).toBe(404)
    expect((await app.request('/receipts/0x1234')).status).toBe(400)
  })
})

describe('CORS', () => {
  const ORIGIN = 'https://third-party.example'

  it('GET /receipts/:intentHash allows any origin, on hits and misses', async () => {
    const { app, receipts } = setup()
    const hash = `0x${'ab'.repeat(32)}`
    await receipts.put(hash, '{"stored":true}')
    const hit = await app.request(`/receipts/${hash}`, { headers: { origin: ORIGIN } })
    expect(hit.status).toBe(200)
    expect(hit.headers.get('access-control-allow-origin')).toBe('*')
    expect(await hit.text()).toBe('{"stored":true}')
    const miss = await app.request(`/receipts/0x${'00'.repeat(32)}`, { headers: { origin: ORIGIN } })
    expect(miss.status).toBe(404)
    expect(miss.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers the receipts preflight for GET only', async () => {
    const { app } = setup()
    const res = await app.request(`/receipts/0x${'ab'.repeat(32)}`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET')
    expect(res.headers.get('access-control-max-age')).toBe('86400')
  })

  it('POST /check, its preflight, and GET / carry no CORS headers', async () => {
    const { app } = setup()
    const unpaid = await post(app, checkBody(), { origin: ORIGIN })
    expect(unpaid.status).toBe(402)
    const invalid = await post(app, '{', { origin: ORIGIN })
    expect(invalid.status).toBe(400)
    const preflight = await app.request('/check', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    })
    const root = await app.request('/', { headers: { origin: ORIGIN } })
    for (const res of [unpaid, invalid, preflight, root]) {
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('access-control-allow-methods')).toBeNull()
    }
  })
})
