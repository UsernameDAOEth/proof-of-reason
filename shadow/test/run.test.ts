import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJson } from 'proof-of-reason-engine/receipt'
import { locate } from '../src/locate.ts'
import { rerunRecord } from '../src/rerun.ts'
import { NO_TYPED_CLAIMS, auditRecord, recordJson, sha256Canonical, verifySeal } from '../src/run.ts'
import type { ShadowRecord } from '../src/run.ts'
import { createZerionClient } from '../src/zerion.ts'
import type { ZerionTransaction } from '../src/zerion.ts'
import {
  BASE_CHAIN_ID,
  FakeTxReader,
  blockAt,
  claimRecord,
  hash,
  listingRoutes,
  readers,
  trueClaims,
  zerionFetch,
  ztx,
} from './helpers.ts'

beforeEach(() => {
  process.env.ZERION_API_KEY = 'zk_test_run'
})
afterEach(() => {
  delete process.env.ZERION_API_KEY
})

const LISTED = [ztx(1, 300), ztx(2, -120), ztx(3, -1800)]
const CHAIN = [
  { n: 1, offsetSeconds: 300 },
  { n: 2, offsetSeconds: -120 },
  { n: 3, offsetSeconds: -1800 },
]

async function audit(record: unknown, listed: ZerionTransaction[] = LISTED) {
  const tx = new FakeTxReader(CHAIN)
  const zerion = createZerionClient({ fetch: zerionFetch(listingRoutes(listed)) })
  return auditRecord(record, {
    readers: readers(tx, blockAt(-120)),
    chainId: BASE_CHAIN_ID,
    locateFn: (r) => locate(r, { zerion, tx, chainId: BASE_CHAIN_ID }),
  })
}

describe('run: one fixture record end to end', () => {
  it('locates, observes at the pinned block, compares, decides, and seals', async () => {
    const record = await audit(claimRecord())
    const pinned = blockAt(-120)
    expect(record.located).toMatchObject({ status: 'LOCATED', txHash: hash(2), blockNumber: pinned })
    expect(record.pinnedBlock).toBe(pinned)
    expect(record.observations.map((o) => o.kind)).toEqual(['rate', 'liquidity', 'vault_rate', 'balance'])
    expect(record.observations.every((o) => o.block === pinned)).toBe(true)
    expect(record.results.map((r) => [r.id, r.status])).toEqual([
      ['r1', 'TRUE'],
      ['l1', 'TRUE'],
      ['v1', 'TRUE'],
      ['b1', 'TRUE'],
    ])
    expect(record.status).toBe('TRUE')
    expect(record.verdict?.outcome).toBe('PASS')
    const { sha256, ...body } = record
    expect(sha256).toBe(sha256Canonical(body))
  })

  it('writes JSON whose sha256 is the sha256 of its canonical JSON without the seal', async () => {
    const record = await audit(claimRecord())
    const dir = mkdtempSync(join(tmpdir(), 'shadow-records-'))
    const path = join(dir, `${record.record.id}.json`)
    writeFileSync(path, recordJson(record))
    const back = JSON.parse(readFileSync(path, 'utf8')) as ShadowRecord & { sha256: string }
    expect(verifySeal(back)).toBe(true)
    const { sha256, ...body } = back
    expect(sha256Canonical(body)).toBe(sha256)
    expect(back.pinnedBlock).toBe(blockAt(-120).toString())
    expect(verifySeal({ ...back, status: 'FALSE' })).toBe(false)
  })

  it('a stale premise makes the record FALSE with claimed, observed, and block', async () => {
    const claims = trueClaims()
    claims[0] = { ...claims[0]!, valuePct: 5 } as (typeof claims)[number]
    const record = await audit(claimRecord({ claims }))
    expect(record.status).toBe('FALSE')
    expect(record.results[0]).toMatchObject({ id: 'r1', status: 'FALSE', claimed: 5, block: blockAt(-120) })
    expect(record.verdict?.outcome).toBe('FAIL')
  })

  it('an UNLOCATED record has no observations and no verdict', async () => {
    const record = await audit(claimRecord(), [])
    expect(record.status).toBe('UNLOCATED')
    expect(record).toMatchObject({ pinnedBlock: null, observations: [], results: [], verdict: null })
  })

  it('a prose-only record is located but UNVERIFIABLE, with a note', async () => {
    const record = await audit(claimRecord({ claims: undefined, prose: 'rates look better on B' }))
    expect(record.located.status).toBe('LOCATED')
    expect(record.status).toBe('UNVERIFIABLE')
    expect(record.notes).toEqual([NO_TYPED_CLAIMS])
  })

  it('Zerion context never changes a status: different Zerion attributes, same results', async () => {
    const plain = await audit(claimRecord())
    const noisy = LISTED.map((t) => ({
      ...t,
      attributes: { ...t.attributes, operation_type: 'trade', fee: { value: 999 }, transfers: [{ direction: 'out', value: 1e9 }] },
    }))
    const other = await audit(claimRecord(), noisy)
    for (const field of ['located', 'pinnedBlock', 'observations', 'results', 'verdict', 'status'] as const) {
      expect(canonicalJson(other[field])).toBe(canonicalJson(plain[field]))
    }
    expect(canonicalJson(other.context)).not.toBe(canonicalJson(plain.context))
    expect(other.context.zerion?.transaction?.attributes.operation_type).toBe('trade')
  })

  it('a third party re-runs the record from its JSON, without Zerion, and matches', async () => {
    const record = await audit(claimRecord())
    const stored = JSON.parse(recordJson(record)) as ShadowRecord
    delete process.env.ZERION_API_KEY
    const tx = new FakeTxReader(CHAIN)
    const report = await rerunRecord(stored, readers(tx, blockAt(-120)))
    expect(report).toEqual({
      sealValid: true,
      fields: { located: true, pinnedBlock: true, observations: true, results: true, verdict: true, status: true },
      match: true,
    })
    expect(tx.calls).toEqual([`tx:${hash(2)}`, `ts:${blockAt(-120)}`])
  })

  it('a re-run against different chain state reports the mismatch', async () => {
    const stored = JSON.parse(recordJson(await audit(claimRecord()))) as ShadowRecord
    const tx = new FakeTxReader(CHAIN)
    const drifted = readers(tx, blockAt(-120))
    drifted.erc20 = { hasCode: async () => true, balanceOf: async () => 1n }
    const report = await rerunRecord(stored, drifted)
    expect(report.match).toBe(false)
    expect(report.fields).toMatchObject({ observations: false, results: false, status: false, located: true })
  })
})
