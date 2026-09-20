import type { z } from 'zod'
import { SchemaError, TOLERANCE_SLACK_PP, parseClaim } from './claims.ts'
import type { AnyClaimKind } from './claims.ts'
import type { MarketParams, Observation } from './morpho.ts'
import { VaultRateClaim } from './erc4626.ts'
import type { VaultRateObservation } from './erc4626.ts'
import { BalanceClaim } from './erc20.ts'
import type { BalanceObservation } from './erc20.ts'

/** Morpho observations plus the audit-only kinds (erc4626.ts, erc20.ts). */
export type AnyObservation = Observation | VaultRateObservation | BalanceObservation

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
  kind: AnyClaimKind
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

function parseWith<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new SchemaError(`invalid ${label}`, result.error.issues.map((i) => i.message))
  return result.data
}

function compareVaultRate(claimInput: unknown, observation: AnyObservation): ClaimResult {
  const claim = parseWith(VaultRateClaim, claimInput, 'vault_rate claim')
  if (observation.kind !== 'vault_rate') {
    throw new SchemaError(`claim ${claim.id} is vault_rate but the observation is ${observation.kind}`)
  }
  if (claim.vault.toLowerCase() !== observation.vault.toLowerCase()) {
    throw new SchemaError(`claim ${claim.id} cites vault ${claim.vault}, observation is ${observation.vault}`)
  }
  if (claim.basis !== observation.basis) {
    throw new SchemaError(`claim ${claim.id} is ${claim.basis} but the observation basis is ${observation.basis}`)
  }
  const head = { id: claim.id, kind: 'vault_rate', block: observation.block } as const
  if (observation.unverifiable !== null || observation.valuePct === null) {
    return { ...head, status: 'UNVERIFIABLE', claimed: claim.valuePct, observed: null }
  }
  const ok = withinTolerance(claim.valuePct, observation.valuePct, claim.tolerancePp)
  return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed: claim.valuePct, observed: observation.valuePct }
}

function compareBalance(claimInput: unknown, observation: AnyObservation): ClaimResult {
  const claim = parseWith(BalanceClaim, claimInput, 'balance claim')
  if (observation.kind !== 'balance') {
    throw new SchemaError(`claim ${claim.id} is balance but the observation is ${observation.kind}`)
  }
  if (
    claim.token.toLowerCase() !== observation.token.toLowerCase() ||
    claim.holder.toLowerCase() !== observation.holder.toLowerCase()
  ) {
    throw new SchemaError(`claim ${claim.id} cites another token or holder than the observation`)
  }
  const head = { id: claim.id, kind: 'balance', block: observation.block } as const
  if (observation.unverifiable !== null || observation.balance === null) {
    return { ...head, status: 'UNVERIFIABLE', claimed: claim.amount, observed: null }
  }
  const diff = observation.balance - BigInt(claim.amount)
  const ok = (diff < 0n ? -diff : diff) <= BigInt(claim.toleranceAtomic)
  return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed: claim.amount, observed: observation.balance.toString() }
}

/** Claim + observation -> TRUE, FALSE, or UNVERIFIABLE. Convention mismatches throw SchemaError. */
export function compare(claimInput: unknown, anyObservation: AnyObservation): ClaimResult {
  const inputKind =
    typeof claimInput === 'object' && claimInput !== null ? (claimInput as { kind?: unknown }).kind : undefined
  if (inputKind === 'vault_rate') return compareVaultRate(claimInput, anyObservation)
  if (inputKind === 'balance') return compareBalance(claimInput, anyObservation)

  const claim = parseClaim(claimInput)
  if (claim.kind !== anyObservation.kind) {
    throw new SchemaError(`claim ${claim.id} is ${claim.kind} but the observation is ${anyObservation.kind}`)
  }
  const observation = anyObservation as Observation
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
