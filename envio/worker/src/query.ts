/**
 * The one GraphQL query the page needs, against ENVIO_GRAPHQL_URL. Nothing here trusts the answer:
 * shapes are checked, and every value is escaped by src/page.ts before it reaches the HTML.
 */
import type { AgentRecord, VerdictRecord } from './page.ts'

export const AGENT_QUERY = `query Agent($id: String!, $limit: Int!) {
  Agent(where: { id: { _eq: $id } }, limit: 1) {
    id
    kind
    validator
    registryAgentId
    passes
    waits
    overrides
    fails
    others
    samples
    wilsonLowerBound
    boundStatus
    lastOutcome
    lastBlock
  }
  Verdict(where: { gate: { _eq: $id } }, order_by: { lastBlock: desc }, limit: $limit) {
    id
    outcome
    source
    ownerOverride
    receiptHash
    requested
    tag
    lastBlock
  }
}`

export const DEFAULT_VERDICT_LIMIT = 25

export type QueryResult = { agent: AgentRecord | null; verdicts: VerdictRecord[] }

export class IndexerError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    // Never carries the URL: it is configuration, and may hold a token.
    super(message)
    this.name = 'IndexerError'
    this.status = status
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isAddress(value: string): boolean {
  return ADDRESS.test(value)
}

/** An agent id is an address on this page, and the indexer stores it lowercase. */
export function normaliseAddress(value: string): string {
  return value.trim().toLowerCase()
}

type Fetcher = typeof fetch

export async function fetchAgent(
  url: string,
  address: string,
  options: { fetch?: Fetcher; limit?: number } = {},
): Promise<QueryResult> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: AGENT_QUERY,
      variables: { id: normaliseAddress(address), limit: options.limit ?? DEFAULT_VERDICT_LIMIT },
    }),
  })
  if (!response.ok) throw new IndexerError(`the indexer answered ${response.status}`, 502)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new IndexerError('the indexer did not answer JSON', 502)
  }
  const payload = body as { data?: { Agent?: unknown; Verdict?: unknown }; errors?: { message?: string }[] }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new IndexerError('the indexer refused the query', 502)
  }
  const agents = payload.data?.Agent
  const verdicts = payload.data?.Verdict
  if (!Array.isArray(agents) || !Array.isArray(verdicts)) {
    throw new IndexerError('the indexer answered an unexpected shape', 502)
  }
  return {
    agent: (agents[0] as AgentRecord | undefined) ?? null,
    verdicts: verdicts as VerdictRecord[],
  }
}
