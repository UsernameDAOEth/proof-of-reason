import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLedger, countRecords, loadRecords, summaryLine } from '../src/ledger.ts'
import { SHADOW_SCHEMA, recordJson, seal } from '../src/run.ts'
import type { ShadowRecord, ShadowStatus } from '../src/run.ts'
import type { ClaimResult } from 'proof-of-reason-engine/compare'
import { WALLET, claimRecord } from './helpers.ts'

function make(id: string, status: ShadowStatus, results: ClaimResult[], postedAt = '2026-09-10T12:00:00Z'): ShadowRecord {
  const located =
    status === 'UNLOCATED'
      ? ({ status: 'UNLOCATED', reason: 'no confirmed transaction from the wallet within the window' } as const)
      : ({
          status: 'LOCATED',
          txHash: `0x${'ab'.repeat(32)}`,
          blockNumber: 100n,
          blockTimestamp: 1n,
          from: WALLET,
          to: null,
          selector: null,
          deltaSeconds: -60,
        } as const)
  return seal({
    schema: SHADOW_SCHEMA,
    shadowVersion: '0.1.0',
    engineVersion: '0.2.0',
    ruleset: 'REASON-R0',
    chainId: 8453,
    record: claimRecord({ id, posted_at: postedAt }) as unknown as ShadowRecord['record'],
    located,
    pinnedBlock: status === 'UNLOCATED' ? null : 100n,
    observations: [],
    results,
    verdict: null,
    status,
    notes: [],
    context: { zerion: null },
  })
}

const t = (id: string, status: ClaimResult['status'], claimed: number | string = 2.3, observed: number | string | null = 2.29): ClaimResult => ({
  id,
  kind: 'rate',
  status,
  claimed,
  observed,
  block: 100n,
})

const RECORDS = [
  make('a-true', 'TRUE', [t('r1', 'TRUE'), t('l1', 'TRUE')]),
  make('b-false', 'FALSE', [t('r1', 'FALSE', 5, 2.29), t('l1', 'UNVERIFIABLE', 1, null)]),
  make('c-unverifiable', 'UNVERIFIABLE', [t('r1', 'UNVERIFIABLE', 2.3, null)]),
  make('d-prose', 'UNVERIFIABLE', []),
  make('e-unlocated', 'UNLOCATED', []),
  make('f-false', 'FALSE', [t('r1', 'FALSE', 9, 2.29)], '2026-09-11T08:00:00Z'),
]

describe('ledger', () => {
  it('counts N audited (located), F with a FALSE premise, U unverifiable, X unlocated', () => {
    expect(countRecords(RECORDS)).toEqual({ audited: 5, falsePremise: 2, unverifiable: 2, unlocated: 1 })
    expect(summaryLine(countRecords(RECORDS))).toBe('5 audited, 2 with at least one FALSE premise, 2 unverifiable, 1 unlocated')
    expect(summaryLine(countRecords([]))).toBe('0 audited, 0 with at least one FALSE premise, 0 unverifiable, 0 unlocated')
  })

  it('writes one row per claim, and one row for records with no claim result', () => {
    const ledger = buildLedger(RECORDS)
    const rows = ledger.split('\n').filter((l) => l.startsWith('| 2026-'))
    expect(rows).toHaveLength(2 + 2 + 1 + 1 + 1 + 1)
    expect(ledger).toContain('5 audited, 2 with at least one FALSE premise, 2 unverifiable, 1 unlocated')
    expect(ledger).toContain('False-premise rate among audited actions: 2/5.')
    expect(rows[0]).toBe(`| 2026-09-10 | Fixture Allocator | base | rate | 2.3 | 2.29 | TRUE | ${RECORDS[0]!.sha256} |`)
    expect(rows.find((r) => r.includes('UNLOCATED'))).toBe(`| 2026-09-10 | Fixture Allocator | base | - | - | - | UNLOCATED | ${RECORDS[4]!.sha256} |`)
    expect(rows.at(-1)).toContain('2026-09-11')
  })

  it('loads records from disk and refuses one whose content no longer matches its sha256', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-ledger-'))
    for (const r of RECORDS) writeFileSync(join(dir, `${r.record.id}.json`), recordJson(r))
    expect(countRecords(loadRecords(dir))).toEqual({ audited: 5, falsePremise: 2, unverifiable: 2, unlocated: 1 })
    const tampered = JSON.parse(recordJson(RECORDS[1]!)) as Record<string, unknown>
    tampered.status = 'TRUE'
    writeFileSync(join(dir, 'b-false.json'), JSON.stringify(tampered))
    expect(() => loadRecords(dir)).toThrow('b-false.json: sha256 does not match its content')
  })
})
