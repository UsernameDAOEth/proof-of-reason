import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { observeAuditAll } from 'proof-of-reason-engine/audit'
import { chainByName } from 'proof-of-reason-engine/chains'
import { SchemaError } from 'proof-of-reason-engine/claims'
import { compare } from 'proof-of-reason-engine/compare'
import type { AnyObservation, ClaimResult } from 'proof-of-reason-engine/compare'
import { ENGINE_VERSION, RULESET, canonicalJson } from 'proof-of-reason-engine/receipt'
import { decide } from 'proof-of-reason-engine/verdict'
import type { Verdict } from 'proof-of-reason-engine/verdict'
import { MissingRpcUrl, viemReaders } from './chain.ts'
import type { ShadowReaders } from './chain.ts'
import { locate } from './locate.ts'
import type { LocateResult, LocatedTx, Unlocated } from './locate.ts'
import { parseClaimRecord } from './record.ts'
import type { ClaimRecordV0 } from './record.ts'
import { ZerionError, createZerionClient } from './zerion.ts'

export const SHADOW_SCHEMA = 'proof-of-reason/shadow-record/v0'
export const SHADOW_VERSION = '0.1.0'
export const NO_TYPED_CLAIMS = 'no typed claims: prose extraction is not configured'

export type ShadowStatus = 'TRUE' | 'FALSE' | 'UNVERIFIABLE' | 'UNLOCATED'

export type ShadowRecordBody = {
  schema: typeof SHADOW_SCHEMA
  shadowVersion: string
  engineVersion: string
  ruleset: string
  chainId: number
  record: ClaimRecordV0
  located: LocatedTx | Unlocated
  pinnedBlock: bigint | null
  observations: AnyObservation[]
  results: ClaimResult[]
  verdict: Verdict | null
  status: ShadowStatus
  notes: string[]
  /** Zerion data only. Nothing under this key is read when deciding a status. */
  context: { zerion: LocateResult['context'] | null }
}

export type ShadowRecord = ShadowRecordBody & { sha256: string }

/** Record-level status: any FALSE premise, else any UNVERIFIABLE (or nothing checkable), else TRUE. */
export function recordStatus(located: LocatedTx | Unlocated, results: readonly ClaimResult[]): ShadowStatus {
  if (located.status === 'UNLOCATED') return 'UNLOCATED'
  if (results.some((r) => r.status === 'FALSE')) return 'FALSE'
  if (results.length === 0 || results.some((r) => r.status === 'UNVERIFIABLE')) return 'UNVERIFIABLE'
  return 'TRUE'
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function seal(body: ShadowRecordBody): ShadowRecord {
  return { ...body, sha256: sha256Canonical(body) }
}

/** Recomputes the sha256 of a record as read back from JSON. */
export function verifySeal(record: object): boolean {
  const { sha256, ...body } = record as { sha256?: unknown }
  return typeof sha256 === 'string' && sha256Canonical(body) === sha256
}

/** Pretty JSON in canonical key order: bigints become base-10 strings, as in the hash. */
export function recordJson(record: ShadowRecord): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(record)), null, 2)}\n`
}

/**
 * Audits one claim record: locate, observe every typed claim at the located block, compare, and
 * decide. `locateFn` is Zerion-backed in a normal run and chain-only in a re-run.
 */
export async function auditRecord(
  input: unknown,
  deps: { readers: ShadowReaders; chainId: number; locateFn: (record: ClaimRecordV0) => Promise<LocateResult> },
): Promise<ShadowRecord> {
  const record = parseClaimRecord(input)
  const found = await deps.locateFn(record)
  const notes: string[] = []
  const base = {
    schema: SHADOW_SCHEMA,
    shadowVersion: SHADOW_VERSION,
    engineVersion: ENGINE_VERSION,
    ruleset: RULESET,
    chainId: deps.chainId,
    record,
    located: found.located,
    context: { zerion: found.context.transaction === null && found.context.listing.pages === 0 ? null : found.context },
  } as const

  if (found.located.status === 'UNLOCATED') {
    return seal({ ...base, pinnedBlock: null, observations: [], results: [], verdict: null, status: 'UNLOCATED', notes })
  }

  const pinnedBlock = found.located.blockNumber
  const claims = record.claims ?? []
  if (claims.length === 0) notes.push(NO_TYPED_CLAIMS)
  const observations = await observeAuditAll(deps.readers, claims, pinnedBlock)
  const results = claims.map((claim, i) => compare(claim, observations[i]!))
  const verdict = decide({ results, actionMismatches: [], mandateViolations: [], requiredKinds: [] })
  return seal({
    ...base,
    pinnedBlock,
    observations,
    results,
    verdict,
    status: recordStatus(found.located, results),
    notes,
  })
}

/** Error text safe to print: our own messages only. Library errors can carry RPC URLs. */
export function safeError(error: unknown): string {
  if (error instanceof ZerionError || error instanceof SchemaError || error instanceof MissingRpcUrl) {
    return `${error.name}: ${error.message}`
  }
  return error instanceof Error ? error.name : 'Error'
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(args: string[]) {
  const inputDir = argValue(args, '--in') ?? 'inputs'
  const outputDir = argValue(args, '--out') ?? 'records'
  const only = argValue(args, '--only')
  mkdirSync(outputDir, { recursive: true })
  const zerion = createZerionClient()
  const files = readdirSync(inputDir).filter((f) => f.endsWith('.json') && (only === undefined || f === `${only}.json`))
  let failed = 0
  for (const file of files.sort()) {
    try {
      const input = JSON.parse(readFileSync(join(inputDir, file), 'utf8')) as { chain?: string }
      const chain = chainByName(String(input.chain))
      const readers = viemReaders(chain)
      const record = await auditRecord(input, {
        readers,
        chainId: chain.chainId,
        locateFn: (r) => locate(r, { zerion, tx: readers.tx, chainId: chain.chainId }),
      })
      writeFileSync(join(outputDir, `${record.record.id}.json`), recordJson(record))
      console.log(`${record.record.id}: ${record.status} sha256 ${record.sha256}`)
    } catch (error) {
      failed++
      console.error(`${file}: not written (${safeError(error)})`)
    }
  }
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(safeError(error))
    process.exitCode = 1
  })
}

