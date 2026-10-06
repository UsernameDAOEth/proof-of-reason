import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLedger, corrections, countA1, countRecords, loadRecords, parseAgents, summaryLine } from '../src/ledger.ts'
import type { AgentType } from '../src/ledger.ts'
import { SHADOW_SCHEMA, recordJson, seal } from '../src/run.ts'
import type { ShadowRecord, ShadowStatus } from '../src/run.ts'
import type { ClaimResult } from 'proof-of-reason-engine/compare'
import { WALLET, claimRecord } from './helpers.ts'

const LISTED = '2026-10-01T00:00Z'
const LISTED_S = Date.parse(LISTED) / 1000
const AFTER = '2026-10-02T12:00:00Z'
const AFTER_S = BigInt(Date.parse(AFTER) / 1000)
const AUDITED = '2026-10-05T09:00:00.000Z'

type Make = {
  postedAt?: string
  wallet?: string
  chain?: string
  blockTimestamp?: bigint
  auditedAt?: string
  window?: { beforeSeconds: number; afterSeconds: number }
}

function make(id: string, status: ShadowStatus, results: ClaimResult[], opts: Make = {}): ShadowRecord {
  const postedAt = opts.postedAt ?? AFTER
  const wallet = (opts.wallet ?? WALLET) as `0x${string}`
  const located =
    status === 'UNLOCATED'
      ? ({ status: 'UNLOCATED', reason: 'no matching transaction in the window' } as const)
      : ({
          status: 'LOCATED',
          txHash: `0x${'ab'.repeat(32)}`,
          blockNumber: 100n,
          blockTimestamp: opts.blockTimestamp ?? BigInt(Date.parse(postedAt) / 1000) - 60n,
          from: wallet,
          to: null,
          selector: null,
          deltaSeconds: -60,
        } as const)
  const record = claimRecord({
    id,
    posted_at: postedAt,
    agent: { name: 'Fixture Allocator', wallet },
    chain: opts.chain ?? 'base',
    ...(opts.window ? { window: opts.window } : {}),
  })
  return seal({
    schema: SHADOW_SCHEMA,
    shadowVersion: '0.3.0',
    engineVersion: '0.2.0',
    ruleset: 'REASON-R0',
    chainId: 8453,
    auditedAt: opts.auditedAt ?? AUDITED,
    record: record as unknown as ShadowRecord['record'],
    located,
    completeness: null,
    pinnedBlock: status === 'UNLOCATED' ? null : 99n,
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
  block: 99n,
})

const HEADER = [
  '| Listed (UTC) | Agent | Type | Wallet | Chain | Where it explains its actions |',
  '| --- | --- | --- | --- | --- | --- |',
]

function agentsMd(rows: string[]): string {
  return ['# agents', '', 'Prose above the table.', '', ...HEADER, ...rows, ''].join('\n')
}

const row = (wallet: string, type: AgentType = 'vault allocator', listed = LISTED, chain = 'base', name = 'Fixture Allocator') =>
  `| ${listed} | ${name} | ${type} | ${wallet} | ${chain} | https://example.org/agent |`

const walletN = (i: number) => `0x${(0x1000 + i).toString(16).padStart(40, '0')}`

/** n counted records for one agent, `falses` of them FALSE, posted one hour apart after listing. */
function agentRecords(wallet: string, n: number, falses: number, prefix = wallet.slice(-4)): ShadowRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const postedAt = new Date((Number(AFTER_S) + i * 3600) * 1000).toISOString()
    return i < falses
      ? make(`${prefix}-${String(i).padStart(2, '0')}`, 'FALSE', [t('r1', 'FALSE', 5)], { wallet, postedAt })
      : make(`${prefix}-${String(i).padStart(2, '0')}`, 'TRUE', [t('r1', 'TRUE')], { wallet, postedAt })
  })
}

/** `agents` listed agents with `per` counted records each and `falses` FALSE records in total. */
function population(agents: number, per: number, falses: number) {
  const rows: string[] = []
  const records: ShadowRecord[] = []
  for (let a = 0; a < agents; a++) {
    rows.push(row(walletN(a)))
    records.push(...agentRecords(walletN(a), per, a < falses ? 1 : 0))
  }
  return { agents: parseAgents(agentsMd(rows)), records }
}

const RECORDS = [
  make('a-true', 'TRUE', [t('r1', 'TRUE'), t('l1', 'TRUE')]),
  make('b-false', 'FALSE', [t('r1', 'FALSE', 5, 2.29), t('l1', 'UNVERIFIABLE', 1, null)]),
  make('c-unverifiable', 'UNVERIFIABLE', [t('r1', 'UNVERIFIABLE', 2.3, null)]),
  make('d-prose', 'UNVERIFIABLE', []),
  make('e-unlocated', 'UNLOCATED', []),
  make('f-false', 'FALSE', [t('r1', 'FALSE', 9, 2.29)], { postedAt: '2026-10-03T08:00:00Z' }),
]

describe('ledger: the old all-records line', () => {
  it('counts N audited (located), F with a FALSE premise, U unverifiable, X unlocated', () => {
    expect(countRecords(RECORDS)).toEqual({ audited: 5, falsePremise: 2, unverifiable: 2, unlocated: 1 })
    expect(summaryLine(countRecords(RECORDS))).toBe('5 audited, 2 with at least one FALSE premise, 2 unverifiable, 1 unlocated')
    expect(summaryLine(countRecords([]))).toBe('0 audited, 0 with at least one FALSE premise, 0 unverifiable, 0 unlocated')
  })

  it('keeps the old line, labeled as not the A1 count, and one row per claim with whether it counts', () => {
    const ledger = buildLedger(RECORDS, parseAgents(agentsMd([row(WALLET)])))
    expect(ledger).toContain(
      'All records, not the A1 count: 5 audited, 2 with at least one FALSE premise, 2 unverifiable, 1 unlocated.',
    )
    const rows = ledger.split('\n').filter((l) => l.startsWith('| 2026-'))
    expect(rows).toHaveLength(2 + 2 + 1 + 1 + 1 + 1)
    expect(rows[0]).toBe(`| 2026-10-02 | Fixture Allocator | base | rate | 2.3 | 2.29 | TRUE | yes | ${RECORDS[0]!.sha256} |`)
    expect(rows.find((r) => r.includes('UNLOCATED'))).toBe(
      `| 2026-10-02 | Fixture Allocator | base | - | - | - | UNLOCATED | no: unlocated | ${RECORDS[4]!.sha256} |`,
    )
    expect(rows.find((r) => r.includes(RECORDS[2]!.sha256))).toContain('| no: no claim decided TRUE or FALSE |')
    expect(rows.at(-1)).toContain('2026-10-03')
  })

  it('loads records from disk and refuses one whose content no longer matches its sha256', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-ledger-'))
    for (const r of RECORDS) writeFileSync(join(dir, `${r.record.id}.json`), recordJson(r))
    const loaded = loadRecords(dir)
    expect(countRecords(loaded)).toEqual({ audited: 5, falsePremise: 2, unverifiable: 2, unlocated: 1 })
    // Read back from JSON (bigints as strings), the A1 count is the same.
    const agents = parseAgents(agentsMd([row(WALLET)]))
    expect(countA1(loaded, agents)).toMatchObject({ counted: 3, falsePremise: 2 })
    const tampered = JSON.parse(recordJson(RECORDS[1]!)) as Record<string, unknown>
    tampered.status = 'TRUE'
    writeFileSync(join(dir, 'b-false.json'), JSON.stringify(tampered))
    expect(() => loadRecords(dir)).toThrow('b-false.json: sha256 does not match its content')
  })
})

describe('ledger: shadow/AGENTS.md rows', () => {
  it('parses every row, and the committed AGENTS.md parses', () => {
    const rows = parseAgents(agentsMd([row(walletN(1), 'trader', '2026-10-01T09:30Z', 'monad', 'Agent One')]))
    expect(rows).toEqual([
      {
        line: 7,
        listed: '2026-10-01T09:30Z',
        listedMs: Date.parse('2026-10-01T09:30:00Z'),
        agent: 'Agent One',
        type: 'trader',
        wallet: walletN(1),
        chain: 'monad',
        source: 'https://example.org/agent',
      },
    ])
    expect(parseAgents(readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8'))).toEqual([])
  })

  it('a malformed row throws with its line number; none is skipped', () => {
    const bad: [string, string][] = [
      [row(WALLET, 'vault allocator', '2026-10-01 00:00'), 'line 7: listing time "2026-10-01 00:00" is not YYYY-MM-DDTHH:MMZ'],
      [row(WALLET, 'vault allocator', '2026-10-01T00:00:00Z'), 'is not YYYY-MM-DDTHH:MMZ'],
      [row(WALLET, 'vault allocator', '2026-02-30T00:00Z'), 'is not a real UTC time'],
      [row(WALLET, 'allocator' as AgentType), 'type "allocator" is not one of vault allocator, trader, other'],
      [row('0x1234'), 'wallet "0x1234" is not an address'],
      [row(WALLET, 'trader', LISTED, 'solana'), 'chain "solana" is not one of monad, base, ethereum'],
      [row(WALLET, 'trader', LISTED, 'base', ''), 'agent is empty'],
      [`| ${LISTED} | Agent | trader | ${WALLET} | base |`, 'expected 6 columns, found 5'],
    ]
    for (const [line, message] of bad) {
      expect(() => parseAgents(agentsMd([row(walletN(9)), line].reverse()))).toThrow(message)
    }
    expect(() => parseAgents('# agents\n\nno table here\n')).toThrow('no agent table')
  })

  it('a line inside the table without its leading pipe throws with its line number', () => {
    const md = agentsMd([row(walletN(1)), row(walletN(2)).slice(1)])
    expect(() => parseAgents(md)).toThrow('AGENTS.md line 8: a line inside the agent table must start with "|"')
    expect(() => parseAgents(agentsMd([` ${row(walletN(1))}`]))).toThrow('AGENTS.md line 7: a line inside the agent table must start with "|"')
  })

  it('a non-blank line after the table throws; blank lines after it do not', () => {
    const after = ['# agents', '', ...HEADER, row(walletN(1)), '', '', row(walletN(2)), ''].join('\n')
    expect(() => parseAgents(after)).toThrow('AGENTS.md line 8: text after the agent table')
    const prose = ['# agents', '', ...HEADER, row(walletN(1)), '', 'A note under the table.'].join('\n')
    expect(() => parseAgents(prose)).toThrow('AGENTS.md line 7: text after the agent table')
    const trailing = ['# agents', '', ...HEADER, row(walletN(1)), '', '   ', ''].join('\n')
    expect(parseAgents(trailing)).toHaveLength(1)
  })

  it('a header without its delimiter row throws', () => {
    expect(() => parseAgents(['# agents', HEADER[0], row(WALLET)].join('\n'))).toThrow("AGENTS.md line 3: expected the table's delimiter row")
  })
})

describe('ledger: one wallet listed twice (PREREG Amendment 2)', () => {
  const twice = (later = '2026-10-03T00:00Z') =>
    parseAgents(
      agentsMd([
        row(WALLET, 'trader', '2026-10-01T00:00Z', 'base', 'First Name'),
        row(walletN(5), 'other'),
        row(WALLET, 'vault allocator', later, 'base', 'Corrected Name'),
      ]),
    )

  it('counts from the earliest row and takes the type from the latest', () => {
    const agents = twice()
    const between = make('between', 'TRUE', [t('r1', 'TRUE')], { postedAt: '2026-10-02T00:00:00Z' })
    const late = make('late', 'FALSE', [t('r1', 'FALSE', 5)], { postedAt: '2026-10-04T00:00:00Z' })
    const a1 = countA1([between, late], agents)
    expect(a1.reasons.get('between')).toBeNull()
    expect(a1.reasons.get('late')).toBeNull()
    expect(a1.byType['vault allocator']).toMatchObject({ counted: 2, falsePremise: 1 })
    expect(a1.byType.trader.counted).toBe(0)
  })

  it('a later row neither drops a counted record nor bars the agent', () => {
    const records = [
      make('counted-early', 'FALSE', [t('r1', 'FALSE', 5)], { postedAt: '2026-10-02T00:00:00Z', auditedAt: '2026-10-02T06:00:00.000Z' }),
      make('counted-late', 'TRUE', [t('r1', 'TRUE')], { postedAt: '2026-10-08T00:00:00Z', auditedAt: '2026-10-08T06:00:00.000Z' }),
    ]
    const once = parseAgents(agentsMd([row(WALLET, 'trader', '2026-10-01T00:00Z')]))
    const before = countA1(records, once)
    expect(before).toMatchObject({ counted: 2, falsePremise: 1 })
    // A row added after both audits, listed later than both: the first one was audited before it.
    const after = countA1(records, twice('2026-10-09T00:00Z'))
    expect(after).toMatchObject({ counted: 2, falsePremise: 1, passBasis: 2, passFalse: 1 })
    expect([...after.reasons.values()]).toEqual([null, null])
    // A later row with an earlier listing time does not move the listing time either.
    const earlier = parseAgents(agentsMd([row(WALLET, 'trader', '2026-10-01T00:00Z'), row(WALLET, 'trader', '2026-09-01T00:00Z')]))
    const old = make('before-first-row', 'TRUE', [t('r1', 'TRUE')], { postedAt: '2026-09-20T00:00:00Z' })
    expect(countA1([...records, old], earlier).reasons.get('before-first-row')).toBe('transaction not after listing')
  })

  it('lists every correction in LEDGER.md: wallet, chain, and each row with its line and listing time', () => {
    const agents = twice()
    expect(corrections(agents).map((a) => [a.wallet, a.chain, a.rows.map((r) => r.line)])).toEqual([[WALLET, 'base', [7, 9]]])
    const ledger = buildLedger([], agents)
    expect(ledger).toContain('| Wallet | Chain | Rows (line, listing time) | Counts from | Name, type, source from |')
    expect(ledger).toContain(`| ${WALLET} | base | line 7 2026-10-01T00:00Z; line 9 2026-10-03T00:00Z | line 7 2026-10-01T00:00Z | line 9 |`)
    expect(buildLedger([], parseAgents(agentsMd([row(WALLET)])))).toContain('Corrections (PREREG Amendment 2): none.')
  })

  it('the same wallet on another chain is a new agent with its own listing time', () => {
    const agents = parseAgents(agentsMd([row(WALLET, 'trader', '2026-10-01T00:00Z'), row(WALLET, 'other', '2026-10-03T00:00Z', 'monad')]))
    expect(corrections(agents)).toEqual([])
    const monad = make('monad', 'TRUE', [t('r1', 'TRUE')], { chain: 'monad', postedAt: '2026-10-02T00:00:00Z' })
    expect(countA1([monad], agents).reasons.get('monad')).toBe('transaction not after listing')
  })
})

describe('ledger: which records count (PREREG Amendment 1)', () => {
  const agents = parseAgents(agentsMd([row(WALLET)]))

  it('a transaction or a statement at or before the listing time is not counted', () => {
    const txBefore = make('tx-before', 'TRUE', [t('r1', 'TRUE')], { blockTimestamp: BigInt(LISTED_S) - 1n })
    const txAt = make('tx-at', 'TRUE', [t('r1', 'TRUE')], { blockTimestamp: BigInt(LISTED_S) })
    const postedBefore = make('posted-before', 'TRUE', [t('r1', 'TRUE')], {
      postedAt: '2026-09-30T23:59:00Z',
      blockTimestamp: BigInt(LISTED_S) + 60n,
    })
    const ok = make('ok', 'TRUE', [t('r1', 'TRUE')], { blockTimestamp: BigInt(LISTED_S) + 1n })
    const a1 = countA1([txBefore, txAt, postedBefore, ok], agents)
    expect(a1.reasons.get('tx-before')).toBe('transaction not after listing')
    expect(a1.reasons.get('tx-at')).toBe('transaction not after listing')
    expect(a1.reasons.get('posted-before')).toBe('statement not after listing')
    expect(a1.reasons.get('ok')).toBeNull()
    expect(a1.counted).toBe(1)
  })

  it('a record audited before the listing time disqualifies every record of that agent', () => {
    const early = make('audited-early', 'UNLOCATED', [], { auditedAt: '2026-09-30T00:00:00.000Z' })
    const good = make('good', 'FALSE', [t('r1', 'FALSE', 5)])
    expect(countA1([good], agents).counted).toBe(1)
    const a1 = countA1([early, good], agents)
    expect(a1.counted).toBe(0)
    expect(a1.reasons.get('good')).toBe('agent audited before its listing')
    // Another listed agent is unaffected.
    const two = parseAgents(agentsMd([row(WALLET), row(walletN(1))]))
    const other = make('other', 'TRUE', [t('r1', 'TRUE')], { wallet: walletN(1) })
    expect(countA1([early, good, other], two).counted).toBe(1)
  })

  it('a custom window, an only-UNVERIFIABLE record, a prose-only record, an unlocated one, and an unlisted agent are not counted', () => {
    const records = [
      make('window', 'FALSE', [t('r1', 'FALSE', 5)], { window: { beforeSeconds: 7200, afterSeconds: 0 } }),
      make('unverifiable', 'UNVERIFIABLE', [t('r1', 'UNVERIFIABLE', 2.3, null), t('l1', 'UNVERIFIABLE', 1, null)]),
      make('prose', 'UNVERIFIABLE', []),
      make('unlocated', 'UNLOCATED', []),
      make('unlisted', 'FALSE', [t('r1', 'FALSE', 5)], { wallet: walletN(77) }),
      make('other-chain', 'FALSE', [t('r1', 'FALSE', 5)], { chain: 'monad' }),
      make('mixed', 'UNVERIFIABLE', [t('r1', 'TRUE'), t('l1', 'UNVERIFIABLE', 1, null)]),
    ]
    const a1 = countA1(records, agents)
    expect(Object.fromEntries(a1.reasons)).toEqual({
      window: 'custom window',
      unverifiable: 'no claim decided TRUE or FALSE',
      prose: 'no claim decided TRUE or FALSE',
      unlocated: 'unlocated',
      unlisted: 'agent not listed',
      'other-chain': 'agent not listed',
      mixed: null,
    })
    expect(a1).toMatchObject({ counted: 1, falsePremise: 0 })
  })

  it('caps each agent at its earliest 6 for the pass and earliest 20 for the kill, by posted_at', () => {
    const records = agentRecords(WALLET, 25, 0)
    // The 7th and the 22nd earliest are FALSE; shuffle so file order is not posting order.
    records[6] = make(records[6]!.record.id, 'FALSE', [t('r1', 'FALSE', 5)], { postedAt: records[6]!.record.posted_at })
    records[21] = make(records[21]!.record.id, 'FALSE', [t('r1', 'FALSE', 5)], { postedAt: records[21]!.record.posted_at })
    records.reverse()
    const a1 = countA1(records, agents)
    expect(a1).toMatchObject({ counted: 25, falsePremise: 2, passBasis: 6, passFalse: 0, killBasis: 20, killFalse: 1 })
  })
})

describe('ledger: thresholds (integer arithmetic)', () => {
  it('pass at 3 false of 60, not at 2 of 60, and no read below 60', () => {
    const three = population(10, 6, 3)
    expect(countA1(three.records, three.agents)).toMatchObject({ passBasis: 60, passFalse: 3, pass: 'pass' })
    const two = population(10, 6, 2)
    expect(countA1(two.records, two.agents)).toMatchObject({ passBasis: 60, passFalse: 2, pass: 'not met' })
    const short = population(10, 6, 3)
    const fewer = short.records.slice(1)
    expect(countA1(fewer, short.agents)).toMatchObject({ passBasis: 59, pass: 'no read' })
    // A seventh record per agent does not raise the pass basis.
    const seven = population(10, 7, 0)
    expect(countA1(seven.records, seven.agents)).toMatchObject({ counted: 70, passBasis: 60, killBasis: 70 })
  })

  it('kill at 1 false of 200, not at 2 of 200, and no read below 200', () => {
    const one = population(10, 20, 1)
    expect(countA1(one.records, one.agents)).toMatchObject({ killBasis: 200, killFalse: 1, kill: 'kill' })
    const two = population(10, 20, 2)
    expect(countA1(two.records, two.agents)).toMatchObject({ killBasis: 200, killFalse: 2, kill: 'not met' })
    const short = population(10, 20, 0)
    expect(countA1(short.records.slice(1), short.agents)).toMatchObject({ killBasis: 199, kill: 'no read' })
  })

  it('with no records both thresholds print their counts and "no read"', () => {
    const ledger = buildLedger([], [])
    expect(ledger).toContain(
      "A1 pass: 0 with a false premise of 0 counted (each agent's earliest 6); needs at least 60 counted and at least 1 in 20 false: no read.",
    )
    expect(ledger).toContain(
      "A1 kill: 0 with a false premise of 0 counted (each agent's earliest 20); needs at least 200 counted and fewer than 1 in 100 false: no read.",
    )
    expect(ledger).toContain('All records, not the A1 count: 0 audited, 0 with at least one FALSE premise, 0 unverifiable, 0 unlocated.')
  })

  it('reports counts by type', () => {
    const rows = [row(walletN(1), 'vault allocator'), row(walletN(2), 'trader'), row(walletN(3), 'trader'), row(walletN(4), 'other')]
    const agents = parseAgents(agentsMd(rows))
    const records = [
      ...agentRecords(walletN(1), 8, 1),
      ...agentRecords(walletN(2), 2, 2),
      ...agentRecords(walletN(3), 3, 0),
      ...agentRecords(walletN(4), 1, 0),
    ]
    const a1 = countA1(records, agents)
    expect(a1.byType).toEqual({
      'vault allocator': { counted: 8, falsePremise: 1, passBasis: 6, passFalse: 1, killBasis: 8, killFalse: 1 },
      trader: { counted: 5, falsePremise: 2, passBasis: 5, passFalse: 2, killBasis: 5, killFalse: 2 },
      other: { counted: 1, falsePremise: 0, passBasis: 1, passFalse: 0, killBasis: 1, killFalse: 0 },
    })
    const ledger = buildLedger(records, agents)
    expect(ledger).toContain('| vault allocator | 8 | 1 | 6 | 1 | 8 | 1 |')
    expect(ledger).toContain('| trader | 5 | 2 | 5 | 2 | 5 | 2 |')
    expect(ledger).toContain('| other | 1 | 0 | 1 | 0 | 1 | 0 |')
    expect(ledger).toContain('A1 pass: 3 with a false premise of 12 counted')
  })
})
