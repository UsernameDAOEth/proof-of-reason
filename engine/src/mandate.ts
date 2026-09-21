import { parseMandate, parseTypedDecisionClaims } from './claims.ts'
import type { MandateV0, TypedDecisionMandate } from './claims.ts'
import { touchedMarkets } from './action.ts'
import type { DecodedAction } from './action.ts'

export type MandateViolation = {
  source: 'mandate'
  rule: 'allowedMarkets'
  claimed: string
  observed: string
  block: null
}

/** Every market the decoded calldata touches must be in the mandate. */
export function checkMandate(decoded: DecodedAction | null, mandateInput: MandateV0): MandateViolation[] {
  const mandate = parseMandate(mandateInput)
  if (decoded === null) return []
  const allowed = new Set(mandate.allowedMarkets.map((m) => m.toLowerCase()))
  const seen = new Set<string>()
  const violations: MandateViolation[] = []
  for (const market of touchedMarkets(decoded)) {
    const id = market.toLowerCase()
    if (allowed.has(id) || seen.has(id)) continue
    seen.add(id)
    violations.push({
      source: 'mandate',
      rule: 'allowedMarkets',
      claimed: id,
      observed: 'not in mandate.allowedMarkets',
      block: null,
    })
  }
  return violations
}

export type TypedDecisionViolation = {
  source: 'mandate'
  rule: 'gate' | 'market' | 'allowedAnswers' | 'minProbability' | 'maxNotionalUsd' | 'maxPositionBase'
  claimed: string | number
  observed: string | number
  block: null
}

/**
 * A typed-decision claim may never widen the principal's mandate: the gate and market are fixed,
 * the allowed answers are a subset, and neither cap nor the probability floor may be loosened.
 * Every violation is a FAIL, so an agent cannot grant itself a looser limit.
 */
export function checkTypedDecisionMandate(claimsInput: unknown, mandate: TypedDecisionMandate): TypedDecisionViolation[] {
  const claims = parseTypedDecisionClaims(claimsInput)
  const out: TypedDecisionViolation[] = []
  const add = (rule: TypedDecisionViolation['rule'], claimed: string | number, observed: string | number) =>
    out.push({ source: 'mandate', rule, claimed, observed, block: null })

  for (const claim of claims) {
    if (claim.kind === 'kuru_book' && claim.market.toLowerCase() !== mandate.market.toLowerCase()) {
      add('market', claim.market.toLowerCase(), mandate.market.toLowerCase())
    }
    if (claim.kind === 'decision') {
      const outside = claim.allowedValues.filter((v) => !mandate.allowedAnswers.includes(v))
      if (outside.length > 0) add('allowedAnswers', outside.join(','), mandate.allowedAnswers.join(','))
      if (claim.minProbability < mandate.minProbability) add('minProbability', claim.minProbability, mandate.minProbability)
    }
    if (claim.kind === 'position') {
      if (claim.gate.toLowerCase() !== mandate.gate.toLowerCase()) add('gate', claim.gate.toLowerCase(), mandate.gate.toLowerCase())
      if (claim.market.toLowerCase() !== mandate.market.toLowerCase()) add('market', claim.market.toLowerCase(), mandate.market.toLowerCase())
      if (claim.maxNotionalUsd > mandate.maxNotionalUsd) add('maxNotionalUsd', claim.maxNotionalUsd, mandate.maxNotionalUsd)
      if (claim.maxPositionBase > mandate.maxPositionBase) add('maxPositionBase', claim.maxPositionBase, mandate.maxPositionBase)
    }
  }
  return out
}

/** Either violation shape: both are FAIL inputs for verdict.decide. */
export type AnyMandateViolation = MandateViolation | TypedDecisionViolation
