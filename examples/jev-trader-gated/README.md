# jev-trader, gated

Jarrod Watts's [jev-trader](https://github.com/jarrodwatts/jev-trader) (MIT) trades Kuru MON-USDC on
Monad on one model decision per block. This example puts a Proof of Reason gate in front of the order
it would send, and changes nothing about how it decides.

The doctrine is unchanged: the LLM reads, the chain testifies, TypeScript decides. The principal
holds the veto, never the keys.

## Nothing upstream is edited

`upstream/` is a git submodule pinned at `b587759e459ea049590102e54a0b07800864cdc3`, the commit
recorded in `docs/MONAD.md` section 11. It is read, never written. Its MIT licence file stays where
it is, and this example adds no patch, no fork and no vendored copy of its source.

```
git submodule update --init examples/jev-trader-gated/upstream
```

Three tests in `test/replay.test.ts` keep that honest: the submodule is at that exact commit, `git
status --porcelain` inside it is empty, and the two lines the adapter mirrors (`market.ts`'s
`batchUpdate` encoding and `model.ts`'s `Decision` fields) are still there, so a silent upstream
change breaks the suite instead of the gate.

What the adapter uses from upstream is its data, not its process: the `TradeState` the model was
shown, the `Decision` it returned, and the `Book` it read. The order is rebuilt here with upstream's
own integer tick math and its own `batchUpdate` encoding, so the bytes the gate forwards are the
bytes upstream would have sent.

### What the pinned commit actually does

It does not swap. At `b587759` the bot posts a post-only limit order on the Kuru MON-USDC OrderBook
every block and cancels last block's order, with its funds in the Kuru MarginAccount, so the call is
`batchUpdate(...)` with `value: 0` (`upstream/src/market.ts`). There is no router call anywhere in
the tree. The gate is built for that call path, not for a router swap.

## The executor design rule

`contracts/src/KuruGate.sol` holds the trading balance. The rule it exists to enforce:

- The **principal owns the gate.** `Ownable2Step`, and only the owner can `withdraw`, rotate the
  validator, rotate the agent, change the freshness bound or change the selector allowlist.
- The **agent owns nothing.** It may only call `execute`, and only with a verdict signed by the
  validator the principal set, over exactly the intent it submitted.
- **One venue, forever.** `venue` is `immutable`. There is no function that retargets it, so no
  verdict, no owner call and no upgrade can point the gate at another contract.
- **Allowlist in, blocklist across.** Only selectors the owner allowlisted can be forwarded.
  `transfer`, `transferFrom`, `approve` and the MarginAccount's `withdraw` and
  `batchWithdrawMaxTokens` are blocked at compile time, as constants computed from the interfaces.
- **Value is always 0,** matching upstream's margin-funded call.
- **Margin is owner-only, both ways.** Kuru limit orders draw from the MarginAccount, so the trading
  balance sits there. `depositMargin` and `withdrawMargin` are `onlyOwner`; Kuru's own `withdraw`
  moves only the caller's balance to the caller, so a withdrawal can only land in the gate, from
  where only the owner can take it. The agent key can call neither, and `execute` cannot reach the
  MarginAccount at all: the venue is immutable and both margin withdraw selectors are blocklisted.
- **Approvals live for one call.** `forceApprove(venue, max)` before, `forceApprove(venue, 0)` after,
  for both quote and base. No standing allowance exists between blocks.
- **FAIL reverts. WAIT waits.** A FAIL verdict reverts `Refuted`. A WAIT needs an owner signature
  over the intent hash (EOA or ERC-1271); without it nothing is forwarded.

The adapter mirrors that rule off chain: it never holds a key and never signs. Sending is an injected
function, and it refuses to hand anything to it unless the verdict it received is over exactly the
intent it built, signed by the validator the principal set, for this gate on this chain.

## Run it dry against Monad, with no key

Read-only. Nothing is signed, nothing is sent, no key is read or created.

```
pnpm install
node dry-run.ts                  # a buy answer on the live book
ANSWER=SHORT node dry-run.ts     # an answer the mandate does not list
MONAD_RPC_URL=https://rpc-mainnet.monadinfra.com node dry-run.ts   # must hold state at the blocks you query
```

It reads the head, pins three blocks behind it, reads `getMarketParams`, `bestBidAsk`, `getL2Book`
and the gate's balance one request at a time (never batched, as `docs/MONAD.md` requires), runs the
validator in process with a throwaway key, and prints the outcome, the order it would have sent, the
receipt hash and the hash of the state the answer came from. Two real runs:

```
block 106623382 | bid 0.024758 ask 0.024768 | answer buy
outcome PASS | sent false | order buy at 2475900 | receipt 0xe77123ba... | dry run: PASS, nothing sent

block 106623517 | bid 0.024665 ask 0.024679 | answer SHORT
outcome WAIT | sent false | order cancel-only | receipt 0xb67a45e9...
decision: claimed {"answer":"SHORT",...}, observed {"answer":"SHORT","recognised":false}
```

Against the deployed validator instead of the in-process one, `deps.check` posts to
`https://api.proofofreason.com/check` with an x402 payment of 0.10 USDC and a `mandateId` the worker
knows. The worker accepts these three claim kinds under any mandate whose `type` is
`typed-decision`, but no such mandate is bundled yet: registering this one is a one-line addition of
`mandate.json` to `worker/src/mandates.ts` at deploy time, with its `gate` set to the deployed
KuruGate, and it is a redeploy. That addition also changes the mandate list `GET /` publishes, which
`docs/DEPLOY_RUNBOOK.md` step 7 pins. Until the gate address is filled in, `mandate.json` carries
the zero address and the adapter refuses to ask for a verdict at all.

## The answer set

`upstream/src/model.ts:6` at `b587759` defines it: `export type Action = "buy" | "sell" | "hold";`,
with line 5 recording that `hold` appears only on a late block where no decision was made. So
`mandate.json` allows `["buy", "sell"]`, `hold` asks for no verdict and places no order, and any
other string is an unrecognised answer, which is WAIT. There is no UP, DOWN or FLAT in the upstream
tree; those are not jev-trader's answers.

## The three MrJev findings, and which check stops each

Reported against MrJev (`aowang-ai/jev-trade` issue 1). Each one is stopped by a different part of
the pipeline, and each has a test in `test/replay.test.ts`.

| Finding | What stops it | Where |
| --- | --- | --- |
| An answer the schema does not recognise defaults to long | The `decision` claim carries the answer verbatim and the allowed set. An answer outside the set is recorded `recognised: false`, which compares to UNVERIFIABLE, which is WAIT, never a side. The adapter builds a cancel-only intent for it, so nothing is placed. | `engine/src/kuru.ts` `observeDecision`, `engine/src/compare.ts` `compareDecision`, `adapter.ts` `planOrder` |
| No position or notional cap | The `position` claim is checked against the gate's own balance at the pinned block. Over either cap is FALSE, which is FAIL, and the receipt carries the number observed. 200 MON per order against a 1000 MON cap stops after six orders. | `engine/src/kuru.ts` `observePosition`, `engine/src/compare.ts` `comparePosition` |
| Leverage changed silently | Neither the claim schema nor the mandate schema has a leverage field, and both are strict, so a request carrying one is refused rather than ignored. The mandate lives with the validator, not the agent, so an agent cannot widen it; a claim that tries to raise a cap or lower the probability floor is a mandate violation, which is FAIL. | `engine/src/claims.ts`, `engine/src/mandate.ts` `checkTypedDecisionMandate`, `adapter.ts` `loadMandate` |

## Files

| File | What it is |
| --- | --- |
| `adapter.ts` | The gate in front of the order step: state hash, claims, intent, verdict check, execute on PASS only. |
| `mandate.json` | The principal's mandate: allowed answers, probability floor, notional and position caps. |
| `dry-run.ts` | One gated block against live Monad, no key, nothing sent. |
| `test/replay.test.ts` | Offline replay: the three findings, the order encoding, and the upstream pin. |
| `test/helpers.ts` | A fake Kuru reader and the validator in process. No network. |
| `upstream/` | jev-trader at `b587759`, MIT, unedited. |
