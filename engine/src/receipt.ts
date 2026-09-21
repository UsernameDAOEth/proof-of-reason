import { keccak256, stringToBytes } from 'viem'
import type { Address, Hex } from 'viem'
import { parseAction, parseAnyClaims, parseAnyMandate, parseClaims } from './claims.ts'
import type { ActionV0, AnyClaim, AnyClaimKind, ClaimV0, Mandate } from './claims.ts'
import type { AnyObservation, ClaimResult } from './compare.ts'
import { OUTCOME_CODE } from './verdict.ts'
import type { FailingItem, Verdict } from './verdict.ts'
import { gateDomain, hashIntent } from './sign.ts'

export const RULESET = 'REASON-R0'
export const ENGINE_VERSION = '0.2.0'

/** Carried by every receipt whose mandate requires no claim kinds. */
export const PREMISE_CHECK_DISABLED = 'premise check disabled by mandate'

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, bigints as base-10
 * strings. undefined, non-finite numbers, and non-plain objects are rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number ${value}`)
      return JSON.stringify(value)
    case 'undefined':
      throw new TypeError('undefined is not allowed in canonical JSON')
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      if (!isPlainObject(value)) throw new TypeError('only plain objects are allowed in canonical JSON')
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
    }
    default:
      throw new TypeError(`${typeof value} is not allowed in canonical JSON`)
  }
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)))
}

/** The claimsHash bound into the on-chain Intent. */
export function claimsHash(claims: readonly ClaimV0[]): Hex {
  return hashCanonical(parseClaims(claims))
}

export type ReceiptInput = {
  chainId: number
  gate: Address
  vault: Address
  data: Hex
  nonce: bigint
  notAfterBlock: bigint
  claims: readonly AnyClaim[]
  action: ActionV0
  mandate: Mandate
  observations: readonly AnyObservation[]
  results: readonly ClaimResult[]
  verdict: Verdict
  checkedAtBlock: bigint
  /** null for typed claims. */
  modelId: string | null
}

export type Receipt = {
  ruleset: typeof RULESET
  engineVersion: string
  modelId: string | null
  /** Human-readable warnings about the check itself. */
  notices: string[]
  intent: {
    chainId: number
    gate: Address
    vault: Address
    data: Hex
    dataHash: Hex
    claimsHash: Hex
    nonce: bigint
    notAfterBlock: bigint
    intentHash: Hex
  }
  claims: AnyClaim[]
  action: ActionV0
  mandate: Mandate
  observations: AnyObservation[]
  results: ClaimResult[]
  verdict: {
    outcome: Verdict['outcome']
    outcomeCode: 1 | 2 | 3
    checkedAtBlock: bigint
    failing: FailingItem[]
    missingKinds: AnyClaimKind[]
  }
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const claims = parseAnyClaims(input.claims)
  const dataHash = keccak256(input.data)
  const boundClaimsHash = hashCanonical(claims)
  const intentHash = hashIntent(gateDomain(input.chainId, input.gate), {
    vault: input.vault,
    dataHash,
    claimsHash: boundClaimsHash,
    nonce: input.nonce,
    notAfterBlock: input.notAfterBlock,
  })
  const mandate = parseAnyMandate(input.mandate)
  return {
    ruleset: RULESET,
    engineVersion: ENGINE_VERSION,
    modelId: input.modelId,
    notices: mandate.requiredKinds.length === 0 ? [PREMISE_CHECK_DISABLED] : [],
    intent: {
      chainId: input.chainId,
      gate: input.gate,
      vault: input.vault,
      data: input.data,
      dataHash,
      claimsHash: boundClaimsHash,
      nonce: input.nonce,
      notAfterBlock: input.notAfterBlock,
      intentHash,
    },
    claims,
    action: parseAction(input.action),
    mandate,
    observations: [...input.observations],
    results: [...input.results],
    verdict: {
      outcome: input.verdict.outcome,
      outcomeCode: OUTCOME_CODE[input.verdict.outcome],
      checkedAtBlock: input.checkedAtBlock,
      failing: input.verdict.failing,
      missingKinds: input.verdict.missingKinds,
    },
  }
}

export function receiptHash(receipt: Receipt): Hex {
  return hashCanonical(receipt)
}
