import { parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'

/**
 * Leash (https://github.com/iamrobertmoore/leash): an owner caps what an agent key may spend per day,
 * which sellers it may pay and until when, on LeashHub. One view call reads it. The worker reads it
 * only for a request that names an agent in `x-leash-agent`. LeashHub on Monad mainnet, source-verified:
 * https://monadvision.com/contracts/full_match/143/0x64a489074dd6a4b3b977e5f635a178366a8c12c3/
 */
export const LEASH_HUB: Address = '0x64a489074dd6a4b3b977e5f635a178366a8c12c3'

export const leashHubAbi = parseAbi([
  'function check(address agent, address seller, uint256 amount) view returns (uint8 status, uint256 remainingToday, uint64 expiry, uint256 agentId, address account)',
])

/** LeashHub's status codes, in order. */
export const LEASH_STATUS = ['OK', 'UNKNOWN_AGENT', 'REVOKED', 'EXPIRED', 'SELLER_NOT_ALLOWED', 'OVER_CAP'] as const

/** Integers as base-10 strings, like the rest of the canonical JSON. remainingToday is 6-decimal dollars. */
export type LeashVerdict = {
  agent: Address
  status: (typeof LEASH_STATUS)[number]
  remainingToday: string
  expiry: string
  agentId: string
}

export type LeashReader = (agent: Address) => Promise<LeashVerdict>

/** A leash that exists and says no. An agent with no leash at all is not refused. */
export function leashRefuses(verdict: LeashVerdict): boolean {
  return verdict.status !== 'OK' && verdict.status !== 'UNKNOWN_AGENT'
}

/** Asks LeashHub whether `agent` may pay `payTo` the price of one check right now. */
export function viemLeashReader(client: Pick<PublicClient, 'readContract'>, payTo: Address, priceAtomic: bigint): LeashReader {
  return async (agent) => {
    const [status, remaining, expiry, agentId] = await client.readContract({
      address: LEASH_HUB,
      abi: leashHubAbi,
      functionName: 'check',
      args: [agent, payTo, priceAtomic],
    })
    const name = LEASH_STATUS[status]
    if (name === undefined) throw new Error(`unknown leash status ${status}`)
    return { agent, status: name, remainingToday: remaining.toString(), expiry: expiry.toString(), agentId: agentId.toString() }
  }
}
