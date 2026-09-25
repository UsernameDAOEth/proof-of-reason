import type { Mandate } from 'proof-of-reason-engine/claims'

/** Market ids from docs/MONAD.md section 3. */
export const MARKET_A = '0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626'
export const MARKET_B = '0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439'

/**
 * Mandates are set by the principal and bundled with the worker, so every mandate a verdict
 * cites is public and versioned in git. A change is a redeploy.
 */
export const MANDATES = {
  'demo-usdc-v1': {
    allowedMarkets: [MARKET_A, MARKET_B],
    requiredKinds: ['rate', 'liquidity'],
    // ERC-8004 agent id of the demo agent, from runbook step 6. "0" is the placeholder until 2B
    // registers it: with a placeholder every receipt records a registry error and no verdict is
    // written, which is visible rather than silent.
    agentId: 'REPLACE_WITH_AGENT_ID',
  },
  // A typed-decision mandate (engine TypedDecisionMandate) may be registered here the same way;
  // examples/jev-trader-gated/mandate.json carries one, and adding it is a redeploy.
} satisfies Record<string, Mandate>
