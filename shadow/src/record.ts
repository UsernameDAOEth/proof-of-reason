import { z } from 'zod'
import { toFunctionSelector } from 'viem'
import type { Hex } from 'viem'
import { AuditClaims } from 'proof-of-reason-engine/audit'
import { AddressString, SchemaError } from 'proof-of-reason-engine/claims'

const SELECTOR = /^0x[0-9a-fA-F]{8}$/
const SIGNATURE = /^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const MAX_WINDOW_SECONDS = 7 * 24 * 3600

/** 4-byte selector from a selector or a full function signature such as "reallocate(...)". */
export function methodSelector(method: string): Hex {
  if (SELECTOR.test(method)) return method.toLowerCase() as Hex
  if (SIGNATURE.test(method)) return toFunctionSelector(method)
  throw new SchemaError(`target.method ${method} is neither a 4-byte selector nor a function signature`)
}

/**
 * One public agent statement to audit. source_text is the reason copied verbatim from source_url.
 * Typed claims are audited; prose alone cannot be (no extractor is configured) and is recorded.
 * tx_hash is set only when the statement itself gives the transaction (PREREG Amendment 1), so
 * it must appear in source_text.
 */
export const ClaimRecordV0 = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/, 'lowercase slug'),
    agent: z.strictObject({ name: z.string().min(1).max(200), wallet: AddressString }),
    chain: z.enum(['monad', 'base', 'ethereum']),
    source_url: z.url(),
    source_text: z.string().min(1),
    posted_at: z.iso.datetime({ offset: true }),
    tx_hash: z.string().regex(TX_HASH, '0x plus 64 hex characters').optional(),
    claims: AuditClaims.optional(),
    prose: z.string().min(1).optional(),
    target: z
      .strictObject({
        contract: AddressString.optional(),
        method: z
          .string()
          .refine((m) => SELECTOR.test(m) || SIGNATURE.test(m), '4-byte selector or function signature')
          .optional(),
      })
      .optional(),
    window: z
      .strictObject({
        beforeSeconds: z.number().int().min(0).max(MAX_WINDOW_SECONDS),
        afterSeconds: z.number().int().min(0).max(MAX_WINDOW_SECONDS),
      })
      .optional(),
  })
  .refine((r) => r.claims !== undefined || r.prose !== undefined, 'send typed claims, prose, or both')
  .refine((r) => r.tx_hash === undefined || r.source_text.toLowerCase().includes(r.tx_hash.toLowerCase()), {
    message: 'tx_hash does not appear in source_text',
    path: ['tx_hash'],
  })

export type ClaimRecordV0 = z.infer<typeof ClaimRecordV0>

/** Drops keys whose value is undefined, so a record built in code hashes like one read from JSON. */
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, withoutUndefined(v)]),
    ) as T
  }
  return value
}

export function parseClaimRecord(input: unknown): ClaimRecordV0 {
  const result = ClaimRecordV0.safeParse(input)
  if (!result.success) {
    throw new SchemaError(
      'invalid claim record',
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }
  return withoutUndefined(result.data)
}
