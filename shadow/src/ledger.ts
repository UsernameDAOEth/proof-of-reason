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

/**
 * Parses the agent table in shadow/AGENTS.md. Every table line after the header is a row, and a
 * malformed row throws: no row is ever skipped.
 */
export function parseAgents(markdown: string): AgentRow[] {
  const lines = markdown.split('\n')
  const header = lines.findIndex((l) => l.trim().startsWith('|') && cells(l).join('|') === HEADER.join('|'))
  if (header < 0) throw new Error(`AGENTS.md: no agent table with columns ${HEADER.join(', ')}`)
  const rows: AgentRow[] = []
  for (let i = header + 1; i < lines.length; i++) {
    const text = lines[i]!
    if (!text.trim().startsWith('|')) continue
    const line = i + 1
    const c = cells(text)
    if (i === header + 1 && c.every((x) => /^:?-{3,}:?$/.test(x))) continue
    const fail = (why: string): never => {
      throw new Error(`AGENTS.md line ${line}: ${why}`)
    }
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
    rows.push({ line, listed, listedMs, agent, type: type as AgentType, wallet, chain, source })
  }
  return rows
}

const agentKey = (wallet: string, chain: string) => `${wallet.toLowerCase()}|${chain}`

/** The row that applies to each wallet and chain: the latest listing time, then the later row. */
export function latestRows(rows: readonly AgentRow[]): Map<string, AgentRow> {
  const byKey = new Map<string, AgentRow>()
  for (const row of rows) {
    const key = agentKey(row.wallet, row.chain)
    const prev = byKey.get(key)
    if (prev === undefined || row.listedMs >= prev.listedMs) byKey.set(key, row)
  }
  return byKey
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
export function exclusion(record: ShadowRecord, row: AgentRow | undefined, agentBarred: boolean): string | null {
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
 * The A1 count under docs/PREREG.md Amendment 1. Pass basis: each agent's earliest 6 counted
 * records by posted_at. Kill basis: each agent's earliest 20. Integer arithmetic only.
 */
export function countA1(records: readonly ShadowRecord[], agents: readonly AgentRow[]): A1Count {
  const rows = latestRows(agents)
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
