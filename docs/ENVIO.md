# The verdict index and the agent page

`envio/` indexes what the gates executed and what the validator recorded, on Monad. `envio/worker/`
serves one page per agent from that index: server rendered, no JavaScript, one URL.

Two sources, joined on the EIP-712 intent hash:

| Source | What it proves | Why it is not the whole story |
| --- | --- | --- |
| `ReasonGate` / `KuruGate` `Executed` | what actually ran: a PASS, or a WAIT the owner signed for | a FAIL reverts with `Refuted`, so a refusal never emits an event |
| `ValidationRegistry` `ValidationResponse` | every verdict the validator signed, PASS, WAIT and FAIL | it is the validator's own word, written after the fact |

## The counting rule

- **Gate events are authoritative for pass, wait and override.** A pass is a pass because it
  executed, not because the validator said so.
- **Registry events supply the fails**, plus the `requested` flag and the receipt hash. Nothing else
  on chain can report a refusal.
- **A PASS is never counted twice.** When both sources carry the same intent hash, the gate's count
  stands and the registry's response only fills in the receipt hash and the flag.
- **Registry rows are kept whole, separately**, as `RegistryVerdict` and `RegistryAgent`. That audit
  view counts every response including the passes, so it is allowed to disagree with the `Agent`
  counters. Keeping both is the point: one says what ran, the other says what was claimed.
- **An OTHER response is stored with `outcome` null** and left out of the bound. The registry accepts
  any value in 0 to 100; a response that is not 100, 50 or 0 is not a verdict this ruleset knows how
  to score, so it is counted as `others` and never guessed at. `envio/src/outcomes.ts` is the only
  place that mapping lives.

An `Agent` row is keyed by gate address, which is the `:address` in `GET /agents/:address`. A
registry response carries an ERC-8004 agent id, not a gate address, so the indexer learns the link
from the intent hash that a gate event and a registry response share: the first verdict both sides
recorded ties an agent id to a gate, with no configuration. Fails recorded before that link exists
stay on the audit view; they are not retro-attributed.

One consequence, stated plainly: a WAIT the owner left alone never reaches a gate, so it is not in
`Agent.waits`. `Agent` counts what executed plus what was refused; `RegistryAgent` counts what the
validator said. `Agent.waits` therefore equals `Agent.overrides`.

## The bound

`envio/src/wilson.ts` is pure and has no dependencies. The page shows the Wilson score interval's
lower bound at z 1.96:

```
lower = (p + z^2/2n - z * sqrt(p(1-p)/n + z^2/4n^2)) / (1 + z^2/n)
```

8 passes out of 10 samples gives **0.4902**. Ten passes out of ten gives 0.7225, not 1.0, which is the
point: a pass rate of 1.0 from two verdicts says nothing, and a page that prints it next to a pass
rate of 0.95 from four hundred is lying by arithmetic. The bound rises only with evidence.

Samples are passes plus waits plus fails. Under **10 samples there is no number at all**: the status
is `INSUFFICIENT_HISTORY` and the page says how far off it is.

## Data source

`envio/config.yaml` reads two variables, and `envio/src/datasource.ts` is the same rule in code, with
tests that pin both strings so the two cannot drift:

| Environment | Source | When |
| --- | --- | --- |
| neither set | HyperSync | the default, and what a fresh clone does |
| `ENVIO_RPC_URL` set | HyperSync, that RPC as fallback | a little more reliability |
| `ENVIO_RPC_URL` set, `ENVIO_RPC_FOR=sync` | that RPC only | no HyperSync; needs an archive node |

An invalid `ENVIO_RPC_FOR` is refused rather than defaulted, and `ENVIO_RPC_FOR=sync` without a URL
is refused too. Monad's Foundation RPC forbids JSON-RPC batch and rate limits hard, so an RPC used
for `sync` must be an archive endpoint of your own (docs/MONAD.md section 8).

Envio interpolates `${...}` in `config.yaml` at parse time and **fails when `ENVIO_RPC_URL` is not
set at all**, even for a HyperSync run. So export it, empty or not, before any `envio` command:

```sh
export ENVIO_RPC_URL=https://rpc.monad.xyz   # or your archive endpoint
```

## Run it locally

```sh
cd envio
pnpm install
pnpm test                                    # 47 tests, no codegen, no database, no network
ENVIO_RPC_URL=https://rpc.monad.xyz pnpm codegen
pnpm dev                                     # needs Docker: Postgres plus Hasura
```

`pnpm dev` serves GraphQL at `http://localhost:8080/v1/graphql`. Point the page at it:

```sh
cd envio/worker
pnpm test                                    # 19 tests, fixtures and fakes only
ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql pnpm exec wrangler dev
open http://localhost:8787/agents/<gate address>
```

Addresses in `config.yaml` are placeholders (`0x0000...0000`) until the runbook fills them in: the
registry from step 6a, the gate from step 5, the KuruGate when it is deployed. Quote them: unquoted
`0x...` is parsed as a YAML integer and envio rejects it.

### Codegen and the workspace

`envio codegen` writes `envio/generated/`, which is **gitignored and never committed**
(`envio/.gitignore`). Two workspace frictions, both settled in the repository:

1. Codegen compiles ReScript, whose install script pnpm blocks by default. `pnpm-workspace.yaml`
   carries `allowBuilds: rescript: true`, so a root `pnpm install` builds it once and codegen then
   compiles cleanly (124 modules, about 3 s cold).
2. Codegen runs a nested `pnpm install` inside `generated/`, which resolves to the workspace root and
   prints `ERR_PNPM_IGNORED_BUILDS`. **`pnpm codegen` therefore exits non-zero even when it
   succeeded.** Check the output, not the exit code: the last lines should be `>>>> Finish compiling`
   and `generated/lib/` should exist.

Two things codegen does not do here, and what to do instead:

- **It does not link `generated` as a module.** Nothing in `package.json` may depend on it, because a
  `file:./generated` dependency would break `pnpm install` on a fresh clone where the directory does
  not exist yet. So `pnpm typecheck:handlers` resolves it with a `paths` mapping in
  `tsconfig.handlers.json` instead, and passes with no errors once codegen has run. For `pnpm dev`,
  where Node has to resolve the import at runtime, link it locally:

  ```sh
  cd envio && mkdir -p node_modules && ln -sfn ../generated node_modules/generated
  ```

- **Envio's own `TestHelpers` are therefore not wired up.** They compile, but using them would mean
  depending on that runtime link from the test suite. The handler tests here are **pure-function
  tests** instead: every decision lives in `src/handlers.ts`, `src/verdicts.ts`, `src/wilson.ts` and
  `src/outcomes.ts`, which take plain objects and a get/set context, and `test/handlers.test.ts`
  drives the whole reducer through an in-memory store. `src/EventHandlers.ts` is registration only,
  and is the one file that needs codegen: `pnpm typecheck` leaves it out, `pnpm typecheck:handlers`
  checks it.

## Deploy to Envio Cloud (DJ performs these)

1. **Connect the GitHub App.** app.envio.dev, "Add indexer", authorise the Envio GitHub App on the
   `proof-of-reason` repository. Envio builds from the repository, not from your machine.
2. **Pick the deploy branch.** Envio deploys on every push to the branch you nominate. Use a branch
   that only moves when you mean it to, for example `envio-deploy`, rather than `main`:
   `git switch -c envio-deploy && git push -u origin envio-deploy`.
3. **Set the config path** to `envio/config.yaml` and the root to `envio/`.
4. **Set `ENVIO_RPC_URL`** in the Envio Cloud environment, even on HyperSync, or the config fails to
   parse. Leave `ENVIO_RPC_FOR` unset for the fallback default.
5. **Copy the GraphQL endpoint** Envio gives you into `envio/worker/wrangler.toml`
   (`ENVIO_GRAPHQL_URL`) along with `CRON_AGENT_ADDRESS`, then `pnpm exec wrangler deploy` from
   `envio/worker`.
6. **Check the cron is registered:** the Cloudflare dashboard, Workers, Triggers, should show
   `0 12 * * 1`.

### The 28 September rule

Arithmetic against Envio Cloud's free Development plan, not a platform policy date:

- A deployment is **deleted after 30 days at most**.
- Separately, a deployment with **no requests for 7 days** gets 7 days of grace, then 3 days
  read-only, then deletion.
- **Judging runs 14 to 27 October.**

A deployment created before **28 September** can therefore be deleted before judging ends: 27
September plus 30 days is 27 October, the last judging day. So **the first Cloud deploy happens on or
after 28 September 2026**, which puts its 30 day limit on 28 October or later, and **the page must
receive at least one request every week until 27 October**. The weekly cron in
`envio/worker/wrangler.toml` covers the second rule; it fires Mondays at 12:00 UTC, which lands on 28
September, 5, 12, 19 and 26 October. Local runs are unaffected by either rule.

If the deployment is deleted anyway, nothing is lost that cannot be rebuilt: the index is derived
from chain events, so a fresh `envio deploy` reproduces it. What would be lost is the page's history
of being reachable, which is why the cron exists.

### Fallback behaviour

- **No `ENVIO_RPC_URL`:** HyperSync only. If HyperSync is behind or unavailable for Monad, the
  indexer waits rather than inventing data.
- **`ENVIO_RPC_URL` set, no role:** HyperSync leads and the RPC covers what HyperSync cannot serve.
  This is the recommended Cloud setting.
- **`ENVIO_RPC_FOR=sync`:** the RPC is the only source. Expect a slow historical sync and watch the
  rate limits.
- **The page when the indexer is down:** `GET /agents/:address` answers 502 with one line and never
  echoes the endpoint, which is configuration. It shows no stale numbers, because it holds none: the
  page is rendered per request from the indexer.
- **The page when an agent has nothing indexed:** 404 with the address, not an empty page implying a
  clean record.
- **The page when there are under 10 verdicts:** the counts, and `Not enough history: N of 10
  verdicts needed`. Never a bound.
