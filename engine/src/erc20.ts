import { z } from 'zod'
import { parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'
import { AddressString, DecimalString, SchemaError, claimCommon } from './claims.ts'

/** Audit-only claim: an ERC-20 balance at the pinned block. */
export const BalanceClaim = z.strictObject({
  ...claimCommon,
  kind: z.literal('balance'),
  token: AddressString.describe('ERC-20 token address'),
  holder: AddressString.describe('address whose balance is claimed'),
  amount: DecimalString.describe('claimed balance, token atomic units'),
  toleranceAtomic: DecimalString.describe('allowed absolute difference, token atomic units'),
})

export type BalanceClaim = z.infer<typeof BalanceClaim>

export const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

/** Every read is pinned to a block. */
export interface Erc20Reader {
  hasCode(address: Address, block: bigint): Promise<boolean>
  balanceOf(token: Address, holder: Address, block: bigint): Promise<bigint>
}

export function viemErc20Reader(client: Pick<PublicClient, 'readContract' | 'getCode'>): Erc20Reader {
  return {
    async hasCode(address, block) {
      const code = await client.getCode({ address, blockNumber: block })
      return code !== undefined && code !== '0x'
    },
    async balanceOf(token, holder, block) {
      return client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
        blockNumber: block,
      })
    },
  }
}

export type BalanceObservation = {
  kind: 'balance'
  token: Address
  holder: Address
  block: bigint
  balance: bigint | null
  unverifiable: string | null
}

/** One read for code, then one for the balance, at the pinned block. */
export async function observeBalance(reader: Erc20Reader, claimInput: unknown, block: bigint): Promise<BalanceObservation> {
  const parsed = BalanceClaim.safeParse(claimInput)
  if (!parsed.success) throw new SchemaError('invalid balance claim', parsed.error.issues.map((i) => i.message))
  const claim = parsed.data
  const token = claim.token as Address
  const holder = claim.holder as Address
  const base = { kind: 'balance', token, holder, block } as const
  if (!(await reader.hasCode(token, block))) {
    return { ...base, balance: null, unverifiable: 'token has no code at the pinned block' }
  }
  return { ...base, balance: await reader.balanceOf(token, holder, block), unverifiable: null }
}
