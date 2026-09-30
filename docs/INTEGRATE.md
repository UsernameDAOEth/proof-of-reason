# Integrating Proof of Reason

For the developer who runs an automated allocator and wants a premise check in front of it. Everything
here is the code as it is today: the hosted validator, the gate on Monad mainnet, and the offline
verifier. Nothing is promised that is not deployed.

What you get: before your agent's transaction reaches the vault, a validator reads the chain at a
pinned block and checks that every fact the agent stated is TRUE, that the action is inside the
mandate you wrote (ALLOWED), and that every claim kind you required is present (COMPLETE). The gate
holds a veto and never a key. A refusal is a revert, and every verdict, PASS, WAIT or FAIL, is filed
on an ERC-8004 validation registry and served as a receipt anyone can re-check.

What you need: a vault the gate can be the allocator of, an agent key that pays 0.10 USDC per check
over x402, and a mandate. Nothing else runs on your side.

## The four pieces

| Piece | What it is | Where |
| --- | --- | --- |
| Mandate | The principal's rules: which markets, which claim kinds are required, which agent id | `worker/src/mandates.ts`, public and versioned in git |
| Claims | The agent's reason as typed facts, each one checkable at a block | `docs/CLAIMS.md` |
| Validator | Reads the chain at `head - 2`, runs the engine, signs the verdict, files it on the registry | `worker/`, hosted at `api.proofofreason.com` |
| Gate | Forwards calldata to the vault only with a fresh signed PASS, or a WAIT the owner countersigned | `contracts/src/ReasonGate.sol` |

The engine (`engine/`) is pure TypeScript with no server in it. The validator and the verifier both
call the same functions, which is why a receipt can be re-run by anyone.

## 1. Write the mandate

A Morpho mandate lists the markets the calldata may touch and the claim kinds a PASS requires:

```json
{
  "allowedMarkets": [
    "0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626",
    "0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439"
  ],
  "requiredKinds": ["rate", "liquidity"],
  "agentId": "10258"
}
```

`agentId` is the agent's ERC-8004 id on the Identity Registry. Without it nothing is filed on chain
and the receipt says so. A typed-decision mandate (for a Kuru trading agent) has a different shape;
`examples/jev-trader-gated/mandate.json` is a complete one and `docs/CLAIMS.md` describes both.

Mandates are bundled with the validator, so yours becomes a pull request adding one entry to
`worker/src/mandates.ts` under an id you choose. Every mandate a verdict cites is then public.

## 2. State the reason as claims, and the action as data

The agent reads the chain, then phrases claims from what it read. A claim phrased before the reading
is the thing the gate exists to catch. The first mainnet receipt carried these two:

```json
[
  {
    "id": "r1",
    "kind": "rate",
    "market": "0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439",
    "side": "supply",
    "valuePct": 9.5558,
    "basis": "APY",
    "compounding": "continuous",
    "window": { "type": "instant" },
    "tolerancePp": 0.1,
    "sourceSpan": "market B pays more to supply than market A"
  },
  {
    "id": "l1",
    "kind": "liquidity",
    "market": "0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439",
    "minWithdrawable": "1639330385558",
    "sourceSpan": "market B can return the 5 USDC on demand"
  }
]
```

`sourceSpan` is the sentence of the reason the claim encodes; it is recorded, never checked. The
four Morpho kinds are `rate`, `utilization`, `liquidity` and `identity`. Numbers with tolerances
are compared in percentage points; amounts are decimal strings in atomic units.

The action is stated once as a typed struct and once as the exact calldata. The validator decodes
the calldata and refuses if the two disagree:

```json
{
  "fn": "reallocate",
  "allocations": [
    { "market": "0x9e8441e7af65860feac831ebc117473e3033321abf528ebc8fbde1eeaaa3a626", "assets": "4999999" },
    { "market": "0x093bd94086b08a013c96dc0776ebf663e9300e742a2c14479211cc35da6c3439", "assets": "115792089237316195423570985008687907853269984665640564039457584007913129639935" }
  ]
}
```

Supported actions: MetaMorpho V1.1 `reallocate`, Vault V2 `allocate` and `deallocate`, and Kuru
`kuru_order`. The gate allowlists selectors, so only the functions in your gate's constructor can
ever be forwarded.

## 3. Pay for a check

`POST https://api.proofofreason.com/check` takes:

```json
{
  "intent": { "vault": "0x...", "data": "0x7299aa31...", "nonce": "1790369096908", "notAfterBlock": "107991934" },
  "action": { "fn": "reallocate", "allocations": [ ... ] },
  "claims": [ ... ],
  "mandateId": "demo-usdc-v1"
}
```

`nonce` is any unused uint256; the gate burns it on execution. `notAfterBlock` is the last block the
intent is valid at; the gate refuses after it. Both are decimal strings.

The first call answers `402` with a `payment-required` header: x402 v2, `exact` scheme, network
`eip155:143`, amount `100000` of Monad USDC (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`), USDC
EIP-712 domain name `USDC` version `2`. The agent signs an EIP-3009 transfer authorization for 0.10
USDC and repeats the call with the payment header. No transaction leaves the agent; the facilitator
settles. `scripts/demo-check.ts` exports the whole exchange as one function:

```ts
import { payAndCheck } from './scripts/demo-check.ts'

const { status, body } = await payAndCheck({
  origin: 'https://api.proofofreason.com',
  body: { intent, action, claims, mandateId: 'demo-usdc-v1' },
  signer: agentAccount, // a viem LocalAccount; it signs the USDC authorization and nothing else
})
```

A `200` carries:

| Field | Use |
| --- | --- |
| `verdict.outcome` | `PASS`, `WAIT` or `FAIL`, with `failing` and `missingKinds` saying why |
| `signed` | Exactly the arguments `gate.execute` takes: `claimsHash`, `outcome` (1, 2, 3), `checkedAtBlock`, `receiptHash`, `signature` |
| `receipt` | The full document, also served at `GET /receipts/{signed.intentHash}` |
| `receipt.registry.tx` | The validation registry write, or `error` saying why there was none |

Errors: `400` malformed or wrong claim family for the mandate, `404` unknown mandate, `422` prose
without typed claims (no extractor is configured on the hosted validator), `503` chain state
unavailable. No payment settles on a `503`.

## 4. Execute, inside the window

The gate accepts a verdict for `maxAgeBlocks` after `checkedAtBlock`: 60 blocks, about 18 seconds
on Monad. Check and execute back to back.

```ts
const gateAbi = parseAbi([
  'struct Tally { uint8 falseCount; uint8 unverifiableCount; uint8 missingCount; uint8 mismatchCount; uint8 violationCount; }',
  'struct Verdict { uint8 outcome; uint64 checkedAtBlock; bytes32 receiptHash; Tally tally; }',
  'struct Premise { bytes32 subject; uint8 kind; uint256 lo; uint256 hi; }',
  'function execute(bytes data, bytes32 claimsHash, uint256 nonce, uint64 notAfterBlock, Verdict verdict, Premise[] premises, bytes validatorSig, bytes ownerSig)',
  'function previewPremises(Premise[] premises) view returns (bool heldAll, uint256[] observed)',
])
// The premises are served with decimal strings; the gate takes integers.
const premises = body.signed.premises.map((p) => ({ subject: p.subject, kind: p.kind, lo: BigInt(p.lo), hi: BigInt(p.hi) }))

// Free: the chain's reading of every premise right now. Ask before spending a gas limit.
const [heldAll] = await client.readContract({ address: gate, abi: gateAbi, functionName: 'previewPremises', args: [premises] })
if (!heldAll) throw new Error('a premise no longer holds: check again')

await wallet.writeContract({
  address: gate,
  abi: gateAbi,
  functionName: 'execute',
  args: [
    intent.data,
    body.signed.claimsHash,
    BigInt(intent.nonce),
    BigInt(intent.notAfterBlock),
    {
      outcome: body.signed.outcome,
      checkedAtBlock: BigInt(body.signed.checkedAtBlock),
      receiptHash: body.signed.receiptHash,
      tally: body.signed.tally,
    },
    premises,
    body.signed.signature,
    '0x', // ownerSig: empty on PASS
  ],
  gas, // explicit: Monad charges the limit, not the gas used
})
```

The gate, in order: caller is the agent, selector is allowlisted, nonce unused, intent not expired,
signature is the validator's over exactly this intent, receipt, tally and premises, verdict is fresh,
then FAIL reverts with `Refuted`, WAIT needs `ownerSig`, PASS continues; then (ruleset REASON-R1)
the signed outcome must be the one the signed tally derives, or `OutcomeInconsistent`, and every
premise is read back from Morpho (or the Kuru book) in this block, or `PremiseRefuted`; then the
bound calldata is forwarded. Any revert from the vault bubbles up. `PremiseHeld` events carry the
chain's own readings. Send an explicit gas limit: Monad charges the limit, not the gas used, which is
also why `previewPremises` exists.

What `body.signed` carries under REASON-R1, beyond the fields above: `tally` (the five counts the
outcome is derived from), `premisesHash` (`keccak256(abi.encode(premises))`, what was signed), and
`premises` (the bounds, one per utilization or liquidity claim, or two per kuru_book claim). Rate
claims have no premise: the chain cannot recompute a rate, so those stay the validator's pinned
observations, and `docs/MONAD.md` section 13 lists which kinds are which.

## 5. WAIT and FAIL

**FAIL** means a claim was FALSE at the block, the stated action did not match the calldata, or the
calldata touched a market outside the mandate. `verdict.failing` names each item with the claimed
and observed values. Fix the reason, or the action, and check again with a new nonce. Presenting a
FAIL to the gate only spends gas on a revert.

**WAIT** means nothing was false but something could not be settled: a claim was UNVERIFIABLE (the
read failed or the guard window tripped) or a required kind was missing. The owner can carry a WAIT
by signing the intent hash under the gate's EIP-712 domain:

```ts
import { overrideTypes } from 'proof-of-reason-engine/sign'
// Override { bytes32 intentHash }, domain name "Proof of Reason" version "2", verifyingContract = gate
const ownerSig = await owner.signTypedData({ domain, types: overrideTypes, primaryType: 'Override', message: { intentHash } })
```

`SignatureChecker` is used, so the owner may be a Safe or any ERC-1271 contract. The `Executed`
event then records `ownerOverride = true`, so an override is never silent.

## 6. Verify any receipt, with your own RPC

The README's "How to verify a receipt without trusting us" is the procedure: fetch the receipt,
recompute the sealed hash and the intent hash, read every claim again at `checkedAtBlock` through an
RPC you choose, re-run the engine, read the validation registry entry, and look for the gate's
`Executed` event. Nothing in it trusts the API to be honest, or up: with a receipt file in hand it
still checks the chain.

## 7. Running it for your own vault

The hosted validator is bound to one gate and one vault: it refuses a check for any other vault, by
design, so a verdict can never be replayed against a vault it was not made for. A second principal
today is a second deployment, and `docs/DEPLOY_RUNBOOK.md` is the whole of it:

1. Deploy `ReasonGate` with your owner, vault, the validator address, your agent address and the
   selectors you allow. Set the gate as the vault's allocator. The gate holds no funds.
2. Deploy the worker from `worker/` with your `GATE`, `VAULT` and `PAY_TO`, and the validator key as
   a secret. You can run the validator yourself; the key never has to be ours.
3. Register the agent on the ERC-8004 Identity Registry and put its id in the mandate, so verdicts
   file against it.

The runbook's gas table puts a full deployment, vault included, between about 1.2 and 2.4 MON,
plus about 0.031 MON per verdict the validator files. A hosted multi-tenant validator is not built and, per `docs/PREREG.md`, is not built unless the fit gate passes on
15 December. Until then self-hosting is the honest answer, and it is the same code.

## What it does not do

- It does not judge whether the decision is wise, only whether its premises are true and allowed.
- It does not read prose on the hosted validator. Send typed claims.
- It is one validator key today. Every verdict is on the registry and re-checkable, and the vault
  owner can replace the validator with `setValidator`, or halt the gate by setting it to zero.
- The receipt is served the moment the check completes, before execution. For vault reallocations
  that is fine; for order flow it is information. Treat the receipt as public from the first block.

Questions, mandates, pilots: dj@proofofreason.com.
