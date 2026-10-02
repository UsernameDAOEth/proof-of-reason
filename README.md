# Proof of Reason

An automated allocator has to state its reason before a vault moves money, and the reason is checked
against chain state at a pinned block: premises true (TRUE), action inside the principal's mandate
(ALLOWED), every required claim present (COMPLETE). The gate holds a veto and never a key, so the
worst a bad verdict can do is refuse. Most agent gates check permissions. Proof of Reason checks
premises.

## Live on Monad

<!-- BEGIN GENERATED live: node scripts/gen-readme.ts -->

Monad mainnet, chain 143. Addresses link to Monad Vision.

| What | Address |
| --- | --- |
| Vault | [`0x28900B0B2DDA5d2d61cDF17BE8b7091206a04Bf9`](https://monadvision.com/address/0x28900B0B2DDA5d2d61cDF17BE8b7091206a04Bf9) |
| Gate | [`0x8fF582f268aB8E2148B548Aa061c5273bC383120`](https://monadvision.com/address/0x8fF582f268aB8E2148B548Aa061c5273bC383120) |
| Validation registry | [`0x8e2b835d43bB93cE46CcA9994f41596dB162007C`](https://monadvision.com/address/0x8e2b835d43bB93cE46CcA9994f41596dB162007C) |
| Validator | [`0xEC37691732204714DDfd024B67F1B7abfcF3FC9E`](https://monadvision.com/address/0xEC37691732204714DDfd024B67F1B7abfcF3FC9E) |
| Identity registry | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://monadvision.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| Validator agent | ERC-8004 id `10259` on the identity registry above, its registration file carrying the pre-registration sha256 below |
| Demo agent | ERC-8004 id `10258` on the identity registry above |
| API | [`https://api.proofofreason.com`](https://api.proofofreason.com), x402, 0.10 USDC per check, exact scheme, `eip155:143` |

First receipt, 25 Sep 2026: [PASS at block 107991649](https://api.proofofreason.com/receipts/0x45ab90694af77667d82c0b3047611c4ac707b3e3f94cda5cd67aad63735298e3).
Then the [registry write](https://monadvision.com/tx/0x4eb4422544c1120c5133653d06469ab7ef44574eeaf0ecd4bcf1134311740240), then the [execution](https://monadvision.com/tx/0xfcc50dadc9635a268ab55c5065ad7d4226b4d222180280e604f6834d72e6d3af).

<!-- END GENERATED live -->

## Quickstart

Everything below runs offline. No RPC, no keys, no payment, no network.

```sh
git clone --recurse-submodules https://github.com/UsernameDAOEth/proof-of-reason
cd proof-of-reason
pnpm install
pnpm test          # the TypeScript workspace
cd contracts && forge test
```

Expected, as of 2026-09-26: **350 tests passing** across the eight TypeScript packages, and
**105 passing, 1 skipped** in Foundry. The one skip is deliberate and names its reason when it runs.

If you cloned without `--recurse-submodules`, the contracts will not build and the jev-trader example
will fail three of its tests by design. Fix it with `git submodule update --init --recursive`.

The video kit in `vid/` is Python and is not part of `pnpm test`. It needs `ffmpeg` with `drawtext`
and renders nothing without a live receipt:

```sh
python3 -m unittest discover -s vid/test -t vid/test    # 53 tests
```

## The demo

Three commands, against the live chain. A vault with 10 USDC, an agent that states a reason and pays
0.10 USDC to have it checked, and a gate that moves the money only because the reason held.

```sh
node scripts/demo-check.ts seed
node scripts/demo-check.ts check && node scripts/demo-check.ts execute
```

**Run it with `--dry-run` first.** A dry run reads the chain, prints what it would do, and signs
nothing, sends nothing and reads no key file. It is the safe way to see the shape of the thing.

The second line is one command on purpose. The gate accepts a verdict for **60 blocks**, about 18
seconds on Monad, so `check` and `execute` run back to back. If they drift apart, `execute` refuses
before sending anything and tells you how old the verdict is; run `check` again.

Full walkthrough, including what a judge sees and how to force a FAIL: [docs/DEMO.md](docs/DEMO.md).

## Architecture

| Package | What it is |
| --- | --- |
| `contracts/` | `ReasonGate` (the veto, EIP-712 verdicts, a 60 block freshness bound), `KuruGate`, `VerdictRule` (the outcome rule and the premise re-assertion the chain runs itself, ruleset REASON-R1), and the interim ERC-8004 `ValidationRegistry`. Solidity, Foundry. |
| `engine/` | The check itself: claim types, chain readers, the comparison, the verdict, and the canonical receipt hash. Pure TypeScript, no server. |
| `worker/` | The hosted validator: the x402 paywall, the signing key, the registry write, and `GET /receipts/{intentHash}`. Cloudflare Worker. |
| `envio/` | HyperIndex indexer and the no-script agent compliance page built from `ValidationResponse` and `Executed` events. |
| `shadow/` | The shadow audit: public agent reasoning replayed against the state it cited, feeding the A1 false-premise rate. Its ledger is `shadow/LEDGER.md`. |
| `examples/` | `jev-trader-gated`: a third-party Monad trading agent with a gate in front of its order and no edit to its source. |
| `scripts/` | `demo-check.ts` (the three demo commands), `gen-registration.ts` (the ERC-8004 registration file), `gen-readme.ts` (this README's table). |
| `vid/` | The transmission-frame renderer: a receipt becomes a short and a thumbnail, and it refuses to render anything that is not a live receipt. Python and ffmpeg. |
| `site/` | proofofreason.com. One page, one stylesheet, one icon, no JavaScript, under 30 KB. |

## How to verify a receipt without trusting us

The receipt is the artifact. Nothing below needs our API to be honest, or up.

**1. Recompute the hash the validator signed.** Fetch the receipt, drop the one key that is written
after the signature, and hash what is left. `registry` is unsealed precisely because the response it
posts is the receipt's own hash, so it can never be inside that hash.

```sh
curl -s https://api.proofofreason.com/receipts/<intentHash> > receipt.json
```

```ts
import { hashCanonical, RECEIPT_UNSEALED_KEYS } from 'proof-of-reason-engine/receipt'

const { registry, ...sealed } = JSON.parse(readFileSync('receipt.json', 'utf8'))
console.log(RECEIPT_UNSEALED_KEYS)   // ['registry']
console.log(hashCanonical(sealed))
```

Canonical JSON is object keys sorted by UTF-16 code unit, no whitespace, integers as base-10
strings, then `keccak256` over the UTF-8 bytes. Integers are strings in the stored document for this
reason: hashing the JSON you were served gives the same value as hashing the engine's own types. For
the first receipt this returns
`0x3cb1764a104bc52f1db95b9f6572de13d3a352ee5ec4213a2050e64a454b1ea7`.

**2. Check the registry says the same thing.** The validator files the verdict against the agent's
ERC-8004 id on the validation registry. Read the `ValidationResponse` event from the registry write
transaction:

```
ValidationResponse(address indexed validator, uint256 indexed agentId, bytes32 indexed requestHash,
                   uint8 response, bytes32 responseHash, string tag, bool requested)
```

`responseHash` is the hash you recomputed in step 1. `response` is 100 for PASS, 50 for WAIT and 0
for FAIL. `tag` is the ruleset: `REASON-R0` on the first receipt, `REASON-R1` from gate v2 on.
`validator` must be the validator address in the table above, and `agentId` the agent the receipt's
mandate names.

**3. Check the gate acted on that exact verdict.** Read the `Executed` event from the execution
transaction:

```
Executed(bytes32 indexed intentHash, uint8 outcome, bytes32 receiptHash, bool ownerOverride)
```

`receiptHash` must equal the hash from step 1, and `intentHash` the one you fetched the receipt by.
A FAIL never reaches this event: the gate reverts with `Refuted`, so a refusal leaves no `Executed`
log at all. `ownerOverride` is true only where a WAIT was carried by the owner's own signature.

If step 1 disagrees with step 2, the served document is not the one that was signed. If step 2
disagrees with step 3, the money moved on something other than the filed verdict. Either way the
chain is the record and we are not.

**4. From gate v2 (ruleset REASON-R1), check what the chain checked.** The receipt carries
`verdict.tally`, the five counts the outcome is derived from, and `premises`, the integer bounds the
gate read back from Morpho in the block that executed. Both are inside the signature. Recompute the
outcome from the tally with the rule in `docs/CLAIMS.md` (any FALSE, mismatch or violation is FAIL;
else any UNVERIFIABLE or missing kind is WAIT; else PASS): the gate reverts on anything else, so a
signed PASS over a tally that says FAIL never executes. Then read the `PremiseHeld` events from the
execution transaction:

```
PremiseHeld(bytes32 indexed intentHash, bytes32 indexed subject, uint8 kind, uint256 observed)
```

One per premise, each `observed` inside the premise's `[lo, hi]`. That is the chain's own reading of
utilization or liquidity at execution, not the validator's.
Rate claims are not re-asserted on chain; they are re-run by the verifier at the pinned block
instead, and `docs/MONAD.md` section 13 says exactly which kinds are which.
Re-read the observed values at the receipt's pinned block through https://rpc-mainnet.monadinfra.com,
because the public node forgets state after about 5.6 days (measured 2026-09-30 UTC).

## Pre-registered, before any code

The hypothesis, the kill thresholds and the gate dates were written down before any product code.
The file says it was registered on 2026-09-17. It is the first commit in this repository, `073cceb`,
dated 2026-09-18, and its sha256 below was first posted publicly on 2026-09-25:
[the post](https://x.com/Djzs_ai/status/2103540228128694716).

| | |
| --- | --- |
| sha256 of [docs/PREREG.md](docs/PREREG.md) v1.0, the file's first 2,770 bytes | `5f6a494f937dc6fc915ae154fe347728aea5816c08523204bb73dedf02c7c2d4` |
| Gate dates | 13 Oct: first read. 3 Nov: second read. 15 Dec: fit gate. |

The file is append-only. Amendments are appended after those 2,770 bytes with a date and a reason,
and never edit them, so `head -c 2770 docs/PREREG.md | shasum -a 256` reproduces the published hash.

Results publish whichever way they fall, including a kill.

## Known limits

- One validator key today; every verdict is on the registry and re-checkable by anyone, and a second
  validator is the roadmap.
- What the gate trusts the validator for, after REASON-R1: the observations of claims the chain
  cannot re-read (rates above all) at the pinned block, and that the tally counts what the receipt
  shows. Both are checkable after the fact through an RPC that still holds state at the pinned
  block, such as https://rpc-mainnet.monadinfra.com. Utilization, liquidity and the Kuru book are
  re-read by the chain at execution; the rule that turns counts into an outcome is compiled into
  the gate.
- The validator sees an agent's calldata and claims before the chain does. A dishonest validator
  could trade on that. The operator's policy is to keep no copy of non-PASS intents beyond their
  receipts and never to trade on gate inputs; a second validator or an enclave is the mechanism
  that would replace the policy. This is true of every hosted pre-execution check, and it is stated
  here rather than assumed away.
- The check judges premises and mandate, not whether the decision is wise.
- The registry is interim until Monad's canonical ERC-8004 validation registry ships.

## Status

As of 2026-09-26.

| | What | When |
| --- | --- | --- |
| Done | Contracts deployed on Monad mainnet, chain 143 | 2026-09-22 |
| Done | Validator and demo agents registered on the identity registry | 2026-09-24 |
| Done | proofofreason.com live, no JavaScript, under 30 KB | 2026-09-24 |
| Done | First paid check end to end: PASS, registry write, execution | 2026-09-25 |
| Done | PASS short and thumbnail rendered from the live receipt | 2026-09-25 |
| Pending | Envio Cloud deployment, so the agent compliance page is live | 2026-09-28 |
| Pending | Gate v2 deployed (ruleset REASON-R1: outcome derived on chain from the signed tally, utilization and liquidity re-asserted at execution), first REASON-R1 receipt published | 2026-10-06 |
| Pending | FAIL receipt published, and its short | 2026-09-30 |
| Pending | WAIT receipt published, and its short | 2026-09-30 |
| Pending | Kuru gate deployed, so the example trades behind a real gate | 2026-10-13 |
| Pending | Shadow ledger carries its first audited actions, for the A1 read | 2026-10-13 |

The three pre-registration gate dates are 13 Oct, 3 Nov and 15 Dec.

## Built with

Written with [Claude Code](https://claude.com/claude-code) driving Claude, by one person, over the
week of 2026-09-18. That is stated plainly because the pre-registration asks for honest reporting and
this is part of the honest report: the design decisions, the doctrine and the thresholds are the
author's; a great deal of the typing is not.

**No DJZS v1 code is reused here.** Determined by inspection of the tracked tree: the only DJZS
material in this repository is the legal name, the `username.dj-z-s.eth` name, a link to the DJZS
correction record, and the design token block in `site/public/style.css`, which is copied from
`https://djzs.ai/style.css` and says so at the top of the file. No module, function or contract comes
from a DJZS v1 codebase.

Third-party code is vendored only as git submodules, unmodified: `forge-std`, OpenZeppelin, Morpho
`vault-v2` and `metamorpho-v1.1` under `contracts/lib/`, and
[jev-trader](https://github.com/jarrodwatts/jev-trader) (MIT, Jarrod Watts) under
`examples/jev-trader-gated/upstream/`, which keeps its own licence file and is read, never written.

## License

MIT. See [LICENSE](LICENSE).

`examples/jev-trader-gated/upstream/` is a submodule under its own MIT licence, copyright Jarrod
Watts, and is not covered by this repository's copyright.

## Contact

[dj@proofofreason.com](mailto:dj@proofofreason.com)
