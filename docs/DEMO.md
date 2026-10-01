# The first paid check, end to end

Three commands. A vault with 10 USDC in it, an agent that states a reason and pays 0.10 USDC to have
it checked, and a gate that moves the money only because the reason held.

```sh
cd ~/proof-of-reason
node scripts/demo-check.ts seed
node scripts/demo-check.ts check && node scripts/demo-check.ts execute
```

The second line is one command on purpose. The gate accepts a verdict for **60 blocks**, about 18
seconds on Monad, so `check` and `execute` run back to back. If they drift apart, `execute` refuses
before sending anything and tells you how old the verdict is; run `check` again.

Add `--dry-run` to any of the three. A dry run reads the chain, prints what it would do, and signs
nothing, sends nothing and reads no key file. It is the safe way to see the shape of the thing.

## What each command does

### 1. `seed`, once

From the deployer key in `contracts/.env.deploy`: approve 10 USDC to the vault, then ERC-4626
`deposit`. The vault's supply queue routes the deposit into markets A and B. Both transactions send
an explicit gas limit, estimated and then multiplied by 1.2, because Monad charges the limit and not
the gas used.

It is idempotent: if the deployer already holds vault shares it prints the balances and stops.

### 2. `check`, the paid part

As the agent, from `contracts/.env.agent`:

1. Reads the vault's position in market A at the head minus 2 blocks, the same block the validator
   will read.
2. Builds MetaMorpho V1.1 `reallocate` calldata that moves `--amount` USDC, **4 by default**, from
   market A to market B (`--from B` reverses it). The struct is the one the engine and the gate
   already agree on, so the selector is `0x7299aa31`, which is the only selector this gate
   allowlists.
3. Reads market B's supply rate and withdrawable liquidity at that block, then states the claims from
   what it read: the APY to four decimal places within a 0.1 point tolerance, and a liquidity floor at
   90 percent of the worst block in the window. A claim is phrased after the reading, never before.
4. **Preflight, free, before any payment**: an `eth_call` of `vault.reallocate` with that calldata,
   sent from the gate's address. The gate is the vault's allocator, so the vault runs exactly the
   checks it will run when the gate forwards the call. On a revert, `check` prints the error by name
   with the market labelled A or B, for example
   `SupplyCapExceeded(market B 0x093bd940...)`, and stops: no key is read, nothing is paid. A dry run
   runs the preflight too.
5. POSTs to `https://api.proofofreason.com/check`, is refused with a 402 carrying the price and the
   USDC EIP-712 domain, signs an EIP-3009 transfer authorization for 0.10 USDC with the agent key,
   and posts again with the payment header. Nothing but that authorization is signed: no transaction
   leaves this process.

It prints the verdict, the block it was checked at, the receipt hash, the registry transaction if the
validator wrote one, the receipt URL, and the block the verdict expires at. The verdict is saved to
`.demo/last-check.json`, which is gitignored and holds the intent, the signed verdict and the receipt
URL, and no key.

### 3. `execute`, the part that moves money

As the agent: rebuilds the intent hash from the saved intent under the deployed gate's EIP-712
domain (version 1) and refuses if it does not match the verdict it holds, refuses a stale verdict or
a used nonce, prints the vault's per-market balances, calls `gate.execute` with an explicit gas
limit, then prints the balances again and the difference.

It refuses a FAIL unless `--simulate` is given, and a WAIT unless `--owner-sig` is given:

- `--simulate` makes an `eth_call` of `execute` from the agent address and prints the gate's revert
  decoded by name, for example `Refuted(0x..., 0x...)`. Nothing is signed and nothing is sent, and no
  key is read.
- `--owner-sig` signs the gate's EIP-712 `Override(bytes32 intentHash)` for the saved intent with
  `PRIVATE_KEY` from `contracts/.env.deploy`, after checking that the key's address is the gate's
  live `owner()` (0xBBfcf117A17eBC65F562e06AfDe5995cD38AA1AF, which also owns the vault). The gate
  checks exactly that signer: `SignatureChecker.isValidSignatureNow(owner(), digest, ownerSig)` at
  `contracts/src/ReasonGate.sol` line 194 as committed at HEAD, the deployed v1 source (read it with
  `git show HEAD:contracts/src/ReasonGate.sol`). The key is never printed.

### 4. `receipt --save PATH`

Fetches `https://api.proofofreason.com/receipts/` plus the intent hash of the last check from the
live API and writes the bytes it served to `PATH`, unparsed. The receipt is never built locally.

## What a judge sees

```
node scripts/demo-check.ts check
head 107948754, reading at 107948752
vault now at block 107948752: market A 10.000000 USDC, market B 0.000000 USDC, totalAssets 10.000000 USDC
moving 5.000000 USDC from market A to market B, so market A targets 5.000000 USDC
claim: market B supply APY is 9.524 percent, within 0.1 pp
claim: market B can return at least 1632618.567576 USDC
agent 0x876a294aB4D313798EA44fFdCEC37EA741D792AF, paying 0.100000 USDC for one check
402 challenge: [{"scheme":"exact","network":"eip155:143", ...}]

verdict PASS (outcome code 1)
checked at block 107948752
receipt hash 0x...
registry tx 0x...
receipt https://api.proofofreason.com/receipts/0x...
the gate accepts this verdict until block 107948812, 60 blocks after the check
saved to .demo/last-check.json. Run execute now: the window is 60 blocks.
```

```
node scripts/demo-check.ts execute
saved verdict PASS for intent 0x...
verdict is 3 blocks old, inside the 60 block bound
before at block 107948757: market A 10.000000 USDC, market B 0.000000 USDC, totalAssets 10.000000 USDC
execute: estimate 289431, sending with gas 347317
execute tx 0x...
execute status success in block 107948759, gas used 284102
after at block 107948759: market A 5.000000 USDC, market B 5.000000 USDC, totalAssets 10.000000 USDC
market A moved -5.000000 USDC, market B moved 5.000000 USDC
```

Three things are worth pointing at while it runs:

- **The money moved because a premise was checked, not because an agent asked.** The same calldata
  presented without a verdict reverts, and presented with a FAIL verdict reverts `Refuted`.
- **The receipt is the artifact.** Open the receipt URL: it carries the claims, the observations, the
  block they were read at, the verdict and the mandate, and its own hash is what the validator signed
  and what the gate checked.
- **The refusal path is the product.** Take 2 below shows it: a rate stated 5 points above what the
  chain shows is FAIL, the receipt says which claim failed and what was observed instead, and the
  gate's own answer to the call is `Refuted`.

## The three takes

One sitting, three paid checks, on the deployed gate v1
(0x8fF582f268aB8E2148B548Aa061c5273bC383120), vault 0x28900B0B2DDA5d2d61cDF17BE8b7091206a04Bf9,
mandate `demo-usdc-v1`, market A
0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626 and market B
0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439.

### The caps, and why 4 USDC

The vault caps each market at exactly **10.000000 USDC** of supply, and holds about **A 5 / B 5**
(5.005075 and 5.004221 USDC at block 109167154). Moving 5.000000 USDC into either market takes it
over its cap, and MetaMorpho reverts `SupplyCapExceeded(bytes32)`, selector `0x5e25afa5`, with the
market id as data. Market B takes at most 4.995779 more, market A at most 4.994925. So `check`
moves **4 USDC by default**, and the preflight refuses anything that would not fit before a cent is
paid:

```sh
node scripts/demo-check.ts check --dry-run --amount 5
```

prints `failed: preflight: the vault would revert SupplyCapExceeded(market B 0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439) ... No payment made.`

The sitting starts at about A 5 / B 5 and ends there: take 1 moves 4 USDC from A to B (about
A 1 / B 9), take 2 moves nothing, take 3 moves 4 USDC from B back to A. Interest accrues in between,
so the last digits drift upward.

Each `check` and the `execute` after it are one line joined by `&&`: the gate accepts a verdict for
60 blocks, and in take 2 a stale verdict would revert `VerdictTooOld` before the gate ever reaches
`Refuted`.

Rehearse any take first by adding `--dry-run` to its `check`: the claims and the preflight are
printed, nothing is paid.

### Take 1: PASS, A to B

```sh
cd ~/proof-of-reason
node scripts/demo-check.ts check && node scripts/demo-check.ts execute
node scripts/demo-check.ts receipt --save .demo/receipt-pass.json
```

The claims are stated from what was read: market B's supply APY to four decimals within 0.1 point,
and a liquidity floor at 90 percent of the worst block. Verdict PASS, registry response 100.
`execute` moves 4 USDC: the vault goes to about A 1 / B 9.

### Take 2: FAIL, B to A, with a false rate

```sh
node scripts/demo-check.ts check --from B --claim-false && node scripts/demo-check.ts execute --simulate
node scripts/demo-check.ts receipt --save .demo/receipt-fail.json
```

The claims are about market A, the destination. `--claim-false` states its rate at the observed
median plus 5.0 percentage points. A rate claim is TRUE only when |observed - claimed| is within
its tolerance (`engine/src/compare.ts` line 45, 0.1 point here), so it is FALSE, and any FALSE claim
is FAIL (`engine/src/verdict.ts` lines 62 and 63). Verdict FAIL, registry response 0. The liquidity
claim still holds; the receipt lists the rate alone under `failing`, with what was observed.

`execute --simulate` asks the gate, without sending, and prints `the gate reverts: Refuted(...)`
with this check's intent hash and receipt hash: the check at line 191 of the deployed
`contracts/src/ReasonGate.sol` (HEAD). The vault stays at about A 1 / B 9.

### Take 3: WAIT, B to A, liquidity left out, owner override

```sh
node scripts/demo-check.ts check --from B --omit liquidity && node scripts/demo-check.ts execute --owner-sig
node scripts/demo-check.ts receipt --save .demo/receipt-wait.json
```

`--omit liquidity` sends the rate claim alone. The mandate requires rate and liquidity, a required
kind with no claim is missing (`engine/src/verdict.ts` line 43), and a missing kind with nothing
false is WAIT (lines 64 and 65). Verdict WAIT, registry response 50, `missing kinds: liquidity`.

`execute --owner-sig` signs the Override as the gate owner and presents it with the verdict. The
gate recomputes the digest (line 193), checks it against `owner()` (line 194) and forwards the call.
`Executed` carries `ownerOverride = true`. The vault goes back to about A 5 / B 5.

### What the sitting costs

| | |
| --- | --- |
| Checks | 3 at 0.10 USDC each, 0.30 USDC, paid over x402 by the agent |
| PAY_TO 0xA6Ad9B6e390979c8e4BA9c7Eb7cFd701dE1F9275 | holds 0.40 USDC before (the first receipt and the 29 Sep rehearsal), 0.70 USDC after |
| Agent 0x876a294aB4D313798EA44fFdCEC37EA741D792AF | holds 1.60 USDC and 1.950124 MON before: 1.30 USDC after, and gas for two `execute` transactions |
| Preflight and `execute --simulate` | free: `eth_call` |
| Owner | signs one EIP-712 message, sends nothing, spends nothing |

## Rehearsal, 29 Sep 2026

Three real checks by the demo agent 0x876a294aB4D313798EA44fFdCEC37EA741D792AF on the gate above,
each moving 5.000000 USDC, before the 4 USDC default and the preflight existed:

| Take | Intent | Verdict | Registry response |
| --- | --- | --- | --- |
| PASS | 0x2aa4c0dae030b5f663ea07df225b39187bc7c756f78e430ebb6a289e73fef385 | PASS, block 109163748 | 100 |
| FAIL | 0xafe36d676c07fea51f39689d4c0fb4cedd11b52fe9142b85d57dafea59a86e1b | FAIL, block 109163781 | 0 |
| WAIT | 0x9c32eded06a5a5ba4b2499ff5be71e5c1937b6964117f9e6be6bc0b6d71e3bc0 | WAIT, block 109163813, missing liquidity | 50 |

The verdicts were right. The PASS and WAIT executions were blocked by the vault's own supply cap,
`SupplyCapExceeded`, not by the gate: 5 USDC did not fit under the 10 USDC cap of the destination
market. These three checks are not used in the video and do not count as usage.

## Live takes, 29 Sep 2026

The three takes, run live on Monad mainnet against the v1 gate. They were not screen-recorded: the
receipts at `https://api.proofofreason.com/receipts/<intent>` are the record.

| Take | Intent | Registry response | On chain |
| --- | --- | --- | --- |
| PASS | 0xbc61bf14bdda5ccf34163a29e5b9cb59eb8fd9cfd117e2f837c56c5a71258917 | 100 | execute tx 0xf6160dba44ac196f333f21187c0213dc000be1b63ce70c6514e8ee9ebef048e9 in block 109188854 |
| FAIL | 0xaee2253b7c112971435c111c97c20ddf2d2c863079ddf662e0ddb8fc7ace0b9b | 0 | registry tx 0x7c3b22f90554f789e11f1455cf2c6d5d7c3989f73406590f87baeb609a79da16; execute simulated against the live gate, not sent, gate error `Refuted` |
| WAIT | 0xfdef4aa1a5f5d840cc453c9c0203903ffbb6cfc9a8e58dc8dccf455565d560ee | 50 | registry tx 0x22e12dde49b5786a1a98893a8d770f47651e647547072f44739adf7a98026790; execute tx 0x363b90a46c6f7578a2df3e88d0a5f718a3d5d437a519a3d51a22ba0a837ecced in block 109193857, owner override |

The FAIL take was run with the old wording: `check` printed "the gate accepts this verdict
until block N" for a FAIL. `check` now prints "the gate will refuse this verdict" for a FAIL, and
no longer tells you to run execute.

Cost for the sitting: 0.30 USDC, three checks at 0.10 USDC. PAY_TO now holds 0.70 USDC.
Vault after: A 5.005179 USDC, B 5.004346 USDC.

## Before the demo

| Check | Command |
| --- | --- |
| Tests pass offline | `cd scripts && pnpm test` |
| The vault has money | `node scripts/demo-check.ts seed --dry-run` prints totalAssets |
| The agent key matches the gate | `check` refuses if `AGENT_KEY` is not the agent the gate names |
| The agent has MON for gas | `cast balance 0x876a294aB4D313798EA44fFdCEC37EA741D792AF --rpc-url monad` |
| The agent has USDC for the check | at least 0.10 USDC at `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |

## Files and keys

`contracts/.env.deploy` provides `RPC_URL` and, for `seed` and `execute --owner-sig` only,
`PRIVATE_KEY`. `RPC_URL` set in the environment takes precedence, so a dry run reads no env file:
`RPC_URL=https://rpc.monad.xyz node scripts/demo-check.ts check --dry-run`.
`contracts/.env.agent` provides `AGENT_KEY`, read by `check` and `execute` only. Both files are
gitignored, both are read at run time, and neither value is ever printed: the script names the
variable and the file when something is missing, never the value. `.demo/` is gitignored.
