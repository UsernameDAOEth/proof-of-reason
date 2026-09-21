/**
 * A Proof of Reason gate in front of jev-trader's order step.
 *
 * Nothing in upstream/ is edited. This adapter sits between the two calls upstream's Trader makes
 * every block (upstream/src/trader.ts, onBlock): `model.decide(state)` and `market.send(...)`. It
 * hashes the state the model was shown, states the book the model read, the answer it gave, and the
 * position the order would leave behind, and asks the validator. The order is built here with the
 * same integer tick math and the same batchUpdate encoding as upstream/src/market.ts, so the bytes
 * the gate forwards are the bytes upstream would have sent.
 *
 * The adapter never holds a key and never signs. Sending is an injected function: in a dry run it
 * is absent and nothing leaves the process.
 */
import { encodeFunctionData, keccak256 } from 'viem'
import type { Address, Hex } from 'viem'
import { parseAnyMandate, parseTypedDecisionClaims } from 'proof-of-reason-engine/claims'
import type { TypedDecisionClaim, TypedDecisionMandate } from 'proof-of-reason-engine/claims'
import { kuruOrderBookAbi } from 'proof-of-reason-engine/kuru'
import { hashCanonical } from 'proof-of-reason-engine/receipt'
import { gateDomain, hashIntent } from 'proof-of-reason-engine/sign'

/** upstream/src/market.ts, interface Book, at commit b587759. Only these fields are used. */
export type UpstreamBook = {
  block: number
  bid: number
  ask: number
  mid: number
}

/** upstream/src/model.ts, interface Decision, at commit b587759. */
export type UpstreamDecision = {
  action: string
  probabilities: Record<string, number>
}

/** upstream/src/model.ts, interface TradeState. Hashed verbatim, never interpreted. */
export type UpstreamTradeState = Record<string, unknown>

/** Market parameters as upstream reads them from the Kuru SDK (upstream/src/market.ts, init). */
export type VenueParams = {
  /** log10(pricePrecision), as upstream's priceDec. */
  priceDecimals: number
  /** log10(sizePrecision), as upstream's sizeDec. */
  sizeDecimals: number
  /** tickSize in price units, as upstream's tickUnits. */
  tickUnits: number
}

export type AdapterConfig = {
  mandateId: string
  mandate: TypedDecisionMandate
  venue: Address
  params: VenueParams
  /** upstream config.quoteInsideTicks. */
  quoteInsideTicks: number
  /** upstream config.tradeSizeMon. */
  tradeSizeMon: number
  /** Allowed relative difference on the book claim, in percent. */
  tolerancePp: number
  /** notAfterBlock = head + this. The gate's own freshness bound is 60 blocks. */
  intentLifetimeBlocks: number
  chainId: number
  validator: Address
  /** The version string the adapter reports, recorded as the receipt's model id. */
  modelId: string
}

export type PlannedOrder = {
  side: 'buy' | 'sell' | 'cancel-only'
  /** Price in price-precision units, exactly as in the calldata. 0 for cancel-only. */
  priceUnits: bigint
  /** Size in size-precision units, exactly as in the calldata. 0 for cancel-only. */
  sizeUnits: bigint
  cancels: number[]
  data: Hex
}

/** The verdict as the validator returns it on POST /check. */
export type SignedVerdict = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  intentHash: Hex
  claimsHash: Hex
  outcome: 1 | 2 | 3
  checkedAtBlock: string
  receiptHash: Hex
  validator: Address
  signature: Hex
}

export type CheckResponse = {
  mandateId: string
  verdict: { outcome: 'PASS' | 'WAIT' | 'FAIL'; failing: unknown[]; missingKinds: string[] }
  signed: SignedVerdict
  receipt: unknown
}

/** The call KuruGate.execute takes. ownerSig is empty unless the owner overrode a WAIT. */
export type GateCall = {
  data: Hex
  claimsHash: Hex
  nonce: bigint
  notAfterBlock: bigint
  outcome: 1 | 2 | 3
  checkedAtBlock: bigint
  receiptHash: Hex
  validatorSig: Hex
  ownerSig: Hex
}

export type AdapterDeps = {
  /** POST /check. In production this is a fetch wrapped by an x402 client; the price is 0.10 USDC. */
  check: (body: unknown) => Promise<CheckResponse>
  blockNumber: () => Promise<bigint>
  /** Strictly increasing, one per intent. The gate refuses a nonce twice. */
  nonce: () => bigint
  /** Absent in a dry run: the order is built and checked, and nothing is sent. */
  execute?: (call: GateCall) => Promise<Hex>
  log?: (line: string) => void
}

export type GatedBlockInput = {
  block: number
  state: UpstreamTradeState
  decision: UpstreamDecision
  book: UpstreamBook
  /** Resting order ids to cancel, as upstream passes to market.send. */
  cancels?: number[]
}

export type GatedBlockResult = {
  block: number
  /** REFUSED: the adapter itself would not ask, or the answer could not be turned into an intent. */
  outcome: 'PASS' | 'WAIT' | 'FAIL' | 'REFUSED'
  sent: boolean
  order: PlannedOrder | null
  intentHash: Hex | null
  claimsHash: Hex | null
  receiptHash: Hex | null
  txHash: Hex | null
  stateHash: Hex
  reason: string
}

/** The exact bytes the model was shown, hashed the way a receipt is hashed. */
export function stateHash(state: UpstreamTradeState): Hex {
  return hashCanonical(state)
}

/**
 * upstream/src/market.ts quotePrice: `quoteInsideTicks` inside the touch on our side, never
 * crossing, clamped to the touch when the spread is too tight. Integer tick math, so the price is
 * exactly representable on chain.
 */
export function quotePriceUnits(side: 'buy' | 'sell', book: UpstreamBook, config: AdapterConfig): bigint {
  const scale = 10 ** config.params.priceDecimals
  const tick = config.params.tickUnits
  const bidU = Math.round(book.bid * scale)
  const askU = Math.round(book.ask * scale)
  const step = config.quoteInsideTicks * tick
  let p = side === 'buy' ? bidU + step : askU - step
  if (side === 'buy' && p >= askU) p = bidU
  if (side === 'sell' && p <= bidU) p = askU
  return BigInt(p)
}

/** upstream/src/market.ts encode: parseUnits(size, sizeDec) with no rounding of its own. */
export function sizeUnits(sizeMon: number, config: AdapterConfig): bigint {
  const dec = config.params.sizeDecimals
  const [whole, fraction = ''] = sizeMon.toFixed(dec).split('.')
  return BigInt(`${whole}${fraction.padEnd(dec, '0')}`)
}

/**
 * upstream/src/market.ts encode: batchUpdate(buyPrices, buySizes, sellPrices, sellSizes,
 * orderIdsToCancel, postOnly). Funds come from the Kuru margin account, so value is 0.
 */
export function encodeBatchUpdate(
  side: 'buy' | 'sell' | 'cancel-only',
  priceUnits: bigint,
  size: bigint,
  cancels: readonly number[],
): Hex {
  const buys: [number[], bigint[]] = side === 'buy' ? [[Number(priceUnits)], [size]] : [[], []]
  const sells: [number[], bigint[]] = side === 'sell' ? [[Number(priceUnits)], [size]] : [[], []]
  return encodeFunctionData({
    abi: kuruOrderBookAbi,
    functionName: 'batchUpdate',
    args: [buys[0], buys[1], sells[0], sells[1], [...cancels], true],
  })
}

/**
 * The order this block would post. An answer the mandate does not list is never turned into a side:
 * the intent cancels what is resting and places nothing, and the validator is still asked, so the
 * refusal is on the record.
 */
export function planOrder(
  decision: UpstreamDecision,
  book: UpstreamBook,
  config: AdapterConfig,
  cancels: readonly number[] = [],
): PlannedOrder {
  const side = decision.action === 'buy' || decision.action === 'sell' ? decision.action : 'cancel-only'
  if (side === 'cancel-only') {
    return { side, priceUnits: 0n, sizeUnits: 0n, cancels: [...cancels], data: encodeBatchUpdate(side, 0n, 0n, cancels) }
  }
  const priceUnits = quotePriceUnits(side, book, config)
  const size = sizeUnits(config.tradeSizeMon, config)
  return { side, priceUnits, sizeUnits: size, cancels: [...cancels], data: encodeBatchUpdate(side, priceUnits, size, cancels) }
}

/**
 * The three claims a typed-decision agent can make: the book it read, the answer it gave, and the
 * position the order would leave behind. The state hash is carried on the decision claim, because
 * for this class of model the reason is the state plus the answer.
 */
export function buildClaims(
  input: GatedBlockInput,
  config: AdapterConfig,
): TypedDecisionClaim[] {
  const answer = input.decision.action
  const probability = input.decision.probabilities[answer] ?? 0
  return parseTypedDecisionClaims([
    {
      id: `book-${input.block}`,
      kind: 'kuru_book',
      sourceSpan: `book at block ${input.book.block}`,
      market: config.venue,
      bestBid: input.book.bid,
      bestAsk: input.book.ask,
      tolerancePp: config.tolerancePp,
    },
    {
      id: `decision-${input.block}`,
      kind: 'decision',
      sourceSpan: `state ${stateHash(input.state)}`,
      answer,
      allowedValues: [...config.mandate.allowedAnswers],
      probability,
      minProbability: config.mandate.minProbability,
    },
    {
      id: `position-${input.block}`,
      kind: 'position',
      sourceSpan: null,
      gate: config.mandate.gate as Address,
      market: config.venue,
      maxNotionalUsd: config.mandate.maxNotionalUsd,
      maxPositionBase: config.mandate.maxPositionBase,
    },
  ])
}

export type CheckBody = {
  intent: { vault: Address; data: Hex; nonce: string; notAfterBlock: string }
  action: {
    fn: 'kuru_order'
    venue: Address
    side: PlannedOrder['side']
    price: string
    size: string
    cancels: number
    postOnly: true
  }
  claims: TypedDecisionClaim[]
  mandateId: string
  model: string
}

export function buildCheckBody(
  order: PlannedOrder,
  claims: TypedDecisionClaim[],
  intent: { nonce: bigint; notAfterBlock: bigint },
  config: AdapterConfig,
): CheckBody {
  return {
    intent: {
      vault: config.venue,
      data: order.data,
      nonce: intent.nonce.toString(),
      notAfterBlock: intent.notAfterBlock.toString(),
    },
    action: {
      fn: 'kuru_order',
      venue: config.venue,
      side: order.side,
      price: order.priceUnits.toString(),
      size: order.sizeUnits.toString(),
      cancels: order.cancels.length,
      postOnly: true,
    },
    claims,
    mandateId: config.mandateId,
    model: config.modelId,
  }
}

/**
 * The verdict must be over exactly the intent this adapter built, signed by the validator the
 * principal set, for this gate on this chain. Anything else is not executed.
 */
export function verdictMatchesIntent(
  response: CheckResponse,
  body: CheckBody,
  claims: TypedDecisionClaim[],
  config: AdapterConfig,
): string | null {
  const domain = gateDomain(config.chainId, config.mandate.gate as Address)
  const localClaimsHash = hashCanonical(claims)
  if (response.signed.claimsHash.toLowerCase() !== localClaimsHash.toLowerCase()) {
    return 'claimsHash is not the hash of the claims sent'
  }
  const localIntentHash = hashIntent(domain, {
    vault: body.intent.vault,
    dataHash: keccak256(body.intent.data),
    claimsHash: localClaimsHash,
    nonce: BigInt(body.intent.nonce),
    notAfterBlock: BigInt(body.intent.notAfterBlock),
  })
  if (response.signed.intentHash.toLowerCase() !== localIntentHash.toLowerCase()) {
    return 'intentHash is not the hash of the intent sent'
  }
  if (response.signed.validator.toLowerCase() !== config.validator.toLowerCase()) {
    return `verdict signed by ${response.signed.validator}, not the validator the principal set`
  }
  if (
    response.signed.domain.chainId !== config.chainId ||
    response.signed.domain.verifyingContract.toLowerCase() !== (config.mandate.gate as string).toLowerCase()
  ) {
    return 'verdict is for another gate or another chain'
  }
  return null
}

/**
 * One gated block: hash the state, build the order upstream would have sent, ask the validator, and
 * send only on PASS. WAIT and FAIL place no order; the receipt hash is logged either way.
 */
export async function gatedBlock(
  input: GatedBlockInput,
  config: AdapterConfig,
  deps: AdapterDeps,
): Promise<GatedBlockResult> {
  const log = deps.log ?? (() => {})
  const hash = stateHash(input.state)
  const base = {
    block: input.block,
    sent: false,
    order: null,
    intentHash: null,
    claimsHash: null,
    receiptHash: null,
    txHash: null,
    stateHash: hash,
  }

  // The mandate the adapter was handed must be one the engine recognises. A field the principal
  // never granted, leverage for instance, is refused here rather than quietly ignored.
  try {
    loadMandate(config.mandate)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`#${input.block} REFUSED ${reason}`)
    return { ...base, outcome: 'REFUSED', reason }
  }
  if ((config.mandate.gate as string) === '0x0000000000000000000000000000000000000000') {
    return { ...base, outcome: 'REFUSED', reason: 'mandate.json still carries the placeholder gate address' }
  }
  // upstream emits action "hold" only for a block where no decision was made (trader.ts, late).
  if (input.decision.action === 'hold') {
    return { ...base, outcome: 'REFUSED', reason: 'no decision this block' }
  }

  let claims: TypedDecisionClaim[]
  try {
    claims = buildClaims(input, config)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`#${input.block} REFUSED ${reason}`)
    return { ...base, outcome: 'REFUSED', reason }
  }

  const order = planOrder(input.decision, input.book, config, input.cancels ?? [])
  const head = await deps.blockNumber()
  const intent = { nonce: deps.nonce(), notAfterBlock: head + BigInt(config.intentLifetimeBlocks) }
  const body = buildCheckBody(order, claims, intent, config)

  let response: CheckResponse
  try {
    response = await deps.check(body)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`#${input.block} REFUSED validator said no: ${reason}`)
    return { ...base, order, outcome: 'REFUSED', reason }
  }

  const mismatch = verdictMatchesIntent(response, body, claims, config)
  if (mismatch !== null) {
    log(`#${input.block} REFUSED ${mismatch}`)
    return { ...base, order, outcome: 'REFUSED', reason: mismatch }
  }

  const common = {
    ...base,
    order,
    intentHash: response.signed.intentHash,
    claimsHash: response.signed.claimsHash,
    receiptHash: response.signed.receiptHash,
  }

  if (response.verdict.outcome !== 'PASS') {
    log(`#${input.block} ${response.verdict.outcome} no order | receipt ${response.signed.receiptHash}`)
    return { ...common, outcome: response.verdict.outcome, reason: describeFailing(response) }
  }

  if (deps.execute === undefined) {
    log(`#${input.block} PASS dry run, order not sent | receipt ${response.signed.receiptHash}`)
    return { ...common, outcome: 'PASS', reason: 'dry run: PASS, nothing sent' }
  }

  const txHash = await deps.execute({
    data: order.data,
    claimsHash: response.signed.claimsHash,
    nonce: intent.nonce,
    notAfterBlock: intent.notAfterBlock,
    outcome: response.signed.outcome,
    checkedAtBlock: BigInt(response.signed.checkedAtBlock),
    receiptHash: response.signed.receiptHash,
    validatorSig: response.signed.signature,
    ownerSig: '0x',
  })
  log(`#${input.block} PASS ${order.side} ${order.priceUnits} | receipt ${response.signed.receiptHash} | ${txHash}`)
  return { ...common, outcome: 'PASS', sent: true, txHash, reason: 'PASS' }
}

/** The first failing item, in the words the receipt uses. */
export function describeFailing(response: CheckResponse): string {
  const first = response.verdict.failing[0] as Record<string, unknown> | undefined
  if (first === undefined) {
    const missing = response.verdict.missingKinds.join(', ')
    return missing.length > 0 ? `missing claim kinds: ${missing}` : response.verdict.outcome
  }
  const where = first.rule ?? first.field ?? first.kind ?? first.source
  return `${where}: claimed ${JSON.stringify(first.claimed)}, observed ${JSON.stringify(first.observed)}`
}

/** mandate.json, checked against the engine schema. */
export function loadMandate(json: unknown): TypedDecisionMandate {
  const mandate = parseAnyMandate(json)
  if (!('type' in mandate)) throw new Error('mandate.json is not a typed-decision mandate')
  return mandate
}
