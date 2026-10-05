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

export type LocateResult = {
  located: LocatedTx | Unlocated
  /** Zerion data, recorded under "context" only. */
  context: {
    transaction: ZerionTransaction | null
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

function windowOf(record: ClaimRecordV0, options: LocateOptions) {
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

/**
 * Finds the action a statement refers to (PREREG Amendment 1, "Which transaction").
 * With tx_hash, the action is that transaction, checked on chain with no window. Without it,
 * Zerion lists candidate hashes in the window and every candidate is checked on chain: the
 * record is LOCATED only when exactly one passes. The nearest match is never chosen. The chain
 * decides sender, success, target, method, block, and timestamp.
 */
export async function locate(
  record: ClaimRecordV0,
  deps: { zerion: Pick<ZerionClient, 'listTransactions'>; tx: TxReader; chainId: number; options?: Partial<LocateOptions> },
): Promise<LocateResult> {
  if (record.tx_hash !== undefined) return locateByHash(record, record.tx_hash.toLowerCase() as Hex, deps.tx)

  const options = { ...DEFAULT_LOCATE_OPTIONS, ...deps.options }
  const { postedMs, fromMs, toMs } = windowOf(record, options)
  const emptyListing = { pages: 0, truncated: false, listed: 0, candidates: 0, checkedOnChain: 0 }
  const unlocated = (reason: string, listing = emptyListing): LocateResult => ({
    located: { status: 'UNLOCATED', reason },
    context: { transaction: null, listing },
  })

  let listing
  try {
    listing = await deps.zerion.listTransactions(record.agent.wallet, {
      chain: deps.chainId,
      from: new Date(fromMs),
      to: new Date(toMs),
    })
  } catch (error) {
    if (error instanceof ZerionUnsupportedChain) return unlocated(error.message)
    throw error
  }

  const candidates = listing.transactions
    .filter((t) => HASH.test(t.attributes?.hash ?? ''))
    .filter((t) => t.attributes?.status === 'confirmed')
    .filter((t) => t.attributes?.sent_from === undefined || sameAddress(t.attributes.sent_from, record.agent.wallet))
    .filter((t) => {
      const at = Date.parse(t.attributes.mined_at ?? '')
      return Number.isFinite(at) && at >= fromMs && at <= toMs
    })
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
    if (tx === null || mismatch(record, tx) !== null) continue
    const ts = await deps.tx.getBlockTimestamp(tx.blockNumber)
    const tsMs = Number(ts) * 1000
    if (tsMs < fromMs || tsMs > toMs) continue
    matches.push({ tx, ts, zerion: t })
  }

  if (matches.length === 0) return unlocated(NO_MATCH, stats)
  if (matches.length > 1) return unlocated(`ambiguous: ${matches.length} transactions match`, stats)
  const only = matches[0]!
  return { located: locatedFrom(only.tx, only.ts, postedMs), context: { transaction: only.zerion, listing: stats } }
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
    return { located: { status: 'UNLOCATED', reason: reason ?? 'transaction not found on chain' }, context: { transaction: null, listing } }
  }
  const ts = await tx.getBlockTimestamp(info.blockNumber)
  return { located: locatedFrom(info, ts, Date.parse(record.posted_at)), context: { transaction: null, listing } }
}
