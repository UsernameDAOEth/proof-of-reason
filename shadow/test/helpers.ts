import { readFileSync } from 'node:fs'
import { encodeFunctionData, maxUint256 } from 'viem'
import type { Address, Hex } from 'viem'
import { marketId, vaultAbi } from 'proof-of-reason-engine/action'
import type { Erc20Reader } from 'proof-of-reason-engine/erc20'
import type { Erc4626Reader } from 'proof-of-reason-engine/erc4626'
import type { MarketParams, MarketState, MorphoReader } from 'proof-of-reason-engine/morpho'
import type { TxInfo, TxReader, ShadowReaders } from '../src/chain.ts'
import type { ZerionTransaction } from '../src/zerion.ts'

export const WALLET: Address = '0x1111111111111111111111111111111111111111'
export const VAULT: Address = '0x2222222222222222222222222222222222222222'
export const OTHER: Address = '0x3333333333333333333333333333333333333333'
export const TOKEN: Address = '0x4444444444444444444444444444444444444444'
export const BASE_CHAIN_ID = 8453
export const POSTED_AT = '2026-09-10T12:00:00Z'
export const POSTED_S = 1_789_041_600

export function hash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

/** A Zerion transaction entry in the same shape as the fixture files. */
export function ztx(n: number, offsetSeconds: number, overrides: Partial<ZerionTransaction['attributes']> = {}): ZerionTransaction {
  return {
    type: 'transactions',
    id: `${hash(n)}-0`,
    attributes: {
      hash: hash(n),
      mined_at: new Date((POSTED_S + offsetSeconds) * 1000).toISOString().replace('.000Z', 'Z'),
      status: 'confirmed',
      operation_type: 'execute',
      sent_from: WALLET,
      sent_to: VAULT,
      ...overrides,
    },
    relationships: { chain: { data: { id: 'base' } } },
  }
}

export type Seen = { url: URL; authorization: string | null }

/** Serves JSON by URL (path plus query) from a route table; unknown URLs are a test failure. */
export function zerionFetch(routes: Record<string, unknown | (() => Response)>, seen: Seen[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    seen.push({ url, authorization: headers.get('authorization') })
    const key = `${url.pathname}${url.search}`
    const route = routes[key] ?? routes[url.pathname]
    if (route === undefined) throw new Error(`unexpected Zerion request ${key}`)
    if (typeof route === 'function') return (route as () => Response)()
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

export function listingRoutes(transactions: ZerionTransaction[], wallet: Address = WALLET) {
  return {
    '/v1/chains/': fixture('chains.json'),
    [`/v1/wallets/${wallet}/transactions/`]: { links: { next: null }, data: transactions },
  }
}

/** Two-second blocks: block n has timestamp GENESIS_S + 2n, so posted_at falls on block 20,000,000. */
export const GENESIS_S = POSTED_S - 40_000_000
export const blockAt = (offsetSeconds: number) => BigInt(Math.floor((POSTED_S + offsetSeconds - GENESIS_S) / 2))
export const tsOf = (block: bigint) => BigInt(GENESIS_S) + 2n * block

export const REALLOCATE_DATA: Hex = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'reallocate',
  args: [[{ marketParams: marketParams(), assets: maxUint256 }]],
})

export type ChainTx = Partial<TxInfo> & { n: number; offsetSeconds: number; timestamp?: bigint }

/** Far enough after posted_at that every test window has closed. */
export const HEAD_BLOCK = blockAt(8 * 86_400)

/**
 * A chain with the given transactions. Nonces are derived from them: an address's nonce at block b
 * is the number of its transactions in blocks <= b, failed ones included, plus `nonceBase`.
 */
export class FakeTxReader implements TxReader {
  calls: string[] = []
  txs = new Map<string, TxInfo>()
  times = new Map<bigint, bigint>()
  head: bigint
  nonceBase = 7n

  constructor(txs: ChainTx[], head: bigint = HEAD_BLOCK) {
    this.head = head
    for (const t of txs) {
      const blockNumber = t.blockNumber ?? blockAt(t.offsetSeconds)
      this.txs.set(hash(t.n), {
        hash: hash(t.n),
        from: t.from ?? WALLET,
        to: t.to === undefined ? VAULT : t.to,
        input: t.input ?? REALLOCATE_DATA,
        blockNumber,
        success: t.success ?? true,
      })
      this.times.set(blockNumber, t.timestamp ?? tsOf(blockNumber))
    }
  }

  async getTransaction(h: Hex): Promise<TxInfo | null> {
    this.calls.push(`tx:${h}`)
    return this.txs.get(h) ?? null
  }

  async getBlockTimestamp(block: bigint): Promise<bigint> {
    this.calls.push(`ts:${block}`)
    return this.times.get(block) ?? tsOf(block)
  }

  async getHead() {
    this.calls.push('head')
    return { number: this.head, timestamp: this.times.get(this.head) ?? tsOf(this.head) }
  }

  async getNonce(address: Address, block: bigint): Promise<bigint> {
    this.calls.push(`nonce:${block}`)
    let n = this.nonceBase
    for (const tx of this.txs.values()) {
      if (tx.from.toLowerCase() === address.toLowerCase() && tx.blockNumber <= block) n++
    }
    return n
  }
}

export function marketParams(): MarketParams {
  return {
    loanToken: TOKEN,
    collateralToken: '0x0000000000000000000000000000000000002000',
    oracle: '0x0000000000000000000000000000000000003000',
    irm: '0x0000000000000000000000000000000000004000',
    lltv: 860_000_000_000_000_000n,
  }
}

export const MARKET: Hex = marketId(marketParams())

/** The engine fixture market: supply APY 2.29656616 percent, withdrawable 200,000e6. */
export const MARKET_STATE: MarketState = {
  totalSupplyAssets: 1_000_000_000_000n,
  totalSupplyShares: 1_000_000_000_000_000_000n,
  totalBorrowAssets: 800_000_000_000n,
  totalBorrowShares: 800_000_000_000_000_000n,
  lastUpdate: 1_700_000_000n,
  fee: 100_000_000_000_000_000n,
}

export class FakeMorpho implements MorphoReader {
  calls: string[] = []
  async market(_id: Hex, block: bigint) {
    this.calls.push(`market@${block}`)
    return MARKET_STATE
  }
  async idToMarketParams(_id: Hex, block: bigint) {
    this.calls.push(`params@${block}`)
    return marketParams()
  }
  async borrowRateView(_p: MarketParams, _m: MarketState, block: bigint) {
    this.calls.push(`rate@${block}`)
    return 1_000_000_000n
  }
}

/** Share price grows exactly 0.01 percent per day from `anchor` seconds: APY 3.7172411303 percent. */
export class FakeVault implements Erc4626Reader {
  anchor: bigint
  constructor(anchor: bigint) {
    this.anchor = anchor
  }
  async blockTimestamp(block: bigint) {
    return tsOf(block)
  }
  async hasCode() {
    return true
  }
  async convertToAssets(_v: Address, _s: bigint, block: bigint) {
    const days = tsOf(block) - this.anchor
    return 10n ** 24n + (days * 10n ** 20n) / 86_400n
  }
  async totalAssets() {
    return 5_000_000_000n
  }
}

export const fakeErc20: Erc20Reader = {
  hasCode: async () => true,
  balanceOf: async () => 5_000_000n,
}

export function readers(tx: TxReader, located: bigint): ShadowReaders {
  return { morpho: new FakeMorpho(), erc4626: new FakeVault(tsOf(located) - 86_400n), erc20: fakeErc20, tx }
}

/** Typed claims that are all TRUE at the fake chain state. */
export function trueClaims() {
  return [
    {
      id: 'r1',
      kind: 'rate',
      sourceSpan: 'supply APY is 2.3%',
      market: MARKET,
      side: 'supply',
      valuePct: 2.3,
      basis: 'APY',
      compounding: 'continuous',
      window: { type: 'instant' },
      tolerancePp: 0.05,
    },
    { id: 'l1', kind: 'liquidity', sourceSpan: 'over 100k is withdrawable', market: MARKET, minWithdrawable: '100000000000' },
    {
      id: 'v1',
      kind: 'vault_rate',
      sourceSpan: 'the vault earns 3.7% APY',
      vault: VAULT,
      valuePct: 3.7,
      basis: 'APY',
      compounding: 'continuous',
      lookbackBlocks: 43_200,
      tolerancePp: 0.05,
    },
    { id: 'b1', kind: 'balance', sourceSpan: 'the vault holds 5 USDC idle', token: TOKEN, holder: VAULT, amount: '5000000', toleranceAtomic: '0' },
  ]
}

export function claimRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fixture-agent-2026-09-10',
    agent: { name: 'Fixture Allocator', wallet: WALLET },
    chain: 'base',
    source_url: 'https://example.org/posts/1',
    source_text: 'Moving idle USDC: supply APY is 2.3%, over 100k is withdrawable, the vault earns 3.7% APY.',
    posted_at: POSTED_AT,
    claims: trueClaims(),
    target: { contract: VAULT, method: 'reallocate(((address,address,address,address,uint256),uint256)[])' },
    ...overrides,
  }
}
