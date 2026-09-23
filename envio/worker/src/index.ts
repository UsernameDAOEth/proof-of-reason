/**
 * GET /agents/:address, server rendered, no JavaScript in the response.
 *
 * The weekly cron matters as much as the page: Envio Cloud's free Development plan deletes a
 * deployment after 7 days without requests, so the schedule requests the page once a week and keeps
 * the indexer alive through judging (docs/ENVIO.md, "The 28 September rule").
 */
import { renderAgentPage } from './page.ts'
import { IndexerError, fetchAgent, isAddress, normaliseAddress } from './query.ts'

export interface Env {
  /** The indexer's GraphQL endpoint, e.g. https://indexer.dev.envio.xyz/<id>/v1/graphql. */
  ENVIO_GRAPHQL_URL: string
  /** Where receipts are served, default https://api.proofofreason.com/receipts. */
  RECEIPTS_BASE?: string
  /** The agent the weekly cron requests, so the deployment keeps receiving requests. */
  CRON_AGENT_ADDRESS?: string
  /** This worker's own origin, for the cron request. */
  PAGE_ORIGIN?: string
}

const HTML = { 'content-type': 'text/html; charset=utf-8' } as const
const TEXT = { 'content-type': 'text/plain; charset=utf-8' } as const
export const DEFAULT_RECEIPTS_BASE = 'https://api.proofofreason.com/receipts'

/** Cache at the edge for a minute: the page is a weekly read of a slow-moving record. */
const CACHE_CONTROL = 'public, max-age=60'

function text(body: string, status: number): Response {
  return new Response(`${body}\n`, { status, headers: TEXT })
}

export function agentPath(pathname: string): string | null {
  const match = /^\/agents\/([^/]+)\/?$/.exec(pathname)
  return match === null ? null : decodeURIComponent(match[1]!)
}

export async function handleRequest(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('only GET', 405)
  }
  if (url.pathname === '/' || url.pathname === '') {
    return text('Proof of Reason agent pages: GET /agents/<address>', 200)
  }
  const raw = agentPath(url.pathname)
  if (raw === null) return text('not found: GET /agents/<address>', 404)
  if (!isAddress(raw)) return text('address must be 20 bytes of hex', 400)
  if (typeof env.ENVIO_GRAPHQL_URL !== 'string' || !env.ENVIO_GRAPHQL_URL.startsWith('http')) {
    return text('page is not configured: ENVIO_GRAPHQL_URL', 500)
  }

  try {
    const { agent, verdicts } = await fetchAgent(env.ENVIO_GRAPHQL_URL, raw)
    if (agent === null) return text(`no verdicts indexed for ${normaliseAddress(raw)}`, 404)
    const body = renderAgentPage({
      agent,
      verdicts,
      receiptsBase: env.RECEIPTS_BASE ?? DEFAULT_RECEIPTS_BASE,
      renderedAt: now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    })
    return new Response(body, { status: 200, headers: { ...HTML, 'cache-control': CACHE_CONTROL } })
  } catch (error) {
    if (error instanceof IndexerError) return text(error.message, error.status)
    // The message may carry the endpoint, which is configuration. Only the class is reported.
    return text('the indexer could not be reached', 502)
  }
}

/** The weekly keep-alive: one request to the page this worker serves. */
export async function handleScheduled(env: Env, doFetch: typeof fetch = fetch): Promise<Response | null> {
  const origin = env.PAGE_ORIGIN
  const address = env.CRON_AGENT_ADDRESS
  if (typeof origin !== 'string' || origin.length === 0) return null
  if (typeof address !== 'string' || !isAddress(address)) return null
  return doFetch(`${origin.replace(/\/$/, '')}/agents/${normaliseAddress(address)}`, {
    headers: { 'user-agent': 'proof-of-reason-keepalive' },
  })
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
  async scheduled(_event: unknown, env: Env, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    const work = handleScheduled(env).then(
      () => undefined,
      () => undefined,
    )
    if (ctx === undefined) await work
    else ctx.waitUntil(work)
  },
}
