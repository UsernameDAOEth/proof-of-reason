/**
 * The handler bodies, as pure functions over a context that only gets and sets rows.
 *
 * Nothing here imports `generated`, so the whole reducer is testable with an in-memory store and no
 * `envio codegen` (test/handlers.test.ts). src/EventHandlers.ts is the registration shim that hands
 * envio's context to these functions, and contains no logic of its own.
 *
 * The counting rule, in one place:
 *   a gate emits Executed only for what ran, a PASS or a WAIT the owner signed for, so the gate is
 *   authoritative for pass, wait and override;
 *   a FAIL reverts with Refuted and never reaches a gate, so the registry supplies the fails, plus
 *   the requested flag and the receipt hash;
 *   a PASS seen by both is counted once, from the gate;
 *   the registry's own totals live on RegistryAgent and RegistryVerdict, the audit view, which counts
 *   every response including the passes.
 */
import { outcomeOf } from './outcomes.ts'
import {
  EMPTY_COUNTERS,
  EMPTY_REGISTRY_COUNTERS,
  gateOutcome,
  nullableOutcome,
  onGateExecuted,
  onRegistryAgentResponse,
  onRegistryResponse,
  score,
} from './verdicts.ts'
import type { Outcome } from './outcomes.ts'

export type GateKind = 'ReasonGate' | 'KuruGate'

export type ExecutedEvent = {
  srcAddress: string
  params: { intentHash: string; outcome: bigint | number; receiptHash: string; ownerOverride: boolean }
  block: { number: number }
  transaction: { hash: string }
}

export type ValidatorSetEvent = {
  srcAddress: string
  params: { newValidator: string }
  block: { number: number }
}

export type AgentSetEvent = { srcAddress: string; params: { newAgent: string }; block: { number: number } }

export type ValidationRequestEvent = {
  params: { validator: string; agentId: bigint; requestHash: string; requestUri: string }
  block: { number: number }
}

export type ValidationResponseEvent = {
  params: {
    validator: string
    agentId: bigint
    requestHash: string
    response: bigint | number
    responseHash: string
    tag: string
    requested: boolean
  }
  block: { number: number }
  transaction: { hash: string }
}

export type Loader = {
  Gate: { get: (id: string) => Promise<GateRow | undefined>; set: (row: GateRow) => void }
  Agent: { get: (id: string) => Promise<AgentRow | undefined>; set: (row: AgentRow) => void }
  Verdict: { get: (id: string) => Promise<VerdictRow | undefined>; set: (row: VerdictRow) => void }
  RegistryAgent: {
    get: (id: string) => Promise<RegistryAgentRow | undefined>
    set: (row: RegistryAgentRow) => void
  }
  RegistryVerdict: {
    get: (id: string) => Promise<RegistryVerdictRow | undefined>
    set: (row: RegistryVerdictRow) => void
  }
}

export type GateRow = {
  id: string
  kind: string
  validator: string | undefined
  agentKey: string | undefined
  executions: number
  passes: number
  waits: number
  overrides: number
  registryAgentId: bigint | undefined
  firstBlock: bigint
  lastBlock: bigint
}

export type AgentRow = {
  id: string
  kind: string | undefined
  validator: string | undefined
  registryAgentId: bigint | undefined
  passes: number
  waits: number
  overrides: number
  fails: number
  others: number
  samples: number
  wilsonLowerBound: number | undefined
  boundStatus: string
  lastOutcome: string | undefined
  lastBlock: bigint
}

export type VerdictRow = {
  id: string
  outcome: string | undefined
  outcomeCode: number | undefined
  source: string
  gate: string | undefined
  ownerOverride: boolean | undefined
  receiptHash: string | undefined
  requested: boolean | undefined
  registryAgentId: bigint | undefined
  tag: string | undefined
  executedBlock: bigint | undefined
  recordedBlock: bigint | undefined
  lastTx: string | undefined
  firstBlock: bigint
  lastBlock: bigint
}

export type RegistryAgentRow = {
  id: string
  recorded: number
  passes: number
  waits: number
  fails: number
  others: number
  volunteered: number
  gate: string | undefined
  lastOutcome: string | undefined
  lastBlock: bigint
}

export type RegistryVerdictRow = {
  id: string
  registryAgentId: bigint
  validator: string
  response: number
  outcome: string | undefined
  outcomeCode: number | undefined
  responseHash: string
  tag: string
  requested: boolean
  responses: number
  requestUri: string | undefined
  firstBlock: bigint
  lastBlock: bigint
  lastTx: string
}

const lower = (value: string): string => value.toLowerCase()

/** gate, registry, or both: which sources have seen this intent hash. */
function mergeSource(existing: string | undefined, seen: 'gate' | 'registry'): string {
  if (existing === undefined) return seen
  return existing === seen ? seen : 'both'
}

function emptyGate(id: string, kind: string, block: bigint): GateRow {
  return {
    id,
    kind,
    validator: undefined,
    agentKey: undefined,
    executions: 0,
    passes: 0,
    waits: 0,
    overrides: 0,
    registryAgentId: undefined,
    firstBlock: block,
    lastBlock: block,
  }
}

function emptyAgent(id: string, block: bigint): AgentRow {
  return {
    id,
    kind: undefined,
    validator: undefined,
    registryAgentId: undefined,
    ...EMPTY_COUNTERS,
    samples: 0,
    wilsonLowerBound: undefined,
    boundStatus: 'INSUFFICIENT_HISTORY',
    lastOutcome: undefined,
    lastBlock: block,
  }
}

function emptyVerdict(id: string, block: bigint, source: 'gate' | 'registry' = 'gate'): VerdictRow {
  return {
    id,
    outcome: undefined,
    outcomeCode: undefined,
    source,
    gate: undefined,
    ownerOverride: undefined,
    receiptHash: undefined,
    requested: undefined,
    registryAgentId: undefined,
    tag: undefined,
    executedBlock: undefined,
    recordedBlock: undefined,
    lastTx: undefined,
    firstBlock: block,
    lastBlock: block,
  }
}

function emptyRegistryAgent(id: string, block: bigint): RegistryAgentRow {
  return { id, ...EMPTY_REGISTRY_COUNTERS, gate: undefined, lastOutcome: undefined, lastBlock: block }
}

/** One gate execution: the authoritative record of a pass, a wait, and an override. */
export async function handleExecuted(kind: GateKind, event: ExecutedEvent, context: Loader): Promise<void> {
  const block = BigInt(event.block.number)
  const gateId = lower(event.srcAddress)
  const outcome = gateOutcome(event.params.outcome)
  const executed = { outcomeCode: event.params.outcome, ownerOverride: event.params.ownerOverride }

  const gate = (await context.Gate.get(gateId)) ?? emptyGate(gateId, kind, block)
  const gateCounters = onGateExecuted(
    { passes: gate.passes, waits: gate.waits, overrides: gate.overrides, fails: 0, others: 0 },
    executed,
  )

  const verdictId = lower(event.params.intentHash)
  const existingVerdict = await context.Verdict.get(verdictId)
  const verdict = existingVerdict ?? emptyVerdict(verdictId, block)
  // The registry may already have recorded this intent hash; that is how the agent id is learned.
  const registryAgentId = verdict.registryAgentId ?? gate.registryAgentId

  context.Gate.set({
    ...gate,
    kind,
    executions: gate.executions + 1,
    passes: gateCounters.passes,
    waits: gateCounters.waits,
    overrides: gateCounters.overrides,
    registryAgentId,
    lastBlock: block,
  })

  context.Verdict.set({
    ...verdict,
    // The gate is authoritative for the outcome it executed.
    ...(outcome === null ? {} : nullableOutcome(outcome)),
    source: mergeSource(existingVerdict?.source, 'gate'),
    gate: gateId,
    ownerOverride: event.params.ownerOverride,
    receiptHash: lower(event.params.receiptHash),
    executedBlock: block,
    lastTx: event.transaction.hash,
    lastBlock: block,
  })

  const agent = (await context.Agent.get(gateId)) ?? emptyAgent(gateId, block)
  const counters = onGateExecuted(agent, executed)
  context.Agent.set({
    ...agent,
    ...score(counters, outcome ?? undefined),
    kind,
    validator: gate.validator,
    registryAgentId,
    lastBlock: block,
  })

  if (registryAgentId !== undefined) {
    const registryAgent =
      (await context.RegistryAgent.get(registryAgentId.toString())) ??
      emptyRegistryAgent(registryAgentId.toString(), block)
    context.RegistryAgent.set({ ...registryAgent, gate: gateId })
  }
}

export async function handleValidatorSet(event: ValidatorSetEvent, context: Loader, kind: GateKind): Promise<void> {
  const block = BigInt(event.block.number)
  const gateId = lower(event.srcAddress)
  const gate = (await context.Gate.get(gateId)) ?? emptyGate(gateId, kind, block)
  const validator = lower(event.params.newValidator)
  context.Gate.set({ ...gate, kind, validator, lastBlock: block })
  const agent = (await context.Agent.get(gateId)) ?? emptyAgent(gateId, block)
  context.Agent.set({ ...agent, kind, validator, lastBlock: block })
}

export async function handleAgentSet(event: AgentSetEvent, context: Loader, kind: GateKind): Promise<void> {
  const block = BigInt(event.block.number)
  const gateId = lower(event.srcAddress)
  const gate = (await context.Gate.get(gateId)) ?? emptyGate(gateId, kind, block)
  context.Gate.set({ ...gate, kind, agentKey: lower(event.params.newAgent), lastBlock: block })
}

export async function handleValidationRequest(event: ValidationRequestEvent, context: Loader): Promise<void> {
  const block = BigInt(event.block.number)
  const id = lower(event.params.requestHash)

  const row = await context.RegistryVerdict.get(id)
  if (row !== undefined) {
    // A request over a volunteered record flips the flag and leaves the verdict untouched.
    context.RegistryVerdict.set({ ...row, requested: true, requestUri: event.params.requestUri, lastBlock: block })
  }

  const existingVerdict = await context.Verdict.get(id)
  const verdict = existingVerdict ?? emptyVerdict(id, block, 'registry')
  context.Verdict.set({
    ...verdict,
    source: mergeSource(existingVerdict?.source, 'registry'),
    requested: true,
    registryAgentId: event.params.agentId,
    recordedBlock: verdict.recordedBlock ?? block,
    lastBlock: block,
  })
}

export async function handleValidationResponse(event: ValidationResponseEvent, context: Loader): Promise<void> {
  const block = BigInt(event.block.number)
  const id = lower(event.params.requestHash)
  const response = Number(event.params.response)
  const outcome: Outcome = outcomeOf(response)
  const agentId = event.params.agentId

  // 1. The audit row: every response, whole, whatever the gate says.
  const existing = await context.RegistryVerdict.get(id)
  const isRepeat = existing !== undefined && existing.responses > 0
  context.RegistryVerdict.set({
    id,
    registryAgentId: agentId,
    validator: lower(event.params.validator),
    response,
    ...nullableOutcome(outcome),
    responseHash: lower(event.params.responseHash),
    tag: event.params.tag,
    requested: existing?.requested ?? event.params.requested,
    responses: (existing?.responses ?? 0) + 1,
    requestUri: existing?.requestUri,
    firstBlock: existing?.firstBlock ?? block,
    lastBlock: block,
    lastTx: event.transaction.hash,
  })

  // 2. The registry's own totals, which count passes too.
  const registryAgent =
    (await context.RegistryAgent.get(agentId.toString())) ?? emptyRegistryAgent(agentId.toString(), block)
  const registryCounters = onRegistryAgentResponse(registryAgent, {
    response,
    requested: event.params.requested,
    isRepeat,
  })

  // 3. The joined verdict row, and the link between an agent id and a gate.
  const existingVerdict = await context.Verdict.get(id)
  const verdict = existingVerdict ?? emptyVerdict(id, block, 'registry')
  const gateId = verdict.gate ?? registryAgent.gate
  context.Verdict.set({
    ...verdict,
    // The gate is authoritative where it spoke; the registry fills in what it never saw.
    ...(verdict.outcome === undefined ? nullableOutcome(outcome) : {}),
    source: mergeSource(existingVerdict?.source, 'registry'),
    receiptHash: lower(event.params.responseHash),
    requested: verdict.requested === true ? true : event.params.requested,
    registryAgentId: agentId,
    tag: event.params.tag,
    recordedBlock: block,
    lastTx: event.transaction.hash,
    lastBlock: block,
  })

  context.RegistryAgent.set({
    ...registryAgent,
    ...registryCounters,
    gate: gateId,
    lastOutcome: outcome,
    lastBlock: block,
  })

  // 4. The agent's score, but only the half the gate cannot report: the fails, and OTHER responses.
  if (gateId !== undefined && !isRepeat) {
    const agent = (await context.Agent.get(gateId)) ?? emptyAgent(gateId, block)
    const counters = onRegistryResponse(agent, { response })
    const changed = counters.fails !== agent.fails || counters.others !== agent.others
    context.Agent.set({
      ...agent,
      ...score(counters, changed ? outcome : (agent.lastOutcome as Outcome | undefined)),
      registryAgentId: agentId,
      lastBlock: block,
    })
  }
}
