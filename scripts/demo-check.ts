/**
 * The first paid check, end to end, in three steps.
 *
 *   node scripts/demo-check.ts seed      [--dry-run]   deployer puts 10 USDC in the vault
 *   node scripts/demo-check.ts check     [--dry-run]   agent states a reason and pays for a verdict
 *   node scripts/demo-check.ts execute   [--dry-run]   agent presents the verdict to the gate
 *   node scripts/demo-check.ts receipt   --save PATH   the live receipt of the last check, verbatim
 *
 * The three demo takes (docs/DEMO.md) add: `check --from B` to move market B to market A,
 * `check --claim-false` for a FAIL, `check --omit liquidity` for a WAIT, `execute --simulate` to
 * eth_call the gate and print its decoded revert without sending, and `execute --owner-sig` to
 * override a WAIT with the gate owner's EIP-712 Override signature.
 *
 * `check --amount USDC` sets how much moves (default 4: each market has a 10 USDC supply cap and
 * holds about 5). Before any payment, `check` eth_calls vault.reallocate from the gate, the vault's
 * allocator, and stops on a revert, decoded by name.
 *
 * Keys are read at run time and never stored, printed or logged: AGENT_KEY from
 * contracts/.env.agent, PRIVATE_KEY and RPC_URL from contracts/.env.deploy. RPC_URL in the process
 * environment takes precedence over the file, so a dry run needs no env file at all. Both files are
 * gitignored and neither key is read in dry-run mode or by --simulate. The verdict is persisted
 * between `check` and `execute` in .demo/, which is gitignored and holds no key.
 *
 * Every read is one request, pinned to a block, never batched (docs/MONAD.md section 8).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  maxUint256,
  parseAbi,
} from 'viem'
import type { Account, Address, Hex, LocalAccount, PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monad } from 'viem/chains'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { vaultAbi } from 'proof-of-reason-engine/action'
import { observeAll, viemMorphoReader } from 'proof-of-reason-engine/morpho'
import type { MarketParams, Observation } from 'proof-of-reason-engine/morpho'
import type { ClaimV0 } from 'proof-of-reason-engine/claims'
import { DOMAIN_NAME, intentTypes, overrideTypes } from 'proof-of-reason-engine/sign'

// ------------------------------------------------------------------ live facts

/** Deployed in Phase 2B. Every address here is on Monad mainnet, chain 143. */
export const CHAIN_ID = 143
export const NETWORK = 'eip155:143' as const
export const VAULT: Address = '0x28900B0B2DDA5d2d61cDF17BE8b7091206a04Bf9'
export const GATE: Address = '0x8fF582f268aB8E2148B548Aa061c5273bC383120'
export const AGENT: Address = '0x876a294aB4D313798EA44fFdCEC37EA741D792AF'
export const VALIDATOR: Address = '0xEC37691732204714DDfd024B67F1B7abfcF3FC9E'
export const MORPHO: Address = '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee'
export const USDC: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
export const API_ORIGIN = 'https://api.proofofreason.com'
export const MANDATE_ID = 'demo-usdc-v1'

const IRM: Address = '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F'

/** docs/MONAD.md section 3. The market id is keccak256(abi.encode(marketParams)). */
export const MARKET_A = {
  id: '0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626' as Hex,
  params: {
    loanToken: USDC,
    collateralToken: '0x7Cd231120a60F500887444a9bAF5e1BD753A5e59',
    oracle: '0x4af4f38164cD7F28653A66aa2255B249a23cFBec',
    irm: IRM,
    lltv: 770_000_000_000_000_000n,
  } satisfies MarketParams,
} as const

export const MARKET_B = {
  id: '0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439' as Hex,
  params: {
    loanToken: USDC,
    collateralToken: '0xa08A69aB9Dd3B04D0992BC7aFb2c0b907bbdc147',
    oracle: '0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2',
    irm: IRM,
    lltv: 915_000_000_000_000_000n,
  } satisfies MarketParams,
} as const

/** The validator checks this many blocks behind the head (worker/src/config.ts). */
export const CHECK_LAG_BLOCKS = 2n
/** 10 USDC, 6 decimals. */
export const SEED_ATOMIC = 10_000_000n
/**
 * 4 USDC by default. The vault caps each market at exactly 10 USDC of supply and holds about 5 in
 * each, so 5 USDC into either market overshoots its cap and MetaMorpho reverts SupplyCapExceeded.
 */
export const DEFAULT_MOVE_ATOMIC = 4_000_000n
/** The vault's supply cap on each of market A and market B, read on chain on 29 Sep 2026. */
export const MARKET_CAP_ATOMIC = 10_000_000n
/** 0.10 USDC per check, the price the Worker charges. */
export const PRICE_ATOMIC = 100_000n
/** --claim-false states the rate this many percentage points above what was observed. */
export const FALSE_RATE_OFFSET_PP = 5
/** Intent lifetime. The verdict's own freshness bound is the gate's maxAgeBlocks, read live. */
export const INTENT_LIFETIME_BLOCKS = 300n
/** Gas limits are estimated, then multiplied by this: Monad charges the limit, not the gas used. */
export const GAS_MARGIN_NUMERATOR = 12n
export const GAS_MARGIN_DENOMINATOR = 10n

/**
 * The deployed gate is v1, ruleset REASON-R0: EIP712("Proof of Reason", "1") at
 * contracts/src/ReasonGate.sol line 72 as committed (last changed in 14ad855, the source deployed in
 * Phase 2B, unchanged at HEAD). The live
 * validator signs under this version too. The engine's gateDomain now names the next gate's
 * version, so the v1 domain is spelled out here and hashed with the engine's own Intent and
 * Override types, which v1 and v2 share.
 */
export const GATE_DOMAIN_VERSION = '1'

export function gateDomainV1(chainId: number = CHAIN_ID, gate: Address = GATE) {
  return { name: DOMAIN_NAME, version: GATE_DOMAIN_VERSION, chainId, verifyingContract: gate } as const
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_DIR = join(repoRoot, '.demo')
const LAST_CHECK = join(DEMO_DIR, 'last-check.json')

// ------------------------------------------------------------------ abis

const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const erc4626Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function totalAssets() view returns (uint256)',
])

const morphoPositionAbi = parseAbi([
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
])

// Gate v1 exactly as deployed at GATE (contracts/src/ReasonGate.sol as committed at HEAD): the verdict
// travels as three flat arguments, and there is no tally, no premise and no previewPremises. The
// errors are listed so a simulated call decodes its revert by name.
export const gateAbi = parseAbi([
  'function execute(bytes data, bytes32 claimsHash, uint256 nonce, uint64 notAfterBlock, uint8 outcome, uint64 checkedAtBlock, bytes32 receiptHash, bytes validatorSig, bytes ownerSig)',
  'function maxAgeBlocks() view returns (uint64)',
  'function usedNonce(uint256 nonce) view returns (bool)',
  'function owner() view returns (address)',
  'error NotAgent(address caller)',
  'error CalldataTooShort(uint256 length)',
  'error SelectorNotAllowed(bytes4 selector)',
  'error NonceUsed(uint256 nonce)',
  'error IntentExpired(uint64 notAfterBlock, uint256 blockNumber)',
  'error InvalidValidatorSignature(address recovered)',
  'error VerdictFromFuture(uint64 checkedAtBlock, uint256 blockNumber)',
  'error VerdictTooOld(uint64 checkedAtBlock, uint256 blockNumber, uint64 maxAgeBlocks)',
  'error Refuted(bytes32 intentHash, bytes32 receiptHash)',
  'error OverrideNotAuthorized(bytes32 intentHash)',
  'error InvalidOutcome(uint8 outcome)',
  'error SelectorBlocked(bytes4 selector)',
])

// ------------------------------------------------------------------ env, read at run time only

/** Parses KEY=value lines. Values are returned, never logged. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export class ConfigError extends Error {
  constructor(message: string) {
    // Names the file and the variable, never the value.
    super(message)
    this.name = 'ConfigError'
  }
}

function readEnv(relativePath: string): Record<string, string> {
  const path = join(repoRoot, relativePath)
  if (!existsSync(path)) throw new ConfigError(`${relativePath} does not exist; see docs/DEMO.md`)
  return parseEnvFile(readFileSync(path, 'utf8'))
}

function requireVar(env: Record<string, string>, name: string, file: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0) throw new ConfigError(`${name} is not set in ${file}`)
  return value
}

function requireKey(env: Record<string, string>, name: string, file: string): Hex {
  const value = requireVar(env, name, file)
  const hex = value.startsWith('0x') ? value : `0x${value}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new ConfigError(`${name} in ${file} is not a 32 byte hex key`)
  return hex as Hex
}

function rpcUrl(): string {
  const fromEnvironment = process.env['RPC_URL']
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment
  return requireVar(readEnv('contracts/.env.deploy'), 'RPC_URL', 'contracts/.env.deploy')
}

// ------------------------------------------------------------------ chain helpers

export function publicClientFor(url: string): PublicClient {
  // One JSON-RPC request per read: the Foundation RPC forbids batch.
  return createPublicClient({ chain: monad, transport: http(url, { batch: false }) })
}

/**
 * Morpho Blue SharesMathLib.toAssetsDown, with the virtual amounts:
 * shares * (totalAssets + 1) / (totalShares + 1e6).
 */
export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + 1n)) / (totalShares + 1_000_000n)
}

/** What the vault has supplied to one market, in loan-token atomic units, at a pinned block. */
export async function marketAssetsOf(
  client: PublicClient,
  marketId: Hex,
  owner: Address,
  block: bigint,
): Promise<bigint> {
  const [supplyShares] = await client.readContract({
    address: MORPHO,
    abi: morphoPositionAbi,
    functionName: 'position',
    args: [marketId, owner],
    blockNumber: block,
  })
  const [totalSupplyAssets, totalSupplyShares] = await client.readContract({
    address: MORPHO,
    abi: morphoPositionAbi,
    functionName: 'market',
    args: [marketId],
    blockNumber: block,
  })
  return toAssetsDown(supplyShares, totalSupplyAssets, totalSupplyShares)
}

export type VaultPositions = { a: bigint; b: bigint; totalAssets: bigint; block: bigint }

export async function vaultPositions(client: PublicClient, block: bigint): Promise<VaultPositions> {
  const a = await marketAssetsOf(client, MARKET_A.id, VAULT, block)
  const b = await marketAssetsOf(client, MARKET_B.id, VAULT, block)
  const totalAssets = await client.readContract({
    address: VAULT,
    abi: erc4626Abi,
    functionName: 'totalAssets',
    blockNumber: block,
  })
  return { a, b, totalAssets, block }
}

export const usdc = (atomic: bigint): string => `${(Number(atomic) / 1e6).toFixed(6)} USDC`

/** '4' is 4_000_000n. At most six decimals, more than zero; anything else is refused, not rounded. */
export function parseUsdc(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text)
  if (match === null) throw new ConfigError(`--amount takes a USDC amount with at most 6 decimals, not ${text}`)
  const atomic = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))
  if (atomic === 0n) throw new ConfigError('--amount must be more than 0')
  return atomic
}

/** How claim text names an amount: 4 USDC, 4.5 USDC. */
export function usdcShort(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac.length > 0 ? `${whole}.${frac} USDC` : `${whole} USDC`
}

function withMargin(estimate: bigint): bigint {
  return (estimate * GAS_MARGIN_NUMERATOR) / GAS_MARGIN_DENOMINATOR
}

// ------------------------------------------------------------------ the intent

/** Which market the money leaves. The other market is where it goes and what the claims are about. */
export type Side = 'A' | 'B'

const MARKETS = { A: MARKET_A, B: MARKET_B } as const
const other = (side: Side): Side => (side === 'A' ? 'B' : 'A')

/**
 * MetaMorpho V1.1 reallocate takes a target supply per market, so moving assets is one withdrawal
 * and one supply: the source market is set to its current assets minus the amount, and the
 * destination takes everything left with maxUint256, which is the vault's own idiom for "supply the
 * remainder". The source defaults to market A. Struct shapes come from the pinned ABI the engine
 * and the gate already agree on (engine/src/action.ts vaultAbi, generated from
 * contracts/lib/metamorpho-v1.1).
 */
export function buildReallocateData(args: {
  fromCurrentAssets: bigint
  moveAtomic: bigint
  from?: Side
}): { data: Hex; fromTarget: bigint } {
  const from = args.from ?? 'A'
  if (args.moveAtomic <= 0n) throw new Error('nothing to move')
  if (args.fromCurrentAssets < args.moveAtomic) {
    throw new Error(
      `market ${from} holds ${usdc(args.fromCurrentAssets)}, less than the ${usdc(args.moveAtomic)} to move; run seed first`,
    )
  }
  const fromTarget = args.fromCurrentAssets - args.moveAtomic
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'reallocate',
    args: [
      [
        { marketParams: MARKETS[from].params, assets: fromTarget },
        { marketParams: MARKETS[other(from)].params, assets: maxUint256 },
      ],
    ],
  })
  return { data, fromTarget }
}

export type ActionV0Reallocate = {
  fn: 'reallocate'
  allocations: { market: string; assets: string }[]
}

export function buildAction(fromTarget: bigint, from: Side = 'A'): ActionV0Reallocate {
  return {
    fn: 'reallocate',
    allocations: [
      { market: MARKETS[from].id, assets: fromTarget.toString() },
      { market: MARKETS[other(from)].id, assets: maxUint256.toString() },
    ],
  }
}

// ------------------------------------------------------------------ the claims

/**
 * Provisional claims, used only to read the chain. The values are replaced by what was read. They
 * are about the destination market: it pays more, and it can give the money back.
 */
export function probeClaims(to: Side = 'B', moveAtomic: bigint = DEFAULT_MOVE_ATOMIC): ClaimV0[] {
  const market = MARKETS[to].id
  return [
    {
      id: 'r1',
      kind: 'rate',
      sourceSpan: `market ${to} pays more to supply than market ${other(to)}`,
      market,
      side: 'supply',
      valuePct: 0,
      basis: 'APY',
      compounding: 'continuous',
      window: { type: 'instant' },
      tolerancePp: 0.1,
    },
    {
      id: 'l1',
      kind: 'liquidity',
      sourceSpan: `market ${to} can return the ${usdcShort(moveAtomic)} on demand`,
      market,
      minWithdrawable: '0',
    },
  ]
}

/**
 * The two ways the demo gets a claim wrong on purpose.
 *
 * claimFalse states the rate FALSE_RATE_OFFSET_PP above what was observed. A rate claim is TRUE
 * when |observed - claimed| <= tolerancePp + slack (engine/src/compare.ts line 45), so 5 points
 * against a 0.1 point tolerance is FALSE, and any FALSE gives FAIL (engine/src/verdict.ts lines
 * 62 and 63).
 *
 * omit drops the liquidity claim. demo-usdc-v1 requires rate and liquidity; a required kind with
 * no claim is a missing kind (engine/src/verdict.ts line 43), which gives WAIT (lines 64 and 65).
 */
export type ClaimOptions = { to?: Side; moveAtomic?: bigint; claimFalse?: boolean; omit?: 'liquidity' }

/**
 * States the claims from what was read, inside the tolerance the claim itself declares, unless
 * ClaimOptions says otherwise.
 *
 * A rate claim is TRUE when |observed - claimed| is at most tolerancePp, so the rate is stated to
 * four decimal places of what the median of the guard window showed. A liquidity claim is a floor,
 * checked against the minimum over the window, so it is stated at 90 percent of that minimum: a
 * claim the market can still honour if liquidity dips, which is the point of claiming a floor
 * rather than a number.
 */
export function phraseClaims(observations: readonly Observation[], options: ClaimOptions = {}): ClaimV0[] {
  const [rate, liquidity] = observations
  if (rate?.kind !== 'rate') throw new Error('expected a rate observation first')
  if (liquidity?.kind !== 'liquidity') throw new Error('expected a liquidity observation second')
  if (rate.valuePct === null) throw new Error(`rate is unverifiable: ${rate.unverifiable ?? 'no value'}`)
  const [probeRate, probeLiquidity] = probeClaims(options.to, options.moveAtomic) as [
    Extract<ClaimV0, { kind: 'rate' }>,
    Extract<ClaimV0, { kind: 'liquidity' }>,
  ]
  const statedPct = options.claimFalse === true ? rate.valuePct + FALSE_RATE_OFFSET_PP : rate.valuePct
  const rateClaim: ClaimV0 = { ...probeRate, valuePct: Number(statedPct.toFixed(4)) }
  if (options.omit === 'liquidity') return [rateClaim]
  if (liquidity.withdrawable === null) {
    throw new Error(`liquidity is unverifiable: ${liquidity.unverifiable ?? 'no value'}`)
  }
  return [rateClaim, { ...probeLiquidity, minWithdrawable: ((liquidity.withdrawable * 9n) / 10n).toString() }]
}

export type CheckBody = {
  intent: { vault: Address; data: Hex; nonce: string; notAfterBlock: string }
  action: ActionV0Reallocate
  claims: ClaimV0[]
  mandateId: string
}

/** Reads the chain for a set of probe claims at a pinned block. Live, observeAll over Morpho. */
export type Observe = (claims: ClaimV0[], block: bigint) => Promise<Observation[]>

/** Reads first, then states the claims from what was read, then binds them to the intent. */
export async function buildCheckBody(args: {
  observe: Observe
  fromCurrentAssets: bigint
  head: bigint
  pinned: bigint
  nonce: bigint
  from?: Side
  moveAtomic?: bigint
  claimFalse?: boolean
  omit?: 'liquidity'
}): Promise<{ body: CheckBody; fromTarget: bigint; observations: Observation[] }> {
  const from = args.from ?? 'A'
  const to = other(from)
  const moveAtomic = args.moveAtomic ?? DEFAULT_MOVE_ATOMIC
  const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: args.fromCurrentAssets, moveAtomic, from })
  const observations = await args.observe(probeClaims(to, moveAtomic), args.pinned)
  const claims = phraseClaims(observations, {
    to,
    moveAtomic,
    ...(args.claimFalse === true ? { claimFalse: true } : {}),
    ...(args.omit !== undefined ? { omit: args.omit } : {}),
  })
  const body: CheckBody = {
    intent: {
      vault: VAULT,
      data,
      nonce: args.nonce.toString(),
      notAfterBlock: (args.head + INTENT_LIFETIME_BLOCKS).toString(),
    },
    action: buildAction(fromTarget, from),
    claims,
    mandateId: MANDATE_ID,
  }
  return { body, fromTarget, observations }
}

// ------------------------------------------------------------------ preflight

/**
 * MetaMorpho V1.1 errors a reallocate can revert with (contracts/lib/metamorpho-v1.1/src/libraries/
 * ErrorsLib.sol). The liquidity error is NotEnoughLiquidity(), line 70; Morpho Blue's own
 * "insufficient liquidity" arrives as Error(string), which decodes without an entry here.
 */
export const metaMorphoErrorsAbi = parseAbi([
  'error SupplyCapExceeded(bytes32 id)',
  'error AllCapsReached()',
  'error InconsistentReallocation()',
  'error MarketNotEnabled(bytes32 id)',
  'error NotEnoughLiquidity()',
  'error UnauthorizedMarket(bytes32 id)',
  'error NotAllocatorRole()',
])

/** A market id as the demo names it: A or B, with the id, or the id alone if it is neither. */
export function labelMarket(id: unknown): string {
  if (typeof id !== 'string') return String(id)
  if (id.toLowerCase() === MARKET_A.id) return `market A ${id}`
  if (id.toLowerCase() === MARKET_B.id) return `market B ${id}`
  return id
}

/** The revert data under any viem error, or null when the error carries none. */
function revertDataOf(error: unknown): Hex | null {
  const found = error instanceof BaseError
    ? error.walk((e) => typeof (e as { data?: unknown }).data === 'string')
    : typeof (error as { data?: unknown })?.data === 'string' ? error : null
  const data = (found as { data?: unknown } | null)?.data
  return typeof data === 'string' && data.startsWith('0x') ? (data as Hex) : null
}

/** Names a revert: known errors with their arguments, markets labelled A or B; else the raw selector. */
export function describeRevert(data: Hex): string {
  if (data.length < 10) return `a revert with no error data (${data})`
  try {
    const decoded = decodeErrorResult({ abi: metaMorphoErrorsAbi, data })
    const args = (decoded.args ?? []).map(labelMarket)
    return `${decoded.errorName}(${args.join(', ')})`
  } catch {
    return `an unknown error, selector ${data.slice(0, 10)}`
  }
}

export type PreflightResult = { ok: true } | { ok: false; reason: string }

/**
 * The free question asked before paying: would the vault take this reallocate from the gate right
 * now? The gate is the vault's allocator, so an eth_call from the gate's address runs the exact
 * checks MetaMorpho runs when the gate forwards the call: caps, enabled markets, liquidity.
 */
export async function preflightReallocate(
  client: Pick<PublicClient, 'call'>,
  data: Hex,
  vault: Address = VAULT,
  gate: Address = GATE,
): Promise<PreflightResult> {
  try {
    await client.call({ account: gate, to: vault, data })
    return { ok: true }
  } catch (error) {
    const revert = revertDataOf(error)
    if (revert === null) throw error
    return { ok: false, reason: describeRevert(revert) }
  }
}

// ------------------------------------------------------------------ x402

export type SignedTally = {
  falseCount: number
  unverifiableCount: number
  missingCount: number
  mismatchCount: number
  violationCount: number
}

/** As served: bigints are decimal strings. */
export type SignedPremise = { subject: Hex; kind: number; lo: string; hi: string }

export type SignedVerdict = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  intentHash: Hex
  claimsHash: Hex
  outcome: 1 | 2 | 3
  checkedAtBlock: string
  receiptHash: Hex
  /** Served by a REASON-R1 (v2) validator only. The live v1 validator signs neither. */
  tally?: SignedTally
  premisesHash?: Hex
  premises?: SignedPremise[]
  validator: Address
  signature: Hex
}

export function premiseArgs(premises: SignedPremise[]) {
  return premises.map((p) => ({ subject: p.subject, kind: p.kind, lo: BigInt(p.lo), hi: BigInt(p.hi) }))
}

export type CheckResponse = {
  mandateId: string
  verdict: { outcome: 'PASS' | 'WAIT' | 'FAIL'; failing: unknown[]; missingKinds: string[] }
  signed: SignedVerdict
  receipt: { registry?: { tx?: string; error?: string; response?: number }; [key: string]: unknown }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Pays for one check over x402 v2, exact scheme, EIP-3009 on USDC. The 402 challenge carries the
 * requirements: network, asset, amount, payTo and the USDC EIP-712 domain. The agent key signs the
 * transfer authorization, and only that: no transaction is sent by this process.
 */
export async function payAndCheck(args: {
  origin: string
  body: CheckBody
  signer: Account
  fetchImpl?: FetchLike
  onChallenge?: (accepts: unknown) => void
}): Promise<{ status: number; body: CheckResponse | { error: string }; paid: boolean }> {
  const doFetch = args.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = `${args.origin}/check`
  const payload = JSON.stringify(args.body)
  const headers = { 'content-type': 'application/json' }

  const challenge = await doFetch(url, { method: 'POST', body: payload, headers })
  if (challenge.status !== 402) {
    return { status: challenge.status, body: (await challenge.json()) as CheckResponse, paid: false }
  }

  const client = new x402Client()
  registerExactEvmScheme(client, { signer: args.signer as never, networks: [NETWORK] })
  const http402 = new x402HTTPClient(client)
  const required = http402.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json())
  args.onChallenge?.(required.accepts)
  const payment = await http402.createPaymentPayload(required)

  const paid = await doFetch(url, {
    method: 'POST',
    body: payload,
    headers: { ...headers, ...http402.encodePaymentSignatureHeader(payment) },
  })
  return { status: paid.status, body: (await paid.json()) as CheckResponse, paid: true }
}

// ------------------------------------------------------------------ persistence

export type SavedCheck = {
  savedAt: string
  mandateId: string
  outcome: 'PASS' | 'WAIT' | 'FAIL'
  intent: { vault: Address; data: Hex; nonce: string; notAfterBlock: string }
  signed: SignedVerdict
  receiptUrl: string
  registryTx: string | null
}

export function saveCheck(saved: SavedCheck, path: string = LAST_CHECK): void {
  mkdirSync(dirname(path), { recursive: true })
  // No key, no payment authorization: the intent, the verdict, and where the receipt lives.
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`)
}

export function loadCheck(path: string = LAST_CHECK): SavedCheck {
  if (!existsSync(path)) throw new ConfigError('no saved check: run `node scripts/demo-check.ts check` first')
  return JSON.parse(readFileSync(path, 'utf8')) as SavedCheck
}

export function intentHashOf(saved: SavedCheck, gate: Address = GATE, chainId = CHAIN_ID): Hex {
  return hashTypedData({
    domain: gateDomainV1(chainId, gate),
    types: intentTypes,
    primaryType: 'Intent',
    message: {
      vault: saved.intent.vault,
      dataHash: keccak256(saved.intent.data),
      claimsHash: saved.signed.claimsHash,
      nonce: BigInt(saved.intent.nonce),
      notAfterBlock: BigInt(saved.intent.notAfterBlock),
    },
  })
}

/** The verdict must be over exactly the intent that is about to be presented, for the v1 gate. */
export function verdictMatchesIntent(saved: SavedCheck, gate: Address = GATE, chainId = CHAIN_ID): string | null {
  if (intentHashOf(saved, gate, chainId).toLowerCase() !== saved.signed.intentHash.toLowerCase()) {
    return 'the saved verdict is not over the saved intent'
  }
  if (saved.signed.validator.toLowerCase() !== VALIDATOR.toLowerCase()) {
    return `the verdict was signed by ${saved.signed.validator}, not the validator the gate names`
  }
  if (
    saved.signed.domain.chainId !== chainId ||
    saved.signed.domain.verifyingContract.toLowerCase() !== gate.toLowerCase()
  ) {
    return 'the verdict is for another gate or another chain'
  }
  if (saved.signed.domain.version !== GATE_DOMAIN_VERSION) {
    return `the verdict was signed under domain version ${saved.signed.domain.version}; the deployed gate is version ${GATE_DOMAIN_VERSION}`
  }
  return null
}

/**
 * The gate owner's consent to execute a WAIT: EIP-712 Override(bytes32 intentHash) under the v1
 * domain. The gate checks it against owner() (contracts/src/ReasonGate.sol lines 193 and 194 at
 * HEAD, the deployed source).
 */
export async function signOverride(owner: LocalAccount, intentHash: Hex, gate: Address = GATE): Promise<Hex> {
  return owner.signTypedData({
    domain: gateDomainV1(CHAIN_ID, gate),
    types: overrideTypes,
    primaryType: 'Override',
    message: { intentHash },
  })
}

/** The nine arguments of the v1 gate's execute, in order. ownerSig is '0x' unless a WAIT is overridden. */
export function executeArgs(saved: SavedCheck, ownerSig: Hex = '0x') {
  return [
    saved.intent.data,
    saved.signed.claimsHash,
    BigInt(saved.intent.nonce),
    BigInt(saved.intent.notAfterBlock),
    saved.signed.outcome,
    BigInt(saved.signed.checkedAtBlock),
    saved.signed.receiptHash,
    saved.signed.signature,
    ownerSig,
  ] as const
}

export type SimulateResult = { reverted: false } | { reverted: true; errorName: string; args: readonly unknown[]; text: string }

/**
 * eth_call of execute from the agent address, so the gate runs every check it would run for real.
 * Nothing is signed and nothing is sent. A revert is decoded by name from the v1 gate's errors.
 */
export async function simulateExecute(
  client: Pick<PublicClient, 'simulateContract'>,
  saved: SavedCheck,
  ownerSig: Hex = '0x',
  gate: Address = GATE,
): Promise<SimulateResult> {
  try {
    await client.simulateContract({
      address: gate,
      abi: gateAbi,
      functionName: 'execute',
      args: executeArgs(saved, ownerSig),
      account: AGENT,
    })
    return { reverted: false }
  } catch (error) {
    const reverted =
      error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName !== undefined) {
      const args = reverted.data.args ?? []
      const text = `${reverted.data.errorName}(${args.map((a) => String(a)).join(', ')})`
      return { reverted: true, errorName: reverted.data.errorName, args, text }
    }
    throw error
  }
}

// ------------------------------------------------------------------ the receipt

/**
 * The receipt as the live API serves it, byte for byte. Nothing is parsed, re-serialized or built
 * here: the file on disk is what anyone can fetch from the same URL.
 */
export async function fetchReceipt(args: {
  origin?: string
  intentHash: Hex
  fetchImpl?: FetchLike
}): Promise<{ url: string; bytes: Uint8Array }> {
  const doFetch = args.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = `${args.origin ?? API_ORIGIN}/receipts/${args.intentHash}`
  const response = await doFetch(url)
  if (response.status !== 200) throw new Error(`GET ${url} answered ${response.status}`)
  return { url, bytes: new Uint8Array(await response.arrayBuffer()) }
}

export function writeReceipt(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

// ------------------------------------------------------------------ commands

type Options = { dryRun: boolean }

export type CheckOptions = Options & { from: Side; amount: bigint; claimFalse: boolean; omit?: 'liquidity' }

/** What check talks to. Live by default; the tests pass a mocked chain, observer and payment. */
export type CheckDeps = {
  client: PublicClient
  observe: Observe
  loadAgent: () => Account
  pay: (body: CheckBody, signer: Account) => ReturnType<typeof payAndCheck>
  now: () => bigint
}

function liveCheckDeps(): CheckDeps {
  const client = publicClientFor(rpcUrl())
  const reader = viemMorphoReader(client, MORPHO)
  return {
    client,
    observe: (claims, block) => observeAll(reader, claims, block),
    loadAgent: () => {
      const agent = privateKeyToAccount(requireKey(readEnv('contracts/.env.agent'), 'AGENT_KEY', 'contracts/.env.agent'))
      if (agent.address.toLowerCase() !== AGENT.toLowerCase()) {
        throw new ConfigError(`AGENT_KEY is ${agent.address}, but the gate names ${AGENT}`)
      }
      return agent
    },
    pay: (body, signer) =>
      payAndCheck({
        origin: API_ORIGIN,
        body,
        signer,
        onChallenge: (accepts) => line(`402 challenge: ${JSON.stringify(accepts)}`),
      }),
    now: () => BigInt(Date.now()),
  }
}
export type ExecuteOptions = Options & { ownerSig: boolean; simulate: boolean }

export async function seed(options: Options): Promise<void> {
  const client = publicClientFor(rpcUrl())
  const head = await client.getBlockNumber()
  const pinned = head - CHECK_LAG_BLOCKS

  if (options.dryRun) {
    const positions = await vaultPositions(client, pinned)
    line('dry run: nothing signed, nothing sent')
    line(`vault totalAssets at block ${pinned}: ${usdc(positions.totalAssets)}`)
    line(`would approve ${usdc(SEED_ATOMIC)} of USDC to the vault, then deposit it`)
    line('the vault supply queue routes the deposit; markets A and B both have a cap')
    return
  }

  const env = readEnv('contracts/.env.deploy')
  const deployer = privateKeyToAccount(requireKey(env, 'PRIVATE_KEY', 'contracts/.env.deploy'))
  const wallet = createWalletClient({
    account: deployer,
    chain: monad,
    transport: http(requireVar(env, 'RPC_URL', 'contracts/.env.deploy'), { batch: false }),
  })
  line(`deployer ${deployer.address}`)

  const shares = await client.readContract({
    address: VAULT,
    abi: erc4626Abi,
    functionName: 'balanceOf',
    args: [deployer.address],
  })
  if (shares > 0n) {
    line(`already seeded: the deployer holds ${shares} vault shares. Nothing to do.`)
    const positions = await vaultPositions(client, pinned)
    printPositions('vault', positions)
    return
  }

  const balance = await client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [deployer.address],
  })
  if (balance < SEED_ATOMIC) {
    throw new ConfigError(`deployer holds ${usdc(balance)}, needs ${usdc(SEED_ATOMIC)}`)
  }

  const allowance = await client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [deployer.address, VAULT],
  })
  if (allowance < SEED_ATOMIC) {
    const estimate = await client.estimateContractGas({
      address: USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [VAULT, SEED_ATOMIC],
      account: deployer,
    })
    const gas = withMargin(estimate)
    line(`approve: estimate ${estimate}, sending with gas ${gas}`)
    const hash = await wallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [VAULT, SEED_ATOMIC],
      gas,
    })
    line(`approve tx ${hash}`)
    const receipt = await client.waitForTransactionReceipt({ hash })
    line(`approve status ${receipt.status}`)
  } else {
    line(`allowance already ${usdc(allowance)}: no approve needed`)
  }

  const depositEstimate = await client.estimateContractGas({
    address: VAULT,
    abi: erc4626Abi,
    functionName: 'deposit',
    args: [SEED_ATOMIC, deployer.address],
    account: deployer,
  })
  const depositGas = withMargin(depositEstimate)
  line(`deposit: estimate ${depositEstimate}, sending with gas ${depositGas}`)
  const depositHash = await wallet.writeContract({
    address: VAULT,
    abi: erc4626Abi,
    functionName: 'deposit',
    args: [SEED_ATOMIC, deployer.address],
    gas: depositGas,
  })
  line(`deposit tx ${depositHash}`)
  const depositReceipt = await client.waitForTransactionReceipt({ hash: depositHash })
  line(`deposit status ${depositReceipt.status} in block ${depositReceipt.blockNumber}`)

  printPositions('vault after seed', await vaultPositions(client, depositReceipt.blockNumber))
}

export async function check(options: CheckOptions, deps: CheckDeps = liveCheckDeps()): Promise<void> {
  const client = deps.client
  const head = await client.getBlockNumber()
  const pinned = head - CHECK_LAG_BLOCKS
  line(`head ${head}, reading at ${pinned}`)

  const from = options.from
  const to = from === 'A' ? 'B' : 'A'
  const currentFrom = await marketAssetsOf(client, MARKETS[from].id, VAULT, pinned)
  printPositions('vault now', await vaultPositions(client, pinned))

  // Read the chain first, then state the claims from what was read.
  const { body, fromTarget, observations } = await buildCheckBody({
    observe: deps.observe,
    fromCurrentAssets: currentFrom,
    head,
    pinned,
    nonce: deps.now(),
    from,
    moveAtomic: options.amount,
    claimFalse: options.claimFalse,
    ...(options.omit !== undefined ? { omit: options.omit } : {}),
  })
  line(`moving ${usdc(options.amount)} from market ${from} to market ${to}, so market ${from} targets ${usdc(fromTarget)}`)
  const observedRate = observations[0]?.kind === 'rate' ? observations[0].valuePct : null
  for (const claim of body.claims) {
    if (claim.kind === 'rate') {
      const note = options.claimFalse ? `, FALSE on purpose: observed ${observedRate?.toFixed(4)}, stated ${FALSE_RATE_OFFSET_PP} pp above` : ''
      line(`claim: market ${to} supply APY is ${claim.valuePct} percent, within ${claim.tolerancePp} pp${note}`)
    } else if (claim.kind === 'liquidity') {
      line(`claim: market ${to} can return at least ${usdc(BigInt(claim.minWithdrawable))}`)
    }
  }
  if (options.omit === 'liquidity') {
    line(`claim omitted on purpose: liquidity, which ${MANDATE_ID} requires`)
  }

  // Free, and before any payment: would the vault take this call from the gate right now?
  const preflight = await preflightReallocate(client, body.intent.data)
  if (!preflight.ok) {
    throw new Error(
      `preflight: the vault would revert ${preflight.reason} when the gate forwards this reallocate. No payment made.`,
    )
  }
  line(`preflight: the vault accepts this reallocate from the gate ${GATE} (eth_call, free)`)

  if (options.dryRun) {
    line('dry run: nothing signed, nothing sent, no payment made')
    line(JSON.stringify(body, null, 2))
    return
  }

  const agent = deps.loadAgent()
  line(`agent ${agent.address}, paying ${usdc(PRICE_ATOMIC)} for one check`)

  const result = await deps.pay(body, agent)
  if (result.status !== 200) {
    throw new Error(`POST /check answered ${result.status}: ${JSON.stringify(result.body)}`)
  }
  const response = result.body as CheckResponse

  line('')
  line(`verdict ${response.verdict.outcome} (outcome code ${response.signed.outcome})`)
  if (response.verdict.failing.length > 0) line(`failing: ${JSON.stringify(response.verdict.failing)}`)
  if (response.verdict.missingKinds.length > 0) line(`missing kinds: ${response.verdict.missingKinds.join(', ')}`)
  line(`checked at block ${response.signed.checkedAtBlock}`)
  line(`receipt hash ${response.signed.receiptHash}`)
  const registry = response.receipt.registry
  if (registry?.response !== undefined) line(`registry response ${registry.response}`)
  if (registry?.tx !== undefined) line(`registry tx ${registry.tx}`)
  else line(`registry not written: ${registry?.error ?? 'no registry record in the receipt'}`)
  const receiptUrl = `${API_ORIGIN}/receipts/${response.signed.intentHash}`
  line(`receipt ${receiptUrl}`)

  const maxAge = await client.readContract({ address: GATE, abi: gateAbi, functionName: 'maxAgeBlocks' })
  const gateLines = verdictWindowLines(response.verdict.outcome, BigInt(response.signed.checkedAtBlock), BigInt(maxAge))
  line(gateLines.gate)

  saveCheck({
    savedAt: new Date().toISOString(),
    mandateId: response.mandateId,
    outcome: response.verdict.outcome,
    intent: body.intent,
    signed: response.signed,
    receiptUrl,
    registryTx: registry?.tx ?? null,
  })
  line(gateLines.saved)
}

/** What check prints about the gate once the verdict is in. A FAIL is refused whatever the block. */
export function verdictWindowLines(
  outcome: SavedCheck['outcome'],
  checkedAtBlock: bigint,
  maxAge: bigint,
): { gate: string; saved: string } {
  if (outcome === 'FAIL') {
    return { gate: 'the gate will refuse this verdict', saved: 'saved to .demo/last-check.json.' }
  }
  return {
    gate: `the gate accepts this verdict until block ${checkedAtBlock + maxAge}, ${maxAge} blocks after the check`,
    saved: `saved to .demo/last-check.json. Run execute now: the window is ${maxAge} blocks.`,
  }
}

/** Which verdicts execute will present, and with which flag. Returns the refusal, or null. */
export function executeRefusal(outcome: SavedCheck['outcome'], options: Pick<ExecuteOptions, 'ownerSig' | 'simulate'>): string | null {
  if (options.simulate) return null
  if (outcome === 'FAIL') {
    return 'the verdict is FAIL: the gate would revert Refuted. Nothing to execute. Add --simulate to see the revert without sending.'
  }
  if (outcome === 'WAIT' && !options.ownerSig) {
    return 'the verdict is WAIT: the gate needs the owner signature over the intent hash. Add --owner-sig to override as the gate owner.'
  }
  if (outcome === 'PASS' && options.ownerSig) {
    return 'the verdict is PASS: the gate needs no owner signature. Run execute without --owner-sig.'
  }
  return null
}

/** The gate owner's key, from contracts/.env.deploy, checked against owner() read live. Never printed. */
async function ownerOverride(client: PublicClient, intentHash: Hex): Promise<Hex> {
  const owner = privateKeyToAccount(requireKey(readEnv('contracts/.env.deploy'), 'PRIVATE_KEY', 'contracts/.env.deploy'))
  const gateOwner = await client.readContract({ address: GATE, abi: gateAbi, functionName: 'owner' })
  if (owner.address.toLowerCase() !== gateOwner.toLowerCase()) {
    throw new ConfigError(`PRIVATE_KEY in contracts/.env.deploy is ${owner.address}, but the gate owner is ${gateOwner}`)
  }
  const signature = await signOverride(owner, intentHash)
  line(`owner ${owner.address} signs Override(${intentHash})`)
  return signature
}

export async function execute(options: ExecuteOptions): Promise<void> {
  const saved = loadCheck()
  const client = publicClientFor(rpcUrl())

  const mismatch = verdictMatchesIntent(saved)
  if (mismatch !== null) throw new Error(mismatch)
  line(`saved verdict ${saved.outcome} for intent ${saved.signed.intentHash}`)

  const refusal = executeRefusal(saved.outcome, options)
  if (refusal !== null) throw new Error(refusal)

  const head = await client.getBlockNumber()
  const maxAge = await client.readContract({ address: GATE, abi: gateAbi, functionName: 'maxAgeBlocks' })
  const checkedAt = BigInt(saved.signed.checkedAtBlock)
  const age = head - checkedAt
  const stale = age > BigInt(maxAge)
  if (stale && !options.simulate) {
    throw new Error(
      `the verdict is ${age} blocks old and the gate accepts ${maxAge}. Run check again, then execute straight after.`,
    )
  }
  line(`verdict is ${age} blocks old, ${stale ? 'OUTSIDE' : 'inside'} the ${maxAge} block bound`)
  if (!options.simulate) {
    if (BigInt(saved.intent.notAfterBlock) < head) {
      throw new Error(`the intent expired at block ${saved.intent.notAfterBlock}, the head is ${head}`)
    }
    const used = await client.readContract({
      address: GATE,
      abi: gateAbi,
      functionName: 'usedNonce',
      args: [BigInt(saved.intent.nonce)],
    })
    if (used) throw new Error(`nonce ${saved.intent.nonce} is already used. Run check again.`)
  }

  const before = await vaultPositions(client, head)
  printPositions('before', before)

  if (options.dryRun) {
    line('dry run: nothing signed, nothing sent')
    line(`would call ${GATE}.execute with nonce ${saved.intent.nonce}, outcome ${saved.signed.outcome}${options.ownerSig ? ', with an owner override' : ''}`)
    line(`calldata length ${(saved.intent.data.length - 2) / 2} bytes, validator signature ${saved.signed.signature.slice(0, 12)}...`)
    return
  }

  const ownerSig: Hex = options.ownerSig ? await ownerOverride(client, saved.signed.intentHash) : '0x'

  if (options.simulate) {
    line(`simulating ${GATE}.execute as the agent ${AGENT}: eth_call, nothing signed by the agent, nothing sent`)
    const result = await simulateExecute(client, saved, ownerSig)
    if (result.reverted) line(`the gate reverts: ${result.text}`)
    else line('the gate would accept this call. Nothing was sent.')
    return
  }

  const agentKey = requireKey(readEnv('contracts/.env.agent'), 'AGENT_KEY', 'contracts/.env.agent')
  const agent = privateKeyToAccount(agentKey)
  const wallet = createWalletClient({ account: agent, chain: monad, transport: http(rpcUrl(), { batch: false }) })
  const args = executeArgs(saved, ownerSig)

  const estimate = await client.estimateContractGas({
    address: GATE,
    abi: gateAbi,
    functionName: 'execute',
    args,
    account: agent,
  })
  const gas = withMargin(estimate)
  line(`execute: estimate ${estimate}, sending with gas ${gas}`)
  const hash = await wallet.writeContract({
    address: GATE,
    abi: gateAbi,
    functionName: 'execute',
    args,
    gas,
  })
  line(`execute tx ${hash}`)
  const receipt = await client.waitForTransactionReceipt({ hash })
  line(`execute status ${receipt.status} in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`)

  const after = await vaultPositions(client, receipt.blockNumber)
  printPositions('after', after)
  line(`market A moved ${usdc(after.a - before.a)}, market B moved ${usdc(after.b - before.b)}`)
  line(`receipt ${saved.receiptUrl}`)
}

export async function receipt(savePath: string): Promise<void> {
  const saved = loadCheck()
  const { url, bytes } = await fetchReceipt({ intentHash: saved.signed.intentHash })
  const path = resolve(process.cwd(), savePath)
  writeReceipt(path, bytes)
  line(`receipt ${url}`)
  line(`saved ${bytes.length} bytes, verbatim, to ${path}`)
}

// ------------------------------------------------------------------ cli

function line(text: string): void {
  console.log(text)
}

function printPositions(label: string, positions: VaultPositions): void {
  line(
    `${label} at block ${positions.block}: market A ${usdc(positions.a)}, market B ${usdc(positions.b)}, totalAssets ${usdc(positions.totalAssets)}`,
  )
}

const USAGE = `usage: node scripts/demo-check.ts <command> [flags]

  seed                           deployer approves and deposits ${usdc(SEED_ATOMIC)} into the vault, once
  check    [--from A|B]          agent states a reason, pays ${usdc(PRICE_ATOMIC)} over x402, and gets a signed verdict
           [--amount USDC]       how much moves, default ${usdcShort(DEFAULT_MOVE_ATOMIC)}; preflighted against the vault before paying
           [--claim-false]       state the rate ${FALSE_RATE_OFFSET_PP} pp above what was observed: FAIL
           [--omit liquidity]    leave out the liquidity claim the mandate requires: WAIT
  execute  [--owner-sig]         present the saved verdict; with --owner-sig, override a WAIT as the gate owner
           [--simulate]          eth_call execute and print the decoded revert; nothing is sent
  receipt  --save PATH           write the live receipt of the last check to PATH, verbatim

  --dry-run on seed, check or execute reads the chain and prints, signs nothing and sends nothing.

docs/DEMO.md has the order and what a judge sees.`

export type Parsed =
  | { command: 'seed'; options: Options }
  | { command: 'check'; options: CheckOptions }
  | { command: 'execute'; options: ExecuteOptions }
  | { command: 'receipt'; savePath: string }

/** Every flag is known to exactly one command; anything else is refused rather than ignored. */
export function parseArgs(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv
  const flags = new Set<string>()
  const values: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--from' || arg === '--omit' || arg === '--save' || arg === '--amount') {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) throw new ConfigError(`${arg} needs a value`)
      values[arg] = value
      i++
    } else if (arg.startsWith('--')) {
      flags.add(arg)
    } else {
      throw new ConfigError(`unexpected argument ${arg}`)
    }
  }
  const allowed: Record<string, string[]> = {
    seed: ['--dry-run'],
    check: ['--dry-run', '--from', '--amount', '--claim-false', '--omit'],
    execute: ['--dry-run', '--owner-sig', '--simulate'],
    receipt: ['--save'],
  }
  const known = command !== undefined ? allowed[command] : undefined
  if (known === undefined) throw new ConfigError(`unknown command ${command ?? '(none)'}`)
  for (const name of [...flags, ...Object.keys(values)]) {
    if (!known.includes(name)) throw new ConfigError(`${name} is not a flag of ${command}`)
  }
  const dryRun = flags.has('--dry-run')

  if (command === 'seed') return { command, options: { dryRun } }
  if (command === 'check') {
    const from = (values['--from'] ?? 'A').toUpperCase()
    if (from !== 'A' && from !== 'B') throw new ConfigError('--from takes A or B')
    const omit = values['--omit']
    if (omit !== undefined && omit !== 'liquidity') {
      throw new ConfigError('--omit takes liquidity: the rate claim is the one the other takes are about')
    }
    return {
      command,
      options: {
        dryRun,
        from,
        amount: values['--amount'] !== undefined ? parseUsdc(values['--amount']) : DEFAULT_MOVE_ATOMIC,
        claimFalse: flags.has('--claim-false'),
        ...(omit !== undefined ? { omit } : {}),
      },
    }
  }
  if (command === 'execute') {
    return { command, options: { dryRun, ownerSig: flags.has('--owner-sig'), simulate: flags.has('--simulate') } }
  }
  const savePath = values['--save']
  if (savePath === undefined) throw new ConfigError('receipt needs --save PATH')
  return { command: 'receipt', savePath }
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 1
  }
  try {
    if (parsed.command === 'seed') await seed(parsed.options)
    else if (parsed.command === 'check') await check(parsed.options)
    else if (parsed.command === 'execute') await execute(parsed.options)
    else await receipt(parsed.savePath)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`failed: ${message}`)
    return 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('demo-check.ts')
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)))
}
