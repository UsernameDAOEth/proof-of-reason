/**
 * The one place the ERC-8004 response scale is turned back into a Proof of Reason outcome.
 *
 * The numbers are not envio's to choose: 100, 50 and 0 are what the validator writes
 * (worker/src/registry.ts OUTCOME_RESPONSE) and 1, 2, 3 are what ReasonGate reads
 * (engine/src/verdict.ts OUTCOME_CODE, contracts/src/ReasonGate.sol PASS, WAIT, FAIL). A response
 * this map does not know is never guessed at: it is reported as OTHER with no outcome code, the same
 * way an unrecognised answer is never turned into a side.
 */
export type Outcome = 'PASS' | 'WAIT' | 'FAIL' | 'OTHER'

export const RESPONSE_PASS = 100
export const RESPONSE_WAIT = 50
export const RESPONSE_FAIL = 0

export const OUTCOME_CODE: Record<Outcome, number | undefined> = {
  PASS: 1,
  WAIT: 2,
  FAIL: 3,
  OTHER: undefined,
}

/** 100 is PASS, 50 is WAIT, 0 is FAIL. Anything else is OTHER. */
export function outcomeOf(response: number | bigint): Outcome {
  switch (Number(response)) {
    case RESPONSE_PASS:
      return 'PASS'
    case RESPONSE_WAIT:
      return 'WAIT'
    case RESPONSE_FAIL:
      return 'FAIL'
    default:
      return 'OTHER'
  }
}

export function outcomeCodeOf(response: number | bigint): number | undefined {
  return OUTCOME_CODE[outcomeOf(response)]
}
