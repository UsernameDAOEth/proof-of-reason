/**
 * Handlers for the interim ERC-8004 Validation Registry (contracts/src/ValidationRegistry.sol).
 *
 * The `generated` module comes from `pnpm envio codegen`, which reads config.yaml,
 * schema.graphql and abis/ValidationRegistry.json. Run codegen before typechecking this file.
 */
import { ValidationRegistry } from 'generated'
import { outcomeCodeOf, outcomeOf } from './outcomes.ts'

const agentKey = (agentId: bigint): string => agentId.toString()

ValidationRegistry.ValidationRequest.handler(async ({ event, context }) => {
  const id = event.params.requestHash
  const existing = await context.ValidationRecord.get(id)
  context.ValidationRecord.set({
    ...(existing ?? {
      id,
      agentId: event.params.agentId,
      validator: event.params.validator,
      response: undefined,
      outcome: undefined,
      outcomeCode: undefined,
      responseHash: undefined,
      tag: undefined,
      responses: 0,
      lastTx: undefined,
      firstBlock: BigInt(event.block.number),
    }),
    // A request may arrive after a volunteered response: the flag flips, the verdict is untouched.
    requested: true,
    requestUri: event.params.requestUri,
    lastBlock: BigInt(event.block.number),
  })
})

ValidationRegistry.ValidationResponse.handler(async ({ event, context }) => {
  const id = event.params.requestHash
  const response = Number(event.params.response)
  const outcome = outcomeOf(response)
  const existing = await context.ValidationRecord.get(id)

  context.ValidationRecord.set({
    id,
    agentId: event.params.agentId,
    validator: event.params.validator,
    response,
    outcome,
    outcomeCode: outcomeCodeOf(response),
    responseHash: event.params.responseHash,
    tag: event.params.tag,
    // The registry flags a response the agent never asked for; a later request can flip it.
    requested: existing?.requested ?? event.params.requested,
    // The latest response wins, and the count says how many there have been.
    responses: (existing?.responses ?? 0) + 1,
    requestUri: existing?.requestUri,
    firstBlock: existing?.firstBlock ?? BigInt(event.block.number),
    lastBlock: BigInt(event.block.number),
    lastTx: event.transaction.hash,
  })

  const key = agentKey(event.params.agentId)
  const agent = (await context.Agent.get(key)) ?? {
    id: key,
    recorded: 0,
    passes: 0,
    waits: 0,
    fails: 0,
    others: 0,
    volunteered: 0,
    lastOutcome: undefined,
    lastBlock: 0n,
  }
  // A repeat response for the same request hash replaces a verdict rather than adding one.
  const isRepeat = (existing?.responses ?? 0) > 0
  context.Agent.set({
    ...agent,
    recorded: agent.recorded + (isRepeat ? 0 : 1),
    passes: agent.passes + (outcome === 'PASS' ? 1 : 0),
    waits: agent.waits + (outcome === 'WAIT' ? 1 : 0),
    fails: agent.fails + (outcome === 'FAIL' ? 1 : 0),
    others: agent.others + (outcome === 'OTHER' ? 1 : 0),
    volunteered: agent.volunteered + (!event.params.requested && !isRepeat ? 1 : 0),
    lastOutcome: outcome,
    lastBlock: BigInt(event.block.number),
  })
})
