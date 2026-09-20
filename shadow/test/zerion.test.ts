import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZerionError, ZerionUnsupportedChain, createZerionClient } from '../src/zerion.ts'
import { BASE_CHAIN_ID, POSTED_S, WALLET, fixture, zerionFetch } from './helpers.ts'
import type { Seen } from './helpers.ts'

const KEY = 'zk_test_client_1f2e3d'
const TX_PATH = `/v1/wallets/${WALLET}/transactions/`
const window = { from: new Date((POSTED_S - 3600) * 1000), to: new Date((POSTED_S + 3600) * 1000) }

beforeEach(() => {
  process.env.ZERION_API_KEY = KEY
})
afterEach(() => {
  delete process.env.ZERION_API_KEY
})

function pagedRoutes() {
  return {
    '/v1/chains/': fixture('chains.json'),
    [TX_PATH]: fixture('transactions-page1.json'),
    [`${TX_PATH}?page%5Bafter%5D=cursor-2`]: fixture('transactions-page2.json'),
  }
}

describe('Zerion client', () => {
  it('sends Basic auth built from the key read at call time, to api.zerion.io/v1', async () => {
    const seen: Seen[] = []
    const client = createZerionClient({ fetch: zerionFetch(pagedRoutes(), seen) })
    await client.listChains()
    expect(seen[0]!.url.href).toBe('https://api.zerion.io/v1/chains/')
    expect(seen[0]!.authorization).toBe(`Basic ${btoa(`${KEY}:`)}`)
    process.env.ZERION_API_KEY = 'zk_test_rotated'
    await client.getPositions(WALLET, { chain: BASE_CHAIN_ID }).catch(() => undefined)
    expect(seen.at(-1)!.authorization).toBe(`Basic ${btoa('zk_test_rotated:')}`)
  })

  it('maps EVM chain ids to Zerion chain ids through external_id', async () => {
    const client = createZerionClient({ fetch: zerionFetch(pagedRoutes()) })
    expect(await client.zerionChainId(8453)).toBe('base')
    expect(await client.zerionChainId(1)).toBe('ethereum')
    await expect(client.zerionChainId(143)).rejects.toBeInstanceOf(ZerionUnsupportedChain)
    const chains = await client.listChains()
    expect(chains.map((c) => [c.id, c.chainId, c.externalId])).toEqual([
      ['ethereum', 1, '0x1'],
      ['base', 8453, '0x2105'],
    ])
  })

  it('pages with links.next, keeps only the window, and stops once a newest-first page passes it', async () => {
    const seen: Seen[] = []
    const client = createZerionClient({ fetch: zerionFetch(pagedRoutes(), seen) })
    const listing = await client.listTransactions(WALLET, { chain: BASE_CHAIN_ID, ...window })
    expect(listing.transactions.map((t) => t.attributes.hash!.slice(-1))).toEqual(['1', '2', '3'])
    expect(listing.pages).toBe(2)
    expect(listing.truncated).toBe(false)
    const txRequests = seen.filter((s) => s.url.pathname === TX_PATH)
    expect(txRequests).toHaveLength(2)
    expect(txRequests[0]!.url.searchParams.get('filter[chain_ids]')).toBe('base')
    expect(txRequests[0]!.url.searchParams.get('page[size]')).toBe('100')
  })

  it('marks a listing truncated at the page cap', async () => {
    const client = createZerionClient({ fetch: zerionFetch(pagedRoutes()), maxPages: 1 })
    const wide = { from: new Date(0), to: new Date((POSTED_S + 3600) * 1000) }
    const listing = await client.listTransactions(WALLET, { chain: BASE_CHAIN_ID, ...wide })
    expect(listing).toMatchObject({ pages: 1, truncated: true })
  })

  it('refuses to follow a next link to another origin', async () => {
    const routes = {
      '/v1/chains/': fixture('chains.json'),
      [TX_PATH]: { links: { next: 'https://evil.example/v1/steal' }, data: [] as unknown[] },
    }
    ;(routes[TX_PATH] as { data: unknown[] }).data = (fixture('transactions-page1.json') as { data: unknown[] }).data
    const client = createZerionClient({ fetch: zerionFetch(routes) })
    const wide = { from: new Date(0), to: new Date((POSTED_S + 3600) * 1000) }
    await expect(client.listTransactions(WALLET, { chain: BASE_CHAIN_ID, ...wide })).rejects.toThrow(/outside the Zerion API origin/)
  })

  it('retries 429 with Retry-After, then succeeds', async () => {
    let calls = 0
    const slept: number[] = []
    const routes = {
      '/v1/chains/': () => {
        calls++
        return calls === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : new Response(JSON.stringify(fixture('chains.json')), { status: 200 })
      },
    }
    const client = createZerionClient({ fetch: zerionFetch(routes), sleep: async (ms) => void slept.push(ms) })
    expect((await client.listChains()).length).toBe(2)
    expect(slept).toEqual([2000])
  })

  it('returns positions for a chain', async () => {
    const routes = { '/v1/chains/': fixture('chains.json'), [`/v1/wallets/${WALLET}/positions/`]: fixture('positions.json') }
    const seen: Seen[] = []
    const positions = await createZerionClient({ fetch: zerionFetch(routes, seen) }).getPositions(WALLET, { chain: BASE_CHAIN_ID })
    expect(positions).toHaveLength(1)
    const url = seen.at(-1)!.url
    expect(url.searchParams.get('filter[positions]')).toBe('no_filter')
    expect(url.searchParams.get('filter[chain_ids]')).toBe('base')
  })

  it('fails with a ZerionError naming only the path when the key is missing', async () => {
    delete process.env.ZERION_API_KEY
    const error = await createZerionClient({ fetch: zerionFetch(pagedRoutes()) }).listChains().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ZerionError)
    expect((error as ZerionError).message).toBe('ZERION_API_KEY is not set')
  })
})
