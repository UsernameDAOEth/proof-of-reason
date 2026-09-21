import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem'
import type { Address, Hex } from 'viem'
import { parseAction } from './claims.ts'
import type { ActionV0 } from './claims.ts'
import { decodeKuruOrder } from './kuru.ts'
import type { MarketParams } from './morpho.ts'

/** Allocator entry points, matching the vault sources pinned in contracts/lib. */
export const vaultAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct MarketAllocation { MarketParams marketParams; uint256 assets; }',
  'function reallocate(MarketAllocation[] allocations)',
  'function allocate(address adapter, bytes data, uint256 assets)',
  'function deallocate(address adapter, bytes data, uint256 assets)',
])

const marketParamsAbi = parseAbiParameters(
  '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
)

export type DecodedLeg = { market: Hex; marketParams: MarketParams; assets: bigint }

export type DecodedAction =
  | { fn: 'reallocate'; allocations: DecodedLeg[] }
  | ({ fn: 'allocate' | 'deallocate'; adapter: Address } & DecodedLeg)

export type ActionMismatch = {
  source: 'action'
  field: string
  claimed: string | number
  observed: string | number
  block: null
}

/** Morpho Blue market id: keccak256(abi.encode(marketParams)). */
export function marketId(params: MarketParams): Hex {
  return keccak256(encodeAbiParameters(marketParamsAbi, [params]))
}

function leg(marketParams: MarketParams, assets: bigint): DecodedLeg {
  return { market: marketId(marketParams), marketParams, assets }
}

/** Decode vault calldata. Throws when the selector is unknown or the bytes are not canonical. */
export function decodeVaultCall(data: Hex): DecodedAction {
  const decoded = decodeFunctionData({ abi: vaultAbi, data })
  const reencoded =
    decoded.functionName === 'reallocate'
      ? encodeFunctionData({ abi: vaultAbi, functionName: 'reallocate', args: decoded.args })
      : encodeFunctionData({ abi: vaultAbi, functionName: decoded.functionName, args: decoded.args })
  if (reencoded.toLowerCase() !== data.toLowerCase()) {
    throw new Error('calldata is not the canonical encoding of its decoded arguments')
  }
  if (decoded.functionName === 'reallocate') {
    const [allocations] = decoded.args
    return {
      fn: 'reallocate',
      allocations: allocations.map((a) => leg(a.marketParams, a.assets)),
    }
  }
  const [adapter, adapterData, assets] = decoded.args
  const [marketParams] = decodeAbiParameters(marketParamsAbi, adapterData)
  if (encodeAbiParameters(marketParamsAbi, [marketParams]).toLowerCase() !== adapterData.toLowerCase()) {
    throw new Error('adapter data is not exactly abi.encode(MarketParams)')
  }
  return { fn: decoded.functionName, adapter, ...leg(marketParams, assets) }
}

function mismatch(field: string, claimed: string | number, observed: string | number): ActionMismatch {
  return { source: 'action', field, claimed, observed, block: null }
}

function compareLeg(
  prefix: string,
  stated: { market: string; assets: string },
  actual: DecodedLeg,
): ActionMismatch[] {
  const out: ActionMismatch[] = []
  if (stated.market.toLowerCase() !== actual.market.toLowerCase()) {
    out.push(mismatch(`${prefix}market`, stated.market.toLowerCase(), actual.market.toLowerCase()))
  }
  if (BigInt(stated.assets) !== actual.assets) {
    out.push(mismatch(`${prefix}assets`, stated.assets, actual.assets.toString()))
  }
  return out
}

export type ActionCheck = { decoded: DecodedAction | null; mismatches: ActionMismatch[] }

/** Compares a stated Kuru order with the batchUpdate calldata the gate would forward. */
function checkKuruOrder(stated: Extract<ActionV0, { fn: 'kuru_order' }>, data: Hex): ActionCheck {
  let order
  try {
    order = decodeKuruOrder(data)
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0]! : String(error)
    return { decoded: null, mismatches: [mismatch('calldata', stated.fn, `undecodable: ${reason}`)] }
  }
  const mismatches: ActionMismatch[] = []
  if (order.side !== stated.side) mismatches.push(mismatch('side', stated.side, order.side))
  if ((order.price ?? 0n) !== BigInt(stated.price)) mismatches.push(mismatch('price', stated.price, (order.price ?? 0n).toString()))
  if ((order.size ?? 0n) !== BigInt(stated.size)) mismatches.push(mismatch('size', stated.size, (order.size ?? 0n).toString()))
  if (order.cancels !== stated.cancels) mismatches.push(mismatch('cancels', stated.cancels, order.cancels))
  if (order.postOnly !== stated.postOnly) {
    mismatches.push(mismatch('postOnly', String(stated.postOnly), String(order.postOnly)))
  }
  return { decoded: null, mismatches }
}

/** Decode the calldata and compare it with the stated action. Any mismatch is a FAIL. */
export function checkAction(statedInput: ActionV0, data: Hex): ActionCheck {
  const stated = parseAction(statedInput)
  if (stated.fn === 'kuru_order') return checkKuruOrder(stated, data)
  let decoded: DecodedAction
  try {
    decoded = decodeVaultCall(data)
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0]! : String(error)
    return { decoded: null, mismatches: [mismatch('calldata', stated.fn, `undecodable: ${reason}`)] }
  }
  if (decoded.fn !== stated.fn) {
    return { decoded, mismatches: [mismatch('fn', stated.fn, decoded.fn)] }
  }
  if (decoded.fn === 'reallocate' && stated.fn === 'reallocate') {
    if (decoded.allocations.length !== stated.allocations.length) {
      return {
        decoded,
        mismatches: [
          mismatch('allocations.length', stated.allocations.length, decoded.allocations.length),
        ],
      }
    }
    const mismatches = decoded.allocations.flatMap((actual, i) =>
      compareLeg(`allocations.${i}.`, stated.allocations[i]!, actual),
    )
    return { decoded, mismatches }
  }
  if (decoded.fn !== 'reallocate' && stated.fn !== 'reallocate') {
    const mismatches: ActionMismatch[] = []
    if (stated.adapter.toLowerCase() !== decoded.adapter.toLowerCase()) {
      mismatches.push(mismatch('adapter', stated.adapter.toLowerCase(), decoded.adapter.toLowerCase()))
    }
    mismatches.push(...compareLeg('', stated, decoded))
    return { decoded, mismatches }
  }
  throw new Error('unreachable')
}

/** Every market the calldata touches. */
export function touchedMarkets(decoded: DecodedAction): Hex[] {
  return decoded.fn === 'reallocate' ? decoded.allocations.map((a) => a.market) : [decoded.market]
}
