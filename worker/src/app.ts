import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import type { FacilitatorClient, RoutesConfig } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import type { Address } from 'viem'
import type { MandateV0 } from 'proof-of-reason-engine/claims'
import { SchemaError } from 'proof-of-reason-engine/claims'
import { canonicalJson } from 'proof-of-reason-engine/receipt'
import { CheckRequestV0 } from './body.ts'
import { HttpError, runCheck } from './check.ts'
import type { CheckDeps } from './check.ts'
import { NETWORK, PRICE_ATOMIC, USDC, USDC_EIP712 } from './config.ts'

/** The subset of a Workers KV namespace the app uses. */
export interface ReceiptStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export type AppDeps = {
  facilitator: FacilitatorClient
  payTo: Address
  receipts: ReceiptStore
  mandates: Readonly<Record<string, MandateV0>>
  /** Built per request so the VALIDATOR_KEY secret is read at runtime, never at import time. */
  checkDeps: () => CheckDeps
}

type Vars = { Variables: { checkRequest: CheckRequestV0; mandate: MandateV0 } }

const INTENT_HASH = /^0x[0-9a-f]{64}$/

function json(c: Context, value: unknown, status: 200 | 400 | 404 | 422 | 500 | 503 = 200) {
  return c.body(canonicalJson(value), status, { 'content-type': 'application/json; charset=utf-8' })
}

export function paymentRoutes(payTo: Address): RoutesConfig {
  return {
    'POST /check': {
      accepts: {
        scheme: 'exact',
        network: NETWORK,
        payTo,
        price: { asset: USDC, amount: PRICE_ATOMIC, extra: { ...USDC_EIP712 } },
        maxTimeoutSeconds: 60,
      },
      description: 'Proof of Reason premise check: verdict, signed Verdict struct, and receipt',
      mimeType: 'application/json',
    },
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Vars>()
  const server = new x402ResourceServer(deps.facilitator).register(NETWORK, new ExactEvmScheme())

  app.onError((error, c) => {
    if (error instanceof HttpError) return json(c, { error: error.message }, error.status)
    if (error instanceof SchemaError) return json(c, { error: error.message }, 400)
    // Log the error class only. Messages are not logged, so no secret can reach the logs.
    console.error(`unhandled ${error.name}`)
    return json(c, { error: 'internal error' }, 500)
  })

  app.get('/', (c) =>
    json(c, {
      name: 'Proof of Reason',
      check: { method: 'POST', path: '/check', price: { asset: USDC, amount: PRICE_ATOMIC, network: NETWORK } },
      receipts: { method: 'GET', path: '/receipts/:intentHash' },
      mandates: Object.keys(deps.mandates),
    }),
  )

  // Validate before payment: a malformed request is refused for free and never charged.
  const validate = async (c: Context<Vars>, next: () => Promise<void>) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return json(c, { error: 'body must be JSON' }, 400)
    }
    const parsed = CheckRequestV0.safeParse(body)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      return json(c, { error: 'invalid check request', issues }, 400)
    }
    const mandate = deps.mandates[parsed.data.mandateId]
    if (mandate === undefined) return json(c, { error: `unknown mandate ${parsed.data.mandateId}` }, 404)
    if (parsed.data.claims === undefined) {
      return json(c, { error: 'prose extraction is not configured on this validator; send typed claims' }, 422)
    }
    c.set('checkRequest', parsed.data)
    c.set('mandate', mandate)
    await next()
  }

  app.post('/check', validate, paymentMiddleware(paymentRoutes(deps.payTo), server), async (c) => {
    const result = await runCheck(c.get('checkRequest'), c.get('mandate'), deps.checkDeps())
    await deps.receipts.put(result.signed.intentHash, result.receiptJson)
    return json(c, {
      mandateId: result.mandateId,
      verdict: result.verdict,
      signed: result.signed,
      receipt: result.receipt,
    })
  })

  // CORS on this read-only route only, any origin, so third parties can fetch receipts from their
  // own pages. POST /check and every other route stay without CORS headers.
  app.use('/receipts/:intentHash', cors({ origin: '*', allowMethods: ['GET'], maxAge: 86400 }))

  app.get('/receipts/:intentHash', async (c) => {
    const key = c.req.param('intentHash').toLowerCase()
    if (!INTENT_HASH.test(key)) return json(c, { error: 'intentHash must be 32 bytes of hex' }, 400)
    const stored = await deps.receipts.get(key)
    if (stored === null) return json(c, { error: 'no receipt for this intentHash' }, 404)
    return c.body(stored, 200, { 'content-type': 'application/json; charset=utf-8' })
  })

  return app
}
