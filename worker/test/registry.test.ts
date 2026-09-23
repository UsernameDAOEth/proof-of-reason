import { describe, expect, it } from 'vitest'
import { recoverTypedDataAddress } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { RULESET } from 'proof-of-reason-engine/receipt'
import { verdictTypes } from 'proof-of-reason-engine/sign'
import { createApp } from '../src/app.ts'
import { CheckRequestV0 } from '../src/body.ts'
import { runCheck } from '../src/check.ts'
import { MANDATES, MARKET_B } from '../src/mandates.ts'
import { OUTCOME_RESPONSE, describeRegistryError, serialised } from '../src/registry.ts'
import type { RegistryWriter, ValidationWrite } from '../src/registry.ts'
import { FakeFacilitator, MemoryStore, PAY_TO, checkBody, checkDeps, sealHashOf } from './helpers.ts'

const account = privateKeyToAccount(generatePrivateKey())
const REGISTRY = '0x51f4C1d5eF8A91A0b0e8e7b0a6Ba1F2d1A9a8B7c' as const
/** The mandate as 2B will carry it: a real agent id, not the placeholder. */
const mandate = { ...MANDATES['demo-usdc-v1']!, agentId: '42' }

/** Records what the worker asked to be written, and can be told to fail. */
function fakeRegistry(fail?: unknown) {
  const writes: ValidationWrite[] = []
  const writer: RegistryWriter = {
    address: REGISTRY,
    async write(write) {
      writes.push(write)
      if (fail !== undefined) throw fail
      return `0x${'ab'.repeat(32)}` as Hex
    },
  }
  return { writes, writer }
}

function request(overrides: Record<string, unknown> = {}) {
  return CheckRequestV0.parse(checkBody(overrides))
}

/** A rate claim that is false at the pinned block: the verdict is FAIL. */
function failingClaims() {
  const claims = checkBody().claims as Record<string, unknown>[]
  return [{ ...claims[0], valuePct: 12 }, claims[1]]
}

/** Only a rate claim: the mandate also requires liquidity, so the verdict is WAIT. */
function incompleteClaims() {
  return [checkBody().claims[0]]
}

describe('every verdict is recorded on chain', () => {
  it('writes PASS as 100, against the mandate agent id, keyed by intentHash, sealed by receiptHash', async () => {
    const { writes, writer } = fakeRegistry()
    const result = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: writer }))

    expect(result.verdict.outcome).toBe('PASS')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      agentId: 42n,
      requestHash: result.signed.intentHash,
      response: 100,
      responseHash: result.signed.receiptHash,
      tag: RULESET,
    })
    expect(result.receipt.registry).toEqual({
      agentId: '42',
      address: REGISTRY,
      response: 100,
      tag: RULESET,
      tx: `0x${'ab'.repeat(32)}`,
    })
  })

  it('writes WAIT as 50 and FAIL as 0, so a refusal is on the record too', async () => {
    const wait = fakeRegistry()
    const waited = await runCheck(
      request({ claims: incompleteClaims() }),
      mandate,
      checkDeps(account, undefined, { registry: wait.writer }),
    )
    expect(waited.verdict.outcome).toBe('WAIT')
    expect(wait.writes[0]?.response).toBe(50)
    expect(waited.receipt.registry?.response).toBe(50)

    const fail = fakeRegistry()
    const failed = await runCheck(
      request({ claims: failingClaims() }),
      mandate,
      checkDeps(account, undefined, { registry: fail.writer }),
    )
    expect(failed.verdict.outcome).toBe('FAIL')
    expect(fail.writes[0]?.response).toBe(0)
    expect(failed.receipt.registry?.response).toBe(0)
    expect(OUTCOME_RESPONSE).toEqual({ PASS: 100, WAIT: 50, FAIL: 0 })
  })

  it('records the tag as the ruleset version', async () => {
    const { writes, writer } = fakeRegistry()
    const result = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: writer }))
    expect(writes[0]?.tag).toBe('REASON-R0')
    expect(result.receipt.registry?.tag).toBe('REASON-R0')
    expect(result.receipt.ruleset).toBe('REASON-R0')
  })

  it('leaves the signed verdict untouched: the registry record is outside receiptHash', async () => {
    const { writer } = fakeRegistry()
    const result = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: writer }))

    expect(result.receiptJson).toContain('"registry"')
    expect(sealHashOf(result.receiptJson)).toBe(result.signed.receiptHash)
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
  })

  it('gives the same receiptHash whether the write succeeded or failed', async () => {
    const ok = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: fakeRegistry().writer }))
    const broken = await runCheck(
      request(),
      mandate,
      checkDeps(account, undefined, { registry: fakeRegistry(new Error('rpc down')).writer }),
    )
    expect(broken.signed.receiptHash).toBe(ok.signed.receiptHash)
    expect(broken.receipt.registry?.error).toBe('Error: rpc down')
    expect(ok.receipt.registry?.tx).toBeTruthy()
  })
})

describe('the write is fail-soft', () => {
  it('returns the verdict and records registry_error when the write throws', async () => {
    const { writes, writer } = fakeRegistry(new Error('replacement transaction underpriced'))
    const result = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: writer }))

    expect(writes).toHaveLength(1)
    expect(result.verdict.outcome).toBe('PASS')
    expect(result.signed.signature).toMatch(/^0x[0-9a-f]+$/)
    expect(result.receipt.registry).toEqual({
      agentId: '42',
      address: REGISTRY,
      response: 100,
      tag: RULESET,
      error: 'Error: replacement transaction underpriced',
    })
    expect(result.receipt.registry?.tx).toBeUndefined()
  })

  it('never lets the RPC URL secret into the receipt', async () => {
    const secret = 'https://monad.example.quiknode.pro/0123456789abcdef/'
    const { writer } = fakeRegistry(new Error(`HTTP request failed.\nURL: ${secret}\nRequest body: {}`))
    const result = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: writer }))

    expect(result.receiptJson).not.toContain(secret)
    expect(result.receiptJson).not.toContain('quiknode')
    expect(result.receipt.registry?.error).toBe('Error: HTTP request failed.')
  })

  it('records why nothing was written: no registry, or no agent id yet', async () => {
    const noRegistry = await runCheck(request(), mandate, checkDeps(account))
    expect(noRegistry.verdict.outcome).toBe('PASS')
    expect(noRegistry.receipt.registry).toEqual({
      agentId: '42',
      address: null,
      response: 100,
      tag: RULESET,
      error: 'no validation registry is configured',
    })

    // The bundled mandate carries the placeholder "0" until 2B registers the demo agent. Agent id 0
    // exists on no Identity Registry, so nothing is sent.
    expect(MANDATES['demo-usdc-v1']!.agentId).toBe('0')
    const { writes, writer } = fakeRegistry()
    const placeholder = await runCheck(
      request(),
      MANDATES['demo-usdc-v1']!,
      checkDeps(account, undefined, { registry: writer }),
    )
    expect(writes).toEqual([])
    expect(placeholder.receipt.registry).toEqual({
      agentId: '0',
      address: REGISTRY,
      response: 100,
      tag: RULESET,
      error: 'the mandate carries no ERC-8004 agent id yet',
    })
  })

  it('describeRegistryError keeps a short, URL-free line', () => {
    expect(describeRegistryError(new Error('boom\nsecond line'))).toBe('Error: boom')
    expect(describeRegistryError({ shortMessage: 'ok' })).toBe('[object Object]')
    expect(describeRegistryError(Object.assign(new Error('x'), { shortMessage: 'Execution reverted.' }))).toBe(
      'Execution reverted.',
    )
    expect(describeRegistryError(new Error('at https://secret.example/token/abc def'))).toBe('Error: at [url] def')
    expect(describeRegistryError(new Error('y'.repeat(500))).length).toBe(200)
  })
})

describe('one validator key, one nonce sequence', () => {
  it('queues writes instead of racing them for a nonce', async () => {
    const queue = serialised<string>()
    let inFlight = 0
    let maxInFlight = 0
    const done: string[] = []
    const task = (name: string, fail = false) => async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      if (fail) throw new Error(name)
      done.push(name)
      return name
    }

    const results = await Promise.allSettled([
      queue(task('first')),
      queue(task('second', true)),
      queue(task('third')),
    ])

    // Never two sends at once, in the order they were asked for, and one failure does not stall the
    // queue: that write is the one that records a registry error.
    expect(maxInFlight).toBe(1)
    expect(done).toEqual(['first', 'third'])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })
})

describe('the stored receipt carries the registry record', () => {
  it('serves it from GET /receipts/:intentHash, and the seal still checks out', async () => {
    const facilitator = new FakeFacilitator()
    const receipts = new MemoryStore()
    const { writer } = fakeRegistry()
    const app = createApp({
      facilitator,
      payTo: PAY_TO,
      receipts,
      mandates: { 'demo-usdc-v1': mandate },
      checkDeps: () => checkDeps(account, undefined, { registry: writer }),
    })

    const result = await runCheck(request(), mandate, checkDeps(account, undefined, { registry: writer }))
    await receipts.put(result.signed.intentHash, result.receiptJson)

    const res = await app.request(`/receipts/${result.signed.intentHash}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    const stored = JSON.parse(text) as { registry: { tx: string; response: number }; mandate: { agentId: string } }
    expect(stored.registry.response).toBe(100)
    expect(stored.registry.tx).toBe(`0x${'ab'.repeat(32)}`)
    expect(stored.mandate.agentId).toBe('42')
    expect(sealHashOf(text)).toBe(result.signed.receiptHash)
    // The mandate the verdict cites is in the receipt, so the agent id is auditable from it alone.
    expect(MARKET_B).toBeTruthy()
  })
})
