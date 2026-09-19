import type { Address } from 'viem'

// Every value below is resolved with a source in docs/MONAD.md.

/** x402 v2 CAIP-2 network id for Monad mainnet. */
export const NETWORK = 'eip155:143' as const
export const CHAIN_ID = 143

/** Monad USDC. Its on-chain EIP-712 domain is name "USDC", version "2" (docs/MONAD.md section 1). */
export const USDC: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
export const USDC_EIP712 = { name: 'USDC', version: '2' } as const

export const FACILITATOR_URL = 'https://x402-facilitator.molandak.org'

/** 0.10 USDC in atomic units (6 decimals). */
export const PRICE_ATOMIC = '100000'

export const MORPHO: Address = '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee'

/**
 * The pinned block is the RPC head minus this lag, so every node behind a load-balanced public
 * endpoint already has the state. 2 blocks is about 0.6 s on Monad.
 */
export const CHECK_LAG_BLOCKS = 2n

/** Upper bound on the calldata the worker will decode, in bytes. */
export const MAX_CALLDATA_BYTES = 16_384
