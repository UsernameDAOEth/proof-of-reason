import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Hex } from 'viem'
import { chainById } from 'proof-of-reason-engine/chains'
import { canonicalJson } from 'proof-of-reason-engine/receipt'
import { viemReaders } from './chain.ts'
import type { ShadowReaders } from './chain.ts'
import { locateByHash } from './locate.ts'
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
  match: boolean
}

/**
 * Re-runs a stored record from its JSON alone: the recorded tx hash is checked on chain, every
 * claim is observed again at the block before it, and the result is compared field by field.
 * Zerion is not used.
 */
export async function rerunRecord(stored: ShadowRecord, readers: ShadowReaders): Promise<RerunReport> {
  const sealValid = verifySeal(stored)
  const hash = stored.located.status === 'LOCATED' ? (stored.located.txHash as Hex) : null
  const fresh = await auditRecord(stored.record, {
    readers,
    chainId: stored.chainId,
    locateFn: async (record) =>
      hash === null
        ? { located: stored.located, context: { transaction: null, listing: { pages: 0, truncated: false, listed: 0, candidates: 0, checkedOnChain: 0 } } }
        : locateByHash(record, hash, readers.tx),
  })
  const fields = Object.fromEntries(
    RERUN_FIELDS.map((f) => [f, canonicalJson(fresh[f] ?? null) === canonicalJson(stored[f] ?? null)]),
  ) as RerunReport['fields']
  return { sealValid, fields, match: sealValid && Object.values(fields).every(Boolean) }
}

async function main(args: string[]) {
  const path = args[0]
  if (path === undefined) throw new Error('usage: node src/rerun.ts <records/id.json>')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as ShadowRecord
  const report = await rerunRecord(stored, viemReaders(chainById(stored.chainId)))
  console.log(`seal ${report.sealValid ? 'valid' : 'INVALID'}`)
  for (const [field, ok] of Object.entries(report.fields)) console.log(`${field}: ${ok ? 'MATCH' : 'MISMATCH'}`)
  console.log(report.match ? 'MATCH' : 'MISMATCH')
  if (!report.match) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(safeError(error))
    process.exitCode = 1
  })
}
