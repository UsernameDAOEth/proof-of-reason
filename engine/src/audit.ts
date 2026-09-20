import { z } from 'zod'
import { IdentityClaim, LiquidityClaim, RateClaim, SchemaError, UtilizationClaim } from './claims.ts'
import type { ClaimV0 } from './claims.ts'
import type { AnyObservation } from './compare.ts'
import { VaultRateClaim, observeVaultRate } from './erc4626.ts'
import type { Erc4626Reader } from './erc4626.ts'
import { BalanceClaim, observeBalance } from './erc20.ts'
import type { Erc20Reader } from './erc20.ts'
import { observe } from './morpho.ts'
import type { MorphoReader, ObserveOptions } from './morpho.ts'

/** Every claim kind the shadow runner audits: ClaimV0 plus the audit-only vault_rate and balance. */
export const AuditClaim = z.discriminatedUnion('kind', [
  RateClaim,
  UtilizationClaim,
  LiquidityClaim,
  IdentityClaim,
  VaultRateClaim,
  BalanceClaim,
])

export const AuditClaims = z.array(AuditClaim).superRefine((claims, ctx) => {
  const seen = new Set<string>()
  for (const claim of claims) {
    if (seen.has(claim.id)) ctx.addIssue({ code: 'custom', message: `duplicate claim id ${claim.id}` })
    seen.add(claim.id)
  }
})

export type AuditClaim = z.infer<typeof AuditClaim>

export function parseAuditClaims(input: unknown): AuditClaim[] {
  const result = AuditClaims.safeParse(input)
  if (!result.success) {
    throw new SchemaError(
      'invalid audit claims',
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }
  return result.data
}

/** One reader per source of chain state, all pinned to blocks on the same chain. */
export type AuditReaders = { morpho: MorphoReader; erc4626: Erc4626Reader; erc20: Erc20Reader }

export async function observeAudit(
  readers: AuditReaders,
  claim: AuditClaim,
  block: bigint,
  options: ObserveOptions = {},
): Promise<AnyObservation> {
  switch (claim.kind) {
    case 'vault_rate':
      return observeVaultRate(readers.erc4626, claim, block)
    case 'balance':
      return observeBalance(readers.erc20, claim, block)
    default:
      return observe(readers.morpho, claim as ClaimV0, block, options)
  }
}

/** Observes each claim in order, one read at a time. Never concurrent, never batched. */
export async function observeAuditAll(
  readers: AuditReaders,
  claims: readonly AuditClaim[],
  block: bigint,
  options: ObserveOptions = {},
): Promise<AnyObservation[]> {
  const observations: AnyObservation[] = []
  for (const claim of claims) observations.push(await observeAudit(readers, claim, block, options))
  return observations
}
