import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJson } from 'proof-of-reason-engine/receipt'
import { locate } from '../src/locate.ts'
import { RERUN_FIELDS, rerunRecord } from '../src/rerun.ts'
import { NO_TYPED_CLAIMS, SHADOW_VERSION, auditRecord, recordJson, sha256Canonical, verifySeal } from '../src/run.ts'
import type { ShadowRecord } from '../src/run.ts'
import { createZerionClient } from '../src/zerion.ts'
import type { ZerionTransaction } from '../src/zerion.ts'
import {
  BASE_CHAIN_ID,
  FakeMorpho,
  FakeTxReader,
  OTHER,
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

// Three listed candidates; on chain only tx 2 matches (tx 1 went to another contract, tx 3 reverted).
const LISTED = [ztx(1, 300), ztx(2, -120), ztx(3, -1800)]
const CHAIN = [
  { n: 1, offsetSeconds: 300, to: OTHER },
  { n: 2, offsetSeconds: -120 },
  { n: 3, offsetSeconds: -1800, success: false },
]
const ACTION = blockAt(-120)
const PINNED = ACTION - 1n
const AUDITED_AT = new Date('2026-10-05T09:30:00Z')

async function audit(record: unknown, listed: ZerionTransaction[] = LISTED, shadow = readers(new FakeTxReader(CHAIN), ACTION)) {
  const zerion = createZerionClient({ fetch: zerionFetch(listingRoutes(listed)) })
  return auditRecord(record, {
    readers: shadow,
    chainId: BASE_CHAIN_ID,
    locateFn: (r) => locate(r, { zerion, tx: shadow.tx, chainId: BASE_CHAIN_ID }),
    now: () => AUDITED_AT,
  })
}

describe('run: one fixture record end to end', () => {
  it('locates, observes at the block before the action, compares, decides, and seals', async () => {
    const record = await audit(claimRecord())
    expect(record.located).toMatchObject({ status: 'LOCATED', txHash: hash(2), blockNumber: ACTION })
    expect(record.pinnedBlock).toBe(PINNED)
    expect(record.observations.map((o) => o.kind)).toEqual(['rate', 'liquidity', 'vault_rate', 'balance'])
    expect(record.observations.every((o) => o.block === PINNED)).toBe(true)
    expect(record.results.map((r) => [r.id, r.status])).toEqual([
      ['r1', 'TRUE'],
      ['l1', 'TRUE'],
      ['v1', 'TRUE'],
      ['b1', 'TRUE'],
    ])
    expect(record.status).toBe('TRUE')
    expect(record.verdict?.outcome).toBe('PASS')
    expect(record.shadowVersion).toBe(SHADOW_VERSION)
    expect(record.auditedAt).toBe('2026-10-05T09:30:00.000Z')
    const { sha256, ...body } = record
    expect(sha256).toBe(sha256Canonical(body))
    expect(sha256Canonical({ ...body, auditedAt: '2026-10-06T00:00:00.000Z' })).not.toBe(sha256)
  })

  it('every read, including every block of a multi-block window, ends at the action block minus 1', async () => {
    const shadow = readers(new FakeTxReader(CHAIN), ACTION)
    const record = await audit(claimRecord(), LISTED, shadow)
    const blocks = (shadow.morpho as FakeMorpho).calls.map((c) => BigInt(c.split('@')[1]!))
    expect(blocks.length).toBeGreaterThan(1)
    expect(blocks.every((b) => b <= PINNED)).toBe(true)
    expect(blocks).toContain(PINNED)
    expect(blocks).toContain(PINNED - 4n)
    expect(record.results.every((r) => r.block === PINNED)).toBe(true)
  })

  it('a record with tx_hash is located by that hash, outside any window, and read at its block minus 1', async () => {
    const far = -86_400 * 2
    const tx = new FakeTxReader([...CHAIN, { n: 9, offsetSeconds: far }])
    const shadow = readers(tx, blockAt(far))
    const record = await audit(claimRecord({ tx_hash: hash(9), source_text: `Moved idle USDC in ${hash(9)}.` }), LISTED, shadow)
    expect(record.located).toMatchObject({ status: 'LOCATED', txHash: hash(9), blockNumber: blockAt(far) })
    expect(record.pinnedBlock).toBe(blockAt(far) - 1n)
    expect(record.context.zerion).toBeNull()
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
    expect(back.pinnedBlock).toBe(PINNED.toString())
    expect(verifySeal({ ...back, status: 'FALSE' })).toBe(false)
  })

  it('a stale premise makes the record FALSE with claimed, observed, and block', async () => {
    const claims = trueClaims()
    claims[0] = { ...claims[0]!, valuePct: 5 } as (typeof claims)[number]
    const record = await audit(claimRecord({ claims }))
    expect(record.status).toBe('FALSE')
    expect(record.results[0]).toMatchObject({ id: 'r1', status: 'FALSE', claimed: 5, block: PINNED })
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
    for (const field of RERUN_FIELDS) {
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
    // The re-run happens later: auditedAt differs and is not compared.
    const report = await rerunRecord(stored, readers(tx, ACTION))
    expect(report).toEqual({
      sealValid: true,
      fields: Object.fromEntries(RERUN_FIELDS.map((f) => [f, true])),
      match: true,
    })
    expect(tx.calls).toEqual([`tx:${hash(2)}`, `ts:${ACTION}`])
  })

  it('a re-run compares every field except auditedAt, context, and the seal', async () => {
    const record = await audit(claimRecord())
    const keys = Object.keys(record).filter((k) => !['auditedAt', 'context', 'sha256'].includes(k))
    expect([...RERUN_FIELDS].sort()).toEqual(keys.sort())
  })

  it('a re-run against different chain state reports the mismatch', async () => {
    const stored = JSON.parse(recordJson(await audit(claimRecord()))) as ShadowRecord
    const tx = new FakeTxReader(CHAIN)
    const drifted = readers(tx, ACTION)
    drifted.erc20 = { hasCode: async () => true, balanceOf: async () => 1n }
    const report = await rerunRecord(stored, drifted)
    expect(report.match).toBe(false)
    expect(report.fields).toMatchObject({ observations: false, results: false, status: false, located: true })
  })
})
