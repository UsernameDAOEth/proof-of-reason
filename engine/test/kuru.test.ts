import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import { checkAction } from '../src/action.ts'
import { SchemaError } from '../src/claims.ts'
import type { TypedDecisionMandate } from '../src/claims.ts'
import { compare } from '../src/compare.ts'
import {
  decodeKuruOrder,
  decodeL2Book,
  depthOf,
  kuruOrderBookAbi,
  observeDecision,
  observeTypedDecisionAll,
} from '../src/kuru.ts'
import type { KuruMarketParams, KuruReader } from '../src/kuru.ts'
import { checkTypedDecisionMandate } from '../src/mandate.ts'
import { decide } from '../src/verdict.ts'

const MARKET: Address = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394'
const GATE: Address = '0x00000000000000000000000000000000000000Aa'
const BLOCK = 106_617_487n

// Kuru MON-USDC parameters at that block (docs/MONAD.md section 11).
const PARAMS: KuruMarketParams = { pricePrecision: 100_000_000n, sizePrecision: 10_000_000_000n, baseDecimals: 18n }
const BEST_BID = 25_188_000_000_000_000n // 0.025188 USDC per MON, 1e18-scaled
const BEST_ASK = 25_199_000_000_000_000n

/** Builds a getL2Book payload: block word, bid pairs, zero, ask pairs, zero. */
function bookPayload(bids: [number, number][], asks: [number, number][]): Hex {
  const word = (v: bigint) => v.toString(16).padStart(64, '0')
  const level = ([p, s]: [number, number]) =>
    word(BigInt(Math.round(p * 1e8))) + word(BigInt(Math.round(s * 1e10)))
  return `0x${word(BLOCK)}${bids.map(level).join('')}${word(0n)}${asks.map(level).join('')}${word(0n)}` as Hex
}

const BOOK = bookPayload(
  [
    [0.025188, 19_841],
    [0.025187, 19_800],
  ],
  [
    [0.025199, 19_800],
    [0.025204, 19_841],
  ],
)

function reader(overrides: Partial<{ bestBid: bigint; bestAsk: bigint; balance: bigint }> = {}): KuruReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async bestBidAsk(_m, block) {
      calls.push(`bestBidAsk@${block}`)
      return { bestBid: overrides.bestBid ?? BEST_BID, bestAsk: overrides.bestAsk ?? BEST_ASK }
    },
    async l2Book(_m, block) {
      calls.push(`l2Book@${block}`)
      return BOOK
    },
    async marketParams(_m, block) {
      calls.push(`marketParams@${block}`)
      return PARAMS
    },
    async nativeBalance(_a, block) {
      calls.push(`nativeBalance@${block}`)
      return overrides.balance ?? 500n * 10n ** 18n
    },
  }
}

const bookClaim = (o: Record<string, unknown> = {}) => ({
  id: 'k1',
  kind: 'kuru_book',
  sourceSpan: null,
  market: MARKET,
  bestBid: 0.025188,
  bestAsk: 0.025199,
  tolerancePp: 0.1,
  ...o,
})

const decisionClaim = (o: Record<string, unknown> = {}) => ({
  id: 'd1',
  kind: 'decision',
  sourceSpan: null,
  answer: 'UP',
  allowedValues: ['UP', 'DOWN', 'FLAT'],
  probability: 0.71,
  minProbability: 0.6,
  ...o,
})

const positionClaim = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  kind: 'position',
  sourceSpan: null,
  gate: GATE,
  market: MARKET,
  maxNotionalUsd: 100,
  maxPositionBase: 1_000,
  ...o,
})

const MANDATE: TypedDecisionMandate = {
  type: 'typed-decision',
  gate: GATE,
  market: MARKET,
  allowedAnswers: ['UP', 'DOWN', 'FLAT'],
  minProbability: 0.6,
  maxNotionalUsd: 100,
  maxPositionBase: 1_000,
  requiredKinds: ['kuru_book', 'decision', 'position'],
}

function orderData(price: number, size: bigint, side: 'buy' | 'sell' = 'buy', postOnly = true): Hex {
  const prices = [price] as const
  const sizes = [size] as const
  return encodeFunctionData({
    abi: kuruOrderBookAbi,
    functionName: 'batchUpdate',
    args: side === 'buy' ? [prices, sizes, [], [], [], postOnly] : [[], [], prices, sizes, [], postOnly],
  })
}

describe('the Kuru book at a pinned block', () => {
  it('decodes getL2Book into levels and depth, with the embedded block', () => {
    const book = decodeL2Book(BOOK, PARAMS)
    expect(book.block).toBe(BLOCK)
    expect(book.bids[0]).toEqual({ price: 0.025188, size: 19_841 })
    expect(book.asks[0]).toEqual({ price: 0.025199, size: 19_800 })
    expect(depthOf(book.bids)).toBeCloseTo(39_641, 6)
  })

  it('reads params, best bid and ask, then the book, one read at a time', async () => {
    const r = reader()
    const [obs] = await observeTypedDecisionAll(r, [bookClaim()] as never, BLOCK)
    expect(r.calls).toEqual([`marketParams@${BLOCK}`, `bestBidAsk@${BLOCK}`, `l2Book@${BLOCK}`])
    expect(obs).toMatchObject({ bestBid: 0.025188, bestAsk: 0.025199, bookBlock: BLOCK, levels: 4 })
    expect(compare(bookClaim(), obs!).status).toBe('TRUE')
  })

  it('is FALSE when a quoted price is outside the relative tolerance, and TRUE just inside', async () => {
    const [obs] = await observeTypedDecisionAll(reader(), [bookClaim()] as never, BLOCK)
    // 0.1 percent of the claimed price is about 2.5e-5, so 0.02517 is inside and 0.0251 is not.
    expect(compare(bookClaim({ bestBid: 0.02517 }), obs!).status).toBe('TRUE')
    expect(compare(bookClaim({ bestBid: 0.0251 }), obs!)).toMatchObject({
      status: 'FALSE',
      claimed: { bestBid: 0.0251, bestAsk: 0.025199 },
      observed: { bestBid: 0.025188, bestAsk: 0.025199 },
    })
    expect(compare(bookClaim({ bestAsk: 0.03 }), obs!).status).toBe('FALSE')
  })

  it('is UNVERIFIABLE when the book has no bid', async () => {
    const [obs] = await observeTypedDecisionAll(reader({ bestBid: 0n }), [bookClaim()] as never, BLOCK)
    expect(obs!.unverifiable).toBe('the book has no bid or no ask at the pinned block')
    expect(compare(bookClaim(), obs!).status).toBe('UNVERIFIABLE')
  })
})

describe('decision: an unrecognised answer never becomes a default', () => {
  it('TRUE for an allowed answer above the probability floor', () => {
    const obs = observeDecision(decisionClaim(), BLOCK)
    expect(compare(decisionClaim(), obs)).toMatchObject({ status: 'TRUE', block: BLOCK })
  })

  it('UNVERIFIABLE, so WAIT, for an answer outside the allowed set', () => {
    const claim = decisionClaim({ answer: 'SHORT' })
    const obs = observeDecision(claim, BLOCK)
    expect(obs.recognised).toBe(false)
    const result = compare(claim, obs)
    expect(result.status).toBe('UNVERIFIABLE')
    expect(result.observed).toEqual({ answer: 'SHORT', recognised: false })
    expect(decide({ results: [result], actionMismatches: [], mandateViolations: [], requiredKinds: [] }).outcome).toBe('WAIT')
  })

  it('FALSE, so FAIL, for an allowed answer below the probability floor', () => {
    const claim = decisionClaim({ probability: 0.41 })
    const result = compare(claim, observeDecision(claim, BLOCK))
    expect(result.status).toBe('FALSE')
    expect(decide({ results: [result], actionMismatches: [], mandateViolations: [], requiredKinds: [] }).outcome).toBe('FAIL')
  })

  it('rejects a claim carrying a field the schema does not declare, such as leverage', () => {
    expect(() => observeDecision(decisionClaim({ leverage: 3 }), BLOCK)).toThrow(SchemaError)
  })
})

describe('position: the gate balances are the position', () => {
  it('TRUE inside both caps', async () => {
    const [obs] = await observeTypedDecisionAll(reader(), [positionClaim()] as never, BLOCK)
    expect(obs).toMatchObject({ positionBase: 500, notionalUsd: 500 * 0.025188 })
    expect(compare(positionClaim(), obs!).status).toBe('TRUE')
  })

  it('FALSE with the observed numbers when the base cap is breached', async () => {
    const [obs] = await observeTypedDecisionAll(reader({ balance: 1_200n * 10n ** 18n }), [positionClaim()] as never, BLOCK)
    const result = compare(positionClaim(), obs!)
    expect(result.status).toBe('FALSE')
    expect(result.observed).toEqual({ positionBase: 1_200, notionalUsd: 1_200 * 0.025188 })
    expect(result.claimed).toEqual({ maxPositionBase: 1_000, maxNotionalUsd: 100 })
  })

  it('FALSE when the notional cap is breached even though the base cap is not', async () => {
    const [obs] = await observeTypedDecisionAll(reader(), [positionClaim({ maxNotionalUsd: 5 })] as never, BLOCK)
    expect(compare(positionClaim({ maxNotionalUsd: 5 }), obs!).status).toBe('FALSE')
  })
})

describe('the typed-decision mandate cannot be widened by a claim', () => {
  it('no violation when every claim matches the mandate', () => {
    expect(checkTypedDecisionMandate([bookClaim(), decisionClaim(), positionClaim()], MANDATE)).toEqual([])
  })

  it('flags a wider answer set, a lower probability floor, looser caps, another gate or market', () => {
    const rules = (claims: unknown[]) => checkTypedDecisionMandate(claims, MANDATE).map((v) => v.rule)
    expect(rules([decisionClaim({ allowedValues: ['UP', 'DOWN', 'FLAT', 'LEVERAGE_UP'] })])).toEqual(['allowedAnswers'])
    expect(rules([decisionClaim({ minProbability: 0.1 })])).toEqual(['minProbability'])
    expect(rules([positionClaim({ maxNotionalUsd: 1_000_000 })])).toEqual(['maxNotionalUsd'])
    expect(rules([positionClaim({ maxPositionBase: 9_999 })])).toEqual(['maxPositionBase'])
    expect(rules([positionClaim({ gate: '0x000000000000000000000000000000000000dEaD' })])).toEqual(['gate'])
    expect(rules([bookClaim({ market: '0x000000000000000000000000000000000000dEaD' })])).toEqual(['market'])
  })

  it('a violation is a FAIL', () => {
    const violations = checkTypedDecisionMandate([positionClaim({ maxPositionBase: 9_999 })], MANDATE)
    expect(decide({ results: [], actionMismatches: [], mandateViolations: violations, requiredKinds: [] }).outcome).toBe('FAIL')
  })
})

describe('the order the gate would forward', () => {
  const stated = {
    fn: 'kuru_order',
    venue: MARKET,
    side: 'buy',
    price: '2518800',
    size: '2000000000000',
    cancels: 0,
    postOnly: true,
  } as const

  it('matches the batchUpdate calldata', () => {
    expect(checkAction(stated, orderData(2_518_800, 2_000_000_000_000n)).mismatches).toEqual([])
    expect(decodeKuruOrder(orderData(2_518_800, 2_000_000_000_000n))).toMatchObject({
      side: 'buy',
      price: 2_518_800n,
      size: 2_000_000_000_000n,
      cancels: 0,
      postOnly: true,
    })
  })

  it('flags a different size, side, or postOnly flag', () => {
    expect(checkAction(stated, orderData(2_518_800, 9_000_000_000_000n)).mismatches.map((m) => m.field)).toEqual(['size'])
    expect(checkAction(stated, orderData(2_518_800, 2_000_000_000_000n, 'sell')).mismatches.map((m) => m.field)).toEqual(['side'])
    expect(
      checkAction(stated, orderData(2_518_800, 2_000_000_000_000n, 'buy', false)).mismatches.map((m) => m.field),
    ).toEqual(['postOnly'])
  })

  it('refuses calldata that is not one batchUpdate order', () => {
    const twoOrders = encodeFunctionData({
      abi: kuruOrderBookAbi,
      functionName: 'batchUpdate',
      args: [[2_518_800, 2_518_700], [1n, 2n], [], [], [], true],
    })
    expect(checkAction(stated, twoOrders).mismatches[0]).toMatchObject({ field: 'calldata' })
    expect(checkAction(stated, '0xdeadbeef').mismatches[0]).toMatchObject({ field: 'calldata' })
  })
})
