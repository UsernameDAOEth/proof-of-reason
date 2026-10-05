import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_MATCH, locate } from '../src/locate.ts'
import { parseClaimRecord } from '../src/record.ts'
import { createZerionClient } from '../src/zerion.ts'
import type { ZerionTransaction } from '../src/zerion.ts'
import {
  BASE_CHAIN_ID,
  FakeTxReader,
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
    const { result } = await run([ztx(1, -60)], [{ n: 1, offsetSeconds: -60, from: OTHER }])
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
    expect(tx.calls).toEqual([])
  })

  it('more candidates than maxCandidates is UNLOCATED: uniqueness could not be checked', async () => {
    const listed = [ztx(1, -10), ztx(2, -20), ztx(3, -30)]
    const chain = [
      { n: 1, offsetSeconds: -10, from: OTHER },
      { n: 2, offsetSeconds: -20, from: OTHER },
      { n: 3, offsetSeconds: -30 },
    ]
    const over = await run(listed, chain, {}, { maxCandidates: 2 })
    expect(over.result.located).toEqual({
      status: 'UNLOCATED',
      reason: '3 candidates exceed maxCandidates 2, so uniqueness could not be checked',
    })
    expect(over.tx.calls).toEqual([])
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

  it('ignores failed transactions and other senders, from Zerion and from the chain', async () => {
    const { result } = await run(
      [ztx(1, -10, { status: 'failed' }), ztx(2, -20, { sent_from: OTHER }), ztx(3, -30), ztx(4, -40), ztx(5, -900)],
      [
        { n: 3, offsetSeconds: -30, from: OTHER },
        { n: 4, offsetSeconds: -40, success: false },
        { n: 5, offsetSeconds: -900 },
      ],
    )
    expect(result.located).toMatchObject({ txHash: hash(5) })
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
