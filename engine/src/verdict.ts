import type { ClaimKind } from './claims.ts'
import type { ClaimResult } from './compare.ts'
import type { ActionMismatch } from './action.ts'
import type { MandateViolation } from './mandate.ts'

export type Outcome = 'PASS' | 'WAIT' | 'FAIL'

/** On-chain outcome codes used by ReasonGate. */
export const OUTCOME_CODE = { PASS: 1, WAIT: 2, FAIL: 3 } as const

export type ClaimItem = {
  source: 'claim'
  id: string
  kind: ClaimKind
  status: 'FALSE' | 'UNVERIFIABLE'
  claimed: ClaimResult['claimed']
  observed: ClaimResult['observed']
  block: bigint
}

export type FailingItem = ClaimItem | ActionMismatch | MandateViolation

export type VerdictInput = {
  results: readonly ClaimResult[]
  actionMismatches: readonly ActionMismatch[]
  mandateViolations: readonly MandateViolation[]
  requiredKinds: readonly ClaimKind[]
}

export type Verdict = {
  outcome: Outcome
  /** Every item that is not TRUE: FALSE and UNVERIFIABLE claims, action mismatches, mandate violations. */
  failing: FailingItem[]
  missingKinds: ClaimKind[]
}

/**
 * Pure. Any FALSE, action mismatch, or mandate violation gives FAIL. Else any UNVERIFIABLE
 * or missing required kind gives WAIT. Else PASS.
 */
export function decide(input: VerdictInput): Verdict {
  const present = new Set(input.results.map((r) => r.kind))
  const missingKinds = [...new Set(input.requiredKinds)].filter((k) => !present.has(k))

  const claimItems: ClaimItem[] = input.results
    .filter((r) => r.status !== 'TRUE')
    .map((r) => ({
      source: 'claim',
      id: r.id,
      kind: r.kind,
      status: r.status as 'FALSE' | 'UNVERIFIABLE',
      claimed: r.claimed,
      observed: r.observed,
      block: r.block,
    }))
  const failing: FailingItem[] = [...claimItems, ...input.actionMismatches, ...input.mandateViolations]

  const anyFalse = claimItems.some((i) => i.status === 'FALSE')
  const anyUnverifiable = claimItems.some((i) => i.status === 'UNVERIFIABLE')

  let outcome: Outcome
  if (anyFalse || input.actionMismatches.length > 0 || input.mandateViolations.length > 0) {
    outcome = 'FAIL'
  } else if (anyUnverifiable || missingKinds.length > 0) {
    outcome = 'WAIT'
  } else {
    outcome = 'PASS'
  }
  return { outcome, failing, missingKinds }
}
