import { describe, expect, it } from 'vitest'
import {
  handleAgentSet,
  handleExecuted,
  handleValidationRequest,
  handleValidationResponse,
  handleValidatorSet,
} from '../src/handlers.ts'
import type { AgentRow, GateRow, Loader, RegistryAgentRow, RegistryVerdictRow, VerdictRow } from '../src/handlers.ts'

/**
 * `envio codegen` writes generated/ but its ReScript build does not complete inside this pnpm
 * workspace, so envio's own TestHelpers are not available (docs/ENVIO.md, "Codegen and the workspace").
 * The handler bodies are pure functions over this store instead, which is the whole reducer: the same
 * code the registration shim in src/EventHandlers.ts calls.
 */
function store() {
  const tables = {
    Gate: new Map<string, GateRow>(),
    Agent: new Map<string, AgentRow>(),
    Verdict: new Map<string, VerdictRow>(),
    RegistryAgent: new Map<string, RegistryAgentRow>(),
    RegistryVerdict: new Map<string, RegistryVerdictRow>(),
  }
  const table = <T extends { id: string }>(map: Map<string, T>) => ({
    get: async (id: string) => map.get(id),
    set: (row: T) => {
      map.set(row.id, row)
    },
  })
  const context = {
    Gate: table(tables.Gate),
    Agent: table(tables.Agent),
    Verdict: table(tables.Verdict),
    RegistryAgent: table(tables.RegistryAgent),
    RegistryVerdict: table(tables.RegistryVerdict),
  } as unknown as Loader
  return { context, tables }
}

const GATE = '0x4E23Fe7D8ED36ADA7cAc3645a7801c352d3daAbc'
const VALIDATOR = '0x0376AAc07Ad725E01357B1725B5ceC61aE10473c'
const AGENT_ID = 42n
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const receipt = (n: number) => `0x${(n + 0xbb).toString(16).padStart(64, '0')}`

let blockCounter = 1_000

function executed(options: {
  intentHash: string
  outcome: number
  ownerOverride?: boolean
  receiptHash?: string
  gate?: string
}) {
  return {
    srcAddress: options.gate ?? GATE,
    params: {
      intentHash: options.intentHash,
      outcome: options.outcome,
      receiptHash: options.receiptHash ?? receipt(1),
      ownerOverride: options.ownerOverride ?? false,
    },
    block: { number: ++blockCounter },
    transaction: { hash: `0x${'ee'.repeat(32)}` },
  }
}

function response(options: {
  requestHash: string
  response: number
  requested?: boolean
  responseHash?: string
  agentId?: bigint
  tag?: string
}) {
  return {
    params: {
      validator: VALIDATOR,
      agentId: options.agentId ?? AGENT_ID,
      requestHash: options.requestHash,
      response: options.response,
      responseHash: options.responseHash ?? receipt(1),
      tag: options.tag ?? 'REASON-R0',
      requested: options.requested ?? false,
    },
    block: { number: ++blockCounter },
    transaction: { hash: `0x${'dd'.repeat(32)}` },
  }
}

const gateId = GATE.toLowerCase()

describe('a gate execution', () => {
  it('records a pass on the gate, the agent and the verdict', async () => {
    const { context, tables } = store()
    await handleExecuted('ReasonGate', executed({ intentHash: hash(1), outcome: 1 }), context)

    expect(tables.Gate.get(gateId)).toMatchObject({ kind: 'ReasonGate', executions: 1, passes: 1, waits: 0, overrides: 0 })
    expect(tables.Agent.get(gateId)).toMatchObject({
      passes: 1,
      waits: 0,
      fails: 0,
      others: 0,
      samples: 1,
      boundStatus: 'INSUFFICIENT_HISTORY',
      wilsonLowerBound: undefined,
      lastOutcome: 'PASS',
    })
    expect(tables.Verdict.get(hash(1))).toMatchObject({
      outcome: 'PASS',
      outcomeCode: 1,
      source: 'gate',
      gate: gateId,
      ownerOverride: false,
      receiptHash: receipt(1),
    })
  })

  it('records an executed wait as a wait and an override, never as a pass', async () => {
    const { context, tables } = store()
    await handleExecuted('KuruGate', executed({ intentHash: hash(2), outcome: 2, ownerOverride: true }), context)

    expect(tables.Gate.get(gateId)).toMatchObject({ kind: 'KuruGate', passes: 0, waits: 1, overrides: 1 })
    expect(tables.Agent.get(gateId)).toMatchObject({ passes: 0, waits: 1, overrides: 1, samples: 1 })
    expect(tables.Verdict.get(hash(2))).toMatchObject({ outcome: 'WAIT', outcomeCode: 2, ownerOverride: true })
  })

  it('keeps the validator and the agent key the owner set', async () => {
    const { context, tables } = store()
    await handleValidatorSet({ srcAddress: GATE, params: { newValidator: VALIDATOR }, block: { number: 1 } }, context, 'ReasonGate')
    await handleAgentSet({ srcAddress: GATE, params: { newAgent: '0xAbC0000000000000000000000000000000000001' }, block: { number: 2 } }, context, 'ReasonGate')

    expect(tables.Gate.get(gateId)).toMatchObject({
      validator: VALIDATOR.toLowerCase(),
      agentKey: '0xabc0000000000000000000000000000000000001',
    })
    expect(tables.Agent.get(gateId)?.validator).toBe(VALIDATOR.toLowerCase())
  })
})

describe('a PASS is never counted twice', () => {
  it('counts the gate pass once when the registry records the same intent hash', async () => {
    const { context, tables } = store()
    await handleExecuted('ReasonGate', executed({ intentHash: hash(3), outcome: 1 }), context)
    await handleValidationResponse(response({ requestHash: hash(3), response: 100 }), context)

    expect(tables.Agent.get(gateId)).toMatchObject({ passes: 1, fails: 0, others: 0, samples: 1 })
    // The audit view counts it too, which is the point of keeping both.
    expect(tables.RegistryAgent.get('42')).toMatchObject({ recorded: 1, passes: 1, fails: 0, volunteered: 1 })
    expect(tables.Verdict.get(hash(3))).toMatchObject({ source: 'both', outcome: 'PASS', gate: gateId })
  })

  it('counts it once in the other order too, and learns the agent id from the overlap', async () => {
    const { context, tables } = store()
    await handleValidationResponse(response({ requestHash: hash(4), response: 100 }), context)
    await handleExecuted('ReasonGate', executed({ intentHash: hash(4), outcome: 1 }), context)

    expect(tables.Agent.get(gateId)).toMatchObject({ passes: 1, samples: 1, registryAgentId: 42n })
    expect(tables.Gate.get(gateId)?.registryAgentId).toBe(42n)
    expect(tables.RegistryAgent.get('42')?.gate).toBe(gateId)
    expect(tables.Verdict.get(hash(4))?.source).toBe('both')
  })
})

describe('the registry supplies the fails', () => {
  it('counts a fail against the agent once the gate and the agent id are linked', async () => {
    const { context, tables } = store()
    // The link: one verdict both sides recorded.
    await handleExecuted('ReasonGate', executed({ intentHash: hash(5), outcome: 1 }), context)
    await handleValidationResponse(response({ requestHash: hash(5), response: 100 }), context)
    // A refusal: no gate event exists for it, because a FAIL reverts.
    await handleValidationResponse(response({ requestHash: hash(6), response: 0, responseHash: receipt(6) }), context)

    expect(tables.Agent.get(gateId)).toMatchObject({ passes: 1, fails: 1, samples: 2, lastOutcome: 'FAIL' })
    expect(tables.Verdict.get(hash(6))).toMatchObject({
      outcome: 'FAIL',
      outcomeCode: 3,
      source: 'registry',
      gate: undefined,
      receiptHash: receipt(6),
      requested: false,
    })
    expect(tables.RegistryVerdict.get(hash(6))).toMatchObject({
      response: 0,
      outcome: 'FAIL',
      requested: false,
      responses: 1,
      tag: 'REASON-R0',
      validator: VALIDATOR.toLowerCase(),
    })
  })

  it('holds a fail on the audit view alone until a gate is linked', async () => {
    const { context, tables } = store()
    await handleValidationResponse(response({ requestHash: hash(7), response: 0 }), context)

    expect(tables.Agent.size).toBe(0)
    expect(tables.RegistryAgent.get('42')).toMatchObject({ recorded: 1, fails: 1, volunteered: 1 })
  })

  it('does not count a repeat response twice', async () => {
    const { context, tables } = store()
    await handleExecuted('ReasonGate', executed({ intentHash: hash(8), outcome: 1 }), context)
    await handleValidationResponse(response({ requestHash: hash(8), response: 100 }), context)
    await handleValidationResponse(response({ requestHash: hash(9), response: 0 }), context)
    await handleValidationResponse(response({ requestHash: hash(9), response: 0, responseHash: receipt(99) }), context)

    expect(tables.Agent.get(gateId)).toMatchObject({ passes: 1, fails: 1, samples: 2 })
    expect(tables.RegistryAgent.get('42')?.recorded).toBe(2)
    // The latest response wins on the record, and the count says how many there were.
    expect(tables.RegistryVerdict.get(hash(9))).toMatchObject({ responses: 2, responseHash: receipt(99) })
  })
})

describe('an OTHER response is stored with no outcome and left out of the bound', () => {
  it('counts it as an other, scores nothing, and leaves the verdict outcome null', async () => {
    const { context, tables } = store()
    await handleExecuted('ReasonGate', executed({ intentHash: hash(10), outcome: 1 }), context)
    await handleValidationResponse(response({ requestHash: hash(10), response: 100 }), context)
    await handleValidationResponse(response({ requestHash: hash(11), response: 73 }), context)

    const agent = tables.Agent.get(gateId)!
    expect(agent.others).toBe(1)
    expect(agent.samples).toBe(1)
    expect(agent.passes + agent.waits + agent.fails).toBe(agent.samples)
    expect(tables.Verdict.get(hash(11))).toMatchObject({ outcome: undefined, outcomeCode: undefined })
    expect(tables.RegistryVerdict.get(hash(11))).toMatchObject({ response: 73, outcome: undefined, outcomeCode: undefined })
    expect(tables.RegistryAgent.get('42')?.others).toBe(1)
  })
})

describe('the requested flag', () => {
  it('is false for a verdict the agent never asked for, and flips when it does', async () => {
    const { context, tables } = store()
    await handleValidationResponse(response({ requestHash: hash(12), response: 0, requested: false }), context)
    expect(tables.RegistryVerdict.get(hash(12))?.requested).toBe(false)
    expect(tables.RegistryAgent.get('42')?.volunteered).toBe(1)

    await handleValidationRequest(
      {
        params: { validator: VALIDATOR, agentId: AGENT_ID, requestHash: hash(12), requestUri: 'https://api.proofofreason.com/check' },
        block: { number: ++blockCounter },
      },
      context,
    )

    const row = tables.RegistryVerdict.get(hash(12))!
    expect(row.requested).toBe(true)
    expect(row.requestUri).toBe('https://api.proofofreason.com/check')
    // The verdict it volunteered is untouched by the request.
    expect(row.response).toBe(0)
    expect(row.responses).toBe(1)
    expect(tables.Verdict.get(hash(12))?.requested).toBe(true)
  })

  it('stays true once set, whatever a later response says', async () => {
    const { context, tables } = store()
    await handleValidationResponse(response({ requestHash: hash(13), response: 0, requested: true }), context)
    await handleValidationResponse(response({ requestHash: hash(13), response: 50, requested: false }), context)
    expect(tables.RegistryVerdict.get(hash(13))?.requested).toBe(true)
    expect(tables.Verdict.get(hash(13))?.requested).toBe(true)
  })
})

describe('the bound over a real history', () => {
  it('reports 0.4902 for eight passes and two fails, the tenth sample being the threshold', async () => {
    const { context, tables } = store()
    for (let i = 0; i < 8; i++) {
      const h = hash(100 + i)
      await handleExecuted('ReasonGate', executed({ intentHash: h, outcome: 1 }), context)
      await handleValidationResponse(response({ requestHash: h, response: 100 }), context)
    }
    expect(tables.Agent.get(gateId)?.boundStatus).toBe('INSUFFICIENT_HISTORY')

    await handleValidationResponse(response({ requestHash: hash(200), response: 0 }), context)
    expect(tables.Agent.get(gateId)?.samples).toBe(9)
    expect(tables.Agent.get(gateId)?.boundStatus).toBe('INSUFFICIENT_HISTORY')

    await handleValidationResponse(response({ requestHash: hash(201), response: 0 }), context)
    const agent = tables.Agent.get(gateId)!
    expect(agent).toMatchObject({ passes: 8, fails: 2, samples: 10, boundStatus: 'OK' })
    expect(agent.wilsonLowerBound).toBeCloseTo(0.4902, 4)
  })

  it('keeps two gates apart', async () => {
    const { context, tables } = store()
    const other = '0x2Ff1552DD09f87d6774229Ee4A0b3B9e5f7F4bdE'
    await handleExecuted('ReasonGate', executed({ intentHash: hash(20), outcome: 1 }), context)
    await handleExecuted('KuruGate', executed({ intentHash: hash(21), outcome: 1, gate: other }), context)

    expect(tables.Agent.get(gateId)?.passes).toBe(1)
    expect(tables.Agent.get(other.toLowerCase())?.passes).toBe(1)
    expect(tables.Gate.size).toBe(2)
  })
})
