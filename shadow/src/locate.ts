import type { Address, Hex } from 'viem'
import type { TxInfo, TxReader } from './chain.ts'
import type { ClaimRecordV0 } from './record.ts'
import { methodSelector } from './record.ts'
import { ZerionUnsupportedChain } from './zerion.ts'
import type { ZerionClient, ZerionTransaction } from './zerion.ts'

export type LocateOptions = {
  /** Seconds before posted_at to search. A record's own window overrides. */
  windowBeforeSeconds: number
  /** Seconds after posted_at to search. A record's own window overrides. */
  windowAfterSeconds: number
  /** Every candidate is checked on chain; more candidates than this and uniqueness is not checked. */
  maxCandidates: number
}

export const DEFAULT_LOCATE_OPTIONS: LocateOptions = {
  windowBeforeSeconds: 3600,
  windowAfterSeconds: 3600,
  maxCandidates: 25,
}

export const NO_MATCH = 'no matching transaction in the window'

export type LocatedTx = {
  status: 'LOCATED'
  txHash: Hex
  blockNumber: bigint
  blockTimestamp: bigint
  from: Address
  to: Address | null
  selector: Hex | null
  /** Chain block timestamp minus posted_at, in seconds. */
  deltaSeconds: number
}

export type Unlocated = { status: 'UNLOCATED'; reason: string }

/**
 * The chain's proof that the Zerion listing was complete: the window's first and last blocks, and
 * the wallet's nonce at the block before the first and at the last. The difference is how many
 * transactions the wallet sent in the window, failed ones included. Sealed in the record.
 */
export type Completeness = {
  firstBlock: bigint
  lastBlock: bigint
  nonceBeforeFirst: bigint
  nonceAtLast: bigint
}

/** Thrown, so nothing is sealed, while the window has not closed before the chain head. */
export class WindowNotClosed extends Error {
  constructor(windowEnd: Date, head: Date) {
    super(`the window ends at ${windowEnd.toISOString()}, not before the chain head at ${head.toISOString()}; audit after it closes`)
    this.name = 'WindowNotClosed'
  }
}

export type LocateResult = {
  located: LocatedTx | Unlocated
  /** Set when the record was located without tx_hash; null otherwise. */
  completeness: Completeness | null
  /** Zerion data, recorded under "context" only. */
  context: {
    transaction: ZerionTransaction | null
    /** candidates: N, the listed transactions sent from the wallet in the window, of any mined status. */
    listing: { pages: number; truncated: boolean; listed: number; candidates: number; checkedOnChain: number }
  }
}

const HASH = /^0x[0-9a-fA-F]{64}$/

function selectorOf(input: Hex): Hex | null {
  return input.length >= 10 ? (input.slice(0, 10).toLowerCase() as Hex) : null
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/** Checks one transaction against the record on chain. Returns why it fails, or null. */
function mismatch(record: ClaimRecordV0, tx: TxInfo | null): string | null {
  if (tx === null) return 'transaction not found on chain'
  if (!sameAddress(tx.from, record.agent.wallet)) return 'sender is not the agent wallet'
  if (!tx.success) return 'transaction reverted'
  if (record.target?.contract !== undefined && !sameAddress(tx.to, record.target.contract)) return 'target contract differs'
  if (record.target?.method !== undefined && selectorOf(tx.input) !== methodSelector(record.target.method)) {
    return 'target method differs'
  }
  return null
}

export function windowOf(record: ClaimRecordV0, options: LocateOptions = DEFAULT_LOCATE_OPTIONS) {
  const postedMs = Date.parse(record.posted_at)
  const before = record.window?.beforeSeconds ?? options.windowBeforeSeconds
  const after = record.window?.afterSeconds ?? options.windowAfterSeconds
  return { postedMs, fromMs: postedMs - before * 1000, toMs: postedMs + after * 1000 }
}

function locatedFrom(tx: TxInfo, timestamp: bigint, postedMs: number): LocatedTx {
  return {
    status: 'LOCATED',
    txHash: tx.hash.toLowerCase() as Hex,
    blockNumber: tx.blockNumber,
    blockTimestamp: timestamp,
    from: tx.from,
    to: tx.to,
    selector: selectorOf(tx.input),
    deltaSeconds: Number(timestamp) - Math.floor(postedMs / 1000),
  }
}

type Timestamps = (block: bigint) => Promise<bigint>

/** Block timestamps read one at a time, each block at most once. */
function timestampReader(tx: TxReader): Timestamps {
  const seen = new Map<bigint, bigint>()
  return async (block) => {
    const known = seen.get(block)
    if (known !== undefined) return known
    const ts = await tx.getBlockTimestamp(block)
    seen.set(block, ts)
    return ts
  }
}

/** The first block in [0, head] whose timestamp (ms) satisfies `after`, or head + 1. Timestamps never decrease. */
async function firstBlockWhere(ts: Timestamps, head: bigint, after: (ms: bigint) => boolean): Promise<bigint> {
  let lo = 0n
  let hi = head + 1n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (after((await ts(mid)) * 1000n)) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/**
 * The window's boundary blocks by binary search on block timestamps: the first block at or after
 * the window start and the last block at or before the window end. Several blocks may share a
 * timestamp. Reads are sequential, one request each.
 */
export async function windowBlocks(
  tx: TxReader,
  head: bigint,
  fromMs: number,
  toMs: number,
): Promise<{ firstBlock: bigint; lastBlock: bigint }> {
  const ts = timestampReader(tx)
  const firstBlock = await firstBlockWhere(ts, head, (ms) => ms >= BigInt(fromMs))
  const lastBlock = (await firstBlockWhere(ts, head, (ms) => ms > BigInt(toMs))) - 1n
  return { firstBlock, lastBlock }
}

/** The wallet's nonce at the block before `firstBlock` and at `lastBlock`. */
export async function windowNonces(tx: TxReader, wallet: Address, firstBlock: bigint, lastBlock: bigint) {
  const nonceBeforeFirst = firstBlock === 0n ? 0n : await tx.getNonce(wallet, firstBlock - 1n)
  const nonceAtLast = lastBlock < 0n ? 0n : await tx.getNonce(wallet, lastBlock)
  return { nonceBeforeFirst, nonceAtLast }
}

/**
 * Finds the action a statement refers to (PREREG Amendment 1, "Which transaction").
 * With tx_hash, the action is that transaction, checked on chain with no window.
 * Without it, the window must have closed before the chain head (else WindowNotClosed is thrown).
 * The chain gives the window's boundary blocks and, from the wallet's nonce, M: how many
 * transactions the wallet sent in it. Zerion proposes the transactions to check; unless it lists
 * exactly M sent from the wallet, each placed in the window by the chain, the record is
 * UNLOCATED. Only then is every one checked, and the record is LOCATED only when exactly one
 * matches. The nearest match is never chosen, and Zerion can make a record UNLOCATED but never
 * LOCATED: the chain decides sender, success, target, method, block, and timestamp.
 */
export async function locate(
  record: ClaimRecordV0,
  deps: { zerion: Pick<ZerionClient, 'listTransactions'>; tx: TxReader; chainId: number; options?: Partial<LocateOptions> },
): Promise<LocateResult> {
  if (record.tx_hash !== undefined) return locateByHash(record, record.tx_hash.toLowerCase() as Hex, deps.tx)

  const options = { ...DEFAULT_LOCATE_OPTIONS, ...deps.options }
  const { postedMs, fromMs, toMs } = windowOf(record, options)
  const wallet = record.agent.wallet as Address

  const head = await deps.tx.getHead()
  if (BigInt(toMs) >= head.timestamp * 1000n) throw new WindowNotClosed(new Date(toMs), new Date(Number(head.timestamp) * 1000))
  const { firstBlock, lastBlock } = await windowBlocks(deps.tx, head.number, fromMs, toMs)
  const completeness: Completeness = { firstBlock, lastBlock, ...(await windowNonces(deps.tx, wallet, firstBlock, lastBlock)) }
  const sent = completeness.nonceAtLast - completeness.nonceBeforeFirst

  const emptyListing = { pages: 0, truncated: false, listed: 0, candidates: 0, checkedOnChain: 0 }
  const unlocated = (reason: string, listing = emptyListing): LocateResult => ({
    located: { status: 'UNLOCATED', reason },
    completeness,
    context: { transaction: null, listing },
  })

  let listing
  try {
    listing = await deps.zerion.listTransactions(wallet, { chain: deps.chainId, from: new Date(fromMs), to: new Date(toMs) })
  } catch (error) {
    if (error instanceof ZerionUnsupportedChain) return unlocated(error.message)
    throw error
  }

  // N: distinct listed transactions sent from the wallet in the window, of any mined status.
  const byHash = new Map<string, ZerionTransaction>()
  for (const t of listing.transactions) {
    const a = t.attributes
    if (!HASH.test(a?.hash ?? '')) continue
    if (a.status !== 'confirmed' && a.status !== 'failed') continue
    if (!sameAddress(a.sent_from, wallet)) continue
    const at = Date.parse(a.mined_at ?? '')
    if (!Number.isFinite(at) || at < fromMs || at > toMs) continue
    if (!byHash.has(a.hash!.toLowerCase())) byHash.set(a.hash!.toLowerCase(), t)
  }
  const candidates = [...byHash.values()]
  const stats = {
    pages: listing.pages,
    truncated: listing.truncated,
    listed: listing.transactions.length,
    candidates: candidates.length,
    checkedOnChain: 0,
  }

  if (listing.truncated) {
    return unlocated('the Zerion listing was truncated, so uniqueness could not be checked', stats)
  }
  if (BigInt(candidates.length) !== sent) {
    return unlocated(`Zerion listed ${candidates.length} of ${sent} transactions the wallet sent in the window`, stats)
  }
  if (candidates.length > options.maxCandidates) {
    return unlocated(
      `${candidates.length} candidates exceed maxCandidates ${options.maxCandidates}, so uniqueness could not be checked`,
      stats,
    )
  }

  const matches: { tx: TxInfo; ts: bigint; zerion: ZerionTransaction }[] = []
  for (const t of candidates) {
    const tx = await deps.tx.getTransaction(t.attributes.hash as Hex)
    stats.checkedOnChain++
    // The count proves completeness only if the chain confirms each listed one as the wallet's, in the window.
    if (tx === null || !sameAddress(tx.from, wallet) || tx.blockNumber < firstBlock || tx.blockNumber > lastBlock) {
      return unlocated(`the chain does not place listed transaction ${t.attributes.hash} as sent by the wallet in the window`, stats)
    }
    if (mismatch(record, tx) !== null) continue
    const ts = await deps.tx.getBlockTimestamp(tx.blockNumber)
    const tsMs = Number(ts) * 1000
    if (tsMs < fromMs || tsMs > toMs) continue
    matches.push({ tx, ts, zerion: t })
  }

  if (matches.length === 0) return unlocated(NO_MATCH, stats)
  if (matches.length > 1) return unlocated(`ambiguous: ${matches.length} transactions match`, stats)
  const only = matches[0]!
  return { located: locatedFrom(only.tx, only.ts, postedMs), completeness, context: { transaction: only.zerion, listing: stats } }
}

/**
 * Locates a record by a transaction hash, from the chain alone: the hash the statement gives, or
 * the recorded hash when a record is re-run without Zerion (docs/SHADOW.md). No window applies.
 */
export async function locateByHash(record: ClaimRecordV0, hash: Hex, tx: TxReader): Promise<LocateResult> {
  const info = await tx.getTransaction(hash)
  const reason = mismatch(record, info)
  const listing = { pages: 0, truncated: false, listed: 0, candidates: 1, checkedOnChain: 1 }
  if (reason !== null || info === null) {
    return {
      located: { status: 'UNLOCATED', reason: reason ?? 'transaction not found on chain' },
      completeness: null,
      context: { transaction: null, listing },
    }
  }
  const ts = await tx.getBlockTimestamp(info.blockNumber)
  return { located: locatedFrom(info, ts, Date.parse(record.posted_at)), completeness: null, context: { transaction: null, listing } }
}
