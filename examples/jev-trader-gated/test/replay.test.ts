import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeFunctionData } from 'viem'
import { SchemaError } from 'proof-of-reason-engine/claims'
import { kuruOrderBookAbi } from 'proof-of-reason-engine/kuru'
import {
  encodeBatchUpdate,
  gatedBlock,
  loadMandate,
  planOrder,
  quotePriceUnits,
  stateHash,
} from '../adapter.ts'
import type { UpstreamDecision } from '../adapter.ts'
import {
  BOOK,
  CONFIG,
  FakeKuru,
  GATE,
  MANDATE_JSON,
  PINNED,
  VENUE,
  makeValidator,
  nonces,
  recordingExecutor,
  tradeState,
  validatorAccount,
} from './helpers.ts'

const buy = (probability = 0.71): UpstreamDecision => ({
  action: 'buy',
  probabilities: { buy: probability, sell: 1 - probability, hold: 0 },
})

function deps(kuru: FakeKuru, options: { execute?: boolean; mandate?: typeof CONFIG.mandate } = {}) {
  const validator = makeValidator(kuru, options.mandate ? { mandate: options.mandate } : {})
  const executor = recordingExecutor()
  const lines: string[] = []
  return {
    validator,
    executor,
    lines,
    deps: {
      check: validator.check,
      blockNumber: async () => PINNED + 3n,
      nonce: nonces(),
      execute: options.execute === false ? undefined : executor.execute,
      log: (line: string) => lines.push(line),
    },
  }
}

describe('a truthful block', () => {
  it('passes, and sends exactly the batchUpdate upstream would have sent', async () => {
    const kuru = new FakeKuru()
    const { deps: d, executor } = deps(kuru)
    const result = await gatedBlock({ block: 1, state: tradeState(1), decision: buy(), book: BOOK, cancels: [7] }, CONFIG, d)

    expect(result.outcome).toBe('PASS')
    expect(result.sent).toBe(true)
    expect(executor.sent).toHaveLength(1)
    const call = executor.sent[0] as { data: `0x${string}`; outcome: number; receiptHash: string }
    expect(call.outcome).toBe(1)
    expect(call.receiptHash).toBe(result.receiptHash)
    // One tick inside the 0.025188 bid, 200 MON, cancelling the resting order, post-only.
    expect(call.data).toBe(encodeBatchUpdate('buy', 2_518_900n, 2_000_000_000_000n, [7]))
    const decoded = decodeFunctionData({ abi: kuruOrderBookAbi, data: call.data })
    expect(decoded.functionName).toBe('batchUpdate')
    expect(decoded.args).toEqual([[2_518_900], [2_000_000_000_000n], [], [], [7], true])
  })

  it('carries the hash of the state the model was shown, and the version it reported', async () => {
    const kuru = new FakeKuru()
    const { deps: d, validator } = deps(kuru)
    const state = tradeState(2)
    const result = await gatedBlock({ block: 2, state, decision: buy(), book: BOOK }, CONFIG, d)
    const body = validator.calls[0] as { claims: { kind: string; sourceSpan: string | null }[]; model: string }
    const decision = body.claims.find((c) => c.kind === 'decision')!
    expect(decision.sourceSpan).toBe(`state ${stateHash(state)}`)
    expect(body.model).toBe('MrJev jev-latest (jev-trader b587759)')
    // A different state is a different hash, so the receipt cannot be reused for another block.
    expect(stateHash(tradeState(2, { mid: 0.03 }))).not.toBe(result.stateHash)
  })

  it('sends nothing in a dry run, and still records the receipt hash', async () => {
    const kuru = new FakeKuru()
    const { deps: d, executor, lines } = deps(kuru, { execute: false })
    const result = await gatedBlock({ block: 3, state: tradeState(3), decision: buy(), book: BOOK }, CONFIG, d)
    expect(result.outcome).toBe('PASS')
    expect(result.sent).toBe(false)
    expect(result.receiptHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(executor.sent).toEqual([])
    expect(lines[0]).toContain('dry run')
  })
})

describe('MrJev failure mode 1: an unrecognised answer must not become a side', () => {
  it('answers SHORT: no order, WAIT, and the refusal is on the record', async () => {
    const kuru = new FakeKuru()
    const { deps: d, executor, lines } = deps(kuru)
    const decision: UpstreamDecision = { action: 'SHORT', probabilities: { SHORT: 0.9, buy: 0, sell: 0 } }
    const result = await gatedBlock({ block: 4, state: tradeState(4), decision, book: BOOK, cancels: [7] }, CONFIG, d)

    expect(result.outcome).toBe('WAIT')
    expect(result.sent).toBe(false)
    expect(executor.sent).toEqual([])
    // The intent it asked about places nothing: it only cancels what was resting.
    expect(result.order?.side).toBe('cancel-only')
    expect(result.order?.priceUnits).toBe(0n)
    expect(decodeFunctionData({ abi: kuruOrderBookAbi, data: result.order!.data }).args).toEqual([
      [],
      [],
      [],
      [],
      [7],
      true,
    ])
    expect(result.receiptHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(lines[0]).toContain('WAIT no order')
  })

  it('never turns an unrecognised answer into buy or sell, whatever it looks like', async () => {
    for (const answer of ['SHORT', 'long', 'LONG', 'BUY', 'Buy', 'hold ', '']) {
      const decision: UpstreamDecision = { action: answer, probabilities: { [answer]: 1 } }
      expect(planOrder(decision, BOOK, CONFIG).side).toBe('cancel-only')
    }
  })
})

describe('MrJev failure mode 2: no position or notional cap', () => {
  it('300 consecutive buy answers stop at the position cap, with the number in the receipt', async () => {
    const kuru = new FakeKuru()
    const { deps: d, executor } = deps(kuru)
    const outcomes: string[] = []
    let last: Awaited<ReturnType<typeof gatedBlock>> | null = null

    for (let block = 1; block <= 300; block++) {
      const result = await gatedBlock({ block, state: tradeState(block), decision: buy(), book: BOOK }, CONFIG, d)
      outcomes.push(result.outcome)
      last = result
      if (result.outcome !== 'PASS') break
      // Every order that goes through fills: the gate's MON balance grows by the trade size.
      kuru.balanceWei += BigInt(CONFIG.tradeSizeMon) * 10n ** 18n
    }

    // 200 MON per order against a 1000 MON cap: six orders reach the cap, the seventh is refused.
    expect(outcomes.filter((o) => o === 'PASS')).toHaveLength(6)
    expect(executor.sent).toHaveLength(6)
    expect(outcomes[outcomes.length - 1]).toBe('FAIL')
    expect(outcomes).toHaveLength(7)

    // The refusal carries the position it saw, in whole MON, not a generic error.
    expect(last!.sent).toBe(false)
    expect(last!.reason).toContain('1200')
    expect(kuru.balanceWei).toBe(1_200n * 10n ** 18n)
  })

  it('a claim that raises the caps above the mandate fails on the mandate rule', async () => {
    const kuru = new FakeKuru()
    const { deps: d } = deps(kuru)
    const widened = { ...CONFIG, mandate: { ...CONFIG.mandate, maxPositionBase: 100_000, maxNotionalUsd: 100_000 } }
    const result = await gatedBlock({ block: 5, state: tradeState(5), decision: buy(), book: BOOK }, widened, d)
    expect(result.outcome).toBe('FAIL')
    expect(result.reason).toMatch(/maxNotionalUsd|maxPositionBase/)
    expect(result.sent).toBe(false)
  })
})

describe('MrJev failure mode 3: leverage changed silently', () => {
  it('a leverage field on a claim is refused: the claim schema has no such field', async () => {
    const kuru = new FakeKuru()
    const validator = makeValidator(kuru)
    const claims = [
      {
        id: 'd1',
        kind: 'decision',
        sourceSpan: null,
        answer: 'buy',
        allowedValues: ['buy', 'sell'],
        probability: 0.8,
        minProbability: 0.6,
        leverage: 3,
      },
    ]
    await expect(
      validator.check({
        intent: { vault: VENUE, data: encodeBatchUpdate('cancel-only', 0n, 0n, []), nonce: '1', notAfterBlock: '9' },
        action: { fn: 'kuru_order', venue: VENUE, side: 'cancel-only', price: '0', size: '0', cancels: 0, postOnly: true },
        claims,
        mandateId: 'jev-mon-usdc-v1',
      }),
    ).rejects.toThrow(SchemaError)
  })

  it('a leverage field on the mandate is refused: the mandate has no such field', () => {
    expect(() => loadMandate({ ...MANDATE_JSON, gate: GATE, leverage: 3 })).toThrow(SchemaError)
  })

  it('an agent that adds leverage gets no order and no signature', async () => {
    const kuru = new FakeKuru()
    const { deps: d, executor } = deps(kuru)
    // The agent hands the adapter a mandate it invented, with a field the principal never granted.
    const tampered = { ...CONFIG, mandate: { ...CONFIG.mandate, leverage: 3 } as typeof CONFIG.mandate }
    const result = await gatedBlock({ block: 6, state: tradeState(6), decision: buy(), book: BOOK }, tampered, d)
    expect(result.outcome).toBe('REFUSED')
    expect(result.sent).toBe(false)
    expect(executor.sent).toEqual([])
  })
})

describe('the adapter refuses what it cannot check', () => {
  it('does not ask, and does not trade, while mandate.json carries the placeholder gate', async () => {
    const kuru = new FakeKuru()
    const { deps: d, validator } = deps(kuru)
    const unset = { ...CONFIG, mandate: loadMandate(MANDATE_JSON) }
    const result = await gatedBlock({ block: 7, state: tradeState(7), decision: buy(), book: BOOK }, unset, d)
    expect(result.outcome).toBe('REFUSED')
    expect(result.reason).toContain('placeholder gate')
    expect(validator.calls).toEqual([])
  })

  it('places no order on a late block, where upstream reports hold', async () => {
    const kuru = new FakeKuru()
    const { deps: d, validator, executor } = deps(kuru)
    const decision: UpstreamDecision = { action: 'hold', probabilities: { buy: 0, sell: 0, hold: 1 } }
    const result = await gatedBlock({ block: 8, state: tradeState(8), decision, book: BOOK }, CONFIG, d)
    expect(result.outcome).toBe('REFUSED')
    expect(result.reason).toBe('no decision this block')
    expect(validator.calls).toEqual([])
    expect(executor.sent).toEqual([])
  })

  it('refuses a verdict that is not over the intent it built', async () => {
    const kuru = new FakeKuru()
    const { executor } = deps(kuru)
    const honest = makeValidator(kuru)
    const result = await gatedBlock({ block: 9, state: tradeState(9), decision: buy(), book: BOOK }, CONFIG, {
      check: async (body) => {
        const response = await honest.check(body)
        // A validator, or anything in between, returns a verdict over a different intent.
        return { ...response, signed: { ...response.signed, intentHash: `0x${'de'.repeat(32)}` as const } }
      },
      blockNumber: async () => PINNED + 3n,
      nonce: nonces(),
      execute: executor.execute,
    })
    expect(result.outcome).toBe('REFUSED')
    expect(result.reason).toContain('intentHash')
    expect(executor.sent).toEqual([])
  })

  it('refuses a verdict signed by anyone but the validator the principal set', async () => {
    const kuru = new FakeKuru()
    const { executor } = deps(kuru)
    const honest = makeValidator(kuru)
    const other = { ...CONFIG, validator: '0x000000000000000000000000000000000000dEaD' as const }
    const result = await gatedBlock({ block: 10, state: tradeState(10), decision: buy(), book: BOOK }, other, {
      check: honest.check,
      blockNumber: async () => PINNED + 3n,
      nonce: nonces(),
      execute: executor.execute,
    })
    expect(result.outcome).toBe('REFUSED')
    expect(result.reason).toContain(validatorAccount.address)
    expect(executor.sent).toEqual([])
  })
})

describe('the order is the order upstream would have sent', () => {
  it('prices one tick inside the touch, and joins the touch when the spread is one tick', () => {
    expect(quotePriceUnits('buy', BOOK, CONFIG)).toBe(2_518_900n)
    expect(quotePriceUnits('sell', BOOK, CONFIG)).toBe(2_519_800n)
    const tight = { ...BOOK, bid: 0.025188, ask: 0.025189 }
    expect(quotePriceUnits('buy', tight, CONFIG)).toBe(2_518_800n)
    expect(quotePriceUnits('sell', tight, CONFIG)).toBe(2_518_900n)
  })

  it('matches the upstream encoder, field for field', () => {
    // upstream/src/market.ts encode: [priceU], [sizeU] on the chosen side, cancels, postOnly true.
    const order = planOrder(buy(), BOOK, CONFIG, [4, 5])
    expect(decodeFunctionData({ abi: kuruOrderBookAbi, data: order.data }).args).toEqual([
      [2_518_900],
      [2_000_000_000_000n],
      [],
      [],
      [4, 5],
      true,
    ])
  })
})

describe('upstream is vendored, pinned, and unedited', () => {
  const upstream = new URL('../upstream/', import.meta.url)

  it('sits at the commit docs/MONAD.md section 11 records, with no local changes', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim()
    expect(head).toBe('b587759e459ea049590102e54a0b07800864cdc3')
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: upstream, encoding: 'utf8' })
    expect(dirty).toBe('')
  })

  it('keeps its MIT licence file', () => {
    const licence = readFileSync(new URL('LICENSE', upstream), 'utf8')
    expect(licence).toContain('MIT License')
  })

  it('still encodes the call the adapter mirrors', () => {
    const market = readFileSync(new URL('src/market.ts', upstream), 'utf8')
    expect(market).toContain('encodeFunctionData("batchUpdate", [bp, bs, sp, ss, cancel.map((id) => BN.from(id)), true])')
    expect(market).toContain('value: BN.from(0)')
    const model = readFileSync(new URL('src/model.ts', upstream), 'utf8')
    // The fields the adapter reads off a Decision.
    expect(model).toContain('action: Action;')
    expect(model).toContain('probabilities: Record<Action, number>;')
    expect(model).toContain('export type Action = "buy" | "sell" | "hold";')
  })
})
