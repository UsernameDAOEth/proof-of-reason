import { z } from 'zod'
import { ActionV0, AddressString, ClaimsV0, DecimalString, TypedDecisionClaims } from 'proof-of-reason-engine/claims'
import { MAX_CALLDATA_BYTES } from './config.ts'

const UINT64_MAX = 2n ** 64n - 1n

const Calldata = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/, 'hex bytes with 0x prefix')
  .refine((s) => (s.length - 2) / 2 <= MAX_CALLDATA_BYTES, `at most ${MAX_CALLDATA_BYTES} bytes`)

/** POST /check body. Exactly one of claims or prose. */
export const CheckRequestV0 = z
  .strictObject({
    intent: z.strictObject({
      vault: AddressString,
      data: Calldata,
      nonce: DecimalString,
      notAfterBlock: DecimalString.refine(
        (s) => !/^(0|[1-9][0-9]*)$/.test(s) || BigInt(s) <= UINT64_MAX,
        'exceeds uint64',
      ),
    }),
    action: ActionV0,
    // ClaimV0 kinds under a Morpho mandate, typed-decision kinds under a typed-decision mandate.
    claims: z.union([ClaimsV0, TypedDecisionClaims]).optional(),
    prose: z.string().min(1).max(8_000).optional(),
    mandateId: z.string().min(1).max(64),
    /** The model version the adapter reports, recorded as the receipt's model id. */
    model: z.string().min(1).max(200).optional(),
  })
  .refine((b) => (b.claims === undefined) !== (b.prose === undefined), {
    message: 'send exactly one of claims or prose',
  })

export type CheckRequestV0 = z.infer<typeof CheckRequestV0>
