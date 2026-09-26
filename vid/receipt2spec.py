"""Turn a Proof of Reason receipt into a transmission frame spec.

    python3 vid/receipt2spec.py receipt vid/receipts/pass.json vid/out/spec-pass.json
    python3 vid/receipt2spec.py open    vid/numbers.json       vid/out/spec-open.json
    python3 vid/receipt2spec.py numbers vid/numbers.json       vid/out/spec-numbers.json
    python3 vid/receipt2spec.py end     vid/numbers.json       vid/out/spec-end.json

A receipt is the document the validator signs and seals: fetch one from
https://api.proofofreason.com/receipts/<intentHash> and keep that url in its provenance field.
A synthetic-*.json fixture, or a receipt whose provenance url does not answer with the same
document, is refused here and again at render time (provenance.py).

Nothing on the frame is typed by hand. Every value on screen comes out of the receipt, or out of
numbers.json: the rail, the SYS_ID, the identity block and the two title lines, which no receipt
carries, plus everything on the frames that have no receipt behind them (open, numbers, end).
vid/test/test_trace.py holds that line, slot by slot.

The frame's four laws are the product's four questions, lit when the receipt says they hold:

    L1 TRUE      every premise compared TRUE against chain state
    L2 ALLOWED   nothing in the action broke the mandate
    L3 COMPLETE  every claim kind the mandate requires was present
    L4 FRESH     the verdict is pinned to a block, the chain state it rests on was read inside
                 the gate's 60 block acceptance window, and the intent had not expired

Note the inversion against the daily scan, where a lit law is a flag that fired, meaning something
is wrong. Here a lit law is a law that held. Four lit laws is the good case.
"""

from __future__ import annotations

import json
import os
import sys

import provenance

NUMBERS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "numbers.json")

# The status word on the rail. The verdict is signed either way; RECORDED means the validator also
# got it onto the ERC-8004 registry, which is true exactly when the receipt carries a registry tx.
STATUS_RECORDED = "RECORDED"
STATUS_SIGNED = "SIGNED"

# ReasonGate.DEFAULT_MAX_AGE_BLOCKS: the gate accepts a verdict while block.number - checkedAtBlock
# <= 60 (engine/src/claims.ts keeps GATE_DEFAULT_MAX_AGE_BLOCKS equal to it, and test_pass.py reads
# the Solidity constant and holds this one equal to both).
MAX_AGE_BLOCKS = 60

LAW_NAMES = {
    "L1": "TRUE · PREMISES HOLD ON CHAIN",
    "L2": "ALLOWED · ACTION INSIDE MANDATE",
    "L3": "COMPLETE · REQUIRED CLAIMS PRESENT",
    "L4": "FRESH · PINNED BLOCK NOT EXPIRED",
}


def short_hash(value: str, head: int = 10, tail: int = 6) -> str:
    """A hash the eye can check: prefix, ellipsis, suffix. The trace test knows this shape."""
    if len(value) <= head + tail + 3:
        return value
    return f"{value[:head]}...{value[-tail:]}"


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_numbers(path: str | None = None) -> dict:
    return _load(path or NUMBERS_PATH)


def frame_identity(numbers: dict) -> dict:
    """The rail, the SYS_ID, the brand and the identity block.

    None of it is in the receipt: it is who publishes, and it is the same on every frame. It lives
    in numbers.json so the ruling holds for it too, and test_trace.py checks it verbatim.
    """
    return dict(numbers["frame"])


def wording(numbers: dict, outcome: str) -> tuple[str, str]:
    """The title and subtitle for a verdict, from numbers.json.

    Each verdict has its own wording, and a verdict has none until its receipt is published: the
    PASS entry carries the PASS wording, and a pending FAIL or WAIT entry carries neither, so a
    FAIL or WAIT receipt is refused here rather than borrowing the words written for PASS.
    """
    entry = (numbers.get("receipts") or {}).get(outcome.lower()) or {}
    title, subtitle = entry.get("title"), entry.get("subtitle")
    if not title or not subtitle:
        raise provenance.Refused(
            f"numbers.json has no title and subtitle for a {outcome} verdict, "
            f"so there are no words for this short yet"
        )
    return title, subtitle


# ----------------------------------------------------------------- laws


def observation_blocks(receipt: dict) -> list[int]:
    """Every block the verdict rests on: each observation's pinned block and each of its samples."""
    blocks: list[int] = []
    for observation in receipt.get("observations", []):
        if observation.get("block") is not None:
            blocks.append(int(observation["block"]))
        for sample in observation.get("samples") or []:
            if sample.get("block") is not None:
                blocks.append(int(sample["block"]))
    return blocks


def laws_from_receipt(receipt: dict) -> list[dict]:
    results = receipt.get("results", [])
    failing = receipt["verdict"].get("failing", [])
    missing = receipt["verdict"].get("missingKinds", [])
    checked_at = int(receipt["verdict"]["checkedAtBlock"])
    not_after = int(receipt["intent"]["notAfterBlock"])

    true_holds = len(results) > 0 and all(item["status"] == "TRUE" for item in results)
    allowed_holds = not any(item.get("source") == "mandate" for item in failing) and not any(
        item.get("source") == "action" for item in failing
    )
    complete_holds = len(missing) == 0 and not any(
        item.get("status") == "UNVERIFIABLE" for item in results
    )
    # FRESH is the gate's rule as far as the receipt can carry it: the verdict is pinned to a
    # block, every piece of chain state it rests on was read no earlier than MAX_AGE_BLOCKS before
    # that block and no later than it, and the intent had not expired at the check. The block the
    # gate actually executed at is not in the receipt, so what is proven is the window, not the use
    # of it. A receipt with no observations (a mandate requiring no claim kinds) keeps the two
    # bounds that do not need them.
    read_blocks = observation_blocks(receipt)
    fresh_holds = (
        checked_at > 0
        and not_after > checked_at
        and all(block <= checked_at for block in read_blocks)
        and all(checked_at - block <= MAX_AGE_BLOCKS for block in read_blocks)
    )

    return [
        {"code": "L1", "name": LAW_NAMES["L1"], "on": true_holds},
        {"code": "L2", "name": LAW_NAMES["L2"], "on": allowed_holds},
        {"code": "L3", "name": LAW_NAMES["L3"], "on": complete_holds},
        {"code": "L4", "name": LAW_NAMES["L4"], "on": fresh_holds},
    ]


# ----------------------------------------------------------------- proof lines


def _claim_line(claim: dict, result: dict | None) -> str:
    """One claim, restated in the numbers it carries. Values come from the claim itself."""
    kind = claim["kind"]
    if kind == "rate":
        return f"rate: {claim['valuePct']} pct +/- {claim['tolerancePp']}"
    if kind == "liquidity":
        return f"liquidity: floor {claim['minWithdrawable']}"
    if kind == "utilization":
        return f"utilization: {claim['valuePct']} pct +/- {claim['tolerancePp']}"
    if kind == "identity":
        return f"identity: lltv {claim['lltv']}"
    if kind == "kuru_book":
        return f"book: bid {claim['bestBid']} ask {claim['bestAsk']}"
    if kind == "decision":
        return f"answer: {claim['answer']} p {claim['probability']}"
    if kind == "position":
        return f"position: cap {claim['maxPositionBase']} base"
    observed = result.get("observed") if result else None
    return f"{kind}: {observed}"


def proof_from_receipt(receipt: dict) -> list[str]:
    """Three lines: the claims that were checked, then where the verdict was recorded."""
    claims = receipt.get("claims", [])
    results = receipt.get("results", [])
    by_id = {item.get("id"): item for item in results}
    lines = [_claim_line(claim, by_id.get(claim.get("id"))) for claim in claims[:2]]
    while len(lines) < 2:
        true_count = sum(1 for item in results if item["status"] == "TRUE")
        lines.append(f"premises: {true_count} of {len(results)} true")
    registry = receipt.get("registry") or {}
    tx = registry.get("tx")
    if tx:
        lines.append(f"registry: {short_hash(tx)}")
    else:
        error = registry.get("error", "not recorded")
        lines.append(f"registry: {error}")
    return lines[:3]


# ----------------------------------------------------------------- the receipt frame


def spec_from_receipt(
    receipt: dict,
    window: dict | None = None,
    path: str | None = None,
    fetch: provenance.Fetch = provenance.fetch_live,
    numbers: dict | None = None,
) -> dict:
    """The receipt frame: the receipt fills every slot except who publishes and the two title lines.

    Those come from numbers.json, and a verdict with no wording there is refused, so the wording
    for a FAIL or a WAIT is written when its receipt is published and never borrowed from PASS.
    """
    url = provenance.require_live_receipt(path, receipt, fetch)
    numbers = numbers if numbers is not None else load_numbers()
    identity = frame_identity(numbers)
    verdict = receipt["verdict"]["outcome"]
    title, subtitle = wording(numbers, verdict)
    checked_at = str(receipt["verdict"]["checkedAtBlock"])
    chain_id = receipt["intent"]["chainId"]
    intent_hash = receipt["intent"]["intentHash"]
    registry = receipt.get("registry") or {}
    status = STATUS_RECORDED if registry.get("tx") else STATUS_SIGNED
    laws = laws_from_receipt(receipt)
    proof = proof_from_receipt(receipt)
    results = receipt.get("results", [])
    where = f"MONAD {chain_id} · BLOCK {checked_at}"

    spec = {
        "rail": identity["rail"],
        "sys_id": identity["sys_id"],
        "status": status,
        "series": ["PREMISE CHECK //", where],
        "series_thumb": f"// PREMISE CHECK / {where}",
        "laws": laws,
        "proof": proof,
        "verdict": verdict,
        "title": [title, subtitle],
        "run": f"> checked: block {checked_at}",
        "identity": list(identity["identity"]),
        "domain": identity["domain"],
        "ens": identity["ens"],
        "window": window or typed_window_from_receipt(receipt),
        "thumb": {
            "title": identity["brand"],
            "sub": [where.lower(), subtitle],
        },
        "trace": {
            "source": "receipt",
            "file": os.path.basename(path) if path else None,
            "provenance": url,
            "outcome": verdict,
            "intentHash": intent_hash,
            "receiptHash": receipt.get("verdict", {}).get("receiptHash"),
        },
    }
    return spec


def typed_window_from_receipt(receipt: dict) -> dict:
    """The receipt reading itself out: what was claimed, what was observed, what was decided."""
    claims = receipt.get("claims", [])
    results = receipt.get("results", [])
    by_id = {item.get("id"): item for item in results}
    lines: list[dict] = [{"text": "THE AGENT SAID", "bold": True, "size": 28}]
    for claim in claims:
        lines.append({"text": _claim_line(claim, by_id.get(claim.get("id"))), "size": 22})
    lines.append({"text": "THE CHAIN SAID", "bold": True, "size": 28})
    for item in results:
        observed = item.get("observed")
        rendered = json.dumps(observed) if isinstance(observed, dict) else str(observed)
        lines.append({"text": f"{item['kind']}: {rendered} [{item['status']}]", "size": 22})
    verdict = receipt["verdict"]["outcome"]
    failing = receipt["verdict"].get("failing", [])
    tail = f"> VERDICT {verdict}"
    if failing:
        first = failing[0]
        where = first.get("rule") or first.get("field") or first.get("kind") or first.get("source")
        tail = f"> VERDICT {verdict} on {where}"
    lines.append({"text": tail, "size": 24, "color": "0x3DFF88"})
    return {"type": "typed", "dur": max(10.0, 1.4 * (len(lines) + 2)), "step": 1.4, "lines": lines}


# ----------------------------------------------------------------- frames with no receipt


def spec_from_numbers(numbers: dict, kind: str) -> dict:
    block = numbers[kind]
    identity = frame_identity(numbers)
    spec = {
        "rail": identity["rail"],
        "sys_id": identity["sys_id"],
        "status": numbers["status"],
        "series": block["series"],
        "series_thumb": block["series_thumb"],
        "laws": [
            {"code": code, "name": LAW_NAMES[code], "on": bool(on)}
            for code, on in zip(("L1", "L2", "L3", "L4"), block["laws_on"])
        ],
        "proof": block["proof"],
        "verdict": block.get("verdict") or "",
        "title": block["title"],
        "run": block["run"],
        "identity": list(identity["identity"]),
        "domain": identity["domain"],
        "ens": identity["ens"],
        "window": {
            "type": "none",
            "dur": float(block.get("dur", 6)),
            "step": float(block.get("step", 0)),
            "lines": [
                {"text": block["h1"], "bold": True, "size": 34},
                *[{"text": line, "size": 22} for line in block["lines"]],
            ],
        },
        "thumb": {"title": block["thumb_title"], "sub": block["thumb_sub"]},
        "trace": {"source": "numbers", "key": kind},
    }
    return spec


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] not in ("receipt", "open", "numbers", "end"):
        print(
            "usage: receipt2spec.py <receipt|open|numbers|end> <receipt.json|numbers.json> <out.json>",
            file=sys.stderr,
        )
        return 1
    mode, source, out = argv
    document = _load(source)
    if mode == "receipt":
        spec = spec_from_receipt(document, path=source)
    else:
        spec = spec_from_numbers(document, mode)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(spec, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    lit = " ".join(law["code"] for law in spec["laws"] if law["on"]) or "none"
    print(f"wrote {out}: status {spec['status']}, verdict {spec['verdict'] or 'none'}, lit {lit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
