import type { Address, Hex, LocalAccount } from 'viem'
import { checkAction } from 'proof-of-reason-engine/action'
import { isTypedDecisionMandate, parseClaims, parseTypedDecisionClaims } from 'proof-of-reason-engine/claims'
import type { ClaimV0, Mandate, TypedDecisionClaim } from 'proof-of-reason-engine/claims'
import { compare } from 'proof-of-reason-engine/compare'
import { checkMandate, checkTypedDecisionMandate } from 'proof-of-reason-engine/mandate'
import { observeAll } from 'proof-of-reason-engine/morpho'
import type { MorphoReader } from 'proof-of-reason-engine/morpho'
import { observeTypedDecisionAll } from 'proof-of-reason-engine/kuru'
import type { KuruReader } from 'proof-of-reason-engine/kuru'
import { RULESET, buildReceipt, canonicalJson, receiptHash } from 'proof-of-reason-engine/receipt'
import type { Receipt, ReceiptRegistryRecord } from 'proof-of-reason-engine/receipt'
import { gateDomain, signVerdict } from 'proof-of-reason-engine/sign'
import type { GateDomain } from 'proof-of-reason-engine/sign'
import { OUTCOME_CODE, decide } from 'proof-of-reason-engine/verdict'
import type { Verdict } from 'proof-of-reason-engine/verdict'
import type { CheckRequestV0 } from './body.ts'
import { CHECK_LAG_BLOCKS } from './config.ts'
import { OUTCOME_RESPONSE, describeRegistryError } from './registry.ts'
import type { RegistryWriter } from './registry.ts'

export class HttpError extends Error {
  readonly status: 400 | 404 | 422 | 500 | 503

  constructor(status: 400 | 404 | 422 | 500 | 503, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export type CheckDeps = {
  reader: MorphoReader
  /** Kuru reads, used by typed-decision mandates. */
  kuru: KuruReader
  getBlockNumber: () => Promise<bigint>
  /** Built from the VALIDATOR_KEY secret at request time. Never logged. */
  account: LocalAccount
  chainId: number
  gate: Address
  vault: Address
  /** Absent when no validation registry is configured: the receipt then says so. */
  registry?: RegistryWriter
}

export type SignedVerdict = {
  domain: GateDomain
  intentHash: Hex
  claimsHash: Hex
  outcome: 1 | 2 | 3
  checkedAtBlock: bigint
  receiptHash: Hex
  validator: Address
  signature: Hex
}

export type CheckResult = {
  mandateId: string
  verdict: Verdict
  signed: SignedVerdict
  receipt: Receipt
  /** The exact bytes stored in KV and hashed into receiptHash. */
  receiptJson: string
}

async function recordVerdict(
  deps: CheckDeps,
  agentId: string | undefined,
  intentHash: Hex,
  hash: Hex,
  outcome: Verdict['outcome'],
): Promise<ReceiptRegistryRecord> {
  const response = OUTCOME_RESPONSE[outcome]
  const base = { agentId: agentId ?? null, address: deps.registry?.address ?? null, response, tag: RULESET }
  if (deps.registry === undefined) return { ...base, error: 'no validation registry is configured' }
  if (agentId === undefined || agentId === '0') {
    // "0" is the placeholder a mandate carries until the agent is registered. Agent id 0 exists on
    // no Identity Registry, so sending it would spend gas on a certain revert.
    return { ...base, error: 'the mandate carries no ERC-8004 agent id yet' }
  }
  try {
    const tx = await deps.registry.write({
      agentId: BigInt(agentId),
      requestHash: intentHash,
      response,
      responseHash: hash,
      tag: RULESET,
    })
    return { ...base, tx }
  } catch (error) {
    return { ...base, error: describeRegistryError(error) }
  }
}

export async function runCheck(
  request: CheckRequestV0,
  mandate: Mandate,
  deps: CheckDeps,
): Promise<CheckResult> {
  if (request.intent.vault.toLowerCase() !== deps.vault.toLowerCase()) {
    throw new HttpError(400, `this validator serves vault ${deps.vault}`)
  }
  const claims = request.claims
  if (claims === undefined) {
    throw new HttpError(422, 'prose extraction is not configured on this validator; send typed claims')
  }
  const data = request.intent.data as Hex

  // The mandate decides which claim family is legal. A typed-decision mandate takes kuru_book,
  // decision and position; a Morpho mandate takes the ClaimV0 kinds. Never a mix.
  const typedDecision = isTypedDecisionMandate(mandate)
  let typedClaims: TypedDecisionClaim[] | null = null
  let v0Claims: ClaimV0[] | null = null
  try {
    if (typedDecision) typedClaims = parseTypedDecisionClaims(claims)
    else v0Claims = parseClaims(claims)
  } catch {
    const expected = typedDecision ? 'typed-decision' : 'ClaimV0'
    throw new HttpError(400, `mandate ${request.mandateId} takes ${expected} claim kinds`)
  }

  let head: bigint
  let observations
  try {
    head = await deps.getBlockNumber()
    const pinned = head - CHECK_LAG_BLOCKS
    // One read at a time, claim by claim, block by block (docs/MONAD.md, RPC policy).
    observations = typedClaims
      ? await observeTypedDecisionAll(deps.kuru, typedClaims, pinned)
      : await observeAll(deps.reader, v0Claims!, pinned)
  } catch (error) {
    // No payment is settled on a 5xx. The upstream message is not echoed.
    throw new HttpError(503, 'chain state unavailable')
  }
  const checkedAtBlock = head - CHECK_LAG_BLOCKS

  const results = claims.map((claim, i) => compare(claim, observations[i]!))
  const action = checkAction(request.action, data)
  const verdict = decide({
    results,
    actionMismatches: action.mismatches,
    mandateViolations: typedDecision
      ? checkTypedDecisionMandate(typedClaims, mandate)
      : checkMandate(action.decoded, mandate),
    requiredKinds: mandate.requiredKinds,
  })

  const receipt = buildReceipt({
    chainId: deps.chainId,
    gate: deps.gate,
    vault: deps.vault,
    data,
    nonce: BigInt(request.intent.nonce),
    notAfterBlock: BigInt(request.intent.notAfterBlock),
    claims,
    action: request.action,
    mandate,
    observations,
    results,
    verdict,
    checkedAtBlock,
    modelId: request.model ?? null,
  })
  const hash = receiptHash(receipt)
  const domain = gateDomain(deps.chainId, deps.gate)
  const outcome = OUTCOME_CODE[verdict.outcome]
  const signature = await signVerdict(deps.account, domain, {
    intentHash: receipt.intent.intentHash,
    outcome,
    checkedAtBlock,
    receiptHash: hash,
  })

  // Every verdict goes on the record, PASS, WAIT and FAIL alike. The response it posts is this
  // receipt's own hash, so this runs after the signature and lands outside receiptHash. Fail-soft:
  // the verdict is returned either way, and the receipt says what happened.
  receipt.registry = await recordVerdict(deps, mandate.agentId, receipt.intent.intentHash, hash, verdict.outcome)
  const receiptJson = canonicalJson(receipt)

  return {
    mandateId: request.mandateId,
    verdict,
    signed: {
      domain,
      intentHash: receipt.intent.intentHash,
      claimsHash: receipt.intent.claimsHash,
      outcome,
      checkedAtBlock,
      receiptHash: hash,
      validator: deps.account.address,
      signature,
    },
    receipt,
    receiptJson,
  }
}
