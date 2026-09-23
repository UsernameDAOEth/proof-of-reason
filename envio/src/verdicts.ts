/**
 * The counting rule, as pure functions over plain objects, so it is testable without `envio codegen`.
 * src/EventHandlers.ts does the reading and writing and nothing else.
 *
 * Two sources see a verdict, and they see different halves of it:
 *
 *   A gate emits `Executed` only for what actually ran: a PASS, or a WAIT the owner signed for. A
 *   FAIL reverts with `Refuted`, so no gate event exists for it, ever.
 *
 *   The registry carries every verdict the validator signed, PASS, WAIT and FAIL alike, because the
 *   validator writes one response per check (worker/src/check.ts).
 *
 * So: the gate is authoritative for pass, wait and override, and the registry supplies the fails,
 * plus the `requested` flag and the receipt hash. A PASS that appears in both is counted once, from
 * the gate. The registry's own totals are kept separately on RegistryAgent and RegistryVerdict, which
 * is the audit view and is allowed to disagree: that is the point of keeping both.
 *
 * The two meet on the EIP-712 intent hash, which the gate uses as its `intentHash` and the registry
 * as its `requestHash`. That overlap is also how the indexer learns which ERC-8004 agent id belongs
 * to which gate, with no configuration: the first verdict both sides recorded links them.
 */
import { outcomeCodeOf, outcomeOf } from './outcomes.ts'
import type { Outcome } from './outcomes.ts'
import { MIN_SAMPLES, wilson } from './wilson.ts'

/** ReasonGate and KuruGate outcome codes. */
export const GATE_OUTCOME: Record<number, Outcome> = { 1: 'PASS', 2: 'WAIT', 3: 'FAIL' }

export type AgentCounters = {
  passes: number
  waits: number
  overrides: number
  fails: number
  others: number
}

export type AgentScore = AgentCounters & {
  samples: number
  wilsonLowerBound: number | undefined
  boundStatus: 'OK' | 'INSUFFICIENT_HISTORY'
  lastOutcome: Outcome | undefined
}

export const EMPTY_COUNTERS: AgentCounters = { passes: 0, waits: 0, overrides: 0, fails: 0, others: 0 }

/** A gate outcome code, or null for a code no ruleset of ours emits. */
export function gateOutcome(outcomeCode: number | bigint): Outcome | null {
  return GATE_OUTCOME[Number(outcomeCode)] ?? null
}

/**
 * What a gate saw. Authoritative for pass, wait and override. An override is a WAIT the owner signed
 * for, so it counts as a wait as well, and never as a pass.
 */
export function onGateExecuted(
  counters: AgentCounters,
  event: { outcomeCode: number | bigint; ownerOverride: boolean },
): AgentCounters {
  const outcome = gateOutcome(event.outcomeCode)
  return {
    passes: counters.passes + (outcome === 'PASS' ? 1 : 0),
    waits: counters.waits + (outcome === 'WAIT' ? 1 : 0),
    overrides: counters.overrides + (event.ownerOverride ? 1 : 0),
    fails: counters.fails + (outcome === 'FAIL' ? 1 : 0),
    others: counters.others + (outcome === null ? 1 : 0),
  }
}

/**
 * What the registry saw. Only the fails are counted here: a PASS or a WAIT the gate reported is
 * already counted, and counting it again would double it. An OTHER response is counted as an other,
 * never scored.
 */
export function onRegistryResponse(counters: AgentCounters, event: { response: number | bigint }): AgentCounters {
  const outcome = outcomeOf(event.response)
  return {
    ...counters,
    fails: counters.fails + (outcome === 'FAIL' ? 1 : 0),
    others: counters.others + (outcome === 'OTHER' ? 1 : 0),
  }
}

/**
 * The bound over what the counters say. Samples are passes, waits and fails; OTHER responses are
 * excluded, because a response outside 100, 50 and 0 is not a verdict this ruleset knows how to
 * score. Under MIN_SAMPLES there is no number, only INSUFFICIENT_HISTORY.
 */
export function score(counters: AgentCounters, lastOutcome?: Outcome): AgentScore {
  const samples = counters.passes + counters.waits + counters.fails
  const result = wilson(counters.passes, samples)
  return {
    ...counters,
    samples,
    wilsonLowerBound: result.status === 'OK' ? result.lowerBound : undefined,
    boundStatus: result.status,
    lastOutcome,
  }
}

export type RegistryCounters = {
  recorded: number
  passes: number
  waits: number
  fails: number
  others: number
  volunteered: number
}

export const EMPTY_REGISTRY_COUNTERS: RegistryCounters = {
  recorded: 0,
  passes: 0,
  waits: 0,
  fails: 0,
  others: 0,
  volunteered: 0,
}

/**
 * The registry's own totals, which count every response including the passes. A repeat response for
 * the same request hash replaces a verdict rather than adding one, exactly as the registry does: the
 * latest response wins.
 */
export function onRegistryAgentResponse(
  counters: RegistryCounters,
  event: { response: number | bigint; requested: boolean; isRepeat: boolean },
): RegistryCounters {
  const outcome = outcomeOf(event.response)
  const first = event.isRepeat ? 0 : 1
  return {
    recorded: counters.recorded + first,
    passes: counters.passes + (outcome === 'PASS' ? 1 : 0),
    waits: counters.waits + (outcome === 'WAIT' ? 1 : 0),
    fails: counters.fails + (outcome === 'FAIL' ? 1 : 0),
    others: counters.others + (outcome === 'OTHER' ? 1 : 0),
    volunteered: counters.volunteered + (!event.requested ? first : 0),
  }
}

/** PASS, WAIT, FAIL, or null for OTHER: what the Verdict entity stores. */
export function nullableOutcome(outcome: Outcome | null): { outcome: string | undefined; outcomeCode: number | undefined } {
  if (outcome === null || outcome === 'OTHER') return { outcome: undefined, outcomeCode: undefined }
  return { outcome, outcomeCode: outcomeCodeOf(outcome === 'PASS' ? 100 : outcome === 'WAIT' ? 50 : 0) }
}

export { MIN_SAMPLES }
