import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifySeal } from './run.ts'
import type { ShadowRecord } from './run.ts'

export type LedgerCounts = { audited: number; falsePremise: number; unverifiable: number; unlocated: number }

export const AGENT_TYPES = ['vault allocator', 'trader', 'other'] as const
export type AgentType = (typeof AGENT_TYPES)[number]
const CHAINS = ['monad', 'base', 'ethereum'] as const

/** One row of shadow/AGENTS.md. */
export type AgentRow = {
  line: number
  listed: string
  listedMs: number
  agent: string
  type: AgentType
  wallet: string
  chain: string
  source: string
}

/** Per-agent caps and thresholds from docs/PREREG.md Amendment 1. */
export const PASS_CAP = 6
export const KILL_CAP = 20
export const PASS_MIN = 60
export const KILL_MIN = 200

const LISTED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/
const WALLET = /^0x[0-9a-fA-F]{40}$/
const HEADER = ['Listed (UTC)', 'Agent', 'Type', 'Wallet', 'Chain', 'Where it explains its actions']

/** Loads every record and refuses any whose sha256 does not match its canonical JSON. */
export function loadRecords(dir: string): ShadowRecord[] {
  const records: ShadowRecord[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ShadowRecord
    if (!verifySeal(record)) throw new Error(`${file}: sha256 does not match its content`)
    records.push(record)
  }
  return records
}

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.trim())
}

const agentKey = (wallet: string, chain: string) => `${wallet.toLowerCase()}|${chain}`

const isDelimiter = (c: string[]) => c.length === HEADER.length && c.every((x) => /^:?-{3,}:?$/.test(x))

function parseRow(text: string, line: number): AgentRow {
  const fail = (why: string): never => {
    throw new Error(`AGENTS.md line ${line}: ${why}`)
  }
  if (!text.startsWith('|')) fail('a line inside the agent table must start with "|"')
  const c = cells(text)
  if (c.length !== HEADER.length) fail(`expected ${HEADER.length} columns, found ${c.length}`)
  const [listed, agent, type, wallet, chain, source] = c as [string, string, string, string, string, string]
  if (!LISTED.test(listed)) fail(`listing time "${listed}" is not YYYY-MM-DDTHH:MMZ`)
  const listedMs = Date.parse(listed)
  if (!Number.isFinite(listedMs) || new Date(listedMs).toISOString().slice(0, 16) !== listed.slice(0, 16)) {
    fail(`listing time "${listed}" is not a real UTC time`)
  }
  if (agent === '') fail('agent is empty')
  if (!(AGENT_TYPES as readonly string[]).includes(type)) fail(`type "${type}" is not one of ${AGENT_TYPES.join(', ')}`)
  if (!WALLET.test(wallet)) fail(`wallet "${wallet}" is not an address`)
  if (!(CHAINS as readonly string[]).includes(chain)) fail(`chain "${chain}" is not one of ${CHAINS.join(', ')}`)
  if (source === '') fail('source is empty')
  return { line, listed, listedMs, agent, type: type as AgentType, wallet, chain, source }
}

/**
 * Parses the agent table in shadow/AGENTS.md: the header, its delimiter row, and the lines directly
 * after them up to the first blank line, as GitHub renders it. Inside the table a line that does
 * not start with "|", or a malformed row, throws with its line number; after the table any
 * non-blank line throws. Nothing is skipped.
 */
export function parseAgents(markdown: string): AgentRow[] {
  const lines = markdown.split(/\r?\n/)
  const header = lines.findIndex((l) => l.startsWith('|') && cells(l).join('|') === HEADER.join('|'))
  if (header < 0) throw new Error(`AGENTS.md: no agent table with columns ${HEADER.join(', ')}`)
  const delimiter = lines[header + 1]
  if (delimiter === undefined || !delimiter.startsWith('|') || !isDelimiter(cells(delimiter))) {
    throw new Error(`AGENTS.md line ${header + 2}: expected the table's delimiter row`)
  }
  const rows: AgentRow[] = []
  let i = header + 2
  const first = new Map<string, AgentRow>()
  for (; i < lines.length && lines[i]!.trim() !== ''; i++) {
    const row = parseRow(lines[i]!, i + 1)
    const key = agentKey(row.wallet, row.chain)
    const earlier = first.get(key)
    if (earlier === undefined) first.set(key, row)
    else if (row.listedMs < earlier.listedMs) {
      throw new Error(
        `AGENTS.md line ${row.line}: listing time ${row.listed} is before ${earlier.listed}, the listing time on line ${earlier.line} for the same wallet and chain`,
      )
    }
    rows.push(row)
  }
  for (; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') throw new Error(`AGENTS.md line ${i + 1}: text after the agent table`)
  }
  return rows
}

/** One listed agent: a wallet and chain, with every row that lists it. */
export type Agent = {
  wallet: string
  chain: string
  /** From the earliest row: decides which actions count and whether the agent was audited before its listing. */
  listed: string
  listedMs: number
  /** From the latest row: name, type, and where it explains its actions. */
  agent: string
  type: AgentType
  source: string
  /** Every row for this wallet and chain, in file order. More than one is a correction. */
  rows: AgentRow[]
}

/**
 * Groups rows by wallet and chain (PREREG Amendment 2). The earliest row, the first added, sets
 * the listing time; a later row changes only name, type, and source, so it can never drop a
 * counted record or bar the agent.
 */
export function agentsByKey(rows: readonly AgentRow[]): Map<string, Agent> {
  const byKey = new Map<string, Agent>()
  for (const row of rows) {
    const key = agentKey(row.wallet, row.chain)
    const prev = byKey.get(key)
    if (prev === undefined) {
      const { wallet, chain, listed, listedMs, agent, type, source } = row
      byKey.set(key, { wallet, chain, listed, listedMs, agent, type, source, rows: [row] })
      continue
    }
    byKey.set(key, { ...prev, agent: row.agent, type: row.type, source: row.source, rows: [...prev.rows, row] })
  }
  return byKey
}

/** Wallets and chains listed in more than one row, in file order of their first row. */
export function corrections(rows: readonly AgentRow[]): Agent[] {
  return [...agentsByKey(rows).values()].filter((a) => a.rows.length > 1)
}

/**
 * The old summary over all records. N audited = located records. F = located records with at
 * least one FALSE premise. U = located records with no FALSE and at least one UNVERIFIABLE claim,
 * or no typed claim to check. X = UNLOCATED records. This is not the A1 count.
 */
export function countRecords(records: readonly Pick<ShadowRecord, 'status'>[]): LedgerCounts {
  const by = (s: string) => records.filter((r) => r.status === s).length
  const unlocated = by('UNLOCATED')
  return {
    audited: records.length - unlocated,
    falsePremise: by('FALSE'),
    unverifiable: by('UNVERIFIABLE'),
    unlocated,
  }
}

export function summaryLine(c: LedgerCounts): string {
  return `${c.audited} audited, ${c.falsePremise} with at least one FALSE premise, ${c.unverifiable} unverifiable, ${c.unlocated} unlocated`
}

/** Why a record is or is not counted toward A1. null means counted. */
export function exclusion(record: ShadowRecord, row: Agent | undefined, agentBarred: boolean): string | null {
  if (record.located.status !== 'LOCATED') return 'unlocated'
  if (!record.results.some((r) => r.status === 'TRUE' || r.status === 'FALSE')) return 'no claim decided TRUE or FALSE'
  if (record.record.window !== undefined) return 'custom window'
  if (row === undefined) return 'agent not listed'
  if (agentBarred) return 'agent audited before its listing'
  if (BigInt(record.located.blockTimestamp) * 1000n <= BigInt(row.listedMs)) return 'transaction not after listing'
  if (Date.parse(record.record.posted_at) <= row.listedMs) return 'statement not after listing'
  return null
}

export type TypeCounts = { counted: number; falsePremise: number; passBasis: number; passFalse: number; killBasis: number; killFalse: number }

export type A1Count = {
  counted: number
  falsePremise: number
  passBasis: number
  passFalse: number
  killBasis: number
  killFalse: number
  pass: 'no read' | 'pass' | 'not met'
  kill: 'no read' | 'kill' | 'not met'
  byType: Record<AgentType, TypeCounts>
  /** Exclusion reason per record id; null means counted. */
  reasons: Map<string, string | null>
}

const isFalse = (r: ShadowRecord) => r.results.some((x) => x.status === 'FALSE')

function byPosted(a: ShadowRecord, b: ShadowRecord): number {
  return Date.parse(a.record.posted_at) - Date.parse(b.record.posted_at) || a.record.id.localeCompare(b.record.id)
}

/**
 * The A1 count under docs/PREREG.md Amendments 1 and 2. Listing times come from each agent's
 * earliest row, types from its latest. Pass basis: each agent's earliest 6 counted records by
 * posted_at. Kill basis: each agent's earliest 20. Integer arithmetic only.
 */
export function countA1(records: readonly ShadowRecord[], agents: readonly AgentRow[]): A1Count {
  const rows = agentsByKey(agents)
  // An agent with any record audited before its listing time never counts. A record without
  // auditedAt cannot show it was audited after the listing, so it bars the agent too.
  const barred = new Set<string>()
  for (const r of records) {
    const key = agentKey(r.record.agent.wallet, r.record.chain)
    const row = rows.get(key)
    if (row === undefined) continue
    const at = Date.parse(String(r.auditedAt))
    if (!Number.isFinite(at) || at < row.listedMs) barred.add(key)
  }

  const reasons = new Map<string, string | null>()
  const counted = new Map<string, ShadowRecord[]>()
  for (const r of records) {
    const key = agentKey(r.record.agent.wallet, r.record.chain)
    const reason = exclusion(r, rows.get(key), barred.has(key))
    reasons.set(r.record.id, reason)
    if (reason === null) counted.set(key, [...(counted.get(key) ?? []), r])
  }

  const zero = (): TypeCounts => ({ counted: 0, falsePremise: 0, passBasis: 0, passFalse: 0, killBasis: 0, killFalse: 0 })
  const byType = { 'vault allocator': zero(), trader: zero(), other: zero() } as Record<AgentType, TypeCounts>
  const total = zero()
  for (const [key, list] of counted) {
    const sorted = [...list].sort(byPosted)
    const pass = sorted.slice(0, PASS_CAP)
    const kill = sorted.slice(0, KILL_CAP)
    for (const t of [total, byType[rows.get(key)!.type]]) {
      t.counted += sorted.length
      t.falsePremise += sorted.filter(isFalse).length
      t.passBasis += pass.length
      t.passFalse += pass.filter(isFalse).length
      t.killBasis += kill.length
      t.killFalse += kill.filter(isFalse).length
    }
  }

  const pass = total.passBasis < PASS_MIN ? 'no read' : total.passFalse * 20 >= total.passBasis ? 'pass' : 'not met'
  const kill = total.killBasis < KILL_MIN ? 'no read' : total.killFalse * 100 < total.killBasis ? 'kill' : 'not met'
  return { ...total, pass, kill, byType, reasons }
}

export function a1Lines(c: A1Count): string[] {
  return [
    `A1 pass: ${c.passFalse} with a false premise of ${c.passBasis} counted (each agent's earliest ${PASS_CAP}); needs at least ${PASS_MIN} counted and at least 1 in 20 false: ${c.pass}.`,
    `A1 kill: ${c.killFalse} with a false premise of ${c.killBasis} counted (each agent's earliest ${KILL_CAP}); needs at least ${KILL_MIN} counted and fewer than 1 in 100 false: ${c.kill}.`,
  ]
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function buildLedger(records: readonly ShadowRecord[], agents: readonly AgentRow[]): string {
  const a1 = countA1(records, agents)
  const sorted = [...records].sort(
    (a, b) => a.record.posted_at.localeCompare(b.record.posted_at) || a.record.id.localeCompare(b.record.id),
  )
  const rows: string[] = []
  for (const r of sorted) {
    const reason = a1.reasons.get(r.record.id)
    const counted = reason === null ? 'yes' : `no: ${reason}`
    const head = [r.record.posted_at.slice(0, 10), cell(r.record.agent.name), r.record.chain]
    if (r.results.length === 0) {
      rows.push(`| ${[...head, '-', '-', '-', r.status, counted, r.sha256].join(' | ')} |`)
      continue
    }
    for (const result of r.results) {
      rows.push(`| ${[...head, result.kind, cell(result.claimed), cell(result.observed), result.status, counted, r.sha256].join(' | ')} |`)
    }
  }
  const types = AGENT_TYPES.map((t) => {
    const c = a1.byType[t]
    return `| ${[t, c.counted, c.falsePremise, c.passBasis, c.passFalse, c.killBasis, c.killFalse].join(' | ')} |`
  })
  const fixes = corrections(agents)
  const fixRows = fixes.map((a) => {
    const listings = a.rows.map((r) => `line ${r.line} ${r.listed}`).join('; ')
    return `| ${[a.wallet, a.chain, listings, `line ${a.rows[0]!.line} ${a.listed}`, `line ${a.rows.at(-1)!.line}`].join(' | ')} |`
  })
  const correctionLines =
    fixes.length === 0
      ? ['Corrections (PREREG Amendment 2): none.']
      : [
          'Corrections (PREREG Amendment 2): each wallet and chain below is listed in more than one row of shadow/AGENTS.md. The earliest row decides which actions count; the latest row gives only name, type, and source.',
          '',
          '| Wallet | Chain | Rows (line, listing time) | Counts from | Name, type, source from |',
          '| --- | --- | --- | --- | --- |',
          ...fixRows,
        ]
  return [
    '# Proof of Reason shadow-audit ledger',
    '',
    'Generated by `pnpm --filter proof-of-reason-shadow ledger` from shadow/records and shadow/AGENTS.md. Do not edit by hand. Counting rules: docs/PREREG.md Amendment 1 and docs/SHADOW.md.',
    '',
    ...a1Lines(a1),
    '',
    `Counted: ${a1.counted}, ${a1.falsePremise} with a false premise, before the per-agent caps.`,
    '',
    '| Type | Counted | False premise | Pass basis | False in pass basis | Kill basis | False in kill basis |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...types,
    '',
    ...correctionLines,
    '',
    `All records, not the A1 count: ${summaryLine(countRecords(records))}.`,
    '',
    '| Date | Agent | Chain | Claim kind | Claimed | Observed | Status | Counted | Record sha256 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const out = argValue(args, '--out') ?? 'LEDGER.md'
    const agents = parseAgents(readFileSync(argValue(args, '--agents') ?? 'AGENTS.md', 'utf8'))
    const records = loadRecords(argValue(args, '--records') ?? 'records')
    writeFileSync(out, buildLedger(records, agents))
    console.log(`wrote ${out}`)
    for (const line of a1Lines(countA1(records, agents))) console.log(line)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
