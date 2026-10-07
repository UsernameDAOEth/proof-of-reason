import { HTTPFacilitatorClient } from '@x402/core/server'
import type { FacilitatorClient } from '@x402/core/server'
import { createPublicClient, http, isAddress } from 'viem'
import type { Address, Hex, LocalAccount } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monad } from 'viem/chains'
import { viemMorphoReader } from 'proof-of-reason-engine/morpho'
import { viemKuruReader } from 'proof-of-reason-engine/kuru'
import { createApp } from './app.ts'
import type { ReceiptStore } from './app.ts'
import { HttpError } from './check.ts'
import { CHAIN_ID, FACILITATOR_URL, MORPHO, PRICE_ATOMIC } from './config.ts'
import { viemLeashReader } from './leash.ts'
import { MANDATES } from './mandates.ts'
import { viemRegistryWriter } from './registry.ts'

/**
 * Worker bindings. VALIDATOR_KEY and MONAD_RPC_URL are Cloudflare secrets: the archive RPC URL
 * carries an access token. Everything else is public.
 */
export interface Env {
  RECEIPTS: ReceiptStore
  VALIDATOR_KEY: string
  MONAD_RPC_URL: string
  GATE_ADDRESS: string
  VAULT_ADDRESS: string
  PAY_TO: string
  /** Interim ERC-8004 Validation Registry. Empty until it is deployed: verdicts are then unrecorded. */
  REGISTRY_ADDRESS?: string
}

export class ConfigError extends Error {
  constructor(variable: string) {
    // Names the variable, never its value.
    super(`worker is not configured: ${variable}`)
    this.name = 'ConfigError'
  }
}

function requireAddress(value: string | undefined, variable: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new ConfigError(variable)
  return value as Address
}

/** Reads the VALIDATOR_KEY secret at request time. The key is never logged or echoed. */
export function validatorAccount(env: Pick<Env, 'VALIDATOR_KEY'>): LocalAccount {
  const key = env.VALIDATOR_KEY
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new HttpError(500, 'validator key is not configured')
  }
  return privateKeyToAccount(key as Hex)
}

export function buildApp(env: Env, facilitator?: FacilitatorClient) {
  const gate = requireAddress(env.GATE_ADDRESS, 'GATE_ADDRESS')
  const vault = requireAddress(env.VAULT_ADDRESS, 'VAULT_ADDRESS')
  const payTo = requireAddress(env.PAY_TO, 'PAY_TO')
  if (typeof env.MONAD_RPC_URL !== 'string' || !env.MONAD_RPC_URL.startsWith('https://')) {
    throw new ConfigError('MONAD_RPC_URL')
  }

  // One JSON-RPC request per read: no JSON-RPC batch (the Foundation RPC forbids it) and no
  // Multicall. The observers issue those reads one at a time (docs/MONAD.md, RPC policy).
  const client = createPublicClient({ chain: monad, transport: http(env.MONAD_RPC_URL, { batch: false }) })
  // The registry write is signed by the same VALIDATOR_KEY that signs the verdict, through the same
  // RPC. Without REGISTRY_ADDRESS nothing is written and every receipt records that.
  const registryAddress =
    typeof env.REGISTRY_ADDRESS === 'string' && isAddress(env.REGISTRY_ADDRESS, { strict: false })
      ? (env.REGISTRY_ADDRESS as Address)
      : undefined
  const reader = viemMorphoReader(client, MORPHO)
  const kuru = viemKuruReader(client)
  let chainChecked = false
  const getBlockNumber = async () => {
    if (!chainChecked) {
      const chainId = await client.getChainId()
      if (chainId !== CHAIN_ID) throw new Error(`RPC serves chain ${chainId}, expected ${CHAIN_ID}`)
      chainChecked = true
    }
    return client.getBlockNumber({ cacheTime: 0 })
  }

  return createApp({
    facilitator: facilitator ?? new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    payTo,
    receipts: env.RECEIPTS,
    mandates: MANDATES,
    leash: viemLeashReader(client, payTo, BigInt(PRICE_ATOMIC)),
    checkDeps: () => {
      const account = validatorAccount(env)
      return {
        reader,
        kuru,
        getBlockNumber,
        account,
        chainId: CHAIN_ID,
        gate,
        vault,
        registry:
          registryAddress === undefined
            ? undefined
            : viemRegistryWriter({ address: registryAddress, account, rpcUrl: env.MONAD_RPC_URL }),
      }
    },
  })
}

let cached: { env: Env; app: ReturnType<typeof buildApp> } | undefined

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    try {
      if (cached === undefined || cached.env !== env) cached = { env, app: buildApp(env) }
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : 'worker is not configured'
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return cached.app.fetch(request, env, ctx as never)
  },
}
