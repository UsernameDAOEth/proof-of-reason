# envio indexer: the validation record

Indexes the interim ERC-8004 Validation Registry (`contracts/src/ValidationRegistry.sol`,
`docs/MONAD.md` section 12) on Monad, so every verdict the validator recorded is queryable: what it
was, which agent it was filed against, whether the agent asked for it, and which receipt it seals.

## Placeholders to fill in

| Where | What | Source |
| --- | --- | --- |
| `config.yaml` `address` | the registry address | `REGISTRY` from runbook step 6a |
| `config.yaml` `start_block` | the block it was deployed in | the DeployRegistry transaction |

Nothing else is a placeholder. The ABI in `abis/ValidationRegistry.json` is generated from the
contract, not hand written:

```sh
cd ../contracts
forge inspect src/ValidationRegistry.sol:ValidationRegistry abi --json > ../envio/abis/ValidationRegistry.json
```

## Run it

```sh
pnpm install
pnpm envio codegen   # writes the `generated` module the handlers import
pnpm envio dev
```

`envio codegen` is what makes `src/EventHandlers.ts` typecheck: the `generated` module is not in the
repository. This package is deliberately outside the pnpm workspace, so the repo's `pnpm -r test`
and `pnpm -r typecheck` never depend on codegen having been run.

## The mapping

`src/outcomes.ts` is the only place the ERC's 0 to 100 scale becomes a Proof of Reason outcome: 100
is PASS, 50 is WAIT, 0 is FAIL, and anything else is `OTHER` with no outcome code. The registry
accepts any value in 0 to 100, so a response no ruleset of ours emits is reported as itself rather
than rounded into a verdict.

## Entities

- `ValidationRecord`, one per request hash, which for Proof of Reason is the EIP-712 intent hash. It
  carries the response, the outcome, the receipt hash, the tag, how many times it has been answered,
  and `requested`: false for a response the agent never asked for.
- `Agent`, running totals per agent id: how many verdicts, split PASS, WAIT, FAIL, OTHER, and how
  many were volunteered rather than requested.

A repeat response for the same request hash replaces the verdict on that record and does not add a
new one to the agent's totals, which mirrors the registry: the latest response wins.
