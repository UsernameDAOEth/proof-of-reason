# Proof of Reason shadow audits

The shadow runner audits public agents without any integration. It takes an agent's stated reason and finds the on-chain action the reason refers to. It then reads the chain state the reason cites at that action's block, and decides whether each premise was TRUE, FALSE, or UNVERIFIABLE. The records feed pre-registered assumption A1 in docs/PREREG.md.

**Zerion output never sets a status.** Zerion lists a wallet's transactions so the runner can find the action; that is all. The runner re-reads everything that matters from the chain: sender, success, target contract, method selector, block, and block timestamp. Every observation is a pinned-block read against an RPC endpoint. Zerion data appears in a record only under the `context` key, and nothing under `context` is read when a status is decided. A test (shadow/test/run.test.ts) runs the same record against two different Zerion payloads and gets identical located transactions, observations, results, verdicts, and statuses.

## Counting rules (PREREG A1, copied verbatim)

```
A1 Premise failures happen often enough to matter.
Test: read-only audits of public agent reasoning against the state it cites, plus any operator logs shared with us.
Pass: at least 1 action in 20 carries a false premise at the time it was made.
Kill: fewer than 1 in 100 across at least 200 audited actions.
```

How shadow/LEDGER.md turns records into those counts:

| Record status | Meaning | Counted as |
| --- | --- | --- |
| FALSE | at least one typed claim is FALSE at the pinned block | audited, with a false premise (F) |
| UNVERIFIABLE | no FALSE claim, and at least one UNVERIFIABLE claim or no typed claim to check (prose only) | audited, unverifiable (U) |
| TRUE | every typed claim TRUE | audited |
| UNLOCATED | no matching transaction from the agent wallet in the window | excluded from the audited count (X) |

The summary line reads "N audited, F with at least one FALSE premise, U unverifiable, X unlocated". N counts every located record, so N = F + U + (TRUE records). The ledger also prints F/N. The ledger refuses to load any record whose sha256 does not match its content.

## Pipeline

1. **Record.** A claim record (shadow/inputs/<id>.json, schema `ClaimRecordV0` in shadow/src/record.ts) holds:
   - `id` and `agent` (`name`, `wallet`)
   - `chain` (`monad`, `base`, or `ethereum`)
   - `source_url` and `source_text`, the reason copied verbatim
   - `posted_at`, an ISO 8601 timestamp
   - typed `claims` or `prose`, or both
   - optionally `target` (`contract`, and `method` as a 4-byte selector or full signature) and `window` (`beforeSeconds`, `afterSeconds`)
   
   Typed claims use every ClaimV0 kind plus the audit-only kinds `vault_rate` and `balance` (docs/CLAIMS.md). Prose alone cannot be checked, because no extractor is configured: such a record is located but UNVERIFIABLE, with a note saying why.
2. **Locate** (shadow/src/locate.ts).
   - The window runs from posted_at minus beforeSeconds to posted_at plus afterSeconds. The default is 3,600 seconds each way; a record's own window overrides it.
   - Zerion lists the wallet's transactions on that chain. Candidates are confirmed transactions in the window (and sent from the wallet, when Zerion reports a sender). At most 25 of them, the closest to posted_at by Zerion time, are checked on chain.
   - The chain must confirm each candidate: the sender is the wallet, it succeeded, and it matches the target contract and method when the record names them. Its block timestamp must fall in the window.
   - The runner picks the confirmed candidate closest to posted_at by chain timestamp; ties go to the earlier one. Its block is the **pinned block** for every read.
   - If nothing matches, the record is UNLOCATED.
3. **Observe** (engine/src/audit.ts, morpho.ts, erc4626.ts, erc20.ts). Each typed claim is read at the pinned block, with the windows and formulas in docs/CLAIMS.md. Reads are one request each, sequential, and never batched.
4. **Compare and decide** (engine/src/compare.ts, engine/src/verdict.ts). Each claim gets TRUE, FALSE, or UNVERIFIABLE. The verdict uses no mandate, so there are no required kinds and no action check.
5. **Seal.** shadow/records/<id>.json holds:
   - the record, the located transaction, and the pinned block
   - every observation with its block, each claim's result, the verdict, and the status
   - any notes, and the Zerion `context`
   - `sha256`: the SHA-256 of the canonical JSON of everything else
   
   Canonical JSON sorts object keys by UTF-16 code unit, writes bigints as base-10 strings, uses no whitespace, and rejects undefined values and non-finite numbers. The file is that same content, pretty-printed in canonical key order.

Pinned-block semantics: a read pinned to block N returns the state after every transaction in block N, including the action itself. Rate and utilization claims use the median of the five blocks ending at N, and liquidity uses the minimum, so one block's change is damped but not excluded.

## Re-running any record without Zerion

Zerion only found the transaction. Its hash is in the record, so anyone with an RPC that still holds state at the pinned block can re-run the audit:

1. **Check the seal.** Parse the record JSON, remove the `sha256` field, canonicalize the rest with the rules above, and hash it with SHA-256. It must equal `sha256`.
2. **Check the transaction.** Fetch `located.txHash` from the chain. Its sender must be `record.agent.wallet`, its receipt status must be success, and its block must equal `located.blockNumber` and `pinnedBlock`. If the record names a target, its `to` and the first four bytes of its input must match.
3. **Repeat the reads.** For each entry in `record.claims`, make the reads docs/CLAIMS.md specifies at `pinnedBlock` (for example: Morpho `market(id)` and the IRM's `borrowRateView` at each of the five blocks ending at the pinned block; ERC-4626 `convertToAssets(10^36)` at the start and pinned blocks). Compute the values and compare them with `observations`.
4. **Re-decide.** Apply the TRUE, FALSE, and UNVERIFIABLE rules in docs/CLAIMS.md and compare with `results` and `status`.

The runner automates steps 1 to 4 with no Zerion key:

```sh
cd shadow
export BASE_RPC_URL=...   # or MONAD_RPC_URL / ETHEREUM_RPC_URL for the record's chain; it must hold state at the pinned block
pnpm rerun records/<id>.json
```

It prints `seal valid`, then MATCH or MISMATCH for `located`, `pinnedBlock`, `observations`, `results`, `verdict`, and `status`, and finally MATCH overall. The Zerion `context` is not re-derived, because it is not evidence.

## Commands

Run from shadow/. Keys and RPC URLs come from the environment only and are never logged, echoed in errors, or written to records (shadow/test/secrets.test.ts).

| Command | Needs | Does |
| --- | --- | --- |
| `pnpm run run` (`--in inputs --out records --only <id>`) | ZERION_API_KEY, the chain's RPC variable | audits every input record and writes records/<id>.json; a record that hits a read error is not written and is reported by error name |
| `pnpm rerun records/<id>.json` | the chain's RPC variable | re-runs one record from its JSON without Zerion |
| `pnpm ledger` | nothing | rebuilds LEDGER.md from records/ and prints the summary line |
| `pnpm prospect -- --chain base 0x...` | ZERION_API_KEY, the chain's RPC variable | context only: counts and sizes each address's reallocate and allocate calls over the last 30 days |
| `pnpm zerion:chains` | ZERION_API_KEY | writes evidence/zerion-chains.json and says whether Monad (143) is in the Zerion catalog |
| `pnpm test`, `pnpm test:live` | nothing; the live test also needs ZERION_API_KEY and MONAD_RPC_URL | offline suite; opt-in live audit of one public wallet, written to a temp directory only |

The RPC variables are MONAD_RPC_URL, BASE_RPC_URL, and ETHEREUM_RPC_URL (engine/src/chains.ts). BASE_RPC_URL and ETHEREUM_RPC_URL should point to archive-capable endpoints, because the pinned block is usually in the past. For MONAD_RPC_URL: Monad has no separate archive tier. The public rpc.monad.xyz kept about the last 5.6 days of state when measured on 2026-09-30 (UTC). https://rpc-mainnet.monadinfra.com (Monad Foundation, listed on the docs.monad.xyz Historical Data page) served state at blocks 50,000,000, 90,000,000, 100,000,000 and 106,277,363 on 2026-10-01 (UTC), and it is a single-provider trust assumption.
