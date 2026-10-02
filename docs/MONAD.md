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
- Primary RPC: Monad has no separate archive tier. The public rpc.monad.xyz kept about the last 5.6 days of state when measured on 2026-09-30 (UTC). https://rpc-mainnet.monadinfra.com (Monad Foundation, listed on the docs.monad.xyz Historical Data page) served state at blocks 50,000,000, 90,000,000, 100,000,000 and 106,277,363 on 2026-10-01 (UTC), and it is a single-provider trust assumption. The URL is treated as a secret, because a provider URL can carry an access token: `RPC_URL` in contracts/.env.deploy, and `MONAD_RPC_URL` as a Cloudflare secret for the worker. It never appears in a tracked file, a log, or an error response.
- Public endpoints (section 4) are fallback only: for the live test's default, and for a manual switch if the primary endpoint is down.
- Cost of sequential reads: a rate claim takes 11 reads with the default 5-block window (params, then state and IRM rate at each block). The worst case, a median window at its cap of 20 blocks, takes 41. A utilization or liquidity claim takes 5. Measured 2026-09-19: the live test's 44 sequential reads through https://rpc.monad.xyz took 7,668 ms from DJ's machine, about 174 ms per read. At that rate:
  - the demo mandate (one rate plus one liquidity claim: 16 reads, plus the chain id and head reads) takes about 3.1 s
  - a worst-case 41-read rate claim takes about 7.1 s
  - one check at this pace issues about 6 requests per second, under rpc.monad.xyz's 20 per second
- Freshness bound: ReasonGate.DEFAULT_MAX_AGE_BLOCKS is 60, about 18 s at about 0.30 s per block (raised from 20 on 2026-09-19 by DJ: 3 s of reads plus signing, response, agent submission, and inclusion did not fit in 6 s). The owner can change it with setMaxAgeBlocks. docs/CLAIMS.md states it as the freshness bound. Latency from the Cloudflare edge to the primary RPC has not been measured.

## 9. Zerion support for Monad (143)

Status: confirmed live. `pnpm zerion:chains` at 2026-10-01T01:31:01Z wrote shadow/evidence/zerion-chains.json (monad_supported true, id monad, chainId 143), and the live smoke test printed "Monad (143) in the Zerion chain catalog: yes, id \"monad\"" the same evening (30 Sep, Pacific).

Documentary evidence (not a live response), from the official `zerion-cli` 1.9.1 package, published from github.com/zeriontech/zerion-ai by maintainers at zerion.io:
- `skills/zerion/SKILL.md`, "Supported chains": the snapshot of the live catalog lists `monad`. The same file warns that the snapshot goes stale and that the live `/chains/` catalog is the source of truth.
- `cli/router.js`: the trading-supported chain list, which mirrors `/chains/` flags.supports_trading at release, includes `"monad"`.
- `skills/zerion/partners/monad-addresses.md` line 7: "**Monad chain name (Zerion CLI):** `monad`".

How the live answer gets recorded: with ZERION_API_KEY set, run `cd shadow && pnpm zerion:chains`. It calls `GET https://api.zerion.io/v1/chains/`. It writes the catalog (id, name, external_id, and attributes per chain, never the key) to shadow/evidence/zerion-chains.json and prints whether an entry with external_id 0x8f (143) exists. Then replace this section's status line with that answer, citing the file and its `fetched_at`. The live test (shadow/test/live/audit.live.test.ts) also prints the answer.

The shadow runner never assumes the Zerion chain id: it maps the EVM chain id to a Zerion chain id through `attributes.external_id` in the live catalog. If Monad is missing from the catalog, every Monad record is UNLOCATED with the reason "chain 143 is not in the Zerion chain catalog".

## 10. Multi-chain Morpho configuration (engine/src/chains.ts)

Source: `@morpho-org/morpho-ts` 2.15.0 (re-exported by `@morpho-org/morpho-sdk` 5.13.0), `addresses[ChainId]` in lib/esm/addresses.js, with `ChainId.EthMainnet = 1` and `ChainId.BaseMainnet = 8453` in lib/esm/chain.js. docs.morpho.org/developers/contracts/addresses (fetched 2026-09-18) lists every address below. On-chain checks were run on 2026-09-19 through public RPCs, read-only.

| Chain | chainId | RPC variable | Morpho | Adaptive Curve IRM | On-chain check |
| --- | --- | --- | --- | --- | --- |
| Monad | 143 | MONAD_RPC_URL | 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee | 0x09475a3D6eA8c314c592b1a3799bDE044E2F400F | rpc.monad.xyz: Morpho 15582 bytes, IRM 2282 bytes, isIrmEnabled true |
| Base | 8453 | BASE_RPC_URL | 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb | 0x46415998764C29aB2a25CbeA6254146D50D22687 | mainnet.base.org: Morpho 15623 bytes, IRM 2323 bytes, isIrmEnabled true |
| Ethereum | 1 | ETHEREUM_RPC_URL | 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb | 0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC | ethereum-rpc.publicnode.com: Morpho 15623 bytes, IRM 2717 bytes, isIrmEnabled true |

Notes:
- BASE_RPC_URL and ETHEREUM_RPC_URL hold archive-capable endpoints. For MONAD_RPC_URL, Monad has no separate archive tier: see section 8. All three are read by the shadow runner at call time. The engine never reads the environment.
- viem 2.56.7's default Ethereum RPC (https://ethereum.reth.rs/rpc) answered HTTP 404 on 2026-09-19, so the Ethereum check used PublicNode instead. Public endpoints are not used by the runner; they were used here for these one-off read-only checks.
- The same read policy as section 8 applies on every chain: one request per read, sequential, never batched.

## 11. jev-trader and Kuru (Phase 2C-b)

### jev-trader's call path, pinned

Source: github.com/jarrodwatts/jev-trader at commit b587759e459ea049590102e54a0b07800864cdc3 (branch main, MIT), vendored as a submodule at examples/jev-trader-gated/upstream and never edited.

At this commit the bot does **not** call a router swap. It posts a post-only limit order on the Kuru MON-USDC OrderBook every block, and its funds sit in the Kuru MarginAccount:
- `src/market.ts:189` encodes `batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, orderIdsToCancel, postOnly)` and `src/market.ts:175-181` sends it to `config.market` with `value: 0`. The comment at `src/market.ts:183` states the reason: "Funds come from the margin account, so value is 0".
- `src/config.ts` defaults: `market` 0x065C9d28E428A0db40191a54d33d5b7c71a9C394 (Kuru MON-USDC), `marginAccount` 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5, `chainId` 143.
- ABIs come from the official SDK: `import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json"`.
- The only mention of a market order anywhere in the tree is `scripts/abi-selectors.ts`, which prints selectors for `placeAndExecuteMarketBuy` and `placeAndExecuteMarketSell`. Neither is called by the trader. `grep -riE "anyToAnySwap|swap|router"` over the tree finds no router use.

Resolved selectors (`cast sig`, signatures from the SDK ABIs):

| Call | Selector | Contract |
| --- | --- | --- |
| batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool) | 0x5339c59f | OrderBook (the market) |
| placeAndExecuteMarketBuy(uint96,uint256,bool,bool) | 0x7c51d6cf | OrderBook (the market), payable |
| placeAndExecuteMarketSell(uint96,uint256,bool,bool) | 0x532c46db | OrderBook (the market), payable |
| anyToAnySwap(address[],bool[],bool[],address,address,uint256,uint256) | 0xffa5210a | Router |
| MarginAccount withdraw(uint256,address) | 0x00f714ce | MarginAccount |
| MarginAccount deposit(address,address,uint256) | 0x8340f549 | MarginAccount |

### Kuru Monad mainnet addresses

Source: docs.kuru.io/contracts/Contract-addresses, read from https://docs.kuru.io/llms-full.txt on 2026-09-20 (the HTML pages render client side; the text mirror carries the same tables).

| Contract | Address | On-chain check at block 106617487 |
| --- | --- | --- |
| Router (market factory and `anyToAnySwap`) | 0xd651346d7c789536ebf06dc72aE3C8502cd695CC | has code; `verifiedMarket(MON-USDC)` is true; `marginAccountAddress()` returns the MarginAccount below |
| MarginAccount | 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5 | matches the Router's `marginAccountAddress()` and jev-trader's default |
| MON-USDC market (OrderBook) | 0x065C9d28E428A0db40191a54d33d5b7c71a9C394 | has code; matches jev-trader's default |
| USDC | 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 | same USDC as section 1 |
| WMON | 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A | same wNative as the Morpho registry in section 1 |

`getMarketParams()` on the market at block 106617487 returns pricePrecision 1e8, sizePrecision 1e10, base token 0x0000000000000000000000000000000000000000 (native MON, 18 decimals), quote token USDC (6 decimals), tickSize 100, minSize 2e12, maxSize 2e18. The base asset being the zero address is why a market buy is payable: it takes native MON as value.

### Margin funding, and who can move it

Kuru limit orders draw from the MarginAccount, not from the trader's wallet, so a gated agent's
trading balance lives there. Two facts from the pinned tree and the SDK ABI decide the design:

- `deposit(address user, address token, uint256 amount)` (0x8340f549) credits the **user passed to
  it**, so anyone can fund any account. Native MON is deposited with `token` = address(0) and the
  amount as `value`: `upstream/src/market.ts:216-223` builds exactly that transaction, and
  `upstream/src/market.ts:247-249` reads a balance back with `getBalance(user, token)` (0xd4fac45d).
- `withdraw(uint256 amount, address token)` (0x00f714ce) moves **only the caller's own balance, to
  the caller**. Nobody can pull another account's margin, and an account with no code path to the
  MarginAccount can never get its own margin back.

KuruGate therefore carries the MarginAccount as an immutable address and two `onlyOwner` functions:
`depositMargin(token, amount)` (approve for that deposit only, then reset to zero) and
`withdrawMargin(token, amount)`, whose proceeds can only land in the gate, from where only the owner
can take them with `withdraw`. The agent key can call neither, and `execute` can never reach the
MarginAccount: the venue is immutable, and both margin withdraw selectors are blocklisted at compile
time. `marginBalance(token)` exposes the gate's own balance for observers.

### The answer set jev-trader actually uses

`upstream/src/model.ts:6` at b587759: `export type Action = "buy" | "sell" | "hold";`, and line 5
records what they mean: "Models answer buy or sell. `hold` only appears on late blocks (no decision
was made)." The two criteria the model is scored against are `buy` and `sell`
(`upstream/src/model.ts:52-53`). There is no UP, DOWN or FLAT anywhere in the tree, so
`examples/jev-trader-gated/mandate.json` lists `["buy", "sell"]` and `hold` is treated as no
decision, which places no order and asks for no verdict.

### Reading the book at a pinned block

Two reads, both `view` on the market, both pinned with `eth_call` at a block:
- `bestBidAsk()` (0xb4de8b70) returns (bestBid, bestAsk) as 1e18-scaled quote-per-base prices.
- `getL2Book()` (0x46fdfbb1) returns ABI-encoded `bytes`: one word holding the block number, then (price, size) word pairs for bids terminated by a zero price, then the same for asks. Prices are scaled by pricePrecision and sizes by sizePrecision, so depth comes from this call. jev-trader decodes it the same way in `src/book.ts:112-130` (`decodeL2Book`), and its `SEL_GET_L2_BOOK` constant equals the selector above.
- Optional: `getVaultParams()` (0x88bb4f60) merges the Kuru AMM vault ladder. On MON-USDC `vaultBidOrderSize` is 0, so the vault is inactive and the second read is skipped.

Verified at block 106617487 through rpc.monad.xyz: `bestBidAsk()` gave 25188000000000000 and 25199000000000000 (0.025188 and 0.025199 USDC per MON); `getL2Book()` decoded to the same top of book, 9 bid levels and 14 ask levels, and its embedded block number equalled the pinned block, which is a self-check that the read was pinned.

The engine's kuru_book observer uses `bestBidAsk()` for the two prices and `getL2Book()` for depth, both at the pinned block, one request each, never batched.

## 12. The on-chain verdict record (Phase 2C-d)

### Why an interim registry exists

ERC-8004 has three registries: Identity, Reputation, Validation. Only the Identity one is resolved
on Monad mainnet, at 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (section 5: an ERC-721 called
"AgentIdentity", implementation getVersion 2.0.0). No canonical Validation Registry address for
Monad could be resolved from source in this phase, and this session does not fetch web pages, so
rather than write verdicts to an address that might be wrong, Proof of Reason deploys its own:
contracts/src/ValidationRegistry.sol, deployed by contracts/script/DeployRegistry.s.sol.

It is interim in the precise sense that it holds records and nothing else. It has no upgrade path, no
owner power over any record, and no privileged reader. Agent ids are not its own invention: every
record names an id the Identity Registry knows, because the registry calls `ownerOf(agentId)` and
lets the call revert when the agent does not exist. That is what makes the records portable: they are
about ERC-8004 agents, not about rows in a private table.

Conformant surface, as close to the ERC as could be resolved offline:
- `validationRequest(validator, agentId, requestUri, requestHash)`, callable only by the agent's
  owner or an operator per the Identity Registry (ERC-721 `ownerOf`, `getApproved`,
  `isApprovedForAll`),
- `validationResponse(requestHash, response, responseUri, responseHash, tag)`, callable only by the
  validator the request named, `response` 0 to 100, callable again for the same request so the latest
  response wins,
- `getValidationStatus(requestHash)` and `getSummary(agentId, validators, tag)`, plus
  `getAgentValidations` and `getValidatorRequests`.

Unverified, and the reason this registry is interim rather than final: the exact argument order and
names of the canonical ERC-8004 Validation Registry functions, and whether the canonical
`ValidationResponse` event carries a response hash at all. Those were not resolvable from source in
this session.

### The one addition: a response with no request

`validationResponse(agentId, requestHash, response, responseHash, tag)` records a response with no
prior request. It exists because of the shape of this product: a Proof of Reason agent asks the
validator before it acts, and a WAIT or a FAIL is exactly the case where it then has no reason to
file anything on chain. Those are the records that matter most, so the validator files them itself.

Such a record is flagged, never disguised: `wasRequested(requestHash)` is false and the
`ValidationResponse` event carries `requested` false, so any reader can tell a volunteered record
from a requested one. The agent may later file its request over the top, which flips the flag and
leaves the verdict untouched; a request naming a different agent or a different validator reverts.
The conformant overload still refuses to answer a request that does not exist.

### What the worker writes

After every verdict, PASS, WAIT and FAIL alike, the worker sends one `validationResponse` from
VALIDATOR_KEY through MONAD_RPC_URL:

| Field | Value |
| --- | --- |
| agentId | from the mandate the verdict cites, decimal; "0" is the placeholder and nothing is sent |
| requestHash | the EIP-712 intent hash |
| response | 100 for PASS, 50 for WAIT, 0 for FAIL |
| responseHash | the receipt hash, so the record points at GET /receipts/<intentHash> |
| tag | the ruleset version, REASON-R0 |

Explicit gas limit 300,000 (worker/src/registry.ts), because Monad charges the limit. The write is
fail-soft: the verdict is signed, returned and stored whatever the registry did, and the receipt
records either `registry.tx` or `registry.error`. The error line is short and stripped of URLs,
because the RPC URL is a secret that carries an access token and viem puts the URL it called into its
error messages.

One consequence worth stating plainly: the response the validator posts is the receipt's own hash, so
the transaction hash can never be inside that hash. `registry` is therefore the one key that
receiptHash does not cover (engine/src/receipt.ts, RECEIPT_UNSEALED_KEYS). A verifier hashes a fetched
receipt by dropping `registry`, canonicalising and hashing, which is what `receiptHash` does; the
signed verdict is identical whether the write succeeded, failed, or never happened.

### Migrating to the canonical registry

The migration is a redeploy and a config change, not a data model change:

1. Resolve the canonical Validation Registry address and its exact function signatures from the ERC.
2. If its response call matches this one, point `REGISTRY_ADDRESS` at it and redeploy the worker. If
   it does not, change worker/src/registry.ts, which is the only file that encodes the call.
3. The agent asks the canonical registry for a validation with `validationRequest`, so the no-request
   addition is no longer needed; the worker keeps writing the same five values.
4. Hand this registry's ownership over with `Ownable2Step` and stop writing to it. Its records stay
   readable forever: they are keyed by intent hash and sealed by receipt hash, both of which are
   reproducible from the receipts the worker serves, so nothing has to be migrated to be believed.
5. envio/config.yaml gets the new address and start block. envio/src/outcomes.ts does not change:
   100, 50 and 0 are ERC-8004's scale, not ours.
