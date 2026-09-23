# envio: the verdict index

Indexes the gates and the interim ERC-8004 Validation Registry on Monad, and serves one page per
gated agent from `worker/`.

**Full documentation, including the counting rule, the bound, the data source, local run and the
Envio Cloud deploy: [docs/ENVIO.md](../docs/ENVIO.md).**

```sh
pnpm install
pnpm test                                     # pure tests: no codegen, no database, no network
ENVIO_RPC_URL=https://rpc.monad.xyz pnpm codegen
pnpm dev                                      # needs Docker
cd worker && pnpm test                        # the agent page
```

| Path | What it is |
| --- | --- |
| `config.yaml` | networks, contracts, and the data source by environment. Addresses are placeholders. |
| `schema.graphql` | `Gate`, `Verdict`, `Agent`, `RegistryAgent`, `RegistryVerdict`. |
| `abis/` | generated with `forge inspect`, never hand written. |
| `src/outcomes.ts` | the only place 100, 50 and 0 become PASS, WAIT and FAIL. |
| `src/wilson.ts` | the Wilson lower bound, pure. Under 10 samples, `INSUFFICIENT_HISTORY`. |
| `src/verdicts.ts` | the counting rule, pure. |
| `src/datasource.ts` | HyperSync or RPC, decided by `ENVIO_RPC_URL` and `ENVIO_RPC_FOR`. |
| `src/handlers.ts` | the handler bodies, pure, over a get/set context. |
| `src/EventHandlers.ts` | registration only. The one file that needs `pnpm codegen`. |
| `worker/` | `GET /agents/:address`, server rendered, no JavaScript, weekly cron. |
| `generated/` | codegen output. Gitignored, never committed. |

`pnpm typecheck` leaves `src/EventHandlers.ts` out because it imports the codegen output;
`pnpm typecheck:handlers` checks it once `pnpm codegen` has run.
