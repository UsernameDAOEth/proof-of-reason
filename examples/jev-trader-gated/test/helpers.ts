import { readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { checkAction } from 'proof-of-reason-engine/action'
import { compare } from 'proof-of-reason-engine/compare'
import { observeTypedDecisionAll } from 'proof-of-reason-engine/kuru'
import type { KuruMarketParams, KuruReader } from 'proof-of-reason-engine/kuru'
import { parseTypedDecisionClaims } from 'proof-of-reason-engine/claims'
import { checkTypedDecisionMandate } from 'proof-of-reason-engine/mandate'
import { buildReceipt, receiptHash } from 'proof-of-reason-engine/receipt'
import { gateDomain, signVerdict } from 'proof-of-reason-engine/sign'
import { OUTCOME_CODE, decide } from 'proof-of-reason-engine/verdict'
import { loadMandate } from '../adapter.ts'
import type { AdapterConfig, CheckResponse, UpstreamBook, UpstreamTradeState } from '../adapter.ts'

export const VENUE: Address = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394'
export const GATE: Address = '0x2Ff1552DD09f87d6774229Ee4A0b3B9e5f7F4bdE'
export const CHAIN_ID = 143
/** The validator checks three blocks behind the head, as worker/src/config.ts does. */
export const CHECK_LAG_BLOCKS = 3n
export const HEAD = 106_617_500n
export const PINNED = HEAD - CHECK_LAG_BLOCKS

/** Kuru MON-USDC at block 106617487 (docs/MONAD.md section 11). */
export const KURU_PARAMS: KuruMarketParams = {
  pricePrecision: 100_000_000n,
  sizePrecision: 10_000_000_000n,
  baseDecimals: 18n,
}
export const BEST_BID = 25_188_000_000_000_000n
export const BEST_ASK = 25_199_000_000_000_000n

export const validatorAccount = privateKeyToAccount(`0x${'11'.repeat(32)}`)

function bookPayload(bids: [number, number][], asks: [number, number][]): Hex {
  const word = (v: bigint) => v.toString(16).padStart(64, '0')
  const level = ([p, s]: [number, number]) =>
    word(BigInt(Math.round(p * 1e8))) + word(BigInt(Math.round(s * 1e10)))
  return `0x${word(PINNED)}${bids.map(level).join('')}${word(0n)}${asks.map(level).join('')}${word(0n)}` as Hex
}

/** Kuru reads, offline. No RPC, no network. */
export class FakeKuru implements KuruReader {
  calls: string[] = []
  bestBid = BEST_BID
  bestAsk = BEST_ASK
  /** Native MON held by the gate. On MON-USDC the base asset is native MON. */
  balanceWei = 0n

  async bestBidAsk(_market: Address, block: bigint) {
    this.calls.push(`bestBidAsk@${block}`)
    return { bestBid: this.bestBid, bestAsk: this.bestAsk }
  }

  async l2Book(_market: Address, block: bigint): Promise<Hex> {
    this.calls.push(`l2Book@${block}`)
    return bookPayload(
      [
        [0.025188, 19_841],
        [0.025187, 19_800],
      ],
      [
        [0.025199, 19_800],
        [0.025204, 19_841],
      ],
    )
  }

  async marketParams(_market: Address, block: bigint) {
    this.calls.push(`marketParams@${block}`)
    return KURU_PARAMS
  }

  async nativeBalance(_address: Address, block: bigint) {
    this.calls.push(`nativeBalance@${block}`)
    return this.balanceWei
  }
}

/** The book the model reads: the top of book the fake Kuru serves. */
export const BOOK: UpstreamBook = { block: Number(PINNED), bid: 0.025188, ask: 0.025199, mid: 0.0251935 }

/** A state in the shape upstream's model is given (upstream/src/model.ts TradeState). */
export function tradeState(block: number, overrides: UpstreamTradeState = {}): UpstreamTradeState {
  return {
    market: 'MON-USDC',
    block,
    horizonBlocks: 100,
    blockMs: 300,
    mid: BOOK.mid,
    spreadBps: 4.37,
    bookImbalance: 0.012,
    book: { bids: ['0.025188 x 19841'], asks: ['0.025199 x 19800'] },
    returnsBps: { last1: 0.4, last5: -1.2, last20: 3.1, last100: -0.7 },
    allowed: { buy: true, sell: true },
    ...overrides,
  }
}

export const MANDATE_JSON = JSON.parse(readFileSync(new URL('../mandate.json', import.meta.url), 'utf8'))

/** mandate.json with the deployed gate filled in, as the runbook says to do. */
export const MANDATE = { ...loadMandate(MANDATE_JSON), gate: GATE }

export const CONFIG: AdapterConfig = {
  mandateId: 'jev-mon-usdc-v1',
  mandate: MANDATE,
  venue: VENUE,
  // getMarketParams() at block 106617487: pricePrecision 1e8, sizePrecision 1e10, tickSize 100.
  params: { priceDecimals: 8, sizeDecimals: 10, tickUnits: 100 },
  quoteInsideTicks: 1,
  tradeSizeMon: 200,
  tolerancePp: 0.1,
  intentLifetimeBlocks: 30,
  chainId: CHAIN_ID,
  validator: validatorAccount.address,
  modelId: 'MrJev jev-latest (jev-trader b587759)',
}

export type ValidatorOptions = {
  mandate?: AdapterConfig['mandate']
  head?: bigint
}

/**
 * The validator, in process: the same engine calls worker/src/check.ts makes, without HTTP or
 * payment. It signs with a throwaway key, so a verdict here is a real signed Verdict.
 */
export function makeValidator(kuru: FakeKuru, options: ValidatorOptions = {}) {
  const mandate = options.mandate ?? MANDATE
  const head = options.head ?? HEAD
  const calls: unknown[] = []

  const check = async (bodyInput: unknown): Promise<CheckResponse> => {
    calls.push(bodyInput)
    const body = bodyInput as {
      intent: { vault: Address; data: Hex; nonce: string; notAfterBlock: string }
      action: unknown
      claims: unknown
      mandateId: string
      model?: string
    }
    if (body.intent.vault.toLowerCase() !== VENUE.toLowerCase()) {
      throw new Error(`this validator serves vault ${VENUE}`)
    }
    // Throws SchemaError on anything the claim schema does not allow, as the worker's 400 does.
    const claims = parseTypedDecisionClaims(body.claims)
    const checkedAtBlock = head - CHECK_LAG_BLOCKS
    const observations = await observeTypedDecisionAll(kuru, claims, checkedAtBlock)
    const results = claims.map((claim, i) => compare(claim, observations[i]!))
    const action = checkAction(body.action as never, body.intent.data)
    const verdict = decide({
      results,
      actionMismatches: action.mismatches,
      mandateViolations: checkTypedDecisionMandate(claims, mandate),
      requiredKinds: mandate.requiredKinds,
    })
    const receipt = buildReceipt({
      chainId: CHAIN_ID,
      gate: mandate.gate as Address,
      vault: VENUE,
      data: body.intent.data,
      nonce: BigInt(body.intent.nonce),
      notAfterBlock: BigInt(body.intent.notAfterBlock),
      claims,
      action: body.action as never,
      mandate,
      observations,
      results,
      verdict,
      checkedAtBlock,
      modelId: body.model ?? null,
    })
    const hash = receiptHash(receipt)
    const domain = gateDomain(CHAIN_ID, mandate.gate as Address)
    const outcome = OUTCOME_CODE[verdict.outcome]
    const signature = await signVerdict(validatorAccount, domain, {
      intentHash: receipt.intent.intentHash,
      outcome,
      checkedAtBlock,
      receiptHash: hash,
    })
    return {
      mandateId: body.mandateId,
      verdict: { outcome: verdict.outcome, failing: verdict.failing, missingKinds: verdict.missingKinds },
      signed: {
        domain,
        intentHash: receipt.intent.intentHash,
        claimsHash: receipt.intent.claimsHash,
        outcome,
        checkedAtBlock: checkedAtBlock.toString(),
        receiptHash: hash,
        validator: validatorAccount.address,
        signature,
      },
      receipt,
    }
  }

  return { check, calls }
}

/** An executor that records what it was asked to send instead of sending it. */
export function recordingExecutor() {
  const sent: unknown[] = []
  return {
    sent,
    execute: async (call: unknown) => {
      sent.push(call)
      return `0x${(sent.length + 0xa0).toString(16).padStart(64, '0')}` as Hex
    },
  }
}

/** Nonces, one per intent, strictly increasing. */
export function nonces(start = 1n) {
  let next = start
  return () => next++
}
