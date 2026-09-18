import { SchemaError, TOLERANCE_SLACK_PP, parseClaim } from './claims.ts'
import type { ClaimKind } from './claims.ts'
import type { MarketParams, Observation } from './morpho.ts'

export type ClaimStatus = 'TRUE' | 'FALSE' | 'UNVERIFIABLE'

export type IdentityValue = {
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: string
}

export type ClaimResult = {
  id: string
  kind: ClaimKind
  status: ClaimStatus
  claimed: number | string | IdentityValue
  observed: number | string | IdentityValue | null
  block: bigint
}

/** |observed - claimed| <= tolerancePp, with the declared rounding slack. */
export function withinTolerance(claimed: number, observed: number, tolerancePp: number): boolean {
  return Math.abs(observed - claimed) <= tolerancePp + TOLERANCE_SLACK_PP
}

function identityOf(params: MarketParams): IdentityValue {
  return {
    loanToken: params.loanToken.toLowerCase(),
    collateralToken: params.collateralToken.toLowerCase(),
    oracle: params.oracle.toLowerCase(),
    irm: params.irm.toLowerCase(),
    lltv: params.lltv.toString(),
  }
}

/** Claim + observation -> TRUE, FALSE, or UNVERIFIABLE. Convention mismatches throw SchemaError. */
export function compare(claimInput: unknown, observation: Observation): ClaimResult {
  const claim = parseClaim(claimInput)
  if (claim.kind !== observation.kind) {
    throw new SchemaError(`claim ${claim.id} is ${claim.kind} but the observation is ${observation.kind}`)
  }
  if (claim.market.toLowerCase() !== observation.market.toLowerCase()) {
    throw new SchemaError(`claim ${claim.id} cites market ${claim.market}, observation is ${observation.market}`)
  }
  const head = { id: claim.id, kind: claim.kind, block: observation.block }

  switch (claim.kind) {
    case 'rate': {
      const obs = observation as Extract<Observation, { kind: 'rate' }>
      if (claim.basis !== obs.basis) {
        throw new SchemaError(`claim ${claim.id} is ${claim.basis} but the observation basis is ${obs.basis}`)
      }
      if (claim.side !== obs.side) {
        throw new SchemaError(`claim ${claim.id} is ${claim.side} side but the observation is ${obs.side} side`)
      }
      if (obs.unverifiable !== null || obs.valuePct === null) {
        return { ...head, status: 'UNVERIFIABLE', claimed: claim.valuePct, observed: null }
      }
      const ok = withinTolerance(claim.valuePct, obs.valuePct, claim.tolerancePp)
      return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed: claim.valuePct, observed: obs.valuePct }
    }
    case 'utilization': {
      const obs = observation as Extract<Observation, { kind: 'utilization' }>
      if (obs.unverifiable !== null || obs.valuePct === null) {
        return { ...head, status: 'UNVERIFIABLE', claimed: claim.valuePct, observed: null }
      }
      const ok = withinTolerance(claim.valuePct, obs.valuePct, claim.tolerancePp)
      return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed: claim.valuePct, observed: obs.valuePct }
    }
    case 'liquidity': {
      const obs = observation as Extract<Observation, { kind: 'liquidity' }>
      if (obs.unverifiable !== null || obs.withdrawable === null) {
        return { ...head, status: 'UNVERIFIABLE', claimed: claim.minWithdrawable, observed: null }
      }
      const ok = obs.withdrawable >= BigInt(claim.minWithdrawable)
      return {
        ...head,
        status: ok ? 'TRUE' : 'FALSE',
        claimed: claim.minWithdrawable,
        observed: obs.withdrawable.toString(),
      }
    }
    case 'identity': {
      const obs = observation as Extract<Observation, { kind: 'identity' }>
      const claimed: IdentityValue = {
        loanToken: claim.loanToken.toLowerCase(),
        collateralToken: claim.collateralToken.toLowerCase(),
        oracle: claim.oracle.toLowerCase(),
        irm: claim.irm.toLowerCase(),
        lltv: claim.lltv,
      }
      const observed = identityOf(obs.params)
      const ok =
        claimed.loanToken === observed.loanToken &&
        claimed.collateralToken === observed.collateralToken &&
        claimed.oracle === observed.oracle &&
        claimed.irm === observed.irm &&
        claimed.lltv === observed.lltv
      return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed, observed }
    }
  }
}
