import { pathToFileURL } from 'node:url'
import { decodeFunctionData, toFunctionSelector } from 'viem'
import type { Address, Hex } from 'viem'
import { vaultAbi } from 'proof-of-reason-engine/action'
import { chainByName } from 'proof-of-reason-engine/chains'
import { viemReaders } from './chain.ts'
import type { TxReader } from './chain.ts'
import { safeError } from './run.ts'
import { createZerionClient } from './zerion.ts'
import type { ZerionClient } from './zerion.ts'

// Selectors computed from the vault ABI in engine/src/action.ts, never hardcoded.
const REALLOCATE = toFunctionSelector('reallocate(((address,address,address,address,uint256),uint256)[])')
const ALLOCATE = toFunctionSelector('allocate(address,bytes,uint256)')

export type ProspectRow = {
  address: Address
  vault: Address
  method: 'reallocate' | 'allocate'
  calls: number
  /** reallocate only: allocation legs summed over calls. */
  legs: number
  /** allocate only: assets summed over calls, vault asset atomic units. */
  assets: bigint
  first: string
  last: string
}

/**
 * Context only, never a status. Zerion lists each address's transactions over the last `days`;
 * the chain says whether each one is a successful reallocate or allocate sent by that address,
 * and its calldata gives the size.
 */
export async function prospect(
  addresses: readonly Address[],
  deps: {
    zerion: Pick<ZerionClient, 'listTransactions'>
    tx: TxReader
    chainId: number
    now?: Date
    days?: number
    maxTransactions?: number
  },
): Promise<{ rows: ProspectRow[]; truncated: boolean }> {
  const now = deps.now ?? new Date()
  const from = new Date(now.getTime() - (deps.days ?? 30) * 86_400_000)
  const max = deps.maxTransactions ?? 2_000
  const rows = new Map<string, ProspectRow>()
  let truncated = false
  let checked = 0

  for (const address of addresses) {
    const listing = await deps.zerion.listTransactions(address, { chain: deps.chainId, from, to: now })
    truncated ||= listing.truncated
    for (const t of listing.transactions) {
      const hash = t.attributes?.hash
      if (!hash || t.attributes?.status !== 'confirmed') continue
      if (t.attributes.sent_from !== undefined && t.attributes.sent_from.toLowerCase() !== address.toLowerCase()) continue
      if (checked >= max) {
        truncated = true
        break
      }
      checked++
      const tx = await deps.tx.getTransaction(hash as Hex)
      if (!tx.success || tx.to === null || tx.from.toLowerCase() !== address.toLowerCase()) continue
      const selector = tx.input.slice(0, 10).toLowerCase()
      if (selector !== REALLOCATE && selector !== ALLOCATE) continue
      let legs = 0
      let assets = 0n
      try {
        const call = decodeFunctionData({ abi: vaultAbi, data: tx.input })
        if (call.functionName === 'reallocate') legs = call.args[0].length
        if (call.functionName === 'allocate') assets = call.args[2]
      } catch {
        continue
      }
      const method = selector === REALLOCATE ? 'reallocate' : 'allocate'
      const at = t.attributes.mined_at ?? ''
      const key = `${address.toLowerCase()}|${tx.to.toLowerCase()}|${method}`
      const row = rows.get(key) ?? { address, vault: tx.to, method, calls: 0, legs: 0, assets: 0n, first: at, last: at }
      row.calls++
      row.legs += legs
      row.assets += assets
      if (at < row.first) row.first = at
      if (at > row.last) row.last = at
      rows.set(key, row)
    }
  }
  return { rows: [...rows.values()].sort((a, b) => b.calls - a.calls || a.address.localeCompare(b.address)), truncated }
}

export function prospectTable(rows: readonly ProspectRow[]): string {
  return [
    '| Address | Vault | Method | Calls | Legs | Assets (atomic) | First | Last |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.address} | ${r.vault} | ${r.method} | ${r.calls} | ${r.legs} | ${r.assets} | ${r.first} | ${r.last} |`),
  ].join('\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--chain')
  const chainName = i >= 0 ? args[i + 1] : 'base'
  const addresses = args.filter((a, j) => /^0x[0-9a-fA-F]{40}$/.test(a) && j !== i + 1) as Address[]
  ;(async () => {
    const chain = chainByName(String(chainName))
    const readers = viemReaders(chain)
    const { rows, truncated } = await prospect(addresses, { zerion: createZerionClient(), tx: readers.tx, chainId: chain.chainId })
    console.log(prospectTable(rows))
    if (truncated) console.log('\nTruncated: the listing or the transaction cap was reached.')
    console.log('\nContext only. Prospecting never sets an audit status.')
  })().catch((error: unknown) => {
    console.error(safeError(error))
    process.exitCode = 1
  })
}
