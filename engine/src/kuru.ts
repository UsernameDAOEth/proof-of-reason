import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import {
  DecisionClaim,
  KuruBookClaim,
  PositionClaim,
  SchemaError,
  parseTypedDecisionClaims,
} from './claims.ts'
import type { TypedDecisionClaim } from './claims.ts'

/**
 * Kuru reads and typed-decision observers. Signatures from the official SDK ABIs
 * (kuru-labs/kuru-sdk 0.0.95) and jev-trader's own decoder; see docs/MONAD.md section 11.
 */
export const kuruOrderBookAbi = parseAbi([
  'function bestBidAsk() view returns (uint256 bestBid, uint256 bestAsk)',
  'function getL2Book() view returns (bytes)',
  'function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAsset, uint256 baseAssetDecimals, address quoteAsset, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)',
  'function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)',
])

/** bestBidAsk returns quote-per-base prices scaled by 1e18. */
export const KURU_PRICE_SCALE = 10n ** 18n

export type KuruMarketParams = { pricePrecision: bigint; sizePrecision: bigint; baseDecimals: bigint }

export type BookLevel = { price: number; size: number }

export type L2Book = { block: bigint; bids: BookLevel[]; asks: BookLevel[] }

/** Every read is pinned to a block. */
export interface KuruReader {
  bestBidAsk(market: Address, block: bigint): Promise<{ bestBid: bigint; bestAsk: bigint }>
  l2Book(market: Address, block: bigint): Promise<Hex>
  marketParams(market: Address, block: bigint): Promise<KuruMarketParams>
  nativeBalance(address: Address, block: bigint): Promise<bigint>
}

export function viemKuruReader(
  client: Pick<PublicClient, 'readContract' | 'getBalance'>,
): KuruReader {
  return {
    async bestBidAsk(market, block) {
      const [bestBid, bestAsk] = await client.readContract({
        address: market,
        abi: kuruOrderBookAbi,
        functionName: 'bestBidAsk',
        blockNumber: block,
      })
      return { bestBid, bestAsk }
    },
    async l2Book(market, block) {
      return client.readContract({ address: market, abi: kuruOrderBookAbi, functionName: 'getL2Book', blockNumber: block })
    },
    async marketParams(market, block) {
      const p = await client.readContract({
        address: market,
        abi: kuruOrderBookAbi,
        functionName: 'getMarketParams',
        blockNumber: block,
      })
      return { pricePrecision: BigInt(p[0]), sizePrecision: p[1], baseDecimals: p[3] }
    },
    async nativeBalance(address, block) {
      return client.getBalance({ address, blockNumber: block })
    },
  }
}

/** Powers of ten: the digit count minus one, as the Kuru SDK does it. */
export function log10(value: bigint): number {
  return value.toString().length - 1
}

export function scaled(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals
}

/**
 * Decodes getL2Book(): one word of block number, then (price, size) word pairs for the bids ending
 * at a zero price, then the same for the asks. Prices scale by pricePrecision, sizes by
 * sizePrecision. Same layout as jev-trader's src/book.ts decodeL2Book.
 */
export function decodeL2Book(data: Hex, params: KuruMarketParams): L2Book {
  const hex = data.slice(2)
  const word = (i: number) => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`)
  const priceDec = log10(params.pricePrecision)
  const sizeDec = log10(params.sizePrecision)
  const bids: BookLevel[] = []
  const asks: BookLevel[] = []
  let side = bids
  let i = 1
  while (i * 64 < hex.length) {
    const price = word(i)
    if (price === 0n) {
      if (side === asks) break
      side = asks
      i += 1
      continue
    }
    side.push({ price: scaled(price, priceDec), size: scaled(word(i + 1), sizeDec) })
    i += 2
  }
  return { block: word(0), bids, asks }
}

export const depthOf = (levels: readonly BookLevel[]): number => levels.reduce((sum, l) => sum + l.size, 0)

export type KuruBookObservation = {
  kind: 'kuru_book'
  market: Address
  block: bigint
  bestBid: number | null
  bestAsk: number | null
  bidDepth: number | null
  askDepth: number | null
  bookBlock: bigint | null
  levels: number | null
  unverifiable: string | null
}

export type DecisionObservation = {
  kind: 'decision'
  block: bigint
  answer: string
  allowedValues: string[]
  recognised: boolean
  probability: number
  minProbability: number
  unverifiable: string | null
}

export type PositionObservation = {
  kind: 'position'
  gate: Address
  market: Address
  block: bigint
  baseBalance: bigint
  quoteBestBid: number
  positionBase: number
  notionalUsd: number
  unverifiable: string | null
}

export type TypedDecisionObservation = KuruBookObservation | DecisionObservation | PositionObservation

function parseOne<T>(schema: { safeParse(i: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new SchemaError(`invalid ${label}`, result.error.issues.map((i) => i.message))
  return result.data
}

/** Best bid, best ask, and depth at the pinned block: three reads, one at a time. */
export async function observeKuruBook(
  reader: KuruReader,
  claimInput: unknown,
  block: bigint,
): Promise<KuruBookObservation> {
  const claim = parseOne(KuruBookClaim, claimInput, 'kuru_book claim')
  const market = claim.market as Address
  const base = { kind: 'kuru_book', market, block } as const
  const empty = { bestBid: null, bestAsk: null, bidDepth: null, askDepth: null, bookBlock: null, levels: null }

  const params = await reader.marketParams(market, block)
  const { bestBid, bestAsk } = await reader.bestBidAsk(market, block)
  if (bestBid === 0n || bestAsk === 0n) {
    return { ...base, ...empty, unverifiable: 'the book has no bid or no ask at the pinned block' }
  }
  const book = decodeL2Book(await reader.l2Book(market, block), params)
  return {
    ...base,
    bestBid: scaled(bestBid, 18),
    bestAsk: scaled(bestAsk, 18),
    bidDepth: depthOf(book.bids),
    askDepth: depthOf(book.asks),
    bookBlock: book.block,
    levels: book.bids.length + book.asks.length,
    unverifiable: null,
  }
}

/**
 * A decision needs no chain read: the claim is the answer the model gave. An answer outside the
 * allowed set is recorded as unrecognised, which the comparison turns into UNVERIFIABLE, so the
 * gate waits instead of defaulting to a side.
 */
export function observeDecision(claimInput: unknown, block: bigint): DecisionObservation {
  const claim = parseOne(DecisionClaim, claimInput, 'decision claim')
  const recognised = claim.allowedValues.includes(claim.answer)
  return {
    kind: 'decision',
    block,
    answer: claim.answer,
    allowedValues: [...claim.allowedValues],
    recognised,
    probability: claim.probability,
    minProbability: claim.minProbability,
    unverifiable: recognised ? null : `answer ${JSON.stringify(claim.answer)} is not one of the allowed values`,
  }
}

/** The gate's balances at the pinned block are the position. Two reads plus the price. */
export async function observePosition(
  reader: KuruReader,
  claimInput: unknown,
  block: bigint,
): Promise<PositionObservation> {
  const claim = parseOne(PositionClaim, claimInput, 'position claim')
  const gate = claim.gate as Address
  const market = claim.market as Address
  const params = await reader.marketParams(market, block)
  const { bestBid } = await reader.bestBidAsk(market, block)
  const baseBalance = await reader.nativeBalance(gate, block)
  const positionBase = scaled(baseBalance, Number(params.baseDecimals))
  const price = scaled(bestBid, 18)
  return {
    kind: 'position',
    gate,
    market,
    block,
    baseBalance,
    quoteBestBid: price,
    positionBase,
    notionalUsd: positionBase * price,
    unverifiable: bestBid === 0n ? 'the book has no bid at the pinned block' : null,
  }
}

export async function observeTypedDecision(
  reader: KuruReader,
  claim: TypedDecisionClaim,
  block: bigint,
): Promise<TypedDecisionObservation> {
  switch (claim.kind) {
    case 'kuru_book':
      return observeKuruBook(reader, claim, block)
    case 'decision':
      return observeDecision(claim, block)
    case 'position':
      return observePosition(reader, claim, block)
  }
}

/** Observes each claim in order, one read at a time. Never concurrent, never batched. */
export async function observeTypedDecisionAll(
  reader: KuruReader,
  claims: readonly TypedDecisionClaim[],
  block: bigint,
): Promise<TypedDecisionObservation[]> {
  const out: TypedDecisionObservation[] = []
  for (const claim of claims) out.push(await observeTypedDecision(reader, claim, block))
  return out
}

// ------------------------------------------------------------------ the order the gate forwards

export type DecodedKuruOrder = {
  fn: 'batchUpdate'
  side: 'buy' | 'sell' | 'cancel-only'
  price: bigint | null
  size: bigint | null
  cancels: number
  postOnly: boolean
}

/** Decodes the batchUpdate call jev-trader sends every block, and refuses non-canonical bytes. */
export function decodeKuruOrder(data: Hex): DecodedKuruOrder {
  const decoded = decodeFunctionData({ abi: kuruOrderBookAbi, data })
  if (decoded.functionName !== 'batchUpdate') throw new Error(`calldata is ${decoded.functionName}, not batchUpdate`)
  if (encodeFunctionData({ abi: kuruOrderBookAbi, functionName: 'batchUpdate', args: decoded.args }).toLowerCase() !== data.toLowerCase()) {
    throw new Error('calldata is not the canonical encoding of its decoded arguments')
  }
  const [buyPrices, buySizes, sellPrices, sellSizes, cancels, postOnly] = decoded.args
  const buys = buyPrices.length
  const sells = sellPrices.length
  if (buys + sells > 1 || buys !== buySizes.length || sells !== sellSizes.length) {
    throw new Error('the gate forwards one order at a time')
  }
  const side = buys === 1 ? 'buy' : sells === 1 ? 'sell' : 'cancel-only'
  return {
    fn: 'batchUpdate',
    side,
    price: buys === 1 ? BigInt(buyPrices[0]!) : sells === 1 ? BigInt(sellPrices[0]!) : null,
    size: buys === 1 ? buySizes[0]! : sells === 1 ? sellSizes[0]! : null,
    cancels: cancels.length,
    postOnly,
  }
}

export { parseTypedDecisionClaims }
