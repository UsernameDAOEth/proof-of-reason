import { TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, http } from 'viem'
import type { Address, Chain, Hex } from 'viem'
import { base, mainnet, monad } from 'viem/chains'
import type { AuditReaders } from 'proof-of-reason-engine/audit'
import type { ChainConfig } from 'proof-of-reason-engine/chains'
import { viemErc20Reader } from 'proof-of-reason-engine/erc20'
import { viemErc4626Reader } from 'proof-of-reason-engine/erc4626'
import { viemMorphoReader } from 'proof-of-reason-engine/morpho'

/** A transaction as the chain reports it. Locating never trusts Zerion for these fields. */
export type TxInfo = {
  hash: Hex
  from: Address
  to: Address | null
  input: Hex
  blockNumber: bigint
  success: boolean
}

export interface TxReader {
  /** null when the chain has no such transaction. Any other read failure throws. */
  getTransaction(hash: Hex): Promise<TxInfo | null>
  getBlockTimestamp(block: bigint): Promise<bigint>
}

export type ShadowReaders = AuditReaders & { tx: TxReader }

export class MissingRpcUrl extends Error {
  constructor(variable: string) {
    // Names the variable, never a value.
    super(`${variable} is not set`)
    this.name = 'MissingRpcUrl'
  }
}

const VIEM_CHAINS: Record<number, Chain> = { 143: monad, 8453: base, 1: mainnet }

/** Reads the chain's RPC URL from its environment variable at call time. */
export function rpcUrlFor(chain: ChainConfig, env: NodeJS.ProcessEnv = process.env): string {
  const url = env[chain.rpcUrlEnv]
  if (!url) throw new MissingRpcUrl(chain.rpcUrlEnv)
  return url
}

/** One JSON-RPC request per read: no batch, no Multicall (docs/MONAD.md section 8). */
export function viemReaders(chain: ChainConfig, env: NodeJS.ProcessEnv = process.env): ShadowReaders {
  const client = createPublicClient({ chain: VIEM_CHAINS[chain.chainId], transport: http(rpcUrlFor(chain, env), { batch: false }) })
  return {
    morpho: viemMorphoReader(client, chain),
    erc4626: viemErc4626Reader(client),
    erc20: viemErc20Reader(client),
    tx: {
      async getTransaction(hash) {
        let tx
        let receipt
        try {
          tx = await client.getTransaction({ hash })
          receipt = await client.getTransactionReceipt({ hash })
        } catch (error) {
          if (error instanceof TransactionNotFoundError || error instanceof TransactionReceiptNotFoundError) return null
          throw error
        }
        if (tx.blockNumber === null) throw new Error('transaction is pending')
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to ?? null,
          input: tx.input,
          blockNumber: tx.blockNumber,
          success: receipt.status === 'success',
        }
      },
      async getBlockTimestamp(block) {
        return (await client.getBlock({ blockNumber: block })).timestamp
      },
    },
  }
}
