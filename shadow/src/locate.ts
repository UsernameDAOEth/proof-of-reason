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
  /** At most this many candidates, closest to posted_at by Zerion time, are checked on chain. */
  maxCandidates: number
}

export const DEFAULT_LOCATE_OPTIONS: LocateOptions = {
  windowBeforeSeconds: 3600,
  windowAfterSeconds: 3600,
  maxCandidates: 25,
}

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
function mismatch(record: ClaimRecordV0, tx: TxInfo): string | null {
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
 * Finds the agent's transaction closest to posted_at within the window. Zerion only lists
 * candidate hashes. The chain decides sender, success, target, method, block, and timestamp,
 * and the chain timestamp decides "closest". Ties go to the earlier transaction.
 */
export async function locate(
  record: ClaimRecordV0,
  deps: { zerion: Pick<ZerionClient, 'listTransactions'>; tx: TxReader; chainId: number; options?: Partial<LocateOptions> },
): Promise<LocateResult> {
  const options = { ...DEFAULT_LOCATE_OPTIONS, ...deps.options }
  const { postedMs, fromMs, toMs } = windowOf(record, options)
  const emptyListing = { pages: 0, truncated: false, listed: 0, candidates: 0, checkedOnChain: 0 }

  let listing
  try {
    listing = await deps.zerion.listTransactions(record.agent.wallet, {
      chain: deps.chainId,
      from: new Date(fromMs),
      to: new Date(toMs),
    })
  } catch (error) {
    if (error instanceof ZerionUnsupportedChain) {
      return { located: { status: 'UNLOCATED', reason: error.message }, context: { transaction: null, listing: emptyListing } }
    }
    throw error
  }

  const candidates = listing.transactions
    .filter((t) => HASH.test(t.attributes?.hash ?? ''))
    .filter((t) => t.attributes?.status === 'confirmed')
    .filter((t) => t.attributes?.sent_from === undefined || sameAddress(t.attributes.sent_from, record.agent.wallet))
    .map((t) => ({ t, at: Date.parse(t.attributes.mined_at ?? '') }))
    .filter(({ at }) => Number.isFinite(at) && at >= fromMs && at <= toMs)
    .sort((a, b) => Math.abs(a.at - postedMs) - Math.abs(b.at - postedMs) || a.at - b.at || a.t.attributes.hash!.localeCompare(b.t.attributes.hash!))
    .slice(0, options.maxCandidates)

  const verified: { tx: TxInfo; ts: bigint; zerion: ZerionTransaction }[] = []
  for (const { t } of candidates) {
    const tx = await deps.tx.getTransaction(t.attributes.hash as Hex)
    if (mismatch(record, tx) !== null) continue
    const ts = await deps.tx.getBlockTimestamp(tx.blockNumber)
    const tsMs = Number(ts) * 1000
    if (tsMs < fromMs || tsMs > toMs) continue
    verified.push({ tx, ts, zerion: t })
  }
  const stats = {
    pages: listing.pages,
    truncated: listing.truncated,
    listed: listing.transactions.length,
    candidates: candidates.length,
    checkedOnChain: candidates.length,
  }

  verified.sort(
    (a, b) =>
      Math.abs(Number(a.ts) * 1000 - postedMs) - Math.abs(Number(b.ts) * 1000 - postedMs) ||
      Number(a.ts - b.ts) ||
      Number(a.tx.blockNumber - b.tx.blockNumber) ||
      a.tx.hash.localeCompare(b.tx.hash),
  )
  const best = verified[0]
  if (best === undefined) {
    const reason =
      candidates.length === 0
        ? `no confirmed transaction from the wallet within the window${listing.truncated ? ' (listing truncated)' : ''}`
        : 'no candidate matched the record on chain'
    return { located: { status: 'UNLOCATED', reason }, context: { transaction: null, listing: stats } }
  }
  return { located: locatedFrom(best.tx, best.ts, postedMs), context: { transaction: best.zerion, listing: stats } }
}

/**
 * Re-locates a recorded transaction by its hash, from the chain alone. Used to re-run a record
 * without Zerion (docs/SHADOW.md).
 */
export async function locateByHash(record: ClaimRecordV0, hash: Hex, tx: TxReader): Promise<LocateResult> {
  const info = await tx.getTransaction(hash)
  const reason = mismatch(record, info)
  const listing = { pages: 0, truncated: false, listed: 0, candidates: 1, checkedOnChain: 1 }
  if (reason !== null) return { located: { status: 'UNLOCATED', reason }, context: { transaction: null, listing } }
  const ts = await tx.getBlockTimestamp(info.blockNumber)
  return { located: locatedFrom(info, ts, Date.parse(record.posted_at)), context: { transaction: null, listing } }
}
