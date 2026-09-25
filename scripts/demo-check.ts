/**
 * The first paid check, end to end, in three steps.
 *
 *   node scripts/demo-check.ts seed      [--dry-run]   deployer puts 10 USDC in the vault
 *   node scripts/demo-check.ts check     [--dry-run]   agent states a reason and pays for a verdict
 *   node scripts/demo-check.ts execute   [--dry-run]   agent presents the verdict to the gate
 *
 * Keys are read at run time and never stored, printed or logged: AGENT_KEY from
 * contracts/.env.agent, PRIVATE_KEY and RPC_URL from contracts/.env.deploy. Both files are
 * gitignored and neither is read in dry-run mode. The verdict is persisted between `check` and
 * `execute` in .demo/, which is gitignored and holds no key.
 *
 * Every read is one request, pinned to a block, never batched (docs/MONAD.md section 8).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  maxUint256,
  parseAbi,
} from 'viem'
import type { Account, Address, Hex, PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monad } from 'viem/chains'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { vaultAbi } from 'proof-of-reason-engine/action'
import { observeAll, viemMorphoReader } from 'proof-of-reason-engine/morpho'
import type { MarketParams, Observation } from 'proof-of-reason-engine/morpho'
import type { ClaimV0 } from 'proof-of-reason-engine/claims'
import { gateDomain, hashIntent } from 'proof-of-reason-engine/sign'

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
/** 5 USDC moved from market A to market B. */
export const MOVE_ATOMIC = 5_000_000n
/** 0.10 USDC per check, the price the Worker charges. */
export const PRICE_ATOMIC = 100_000n
/** Intent lifetime. The verdict's own freshness bound is the gate's maxAgeBlocks, read live. */
export const INTENT_LIFETIME_BLOCKS = 300n
/** Gas limits are estimated, then multiplied by this: Monad charges the limit, not the gas used. */
export const GAS_MARGIN_NUMERATOR = 12n
export const GAS_MARGIN_DENOMINATOR = 10n

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

const gateAbi = parseAbi([
  'function execute(bytes data, bytes32 claimsHash, uint256 nonce, uint64 notAfterBlock, uint8 outcome, uint64 checkedAtBlock, bytes32 receiptHash, bytes validatorSig, bytes ownerSig)',
  'function maxAgeBlocks() view returns (uint64)',
  'function usedNonce(uint256 nonce) view returns (bool)',
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

function withMargin(estimate: bigint): bigint {
  return (estimate * GAS_MARGIN_NUMERATOR) / GAS_MARGIN_DENOMINATOR
}

// ------------------------------------------------------------------ the intent

/**
 * MetaMorpho V1.1 reallocate takes a target supply per market, so moving assets is one withdrawal
 * and one supply: market A is set to its current assets minus the amount, and market B takes
 * everything left with maxUint256, which is the vault's own idiom for "supply the remainder".
 * Struct shapes come from the pinned ABI the engine and the gate already agree on
 * (engine/src/action.ts vaultAbi, generated from contracts/lib/metamorpho-v1.1).
 */
export function buildReallocateData(args: {
  fromCurrentAssets: bigint
  moveAtomic: bigint
}): { data: Hex; fromTarget: bigint } {
  if (args.moveAtomic <= 0n) throw new Error('nothing to move')
  if (args.fromCurrentAssets < args.moveAtomic) {
    throw new Error(
      `market A holds ${usdc(args.fromCurrentAssets)}, less than the ${usdc(args.moveAtomic)} to move; run seed first`,
    )
  }
  const fromTarget = args.fromCurrentAssets - args.moveAtomic
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'reallocate',
    args: [
      [
        { marketParams: MARKET_A.params, assets: fromTarget },
        { marketParams: MARKET_B.params, assets: maxUint256 },
      ],
    ],
  })
  return { data, fromTarget }
}

export type ActionV0Reallocate = {
  fn: 'reallocate'
  allocations: { market: string; assets: string }[]
}

export function buildAction(fromTarget: bigint): ActionV0Reallocate {
  return {
    fn: 'reallocate',
    allocations: [
      { market: MARKET_A.id, assets: fromTarget.toString() },
      { market: MARKET_B.id, assets: maxUint256.toString() },
    ],
  }
}

// ------------------------------------------------------------------ the claims

/** Provisional claims, used only to read the chain. The values are replaced by what was read. */
export function probeClaims(): ClaimV0[] {
  return [
    {
      id: 'r1',
      kind: 'rate',
      sourceSpan: 'market B pays more to supply than market A',
      market: MARKET_B.id,
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
      sourceSpan: 'market B can return the 5 USDC on demand',
      market: MARKET_B.id,
      minWithdrawable: '0',
    },
  ]
}

/**
 * States the claims from what was read, inside the tolerance the claim itself declares.
 *
 * A rate claim is TRUE when |observed - claimed| is at most tolerancePp, so the rate is stated to
 * four decimal places of what the median of the guard window showed. A liquidity claim is a floor,
 * checked against the minimum over the window, so it is stated at 90 percent of that minimum: a
 * claim the market can still honour if liquidity dips, which is the point of claiming a floor
 * rather than a number.
 */
export function phraseClaims(observations: readonly Observation[]): ClaimV0[] {
  const [rate, liquidity] = observations
  if (rate?.kind !== 'rate') throw new Error('expected a rate observation first')
  if (liquidity?.kind !== 'liquidity') throw new Error('expected a liquidity observation second')
  if (rate.valuePct === null) throw new Error(`rate is unverifiable: ${rate.unverifiable ?? 'no value'}`)
  if (liquidity.withdrawable === null) {
    throw new Error(`liquidity is unverifiable: ${liquidity.unverifiable ?? 'no value'}`)
  }
  const [probeRate, probeLiquidity] = probeClaims() as [
    Extract<ClaimV0, { kind: 'rate' }>,
    Extract<ClaimV0, { kind: 'liquidity' }>,
  ]
  return [
    { ...probeRate, valuePct: Number(rate.valuePct.toFixed(4)) },
    { ...probeLiquidity, minWithdrawable: ((liquidity.withdrawable * 9n) / 10n).toString() },
  ]
}

export type CheckBody = {
  intent: { vault: Address; data: Hex; nonce: string; notAfterBlock: string }
  action: ActionV0Reallocate
  claims: ClaimV0[]
  mandateId: string
}

// ------------------------------------------------------------------ x402

export type SignedVerdict = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  intentHash: Hex
  claimsHash: Hex
  outcome: 1 | 2 | 3
  checkedAtBlock: string
  receiptHash: Hex
  validator: Address
  signature: Hex
}

export type CheckResponse = {
  mandateId: string
  verdict: { outcome: 'PASS' | 'WAIT' | 'FAIL'; failing: unknown[]; missingKinds: string[] }
  signed: SignedVerdict
  receipt: { registry?: { tx?: string; error?: string }; [key: string]: unknown }
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

/** The verdict must be over exactly the intent that is about to be presented. */
export function verdictMatchesIntent(saved: SavedCheck, gate: Address = GATE, chainId = CHAIN_ID): string | null {
  const domain = gateDomain(chainId, gate)
  const local = hashIntent(domain, {
    vault: saved.intent.vault,
    dataHash: keccak256(saved.intent.data),
    claimsHash: saved.signed.claimsHash,
    nonce: BigInt(saved.intent.nonce),
    notAfterBlock: BigInt(saved.intent.notAfterBlock),
  })
  if (local.toLowerCase() !== saved.signed.intentHash.toLowerCase()) {
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
  return null
}

// ------------------------------------------------------------------ commands

type Options = { dryRun: boolean }

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

export async function check(options: Options): Promise<void> {
  const client = publicClientFor(rpcUrl())
  const head = await client.getBlockNumber()
  const pinned = head - CHECK_LAG_BLOCKS
  line(`head ${head}, reading at ${pinned}`)

  const currentA = await marketAssetsOf(client, MARKET_A.id, VAULT, pinned)
  printPositions('vault now', await vaultPositions(client, pinned))
  const { data, fromTarget } = buildReallocateData({ fromCurrentAssets: currentA, moveAtomic: MOVE_ATOMIC })
  line(`moving ${usdc(MOVE_ATOMIC)} from market A to market B, so market A targets ${usdc(fromTarget)}`)

  // Read the chain first, then state the claims from what was read.
  const reader = viemMorphoReader(client, MORPHO)
  const observations = await observeAll(reader, probeClaims(), pinned)
  const claims = phraseClaims(observations)
  const rate = claims[0] as Extract<ClaimV0, { kind: 'rate' }>
  const liquidity = claims[1] as Extract<ClaimV0, { kind: 'liquidity' }>
  line(`claim: market B supply APY is ${rate.valuePct} percent, within ${rate.tolerancePp} pp`)
  line(`claim: market B can return at least ${usdc(BigInt(liquidity.minWithdrawable))}`)

  const nonce = BigInt(Date.now())
  const body: CheckBody = {
    intent: {
      vault: VAULT,
      data,
      nonce: nonce.toString(),
      notAfterBlock: (head + INTENT_LIFETIME_BLOCKS).toString(),
    },
    action: buildAction(fromTarget),
    claims,
    mandateId: MANDATE_ID,
  }

  if (options.dryRun) {
    line('dry run: nothing signed, nothing sent, no payment made')
    line(JSON.stringify(body, null, 2))
    return
  }

  const agentKey = requireKey(readEnv('contracts/.env.agent'), 'AGENT_KEY', 'contracts/.env.agent')
  const agent = privateKeyToAccount(agentKey)
  if (agent.address.toLowerCase() !== AGENT.toLowerCase()) {
    throw new ConfigError(`AGENT_KEY is ${agent.address}, but the gate names ${AGENT}`)
  }
  line(`agent ${agent.address}, paying ${usdc(PRICE_ATOMIC)} for one check`)

  const result = await payAndCheck({
    origin: API_ORIGIN,
    body,
    signer: agent,
    onChallenge: (accepts) => line(`402 challenge: ${JSON.stringify(accepts)}`),
  })
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
  if (registry?.tx !== undefined) line(`registry tx ${registry.tx}`)
  else line(`registry not written: ${registry?.error ?? 'no registry record in the receipt'}`)
  const receiptUrl = `${API_ORIGIN}/receipts/${response.signed.intentHash}`
  line(`receipt ${receiptUrl}`)

  const maxAge = await client.readContract({ address: GATE, abi: gateAbi, functionName: 'maxAgeBlocks' })
  const deadline = BigInt(response.signed.checkedAtBlock) + BigInt(maxAge)
  line(`the gate accepts this verdict until block ${deadline}, ${maxAge} blocks after the check`)

  saveCheck({
    savedAt: new Date().toISOString(),
    mandateId: response.mandateId,
    outcome: response.verdict.outcome,
    intent: body.intent,
    signed: response.signed,
    receiptUrl,
    registryTx: registry?.tx ?? null,
  })
  line(`saved to .demo/last-check.json. Run execute now: the window is ${maxAge} blocks.`)
}

export async function execute(options: Options): Promise<void> {
  const saved = loadCheck()
  const client = publicClientFor(rpcUrl())

  const mismatch = verdictMatchesIntent(saved)
  if (mismatch !== null) throw new Error(mismatch)
  line(`saved verdict ${saved.outcome} for intent ${saved.signed.intentHash}`)

  if (saved.outcome === 'FAIL') {
    throw new Error('the verdict is FAIL: the gate would revert Refuted. Nothing to execute.')
  }
  if (saved.outcome === 'WAIT') {
    throw new Error('the verdict is WAIT: the gate needs an owner signature over the intent hash, which this script does not hold.')
  }

  const head = await client.getBlockNumber()
  const maxAge = await client.readContract({ address: GATE, abi: gateAbi, functionName: 'maxAgeBlocks' })
  const checkedAt = BigInt(saved.signed.checkedAtBlock)
  const age = head - checkedAt
  if (age > BigInt(maxAge)) {
    throw new Error(
      `the verdict is ${age} blocks old and the gate accepts ${maxAge}. Run check again, then execute straight after.`,
    )
  }
  line(`verdict is ${age} blocks old, inside the ${maxAge} block bound`)
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

  const before = await vaultPositions(client, head)
  printPositions('before', before)

  const args = [
    saved.intent.data,
    saved.signed.claimsHash,
    BigInt(saved.intent.nonce),
    BigInt(saved.intent.notAfterBlock),
    saved.signed.outcome,
    BigInt(saved.signed.checkedAtBlock),
    saved.signed.receiptHash,
    saved.signed.signature,
    '0x',
  ] as const

  if (options.dryRun) {
    line('dry run: nothing signed, nothing sent')
    line(`would call ${GATE}.execute with nonce ${saved.intent.nonce}, outcome ${saved.signed.outcome}`)
    line(`calldata length ${(saved.intent.data.length - 2) / 2} bytes, validator signature ${saved.signed.signature.slice(0, 12)}...`)
    return
  }

  const agentKey = requireKey(readEnv('contracts/.env.agent'), 'AGENT_KEY', 'contracts/.env.agent')
  const agent = privateKeyToAccount(agentKey)
  const wallet = createWalletClient({ account: agent, chain: monad, transport: http(rpcUrl(), { batch: false }) })

  const estimate = await client.estimateContractGas({
    address: GATE,
    abi: gateAbi,
    functionName: 'execute',
    args: args as never,
    account: agent,
  })
  const gas = withMargin(estimate)
  line(`execute: estimate ${estimate}, sending with gas ${gas}`)
  const hash = await wallet.writeContract({
    address: GATE,
    abi: gateAbi,
    functionName: 'execute',
    args: args as never,
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

// ------------------------------------------------------------------ cli

function line(text: string): void {
  console.log(text)
}

function printPositions(label: string, positions: VaultPositions): void {
  line(
    `${label} at block ${positions.block}: market A ${usdc(positions.a)}, market B ${usdc(positions.b)}, totalAssets ${usdc(positions.totalAssets)}`,
  )
}

const USAGE = `usage: node scripts/demo-check.ts <seed|check|execute> [--dry-run]

  seed     deployer approves and deposits ${usdc(SEED_ATOMIC)} into the vault, once
  check    agent states a reason, pays ${usdc(PRICE_ATOMIC)} over x402, and gets a signed verdict
  execute  agent presents the saved verdict to the gate

docs/DEMO.md has the order and what a judge sees.`

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0]
  const dryRun = argv.includes('--dry-run')
  try {
    if (command === 'seed') await seed({ dryRun })
    else if (command === 'check') await check({ dryRun })
    else if (command === 'execute') await execute({ dryRun })
    else {
      console.error(USAGE)
      return 1
    }
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
