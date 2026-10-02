# Proof of Reason deploy runbook (Phase 2B)

Every command DJ runs in 2B, in order, with the expected output. Keys and the RPC URL (treated as a secret, because a provider URL can carry an access token) live only in gitignored env files and Cloudflare secrets. Never paste one into a terminal command, a chat, or a tracked file. Addresses, KV ids, and hostnames are public and may be committed.

Facts used below are sourced in docs/MONAD.md: addresses and markets (sections 1 to 3), RPC (sections 4 and 8), timelock (section 2), and hosting (section 7).

Conventions:
- **RPC:** `RPC_URL` is the Monad RPC. Monad has no separate archive tier. The public rpc.monad.xyz kept about the last 5.6 days of state when measured on 2026-09-30 (UTC). https://rpc-mainnet.monadinfra.com (Monad Foundation, listed on the docs.monad.xyz Historical Data page) served state at blocks 50,000,000, 90,000,000, 100,000,000 and 106,277,363 on 2026-10-01 (UTC), and it is a single-provider trust assumption. Public endpoints (rpc.monad.xyz, rpc1.monad.xyz) are fallback only.
- **cast:** every `cast` command runs from `contracts/` with `--rpc-url monad`, which foundry.toml resolves to `$RPC_URL`. That keeps the token out of argv and shell history.
- **Production hostnames:** the Worker serves `https://api.proofofreason.com`; the site is `https://proofofreason.com`.

## Budget and gas

Monad charges the full gas limit, not the gas used. Every transaction below has an explicit limit.

| Transaction | Gas limit | Source |
| --- | --- | --- |
| createMetaMorpho | 5,100,000 | DeployBase.s.sol, measured exec 4,191,422 |
| submitCap (x2) | 150,000 each | measured exec 92,340 |
| acceptCap (x2) | 250,000 each | measured exec 181,431 |
| setSupplyQueue | 180,000 | measured exec 123,775 |
| setIsAllocator | 100,000 | measured exec 60,829 |
| gate CREATE2 deploy | 2,050,000 | measured exec 1,529,194 plus 124,504 calldata |
| registry CREATE2 deploy | 1,700,000 | DeployRegistry.s.sol: 6,213 bytes of code at 200 gas, plus init code as calldata |
| ERC-8004 register (demo agent) | `cast estimate` x 1.2 | `register()` with no URI, about 200,000 |
| ERC-8004 register (validator) | `cast estimate` x 1.2 | 1,216,176 estimated for a 1,773-character URI on 2026-09-19 |
| validator MON top-up | 21,000 | a plain transfer of 1 MON |

Total is about 11.6M gas. The 2026-09-18 simulation quoted a 100 gwei base fee and a 203 gwei max fee, which puts the cost between about 1.2 and 2.4 MON. Fund the deployer with at least 3.5 MON, 1 MON of which goes to the validator in step 6.

The validator key now does send transactions: one `validationResponse` per verdict, at an explicit 300,000 gas limit (worker/src/registry.ts). Monad charges the limit, so at a 102 gwei effective price each verdict costs about 0.031 MON, and 1 MON covers about 32 verdicts. When the validator runs out of MON the verdict is still signed and returned: the receipt records `registry.error` instead of `registry.tx` (docs/MONAD.md section 12).

Why `--skip-simulation`: forge's second simulation phase re-estimates every transaction through the RPC. That estimate cannot see the vault created earlier in the same script, so it priced `submitCap` at 25,898 gas, which is intrinsic gas only, and the transaction would run out of gas on chain. With `--skip-simulation`, forge sends the explicit limits verbatim. The local execution phase still runs against live Monad state, with Monad gas rules (`network = "monad"` in foundry.toml).

## 0. Preconditions and zone checks

- `forge --version` reports 1.8.3 or later. If forge is not found, run `export PATH="$PATH:$HOME/.foundry/bin"`.
- `node --version` reports v22.18 or later. `pnpm --version` reports 11.x.
- A Monad RPC URL that holds the history you need (see Conventions: Monad has no separate archive tier).
- A deployer EOA holding at least 2.5 MON on Monad (chain 143).
- The agent EOA address: the only address allowed to call `ReasonGate.execute`.
- A PAY_TO address that receives the 0.10 USDC per check.

Check the zone:

```sh
dig +short NS proofofreason.com
dig +short api.proofofreason.com
```

Expected:
- `chin.ns.cloudflare.com.` and `greg.ns.cloudflare.com.`, in either order.
- Nothing for `api.proofofreason.com`. The Workers Custom Domain creates that record in step 7. If a record already exists, delete it in the Cloudflare dashboard first, or step 7 fails.

In the Cloudflare dashboard for proofofreason.com, confirm: status Active, SSL/TLS encryption mode Full (strict), and Always Use HTTPS On.

## 1. Install and run the offline tests

```sh
cd ~/proof-of-reason
git status --short
pnpm install --frozen-lockfile
pnpm test
cd contracts && forge test && cd ..
```

Expected:
- `git status --short` prints nothing.
- `pnpm test` prints `engine test: ... Tests  86 passed (86)` and `worker test: ... Tests  31 passed (31)`.
- `forge test` ends with `50 tests passed, 0 failed, 1 skipped`. The skipped test is the opt-in Monad fork test.

## 2. Create the gitignored env files

```sh
cd ~/proof-of-reason
umask 077
cat > contracts/.env.deploy <<'EOF'
PRIVATE_KEY=
RPC_URL=
VALIDATOR_ADDRESS=
AGENT_ADDRESS=
VAULT=
GATE=
REGISTRY=
AGENT_ID=
EOF
git check-ignore -v contracts/.env.deploy worker/.env.worker
```

Expected: two lines, each naming `.gitignore` and the `.env.*` rule. If either line is missing, stop.

Open `contracts/.env.deploy` in your editor and fill in:
- `PRIVATE_KEY`: the deployer key.
- `RPC_URL`: the Monad RPC URL.
- `AGENT_ADDRESS`

The gate owner defaults to the deployer. To use a Safe instead, add a line `GATE_OWNER=0x...`.

Check that the RPC holds state 1,000,000 blocks back:

```sh
cd ~/proof-of-reason/contracts
set -a; . ./.env.deploy; set +a
cast chain-id --rpc-url monad
HEAD=$(cast block-number --rpc-url monad)
cast call 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee "market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)" 0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439 --block $((HEAD - 1000000)) --rpc-url monad
```

Expected: `143`, then six numbers. If you get `Block requested not found`, the endpoint does not hold state that far back: stop.

Optional, read-only, through the same RPC:

```sh
cd ~/proof-of-reason/engine && MONAD_RPC_URL="$RPC_URL" pnpm test:live
cd ~/proof-of-reason/contracts && forge test --match-path 'test/fork/*'
```

Expected: `Tests  2 passed (2)`, then `1 passed; 0 failed`.

## 3. Create the worker secrets file without displaying the key

```sh
cd ~/proof-of-reason/worker
umask 077
cast wallet new --json | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; open(".env.worker","x").write("VALIDATOR_KEY="+d["private_key"]+"\n"); print(d["address"])'
```

Expected: one line, the validator address `0x...`. The key goes only into `worker/.env.worker`. The `"x"` mode refuses to overwrite an existing file. Then:
- Copy the address into `VALIDATOR_ADDRESS=` in `contracts/.env.deploy`.
- Open `worker/.env.worker` in your editor and add a second line, `MONAD_RPC_URL=`, with the Monad RPC URL.

## 4. Deploy the vault

```sh
cd ~/proof-of-reason/contracts
set -a; . ./.env.deploy; set +a
forge script script/DeployVault.s.sol --rpc-url monad --skip-simulation
python3 -c "import json; d=json.load(open('broadcast/DeployVault.s.sol/143/dry-run/run-latest.json')); print([int(t['transaction']['gas'],16) for t in d['transactions']])"
```

Expected:
```
== Logs ==
  VAULT 0x<vault>
  PREDICTED_GATE 0x<gate>
  VAULT_OWNER 0x<your deployer>
SKIPPING ON CHAIN SIMULATION.
SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command.
[5100000, 150000, 250000, 150000, 250000, 180000, 100000]
```

If VAULT_OWNER is not your deployer address, stop: PRIVATE_KEY was not loaded. Then broadcast:

```sh
forge script script/DeployVault.s.sol --rpc-url monad --broadcast --skip-simulation --slow
```

Expected: seven `[Success] Hash: 0x...` lines, then `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.` The logged VAULT and PREDICTED_GATE match the simulation. Put both into `contracts/.env.deploy` as `VAULT=` and `GATE=` (the gate address is known before the gate exists).

Verify:

```sh
set -a; . ./.env.deploy; set +a
cast call $VAULT "timelock()(uint256)" --rpc-url monad
cast call $VAULT "supplyQueueLength()(uint256)" --rpc-url monad
cast call $VAULT "isAllocator(address)(bool)" $GATE --rpc-url monad
cast call $VAULT "config(bytes32)(uint184,bool,uint64)" 0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626 --rpc-url monad
cast call $VAULT "config(bytes32)(uint184,bool,uint64)" 0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439 --rpc-url monad
```

Expected: `0`, `2`, `true`, then `10000000 [1e7]` / `true` / `0` for each market.

## 5. Deploy the gate at the predicted address

VALIDATOR_ADDRESS, AGENT_ADDRESS, and GATE_OWNER must be exactly as in step 4, or the CREATE2 address changes and the script reverts with GateAddressMismatch.

```sh
cd ~/proof-of-reason/contracts
set -a; . ./.env.deploy; set +a
forge script script/DeployGate.s.sol --rpc-url monad --skip-simulation
```

Expected logs: `GATE 0x<gate>` equal to GATE in .env.deploy, then GATE_OWNER, VALIDATOR, AGENT. No `WARNING` line. Then broadcast:

```sh
forge script script/DeployGate.s.sol --rpc-url monad --broadcast --skip-simulation --slow
```

Expected: one `[Success]` transaction with gas limit 2050000, then `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.`

Verify:

```sh
cast call $GATE "vault()(address)" --rpc-url monad
cast call $GATE "validator()(address)" --rpc-url monad
cast call $GATE "agent()(address)" --rpc-url monad
cast call $GATE "maxAgeBlocks()(uint64)" --rpc-url monad
cast call $GATE "allowedSelector(bytes4)(bool)" 0x7299aa31 --rpc-url monad
cast call $GATE "isBlockedSelector(bytes4)(bool)" $(cast sig "withdraw(uint256,address,address)") --rpc-url monad
```

Expected: $VAULT, VALIDATOR_ADDRESS, AGENT_ADDRESS, `60`, `true` (0x7299aa31 is MetaMorpho V1.1 `reallocate`), `true`.

The freshness bound defaults to 60 blocks, about 18 seconds on Monad. One demo check spends about 3 seconds on sequential reads (docs/MONAD.md section 8, docs/CLAIMS.md). To change it later, the owner sets it with an explicit gas limit taken from the estimate:

```sh
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
GAS=$(cast estimate $GATE "setMaxAgeBlocks(uint64)" <blocks> --from $DEPLOYER --rpc-url monad)
cast send $GATE "setMaxAgeBlocks(uint64)" <blocks> --gas-limit $((GAS * 12 / 10)) --private-key "$PRIVATE_KEY" --rpc-url monad
```

## 6. Deploy the validation registry and register the demo agent

The worker records every verdict, PASS, WAIT and FAIL alike, on an interim ERC-8004 Validation
Registry. Why interim, and what migrating to the canonical one costs: docs/MONAD.md section 12.

### 6a. Deploy the registry

```sh
cd ~/proof-of-reason/contracts
set -a; . ./.env.deploy; set +a
forge script script/DeployRegistry.s.sol --rpc-url monad --skip-simulation
forge script script/DeployRegistry.s.sol --rpc-url monad --broadcast --skip-simulation --slow
```

Expected: `REGISTRY 0x<registry>`, then REGISTRY_OWNER (the gate owner, or the deployer),
IDENTITY_REGISTRY `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, and VALIDATOR. One `[Success]`
transaction with gas limit 1700000. Put the address in `REGISTRY=` in `.env.deploy`.

Verify:

```sh
cast call $REGISTRY "identityRegistry()(address)" --rpc-url monad
cast call $REGISTRY "owner()(address)" --rpc-url monad
cast call $REGISTRY "MAX_RESPONSE()(uint8)" --rpc-url monad
```

Expected: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, the gate owner, `100`.

### 6b. Register the demo agent on the Identity Registry

The demo agent is its own ERC-8004 agent, separate from the validator registered in step 9: the
agent is the thing being validated, the validator is the thing doing the validating. It is owned by
the deployer, and `register()` takes no URI, so nothing is published here.

```sh
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
GAS=$(cast estimate 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register()" --from $DEPLOYER --rpc-url monad)
cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register()" --gas-limit $((GAS * 12 / 10)) --private-key "$PRIVATE_KEY" --rpc-url monad
```

Read the agent id from the ERC-721 Transfer event, then check who owns it:

```sh
cast receipt <transactionHash> --rpc-url monad --json | python3 -c 'import json,sys; r=json.load(sys.stdin); t="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; print([int(l["topics"][3],16) for l in r["logs"] if l["topics"][0]==t and l["address"].lower()=="0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"])'
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "ownerOf(uint256)(address)" <agentId> --rpc-url monad
```

Expected: `[<agentId>]` and your deployer address. Put that number in `AGENT_ID=` in `.env.deploy`.

### 6c. Point the deployment at the registry

The gate contract holds no registry pointer: ReasonGate and KuruGate never call the registry, the
validator does, so there is nothing to set on chain. The registry address is configuration in two
places, and the agent id in one:

```sh
cd ~/proof-of-reason
# worker/wrangler.toml, [vars]
REGISTRY_ADDRESS = "<registry>"
# worker/src/mandates.ts, the demo mandate: replace the placeholder agentId "0"
agentId: '<agentId>',
# envio/config.yaml, the ValidationRegistry contract address
address: "<registry>"
```

The mandate carries the agent id because the mandate is what the verdict cites, so a receipt names
the agent it was filed against. While the placeholder `"0"` is there, no verdict is written and
every receipt says `the mandate carries no ERC-8004 agent id yet`. Commit both edits, then deploy
the worker in step 7; if the worker is already live, redeploy it after this edit.

### 6d. Fund the validator with 1 MON

The validator signs verdicts with VALIDATOR_KEY and now also sends one transaction per verdict from
the same key, so its address needs gas. It never holds anything else, and it can move nothing: the
registry only records.

```sh
cast send $VALIDATOR_ADDRESS --value 1ether --gas-limit 21000 --private-key "$PRIVATE_KEY" --rpc-url monad
cast balance $VALIDATOR_ADDRESS --rpc-url monad
```

Expected: `status 1 (success)` and `1000000000000000000`. That is about 32 verdicts at a 300,000 gas
limit and 102 gwei. Top it up when `cast balance` falls below about 0.1 MON.

## 7. Deploy the worker to api.proofofreason.com

```sh
cd ~/proof-of-reason/worker
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler kv namespace create RECEIPTS
```

Expected:
- `whoami` lists the account whose id starts with `b4223803`. If it lists more than one account, add `CLOUDFLARE_ACCOUNT_ID=<full id>` to `worker/.env.worker` and run `set -a; . ./.env.worker; set +a` before the wrangler commands below.
- `kv namespace create` prints a config snippet with `binding = "RECEIPTS"` and `id = "<32 hex characters>"`.

Edit `worker/wrangler.toml`:
- `[[kv_namespaces]] id`: that id.
- `GATE_ADDRESS`: $GATE.
- `VAULT_ADDRESS`: $VAULT.
- `PAY_TO`: your USDC receiving address.

Leave `routes` (api.proofofreason.com, custom domain) and `workers_dev = false` as they are.

Build check (bundles, uploads nothing):

```sh
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
```

Expected: `Total Upload: ... KiB / gzip: ... KiB`, the bindings `env.RECEIPTS (<id>)` plus the three vars, and `--dry-run: exiting now.` A bare import of `url` inside `@x402/extensions` did not resolve in the Phase 2A bundle check. `nodejs_compat` should provide it. If the dry run reports `Could not resolve "url"`, stop and report it.

Deploy, then add both secrets from the env file without displaying them:

```sh
pnpm exec wrangler deploy
set -a; . ./.env.worker; set +a
printf '%s' "$VALIDATOR_KEY" | pnpm exec wrangler secret put VALIDATOR_KEY
printf '%s' "$MONAD_RPC_URL" | pnpm exec wrangler secret put MONAD_RPC_URL
unset VALIDATOR_KEY MONAD_RPC_URL
export WORKER_URL=https://api.proofofreason.com
```

Expected:
- `Deployed proof-of-reason triggers`, listing `api.proofofreason.com (custom domain)` and no workers.dev URL.
- `Success! Uploaded secret VALIDATOR_KEY`, then the same line for `MONAD_RPC_URL`.

Until both secrets exist, the worker answers 500 with `worker is not configured: MONAD_RPC_URL` or `validator key is not configured`. The first certificate for the custom domain can take a few minutes.

## 8. Smoke test without paying

```sh
cd ~/proof-of-reason/contracts
set -a; . ./.env.deploy; set +a
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://api.proofofreason.com/
curl -s $WORKER_URL/
curl -s -o /dev/null -w '%{http_code}\n' -X POST $WORKER_URL/check -H 'content-type: application/json' -d '{}'
HEAD=$(cast block-number --rpc-url monad)
node ../worker/scripts/sample-body.ts $VAULT $((HEAD + 1000)) > "$TMPDIR/check-body.json"
curl -s -D - -o /dev/null -X POST $WORKER_URL/check -H 'content-type: application/json' --data @"$TMPDIR/check-body.json" | grep -i -E '^HTTP|^payment-required'
curl -s -o /dev/null -w '%{http_code}\n' $WORKER_URL/receipts/0x0000000000000000000000000000000000000000000000000000000000000000
curl -s -D - -o /dev/null -H 'Origin: https://third-party.example' $WORKER_URL/receipts/0x0000000000000000000000000000000000000000000000000000000000000000 | grep -i '^access-control-allow-origin'
curl -s -D - -o /dev/null -H 'Origin: https://third-party.example' $WORKER_URL/ | grep -ci '^access-control'
```

Expected:
- `301 https://api.proofofreason.com/` (Always Use HTTPS).
- `{"check":{"method":"POST","path":"/check","price":{"amount":"100000","asset":"0x754704Bc059F8C67012fEd69BC8A327a5aafb603","network":"eip155:143"}},"mandates":["demo-usdc-v1"],"name":"Proof of Reason","receipts":{"method":"GET","path":"/receipts/:intentHash"}}`
- `400` (the refusal is free).
- `HTTP/2 402` and a `payment-required:` header.
- `404`.
- `access-control-allow-origin: *`: CORS is on GET /receipts/:intentHash only.
- `0`: no CORS headers anywhere else, including `/` and `POST /check`.

Decode the payment requirements:

```sh
curl -s -D - -o /dev/null -X POST $WORKER_URL/check -H 'content-type: application/json' --data @"$TMPDIR/check-body.json" | awk -F': ' 'tolower($1)=="payment-required"{print $2}' | tr -d '\r' | base64 -d | python3 -m json.tool
```

Expected: `x402Version` 2 and one `accepts` entry with scheme `exact`, network `eip155:143`, amount `100000`, asset `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, your payTo, and extra `{"name": "USDC", "version": "2"}`.

A paid check (0.10 USDC through the facilitator) needs an x402 client wallet, which Phase 2A does not include.

## 9. Register the validator on the ERC-8004 Identity Registry

The registration file always lists `https://api.proofofreason.com/check` as the x402 endpoint, `https://proofofreason.com` as the web service, `username.dj-z-s.eth` as the only ENS name, and `dj@proofofreason.com` as contact. The script takes no URL.

```sh
cd ~/proof-of-reason/contracts
set -a; . ./.env.deploy; set +a
node ../scripts/gen-registration.ts --validator "$VALIDATOR_ADDRESS" --gate "$GATE" --out ../agent-registration.json
grep -o '[a-z0-9.-]*\.eth' ../agent-registration.json | sort -u
URI=$(cat ../agent-registration.json.datauri.txt)
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
GAS=$(cast estimate 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register(string)" "$URI" --from $DEPLOYER --rpc-url monad)
echo $GAS
cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register(string)" "$URI" --gas-limit $((GAS * 12 / 10)) --private-key "$PRIVATE_KEY" --rpc-url monad
```

Expected:
- `wrote ../agent-registration.json and ../agent-registration.json.datauri.txt (<n> characters); prereg_sha256 verified`. If it says `refusing to write`, docs/PREREG.md no longer hashes to 5f6a494f...c2d4: stop.
- The grep prints exactly `username.dj-z-s.eth`.
- `$GAS` about 1,200,000.
- `status 1 (success)` and a `transactionHash`.

Read the agent id from the ERC-721 Transfer event, then verify:

```sh
cast receipt <transactionHash> --rpc-url monad --json | python3 -c 'import json,sys; r=json.load(sys.stdin); t="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; print([int(l["topics"][3],16) for l in r["logs"] if l["topics"][0]==t and l["address"].lower()=="0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"])'
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "ownerOf(uint256)(address)" <agentId> --rpc-url monad
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "tokenURI(uint256)(string)" <agentId> --rpc-url monad
```

Expected: `[<agentId>]`, your deployer address, and the same data URI as `$URI`.

Optional, to record the agent id inside the file:

```sh
node ../scripts/gen-registration.ts --validator "$VALIDATOR_ADDRESS" --gate "$GATE" --agent-id <agentId> --out ../agent-registration.json
URI=$(cat ../agent-registration.json.datauri.txt)
GAS=$(cast estimate 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "setAgentURI(uint256,string)" <agentId> "$URI" --from $DEPLOYER --rpc-url monad)
cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "setAgentURI(uint256,string)" <agentId> "$URI" --gas-limit $((GAS * 12 / 10)) --private-key "$PRIVATE_KEY" --rpc-url monad
```

## 10. Close the shell and commit

```sh
unset PRIVATE_KEY RPC_URL
cd ~/proof-of-reason
git status --short --ignored | grep -E '\.env|\.dev\.vars'
git status --short
```

Expected: every env file appears only in the first list, prefixed `!!` (ignored). The second list shows `worker/wrangler.toml`, `agent-registration.json`, and `agent-registration.json.datauri.txt`. Commit those at your terminal. Never commit `contracts/.env.deploy` or `worker/.env.worker`.

## Troubleshooting

- **A transaction runs out of gas on chain:** do not raise the limit blindly. Re-run the matching simulation with `-vvvv`, read the new execution gas, and update the constant in `contracts/script/DeployBase.s.sol` to execution plus intrinsic plus 20 percent.
- **`GateAddressMismatch`:** VALIDATOR_ADDRESS, AGENT_ADDRESS, or GATE_OWNER differ from step 4, or the contracts were edited and recompiled between steps 4 and 5. Restore the step 4 values. If the vault already made a different address allocator, the vault owner can call `setIsAllocator` for the real gate address.
- **The custom domain fails to attach:** a DNS record for api.proofofreason.com already exists. Delete it in the dashboard and run `pnpm exec wrangler deploy` again.
- **The worker answers `{"error":"worker is not configured: <VAR>"}`:** fill that var in wrangler.toml and redeploy. For MONAD_RPC_URL, repeat its `secret put` step. `{"error":"validator key is not configured"}`: repeat the VALIDATOR_KEY `secret put`.
- **HTTP 429 or errors from the primary RPC:** the worker already reads sequentially with no batching. If the primary endpoint is down, switch to the public fallback until it recovers, then switch back to the primary URL the same way:

  ```sh
  cd ~/proof-of-reason/worker
  printf '%s' https://rpc.monad.xyz | pnpm exec wrangler secret put MONAD_RPC_URL
  ```

  rpc.monad.xyz is the Foundation RPC: 20 requests per second, batch not allowed (docs/MONAD.md section 8). One check at the measured pace issues about 6 requests per second. rpc1.monad.xyz throttled about 40 back-to-back sequential reads on 2026-09-19 (docs/MONAD.md section 6), so prefer rpc.monad.xyz as the fallback.
