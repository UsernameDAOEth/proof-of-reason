import { describe, expect, it } from 'vitest'
import { CLAIM_KINDS } from '../src/claims.ts'
import type { ClaimKind } from '../src/claims.ts'
import type { ClaimResult, ClaimStatus } from '../src/compare.ts'
import type { ActionMismatch } from '../src/action.ts'
import type { MandateViolation } from '../src/mandate.ts'
import { OUTCOME_CODE, decide } from '../src/verdict.ts'

const STATUSES: readonly ClaimStatus[] = ['TRUE', 'FALSE', 'UNVERIFIABLE']
const MAX_CLAIMS = 3

const MISMATCH: ActionMismatch = {
  source: 'action',
  field: 'assets',
  claimed: '1',
  observed: '2',
  block: null,
}
const VIOLATION: MandateViolation = {
  source: 'mandate',
  rule: 'allowedMarkets',
  claimed: '0x01',
  observed: 'not in mandate.allowedMarkets',
  block: null,
}

type Slot = { kind: ClaimKind; status: ClaimStatus }

/** Every list of 0..MAX_CLAIMS claims over every (kind, status) pair. */
function* claimLists(): Generator<Slot[]> {
  const slots: Slot[] = CLAIM_KINDS.flatMap((kind) => STATUSES.map((status) => ({ kind, status })))
  function* build(prefix: Slot[]): Generator<Slot[]> {
    yield prefix
    if (prefix.length === MAX_CLAIMS) return
    for (const slot of slots) yield* build([...prefix, slot])
  }
  yield* build([])
}

function* kindSubsets(): Generator<ClaimKind[]> {
  for (let mask = 0; mask < 1 << CLAIM_KINDS.length; mask++) {
    yield CLAIM_KINDS.filter((_, i) => (mask & (1 << i)) !== 0)
  }
}

function toResults(slots: Slot[]): ClaimResult[] {
  return slots.map((s, i) => ({
    id: `c${i}`,
    kind: s.kind,
    status: s.status,
    claimed: i,
    observed: s.status === 'UNVERIFIABLE' ? null : i,
    block: 1_000n + BigInt(i),
  }))
}

describe('decide, exhaustive', () => {
  it('holds every invariant over every input combination', () => {
    let cases = 0
    for (const slots of claimLists()) {
      const results = Object.freeze(toResults(slots))
      for (const requiredKinds of kindSubsets()) {
        for (const actionMismatches of [[], [MISMATCH]] as const) {
          for (const mandateViolations of [[], [VIOLATION]] as const) {
            cases++
            const verdict = decide({ results, actionMismatches, mandateViolations, requiredKinds })

            const anyFalse = slots.some((s) => s.status === 'FALSE')
            const anyUnverifiable = slots.some((s) => s.status === 'UNVERIFIABLE')
            const allTrue = slots.every((s) => s.status === 'TRUE')
            const present = new Set(slots.map((s) => s.kind))
            const missing = requiredKinds.filter((k) => !present.has(k))
            const complete = missing.length === 0
            const mismatch = actionMismatches.length > 0
            const violation = mandateViolations.length > 0

            // Any FALSE implies FAIL. So does any action mismatch or mandate violation.
            if (anyFalse) expect(verdict.outcome).toBe('FAIL')
            if (mismatch) expect(verdict.outcome).toBe('FAIL')
            if (violation) expect(verdict.outcome).toBe('FAIL')

            // No FAIL condition and any UNVERIFIABLE implies WAIT. Same for a missing kind.
            const noFailCondition = !anyFalse && !mismatch && !violation
            if (noFailCondition && anyUnverifiable) expect(verdict.outcome).toBe('WAIT')
            if (noFailCondition && !complete) expect(verdict.outcome).toBe('WAIT')

            // PASS only when all TRUE and complete, and exactly then when nothing else fails.
            const passExpected = allTrue && complete && !mismatch && !violation
            expect(verdict.outcome === 'PASS').toBe(passExpected)

            // Failing items: every non-TRUE claim, then mismatches, then violations.
            const expectedFailing = slots.filter((s) => s.status !== 'TRUE').length
            expect(verdict.failing).toHaveLength(
              expectedFailing + actionMismatches.length + mandateViolations.length,
            )
            for (const item of verdict.failing) {
              expect(item).toHaveProperty('claimed')
              expect(item).toHaveProperty('observed')
              expect(item).toHaveProperty('block')
            }
            expect(verdict.missingKinds).toEqual(missing)
          }
        }
      }
    }
    // 1 + 12 + 12^2 + 12^3 claim lists, 16 required-kind subsets, 2 action states, 2 mandate states.
    expect(cases).toBe((1 + 12 + 144 + 1728) * 16 * 2 * 2)
  })

  it('returns the failing claim with claimed, observed, and block', () => {
    const verdict = decide({
      results: [
        { id: 'r1', kind: 'rate', status: 'FALSE', claimed: 5.2, observed: 3.1, block: 999n },
        { id: 'u1', kind: 'utilization', status: 'TRUE', claimed: 80, observed: 80, block: 999n },
      ],
      actionMismatches: [],
      mandateViolations: [],
      requiredKinds: ['rate'],
    })
    expect(verdict.outcome).toBe('FAIL')
    expect(verdict.failing).toEqual([
      { source: 'claim', id: 'r1', kind: 'rate', status: 'FALSE', claimed: 5.2, observed: 3.1, block: 999n },
    ])
  })

  it('treats an empty claim set with no required kinds as complete', () => {
    const verdict = decide({ results: [], actionMismatches: [], mandateViolations: [], requiredKinds: [] })
    expect(verdict.outcome).toBe('PASS')
  })

  it('maps outcomes to the gate codes', () => {
    expect(OUTCOME_CODE).toEqual({ PASS: 1, WAIT: 2, FAIL: 3 })
  })
})
