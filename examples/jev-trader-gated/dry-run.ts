/**
 * One gated block against live Monad, with no key and nothing sent.
 *
 *   node dry-run.ts                 one block, a buy answer, PASS or FAIL on the real book
 *   ANSWER=SHORT node dry-run.ts    an answer the mandate does not list: WAIT, no order
 *
 * Reads only: getMarketParams, bestBidAsk, getL2Book and one balance, each pinned to the same
 * block, one request at a time, never batched (docs/MONAD.md, RPC policy). The validator runs in
 * this process and signs with a throwaway key, so the verdict is real but worth nothing: the
 * deployed gate only accepts the validator the principal set. No order is built into a transaction
 * and no transaction is signed, because no executor is passed.
 */
import { createPublicClient, http } from 'viem'
import type { Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { checkAction } from 'proof-of-reason-engine/action'
import { compare } from 'proof-of-reason-engine/compare'
import { observeTypedDecisionAll, viemKuruReader } from 'proof-of-reason-engine/kuru'
import { checkTypedDecisionMandate } from 'proof-of-reason-engine/mandate'
import { buildReceipt, receiptHash } from 'proof-of-reason-engine/receipt'
import { gateDomain, signVerdict } from 'proof-of-reason-engine/sign'
import { OUTCOME_CODE, decide } from 'proof-of-reason-engine/verdict'
import type { TypedDecisionClaim } from 'proof-of-reason-engine/claims'
import { gatedBlock, loadMandate } from './adapter.ts'
import type { AdapterConfig, CheckResponse, UpstreamBook } from './adapter.ts'
import mandateJson from './mandate.json' with { type: 'json' }

const RPC = process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz'
const CHAIN_ID = 143
const LAG = 3n
const VENUE: Address = '0x065C9d28E428A0db40191a54d33d5b7c71a9C394'
/** Stands in for a deployed KuruGate: in a dry run it is only an address to price a position at. */
const GATE: Address = (process.env.GATE as Address) ?? '0x2Ff1552DD09f87d6774229Ee4A0b3B9e5f7F4bdE'

const client = createPublicClient({ transport: http(RPC, { batch: false }) })
const kuru = viemKuruReader(client)
const validator = privateKeyToAccount(generatePrivateKey())

const config: AdapterConfig = {
  mandateId: 'jev-mon-usdc-v1',
  mandate: { ...loadMandate(mandateJson), gate: GATE },
  venue: VENUE,
  params: { priceDecimals: 8, sizeDecimals: 10, tickUnits: 100 },
  quoteInsideTicks: 1,
  tradeSizeMon: 200,
  tolerancePp: 0.1,
  intentLifetimeBlocks: 30,
  chainId: CHAIN_ID,
  validator: validator.address,
  modelId: 'dry-run stand-in (jev-trader b587759)',
}

/** The validator, in this process: the same engine calls the worker makes on POST /check. */
async function check(bodyInput: unknown): Promise<CheckResponse> {
  const body = bodyInput as {
    intent: { vault: Address; data: `0x${string}`; nonce: string; notAfterBlock: string }
    action: never
    claims: TypedDecisionClaim[]
    mandateId: string
    model: string
  }
  const head = await client.getBlockNumber()
  const checkedAtBlock = head - LAG
  const observations = await observeTypedDecisionAll(kuru, body.claims, checkedAtBlock)
  const results = body.claims.map((claim, i) => compare(claim, observations[i]!))
  const action = checkAction(body.action, body.intent.data)
  const verdict = decide({
    results,
    actionMismatches: action.mismatches,
    mandateViolations: checkTypedDecisionMandate(body.claims, config.mandate),
    requiredKinds: config.mandate.requiredKinds,
  })
  const receipt = buildReceipt({
    chainId: CHAIN_ID,
    gate: GATE,
    vault: VENUE,
    data: body.intent.data,
    nonce: BigInt(body.intent.nonce),
    notAfterBlock: BigInt(body.intent.notAfterBlock),
    claims: body.claims,
    action: body.action,
    mandate: config.mandate,
    observations,
    results,
    verdict,
    checkedAtBlock,
    modelId: body.model,
  })
  const hash = receiptHash(receipt)
  const domain = gateDomain(CHAIN_ID, GATE)
  const outcome = OUTCOME_CODE[verdict.outcome]
  return {
    mandateId: body.mandateId,
    verdict: { outcome: verdict.outcome, failing: verdict.failing, missingKinds: verdict.missingKinds },
    signed: {
      domain,
      intentHash: receipt.intent.intentHash,
      claimsHash: receipt.intent.claimsHash,
      outcome,
      checkedAtBlock: checkedAtBlock.toString(),
      receiptHash: hash,
      validator: validator.address,
      signature: await signVerdict(validator, domain, {
        intentHash: receipt.intent.intentHash,
        outcome,
        checkedAtBlock,
        receiptHash: hash,
      }),
    },
    receipt,
  }
}

const head = await client.getBlockNumber()
const pinned = head - LAG
const { bestBid, bestAsk } = await kuru.bestBidAsk(VENUE, pinned)
const bid = Number(bestBid) / 1e18
const ask = Number(bestAsk) / 1e18
const book: UpstreamBook = { block: Number(pinned), bid, ask, mid: (bid + ask) / 2 }

const answer = process.env.ANSWER ?? 'buy'
// A stand-in for the model, not the model: the point of the dry run is the gate, not the signal.
const decision = { action: answer, probabilities: { [answer]: 0.71, sell: 0.29 } }

const state = {
  market: 'MON-USDC',
  block: Number(pinned),
  horizonBlocks: 100,
  mid: book.mid,
  spreadBps: ((ask - bid) / book.mid) * 10_000,
  note: 'dry run: a stand-in state, not the state a live model was shown',
}

console.log(`block ${pinned} | bid ${bid.toFixed(6)} ask ${ask.toFixed(6)} | answer ${answer} | ${RPC}`)
const result = await gatedBlock({ block: Number(pinned), state, decision, book, cancels: [] }, config, {
  check,
  blockNumber: async () => head,
  nonce: () => BigInt(Date.now()),
  log: (line) => console.log(line),
})
console.log(
  [
    `outcome ${result.outcome}`,
    `sent ${result.sent}`,
    `order ${result.order?.side ?? 'none'}${result.order && result.order.priceUnits > 0n ? ` at ${result.order.priceUnits}` : ''}`,
    `receipt ${result.receiptHash ?? 'none'}`,
    `state ${result.stateHash}`,
    result.reason,
  ].join(' | '),
)
