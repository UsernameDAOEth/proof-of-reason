import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Address, Hex } from 'viem'
import { chainById } from 'proof-of-reason-engine/chains'
import { canonicalJson } from 'proof-of-reason-engine/receipt'
import { viemReaders } from './chain.ts'
import type { ShadowReaders } from './chain.ts'
import { locateByHash, windowNonces, windowOf } from './locate.ts'
import type { LocateResult } from './locate.ts'
import { auditRecord, safeError, verifySeal } from './run.ts'
import type { ShadowRecord } from './run.ts'

/**
 * The fields a re-run must reproduce: every field except auditedAt (the time of the run), the
 * Zerion context, and the seal.
 */
export const RERUN_FIELDS = [
  'schema',
  'shadowVersion',
  'engineVersion',
  'ruleset',
  'chainId',
  'record',
  'located',
  'completeness',
  'pinnedBlock',
  'observations',
  'results',
  'verdict',
  'status',
  'notes',
] as const

export type RerunReport = {
  sealValid: boolean
  fields: Record<(typeof RERUN_FIELDS)[number], boolean>
  /**
   * For a record located without tx_hash: whether the sealed boundary blocks are still the first
   * and last blocks of the window, and whether the located block lies between them. null otherwise.
   */
  window: { boundaries: boolean; locatedInside: boolean | null } | null
  match: boolean
}

/** Checks with four timestamp reads that first and last are the window's boundary blocks. */
async function boundariesHold(readers: ShadowReaders, first: bigint, last: bigint, fromMs: number, toMs: number) {
  const ms = async (block: bigint) => (await readers.tx.getBlockTimestamp(block)) * 1000n
  const from = BigInt(fromMs)
  const to = BigInt(toMs)
  if (first > 0n && (await ms(first - 1n)) >= from) return false
  if ((await ms(first)) < from) return false
  if (last >= 0n && (await ms(last)) > to) return false
  return (await ms(last + 1n)) > to
}

/**
 * Re-runs a stored record from its JSON alone: the recorded tx hash is checked on chain, every
 * claim is observed again at the block before it, and the result is compared field by field. For
 * a record located without tx_hash, the wallet's nonces are read again at the sealed boundary
 * blocks, the boundaries are checked against block timestamps, and the located block must lie
 * between them. Zerion is not used.
 */
export async function rerunRecord(stored: ShadowRecord, readers: ShadowReaders): Promise<RerunReport> {
  const sealValid = verifySeal(stored)
  const hash = stored.located.status === 'LOCATED' ? (stored.located.txHash as Hex) : null
  const sealed = stored.completeness ?? null
  const first = sealed === null ? 0n : BigInt(sealed.firstBlock)
  const last = sealed === null ? 0n : BigInt(sealed.lastBlock)
  const fresh = await auditRecord(stored.record, {
    readers,
    chainId: stored.chainId,
    locateFn: async (record): Promise<LocateResult> => {
      const found: LocateResult =
        hash === null
          ? {
              located: stored.located,
              completeness: null,
              context: { transaction: null, listing: { pages: 0, truncated: false, listed: 0, candidates: 0, checkedOnChain: 0 } },
            }
          : await locateByHash(record, hash, readers.tx)
      if (sealed === null) return found
      const nonces = await windowNonces(readers.tx, record.agent.wallet as Address, first, last)
      return { ...found, completeness: { firstBlock: first, lastBlock: last, ...nonces } }
    },
  })
  const fields = Object.fromEntries(
    RERUN_FIELDS.map((f) => [f, canonicalJson(fresh[f] ?? null) === canonicalJson(stored[f] ?? null)]),
  ) as RerunReport['fields']
  let window: RerunReport['window'] = null
  if (sealed !== null) {
    const { fromMs, toMs } = windowOf(stored.record)
    const block = stored.located.status === 'LOCATED' ? BigInt(stored.located.blockNumber) : null
    window = {
      boundaries: await boundariesHold(readers, first, last, fromMs, toMs),
      locatedInside: block === null ? null : block >= first && block <= last,
    }
  }
  const windowOk = window === null || (window.boundaries && window.locatedInside !== false)
  return { sealValid, fields, window, match: sealValid && windowOk && Object.values(fields).every(Boolean) }
}

async function main(args: string[]) {
  const path = args[0]
  if (path === undefined) throw new Error('usage: node src/rerun.ts <records/id.json>')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as ShadowRecord
  const report = await rerunRecord(stored, viemReaders(chainById(stored.chainId)))
  console.log(`seal ${report.sealValid ? 'valid' : 'INVALID'}`)
  for (const [field, ok] of Object.entries(report.fields)) console.log(`${field}: ${ok ? 'MATCH' : 'MISMATCH'}`)
  if (report.window !== null) {
    console.log(`window boundaries: ${report.window.boundaries ? 'MATCH' : 'MISMATCH'}`)
    if (report.window.locatedInside !== null) console.log(`located block inside the window: ${report.window.locatedInside ? 'yes' : 'NO'}`)
  }
  console.log(report.match ? 'MATCH' : 'MISMATCH')
  if (!report.match) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(safeError(error))
    process.exitCode = 1
  })
}
