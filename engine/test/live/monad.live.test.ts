import { beforeAll, describe, expect, it } from 'vitest'
import { createPublicClient, http } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import { monad } from 'viem/chains'
import type { ClaimV0 } from '../../src/claims.ts'
import { annualPct, observeAll, supplyRatePerSecondWad, viemMorphoReader } from '../../src/morpho.ts'
import type { MorphoReader } from '../../src/morpho.ts'
import { canonicalJson } from '../../src/receipt.ts'

// Read-only. Addresses from docs/MONAD.md. No keys. MONAD_RPC_URL should be the archive RPC; the
// public endpoint is the fallback default.
const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz'
const MORPHO: Address = '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee'
const MARKET: Hex = '0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439'
const MORPHO_API = 'https://api.morpho.org/graphql'

const HISTORY_MISSING = /Block requested not found|historical state that is not available|missing trie node|header not found/i

let client: PublicClient
let reader: MorphoReader
let pinned: bigint
let skipReason: string | null = null

function claims(): ClaimV0[] {
  return [
    {
      id: 'r1',
      kind: 'rate',
      sourceSpan: null,
      market: MARKET,
      side: 'supply',
      valuePct: 5,
      basis: 'APY',
      compounding: 'continuous',
      window: { type: 'instant' },
      tolerancePp: 0.5,
    },
    { id: 'u1', kind: 'utilization', sourceSpan: null, market: MARKET, valuePct: 89, tolerancePp: 1 },
    { id: 'l1', kind: 'liquidity', sourceSpan: null, market: MARKET, minWithdrawable: '1' },
    {
      id: 'i1',
      kind: 'identity',
      sourceSpan: null,
      market: MARKET,
      loanToken: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      collateralToken: '0xa08A69aB9Dd3B04D0992BC7aFb2c0b907bbdc147',
      oracle: '0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2',
      irm: '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F',
      lltv: '915000000000000000',
    },
  ]
}

beforeAll(async () => {
  // One JSON-RPC request per read: no JSON-RPC batch, no Multicall (docs/MONAD.md, RPC policy).
  client = createPublicClient({ chain: monad, transport: http(RPC_URL, { batch: false }) }) as PublicClient
  reader = viemMorphoReader(client, MORPHO)
  const head = await client.getBlockNumber()
  pinned = head - 10n
  try {
    // The observers read a 5-block window ending at the pinned block.
    await reader.market(MARKET, pinned - 5n)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (HISTORY_MISSING.test(message)) skipReason = `RPC cannot serve historical state: ${message.split('\n')[0]}`
    else throw error
  }
})

describe(`live Monad observers via ${RPC_URL}`, () => {
  it('observes one real market at a pinned block twice with identical output', async (ctx) => {
    if (skipReason) ctx.skip(skipReason)
    const first = await observeAll(reader, claims(), pinned)
    const second = await observeAll(reader, claims(), pinned)
    expect(second).toEqual(first)
    expect(canonicalJson(second)).toBe(canonicalJson(first))
    for (const obs of first) {
      expect(obs.block).toBe(pinned)
      expect(obs.unverifiable).toBeNull()
    }
    console.log(`[live] pinned block ${pinned}: ${canonicalJson(first).slice(0, 400)}...`)
  })

  it('computed native supply APY vs the Morpho API native supplyApy at the same block', async (ctx) => {
    if (skipReason) ctx.skip(skipReason)
    const response = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ marketById(marketId: "${MARKET}", chainId: 143) { state { blockNumber supplyApy } } }`,
      }),
    })
    const body = (await response.json()) as {
      data?: { marketById?: { state?: { blockNumber: number; supplyApy: number } } }
    }
    const state = body.data?.marketById?.state
    if (!state) ctx.skip('Morpho API returned no state for the market')
    const apiBlock = BigInt(state!.blockNumber)
    const apiPct = state!.supplyApy * 100

    // Exactly at the API's block: one read, no window.
    const params = await reader.idToMarketParams(MARKET, apiBlock)
    const market = await reader.market(MARKET, apiBlock)
    const borrowRate = await reader.borrowRateView(params, market, apiBlock)
    const ourPct = annualPct(supplyRatePerSecondWad(borrowRate, market), 'APY')
    const diffPp = ourPct - apiPct
    console.log(`[live] full precision: engine ${ourPct} api ${apiPct}`)
    console.log(
      `[live] block ${apiBlock}: engine supply APY ${ourPct.toFixed(9)}%, Morpho API ${apiPct.toFixed(9)}%, difference ${diffPp.toExponential(3)} pp`,
    )
    expect(Number.isFinite(diffPp)).toBe(true)
  })
})
