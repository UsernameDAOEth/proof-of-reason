import { createWalletClient, http, parseAbi, parseGwei } from 'viem'
import type { Account, Address, Chain, Hex } from 'viem'
import { monad } from 'viem/chains'

/**
 * The interim ERC-8004 Validation Registry (contracts/src/ValidationRegistry.sol, docs/MONAD.md
 * section 12). The worker uses the addition that takes the agent id, because a WAIT or a FAIL is
 * exactly the case where the agent filed no request, and those records are the point.
 */
export const validationRegistryAbi = parseAbi([
  'function validationResponse(uint256 agentId, bytes32 requestHash, uint8 response, bytes32 responseHash, string tag)',
])

/** PASS, WAIT, FAIL as the ERC's uint8 0 to 100. */
export const OUTCOME_RESPONSE = { PASS: 100, WAIT: 50, FAIL: 0 } as const
export type RegistryResponse = (typeof OUTCOME_RESPONSE)[keyof typeof OUTCOME_RESPONSE]

/**
 * Explicit gas limit. Monad charges the full limit, not the gas used, so this is never estimated per
 * request. A first record writes the validator, the agent id, the response, the response hash and
 * the tag, pushes two index entries and emits one event; a repeat response overwrites and is
 * cheaper. The runbook measures it with `cast estimate` after deployment and this constant is
 * updated from that number.
 */
export const GAS_VALIDATION_RESPONSE = 300_000n

/** Monad hardcodes eth_maxPriorityFeePerGas at 2 gwei; a high static cap costs nothing. */
export const MAX_FEE_GWEI = '400'
export const PRIORITY_FEE_GWEI = '2'

export type ValidationWrite = {
  agentId: bigint
  requestHash: Hex
  response: RegistryResponse
  responseHash: Hex
  tag: string
}

export interface RegistryWriter {
  readonly address: Address
  write(write: ValidationWrite): Promise<Hex>
}

/**
 * One validator key means one nonce sequence, so two verdicts in flight must not both fetch the same
 * pending nonce. Writes through one writer are queued, in the order they were asked for. Across
 * Worker isolates this cannot be enforced; a collision there surfaces as a registry error on one
 * receipt, never as a wrong verdict, because the write is fail-soft.
 */
export function serialised<T>(): (task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
}

export function viemRegistryWriter(args: {
  address: Address
  account: Account
  rpcUrl: string
  chain?: Chain
  gas?: bigint
}): RegistryWriter {
  const client = createWalletClient({
    account: args.account,
    chain: args.chain ?? monad,
    // One request at a time, never batched: the Foundation RPC forbids JSON-RPC batch.
    transport: http(args.rpcUrl, { batch: false }),
  })
  const queue = serialised<Hex>()
  return {
    address: args.address,
    async write(write) {
      return queue(() =>
        client.writeContract({
          address: args.address,
          abi: validationRegistryAbi,
          functionName: 'validationResponse',
          args: [write.agentId, write.requestHash, write.response, write.responseHash, write.tag],
          gas: args.gas ?? GAS_VALIDATION_RESPONSE,
          maxFeePerGas: parseGwei(MAX_FEE_GWEI),
          maxPriorityFeePerGas: parseGwei(PRIORITY_FEE_GWEI),
        }),
      )
    },
  }
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

/**
 * The RPC URL is a secret: it carries an access token, and viem puts the URL it called into its
 * error messages. Only a short, URL-free description of the failure ever reaches a receipt.
 */
export function describeRegistryError(error: unknown): string {
  const raw =
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? `${error.name}: ${error.message.split('\n')[0]}`)
      : String(error)
  return raw.replace(URL_PATTERN, '[url]').slice(0, 200)
}
