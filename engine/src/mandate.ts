import { parseMandate } from './claims.ts'
import type { MandateV0 } from './claims.ts'
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
