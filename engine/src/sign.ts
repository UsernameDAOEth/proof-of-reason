import { hashTypedData } from 'viem'
import type { Address, Hex, LocalAccount } from 'viem'

// This module never reads keys from disk or env. The caller passes a LocalAccount in.

export const DOMAIN_NAME = 'Proof of Reason'
export const DOMAIN_VERSION = '1'

export const intentTypes = {
  Intent: [
    { name: 'vault', type: 'address' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'claimsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'notAfterBlock', type: 'uint64' },
  ],
} as const

export const verdictTypes = {
  Verdict: [
    { name: 'intentHash', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'checkedAtBlock', type: 'uint64' },
    { name: 'receiptHash', type: 'bytes32' },
  ],
} as const

export const overrideTypes = {
  Override: [{ name: 'intentHash', type: 'bytes32' }],
} as const

export type GateDomain = {
  name: typeof DOMAIN_NAME
  version: typeof DOMAIN_VERSION
  chainId: number
  verifyingContract: Address
}

export type IntentMessage = {
  vault: Address
  dataHash: Hex
  claimsHash: Hex
  nonce: bigint
  notAfterBlock: bigint
}

export type VerdictMessage = {
  intentHash: Hex
  outcome: 1 | 2 | 3
  checkedAtBlock: bigint
  receiptHash: Hex
}

export function gateDomain(chainId: number, gate: Address): GateDomain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: gate }
}

/** The gate's intentHash: the full EIP-712 digest of Intent under the gate's domain. */
export function hashIntent(domain: GateDomain, intent: IntentMessage): Hex {
  return hashTypedData({ domain, types: intentTypes, primaryType: 'Intent', message: intent })
}

export function verdictDigest(domain: GateDomain, verdict: VerdictMessage): Hex {
  return hashTypedData({ domain, types: verdictTypes, primaryType: 'Verdict', message: verdict })
}

/** Digest the owner signs to override a WAIT. */
export function overrideDigest(domain: GateDomain, intentHash: Hex): Hex {
  return hashTypedData({
    domain,
    types: overrideTypes,
    primaryType: 'Override',
    message: { intentHash },
  })
}

export async function signVerdict(
  account: LocalAccount,
  domain: GateDomain,
  verdict: VerdictMessage,
): Promise<Hex> {
  return account.signTypedData({
    domain,
    types: verdictTypes,
    primaryType: 'Verdict',
    message: verdict,
  })
}
