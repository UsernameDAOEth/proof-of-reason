import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAINS } from 'proof-of-reason-engine/chains'
import { MissingRpcUrl, rpcUrlFor, viemReaders } from '../src/chain.ts'
import { buildLedger, loadRecords } from '../src/ledger.ts'
import { locate } from '../src/locate.ts'
import { auditRecord, recordJson, safeError } from '../src/run.ts'
import { createZerionClient } from '../src/zerion.ts'
import { BASE_CHAIN_ID, FakeTxReader, blockAt, claimRecord, fixture, listingRoutes, readers, zerionFetch, ztx } from './helpers.ts'

// A fresh throwaway value per run. It is not a real key.
const KEY = `zk_test_${randomUUID().replace(/-/g, '')}`
const RPC_TOKEN = `rpc_token_${randomUUID().replace(/-/g, '')}`
let logged: string[]

function captureConsole() {
  logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(' '))
    })
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n')
}

function expectNoSecret(texts: string[]) {
  for (const text of [...logged, ...texts]) {
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(btoa(`${KEY}:`))
    expect(text).not.toContain(RPC_TOKEN)
  }
}

beforeEach(() => {
  process.env.ZERION_API_KEY = KEY
  captureConsole()
})
afterEach(() => {
  delete process.env.ZERION_API_KEY
  vi.restoreAllMocks()
})

describe('ZERION_API_KEY never appears in logs, errors, or output files', () => {
  it('an error body that echoes the key is redacted from the thrown error', async () => {
    const routes = {
      '/v1/chains/': () =>
        new Response(JSON.stringify({ errors: [{ title: 'Unauthorized', detail: `Invalid API key ${KEY}` }] }), { status: 401 }),
    }
    const error = await createZerionClient({ fetch: zerionFetch(routes) }).listChains().catch((e: unknown) => e)
    expect((error as Error).message).toBe('Zerion API 401 on /v1/chains/: Invalid API key [redacted]')
    expectNoSecret([errorText(error), safeError(error)])
  })

  it('a non-JSON server error and a network failure carry neither the key nor the auth header', async () => {
    const server = await createZerionClient({
      fetch: zerionFetch({ '/v1/chains/': () => new Response(`upstream said ${KEY}`, { status: 502 }) }),
    })
      .listChains()
      .catch((e: unknown) => e)
    const network = await createZerionClient({
      fetch: (async () => {
        throw new TypeError(`fetch failed while sending Authorization: Basic ${btoa(`${KEY}:`)}`)
      }) as typeof fetch,
    })
      .listChains()
      .catch((e: unknown) => e)
    expect((server as Error).message).toBe('Zerion API 502 on /v1/chains/')
    expect((network as Error).message).toBe('Zerion API request failed on /v1/chains/: TypeError')
    expectNoSecret([errorText(server), errorText(network)])
  })

  it('a full audit, its record file, and the ledger never contain the key', async () => {
    const tx = new FakeTxReader([{ n: 2, offsetSeconds: -120 }])
    const zerion = createZerionClient({ fetch: zerionFetch({ ...listingRoutes([ztx(2, -120)]), extra: fixture('positions.json') }) })
    const record = await auditRecord(claimRecord(), {
      readers: readers(tx, blockAt(-120)),
      chainId: BASE_CHAIN_ID,
      locateFn: (r) => locate(r, { zerion, tx, chainId: BASE_CHAIN_ID }),
    })
    const dir = mkdtempSync(join(tmpdir(), 'shadow-secret-'))
    writeFileSync(join(dir, 'record.json'), recordJson(record))
    const ledgerPath = join(dir, 'LEDGER.md')
    writeFileSync(ledgerPath, buildLedger(loadRecords(dir), []))
    const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'))
    expect(files).toHaveLength(2)
    expectNoSecret(files)
    expect(logged).toEqual([])
  })
})

describe('RPC URLs (which carry provider tokens) never appear either', () => {
  it('a missing RPC variable is named, never valued', () => {
    const error = (() => {
      try {
        rpcUrlFor(CHAINS.base, {})
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(MissingRpcUrl)
    expect((error as Error).message).toBe('BASE_RPC_URL is not set')
  })

  it('a failed chain read is reported by error name only', async () => {
    // Port 9 on localhost refuses the connection: no network is used.
    const env = { BASE_RPC_URL: `http://127.0.0.1:9/${RPC_TOKEN}` }
    const reader = viemReaders(CHAINS.base, env)
    const error = await reader.tx.getBlockTimestamp(1n).catch((e: unknown) => e)
    expect(errorText(error)).toContain(RPC_TOKEN)
    const printed = safeError(error)
    expect(printed).toMatch(/^[A-Za-z]+Error$/)
    expectNoSecret([printed])
  })
})
