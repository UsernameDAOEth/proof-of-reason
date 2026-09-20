import type { Address } from 'viem'

export type ChainName = 'monad' | 'base' | 'ethereum'

/**
 * Per-chain Morpho configuration. Addresses come from @morpho-org/morpho-ts 2.15.0
 * `addresses[ChainId]` (re-exported by @morpho-org/morpho-sdk 5.13.0) and are listed on
 * docs.morpho.org/developers/contracts/addresses; sources and on-chain checks in docs/MONAD.md
 * section 10. The engine never reads the environment: `rpcUrlEnv` names the variable a caller
 * reads at call time.
 */
export type ChainConfig = {
  name: ChainName
  chainId: number
  rpcUrlEnv: string
  morpho: Address
  adaptiveCurveIrm: Address
}

export const CHAINS: Readonly<Record<ChainName, ChainConfig>> = {
  monad: {
    name: 'monad',
    chainId: 143,
    rpcUrlEnv: 'MONAD_RPC_URL',
    morpho: '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee',
    adaptiveCurveIrm: '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F',
  },
  base: {
    name: 'base',
    chainId: 8453,
    rpcUrlEnv: 'BASE_RPC_URL',
    morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    adaptiveCurveIrm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
  },
  ethereum: {
    name: 'ethereum',
    chainId: 1,
    rpcUrlEnv: 'ETHEREUM_RPC_URL',
    morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    adaptiveCurveIrm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
  },
}

export function chainByName(name: string): ChainConfig {
  const chain = (CHAINS as Record<string, ChainConfig | undefined>)[name]
  if (chain === undefined) throw new RangeError(`unknown chain ${name}`)
  return chain
}

export function chainById(chainId: number): ChainConfig {
  const chain = Object.values(CHAINS).find((c) => c.chainId === chainId)
  if (chain === undefined) throw new RangeError(`unknown chain id ${chainId}`)
  return chain
}
