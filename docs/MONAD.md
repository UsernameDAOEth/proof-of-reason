# Proof of Reason on Monad: resolved facts

Resolved 2026-09-18, before Phase 2A code. Chain: Monad mainnet, chain id 143. Head block at resolution time: about 106,005,000. Every address below was read from a named source and then checked on chain with read-only calls. None was typed from memory.

## 1. Morpho contract addresses (chain 143)

| Contract | Address | Deployed at block |
| --- | --- | --- |
| Morpho Blue | 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee | 31907457 |
| Adaptive Curve IRM | 0x09475a3D6eA8c314c592b1a3799bDE044E2F400F | 31907457 |
| MetaMorpho V1.1 factory | 0x33f20973275B2F574488b18929cd7DCBf1AbF275 | 32320327 |
| Vault V2 factory | 0x8B2F922162FBb60A6a072cC784A2E4168fB0bb0c | 32321811 |
| USDC (loan token) | 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 | 22909616 |

Sources:
- `@morpho-org/morpho-sdk` 5.13.0, export `./addresses`. It re-exports `@morpho-org/blue-sdk` 6.11.0, which re-exports `@morpho-org/morpho-ts` 2.15.0. The values above are `addresses[ChainId.MonadMainnet]` in `morpho-ts/lib/esm/addresses.js` (keys `morpho`, `adaptiveCurveIrm`, `metaMorphoFactory`, `vaultV2Factory`, `usdc`), and the blocks are from `deployments[ChainId.MonadMainnet]` in the same file. `ChainId.MonadMainnet = 143` is in `morpho-ts/lib/esm/chain.js`.
- docs.morpho.org/developers/contracts/addresses, fetched 2026-09-18. The page lists the same four Morpho addresses and labels 0x33f2...F275 "MetaMorpho Factory V1.1" and 0x8B2F...bb0c "VaultV2Factory".

On-chain checks (rpc.monad.xyz):
- `MetaMorphoFactory.MORPHO()` returns 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee.
- Code is present at all four Morpho addresses (IRM 2282 bytes, Vault V2 factory 23124 bytes).
- USDC `name()` is "USDC", `version()` is "2", `decimals()` is 6. Its `DOMAIN_SEPARATOR()` is 0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6, which equals keccak256(abi.encode(EIP712Domain typehash, keccak256("USDC"), keccak256("2"), 143, USDC)). The x402 EIP-712 domain in the brief (name "USDC", version "2") is therefore correct for this token.

## 2. MetaMorpho V1.1 timelock at creation

Answer: timelock 0 is allowed at creation. There is no waiting period for the demo vault's setup.

Source: contracts/lib/metamorpho-v1.1 at commit 3b17547ee464d00370d1e5e7cd997c3cdb8b0fb7.
- `src/MetaMorphoV1_1.sol:137`: `if (initialTimelock != 0) _checkTimelockBounds(initialTimelock);`. The bounds check is skipped for 0.
- `src/MetaMorphoV1_1.sol:741-744`: after creation, any new timelock must lie in [POST_INITIALIZATION_MIN_TIMELOCK, MAX_TIMELOCK].
- `src/libraries/ConstantsLib.sol:10,13`: MAX_TIMELOCK = 2 weeks and POST_INITIALIZATION_MIN_TIMELOCK = 1 days.
- `src/MetaMorphoV1_1.sol:310-315` and `:495`: raising a cap sets `pendingCap.validAt = block.timestamp + timelock`, and `acceptCap` needs `block.timestamp >= validAt`. With timelock 0, `submitCap` and `acceptCap` can run back to back in one script.

On-chain confirmation: read-only `eth_call`s to the Monad factory 0x33f2...F275 `createMetaMorpho(...)`. With initialTimelock 0 the call returns a vault address. With 3600 it reverts `BelowMinTimelock`.

Effect on the demo timeline: none. Vault creation, caps, supply queue, and `setIsAllocator` all happen in one script run. If the timelock is later raised, the raise itself takes effect immediately (`submitTimelock:246-247`). After that, every cap increase waits the timelock, at least 1 day. Lowering the timelock again waits the current timelock.

## 3. Two live USDC markets with nonzero borrow

Source: Morpho API (https://api.morpho.org/graphql), query `markets(where: {chainId_in: [143], loanAssetAddress_in: [USDC], borrowAssets_gte: 1}, orderBy: BorrowAssetsUsd)`, fetched 2026-09-18. Parameters were then read on chain with `Morpho.idToMarketParams(id)`, and the ids were recomputed as keccak256(abi.encode(MarketParams)) with engine/src/action.ts `marketId`. Both matched.

Market A: USDC / aHYPER
- id: 0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626
- loanToken 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, collateralToken 0x7Cd231120a60F500887444a9bAF5e1BD753A5e59, oracle 0x4af4f38164cD7F28653A66aa2255B249a23cFBec, irm 0x09475a3D6eA8c314c592b1a3799bDE044E2F400F, lltv 770000000000000000
- State at block 106005207: totalSupplyAssets 38611206128629, totalBorrowAssets 34571206128629, fee 0. The API reports utilization 0.8954 and supplyApy 0.0797.

Market B: USDC / PT-USDat-14JAN2027
- id: 0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439
- loanToken 0x754704Bc059F8C67012fEd69BC8A327a5aafb603, collateralToken 0xa08A69aB9Dd3B04D0992BC7aFb2c0b907bbdc147, oracle 0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2, irm 0x09475a3D6eA8c314c592b1a3799bDE044E2F400F, lltv 915000000000000000
- State at block 106005207: totalSupplyAssets 19280298466672, totalBorrowAssets 17199475869871, fee 0. The API reports utilization 0.8921 and supplyApy 0.0511.

Both markets are `listed: true` in the API and use the Adaptive Curve IRM.

## 4. Public RPC endpoints and historical state

Source for the endpoint list: viem 2.56.7, chain id 143 in `viem/chains`, `rpcUrls.default.http`:
- https://rpc.monad.xyz
- https://rpc1.monad.xyz

Probes on 2026-09-18 (`cast call Morpho.market(id)` pinned with `--block`):

| Endpoint | chainId | head - 5 | head - 100 | head - 10,000 | head - 600,000 | head - 1,000,000 |
| --- | --- | --- | --- | --- | --- | --- |
| rpc.monad.xyz | 143 | served | served | served, differs from head | not probed | served |
| rpc1.monad.xyz | 143 | served | served | served, differs from head | served | error -32602 |

The rpc1 error text is: "Block requested not found. Request might be querying historical state that is not available. If possible, reformulate query to point to more recent blocks". Blocks are about 0.30 s apart (100,000 blocks took 30,222 s), so 5 blocks is about 1.5 s. Both endpoints serve the 5-block window the observers need. rpc.monad.xyz has the deeper history.

## 5. Other facts used by Phase 2A

- CREATE2 deployer 0x4e59b44847b379578588920ca78fbf26c0b4956c has code on Monad (69 bytes). DeployGate uses it, so DeployVault can predict the gate address.
- ERC-8004 Identity Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 is an ERC-1967 proxy (130 bytes). Its implementation 0x7274e874CA62410a93Bd8bf61c69d8045E399c02 reports name "AgentIdentity", symbol "AGENT", getVersion "2.0.0". The implementation bytecode contains the selectors for `register()`, `register(string)`, `register(string,(string,bytes)[])`, `setAgentURI(uint256,string)`, `setMetadata(uint256,string,bytes)`, `getMetadata(uint256,string)`, `setAgentWallet(uint256,address,uint256,bytes)`, and `tokenURI(uint256)`.
- Registration file format: `agent0-sdk` 1.7.1 `dist/utils/registration-json.js` writes `type` "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" with `name`, `description`, `image`, `services[{name, endpoint, ...}]`, `registrations[{agentId, agentRegistry: "eip155:<chain>:<registry>"}]`, `supportedTrust`, `active`, and `x402Support`. Agent 3 on the Monad registry uses the same field names.

- x402 on Monad: `@x402/evm` 2.26.0 `DEFAULT_ASSETS["eip155:143"]` (dist/esm/chunk-2UXXNYPA.mjs) is USDC 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 with name "USDC", version "2", 6 decimals. That matches the brief and the on-chain domain in section 1. The worker still pins the asset and the EIP-712 domain explicitly in its price.
- Facilitator https://x402-facilitator.molandak.org was not contacted in Phase 2A (offline tests only). Its `/supported` response for eip155:143 exact is unverified until 2B.

## 6. Live observer results (Phase 2A step 3)

Test: engine/test/live/monad.live.test.ts, run with `pnpm test:live` (LIVE=1). Read-only.
- Determinism: on 2026-09-18 the rate, utilization, liquidity, and identity observers ran twice against Market B, pinned at block 106006741 (head - 10), through https://rpc.monad.xyz. Both runs gave identical output, including byte-identical canonical JSON. The same test passed through https://rpc1.monad.xyz.
- Native supply APY: at block 106005742 (the Morpho API's `state.blockNumber` for Market B), the engine formula gave 5.112215770446301 percent. The API's native `supplyApy` was 0.05112215770446301, which is also 5.112215770446301 percent. The difference is 0 pp: the two IEEE 754 doubles are identical. The engine formula is APY = exp(borrowRateView * utilization * (1 - fee) * 31536000) - 1, with fee = 0 on this market.
- Rate limiting on 2026-09-18: about 50 concurrent `eth_call`s made rpc1.monad.xyz return HTTP 429 (Cloudflare error 1015, "Access denied ... used Cloudflare to restrict access"). A Multicall3-batched client passed on both endpoints that day. That client setting is withdrawn: see section 8.
- Sequential rerun on 2026-09-19, under the section 8 policy (one request per read, no JSON-RPC batch, no Multicall, one read in flight):
  - https://rpc.monad.xyz: both tests pass. At block 106260863 the engine formula gave 4.982380890422236 percent and the Morpho API's native `supplyApy` gave the same value, a 0 pp difference.
  - https://rpc1.monad.xyz: single requests return 200, but the test's roughly 40 back-to-back sequential `eth_call`s got HTTP 429 even after viem's built-in retries. rpc1 throttles by request rate, not only by concurrency. The live test fails loudly on 429; it skips only when historical state is missing.

## 7. Production hosting (Cloudflare)

Source: provided by DJ on 2026-09-19. Not independently checked in this session: DNS and Cloudflare API calls are outside the allowed network use. docs/DEPLOY_RUNBOOK.md step 0 has the commands that check them.

| Fact | Value |
| --- | --- |
| API hostname (this Worker) | api.proofofreason.com |
| Site hostname | proofofreason.com |
| Cloudflare account | b4223803 (as provided; the full 32-hex account id is not recorded in the repo) |
| Zone | proofofreason.com, status Active |
| Nameservers | chin.ns.cloudflare.com, greg.ns.cloudflare.com |
| SSL/TLS mode | Full (strict) |
| Always Use HTTPS | On |
| ENS name | username.dj-z-s.eth, literal (confirmed by DJ 2026-09-19), the only ENS name any registration file or document may reference |
| Contact | dj@proofofreason.com |

The Worker attaches to api.proofofreason.com as a Workers Custom Domain (`routes = [{ pattern = "api.proofofreason.com", custom_domain = true }]` in worker/wrangler.toml), with `workers_dev = false`, so no *.workers.dev URL is served. scripts/gen-registration.ts fixes the x402 endpoint to https://api.proofofreason.com/check, lists https://proofofreason.com as the web service, lists username.dj-z-s.eth as the only ENS entry, and puts dj@proofofreason.com in `metadata.contact`.

## 8. RPC policy (2026-09-19)

Source: DJ, 2026-09-19. "The Foundation RPC" is https://rpc.monad.xyz. Monad's docs list it at 20 requests per second with batch not allowed. Enforcement varies; the policy is never batch. Observation on 2026-09-19: a two-request JSON-RPC batch (eth_blockNumber, eth_chainId) returned HTTP 200 with both results from rpc.monad.xyz and from rpc1.monad.xyz. So the prohibition was not enforced on those endpoints at that size. The policy below is followed regardless.

- Observers read sequentially and never batch. Every read is one `eth_call` pinned to one block. It is sent only after the previous read returns, in claim order and then ascending block order. There is no JSON-RPC batch, no Multicall, and no concurrency. This is enforced in engine/src/morpho.ts (`observe`, `observeAll`) and tested there (call order, at most one read in flight). worker/test/wiring.test.ts also enforces it at the wire: no batch arrays, no Multicall3 target, at most one RPC request in flight.
- The viem transport is created with `http(url, { batch: false })` and without the client-level `batch.multicall` option, in both the worker and the live test.
- Primary RPC: an archive-capable Monad endpoint (QuickNode or Tenderly Node). Its URL carries an access token, so it is a secret: `RPC_URL` in contracts/.env.deploy, and `MONAD_RPC_URL` as a Cloudflare secret for the worker. It never appears in a tracked file, a log, or an error response.
- Public endpoints (section 4) are fallback only: for the live test's default, and for a manual switch if the archive endpoint is down.
- Cost of sequential reads: a rate claim takes 11 reads with the default 5-block window (params, then state and IRM rate at each block). The worst case, a median window at its cap of 20 blocks, takes 41. A utilization or liquidity claim takes 5. Measured 2026-09-19: the live test's 44 sequential reads through https://rpc.monad.xyz took 7,668 ms from DJ's machine, about 174 ms per read. At that rate:
  - the demo mandate (one rate plus one liquidity claim: 16 reads, plus the chain id and head reads) takes about 3.1 s
  - a worst-case 41-read rate claim takes about 7.1 s
  - one check at this pace issues about 6 requests per second, under rpc.monad.xyz's 20 per second
- Freshness bound: ReasonGate.DEFAULT_MAX_AGE_BLOCKS is 60, about 18 s at about 0.30 s per block (raised from 20 on 2026-09-19 by DJ: 3 s of reads plus signing, response, agent submission, and inclusion did not fit in 6 s). The owner can change it with setMaxAgeBlocks. docs/CLAIMS.md states it as the freshness bound. Latency from the Cloudflare edge to the archive RPC has not been measured.
