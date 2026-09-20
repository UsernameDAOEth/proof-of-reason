import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locate } from '../src/locate.ts'
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
import type { ChainTx } from './helpers.ts'

beforeEach(() => {
  process.env.ZERION_API_KEY = 'zk_test_locate'
})
afterEach(() => {
  delete process.env.ZERION_API_KEY
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

describe('locate', () => {
  it('picks the transaction closest to posted_at and pins its block', async () => {
    const offsets = [300, -120, -1800]
    const { result } = await run(
      offsets.map((o, i) => ztx(i + 1, o)),
      offsets.map((o, i) => ({ n: i + 1, offsetSeconds: o })),
    )
    expect(result.located).toMatchObject({ status: 'LOCATED', txHash: hash(2), blockNumber: blockAt(-120), deltaSeconds: -120 })
    expect(result.context.transaction?.attributes.hash).toBe(hash(2))
  })

  it('breaks a tie toward the earlier transaction', async () => {
    const { result } = await run([ztx(1, 60), ztx(2, -60)], [{ n: 1, offsetSeconds: 60 }, { n: 2, offsetSeconds: -60 }])
    expect(result.located).toMatchObject({ txHash: hash(2) })
  })

  it('includes the window edges and excludes one second beyond them', async () => {
    const inside = await run(
      [ztx(1, -3600), ztx(2, 3600)],
      [
        { n: 1, offsetSeconds: -3600, timestamp: BigInt(POSTED_S - 3600) },
        { n: 2, offsetSeconds: 3600, timestamp: BigInt(POSTED_S + 3600) },
      ],
    )
    expect(inside.result.located).toMatchObject({ status: 'LOCATED', txHash: hash(1) })

    const outside = await run(
      [ztx(1, -3601), ztx(2, 3601)],
      [
        { n: 1, offsetSeconds: -3601, timestamp: BigInt(POSTED_S - 3601) },
        { n: 2, offsetSeconds: 3601, timestamp: BigInt(POSTED_S + 3601) },
      ],
    )
    expect(outside.result.located).toEqual({
      status: 'UNLOCATED',
      reason: 'no confirmed transaction from the wallet within the window',
    })
  })

  it('uses a record window and a configured window', async () => {
    const listed = [ztx(1, -5000)]
    const chain = [{ n: 1, offsetSeconds: -5000 }]
    expect((await run(listed, chain)).result.located.status).toBe('UNLOCATED')
    expect((await run(listed, chain, { window: { beforeSeconds: 6000, afterSeconds: 0 } })).result.located.status).toBe('LOCATED')
    expect((await run(listed, chain, {}, { windowBeforeSeconds: 6000 })).result.located.status).toBe('LOCATED')
  })

  it('skips a closer transaction to another contract when the record names a target', async () => {
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
    expect(result.located).toEqual({ status: 'UNLOCATED', reason: 'no candidate matched the record on chain' })
  })

  it('checks at most maxCandidates transactions on chain', async () => {
    const listed = [ztx(1, -10), ztx(2, -20), ztx(3, -30)]
    const chain = [
      { n: 1, offsetSeconds: -10, from: OTHER },
      { n: 2, offsetSeconds: -20, from: OTHER },
      { n: 3, offsetSeconds: -30 },
    ]
    const { result, tx } = await run(listed, chain, {}, { maxCandidates: 2 })
    expect(result.located.status).toBe('UNLOCATED')
    expect(tx.calls.filter((c) => c.startsWith('tx:'))).toHaveLength(2)
  })

  it('is UNLOCATED with no transactions, or on a chain Zerion does not list', async () => {
    expect((await run([], [])).result.located).toEqual({
      status: 'UNLOCATED',
      reason: 'no confirmed transaction from the wallet within the window',
    })
    const monad = await run([ztx(1, -10)], [{ n: 1, offsetSeconds: -10 }], { chain: 'monad' }, {}, 143)
    expect(monad.result.located).toEqual({ status: 'UNLOCATED', reason: 'chain 143 is not in the Zerion chain catalog' })
  })

  it('records the chain block timestamp of the located transaction', async () => {
    const { result } = await run([ztx(1, -120)], [{ n: 1, offsetSeconds: -120 }])
    expect(result.located).toMatchObject({ blockTimestamp: tsOf(blockAt(-120)) })
  })
})
