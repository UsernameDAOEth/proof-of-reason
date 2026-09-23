import { describe, expect, it } from 'vitest'
import { OUTCOME_CODE, RESPONSE_FAIL, RESPONSE_PASS, RESPONSE_WAIT, outcomeCodeOf, outcomeOf } from '../src/outcomes.ts'
import {
  EMPTY_COUNTERS,
  EMPTY_REGISTRY_COUNTERS,
  GATE_OUTCOME,
  gateOutcome,
  nullableOutcome,
  onGateExecuted,
  onRegistryAgentResponse,
  onRegistryResponse,
  score,
} from '../src/verdicts.ts'

describe('the ERC-8004 response scale', () => {
  it('is 100 PASS, 50 WAIT, 0 FAIL, and never guesses at anything else', () => {
    expect([RESPONSE_PASS, RESPONSE_WAIT, RESPONSE_FAIL]).toEqual([100, 50, 0])
    expect(outcomeOf(100)).toBe('PASS')
    expect(outcomeOf(50)).toBe('WAIT')
    expect(outcomeOf(0)).toBe('FAIL')
    for (const odd of [1, 49, 51, 73, 99, 100n + 1n]) expect(outcomeOf(odd)).toBe('OTHER')
    expect(outcomeCodeOf(100)).toBe(1)
    expect(outcomeCodeOf(50)).toBe(2)
    expect(outcomeCodeOf(0)).toBe(3)
    expect(outcomeCodeOf(73)).toBeUndefined()
    expect(OUTCOME_CODE.OTHER).toBeUndefined()
  })

  it('reads a bigint the way an event delivers it', () => {
    expect(outcomeOf(100n)).toBe('PASS')
    expect(outcomeOf(0n)).toBe('FAIL')
  })

  it('stores an OTHER response with no outcome and no code', () => {
    expect(nullableOutcome('OTHER')).toEqual({ outcome: undefined, outcomeCode: undefined })
    expect(nullableOutcome(null)).toEqual({ outcome: undefined, outcomeCode: undefined })
    expect(nullableOutcome('PASS')).toEqual({ outcome: 'PASS', outcomeCode: 1 })
    expect(nullableOutcome('WAIT')).toEqual({ outcome: 'WAIT', outcomeCode: 2 })
    expect(nullableOutcome('FAIL')).toEqual({ outcome: 'FAIL', outcomeCode: 3 })
  })
})

describe('gate events are authoritative for pass, wait and override', () => {
  it('counts a pass as a pass and nothing else', () => {
    const counters = onGateExecuted(EMPTY_COUNTERS, { outcomeCode: 1, ownerOverride: false })
    expect(counters).toEqual({ passes: 1, waits: 0, overrides: 0, fails: 0, others: 0 })
  })

  it('counts an executed wait as a wait and an override, never as a pass', () => {
    const counters = onGateExecuted(EMPTY_COUNTERS, { outcomeCode: 2, ownerOverride: true })
    expect(counters).toEqual({ passes: 0, waits: 1, overrides: 1, fails: 0, others: 0 })
  })

  it('maps the gate codes the contracts use, and no others', () => {
    expect(GATE_OUTCOME).toEqual({ 1: 'PASS', 2: 'WAIT', 3: 'FAIL' })
    expect(gateOutcome(1)).toBe('PASS')
    expect(gateOutcome(2n)).toBe('WAIT')
    expect(gateOutcome(3)).toBe('FAIL')
    for (const invalid of [0, 4, 255]) expect(gateOutcome(invalid)).toBeNull()
    // An unknown code is counted, never scored.
    expect(onGateExecuted(EMPTY_COUNTERS, { outcomeCode: 4, ownerOverride: false })).toEqual({
      ...EMPTY_COUNTERS,
      others: 1,
    })
  })
})

describe('the registry supplies the fails, and only the fails', () => {
  it('counts a FAIL, which no gate event can report', () => {
    expect(onRegistryResponse(EMPTY_COUNTERS, { response: 0 })).toEqual({ ...EMPTY_COUNTERS, fails: 1 })
  })

  it('never counts a PASS twice: the gate already did', () => {
    const afterGate = onGateExecuted(EMPTY_COUNTERS, { outcomeCode: 1, ownerOverride: false })
    const afterRegistry = onRegistryResponse(afterGate, { response: 100 })
    expect(afterRegistry.passes).toBe(1)
    expect(afterRegistry).toEqual(afterGate)
  })

  it('leaves waits to the gate as well', () => {
    const afterGate = onGateExecuted(EMPTY_COUNTERS, { outcomeCode: 2, ownerOverride: true })
    expect(onRegistryResponse(afterGate, { response: 50 })).toEqual(afterGate)
  })

  it('counts an OTHER response as an other', () => {
    expect(onRegistryResponse(EMPTY_COUNTERS, { response: 73 })).toEqual({ ...EMPTY_COUNTERS, others: 1 })
  })
})

describe('the score', () => {
  it('counts passes, waits and fails as samples, and leaves others out', () => {
    const scored = score({ passes: 8, waits: 1, overrides: 1, fails: 1, others: 5 })
    expect(scored.samples).toBe(10)
    expect(scored.boundStatus).toBe('OK')
    expect(scored.wilsonLowerBound).toBeCloseTo(0.4902, 4)
  })

  it('says INSUFFICIENT_HISTORY under ten samples, however many others there are', () => {
    const scored = score({ passes: 9, waits: 0, overrides: 0, fails: 0, others: 100 })
    expect(scored.samples).toBe(9)
    expect(scored.boundStatus).toBe('INSUFFICIENT_HISTORY')
    expect(scored.wilsonLowerBound).toBeUndefined()
  })

  it('drops the bound when a fail arrives, because a fail is a sample that is not a pass', () => {
    const tenPasses = score({ passes: 10, waits: 0, overrides: 0, fails: 0, others: 0 })
    const withAFail = score({ passes: 10, waits: 0, overrides: 0, fails: 1, others: 0 })
    expect(tenPasses.wilsonLowerBound).toBeCloseTo(0.7225, 4)
    expect(withAFail.wilsonLowerBound!).toBeLessThan(tenPasses.wilsonLowerBound!)
  })

  it('carries the last outcome through, including none', () => {
    expect(score(EMPTY_COUNTERS, 'FAIL').lastOutcome).toBe('FAIL')
    expect(score(EMPTY_COUNTERS).lastOutcome).toBeUndefined()
  })
})

describe('the registry keeps its own totals, the audit view', () => {
  it('counts every response, passes included', () => {
    let counters = EMPTY_REGISTRY_COUNTERS
    counters = onRegistryAgentResponse(counters, { response: 100, requested: true, isRepeat: false })
    counters = onRegistryAgentResponse(counters, { response: 50, requested: true, isRepeat: false })
    counters = onRegistryAgentResponse(counters, { response: 0, requested: false, isRepeat: false })
    counters = onRegistryAgentResponse(counters, { response: 73, requested: false, isRepeat: false })
    expect(counters).toEqual({ recorded: 4, passes: 1, waits: 1, fails: 1, others: 1, volunteered: 2 })
  })

  it('treats a repeat response as a replacement, not a new verdict', () => {
    const first = onRegistryAgentResponse(EMPTY_REGISTRY_COUNTERS, {
      response: 0,
      requested: false,
      isRepeat: false,
    })
    const again = onRegistryAgentResponse(first, { response: 100, requested: false, isRepeat: true })
    expect(again.recorded).toBe(1)
    expect(again.volunteered).toBe(1)
    // Both verdicts are visible in the totals; the record itself keeps only the latest.
    expect(again.fails).toBe(1)
    expect(again.passes).toBe(1)
  })
})
