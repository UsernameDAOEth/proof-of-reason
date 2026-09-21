import type { z } from 'zod'
import { SchemaError, TOLERANCE_SLACK_PP, parseClaim } from './claims.ts'
import type { AnyClaimKind } from './claims.ts'
import type { MarketParams, Observation } from './morpho.ts'
import { VaultRateClaim } from './erc4626.ts'
import type { VaultRateObservation } from './erc4626.ts'
import { BalanceClaim } from './erc20.ts'
import type { BalanceObservation } from './erc20.ts'
import { DecisionClaim, KuruBookClaim, PositionClaim } from './claims.ts'
import type { TypedDecisionObservation } from './kuru.ts'

/** Morpho observations, the audit-only kinds (erc4626.ts, erc20.ts), and typed decisions (kuru.ts). */
export type AnyObservation = Observation | VaultRateObservation | BalanceObservation | TypedDecisionObservation

export type ClaimStatus = 'TRUE' | 'FALSE' | 'UNVERIFIABLE'

export type IdentityValue = {
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: string
}

/** A claimed or observed value: a number, a decimal string, or a small record of them. */
export type ClaimValue = number | string | IdentityValue | Record<string, number | string | boolean>

export type ClaimResult = {
  id: string
  kind: AnyClaimKind
  status: ClaimStatus
  claimed: ClaimValue
  observed: ClaimValue | null
  block: bigint
}

/** |observed - claimed| / claimed * 100 <= tolerancePp, with the declared rounding slack. */
export function withinRelativeTolerance(claimed: number, observed: number, tolerancePp: number): boolean {
  if (claimed === 0) return observed === 0
  return (Math.abs(observed - claimed) / Math.abs(claimed)) * 100 <= tolerancePp + TOLERANCE_SLACK_PP
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

function compareKuruBook(claimInput: unknown, observation: AnyObservation): ClaimResult {
  const claim = parseWith(KuruBookClaim, claimInput, 'kuru_book claim')
  if (observation.kind !== 'kuru_book') {
    throw new SchemaError(`claim ${claim.id} is kuru_book but the observation is ${observation.kind}`)
  }
  if (claim.market.toLowerCase() !== observation.market.toLowerCase()) {
    throw new SchemaError(`claim ${claim.id} cites market ${claim.market}, observation is ${observation.market}`)
  }
  const head = { id: claim.id, kind: 'kuru_book', block: observation.block } as const
  const claimed = { bestBid: claim.bestBid, bestAsk: claim.bestAsk }
  if (observation.unverifiable !== null || observation.bestBid === null || observation.bestAsk === null) {
    return { ...head, status: 'UNVERIFIABLE', claimed, observed: null }
  }
  const observed = { bestBid: observation.bestBid, bestAsk: observation.bestAsk }
  const ok =
    withinRelativeTolerance(claim.bestBid, observation.bestBid, claim.tolerancePp) &&
    withinRelativeTolerance(claim.bestAsk, observation.bestAsk, claim.tolerancePp)
  return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed, observed }
}

function compareDecision(claimInput: unknown, observation: AnyObservation): ClaimResult {
  const claim = parseWith(DecisionClaim, claimInput, 'decision claim')
  if (observation.kind !== 'decision') {
    throw new SchemaError(`claim ${claim.id} is decision but the observation is ${observation.kind}`)
  }
  const head = { id: claim.id, kind: 'decision', block: observation.block } as const
  const claimed = { answer: claim.answer, probability: claim.probability, minProbability: claim.minProbability }
  // An unrecognised answer is a completeness failure, never a default side: UNVERIFIABLE gives WAIT.
  if (!observation.recognised || observation.unverifiable !== null) {
    return { ...head, status: 'UNVERIFIABLE', claimed, observed: { answer: observation.answer, recognised: false } }
  }
  const ok = observation.probability >= claim.minProbability
  return {
    ...head,
    status: ok ? 'TRUE' : 'FALSE',
    claimed,
    observed: { answer: observation.answer, recognised: true, probability: observation.probability },
  }
}

function comparePosition(claimInput: unknown, observation: AnyObservation): ClaimResult {
  const claim = parseWith(PositionClaim, claimInput, 'position claim')
  if (observation.kind !== 'position') {
    throw new SchemaError(`claim ${claim.id} is position but the observation is ${observation.kind}`)
  }
  if (claim.gate.toLowerCase() !== observation.gate.toLowerCase()) {
    throw new SchemaError(`claim ${claim.id} cites gate ${claim.gate}, observation is ${observation.gate}`)
  }
  const head = { id: claim.id, kind: 'position', block: observation.block } as const
  const claimed = { maxPositionBase: claim.maxPositionBase, maxNotionalUsd: claim.maxNotionalUsd }
  if (observation.unverifiable !== null) {
    return { ...head, status: 'UNVERIFIABLE', claimed, observed: null }
  }
  const observed = { positionBase: observation.positionBase, notionalUsd: observation.notionalUsd }
  const ok = observation.positionBase <= claim.maxPositionBase && observation.notionalUsd <= claim.maxNotionalUsd
  return { ...head, status: ok ? 'TRUE' : 'FALSE', claimed, observed }
}

/** Claim + observation -> TRUE, FALSE, or UNVERIFIABLE. Convention mismatches throw SchemaError. */
export function compare(claimInput: unknown, anyObservation: AnyObservation): ClaimResult {
  const inputKind =
    typeof claimInput === 'object' && claimInput !== null ? (claimInput as { kind?: unknown }).kind : undefined
  if (inputKind === 'vault_rate') return compareVaultRate(claimInput, anyObservation)
  if (inputKind === 'balance') return compareBalance(claimInput, anyObservation)
  if (inputKind === 'kuru_book') return compareKuruBook(claimInput, anyObservation)
  if (inputKind === 'decision') return compareDecision(claimInput, anyObservation)
  if (inputKind === 'position') return comparePosition(claimInput, anyObservation)

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
