import { describe, expect, it } from 'vitest'
import { AGENT_QUERY, IndexerError, fetchAgent } from '../src/query.ts'
import { DEFAULT_RECEIPTS_BASE, agentPath, handleRequest, handleScheduled } from '../src/index.ts'
import type { Env } from '../src/index.ts'

const GRAPHQL = 'https://indexer.dev.envio.xyz/1234/v1/graphql'
const GATE = '0x4E23Fe7D8ED36ADA7cAc3645a7801c352d3daAbc'
const env: Env = {
  ENVIO_GRAPHQL_URL: GRAPHQL,
  RECEIPTS_BASE: DEFAULT_RECEIPTS_BASE,
  PAGE_ORIGIN: 'https://agents.proofofreason.com',
  CRON_AGENT_ADDRESS: GATE,
}

const agentRow = {
  id: GATE.toLowerCase(),
  kind: 'ReasonGate',
  validator: '0x0376aac07ad725e01357b1725b5cec61ae10473c',
  registryAgentId: '42',
  passes: 8,
  waits: 1,
  overrides: 1,
  fails: 1,
  others: 0,
  samples: 10,
  wilsonLowerBound: 0.490157,
  boundStatus: 'OK',
  lastOutcome: 'PASS',
  lastBlock: '106623517',
}

const verdictRow = {
  id: `0x${'a1'.repeat(32)}`,
  outcome: 'PASS',
  source: 'both',
  ownerOverride: false,
  receiptHash: `0x${'b2'.repeat(32)}`,
  requested: true,
  tag: 'REASON-R0',
  lastBlock: '106623517',
}

/** A fake indexer: records what it was asked, answers what it is told to. */
function indexer(payload: unknown, init: { status?: number; body?: string } = {}) {
  const calls: { url: string; body: unknown }[] = []
  const doFetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body ?? '{}')) })
    const body = init.body ?? JSON.stringify(payload)
    return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, doFetch }
}

function request(path: string, method = 'GET') {
  return new Request(`https://agents.proofofreason.com${path}`, { method })
}

/** handleRequest takes its fetch from the global, so the fake is installed for one call. */
async function serve(path: string, fake: ReturnType<typeof indexer>, override: Partial<Env> = {}, method = 'GET') {
  const original = globalThis.fetch
  globalThis.fetch = fake.doFetch
  try {
    return await handleRequest(request(path, method), { ...env, ...override }, new Date('2026-09-23T12:00:00Z'))
  } finally {
    globalThis.fetch = original
  }
}

describe('GET /agents/:address', () => {
  it('serves the page for an indexed agent, as HTML with no script', async () => {
    const fake = indexer({ data: { Agent: [agentRow], Verdict: [verdictRow] } })
    const response = await serve(`/agents/${GATE}`, fake)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toContain('max-age=60')
    const html = await response.text()
    expect(html).toContain('0.4902')
    expect(html).toContain(GATE.toLowerCase())
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).toContain('2026-09-23 12:00:00 UTC')

    // Asked the indexer for that one agent, lowercase, with its verdicts.
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.url).toBe(GRAPHQL)
    expect(fake.calls[0]?.body).toMatchObject({
      query: AGENT_QUERY,
      variables: { id: GATE.toLowerCase(), limit: 25 },
    })
  })

  it('answers 404 for an agent with nothing indexed, and 400 for something that is not an address', async () => {
    const empty = indexer({ data: { Agent: [], Verdict: [] } })
    const missing = await serve(`/agents/${GATE}`, empty)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('no verdicts indexed')

    const bad = indexer({ data: { Agent: [], Verdict: [] } })
    const notAnAddress = await serve('/agents/not-an-address', bad)
    expect(notAnAddress.status).toBe(400)
    // It never asked the indexer about nonsense.
    expect(bad.calls).toEqual([])
  })

  it('answers 404 off the route, 405 for a write, and 200 at the root', async () => {
    const fake = indexer({ data: { Agent: [agentRow], Verdict: [] } })
    expect((await serve('/', fake)).status).toBe(200)
    expect((await serve('/agents', fake)).status).toBe(404)
    expect((await serve('/agents/a/b', fake)).status).toBe(404)
    expect((await serve(`/agents/${GATE}`, fake, {}, 'POST')).status).toBe(405)
    expect(agentPath('/agents/0xabc')).toBe('0xabc')
    expect(agentPath('/agents/0xabc/')).toBe('0xabc')
    expect(agentPath('/health')).toBeNull()
  })

  it('says it is not configured rather than guessing an endpoint', async () => {
    const fake = indexer({ data: { Agent: [agentRow], Verdict: [] } })
    const response = await serve(`/agents/${GATE}`, fake, { ENVIO_GRAPHQL_URL: '' })
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('ENVIO_GRAPHQL_URL')
    expect(fake.calls).toEqual([])
  })
})

describe('when the indexer misbehaves', () => {
  it('reports a bad gateway without echoing the endpoint', async () => {
    for (const fake of [
      indexer(null, { status: 500 }),
      indexer(null, { body: 'not json' }),
      indexer({ errors: [{ message: 'field boundStatus not found' }] }),
      indexer({ data: { Agent: 'nonsense' } }),
    ]) {
      const response = await serve(`/agents/${GATE}`, fake)
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).not.toContain('envio.xyz')
      expect(body).not.toContain('1234')
    }
  })

  it('surfaces a thrown transport error as 502, not a stack trace', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED ${GRAPHQL}`)
    }) as unknown as typeof fetch
    try {
      const response = await handleRequest(request(`/agents/${GATE}`), env)
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('envio.xyz')
    } finally {
      globalThis.fetch = original
    }
  })

  it('fetchAgent throws IndexerError with a status, never the URL', async () => {
    const fake = indexer(null, { status: 503 })
    await expect(fetchAgent(GRAPHQL, GATE, { fetch: fake.doFetch })).rejects.toThrow(IndexerError)
    await expect(fetchAgent(GRAPHQL, GATE, { fetch: fake.doFetch })).rejects.toThrow(/answered 503/)
  })
})

describe('the weekly cron keeps the deployment alive', () => {
  it('requests the page for the configured agent', async () => {
    const calls: string[] = []
    const doFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response('ok')
    }) as unknown as typeof fetch

    const response = await handleScheduled(env, doFetch)
    expect(response?.status).toBe(200)
    expect(calls).toEqual([`https://agents.proofofreason.com/agents/${GATE.toLowerCase()}`])
  })

  it('does nothing when it has no agent or no origin to ask', async () => {
    const calls: string[] = []
    const doFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response('ok')
    }) as unknown as typeof fetch

    expect(await handleScheduled({ ...env, CRON_AGENT_ADDRESS: undefined }, doFetch)).toBeNull()
    expect(await handleScheduled({ ...env, CRON_AGENT_ADDRESS: 'not-an-address' }, doFetch)).toBeNull()
    expect(await handleScheduled({ ...env, PAGE_ORIGIN: undefined }, doFetch)).toBeNull()
    expect(calls).toEqual([])
  })

  it('is scheduled weekly in wrangler.toml, which is what the 7 day rule needs', async () => {
    const { readFileSync } = await import('node:fs')
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    expect(toml).toContain('crons = ["0 12 * * 1"]')
    expect(toml).toContain('main = "src/index.ts"')
    // No secrets in a public file.
    expect(toml).not.toMatch(/PRIVATE_KEY|VALIDATOR_KEY|token/i)
  })
})
