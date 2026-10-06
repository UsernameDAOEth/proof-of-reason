import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_MATCH, WindowNotClosed, locate, windowBlocks } from '../src/locate.ts'
import type { TxReader } from '../src/chain.ts'
import { parseClaimRecord } from '../src/record.ts'
import { createZerionClient } from '../src/zerion.ts'
import type { ZerionTransaction } from '../src/zerion.ts'
import {
  BASE_CHAIN_ID,
  FakeTxReader,
  GENESIS_S,
  OTHER,
  POSTED_S,
  VAULT,
  blockAt,
  claimRecord,
  hash,
  listingRoutes,
  tsOf,
  zerionFetch,
  ztx,
} from './helpers.ts'
import type { ChainTx, Seen } from './helpers.ts'

beforeEach(() => {
  process.env.ZERION_API_KEY = 'zk_test_locate'
})
afterEach(() => {
  delete process.env.ZERION_API_KEY
})

/** A fake Zerion client whose listing reports itself truncated. */
const truncatedZerion = (transactions: ZerionTransaction[]) => ({
  listTransactions: async () => ({ transactions, pages: 50, truncated: true }),
})

async function run(
  listed: ZerionTransaction[],
  chain: ChainTx[],
  recordOverrides: Record<string, unknown> = {},
  options: Record<string, number> = {},
  chainId = BASE_CHAIN_ID,
) {
  const tx = new FakeTxReader(chain)
  const zerion = createZerionClient({ fetch: zerionFetch(listingRoutes(listed)) })
  const result = await locate(parseClaimRecord(claimRecord(recordOverrides)), { zerion, tx, chainId, options })
  return { result, tx }
}

describe('locate without tx_hash: exactly one match in the window, never the nearest', () => {
  it('zero matching candidates is UNLOCATED', async () => {
    const { result } = await run([ztx(1, -60)], [{ n: 1, offsetSeconds: -60, to: OTHER }])
    expect(result.located).toEqual({ status: 'UNLOCATED', reason: NO_MATCH })
  })

  it('one matching candidate is LOCATED at its block, even when it is not the nearest listed', async () => {
    const offsets = [300, -120, -1800]
    const { result } = await run(
      offsets.map((o, i) => ztx(i + 1, o)),
      [
        { n: 1, offsetSeconds: 300, success: false },
        { n: 2, offsetSeconds: -120, to: OTHER },
        { n: 3, offsetSeconds: -1800 },
      ],
    )
    expect(result.located).toMatchObject({ status: 'LOCATED', txHash: hash(3), blockNumber: blockAt(-1800), deltaSeconds: -1800 })
    expect(result.context.transaction?.attributes.hash).toBe(hash(3))
    expect(result.context.listing).toMatchObject({ candidates: 3, checkedOnChain: 3 })
  })

  it('two or more matching candidates are ambiguous, and the nearest is not chosen', async () => {
    const two = await run([ztx(1, 60), ztx(2, -60)], [{ n: 1, offsetSeconds: 60 }, { n: 2, offsetSeconds: -60 }])
    expect(two.result.located).toEqual({ status: 'UNLOCATED', reason: 'ambiguous: 2 transactions match' })
    const offsets = [300, -120, -1800]
    const three = await run(
      offsets.map((o, i) => ztx(i + 1, o)),
      offsets.map((o, i) => ({ n: i + 1, offsetSeconds: o })),
    )
    expect(three.result.located).toEqual({ status: 'UNLOCATED', reason: 'ambiguous: 3 transactions match' })
  })

  it('a truncated Zerion listing is UNLOCATED: uniqueness could not be checked', async () => {
    const tx = new FakeTxReader([{ n: 1, offsetSeconds: -60 }])
    const result = await locate(parseClaimRecord(claimRecord()), { zerion: truncatedZerion([ztx(1, -60)]), tx, chainId: BASE_CHAIN_ID })
    expect(result.located).toEqual({
      status: 'UNLOCATED',
      reason: 'the Zerion listing was truncated, so uniqueness could not be checked',
    })
    expect(tx.calls.filter((c) => c.startsWith('tx:'))).toEqual([])
  })

  it('more candidates than maxCandidates is UNLOCATED: uniqueness could not be checked', async () => {
    const listed = [ztx(1, -10), ztx(2, -20), ztx(3, -30)]
    const chain = [
      { n: 1, offsetSeconds: -10, to: OTHER },
      { n: 2, offsetSeconds: -20, to: OTHER },
      { n: 3, offsetSeconds: -30 },
    ]
    const over = await run(listed, chain, {}, { maxCandidates: 2 })
    expect(over.result.located).toEqual({
      status: 'UNLOCATED',
      reason: '3 candidates exceed maxCandidates 2, so uniqueness could not be checked',
    })
    expect(over.tx.calls.filter((c) => c.startsWith('tx:'))).toEqual([])
    const at = await run(listed, chain, {}, { maxCandidates: 3 })
    expect(at.result.located).toMatchObject({ status: 'LOCATED', txHash: hash(3) })
    expect(at.tx.calls.filter((c) => c.startsWith('tx:'))).toHaveLength(3)
  })

  it('includes the window edges and excludes one second beyond them', async () => {
    for (const edge of [-3600, 3600]) {
      const { result } = await run([ztx(1, edge)], [{ n: 1, offsetSeconds: edge, timestamp: BigInt(POSTED_S + edge) }])
      expect(result.located).toMatchObject({ status: 'LOCATED', txHash: hash(1) })
    }
    const outside = await run(
      [ztx(1, -3601), ztx(2, 3601)],
      [
        { n: 1, offsetSeconds: -3601, timestamp: BigInt(POSTED_S - 3601) },
        { n: 2, offsetSeconds: 3601, timestamp: BigInt(POSTED_S + 3601) },
      ],
    )
    expect(outside.result.located).toEqual({ status: 'UNLOCATED', reason: NO_MATCH })
  })

  it('uses a record window and a configured window', async () => {
    const listed = [ztx(1, -5000)]
    const chain = [{ n: 1, offsetSeconds: -5000 }]
    expect((await run(listed, chain)).result.located.status).toBe('UNLOCATED')
    expect((await run(listed, chain, { window: { beforeSeconds: 6000, afterSeconds: 0 } })).result.located.status).toBe('LOCATED')
    expect((await run(listed, chain, {}, { windowBeforeSeconds: 6000 })).result.located.status).toBe('LOCATED')
  })

  it('a transaction to another contract does not match when the record names a target', async () => {
    const { result } = await run(
      [ztx(1, -30, { sent_to: OTHER }), ztx(2, -600)],
      [
        { n: 1, offsetSeconds: -30, to: OTHER },
        { n: 2, offsetSeconds: -600 },
      ],
    )
    expect(result.located).toMatchObject({ txHash: hash(2), to: VAULT })
  })

  it('matches the method by selector or by signature, from the calldata on chain', async () => {
    const listed = [ztx(1, -30), ztx(2, -600)]
    const chain = [
      { n: 1, offsetSeconds: -30, input: '0xdeadbeef' as const },
      { n: 2, offsetSeconds: -600 },
    ]
    const bySignature = await run(listed, chain)
    expect(bySignature.result.located).toMatchObject({ txHash: hash(2), selector: '0x7299aa31' })
    const bySelector = await run(listed, chain, { target: { method: '0xdeadbeef' } })
    expect(bySelector.result.located).toMatchObject({ txHash: hash(1), selector: '0xdeadbeef' })
  })

  it('checks failed transactions on chain and ignores other senders', async () => {
    const { result } = await run(
      [ztx(1, -10, { status: 'failed' }), ztx(2, -20, { sent_from: OTHER }), ztx(4, -40), ztx(5, -900)],
      [
        { n: 1, offsetSeconds: -10, success: false },
        { n: 2, offsetSeconds: -20, from: OTHER },
        { n: 4, offsetSeconds: -40, success: false },
        { n: 5, offsetSeconds: -900 },
      ],
    )
    expect(result.located).toMatchObject({ txHash: hash(5) })
    expect(result.context.listing).toMatchObject({ candidates: 3, checkedOnChain: 3 })
  })

  it('trusts the chain timestamp over Zerion mined_at', async () => {
    const { result } = await run([ztx(1, -60)], [{ n: 1, offsetSeconds: -60, timestamp: BigInt(POSTED_S - 7200) }])
    expect(result.located).toEqual({ status: 'UNLOCATED', reason: NO_MATCH })
  })

  it('is UNLOCATED with no transactions, or on a chain Zerion does not list', async () => {
    expect((await run([], [])).result.located).toEqual({ status: 'UNLOCATED', reason: NO_MATCH })
    const monad = await run([ztx(1, -10)], [{ n: 1, offsetSeconds: -10 }], { chain: 'monad' }, {}, 143)
    expect(monad.result.located).toEqual({ status: 'UNLOCATED', reason: 'chain 143 is not in the Zerion chain catalog' })
  })

  it('records the chain block timestamp of the located transaction', async () => {
    const { result } = await run([ztx(1, -120)], [{ n: 1, offsetSeconds: -120 }])
    expect(result.located).toMatchObject({ blockTimestamp: tsOf(blockAt(-120)) })
  })
})

describe('locate with tx_hash: the transaction the statement gives', () => {
  const withHash = (n: number, extra: Record<string, unknown> = {}) => ({
    tx_hash: hash(n),
    // Upper-case hex in the statement: the tx_hash check ignores case.
    source_text: `Rebalanced into the higher-yield market, tx 0x${hash(n).slice(2).toUpperCase()}.`,
    ...extra,
  })

  it('locates that transaction with no window check and no Zerion request', async () => {
    const seen: Seen[] = []
    const tx = new FakeTxReader([{ n: 0xabcdef, offsetSeconds: -86_400 * 3 }, { n: 8, offsetSeconds: -60 }])
    const zerion = createZerionClient({ fetch: zerionFetch(listingRoutes([ztx(8, -60)]), seen) })
    const result = await locate(parseClaimRecord(claimRecord(withHash(0xabcdef))), { zerion, tx, chainId: BASE_CHAIN_ID })
    expect(result.located).toMatchObject({
      status: 'LOCATED',
      txHash: hash(0xabcdef),
      blockNumber: blockAt(-86_400 * 3),
      deltaSeconds: -86_400 * 3,
    })
    expect(seen).toEqual([])
    expect(tx.calls).toEqual([`tx:${hash(0xabcdef)}`, `ts:${blockAt(-86_400 * 3)}`])
  })

  it('is UNLOCATED with the reason when the chain check fails', async () => {
    const cases: [ChainTx[], string][] = [
      [[], 'transaction not found on chain'],
      [[{ n: 7, offsetSeconds: -60, from: OTHER }], 'sender is not the agent wallet'],
      [[{ n: 7, offsetSeconds: -60, success: false }], 'transaction reverted'],
      [[{ n: 7, offsetSeconds: -60, to: OTHER }], 'target contract differs'],
      [[{ n: 7, offsetSeconds: -60, input: '0xdeadbeef' }], 'target method differs'],
    ]
    for (const [chain, reason] of cases) {
      const { result } = await run([], chain, withHash(7))
      expect(result.located).toEqual({ status: 'UNLOCATED', reason })
    }
  })
})

describe('locate without tx_hash: the nonce proves the Zerion listing is complete', () => {
  const window = { from: blockAt(-3600), to: blockAt(3600) }

  it('refuses to audit until the window has closed before the chain head', async () => {
    for (const head of [blockAt(3600), blockAt(3000)]) {
      const tx = new FakeTxReader([{ n: 1, offsetSeconds: -60 }], head)
      const zerion = createZerionClient({ fetch: zerionFetch(listingRoutes([ztx(1, -60)])) })
      const error = await locate(parseClaimRecord(claimRecord()), { zerion, tx, chainId: BASE_CHAIN_ID }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(WindowNotClosed)
      expect((error as Error).message).toContain('the window ends at 2026-09-10T13:00:00.000Z, not before the chain head')
      expect(tx.calls).toEqual(['head'])
    }
    const closed = await run([ztx(1, -60)], [{ n: 1, offsetSeconds: -60 }])
    expect(closed.result.located.status).toBe('LOCATED')
  })

  it('N equal to M locates, and seals the boundary blocks and both nonces', async () => {
    const { result, tx } = await run([ztx(1, -60), ztx(2, 600)], [{ n: 1, offsetSeconds: -60 }, { n: 2, offsetSeconds: 600, to: OTHER }])
    expect(result.located).toMatchObject({ status: 'LOCATED', txHash: hash(1) })
    expect(result.completeness).toEqual({ firstBlock: window.from, lastBlock: window.to, nonceBeforeFirst: 7n, nonceAtLast: 9n })
    expect(tx.calls.filter((c) => c.startsWith('nonce:'))).toEqual([`nonce:${window.from - 1n}`, `nonce:${window.to}`])
  })

  it('N one short of M is UNLOCATED, and a failed transaction counts toward M', async () => {
    const chain = [{ n: 1, offsetSeconds: -60 }, { n: 2, offsetSeconds: 600, success: false }]
    const short = await run([ztx(1, -60)], chain)
    expect(short.result.located).toEqual({ status: 'UNLOCATED', reason: 'Zerion listed 1 of 2 transactions the wallet sent in the window' })
    expect(short.tx.calls.filter((c) => c.startsWith('tx:'))).toEqual([])
    const all = await run([ztx(1, -60), ztx(2, 600, { status: 'failed' })], chain)
    expect(all.result.located).toMatchObject({ status: 'LOCATED', txHash: hash(1) })
  })

  it('N above M is UNLOCATED', async () => {
    // Zerion says the wallet sent tx 2; the chain says another address did.
    const { result } = await run([ztx(1, -60), ztx(2, 600)], [{ n: 1, offsetSeconds: -60 }, { n: 2, offsetSeconds: 600, from: OTHER }])
    expect(result.located).toEqual({ status: 'UNLOCATED', reason: 'Zerion listed 2 of 1 transactions the wallet sent in the window' })
  })

  it('counts are equal but a listed transaction is outside the window on chain: UNLOCATED, never the one left', async () => {
    // Zerion misplaces tx 2 (really before the window) and omits tx 3 (in it): N = M = 2.
    const { result } = await run(
      [ztx(1, -60), ztx(2, 600)],
      [{ n: 1, offsetSeconds: -60 }, { n: 2, offsetSeconds: -7200 }, { n: 3, offsetSeconds: 900 }],
    )
    expect(result.located).toEqual({
      status: 'UNLOCATED',
      reason: `the chain does not place listed transaction ${hash(2)} as sent by the wallet in the window`,
    })
  })

  it('pending and duplicate Zerion entries do not count toward N; other senders never do', async () => {
    const listed = [ztx(1, -60), { ...ztx(1, -60), id: `${hash(1)}-1` }, ztx(3, 60, { status: 'pending' }), ztx(4, 90, { sent_from: OTHER })]
    const { result } = await run(listed, [{ n: 1, offsetSeconds: -60 }, { n: 4, offsetSeconds: 90, from: OTHER }])
    expect(result.located).toMatchObject({ status: 'LOCATED', txHash: hash(1) })
    expect(result.context.listing).toMatchObject({ listed: 4, candidates: 1 })
  })

  it('records with tx_hash skip the head, the boundary search, and the nonces', async () => {
    const { result, tx } = await run([], [{ n: 7, offsetSeconds: -60 }], { tx_hash: hash(7), source_text: `tx ${hash(7)}` }, {}, BASE_CHAIN_ID)
    expect(result.located.status).toBe('LOCATED')
    expect(result.completeness).toBeNull()
    expect(tx.calls).toEqual([`tx:${hash(7)}`, `ts:${blockAt(-60)}`])
  })
})

describe('window boundary search', () => {
  /** A chain whose block timestamps come from a list (index = block number). */
  function chainOf(times: number[]): TxReader & { reads: bigint[] } {
    const reads: bigint[] = []
    return {
      reads,
      getTransaction: async () => null,
      getBlockTimestamp: async (b: bigint) => {
        reads.push(b)
        return BigInt(times[Number(b)]!)
      },
      getHead: async () => ({ number: BigInt(times.length - 1), timestamp: BigInt(times.at(-1)!) }),
      getNonce: async () => 0n,
    }
  }
  const ms = (s: number) => s * 1000

  it('finds the first block at or after the start and the last at or before the end, at exact edges', async () => {
    //            block: 0   1   2   3   4   5   6   7   8
    const chain = chainOf([10, 12, 14, 16, 18, 20, 22, 24, 26])
    expect(await windowBlocks(chain, 8n, ms(14), ms(20))).toEqual({ firstBlock: 2n, lastBlock: 5n })
    expect(await windowBlocks(chain, 8n, ms(13), ms(21))).toEqual({ firstBlock: 2n, lastBlock: 5n })
    expect(await windowBlocks(chain, 8n, ms(10), ms(10))).toEqual({ firstBlock: 0n, lastBlock: 0n })
    expect(await windowBlocks(chain, 8n, ms(15), ms(15))).toEqual({ firstBlock: 3n, lastBlock: 2n })
    expect(await windowBlocks(chain, 8n, ms(14) + 1, ms(20) - 1)).toEqual({ firstBlock: 3n, lastBlock: 4n })
  })

  it('includes every block that shares an edge timestamp', async () => {
    //            block: 0   1   2   3   4   5   6   7   8   9
    const chain = chainOf([10, 11, 11, 11, 12, 12, 13, 13, 13, 14])
    expect(await windowBlocks(chain, 9n, ms(11), ms(13))).toEqual({ firstBlock: 1n, lastBlock: 8n })
    expect(await windowBlocks(chain, 9n, ms(12), ms(12))).toEqual({ firstBlock: 4n, lastBlock: 5n })
    expect(await windowBlocks(chain, 9n, ms(11), ms(11))).toEqual({ firstBlock: 1n, lastBlock: 3n })
  })

  it('reads one block at a time, each at most once, and logarithmically many', async () => {
    const times = Array.from({ length: 1025 }, (_, i) => 1000 + 2 * i)
    const chain = chainOf(times)
    expect(await windowBlocks(chain, 1024n, ms(1500), ms(1700))).toEqual({ firstBlock: 250n, lastBlock: 350n })
    expect(new Set(chain.reads).size).toBe(chain.reads.length)
    expect(chain.reads.length).toBeLessThanOrEqual(2 * 11)
  })

  it('agrees with the fake chain used by the other tests', async () => {
    const tx = new FakeTxReader([])
    const from = (POSTED_S - 3600) * 1000
    const to = (POSTED_S + 3600) * 1000
    const { firstBlock, lastBlock } = await windowBlocks(tx, blockAt(86_400), from, to)
    expect(tsOf(firstBlock)).toBe(BigInt(POSTED_S - 3600))
    expect(tsOf(lastBlock)).toBe(BigInt(POSTED_S + 3600))
    expect(firstBlock).toBe((BigInt(POSTED_S - 3600) - BigInt(GENESIS_S)) / 2n)
  })
})
