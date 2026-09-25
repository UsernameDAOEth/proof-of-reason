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
2. Builds MetaMorpho V1.1 `reallocate` calldata that moves 5 USDC from market A to market B. The
   struct is the one the engine and the gate already agree on, so the selector is `0x7299aa31`, which
   is the only selector this gate allowlists.
3. Reads market B's supply rate and withdrawable liquidity at that block, then states the claims from
   what it read: the APY to four decimal places within a 0.1 point tolerance, and a liquidity floor at
   90 percent of the worst block in the window. A claim is phrased after the reading, never before.
4. POSTs to `https://api.proofofreason.com/check`, is refused with a 402 carrying the price and the
   USDC EIP-712 domain, signs an EIP-3009 transfer authorization for 0.10 USDC with the agent key,
   and posts again with the payment header. Nothing but that authorization is signed: no transaction
   leaves this process.

It prints the verdict, the block it was checked at, the receipt hash, the registry transaction if the
validator wrote one, the receipt URL, and the block the verdict expires at. The verdict is saved to
`.demo/last-check.json`, which is gitignored and holds the intent, the signed verdict and the receipt
URL, and no key.

### 3. `execute`, the part that moves money

As the agent: rebuilds the intent hash from the saved intent and refuses if it does not match the
verdict it holds, refuses a FAIL, refuses a WAIT (that needs the owner's signature, which this script
does not have), refuses a stale verdict or a used nonce, prints the vault's per-market balances,
calls `gate.execute` with an explicit gas limit, then prints the balances again and the difference.

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
- **The refusal path is the product.** To see it, edit a claim by hand so it is false, for example
  raise the liquidity floor above what the market holds, and run `check` again: the verdict is FAIL,
  the receipt says which premise failed and what was observed instead, and `execute` refuses to send.

## Before the demo

| Check | Command |
| --- | --- |
| Tests pass offline | `cd scripts && pnpm test` |
| The vault has money | `node scripts/demo-check.ts seed --dry-run` prints totalAssets |
| The agent key matches the gate | `check` refuses if `AGENT_KEY` is not the agent the gate names |
| The agent has MON for gas | `cast balance 0x876a294aB4D313798EA44fFdCEC37EA741D792AF --rpc-url monad` |
| The agent has USDC for the check | at least 0.10 USDC at `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |

## Files and keys

`contracts/.env.deploy` provides `RPC_URL` and, for `seed` only, `PRIVATE_KEY`.
`contracts/.env.agent` provides `AGENT_KEY`, read by `check` and `execute` only. Both files are
gitignored, both are read at run time, and neither value is ever printed: the script names the
variable and the file when something is missing, never the value. `.demo/` is gitignored.
