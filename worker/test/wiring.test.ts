import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, hexToBigInt, numberToHex } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { irmAbi, morphoAbi } from 'proof-of-reason-engine/morpho'
import worker from '../src/index.ts'
import type { Env } from '../src/index.ts'
import { FACILITATOR_URL, MORPHO, NETWORK } from '../src/config.ts'
import { BORROW_RATE, GATE, HEAD, MemoryStore, PARAMS, PAY_TO, STATES, VAULT, checkBody } from './helpers.ts'
import { MARKET_B } from '../src/mandates.ts'

// Offline: every fetch is answered here. The RPC host below does not exist. Like an archive
// provider URL, it carries an access token, which must never reach a log or a response.
const RPC_TOKEN = 'qn-token-5f0c1e9a7b'
const RPC_URL = `https://monad.archive.invalid/${RPC_TOKEN}`

type Seen = { url: string; body: unknown }

// Wire-level record of RPC traffic: batches seen and the most requests in flight at once.
let rpcInFlight = 0
let rpcMaxInFlight = 0
let rpcBatches = 0

function morphoCall(target: string, data: Hex): Hex {
  if (target.toLowerCase() === MORPHO.toLowerCase()) {
    const call = decodeFunctionData({ abi: morphoAbi, data })
    const id = (call.args[0] as string).toLowerCase()
    if (call.functionName === 'market') {
      const s = STATES[id]!
      return encodeFunctionResult({
        abi: morphoAbi,
        functionName: 'market',
        result: [s.totalSupplyAssets, s.totalSupplyShares, s.totalBorrowAssets, s.totalBorrowShares, s.lastUpdate, s.fee],
      })
    }
    const p = PARAMS[id]!
    return encodeFunctionResult({
      abi: morphoAbi,
      functionName: 'idToMarketParams',
      result: [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
    })
  }
  const call = decodeFunctionData({ abi: irmAbi, data })
  const params = call.args[0] as { collateralToken: string }
  const id = Object.keys(PARAMS).find((k) => PARAMS[k]!.collateralToken === params.collateralToken)!
  return encodeFunctionResult({ abi: irmAbi, functionName: 'borrowRateView', result: BORROW_RATE[id]! })
}

function rpcResult(method: string, params: unknown[]): unknown {
  if (method === 'eth_chainId') return numberToHex(143)
  if (method === 'eth_blockNumber') return numberToHex(HEAD)
  if (method === 'eth_call') {
    const [{ to, data }] = params as [{ to: string; data: Hex }]
    return morphoCall(to, data)
  }
  throw new Error(`unexpected RPC method ${method}`)
}

function installFetch(seen: Seen[], options: { rpcDown?: boolean } = {}) {
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    const body = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : undefined
    seen.push({ url, body })
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith(RPC_URL)) {
      if (options.rpcDown) return new Response('bad gateway', { status: 502 })
      // Like the Foundation RPC: a JSON-RPC batch is refused.
      if (Array.isArray(body)) {
        rpcBatches++
        return reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not allowed' } }, 400)
      }
      rpcInFlight++
      rpcMaxInFlight = Math.max(rpcMaxInFlight, rpcInFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 1))
        const r = body as { id: number; method: string; params: unknown[] }
        return reply({ jsonrpc: '2.0', id: r.id, result: rpcResult(r.method, r.params) })
      } finally {
        rpcInFlight--
      }
    }
    if (url === `${FACILITATOR_URL}/supported`) {
      return reply({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} })
    }
    if (url === `${FACILITATOR_URL}/verify`) return reply({ isValid: true, payer: PAY_TO })
    if (url === `${FACILITATOR_URL}/settle`) {
      return reply({ success: true, transaction: `0x${'cd'.repeat(32)}`, network: NETWORK, payer: PAY_TO })
    }
    throw new Error(`offline test refused a fetch to ${url}`)
  }
  vi.stubGlobal('fetch', vi.fn(fake))
}

let validatorKey: Hex
let logged: string[]

function env(overrides: Partial<Env> = {}): Env {
  return {
    RECEIPTS: new MemoryStore(),
    VALIDATOR_KEY: validatorKey,
    MONAD_RPC_URL: RPC_URL,
    GATE_ADDRESS: GATE,
    VAULT_ADDRESS: VAULT,
    PAY_TO,
    ...overrides,
  }
}

function call(e: Env, body: unknown, headers: Record<string, string> = {}) {
  const request = new Request('https://worker.test/check', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
  return worker.fetch(request, e, {})
}

async function paidCall(e: Env, body: unknown) {
  const challenge = await call(e, body)
  expect(challenge.status).toBe(402)
  const client = new x402Client()
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()), networks: [NETWORK] })
  const http = new x402HTTPClient(client)
  const required = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json())
  return call(e, body, http.encodePaymentSignatureHeader(await http.createPaymentPayload(required)))
}

beforeEach(() => {
  validatorKey = generatePrivateKey()
  logged = []
  rpcInFlight = 0
  rpcMaxInFlight = 0
  rpcBatches = 0
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(' '))
    })
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function expectSecretsNeverLeaked(texts: string[]) {
  const bare = validatorKey.slice(2).toLowerCase()
  for (const text of [...logged, ...texts]) {
    expect(text.toLowerCase()).not.toContain(bare)
    expect(text).not.toContain(RPC_TOKEN)
  }
}

describe('worker entry with the real viem client and the real HTTP facilitator client (offline)', () => {
  it('serves a paid PASS through sequential, unbatched reads and the configured facilitator URL', async () => {
    const seen: Seen[] = []
    installFetch(seen)
    const e = env()
    const res = await paidCall(e, checkBody())
    const text = await res.text()
    expect(res.status).toBe(200)
    const body = JSON.parse(text) as { verdict: { outcome: string }; signed: { validator: string; intentHash: string } }
    expect(body.verdict.outcome).toBe('PASS')
    expect(body.signed.validator).toBe(privateKeyToAccount(validatorKey).address)

    const facilitatorUrls = seen.map((s) => s.url).filter((u) => u.startsWith(FACILITATOR_URL))
    expect(facilitatorUrls).toEqual([
      'https://x402-facilitator.molandak.org/supported',
      'https://x402-facilitator.molandak.org/verify',
      'https://x402-facilitator.molandak.org/settle',
    ])
    const verify = seen.find((s) => s.url.endsWith('/verify'))!.body as {
      x402Version: number
      paymentRequirements: { network: string; amount: string; asset: string; extra: unknown }
    }
    expect(verify.x402Version).toBe(2)
    expect(verify.paymentRequirements).toMatchObject({
      network: 'eip155:143',
      amount: '100000',
      asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      extra: { name: 'USDC', version: '2' },
    })

    // RPC policy: one request per read, never a JSON-RPC batch, never Multicall, never concurrent.
    const rpcCalls = seen.filter((s) => s.url.startsWith(RPC_URL))
    expect(rpcBatches).toBe(0)
    expect(rpcCalls.every((s) => !Array.isArray(s.body))).toBe(true)
    expect(rpcMaxInFlight).toBe(1)
    const ethCalls = rpcCalls
      .map((s) => s.body as { method: string; params: [{ to: string; data: Hex }, Hex] })
      .filter((b) => b.method === 'eth_call')
    const targets = new Set(ethCalls.map((b) => b.params[0].to.toLowerCase()))
    expect([...targets].sort()).toEqual([MORPHO.toLowerCase(), PARAMS[MARKET_B]!.irm.toLowerCase()].sort())
    // rate: params + 5 x (state, IRM rate); liquidity: 5 states.
    expect(ethCalls).toHaveLength(16)
    const pinned = HEAD - 2n
    const blocks = ethCalls.map((b) => hexToBigInt(b.params[1]))
    expect(blocks).toEqual([
      pinned,
      ...[4n, 3n, 2n, 1n, 0n].flatMap((d) => [pinned - d, pinned - d]),
      ...[4n, 3n, 2n, 1n, 0n].map((d) => pinned - d),
    ])

    const receipt = await (e.RECEIPTS as MemoryStore).get(body.signed.intentHash)
    expect(receipt).not.toBeNull()
    expectSecretsNeverLeaked([text, receipt!])
  })

  it('never logs or echoes VALIDATOR_KEY or the RPC token, even when the RPC is down or the key is malformed', async () => {
    const seen: Seen[] = []
    installFetch(seen, { rpcDown: true })
    const down = await paidCall(env(), checkBody())
    expect(down.status).toBe(503)
    const downText = await down.text()

    installFetch(seen)
    const malformed = env({ VALIDATOR_KEY: `${validatorKey}ff` })
    const bad = await paidCall(malformed, checkBody())
    expect(bad.status).toBe(500)
    const badText = await bad.text()
    expect(JSON.parse(badText)).toEqual({ error: 'validator key is not configured' })

    expectSecretsNeverLeaked([downText, badText])
  })

  it('refuses to start without its public configuration, naming only the variable', async () => {
    installFetch([])
    const res = await call(env({ GATE_ADDRESS: '' }), checkBody())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'worker is not configured: GATE_ADDRESS' })
  })
})
