import type { MandateV0 } from 'proof-of-reason-engine/claims'

/** Market ids from docs/MONAD.md section 3. */
export const MARKET_A = '0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626'
export const MARKET_B = '0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439'

/**
 * Mandates are set by the principal and bundled with the worker, so every mandate a verdict
 * cites is public and versioned in git. A change is a redeploy.
 */
export const MANDATES: Readonly<Record<string, MandateV0>> = {
  'demo-usdc-v1': {
    allowedMarkets: [MARKET_A, MARKET_B],
    requiredKinds: ['rate', 'liquidity'],
  },
}
