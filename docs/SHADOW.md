# Proof of Reason shadow audits

The shadow runner audits public agents without any integration. It takes an agent's stated reason and finds the on-chain action the reason refers to. It then reads the chain state the reason cites at the block before the action's block, and decides whether each premise was TRUE, FALSE, or UNVERIFIABLE. The records feed pre-registered assumption A1 in docs/PREREG.md, counted as Amendment 1 (2026-10-01) sets out.

**Zerion output never sets a status.** Zerion lists a wallet's transactions so the runner can find the action; that is all. The runner re-reads everything that matters from the chain: sender, success, target contract, method selector, block, and block timestamp. Every observation is a pinned-block read against an RPC endpoint. Zerion data appears in a record only under the `context` key, and nothing under `context` is read when a status is decided. A test (shadow/test/run.test.ts) runs the same record against two different Zerion payloads and gets identical located transactions, observations, results, verdicts, and statuses.

## Counting rules (PREREG A1 as amended)

A1's v1.0 pass and kill lines are superseded for counting by docs/PREREG.md Amendment 1 (2026-10-01), "how A1 is counted". The thresholds now in force, copied verbatim from it:

```
Pass: at least 60 counted actions, at least 1 in 20 of them with a false premise at the time it was made.
Kill: fewer than 1 in 100 across at least 200 counted actions.
No agent supplies more than 6 of the actions counted toward a pass, or 20 toward a kill. An agent's earliest actions are the ones counted.
At a read, a threshold whose minimum is not met is reported with the counts and the words "no read". It is neither a pass nor a kill.
```

Amendment 1 is the authority; this section says how shadow/src/ledger.ts applies it.

**Who is listed.** shadow/AGENTS.md is the sampling frame. Each table row gives Listed (UTC) as `YYYY-MM-DDTHH:MMZ`, Agent, Type (`vault allocator`, `trader`, or `other`), Wallet, Chain, and where the agent explains its actions. The ledger parses every row, and a malformed row stops it with the line number: no row is skipped. If a wallet and chain appear in more than one row, the row with the latest listing time sets the listing time and type.

**What counts.** A record is counted only when all of these hold:

| Rule | Ledger reason when it fails |
| --- | --- |
| it is LOCATED | unlocated |
| at least one claim was decided TRUE or FALSE | no claim decided TRUE or FALSE |
| it has no `window` field (the default window) | custom window |
| its wallet and chain match a row of shadow/AGENTS.md | agent not listed |
| no record of that agent has `auditedAt` before its listing time; otherwise the agent never counts | agent audited before its listing |
| the action's block timestamp is after the listing time | transaction not after listing |
| `posted_at` is after the listing time | statement not after listing |

A record with only UNVERIFIABLE claims, or prose only, stays in the ledger and is not counted. Within a counted record, an UNVERIFIABLE claim counts as not false. A counted record has a **false premise** when at least one of its claims is FALSE.

**Caps and thresholds.** Per agent, counted records are ordered by `posted_at`. The pass basis is each agent's earliest 6; the kill basis is each agent's earliest 20. With integer arithmetic only:

- Pass when the pass basis is at least 60 and false x 20 >= pass basis.
- Kill when the kill basis is at least 200 and false x 100 < kill basis.
- Below its minimum, a threshold prints its counts and "no read".

shadow/LEDGER.md prints both threshold lines, the counted total before the caps, and the counts by type (counted, false premise, pass basis, and kill basis for each of vault allocator, trader, and other). Each claim row says whether its record counts and, if not, why. It also keeps the old line, "N audited, F with at least one FALSE premise, U unverifiable, X unlocated", labeled "all records, not the A1 count": N there is every located record. The ledger refuses to load any record whose sha256 does not match its content.

## Pipeline

1. **Record.** A claim record (shadow/inputs/<id>.json, schema `ClaimRecordV0` in shadow/src/record.ts) holds:
   - `id` and `agent` (`name`, `wallet`)
   - `chain` (`monad`, `base`, or `ethereum`)
   - `source_url` and `source_text`, the reason copied verbatim
   - `posted_at`, an ISO 8601 timestamp
   - typed `claims` or `prose`, or both
   - optionally `tx_hash` (0x plus 64 hex), set only when the statement itself gives the transaction: a record whose `tx_hash` does not appear in `source_text` (ignoring case) is refused
   - optionally `target` (`contract`, and `method` as a 4-byte selector or full signature) and `window` (`beforeSeconds`, `afterSeconds`). A record with its own `window` is audited and shown, never counted.
   
   Typed claims use every ClaimV0 kind plus the audit-only kinds `vault_rate` and `balance` (docs/CLAIMS.md). Prose alone cannot be checked, because no extractor is configured: such a record is located but UNVERIFIABLE, with a note saying why.
2. **Locate** (shadow/src/locate.ts). The runner finds the action as Amendment 1, "Which transaction", sets out: a hash the statement gives, or the only match in the window. It never picks the nearest of several.
   - **With `tx_hash`:** the action is that transaction. The chain must confirm that the sender is the agent wallet, that it succeeded, and that it matches the target contract and method when the record names them. No window applies, and Zerion is not asked. If any check fails, or the chain has no such transaction, the record is UNLOCATED with the reason.
   - **Without `tx_hash`:** the window runs from posted_at minus beforeSeconds to posted_at plus afterSeconds. The default is 3,600 seconds each way; a record's own window overrides it. Zerion lists the wallet's transactions on that chain. Candidates are confirmed transactions in the window (and sent from the wallet, when Zerion reports a sender).
     - If the Zerion listing was truncated, or there are more candidates than maxCandidates (25), the record is UNLOCATED: uniqueness could not be checked.
     - Otherwise every candidate is checked on chain: the sender is the wallet, it succeeded, it matches the target contract and method when the record names them, and its block timestamp falls in the window.
     - Exactly one passing candidate is the action. None is UNLOCATED, "no matching transaction in the window". Two or more is UNLOCATED, "ambiguous: N transactions match".
   - The action's block is kept as `located.blockNumber`. The **pinned block** for every read is the block before it: `pinnedBlock = located.blockNumber - 1`.
3. **Observe** (engine/src/audit.ts, morpho.ts, erc4626.ts, erc20.ts). Each typed claim is read at the pinned block, the block before the action, with the windows and formulas in docs/CLAIMS.md. A window that spans several blocks ends at the pinned block. Reads are one request each, sequential, and never batched.
4. **Compare and decide** (engine/src/compare.ts, engine/src/verdict.ts). Each claim gets TRUE, FALSE, or UNVERIFIABLE. The verdict uses no mandate, so there are no required kinds and no action check.
5. **Seal.** shadow/records/<id>.json holds:
   - `auditedAt`, the UTC time of the run, and `shadowVersion` (0.2.0 for these rules)
   - the record, the located transaction (with the action's block), and the pinned block
   - every observation with its block, each claim's result, the verdict, and the status
   - any notes, and the Zerion `context`
   - `sha256`: the SHA-256 of the canonical JSON of everything else
   
   Canonical JSON sorts object keys by UTF-16 code unit, writes bigints as base-10 strings, uses no whitespace, and rejects undefined values and non-finite numbers. The file is that same content, pretty-printed in canonical key order.

Pinned-block semantics: a read pinned to block N returns the state after every transaction in block N. The runner pins to the block before the action's block (Amendment 1, "Which state"), so no reading includes anything the action, or anything else in its block, changed. Rate and utilization claims use the median of the five blocks ending at the pinned block, and liquidity uses the minimum; those windows also end at the pinned block. Amendment 1 discloses that this rule works against the hypothesis: it removes FALSE results that the action's own effect would have caused.

## Re-running any record without Zerion

Zerion only found the transaction, if it was needed at all. Its hash is in the record, so anyone with an RPC that still holds state at the pinned block and the blocks before it can re-run the audit:

1. **Check the seal.** Parse the record JSON, remove the `sha256` field, canonicalize the rest with the rules above, and hash it with SHA-256. It must equal `sha256`.
2. **Check the transaction.** Fetch `located.txHash` from the chain. If the record has `tx_hash`, it must be the same hash. Its sender must be `record.agent.wallet`, its receipt status must be success, and its block must equal `located.blockNumber`. `pinnedBlock` must equal `located.blockNumber - 1`. If the record names a target, its `to` and the first four bytes of its input must match. A re-run checks the recorded transaction; it does not repeat the Zerion search, so it does not re-check that the match in the window was unique.
3. **Repeat the reads.** For each entry in `record.claims`, make the reads docs/CLAIMS.md specifies at `pinnedBlock` (for example: Morpho `market(id)` and the IRM's `borrowRateView` at each of the five blocks ending at the pinned block; ERC-4626 `convertToAssets(10^36)` at the start and pinned blocks). Compute the values and compare them with `observations`.
4. **Re-decide.** Apply the TRUE, FALSE, and UNVERIFIABLE rules in docs/CLAIMS.md and compare with `results` and `status`.

The runner automates steps 1 to 4 with no Zerion key:

```sh
cd shadow
export BASE_RPC_URL=...   # or MONAD_RPC_URL / ETHEREUM_RPC_URL for the record's chain; it must hold state at the pinned block
pnpm rerun records/<id>.json
```

It prints `seal valid`, then MATCH or MISMATCH for every field except `auditedAt` and `context` (`schema`, `shadowVersion`, `engineVersion`, `ruleset`, `chainId`, `record`, `located`, `pinnedBlock`, `observations`, `results`, `verdict`, `status`, `notes`), and finally MATCH overall. `auditedAt` is the time of the original run, and the Zerion `context` is not re-derived, because it is not evidence.

## Commands

Run from shadow/. Keys and RPC URLs come from the environment only and are never logged, echoed in errors, or written to records (shadow/test/secrets.test.ts).

| Command | Needs | Does |
| --- | --- | --- |
| `pnpm run run` (`--in inputs --out records --only <id>`) | ZERION_API_KEY, the chain's RPC variable | audits every input record and writes records/<id>.json; a record that hits a read error is not written and is reported by error name |
| `pnpm rerun records/<id>.json` | the chain's RPC variable | re-runs one record from its JSON without Zerion |
| `pnpm ledger` (`--records records --agents AGENTS.md --out LEDGER.md`) | nothing | rebuilds LEDGER.md from records/ and AGENTS.md and prints the A1 pass and kill lines |
| `pnpm prospect -- --chain base 0x...` | ZERION_API_KEY, the chain's RPC variable | context only: counts and sizes each address's reallocate and allocate calls over the last 30 days |
| `pnpm zerion:chains` | ZERION_API_KEY | writes evidence/zerion-chains.json and says whether Monad (143) is in the Zerion catalog |
| `pnpm test`, `pnpm test:live` | nothing; the live test also needs ZERION_API_KEY and MONAD_RPC_URL | offline suite; opt-in live audit of one public wallet, written to a temp directory only |

The RPC variables are MONAD_RPC_URL, BASE_RPC_URL, and ETHEREUM_RPC_URL (engine/src/chains.ts). BASE_RPC_URL and ETHEREUM_RPC_URL should point to archive-capable endpoints, because the pinned block is usually in the past. For MONAD_RPC_URL: Monad has no separate archive tier. The public rpc.monad.xyz kept about the last 5.6 days of state when measured on 2026-09-30 (UTC). https://rpc-mainnet.monadinfra.com (Monad Foundation, listed on the docs.monad.xyz Historical Data page) served state at blocks 50,000,000, 90,000,000, 100,000,000 and 106,277,363 on 2026-10-01 (UTC), and it is a single-provider trust assumption.
