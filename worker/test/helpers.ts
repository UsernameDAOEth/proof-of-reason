import { encodeFunctionData, maxUint256 } from 'viem'
import type { Address, Hex, LocalAccount } from 'viem'
import type { FacilitatorClient } from '@x402/core/server'
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types'
import { vaultAbi } from 'proof-of-reason-engine/action'
import type { MarketParams, MarketState, MorphoReader } from 'proof-of-reason-engine/morpho'
import type { ReceiptStore } from '../src/app.ts'
import type { CheckDeps } from '../src/check.ts'
import { CHAIN_ID, NETWORK, USDC } from '../src/config.ts'
import { MARKET_A, MARKET_B } from '../src/mandates.ts'

export const GATE: Address = '0x4E23Fe7D8ED36ADA7cAc3645a7801c352d3daAbc'
export const VAULT: Address = '0x54020D40c067682CDEE580BEd1D81390add9eB07'
export const PAY_TO: Address = '0x000000000000000000000000000000000000bEEF'
export const HEAD = 106_005_210n

const IRM: Address = '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F'

export const PARAMS: Record<string, MarketParams> = {
  [MARKET_A]: {
    loanToken: USDC,
    collateralToken: '0x7Cd231120a60F500887444a9bAF5e1BD753A5e59',
    oracle: '0x4af4f38164cD7F28653A66aa2255B249a23cFBec',
    irm: IRM,
    lltv: 770_000_000_000_000_000n,
  },
  [MARKET_B]: {
    loanToken: USDC,
    collateralToken: '0xa08A69aB9Dd3B04D0992BC7aFb2c0b907bbdc147',
    oracle: '0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2',
    irm: IRM,
    lltv: 915_000_000_000_000_000n,
  },
}

/** Totals recorded on chain at block 106005207 (docs/MONAD.md section 3). */
export const STATES: Record<string, MarketState> = {
  [MARKET_A]: {
    totalSupplyAssets: 38_611_206_128_629n,
    totalSupplyShares: 36_833_707_365_233_718_888n,
    totalBorrowAssets: 34_571_206_128_629n,
    totalBorrowShares: 32_903_979_014_262_383_361n,
    lastUpdate: 1_789_767_986n,
    fee: 0n,
  },
  [MARKET_B]: {
    totalSupplyAssets: 19_280_298_466_672n,
    totalSupplyShares: 19_150_312_854_356_873_706n,
    totalBorrowAssets: 17_199_475_869_871n,
    totalBorrowShares: 17_070_271_479_155_716_688n,
    lastUpdate: 1_789_768_873n,
    fee: 0n,
  },
}

/** A fixed borrow rate per market for the fake IRM, WAD per second. */
export const BORROW_RATE: Record<string, bigint> = {
  [MARKET_A]: 2_700_000_000n,
  [MARKET_B]: 1_700_000_000n,
}

export class FakeReader implements MorphoReader {
  calls: { fn: string; block: bigint }[] = []
  fail = false

  async market(id: Hex, block: bigint): Promise<MarketState> {
    this.calls.push({ fn: 'market', block })
    if (this.fail) throw new Error('upstream RPC exploded with secret-free detail')
    return STATES[id.toLowerCase()]!
  }

  async idToMarketParams(id: Hex, block: bigint): Promise<MarketParams> {
    this.calls.push({ fn: 'idToMarketParams', block })
    return PARAMS[id.toLowerCase()]!
  }

  async borrowRateView(params: MarketParams, _market: MarketState, block: bigint): Promise<bigint> {
    this.calls.push({ fn: 'borrowRateView', block })
    const id = Object.keys(PARAMS).find((k) => PARAMS[k]!.collateralToken === params.collateralToken)!
    return BORROW_RATE[id]!
  }
}

export class FakeFacilitator implements FacilitatorClient {
  calls: string[] = []
  verifyResult: VerifyResponse = { isValid: true }
  settleResult: SettleResponse = {
    success: true,
    transaction: `0x${'ab'.repeat(32)}`,
    network: NETWORK,
  }
  lastVerify?: { payload: PaymentPayload; requirements: PaymentRequirements }

  async getSupported(): Promise<SupportedResponse> {
    this.calls.push('supported')
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} }
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.calls.push('verify')
    this.lastVerify = { payload, requirements }
    return { ...this.verifyResult, payer: this.verifyResult.isValid ? PAY_TO : undefined }
  }

  async settle(): Promise<SettleResponse> {
    this.calls.push('settle')
    return this.settleResult
  }
}

export class MemoryStore implements ReceiptStore {
  map = new Map<string, string>()

  async get(key: string) {
    return this.map.get(key) ?? null
  }

  async put(key: string, value: string) {
    this.map.set(key, value)
  }
}

export function checkDeps(account: LocalAccount, reader: MorphoReader = new FakeReader()): CheckDeps {
  return { reader, getBlockNumber: async () => HEAD, account, chainId: CHAIN_ID, gate: GATE, vault: VAULT }
}

/** Move market A to a 6 USDC target; B takes all that remains. */
export function reallocateData(): Hex {
  return encodeFunctionData({
    abi: vaultAbi,
    functionName: 'reallocate',
    args: [
      [
        { marketParams: PARAMS[MARKET_A]!, assets: 6_000_000n },
        { marketParams: PARAMS[MARKET_B]!, assets: maxUint256 },
      ],
    ],
  })
}

export function checkBody(overrides: Record<string, unknown> = {}) {
  return {
    intent: { vault: VAULT, data: reallocateData(), nonce: '1', notAfterBlock: (HEAD + 50n).toString() },
    action: {
      fn: 'reallocate',
      allocations: [
        { market: MARKET_A, assets: '6000000' },
        { market: MARKET_B, assets: maxUint256.toString() },
      ],
    },
    claims: [
      {
        id: 'r1',
        kind: 'rate',
        sourceSpan: 'B pays a lower but steadier supply APY',
        market: MARKET_B,
        side: 'supply',
        valuePct: 4.9,
        basis: 'APY',
        compounding: 'continuous',
        window: { type: 'instant' },
        tolerancePp: 0.1,
      },
      { id: 'l1', kind: 'liquidity', sourceSpan: null, market: MARKET_A, minWithdrawable: '4000000' },
    ],
    mandateId: 'demo-usdc-v1',
    ...overrides,
  }
}
