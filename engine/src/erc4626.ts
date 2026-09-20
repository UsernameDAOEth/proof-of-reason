import { z } from 'zod'
import { parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'
import {
  AddressString,
  MAX_VAULT_LOOKBACK_BLOCKS,
  SECONDS_PER_YEAR,
  SchemaError,
  VAULT_PROBE_SHARES,
  WAD,
  claimCommon,
} from './claims.ts'

/** Audit-only claim: an ERC-4626 vault's annualized share-price growth over a block window. */
export const VaultRateClaim = z.strictObject({
  ...claimCommon,
  kind: z.literal('vault_rate'),
  vault: AddressString.describe('ERC-4626 vault address'),
  valuePct: z.number().min(-100).describe('claimed annualized share-price growth in percent'),
  basis: z.enum(['APY', 'APR']).describe('annualization basis of valuePct'),
  compounding: z.literal('continuous').describe('APY compounding convention'),
  lookbackBlocks: z
    .number()
    .int()
    .min(1)
    .max(MAX_VAULT_LOOKBACK_BLOCKS)
    .describe('the rate is measured from block (pinned - lookbackBlocks) to the pinned block'),
  tolerancePp: z.number().min(0).describe('allowed absolute difference, in percentage points'),
})

export type VaultRateClaim = z.infer<typeof VaultRateClaim>

export const erc4626Abi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
])

/** Every read is pinned to a block. */
export interface Erc4626Reader {
  blockTimestamp(block: bigint): Promise<bigint>
  hasCode(address: Address, block: bigint): Promise<boolean>
  convertToAssets(vault: Address, shares: bigint, block: bigint): Promise<bigint>
  totalAssets(vault: Address, block: bigint): Promise<bigint>
}

export function viemErc4626Reader(
  client: Pick<PublicClient, 'readContract' | 'getBlock' | 'getCode'>,
): Erc4626Reader {
  return {
    async blockTimestamp(block) {
      return (await client.getBlock({ blockNumber: block })).timestamp
    },
    async hasCode(address, block) {
      const code = await client.getCode({ address, blockNumber: block })
      return code !== undefined && code !== '0x'
    },
    async convertToAssets(vault, shares, block) {
      return client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: 'convertToAssets',
        args: [shares],
        blockNumber: block,
      })
    },
    async totalAssets(vault, block) {
      return client.readContract({ address: vault, abi: erc4626Abi, functionName: 'totalAssets', blockNumber: block })
    },
  }
}

export type VaultRateObservation = {
  kind: 'vault_rate'
  vault: Address
  basis: 'APY' | 'APR'
  block: bigint
  startBlock: bigint
  startTimestamp: bigint | null
  endTimestamp: bigint | null
  probeShares: bigint
  assetsStart: bigint | null
  assetsEnd: bigint | null
  totalAssets: bigint | null
  valuePct: number | null
  unverifiable: string | null
}

/**
 * Annual rate in percent from share-price growth, continuous compounding:
 * ratePerSecond = ln(assetsEnd / assetsStart) / elapsed, APR = ratePerSecond * 31,536,000,
 * APY = exp(APR) - 1.
 */
export function vaultRatePct(
  assetsStart: bigint,
  assetsEnd: bigint,
  elapsedSeconds: bigint,
  basis: 'APY' | 'APR',
): number {
  if (assetsStart <= 0n) throw new RangeError('assetsStart must be positive')
  if (elapsedSeconds <= 0n) throw new RangeError('elapsedSeconds must be positive')
  const growth = Number(((assetsEnd - assetsStart) * WAD) / assetsStart) / Number(WAD)
  const apr = (Math.log1p(growth) / Number(elapsedSeconds)) * Number(SECONDS_PER_YEAR)
  return (basis === 'APR' ? apr : Math.expm1(apr)) * 100
}

/** Reads the start block, then the pinned block, one read at a time. Never batched. */
export async function observeVaultRate(
  reader: Erc4626Reader,
  claimInput: unknown,
  block: bigint,
): Promise<VaultRateObservation> {
  const parsed = VaultRateClaim.safeParse(claimInput)
  if (!parsed.success) throw new SchemaError('invalid vault_rate claim', parsed.error.issues.map((i) => i.message))
  const claim = parsed.data
  const vault = claim.vault as Address
  const startBlock = block - BigInt(claim.lookbackBlocks)
  if (startBlock < 0n) throw new RangeError('lookback starts before genesis')
  const base = {
    kind: 'vault_rate',
    vault,
    basis: claim.basis,
    block,
    startBlock,
    probeShares: VAULT_PROBE_SHARES,
  } as const
  const empty = { startTimestamp: null, endTimestamp: null, assetsStart: null, assetsEnd: null, totalAssets: null }

  const startTimestamp = await reader.blockTimestamp(startBlock)
  if (!(await reader.hasCode(vault, startBlock))) {
    return { ...base, ...empty, startTimestamp, valuePct: null, unverifiable: 'vault has no code at the start block' }
  }
  const assetsStart = await reader.convertToAssets(vault, VAULT_PROBE_SHARES, startBlock)
  const endTimestamp = await reader.blockTimestamp(block)
  const assetsEnd = await reader.convertToAssets(vault, VAULT_PROBE_SHARES, block)
  const totalAssets = await reader.totalAssets(vault, block)
  const read = { startTimestamp, endTimestamp, assetsStart, assetsEnd, totalAssets }

  if (assetsStart === 0n) return { ...base, ...read, valuePct: null, unverifiable: 'share price is 0 at the start block' }
  const elapsed = endTimestamp - startTimestamp
  if (elapsed <= 0n) return { ...base, ...read, valuePct: null, unverifiable: 'no time elapsed across the window' }
  return { ...base, ...read, valuePct: vaultRatePct(assetsStart, assetsEnd, elapsed, claim.basis), unverifiable: null }
}
