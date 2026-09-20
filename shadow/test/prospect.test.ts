import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters } from 'viem'
import type { Hex } from 'viem'
import { vaultAbi } from 'proof-of-reason-engine/action'
import { prospect, prospectTable } from '../src/prospect.ts'
import { createZerionClient } from '../src/zerion.ts'
import { BASE_CHAIN_ID, FakeTxReader, OTHER, POSTED_S, REALLOCATE_DATA, VAULT, WALLET, fixture, marketParams, zerionFetch, ztx } from './helpers.ts'

beforeEach(() => {
  process.env.ZERION_API_KEY = 'zk_test_prospect'
})
afterEach(() => {
  delete process.env.ZERION_API_KEY
})

const p = marketParams()
const ALLOCATE_DATA: Hex = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'allocate',
  args: [
    OTHER,
    encodeAbiParameters(parseAbiParameters('(address,address,address,address,uint256)'), [[p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]]),
    7_000_000n,
  ],
})
const TWO_LEG_REALLOCATE: Hex = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'reallocate',
  args: [[{ marketParams: p, assets: 0n }, { marketParams: p, assets: 5n }]],
})

describe('prospect', () => {
  it('counts and sizes reallocate and allocate calls over the last 30 days, context only', async () => {
    const day = 86_400
    const listed = [
      ztx(1, -1 * day),
      ztx(2, -2 * day),
      ztx(3, -3 * day),
      ztx(4, -4 * day),
      ztx(5, -5 * day),
      ztx(6, -6 * day),
      ztx(7, -40 * day),
    ]
    const tx = new FakeTxReader([
      { n: 1, offsetSeconds: -1 * day, input: REALLOCATE_DATA },
      { n: 2, offsetSeconds: -2 * day, input: TWO_LEG_REALLOCATE },
      { n: 3, offsetSeconds: -3 * day, input: ALLOCATE_DATA, to: OTHER },
      { n: 4, offsetSeconds: -4 * day, input: ALLOCATE_DATA, to: OTHER },
      { n: 5, offsetSeconds: -5 * day, input: '0xa9059cbb' },
      { n: 6, offsetSeconds: -6 * day, input: REALLOCATE_DATA, success: false },
      { n: 7, offsetSeconds: -40 * day, input: REALLOCATE_DATA },
    ])
    const routes = { '/v1/chains/': fixture('chains.json'), [`/v1/wallets/${WALLET}/transactions/`]: { links: { next: null }, data: listed } }
    const { rows, truncated } = await prospect([WALLET], {
      zerion: createZerionClient({ fetch: zerionFetch(routes) }),
      tx,
      chainId: BASE_CHAIN_ID,
      now: new Date(POSTED_S * 1000),
    })
    expect(truncated).toBe(false)
    expect(rows.map((r) => [r.vault, r.method, r.calls, r.legs, r.assets])).toEqual([
      [VAULT, 'reallocate', 2, 3, 0n],
      [OTHER, 'allocate', 2, 0, 14_000_000n],
    ])
    expect(tx.calls.filter((c) => c.startsWith('tx:'))).toHaveLength(6)
    const table = prospectTable(rows)
    expect(table.split('\n')[0]).toBe('| Address | Vault | Method | Calls | Legs | Assets (atomic) | First | Last |')
    expect(table).toContain(`| ${WALLET} | ${VAULT} | reallocate | 2 | 3 | 0 |`)
  })
})
