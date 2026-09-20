// Zerion API client (https://developers.zerion.io). Base URL, Basic auth ("<key>:"), endpoint paths,
// filter[chain_ids], filter[positions]=no_filter, and the 429 retry follow the official client in
// zerion-cli 1.9.1 (github.com/zeriontech/zerion-ai, cli/utils/api/client.js and auth.js).
// ZERION_API_KEY is read from process.env at call time only, never stored, logged, or echoed.
// Zerion only finds transactions and adds context. It never decides a status.

export const ZERION_API_BASE = 'https://api.zerion.io/v1'

export class ZerionError extends Error {
  readonly status: number | null
  readonly path: string

  constructor(message: string, status: number | null, path: string) {
    super(message)
    this.name = 'ZerionError'
    this.status = status
    this.path = path
  }
}

export class ZerionUnsupportedChain extends Error {
  readonly chainId: number

  constructor(chainId: number) {
    super(`chain ${chainId} is not in the Zerion chain catalog`)
    this.name = 'ZerionUnsupportedChain'
    this.chainId = chainId
  }
}

export type ZerionTransaction = {
  type?: string
  id: string
  attributes: {
    hash?: string
    mined_at?: string
    mined_at_block?: number
    sent_from?: string
    sent_to?: string
    status?: string
    operation_type?: string
    [key: string]: unknown
  }
  relationships?: { chain?: { data?: { id?: string } } }
}

export type ZerionChain = {
  id: string
  name: string
  /** EVM chain id parsed from attributes.external_id (hex), or null when absent. */
  chainId: number | null
  externalId: string | null
  /** The catalog entry's attributes as Zerion returned them. */
  attributes: Record<string, unknown>
}

export type TransactionListing = {
  transactions: ZerionTransaction[]
  pages: number
  truncated: boolean
}

export type ZerionClientOptions = {
  fetch?: typeof fetch
  baseUrl?: string
  /** Page cap per listing. Hitting it marks the listing truncated. */
  maxPages?: number
  pageSize?: number
  sleep?: (ms: number) => Promise<void>
}

export type ZerionClient = {
  listChains(): Promise<ZerionChain[]>
  zerionChainId(chainId: number): Promise<string>
  listTransactions(address: string, options: { chain: number; from: Date; to: Date }): Promise<TransactionListing>
  getPositions(address: string, options: { chain: number }): Promise<unknown[]>
}

type JsonApiPage<T> = { data?: T[]; links?: { next?: string | null } }

const MAX_429_RETRIES = 3
const DEFAULT_429_BACKOFF_MS = 1_000

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

export function createZerionClient(options: ZerionClientOptions = {}): ZerionClient {
  const fetchFn = options.fetch ?? fetch
  const base = new URL(options.baseUrl ?? ZERION_API_BASE)
  const maxPages = options.maxPages ?? 50
  const pageSize = options.pageSize ?? 100
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let chainCache: ZerionChain[] | undefined

  async function request<T>(target: string, params: Record<string, string> = {}): Promise<T> {
    const url = target.startsWith('http') ? new URL(target) : new URL(`${base.pathname.replace(/\/$/, '')}${target}`, base)
    // Never send the key anywhere but the Zerion API origin.
    if (url.origin !== base.origin) throw new ZerionError('refused a link outside the Zerion API origin', null, url.pathname)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const path = url.pathname

    const key = process.env.ZERION_API_KEY
    if (!key) throw new ZerionError('ZERION_API_KEY is not set', null, path)
    const headers = { Accept: 'application/json', Authorization: `Basic ${btoa(`${key}:`)}` }

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchFn(url, { headers })
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error'
        throw new ZerionError(`Zerion API request failed on ${path}: ${name}`, null, path)
      }
      if (response.status === 429 && attempt < MAX_429_RETRIES) {
        await response.text().catch(() => '')
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_429_BACKOFF_MS)
        continue
      }
      const text = await response.text()
      if (!response.ok) {
        let detail = ''
        try {
          const body = JSON.parse(text) as { errors?: { title?: string; detail?: string }[] }
          detail = body.errors?.[0]?.detail ?? body.errors?.[0]?.title ?? ''
        } catch {
          detail = ''
        }
        const message = `Zerion API ${response.status} on ${path}${detail ? `: ${detail}` : ''}`
        throw new ZerionError(redact(message, key), response.status, path)
      }
      try {
        return JSON.parse(text) as T
      } catch {
        throw new ZerionError(`Zerion API returned non-JSON on ${path}`, response.status, path)
      }
    }
  }

  async function allPages<T>(path: string, params: Record<string, string>): Promise<{ data: T[]; truncated: boolean }> {
    const data: T[] = []
    let page = await request<JsonApiPage<T>>(path, params)
    for (let pages = 1; ; pages++) {
      data.push(...(page.data ?? []))
      const next = page.links?.next
      if (!next) return { data, truncated: false }
      if (pages >= maxPages) return { data, truncated: true }
      page = await request<JsonApiPage<T>>(next)
    }
  }

  async function listChains(): Promise<ZerionChain[]> {
    if (chainCache) return chainCache
    const { data } = await allPages<{ id: string; attributes?: Record<string, unknown> }>('/chains/', {})
    chainCache = data.map((c) => {
      const attributes = c.attributes ?? {}
      const hex = typeof attributes.external_id === 'string' ? attributes.external_id : null
      const chainId = hex !== null && /^0x[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : null
      const name = typeof attributes.name === 'string' ? attributes.name : c.id
      return { id: c.id, name, chainId, externalId: hex, attributes }
    })
    return chainCache
  }

  async function zerionChainId(chainId: number): Promise<string> {
    const match = (await listChains()).find((c) => c.chainId === chainId)
    if (match === undefined) throw new ZerionUnsupportedChain(chainId)
    return match.id
  }

  async function listTransactions(
    address: string,
    { chain, from, to }: { chain: number; from: Date; to: Date },
  ): Promise<TransactionListing> {
    const params = {
      'filter[chain_ids]': await zerionChainId(chain),
      'page[size]': String(pageSize),
      currency: 'usd',
    }
    const fromMs = from.getTime()
    const toMs = to.getTime()
    const transactions: ZerionTransaction[] = []
    let page = await request<JsonApiPage<ZerionTransaction>>(`/wallets/${encodeURIComponent(address)}/transactions/`, params)
    for (let pages = 1; ; pages++) {
      const rows = page.data ?? []
      const times = rows.map((t) => Date.parse(t.attributes?.mined_at ?? ''))
      rows.forEach((t, i) => {
        const at = times[i]!
        if (Number.isFinite(at) && at >= fromMs && at <= toMs) transactions.push(t)
      })
      // Server-side time filters are not used until verified live. Stop early only when this page
      // is newest-first and already reaches past the window start.
      const descending = times.every((t, i) => i === 0 || (Number.isFinite(t) && t <= times[i - 1]!))
      const oldest = Math.min(...times.filter(Number.isFinite))
      const next = page.links?.next
      if (rows.length === 0 || !next || (descending && oldest < fromMs)) return { transactions, pages, truncated: false }
      if (pages >= maxPages) return { transactions, pages, truncated: true }
      page = await request<JsonApiPage<ZerionTransaction>>(next)
    }
  }

  async function getPositions(address: string, { chain }: { chain: number }): Promise<unknown[]> {
    const params = {
      'filter[positions]': 'no_filter',
      'filter[chain_ids]': await zerionChainId(chain),
      currency: 'usd',
    }
    return (await allPages<unknown>(`/wallets/${encodeURIComponent(address)}/positions/`, params)).data
  }

  return { listChains, zerionChainId, listTransactions, getPositions }
}
